# Vault Event Indexer

Implementation: `src/lib/indexer/vaultIndexer.ts`. Materializes authoritative vault state
(shares outstanding, NAV/share, epoch, queued redemptions, accrued premium and fees, pause
state, params) from Soroban vault contract events into the read model behind
`GET /api/v1/vaults` and `GET /api/v1/vaults/{id}` (`src/lib/api/vaults.ts`).

## Pipeline

`getEvents` (paged) → `decodeEvent` → domain event → `IndexerStore.applyEvent`
(event-log insert + projection fold + cursor advance in one transaction).

- Events are keyed `(contract_id, ledger, tx_hash, event_index)`; redelivery is a no-op.
- The cursor is stored per contract; restarts resume from it. With no cursor, sync starts at the
  registry's `deploymentLedger`.
- Unknown topics are skipped (cursor still advances). Malformed payloads for known topics are
  counted in `skippedEvents` and reported via `onError`; they never stall other vaults.
- Event schema changes after contract upgrades: add field aliases in `decodeEvent`.
- `VaultIndexer.status()` backs the health endpoint: last ingested ledger, lag, per-vault error.

## Runbook

**Cursor reset (re-ingest, keep log):** `store.clearCursor(contractId)` then `indexer.syncVault(entry)`.
Duplicates are ignored by the event key, so this is safe.

**Full rebuild of projections (no RPC):** `rebuildProjections(store, contractId)` folds the stored
event log into a fresh projection. Use after fixing a projection bug.

**Full backfill from deployment ledger:** `indexer.backfill(entry)` clears the cursor and re-pages
history. Soroban RPC retains only a limited event window; for older history, restore the event log
from an archive (e.g. Galexie) before rebuilding.

**Stuck vault:** check `status().vaults[id].error`, fix the cause, then `syncVault(entry)`.
