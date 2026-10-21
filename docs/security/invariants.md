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
| **twab** | `twab` | Time-weighted average balance of vault shares (issue #272). Checkpointed cumulative-balance accumulator on the SEP-41 share token; `balance_at(account, timestamp)` and `twab(account, start, end)` read from binary-searchable checkpoints. |

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
| SEC-021 | twab | `twab(account, start, end)` must be bounded by the minimum and maximum instantaneous balance over `[start, end]`; it can never exceed the max or fall below the min. | `src/test/security/invariants.test.ts` | `SEC-021: twab is bounded by min and max instantaneous balance over the window` | Issue #272; prevents last-block deposit/withdraw gaming |
| SEC-022 | twab | A zero-length window (`start == end`) must return the instantaneous `balance_at(account, start)` and must never divide by zero. | `src/test/security/invariants.test.ts` | `SEC-022: zero-length twab window returns instantaneous balance without division by zero` | Issue #272; rounding/div-by-zero spec |
| SEC-023 | twab | The cumulative-balance accumulator must be monotonically non-decreasing across interleaved mint/burn/transfer sequences, and checkpoints are written only on share mutation. | `src/test/security/invariants.test.ts` | `SEC-023: cumulative balance is monotonic and checkpoints only on share mutation` | Issue #272; fuzz target for monotonic accumulator |

---

## TWAB Checkpoint Retention Policy (Issue #272)

The vault share token maintains a per-account checkpointed cumulative-balance accumulator. Each checkpoint stores `(timestamp, cumulative_balance)` where `cumulative_balance` is the integral of the instantaneous share balance up to `timestamp`. `balance_at` and `twab` binary-search these checkpoints; no unbounded loops are performed.

**Retention / compaction:**

- Checkpoints are written **only** on share mint, burn, and transfer — never on read paths — so the accumulator cannot be bypassed by a new entry point.
- Timestamps are ledger-close-time (never wall-clock) and are strictly monotonic; a checkpoint at the same ledger timestamp as the previous one overwrites rather than appends.
- History is bounded to `MAX_CHECKPOINTS` per account (a fixed constant). When the bound is reached, the oldest checkpoints are compacted: the earliest retained checkpoint is rewritten to carry the cumulative value forward, preserving the integral while freeing entries.
- Compaction is coordinated with the storage-TTL work: retained checkpoints are extended via `extend_ttl` on write so live accounts never lose their accumulator to rent expiry.
- Overflow: cumulative balance is a `u128`; the documented bound is `max_balance * max_window_seconds < 2^128`, enforced by the fixed `MAX_CHECKPOINTS` and ledger-time bounds.
- TWAB is read-only weighting: it must never be usable to mint value, only to weight governance/allocation/fee tiers.

---

## Notes

- SEC-019 documents an intentional exception (global hotkeys) rather than a violation.
- SEC-021–SEC-023 cover the TWAB accumulator introduced in issue #272; see the retention policy above for the bounded-history and TTL coordination details.
