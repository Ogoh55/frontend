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

## Idle Collateral Yield (Lending Integration)

Vault strategies may earn incremental yield on collateral that sits idle
between option sales — most notably USDC held in cash-secured-put and
iron-condor vaults. Idle collateral is swept into an existing Soroban lending
market and unwound before it is needed. The option-selling strategy itself is
unchanged.

### Collateral-Deployment Policy (per strategy)

Each strategy declares a deployment policy:

| Field | Meaning |
| --- | --- |
| `targetUtilizationBps` | Max share of *idle* collateral that may be lent (e.g. `8000` = 80%). |
| `minLiquidBufferBps` | Minimum share of total collateral that must stay liquid (e.g. `2000` = 20%). |
| `reservedForOpenPositions` | Hard rule: collateral backing open written positions is **never** deployed. |

Deployable amount is computed as:

```
deployable = min(idleCollateral * targetUtilizationBps / 10_000,
                 totalCollateral - totalCollateral * minLiquidBufferBps / 10_000)
```

where `idleCollateral = totalCollateral - reservedForOpenPositions`. If
`deployable <= 0` nothing is swept.

### Epoch Lifecycle Hooks

- **Sweep** after option-sale execution: deposit `deployable` into the lending
  market.
- **Unwind** before settlement/assignment processing and before any epoch close
  that requires collateral: withdraw the full lent principal plus accrued
  interest.
- All external calls go through the existing reentrancy guard and
  failure-containment patterns.

### Adapter & Degraded Path

The lending integration sits behind a narrow adapter trait/interface
(`deposit`, `withdraw`, `isPaused`). If the market is paused, reverts, or
returns less than requested, the adapter degrades to **no external yield** and
the epoch still completes — a failing venue never blocks epoch transitions.
After every call the vault reconciles against on-chain balances so it never
believes it holds more liquid collateral than it does.

### Epoch Ledger Attribution

Lent principal and accrued interest are tracked **separately** from strategy
P&L in the epoch ledger, so yield attribution stays auditable and feeds the
historical epoch ledger and performance analytics surfaces (surfaced via the
collateral-yield breakdown in `src/lib/api/vaults.ts`).

### Operator Guidance

- Start conservative: `targetUtilizationBps` ≤ `8000` and
  `minLiquidBufferBps` ≥ `2000` until the venue's withdrawal latency is
  characterized.
- Never set `minLiquidBufferBps` below the largest single-epoch settlement
  obligation.
- Monitor the degraded-path counter; sustained degradation means the venue is
  paused or withdrawal-locked and utilization should be lowered.

### Out of Scope

Lending-protocol selection/build (an existing Soroban lending market is
assumed), leveraged or recursive lending, and lending of option-premium
proceeds.
