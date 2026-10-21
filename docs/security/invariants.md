# Security Invariants — Zenith Frontend

## Issue #130: Security Regression Test Suite

---

## Introduction

Security invariants are properties of the system that must hold unconditionally, regardless of feature changes, refactors, or dependency upgrades. Encoding them as automated tests rather than prose documentation serves three purposes:

1. **Regression prevention.** A future commit that accidentally removes HTTPS enforcement, weakens nonce validation, or leaks tokens across wallet namespaces will fail CI immediately, with a named invariant ID pointing to the exact contract that was broken.

2. **Living specification.** The test file is the authoritative source of truth for each invariant. The table below cross-references it so reviewers can jump from requirement to implementation and back.

3. **Audit trail.** Each invariant has a stable ID (`SEC-NNN`). Security audits, vulnerability reports, and pull requests can reference these IDs without ambiguity. When an invariant is tightened or relaxed, the history of that change is visible in `git log` on both this file and the test.

All 23 invariants live in a single file so the entire suite can be run in isolation, with no dependency on a running backend or browser extension:

```bash
npm test src/test/security/invariants.test.ts
```

---

## Domain Definitions

| Domain | Abbreviation | Scope |
|---|---|---|
| **signing** | `signing` | Challenge/response authentication: parsing, field validation, expiry, origin binding, nonce entropy, version gating. Covers the Freighter sign-in flow (`src/lib/auth/challengeValidator.ts`). |
| **input** | `input` | User-supplied address validation. Specifically the address-poisoning heuristic that detects look-alike wallet addresses designed to fool copy-paste. |
| **session** | `session` | Bearer token lifecycle: where tokens are stored, that logout clears them completely, and that tokens never appear in URLs. |
| **isolation** | `isolation` | Per-wallet namespacing in `localStorage`. Alert rules, workspace layouts, and anti-phishing phrases must not bleed between wallet accounts. Hotkeys (non-sensitive) are explicitly documented as intentionally global. |
| **headers** | `headers` | Structural HTTP and subresource security: `X-Frame-Options`, SRI hash format correctness, and the HTTPS-only policy for external resources. |
| **corrections** | `corrections` | Admin correction / ledger adjustment write path (Issue #293). Append-only compensating entries, maker-checker (four-eyes) approval, expiry, magnitude-tiered approval, and post-application on-chain reconciliation. |

---

## Invariants Table

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

---

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
