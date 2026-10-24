# Vault Threat Model — Zenith Frontend

Issue [#204](https://github.com/Zenith-options/frontend/issues/204) · Baseline commit `21925df` (`main`)

This model covers the Phase 2 vault stack as seen from this repository: the
frontend, the BFF, and the vault client code. The vault contracts, the
indexer and the operator backend are **not in this repository**. They are
covered here only as trust boundaries and privileged capabilities. Their own
threat models must come from the contracts and backend repositories before
the audit.

The model is anchored on **trust boundaries and privileged capabilities**,
not on files. Each threat is stated as "who can do what, across which
boundary", so the findings stay valid as the implementation moves.

---

## 1. Trust boundaries

```
 ┌────────────┐  B1: httpOnly   ┌──────────┐  B2: bearer   ┌─────────────────┐
 │ Browser    │  cookie + CSRF  │ BFF      │  token        │ Operator        │
 │ (frontend, │ ───────────────▶│ (Next.js │ ─────────────▶│ backend (off    │
 │  Freighter)│                 │  routes) │               │ repo): builds   │
 └─────┬──────┘                 └──────────┘               │ XDR, runs epoch │
       │ B3: unsigned XDR ◀──────────────────────────────── │ automation, NAV │
       │     returned by backend (BLIND SIGNING)            │ and strikes     │
       ▼                                                    └────────┬────────┘
 ┌────────────┐  B4: Horizon REST / RPC                             │ B5: operator
 │ Freighter  │ ──────────────────────▶ Horizon / Soroban RPC ◀─────┘ and admin keys
 │ wallet     │   (submit, history)     (event source for history)
 └────────────┘                                   │
                                                  ▼
                                   Vault contract (off repo): escrow ledger,
                                   epoch state, pause, upgrade
```

| Boundary | What crosses it | Who is trusted to what |
|---|---|---|
| **B1** Browser ↔ BFF | Session cookie (sealed), CSRF token, request bodies | BFF authenticates the user; browser JS never sees the bearer token |
| **B2** BFF ↔ backend | Bearer token, proxied JSON | Backend enforces wallet ownership of every position and vault |
| **B3** Backend → wallet (via browser) | Transaction XDR the user signs | **Backend is only trusted to build what the user asked for.** The frontend is the last check before signature. |
| **B4** Frontend ↔ Horizon/RPC | Signed XDR submission, event history | Horizon is trusted for history today; no independent check |
| **B5** Operator/admin ↔ contract | Epoch transitions, strike and NAV inputs, pause, upgrade | Off repo. The frontend has no path to these. |

## 2. Privileged capabilities

| Capability | Holder | Reachable from this repo? |
|---|---|---|
| Move depositor collateral (withdraw authority) | Depositor's own signature, via a backend-built XDR | **Yes**: `src/lib/api/vault.ts` signs whatever XDR the backend returns |
| Set NAV inputs and mark-to-market | Operator backend / oracle feeders | Displayed here (`sharePrice`, `pnlPct`). Not set here. |
| Set strike and run epoch transitions | Operator automation | Displayed here (`currentStrike`, `currentPhase`, `phaseEndsAt`). Not set here. |
| Pause | Contract admin | Read only as a `ContractPaused` error code (`src/lib/soroban/errorCodes.ts`). No vault pause state is read. |
| Upgrade contract WASM | Contract admin | Only as the WASM-hash check in `src/lib/soroban/registry.ts` |
| Operator signing keys | Off-chain operator | No |

## 3. Assumptions (from the issue)

- The operator key may be **compromised**.
- The indexer or Horizon may be **delayed or forked**.
- The mark source may be **manipulable**.

These are the adversary model. A threat that needs one of them is in scope.

---

## 4. Threat register

**Disposition** is one of:
- **Mitigated**: a control exists in this repo, with evidence cited.
- **Mitigated (external)**: the control is in the contracts or backend repo and must be verified there before the audit.
- **Open**: no adequate control. A follow-up issue is required before the `vaults` flag leaves canary.
- **Accepted**: a documented residual risk with an owner and an expiry.

Owners are **proposed**, using the team labels already in `src/lib/flags/registry.ts` (`vaults`, `protocol`). Reviewers must confirm them before the audit. Follow-up issue numbers are not filed yet; see `F-xx` below.

### 4.1 Collateral custody and withdrawal authority

| ID | Threat | Severity | Evidence | Disposition | Owner (proposed) |
|---|---|---|---|---|---|
| **VT-01** | A compromised or buggy backend returns an XDR that moves funds somewhere other than the requested deposit or withdrawal, and the user signs it. This is blind signing across **B3**. | **Critical** | `depositToVault` and `withdrawFromVault` in `src/lib/api/vault.ts` take the backend `xdr`, call `freighterApi.signTransaction` and submit. Neither decodes the XDR, nor compares it with the requested amount, recipient, or contract. The clear-signing pipeline (`src/lib/soroban/pipeline.ts`, `intent.ts`, `tx.ts`, `docs/clear-signing.md`, #119) is wired into governance (`src/lib/governance/submit.ts`) but **not** into vault flows. | **Open**: `F-01`. Route vault build and sign through `reviewTransaction` / `assertVerified` / `assertSignedMatchesReviewed`, with a vault intent spec in `contracts/spec.ts`. Required before the flag leaves canary. | vaults |
| **VT-02** | Withdrawal overdraws collateral locked by open positions. | High | The frontend check `amount > freeCollateral` in `vault.ts` and `DepositWithdrawModal.tsx` is UX only and client-controlled. | **Mitigated (external)** for the contract, which the registry describes as a per-tag escrow ledger that cannot draw more than was deposited under a tag. **Open** for the backend build path: `F-02` needs a server-side free-collateral check in `build-withdraw` and contract test evidence cited here. | vaults |
| **VT-03** | Wrong or stale XDR is submitted to a different contract ID than `NEXT_PUBLIC_VAULT_CONTRACT_ID`. | High | `VAULT_CONTRACT_ID` is only checked for non-null, not compared with the XDR's invoked contract. Three env names are in use (see `F-10`). | **Open**: folded into `F-01` (the intent check must compare the invoked contract ID). | vaults |

### 4.2 Oracle, strike-setting and mark-to-market manipulation

| ID | Threat | Severity | Evidence | Disposition | Owner (proposed) |
|---|---|---|---|---|---|
| **VT-04** | A manipulated NAV, `sharePrice`, `pnlPct` or `currentStrike` is shown to the depositor, who then deposits or withdraws on a false number. | High | The vault detail page renders `sharePrice`, `currentStrike`, `historicalEpochs[].pnlPct` and `userPosition.totalValue` straight from the API (`src/lib/api/vaults.ts`). No source or staleness is shown. The live path is still a mock (`NEXT_PUBLIC_VAULTS=mock`). | **Open** for the live path: `F-03` shows NAV source, timestamp and staleness, and cites the price-oracle quorum rule from the registry. **Accepted** while the flag is off by default (`defaultValue: false`), until `F-03` lands, expiry at canary. | vaults |
| **VT-05** | Strike selection is set by an operator and is not verifiable by depositors. | High | The strike is a single backend value. The payoff text is static copy (`payoffExplanation`). | **Mitigated (external)** if the strike is an on-chain input the contract checks. Otherwise **Open**: `F-03`. | protocol |

### 4.3 Epoch automation failure and stale state

| ID | Threat | Severity | Evidence | Disposition | Owner (proposed) |
|---|---|---|---|---|---|
| **VT-06** | Automation stops or lags. The UI keeps showing "Deposits open" while the epoch has advanced or the operator is down, so deposits land in the wrong epoch. | High | `currentPhase` and `phaseEndsAt` come from the API. The deposit flow in `DepositWithdrawModal.tsx` and the vault page does not check the phase before building (no phase check found in those flows). The page shows phase copy only. | **Open**: `F-04` gates deposit and withdraw on a fresh phase read and shows a stale-data banner when `phaseEndsAt` has passed. | vaults |
| **VT-07** | The contract is paused and the user only learns about it after signing. | Medium | `ContractPaused` is mapped to a message (`errorCodes.ts`). Pause state is not read ahead of signing. | **Open**: `F-08`. Read pause state before building the transaction. | vaults |

### 4.4 Indexer and event forgery, replay

| ID | Threat | Severity | Evidence | Disposition | Owner (proposed) |
|---|---|---|---|---|---|
| **VT-08** | Forged, delayed or forked history shows a deposit or withdrawal that did not happen, or hides one that did. | Medium | `fetchVaultHistory` in `vault.ts` reads Horizon at `NEXT_PUBLIC_HORIZON_URL` (default `horizon-testnet.stellar.org`) and trusts the response. No cross-check against Soroban RPC or ledger state. | **Open**: `F-05` cross-checks history against RPC (`getTransaction`) and shows an unverified badge on mismatch. Display-only: no funds are at risk from this path. | vaults |
| **VT-09** | Replay of a signed transaction, or of a backend-built XDR. | Medium | Replay protection for submitted Stellar transactions comes from the account sequence number and the transaction's time bounds. This repo does not set or check either for vault XDR. The check is assumed from the Stellar protocol and the backend, not verified here. | **Mitigated (external)**: the protocol enforces sequence numbers. **Open**: `F-01` must check time bounds in the intent verification. | vaults |

### 4.5 Multi-tenant cross-vault access

| ID | Threat | Severity | Evidence | Disposition | Owner (proposed) |
|---|---|---|---|---|---|
| **VT-10** | A wallet reads or acts on another wallet's position or vault through a crafted `:id`. | High | The BFF allowlist limits `:id` to `[A-Za-z0-9_-]{1,128}` and rejects traversal and encoded separators (`src/lib/bff/allowlist.ts`, `isSafePath`). Ownership of a position is decided only by the backend from the bearer token. No frontend check exists. | **Mitigated** for path injection (allowlist and `isSafePath`). **Open** for ownership: `F-06` adds backend tests that a token for wallet A cannot read or move wallet B's vault position, and cites them here. | vaults |
| **VT-11** | Per-wallet client state leaks between wallets on a shared browser. | Low | Vault state is not in `localStorage` in this repo. Existing isolation invariants SEC-017 to SEC-020 cover rules, layouts and anti-phishing phrases. | **Mitigated** for the existing keys. New vault keys must follow the same `zenith.<kind>.<address>` pattern. | frontend |

### 4.6 BFF session and auth boundary

| ID | Threat | Severity | Evidence | Disposition | Owner (proposed) |
|---|---|---|---|---|---|
| **VT-12** | Theft of the bearer token by JS (XSS) or from storage. | High | The token is AES-256-GCM sealed in an httpOnly, Secure, SameSite=Strict cookie with the `__Host-` prefix when secure (`src/lib/bff/session.ts`). The token never appears in a response body. Invariants SEC-014 to SEC-016 cover storage. | **Mitigated**. Residual: XSS can still issue same-origin requests while the page is open. CSP (#117) and CSRF narrow this. Accepted for the window the page is open. | protocol |
| **VT-13** | Cross-site request forgery on vault mutations. | High | Origin check plus a double-submit token (`src/lib/bff/csrf.ts`) on every mutating method. | **Mitigated**. Exercised in `src/lib/bff/__tests__/bff.test.ts`. | protocol |
| **VT-14** | A stolen sealed cookie keeps working for its whole lifetime. | Medium | Session is fixed at 24 hours (`SESSION_MS`), or the backend JWT `exp` if it is shorter. The cookie is not bound to the client. A 401 from the backend clears it. | **Accepted**. Residual window is up to 24 hours per stolen cookie. Owner: protocol. Rationale: binding a cookie to a client fingerprint adds breakage without stopping a same-origin attacker. Expiry: review at canary exit. | protocol |
| **VT-15** | The BFF session secret is weak or missing. | High | Production throws unless `BFF_SESSION_SECRET` is at least 32 characters (`sessionSecret()`). Dev uses an ephemeral random secret. | **Mitigated** in production. Deployment must set the secret from a secret manager, not a committed file. | protocol |
| **VT-16** | The vault client cannot run at all, so the signing path cannot be audited as shipped. | Blocker | `src/lib/api/client.ts` is a **zero-byte file at HEAD** (`git show HEAD:src/lib/api/client.ts` is empty). It is imported by 27 modules. `apiGet` and `bffFetch` are not defined anywhere. `vault.ts` and `reconciliation.ts` call `bffFetch`. | **Open**: `F-00`. Restore `client.ts` (with the CSRF header on mutating calls) before any vault code is reviewed for audit. | frontend |

### 4.7 Operator action abuse

| ID | Threat | Severity | Evidence | Disposition | Owner (proposed) |
|---|---|---|---|---|---|
| **VT-17** | An operator or admin action is reachable through the public BFF, or the frontend holds an operator credential. | Critical | The BFF allowlist has no admin or operator routes (`allowlist.ts`). The frontend holds no operator key. | **Mitigated** in this repo. | protocol |
| **VT-18** | A single operator key can move collateral, change the strike or upgrade the contract. | Critical | Off repo. The registry has a `multisig` contract (M-of-N approval for opaque actions). Whether vault admin actions go through it is not visible here. | **Mitigated (external)** only if verified: `F-07` must show every vault admin and upgrade path is behind multisig, with the signer set and threshold written down. | protocol |
| **VT-19** | A governance action pauses or changes a vault through the options-market path. | Medium | `src/lib/governance/actions.ts` has `set_paused` for the market. Governance uses the clear-signing pipeline. | **Mitigated** for this path. Whether vault admin actions can use the same route is **Open** under `F-07`. | protocol |

### 4.8 Configuration and substitution (cross-cutting)

| ID | Threat | Severity | Evidence | Disposition | Owner (proposed) |
|---|---|---|---|---|---|
| **VT-20** | A misconfigured deploy points the app at the wrong Horizon or contract, so users sign against the wrong target. | High | `NEXT_PUBLIC_HORIZON_URL` and the vault contract ID are build-time values. The vault contract ID has three names (`F-10`). Registry deployments are empty, so the live WASM-hash check cannot run. | **Open**: `F-10` consolidates the env names and fails the build when the vault contract ID is set but the Horizon host is not in an allowlist. | frontend |
| **VT-21** | Query-string overrides enable a feature in production. | Medium | The `?flags=` override is development-only (`src/lib/flags/resolve.ts`, `allowQueryOverride`). The `vaults` flag defaults to off. | **Mitigated**. | vaults |
| **VT-22** | Compromised frontend build or dependency that rewrites the transaction prompt. | Critical | Inherited from the existing supply-chain controls in `SECURITY.md` (audit gate, OSV, lockfile-lint, install-script allowlist, license gate, SRI). | **Mitigated** under `SECURITY.md`. No vault-specific packages were added in this repo. | frontend |

---

## 5. Follow-up issues (not yet filed)

Each item must be filed as a GitHub issue, linked here, and closed before the `vaults` flag moves past canary.

| ID | Summary | Threats | Blocks canary exit |
|---|---|---|---|
| **F-00** | Restore `src/lib/api/client.ts` (`apiGet`, `bffFetch`, CSRF header on mutations). | VT-16 | Yes |
| **F-01** | Route vault build and sign through clear-signing (`reviewTransaction`, `assertVerified`, `assertSignedMatchesReviewed`) with a vault intent spec. Check the invoked contract ID, amount, recipient and time bounds. | VT-01, VT-03, VT-09 | Yes |
| **F-02** | Server-side free-collateral check in `build-withdraw`, plus contract test evidence cited in this doc. | VT-02 | Yes |
| **F-03** | Show NAV and strike source, timestamp and staleness. Document the oracle quorum rule the UI relies on. | VT-04, VT-05 | Yes |
| **F-04** | Gate deposit and withdraw on a fresh phase read. Show a stale-data banner past `phaseEndsAt`. | VT-06 | Yes |
| **F-05** | Cross-check history against Soroban RPC. Show an unverified badge on mismatch. | VT-08 | No (display only) |
| **F-06** | Backend tests: wallet A cannot read or move wallet B's vault position. Cite them here. | VT-10 | Yes |
| **F-07** | Document and verify that every vault admin and upgrade path is behind multisig, with signer set and threshold. | VT-18, VT-19 | Yes |
| **F-08** | Read pause state before building a vault transaction. | VT-07 | No |
| **F-10** | Consolidate the vault contract ID env var (`NEXT_PUBLIC_CONTRACT_VAULT_TESTNET`, `NEXT_PUBLIC_TESTNET_VAULT_CONTRACT_ID`, `NEXT_PUBLIC_VAULT_CONTRACT_ID`) to one name, and fail the build on an inconsistent configuration. | VT-03, VT-20 | Yes |

## 6. Accepted risks

| Risk | Rationale | Owner | Expiry |
|---|---|---|---|
| VT-14: stolen 24h session cookie | Client-binding adds breakage without stopping a same-origin attacker | protocol | Canary exit review |
| VT-12: XSS while the page is open | Bounded by CSP and CSRF. Removing it needs a different architecture. | protocol | Canary exit review |
| VT-04/VT-05: unverified NAV and strike in the UI | Feature is off by default, and the live data path is still a mock. Blocks GA, not canary. | vaults | Until `F-03` ships |

## 7. Review and maintenance

- Re-run this model when the trust boundaries change: a new BFF route, a new
  signing path, a new privileged capability, or a new data source for NAV or
  history.
- Every threat must keep an owner and a disposition. A threat without either
  is incomplete, and review should reject it.
- Related docs: [`docs/security/invariants.md`](invariants.md) (frontend
  SEC-001 to SEC-023), [`docs/clear-signing.md`](../clear-signing.md),
  [`SECURITY.md`](../../SECURITY.md), and
  [`docs/security/vault-audit-package.md`](vault-audit-package.md).
