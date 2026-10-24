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

## Vault Event Indexer: Checkpoint, Backfill & Replay Runbook

This section is the operator runbook for the vault event indexer (issue #287).
It covers durable cursor checkpoints, safe backfill from an arbitrary ledger,
and replay into a shadow dataset so a schema change or an indexer outage can
be corrected by re-reading the chain rather than by hand-patching rows.

### Cursor Checkpointing

The indexer persists a cursor of `(ledger_sequence, ledger_hash)` durably. The
cursor is written **in the same transaction** as the events it describes, so
the cursor can never advance ahead of the data it accounts for. On restart the
indexer resumes from the last committed cursor; if the stored `ledger_hash`
does not match the chain's hash for that sequence (a reorg or a bad write), the
indexer refuses to advance and surfaces a gap alert instead of silently
skipping.

### Idempotent Upserts

All event writes are upserts keyed by
`(contract_id, ledger_sequence, transaction_hash, event_index)`. Re-ingesting
an overlapping range — including a range that overlaps already-promoted data —
updates the existing row in place and cannot double-count share issuance, epoch
transitions, fee accrual, or redemptions.

### Backfill

Backfill ingests a ledger range with configurable concurrency and rate
limiting, and resumes safely if interrupted (it re-reads the persisted cursor
and continues from the next unprocessed ledger). The write path and the
backfill path share one pure `event → row` function; only the
reading/checkpointing layer differs.

```
# Ingest ledgers 1000..2000 with bounded concurrency and rate limiting
indexer backfill --from 1000 --to 2000 --concurrency 4 --rate-limit 10/s
```

Edge cases handled: a ledger containing several events for the same position
(each gets a distinct `event_index`), partially closed ledgers (the cursor only
advances past a ledger once all its events are committed), and a mid-backfill
schema deploy (the run aborts cleanly and resumes from the last committed
cursor).

### Replay into a Shadow Dataset

Replay re-derives events from chain and writes them into a shadow table/schema
for comparison before promotion. Because upserts are idempotent, replaying a
range that overlaps promoted data is safe.

```
# Re-derive ledgers 1000..2000 into the shadow schema
indexer replay --from 1000 --to 2000 --target shadow
```

Compare re-derived aggregates (share totals, fee totals) against the live
tables before promoting. A replay test asserts the re-derived aggregates match
pre-replay values, and a duplicate-event test asserts re-ingestion is a no-op.

### Gap Detection & Lag Alerting

A contiguity check verifies the ingested range has no holes, and an ingestion
lag check alerts when the cursor falls more than a threshold behind the chain
head. Both raise alerts rather than failing silently.

### Promotion / Rebuild Runbook

1. **Quiesce** — pause the live indexer so no new writes land during the run.
2. **Backfill** — ingest the target range (or the full history) with the
   backfill command above; it resumes safely if interrupted.
3. **Verify aggregate invariants** — compare share totals, fee totals, and
   epoch transitions against the shadow dataset and chain state.
4. **Promote** — swap the shadow dataset into the live tables once invariants
   hold.
5. **Resume** — restart the live indexer; it resumes from the persisted
   cursor and continues ingesting.

Out of scope for this runbook: the initial event ingest implementation and the
event schema versioning policy (tracked in separate issues).
