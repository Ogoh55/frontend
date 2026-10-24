# Security Invariants

This document records the security invariants the vault stack must uphold, the trust
boundaries between our own services, and the network surfaces each component exposes.
It is reviewed with the security preparation workstream. Client-facing rate limiting and
abuse protection, and on-chain admin key custody/KMS signing, are covered elsewhere.

This document enumerates the invariants the vault stack must uphold. Each invariant
is stated as a property that must hold across every transaction, and is annotated
with the enforcement point(s) and the tests that guard it.

## Trust boundaries and network surfaces

| Service | Externally routable | Accepts internal calls from | Outbound egress allowlist |
| --- | --- | --- | --- |
| BFF / API (`src/app/api/`) | Yes (only external entry point) | Browser clients (authenticated) | Stellar RPC, Horizon, price feeds, notification providers |
| Indexer | No | BFF/API, scheduler | Stellar RPC, Horizon |
| Scheduler | No | BFF/API | Stellar RPC, Horizon |
| Keeper | No | BFF/API, scheduler | Stellar RPC, Horizon |

- Only the BFF/API layer accepts external traffic. Indexer, scheduler, and keeper
  endpoints are not publicly routable (enforced by network policy / private networking).
- Local topology in `docker-compose.yml` mirrors these trust boundaries so development
  exercises the same isolation as production.

## Service-to-service authentication

- Every internal call is authenticated with mTLS or a short-lived signed service token
  that carries a service identity and a narrow scope claim. Handlers verify the identity
  and scope explicitly; they never trust a bare network position.
- Tokens rotate on a short interval. No shared static bearer secrets are checked into
  config; secrets are sourced from a managed store and referenced (not inlined) in
  `.env.local.example`.
- Token validation tolerates bounded clock skew, and long-running indexer/backfill jobs
  refresh tokens before expiry rather than relying on a single long-lived credential.
- Local development may run without mTLS via a documented dev bypass. The bypass cannot
  be enabled in production; production fails to boot with a missing or placeholder
  service credential.

## Least-privilege credentials per service

- The indexer cannot submit transactions.
- The keeper cannot read depositor PII it does not need.
- Each service holds only the scopes required for its role; scope claims are checked at
  the handler, not inferred from the caller's network location.

## Egress controls

- Outbound traffic is restricted to an explicit allowlist (Stellar RPC, Horizon, price
  feeds, notification providers).
- Denied-outbound calls are logged and alerted so a compromise in one service cannot
  pivot freely.

