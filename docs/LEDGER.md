# Ledger Hardware Wallet Support

Zenith supports connecting a **Ledger hardware wallet** as an alternative to
the Freighter browser extension. Ledger gives high-value users and treasuries
a hardware-backed signing path with no seed phrase in the browser.

## Supported Browsers

- **Chrome / Edge / Brave (Chromium)** — WebHID is preferred; WebUSB is the
  fallback when WebHID is unavailable.
- **Firefox** — no WebHID support. Ledger connections are not available in
  Firefox; the UI shows a clear error rather than a silent hang.
- **Safari** — not supported (no WebHID/WebUSB on desktop Safari).

## Connecting

1. Open the **Stellar app** on your Ledger device.
2. Open Zenith, open the wallet menu, and choose **Connect Ledger**.
3. When prompted, enter the **BIP44 account index** (default `0`). The
   derivation path used is `44'/148'/<index>'`.
4. Zenith requests the device public key; the address is shown on-screen for
   on-device verification (the Ledger screen displays the same address —
   compare it before confirming).
5. The backend sign-in message is then signed by the device. The signature
   is a base64-encoded 64-byte ed25519 signature of the SHA-256 hash of the
   challenge message.

## Signing Transactions

- **Stellar (Payment/ManageData) transactions**: signed via the Ledger
  Stellar app's `signTransaction` API, with the full transaction XDR.
- **Soroban transactions**: the Ledger app supports hash-signing. Soroban
  auth entries that require a hash signature are signed with `signHash`.
  If the simulation indicates a Soroban auth entry the device cannot sign
  directly, the UI explains the hash-signing requirement before prompting.

## Error Handling

| Situation | Message |
| --- | --- |
| Device locked / Stellar app not open | "Ledger did not return an address; ensure the Stellar app is open on the device" |
| User rejected on-device | "User rejected the operation on the Ledger device" |
| Browser unsupported (Firefox) | "No Ledger transport available: WebHID transport not available; WebUSB transport not available" |
| Backend sign-in failed | "Backend sign-in failed" (token left null; the wallet stays connected) |

## Manual Test Report

| Field | Value |
| --- | --- |
| Device model | Ledger Nano S Plus / Nano X |
| Firmware | 2.x (Stellar app 6.x) |
| Browser | Chrome 124+ |
| Transport used | WebHID (fallback to WebUSB) |
| Derivation path | `44'/148'/0'` |
| Sign-in flow | Backend nonce → SHA-256 → `signHash` → base64 → `/auth/verify` |
| Soroban hash-signing | Verified with a Soroban auth entry requiring hash signing |

## Notes

- The transport is kept open until the user disconnects. Disconnecting the
  wallet store does not close the transport; reload the page to release the
  USB handle.
- Ledger support is **lazy-loaded**: the `@ledgerhq/*` packages are only
  fetched when the user chooses "Connect Ledger", keeping the main bundle
  small.
- Soroban auth entries that require hash signing are documented here because
  the device cannot display arbitrary Soroban contract details. Always
  review the transaction hash on the Ledger screen before confirming.

## Admin Correction & Ledger Adjustment Tool (Four-Eyes Approval)

Operators correct vault accounting mistakes through a controlled, append-only
write path. Corrections are **first-class domain objects** with a state machine
(`proposed → approved → applied → reconciled`, plus `rejected` / `expired`),
never ad-hoc SQL. They are emitted through the same event/outbox path as normal
ledger writes so indexing and notifications stay consistent.

### Correction Catalog

Each correction type declares its invariants and blast radius. All corrections
are **append-only**: they never mutate or delete prior records, and each
correction references the record it supersedes (`supersedesId`).

| Type | Invariants | Blast radius |
| --- | --- | --- |
| `compensating_ledger_entry` | Debits/credits net to zero against the superseded entry; entry is never edited in place | Ledger totals, NAV, affected depositor balances |
| `nav_snapshot_restatement` | New snapshot supersedes the prior one; committed NAV of a published epoch requires the higher approval tier | NAV, share price, on-chain NAV feed |
| `queue_entry_repair` | Repaired entry preserves FIFO ordering and total queued amount | Withdrawal queue state, affected depositors |
| `fee_reclassification` | Reclassified fee preserves total fees collected; only the category changes | Fee accounting, NAV |
| `indexer_cursor_rewind` | Rewind target is a previously committed cursor; replay is idempotent | Indexer cursor, read model behind `src/lib/api/vaults.ts` |

### Maker-Checker Enforcement

- One operator **proposes** with a written `reason` and an `evidenceLink`.
- A **different** operator **approves**. Self-approval is rejected
  **server-side**, not just in the UI.
- Approvals **expire**; an expired approval cannot be applied.
- **Magnitude thresholds** route larger corrections to an additional approver
  role. Corrections that would change a published epoch's committed NAV
  require the higher approval tier.

### Dry-Run Preview & Reconciliation

- A dry-run preview shows the resulting NAV, share price, queue state, and
  affected depositors **before** approval.
- After application, the reconciliation job must confirm the corrected state
  matches on-chain balances and **fail loudly** when on-chain and off-chain
  state diverge.
- Corrections propagate to the indexer, the read model behind
  `src/lib/api/vaults.ts`, and downstream consumers **atomically**; partially
  applied corrections are impossible.

### Edge Cases

- Corrections touching a vault with pending redemptions or an in-flight epoch
  are flagged in the preview.
- Corrections applied after on-chain state has already moved are reconciled
  against the current on-chain balances.
- Repeated application of the same correction is **idempotent**.
- Rejection and expiry paths leave prior records untouched.
- Corrections affecting NAV already published to the on-chain NAV feed require
  the higher approval tier.

### Out of Scope

Routine parameter changes (timelocked parameter workflow) and the read-only
support console diagnostics are handled elsewhere and are not part of this
correction path.
