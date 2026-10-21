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

## Vault Data Warehouse & Analytics ETL

The vault analytics warehouse is a separate, read-only analytical store. It
is populated by scheduled ETL jobs that extract from the vault event indexer,
the historical epoch ledger, and the vault registry, then transform into
modeled marts. Dashboards and reporting exports query the warehouse — never
the operational database.

### Schemas

| Table | Grain | Key columns |
| --- | --- | --- |
| `raw_events` | one row per indexer event | `event_id`, `ledger`, `cursor`, `contract`, `topic`, `payload`, `ingested_at` |
| `vault_registry_snapshots` | vault × snapshot time | `vault_id`, `snapshot_at`, `strategy`, `strike_bucket`, `status` |
| `epoch_facts` | one row per epoch | `vault_id`, `epoch_id`, `opened_at`, `closed_at`, `nav_open`, `nav_close`, `premium_collected`, `fees`, `realized_pnl` |
| `flow_facts` | one row per deposit/withdrawal/queue event | `flow_id`, `vault_id`, `epoch_id`, `kind` (`deposit`/`withdrawal`/`queue_enter`/`queue_exit`), `amount`, `shares`, `occurred_at` |
| `share_price_series` | vault × timestamp | `vault_id`, `observed_at`, `share_price` |
| `redemption_queue_depth` | vault × timestamp | `vault_id`, `observed_at`, `depth`, `pending_shares` |

### ETL & Watermarking

- Jobs are **idempotent and replayable**. Each run reads the persisted
  watermark (`etl_watermarks.job`, `etl_watermarks.cursor`) and processes
  events strictly after it, upserting by natural key (`event_id`, `epoch_id`,
  `flow_id`) so replays never double count.
- The watermark advances only after a successful transform + data-quality
  gate. A failed gate leaves the watermark untouched so the next run retries
  the same window.
- **Backfills and restatements**: pass an explicit `--from-cursor` to replay
  a historical window. Admin epoch corrections are accepted as restatements —
  the affected `epoch_facts` row is replaced (not appended) and downstream
  marts are recomputed for that epoch.
- **Reorgs / cursor regressions**: if the indexer cursor moves backwards
  (chain restart), the job rewinds the watermark to the earliest affected
  ledger and reprocesses; upserts make this safe.

### Data-Quality Gates

Each transform run asserts, and **fails loudly** (non-zero exit, no mart
writes) when any check fails:

- **Row counts**: raw events consumed > 0 for a non-empty window; no epoch
  with zero flows when NAV moved.
- **Monotonic NAV timestamps**: `nav_close` timestamps strictly increase per
  vault; out-of-order snapshots abort the run.
- **Flow-to-epoch reconciliation**: sum of `flow_facts.amount` per epoch
  reconciles against the on-chain ledger totals for that epoch within
  tolerance; mismatches abort rather than writing bad aggregates.

### Backfill Runbook

1. Identify the target window (cursor range or epoch range).
2. Run `etl --job <name> --from-cursor <cursor>` against a staging warehouse.
3. Inspect data-quality gate output; fix source data or transform if it fails.
4. Re-run against production; the watermark advances only on success.
5. For restatements, replay the affected epoch and confirm `epoch_facts`
   and dependent marts reflect the corrected values.

### Access & PII

- Dashboards and exports use a **read-only** warehouse role; ETL uses a
  separate write role. Credentials live in the job runner's secret store,
  never in the app runtime.
- No depositor-identifying fields are stored beyond what the data retention
  policy permits; flows are keyed by opaque `flow_id`.