| Domain | Abbreviation | Scope |
|---|---|---|
| **signing** | `signing` | Challenge/response authentication: parsing, field validation, expiry, origin binding, nonce entropy, version gating. Covers the Freighter sign-in flow (`src/lib/auth/challengeValidator.ts`). |
| **input** | `input` | User-supplied address validation. Specifically the address-poisoning heuristic that detects look-alike wallet addresses designed to fool copy-paste. |
| **session** | `session` | Bearer token lifecycle: where tokens are stored, that logout clears them completely, and that tokens never appear in URLs. |
| **isolation** | `isolation` | Per-wallet namespacing in `localStorage`. Alert rules, workspace layouts, and anti-phishing phrases must not bleed between wallet accounts. Hotkeys (non-sensitive) are explicitly documented as intentionally global. |
| **headers** | `headers` | Structural HTTP and subresource security: `X-Frame-Options`, SRI hash format correctness, and the HTTPS-only policy for external resources. |
| **twab** | `twab` | Time-weighted average balance of vault shares (issue #272). Checkpointed cumulative-balance accumulator on the SEP-41 share token; `balance_at(account, timestamp)` and `twab(account, start, end)` read from binary-searchable checkpoints. |
| **vault** | `vault` | Vault share accounting: NAV source of truth, direct-transfer classification, and inflation/donation-attack mitigations (virtual offset, minimum first deposit, `minSharesOut`, NAV-jump guard). |
| **cross-contract** | `cross-contract` | Vault cross-contract call safety: single external-call wrapper, reentrancy lock, call allowlists, and failure containment for calls to the options engine, oracle, and SEP-41 assets. |

---

## Vault Share Accounting — NAV Source of Truth (Issue #290)

Share issuance in the Phase 2 vault is priced **exclusively from internal book-value accounting** (`total_book_value`), never from the raw token balance held at the vault contract address. The raw token balance is treated as an untrusted input that may drift from book value due to direct transfers, returned collateral, or slashed collateral.

**Direct-transfer classification (identical across contract, backend indexer/registry, and `src/lib/api/vaults.ts`):**

> Direct token transfers to the vault contract address are **IGNORED** for NAV/share-price purposes. They do not increase `total_book_value`, do not change NAV per share, and do not mint shares. They remain in the contract balance as an unaccounted surplus and are **not** swept or absorbed as a windfall by any share-issuance path.

This single choice must be mirrored in:
- the vault contract share-accounting module (pricing reads `total_book_value`, not `token.balance_of(vault)`),
- the backend share-accounting service / registry indexer (NAV derived from book value events, not balance snapshots),
- the `src/lib/api/vaults.ts` adapter (share-price and NAV fields sourced from book value, never from a raw balance read).

**Rounding direction:** all NAV/share math is integer arithmetic with a single documented rounding direction — shares minted round **down** (depositor-favoring on issuance is avoided; the vault never mints more shares than the exact rational value), and assets returned on withdrawal round **down**. This guarantees the vault cannot be drained by rounding.

---

## Vault Share Accounting — Inflation / Donation Attack Mitigations (Issue #290)

All four mitigations below are **per-vault configuration** stored with the rest of the vault parameters and changeable **only through the timelocked operator path** — never hardcoded constants.

| Parameter | Purpose |
|---|---|
| `virtual_shares` / `virtual_assets` | Virtual offset added to both numerator and denominator of the share-price formula so the first-depositor / donation attack cannot move NAV per share by a meaningful ratio. |
| `min_first_deposit` | Minimum assets required for the genesis (zero-supply) deposit; the corresponding shares are minted to a dead/locked sink so the attacker cannot own the entire initial supply. |
| `min_shares_out` (per-deposit) | Caller-supplied lower bound on shares minted; the deposit path reverts if the computed shares fall below it, defeating read-time-quote vs execution NAV drift. |
| `max_nav_jump_bps` | Bounds how far NAV per share may move between share-issuance events in the same ledger; a larger jump reverts the issuance. |

**Share-price formula (integer, round-down):**

```
shares_out = floor( assets_in * (total_shares + virtual_shares)
                    / (total_book_value + virtual_assets) )
```

Because `virtual_shares` and `virtual_assets` are non-zero, a donation that inflates `total_book_value` cannot zero out a subsequent depositor's shares, and a 1-unit first deposit cannot capture the whole supply.

---

## Vault Cross-Contract Call Safety (Issue #291)

Vaults custody depositor collateral across epochs and call out to the options engine (sale, settlement, assignment), the oracle, and SEP-41 asset contracts. A single ordering or containment bug in that call graph is a total-loss class of defect, so the following policy is enforced in code and recorded here.

### Single external-call wrapper

Every external call in the vault suite (core vault + strategy modules) is funneled through **one internal wrapper**. The wrapper is the only place that invokes another contract; direct cross-contract invocations elsewhere are a review-blocking defect. The wrapper enforces:

1. **State-write ordering (checks-effects-interactions).** All vault accounting state (`total_book_value`, `total_shares`, per-account balances, pending epoch transition) is written **before** the external call is issued. No accounting mutation may occur after an external call returns within the same entry point.
2. **Validated return-value handling.** Return values from the engine and oracle are treated as untrusted. Accounting state is **never** derived from an unvalidated external return value; the wrapper validates shape/range and reverts on anything unexpected rather than coercing it.
3. **Allowlist enforcement.** The wrapper rejects any call whose target is not on the vault's explicit contract allowlist (options engine, oracle, configured SEP-41 assets). A dependency address changed by an upgrade must be re-registered through the timelocked operator path before it is callable.

### Reentrancy lock

An **explicit** reentrancy lock (not implicit in ordering) covers all accounting-mutating entry points: deposit, withdraw, redeem, settlement, assignment, and epoch transition. The lock is acquired on entry and released on exit; a re-entrant call into any locked entry point reverts. The vault's callback entry points additionally enforce an **explicit caller allowlist** — only the registered options engine may invoke settlement/assignment callbacks, and an auth-entry mismatch reverts.

### Failure containment

For each external call it is documented and enforced whether failure **aborts the transaction** (the default) or is **deferred for keeper retry**. No entry point may leave a partially applied epoch transition or a partial deposit/withdrawal: either the full state transition commits or the transaction reverts with vault state byte-identical to before the call. Calls attempted while an emergency pause is active revert. Resource-budget exhaustion mid-call reverts the whole transaction rather than leaving a half-applied transition.

### Pull-based settlement

Where the engine interface allows, settlement is **pull-based** (the vault reads settled results) rather than callback-driven, keeping the engine interface narrow and version-pinned. Callback-driven settlement is used only where the engine interface requires it, and only behind the caller allowlist above.

### Adversarial test contracts

The contract test crate includes adversarial mocks — a malicious SEP-41 token, a re-entrant options engine, an oracle returning garbage, a call that panics, and a call that exhausts the resource budget — each asserting vault state is byte-identical after any failure.

## Frontend-visible configuration

- The frontend-visible subset of secrets/config is validated in `src/env.ts`; values are
  referenced from the managed store, never inlined.

## Collateral custody

| ID | Domain | Invariant Description | Test File | Test Name | Security / WCAG Ref |
|---|---|---|---|---|---|
| SEC-001 | signing | A well-formed, unexpired challenge for the correct address and domain parses and validates without throwing. | `src/test/security/invariants.test.ts` | `SEC-001: valid challenge parses and validates without error` | SIWS §3 (happy path) |
| SEC-002 | signing | A challenge issued to address A must be rejected with `WRONG_ADDRESS` when validated against address B. | `src/test/security/invariants.test.ts` | `SEC-002: challenge for wrong address is rejected (WRONG_ADDRESS)` | SIWS §4.2; prevents session fixation |
| SEC-003 | signing | A challenge whose `Expiration Time` field is in the past must be rejected with `EXPIRED`. | `src/test/security/invariants.test.ts` | `SEC-003: expired challenge is rejected (EXPIRED)` | SIWS §4.3; prevents replay attacks |
| SEC-004 | signing | A challenge whose `URI` field does not match the expected domain must be rejected with `WRONG_DOMAIN`. | `src/test/security/invariants.test.ts` | `SEC-004: challenge with mismatched domain is rejected (WRONG_DOMAIN)` | SIWS §4.4; prevents phishing relay |
| SEC-005 | signing | A challenge with a nonce shorter than the minimum entropy threshold must be rejected with `NONCE_MALFORMED`. | `src/test/security/invariants.test.ts` | `SEC-005: malformed nonce is rejected (NONCE_MALFORMED)` | OWASP Auth §3; prevents brute-force nonce guessing |
| SEC-006 | signing | A challenge whose `URI` field is not a valid HTTPS URL must not parse (returns `null`). | `src/test/security/invariants.test.ts` | `SEC-006: challenge URI must be a valid HTTPS URL` | SIWS §4.1; OWASP Transport Layer |
| SEC-007 | signing | A challenge with a `Version` field other than `"1"` must be rejected with `VERSION_UNSUPPORTED`. | `src/test/security/invariants.test.ts` | `SEC-007: challenge version other than '1' is rejected` | SIWS §4.5; prevents downgrade attacks |
| SEC-008 | signing | A challenge whose `Issued At` timestamp is more than 10 minutes in the past must be rejected with `ISSUED_AT_TOO_OLD`. | `src/test/security/invariants.test.ts` | `SEC-008: challenge issued too far in the past is rejected (ISSUED_AT_TOO_OLD)` | SIWS §4.3; limits replay window |
| SEC-009 | signing | A challenge whose `Issued At` timestamp is more than a few minutes in the future must be rejected with `ISSUED_AT_FUTURE`. | `src/test/security/invariants.test.ts` | `SEC-009: issued-at far in the future is rejected (ISSUED_AT_FUTURE)` | SIWS §4.3; prevents clock-skew abuse |
| SEC-010 | input | An address that exactly matches a known address must not be flagged as poisoned. | `src/test/security/invariants.test.ts` | `SEC-010: exact address match is not flagged as poisoned` | CWE-20 (false-positive control) |
| SEC-011 | input | An address that matches the first N and last N characters of a known address but differs in the middle must be flagged as poisoned. | `src/test/security/invariants.test.ts` | `SEC-011: address matching first+last chars but differing in middle is flagged` | CWE-20; address-poisoning attack pattern |
| SEC-012 | input | A completely different address (no prefix/suffix match) must not be flagged as poisoned. | `src/test/security/invariants.test.ts` | `SEC-012: completely different address is not flagged` | CWE-20 (false-positive control) |
| SEC-013 | input | An empty string input must not be flagged as poisoned. | `src/test/security/invariants.test.ts` | `SEC-013: empty input is not flagged` | CWE-20; null/empty input safety |
| SEC-014 | session | After explicit logout, all `zenith.wallet.*` keys must be absent from `localStorage`. | `src/test/security/invariants.test.ts` | `SEC-014: after explicit logout, no wallet key remains in localStorage` | OWASP Session Mgmt §3.3; WCAG 2.2 SC 3.3.8 |
| SEC-015 | session | Bearer tokens must never appear as URL query parameters (detectable by scanning constructed URLs for `token=`, `auth=`, or `bearer=`). | `src/test/security/invariants.test.ts` | `SEC-015: bearer token must not appear as a URL query parameter` | OWASP ASVS V3.4.2; tokens in URLs leak via Referer/logs |
| SEC-016 | session | `sessionStorage` must be empty immediately after a fresh page load — wallet tokens are stored only in the zustand-persist `localStorage` store. | `src/test/security/invariants.test.ts` | `SEC-016: sessionStorage is empty after a fresh page load simulation` | OWASP Session Mgmt §2.1 |
| SEC-017 | isolation | Alert rules must be stored under a per-wallet key (`zenith.rules.<address>`) so that switching wallets does not expose another wallet's rules. | `src/test/security/invariants.test.ts` | `SEC-017: rules are stored per wallet address and cannot bleed across wallets` | CWE-359; data isolation |
| SEC-018 | isolation | Workspace layouts must be stored under a per-wallet key (`zenith.layout.<address>`); a different wallet must see no layout data. | `src/test/security/invariants.test.ts` | `SEC-018: workspace layouts are keyed per wallet` | CWE-359; data isolation |
| SEC-019 | isolation | Hotkeys configuration (`zenith.hotkeys.v1`) is intentionally global (non-sensitive preference) and is explicitly documented as such, not a violation. | `src/test/security/invariants.test.ts` | `SEC-019: hotkeys config is not wallet-specific (safe global preference)` | N/A — documented exception |
| SEC-020 | isolation | Anti-phishing phrases must be stored under a per-wallet key (`zenith.antiphishing.phrase.<address>`) and must not be visible to a different wallet. | `src/test/security/invariants.test.ts` | `SEC-020: anti-phishing phrase is wallet-scoped` | CWE-359; data isolation |
| SEC-021 | twab | `twab(account, start, end)` must be bounded by the minimum and maximum instantaneous balance over `[start, end]`; it can never exceed the max or fall below the min. | `src/test/security/invariants.test.ts` | `SEC-021: twab is bounded by min and max instantaneous balance over the window` | Issue #272; prevents last-block deposit/withdraw gaming |
| SEC-022 | twab | A zero-length window (`start == end`) must return the instantaneous `balance_at(account, start)` and must never divide by zero. | `src/test/security/invariants.test.ts` | `SEC-022: zero-length twab window returns instantaneous balance without division by zero` | Issue #272; rounding/div-by-zero spec |
| SEC-023 | twab | The cumulative-balance accumulator must be monotonically non-decreasing across interleaved mint/burn/transfer sequences, and checkpoints are written only on share mutation. | `src/test/security/invariants.test.ts` | `SEC-023: cumulative balance is monotonic and checkpoints only on share mutation` | Issue #272; fuzz target for monotonic accumulator |

## TWAB Checkpoint Retention Policy (Issue #272)

The vault share token maintains a per-account checkpointed cumulative-balance accumulator. Each checkpoint stores `(timestamp, cumulative_balance)` where `cumulative_balance` is the integral of the instantaneous share balance up to `timestamp`. `balance_at` and `twab` binary-search these checkpoints; no unbounded loops are performed.

**Retention / compaction:**

- Checkpoints are written **only** on share mint, burn, and transfer — never on read paths — so the accumulator cannot be bypassed by a new entry point.
- Timestamps are ledger-close-time (never wall-clock) and are strictly monotonic; a checkpoint at the same ledger timestamp as the previous one overwrites rather than appends.
- History is bounded to `MAX_CHECKPOINTS` per account (a fixed constant). When the bound is reached, the oldest checkpoints are compacted: the earliest retained checkpoint is rewritten to carry the cumulative value forward, preserving the integral while freeing entries.
- Compaction is coordinated with the storage-TTL work: retained checkpoints are extended via `extend_ttl` on write so live accounts never lose their accumulator to rent expiry.
- Overflow: cumulative balance is a `u128`; the documented bound is `max_balance * max_window_seconds < 2^128`, enforced by the fixed `MAX_CHECKPOINTS` and ledger-time bounds.
- TWAB is read-only weighting: it must never be usable to mint value, only to weight governance/allocation/fee tiers.

- **INV-1 — Single custodian.** Only the vault core holds collateral custody. Strategy
  modules never receive raw transfer rights; they may only invoke the scoped callbacks
  declared in their capability set (see *Strategy module plugin interface* below).
- **INV-2 — No arbitrary movement.** A module cannot move collateral outside the
  operations it declared at registration time. Any attempt to reach an undeclared
  operation must revert.

## Strategy module plugin interface

A strategy module is a contract that implements the following interface. Conformance
is validated at registration time; a module that fails conformance cannot be enabled.

### Declared parameter schema and defaults

- `parameterSchema() returns (bytes schema)` — ABI-encoded schema describing every
  configurable parameter (name, type, bounds).
- `defaultParameters() returns (bytes defaults)` — ABI-encoded default values that
  must validate against `parameterSchema()`.

### Per-vault capacity / risk-limit hooks

- `capacityLimit(VaultContext ctx) returns (uint256 maxNotional)` — the maximum
  notional the module may deploy for the given vault.
- `riskLimits(VaultContext ctx) returns (RiskLimits limits)` — per-epoch exposure,
  delta, and concentration bounds the vault enforces before dispatching any action.

### Epoch lifecycle responsibilities

- `onEpochOpen(EpochContext ctx)` — allocate within declared capacity; must be
  idempotent and must not exceed `capacityLimit`.
- `onEpochRollover(EpochContext ctx)` — roll expiring positions; must leave the
  vault in a consistent state if it reverts (see failure semantics).
- `onEpochClose(EpochContext ctx)` — settle and report realized PnL; must be
  callable even when the module has been disabled so open positions can be wound down.

### Permitted callbacks on collateral and settlement layers

The module may only invoke the following vault callbacks, and only if the
corresponding capability was declared:

| Capability            | Permitted callback                          |
|-----------------------|---------------------------------------------|
| `HOLD_COLLATERAL`     | `vault.holdCollateral(amount)`              |
| `OPEN_COVERED_CALL`   | `vault.openCoveredCall(strike, expiry, qty)`|
| `OPEN_CASH_SECURED_PUT`| `vault.openCashSecuredPut(strike, expiry, qty)` |
| `OPEN_IRON_CONDOR`    | `vault.openIronCondor(legs)`                |
| `SETTLE_POSITION`     | `settlement.settle(positionId)`             |

Any callback not backed by a declared capability must revert with
`CapabilityNotDeclared`.

### Failure semantics

- **INV-3 — Atomic epochs.** If a module reverts mid-epoch, the vault must roll back
  to the pre-epoch state; no partial allocation may persist.
- **INV-4 — Wind-down after disable.** Disabling a module for a vault must not strand
  open positions: `onEpochClose` remains reachable for wind-down even after disable.
- **INV-5 — Immutable enabled entries.** A registry entry is versioned and immutable
  once enabled. An enabled module cannot be swapped for a different implementation via
  upgrade; a new version must be registered and enabled through the operator workflow.

## Capability model

- **INV-6 — Declared-only reachability.** A module declares the operations it needs
  (e.g. `OPEN_COVERED_CALL`, `HOLD_COLLATERAL`). The vault enforces that only declared
  operations are reachable; undeclared operations revert.

## Registry and operator workflow

- **INV-7 — Governed enablement.** Enabling or disabling a module for a vault is an
  operator action gated by the existing authorization and timelock workflow. There is
  no permissionless module enabling.
- **INV-8 — Sandbox before real deposits.** A candidate module must pass the
  interface-conformance suite and a backtest in the sandbox harness before it can be
  enabled for any vault holding real deposits.

## Testing

- Interface-conformance suite: every module must pass before registration.
- Adversarial tests: a module exceeding its declared capabilities must revert.
- Integration test: enabling a new module on a live-ish vault testnet scenario.

## Verification

- Negative tests prove an unauthenticated or out-of-scope internal call is rejected, an
  egress-denied call is blocked and alerted, and an expired token is refused.
- A configuration test asserts production fails to boot with a missing or placeholder
  service credential.
- Auth failures are surfaced through `sentry.server.config.ts`.

## Notes

- SEC-019 documents an intentional exception (global hotkeys) rather than a violation.
- SEC-021–SEC-023 cover the TWAB accumulator introduced in issue #272; see the retention policy above for the bounded-history and TTL coordination details.
