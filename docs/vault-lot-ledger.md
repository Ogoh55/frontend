# Vault Share-Lot Ledger and Export Schema

Each depositor's vault shares are tracked as dated lots, one ledger per
depositor per vault. Realized PnL is computed on every redemption and
transfer-out. The ledger is derived from indexed vault events, never mutated
in the request path, so it can be rebuilt deterministically after an indexer
fix. The shared math lives in `src/lib/api/vaults.ts`
(`relieveLotsFifo`, `buildLotLedger`, `unrealizedPnl`).

This is an accounting record for the depositor's own reconciliation. It is
not tax advice, and it does not produce jurisdiction-specific tax forms.

## Lot-relief method

- Default and only method: **FIFO** (`lot_method = "fifo"`).
- Lots are consumed in `(acquiredLedger, lotId)` order.
- Every ledger row stores the method it was computed with, so a future method
  change applies to new rows only and does not rewrite history.

## Events

| `event_kind`   | Effect on lots                         | `amount_usd` means        |
| -------------- | -------------------------------------- | ------------------------- |
| `deposit`      | Opens a lot at the minting NAV         | Cost paid                 |
| `transfer_in`  | Opens a lot at the carried basis       | Carried cost basis        |
| `redemption`   | Relieves lots FIFO                     | Gross proceeds            |
| `transfer_out` | Relieves lots FIFO, realizes PnL       | Gross fair value          |

Events are ordered by `(ledger, seq)`. Ordering uses the ledger close time
and never the time the API received the event.

## Fees

- **Performance fees reduce proceeds.** Realized PnL uses
  `net proceeds = amount_usd - fees_usd`.
- **Management fees are not repeated per event.** They accrue into NAV, so
  they already reduce `nav_per_share` and the proceeds derived from it.
- Fees must be `>= 0`.

## Rounding and invariants

- Shares at or below `1e-9` (`DUST_SHARES`) are rounding residue. They never
  open a lot, and they are dropped when a lot is partially relieved.
- A redemption larger than the tracked lots throws. The ledger never produces
  a negative cost basis.
- A redemption that spans several lots produces one `consumed` entry per lot
  in the relief result. Ledger rows aggregate the cost basis across them.

## Unrealized PnL

`unrealizedPnl(lots, markNavPerShare)` returns `sum(shares * mark - costUsd)`
over the lots still held. Pass the same `shareValue` the portfolio surface
displays for that account and timestamp, so the two figures match.

## Export

- `GET /api/v1/vaults/{id}/export?format=csv|json`
- Access: the authenticated depositor only. The backend must authorize by
  session account and never accept an account identifier from the client.
- Large histories are streamed server-side. Exports are never generated
  synchronously in the BFF.
- The frontend download control is on the vault position card. It is shown
  only when the account holds a position.

### CSV columns

The header row is the schema. Column names and order are stable within a
`schema_version`.

| Column             | Type   | Description                              |
| ------------------ | ------ | ---------------------------------------- |
| `schema_version`   | int    | Export schema version (currently `1`)    |
| `seq`              | int    | Event sequence within the ledger         |
| `event_kind`       | string | `deposit`, `transfer_in`, `redemption`, `transfer_out` |
| `ledger`           | int    | Ledger sequence of the event             |
| `ledger_at`        | string | Ledger close time (ISO 8601, UTC)        |
| `vault_id`         | string | Vault identifier                         |
| `shares`           | number | Shares acquired or relieved              |
| `amount_usd`       | number | See the events table                     |
| `fees_usd`         | number | Fees that reduce proceeds                |
| `nav_per_share`    | number | NAV per share used for the event         |
| `cost_basis_usd`   | number | Cost basis of the shares involved        |
| `realized_pnl_usd` | number | Realized PnL (`0` for opening events)    |
| `lot_method`       | string | Lot-relief method (currently `fifo`)     |

### JSON shape

```json
{
  "schema_version": 1,
  "vault_id": "xlm-cc-v1",
  "lot_method": "fifo",
  "rows": [
    {
      "seq": 1,
      "kind": "deposit",
      "ledger": 123456,
      "ledgerAt": "2026-09-01T12:00:00Z",
      "vaultId": "xlm-cc-v1",
      "shares": 100,
      "amountUsd": 100,
      "feesUsd": 0,
      "navPerShare": 1,
      "costBasisUsd": 100,
      "realizedPnlUsd": 0,
      "lotMethod": "fifo"
    }
  ]
}
```

Column names in the JSON `rows` are the camelCase form of the CSV columns.
The CSV schema is the stable contract for downstream users.

## Versioning

Any column change bumps `VAULT_EXPORT_SCHEMA_VERSION` and updates this file.
Removing or renaming a column is a breaking change for downstream users.
