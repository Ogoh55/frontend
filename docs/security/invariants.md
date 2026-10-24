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

## Frontend-visible configuration

- The frontend-visible subset of secrets/config is validated in `src/env.ts`; values are
  referenced from the managed store, never inlined.

## Security invariant catalog

| Domain | Abbreviation | Scope |
|---|---|---|
| **signing** | `signing` | Challenge/response authentication: parsing, field validation, expiry, origin binding, nonce entropy, version gating. Covers the Freighter sign-in flow (`src/lib/auth/challengeValidator.ts`). |
| **input** | `input` | User-supplied address validation. Specifically the address-poisoning heuristic that detects look-alike wallet addresses designed to fool copy-paste. |
| **session** | `session` | Bearer token lifecycle: where tokens are stored, that logout clears them completely, and that tokens never appear in URLs. |
| **isolation** | `isolation` | Per-wallet namespacing in `localStorage`. Alert rules, workspace layouts, and anti-phishing phrases must not bleed between wallet accounts. Hotkeys (non-sensitive) are explicitly documented as intentionally global. |
| **headers** | `headers` | Structural HTTP and subresource security: `X-Frame-Options`, SRI hash format correctness, and the HTTPS-only policy for external resources. |
| **corrections** | `corrections` | Admin correction / ledger adjustment write path (Issue #293). Append-only compensating entries, maker-checker (four-eyes) approval, expiry, magnitude-tiered approval, and post-application on-chain reconciliation. |

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
| SEC-021 | headers | `X-Frame-Options` must be set to `DENY` (or `SAMEORIGIN`) on all responses to prevent clickjacking. | `src/test/security/invariants.test.ts` | `SEC-021: X-Frame-Options is DENY or SAMEORIGIN` | OWASP Secure Headers; clickjacking |
| SEC-022 | headers | Every Subresource Integrity hash must be a valid `sha256-`/`sha384-`/`sha512-` base64 digest. | `src/test/security/invariants.test.ts` | `SEC-022: SRI hashes are well-formed` | W3C SRI; supply-chain integrity |
| SEC-023 | headers | All external resources must be loaded over HTTPS only. | `src/test/security/invariants.test.ts` | `SEC-023: external resources are HTTPS-only` | OWASP Transport Layer; mixed-content |
| SEC-024 | corrections | Every correction is append-only: applying a correction must never mutate or delete a prior ledger/NAV/queue record; it inserts a new record that references the superseded record by id. | `src/test/security/invariants.test.ts` | `SEC-024: correction is append-only and references superseded record` | Audit trail integrity; CWE-778 |
| SEC-025 | corrections | Maker-checker is enforced server-side: a correction proposed by operator A must be rejected when approved by operator A (self-approval), regardless of UI state. | `src/test/security/invariants.test.ts` | `SEC-025: self-approval is rejected server-side` | Four-eyes principle; CWE-863 |
| SEC-026 | corrections | A pending approval past its expiry window must be rejected and the correction must not transition to `applied`. | `src/test/security/invariants.test.ts` | `SEC-026: expired approval cannot be applied` | CWE-613; time-bound authorization |
| SEC-027 | corrections | Corrections exceeding the magnitude threshold, or that change a published epoch's committed NAV, must require the higher approval tier; a single standard approver is insufficient. | `src/test/security/invariants.test.ts` | `SEC-027: high-magnitude / published-NAV corrections require higher approval tier` | Defense in depth; CWE-269 |
| SEC-028 | corrections | Applying the same correction twice must be idempotent — the second application is a no-op and does not create a duplicate compensating entry. | `src/test/security/invariants.test.ts` | `SEC-028: repeated application of a correction is idempotent` | CWE-837; replay safety |
| SEC-029 | corrections | A correction is applied atomically across the ledger, indexer, and read model; a failure mid-application must leave no partially applied state. | `src/test/security/invariants.test.ts` | `SEC-029: correction application is atomic (no partial state)` | CWE-362; transactional integrity |
| SEC-030 | corrections | After application, the reconciliation job must fail loudly when corrected off-chain state diverges from on-chain balances. | `src/test/security/invariants.test.ts` | `SEC-030: reconciliation fails loudly on on-chain/off-chain divergence` | CWE-754; integrity monitoring |

## Collateral custody

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

## Admin Correction Catalog (Issue #293)

Corrections are first-class domain objects with the state machine
`proposed → approved → applied → reconciled` (with `rejected` and `expired`
as terminal branches). They are emitted through the same event/outbox path
as normal ledger writes so indexing and notifications stay consistent.

| Correction Type | Invariants | Blast Radius |
|---|---|---|
| **Compensating ledger entry** | Append-only; references superseded entry; idempotent by correction id. | Affects the affected account's balance and the epoch aggregate; does not alter historical entries. |
| **NAV snapshot restatement** | Append-only; supersedes the prior snapshot; changing a published epoch's committed NAV requires the higher approval tier. | Affects NAV, share price, and all depositor valuations for the affected epoch; propagates to the read model behind `src/lib/api/vaults.ts`. |
| **Queue-entry repair** | Append-only; references the stuck queue entry; must not reorder unrelated entries. | Affects the withdrawal queue ordering/state for the affected depositor; triggers reconciliation. |
| **Fee reclassification** | Append-only; references the mis-booked fee entry. | Affects fee accounting and net NAV; does not delete the original fee record. |
| **Indexer cursor rewind** | Append-only; records the prior cursor and the rewind target. | Affects indexer replay from the rewind point; must reconcile to on-chain state before completion. |

### Maker-Checker Rules

- A correction is proposed by one operator with a written reason and an evidence link.
- A **different** operator must approve; self-approval is rejected server-side (SEC-025).
- Approvals expire; an expired approval cannot be applied (SEC-026).
- Magnitude thresholds and published-NAV changes route to the higher approval tier (SEC-027).
- Application is idempotent (SEC-028) and atomic across ledger, indexer, and read model (SEC-029).
- Post-application reconciliation must confirm corrected state matches on-chain balances and fail loudly otherwise (SEC-030).

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
