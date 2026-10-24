# Order Ticket Backend

This document describes the backend contract surface consumed by the operator
console and the event indexer. It is the source of truth for the API shapes the
frontend relies on.

## Vaults

- `GET /vaults` — list vaults with current parameters.
- `GET /vaults/:id` — vault detail.

## Governance: Timelock & Multisig Proposals (#224)

Privileged vault changes (fee bps, fee recipient, capacity limits, strategy
weights/parameters, oracle configuration, and upgrade authorization) are no
longer operator actions. They must flow through an on-chain governance
workflow:

`propose` → approvals by the configured signer set → `queue` → mandatory delay
→ `execute`, plus `cancel` and expiry for stale proposals.

### Lifecycle

| Stage     | Description                                                                 |
|-----------|-----------------------------------------------------------------------------|
| proposed  | Proposal created with an explicit typed action payload.                     |
| approved  | Signers approve; approval count tracked against the multisig threshold.     |
| queued    | Once threshold is met, the proposal is queued and an ETA is set.            |
| executed  | After the mandatory delay elapses and before expiry, the action applies.    |
| cancelled | A signer cancels a pending/queued proposal before execution.                |
| expired   | A proposal not executed before its expiry is stale and cannot be executed.  |

Approvals may be revoked before execution. The multisig threshold and delay are
stored in contract storage and may only be changed through the same governance
workflow (they cannot be lowered without a timelock).

### Events

Every stage emits an event consumable by the indexer:

- `ProposalCreated`
- `ProposalApproved`
- `ProposalQueued`
- `ProposalExecuted`
- `ProposalCancelled`
- `ProposalExpired`

### Read-only proposal listings

The operator console displays proposals read-only. The backend exposes:

- `GET /vaults/:id/proposals?status=pending|executed` — list proposals.

Each proposal payload:

```json
{
  "id": "string",
  "vaultId": "string",
  "action": "setFeeBps | setFeeRecipient | setCapacityLimit | setStrategyWeights | setOracleConfig | authorizeUpgrade | setThreshold | setDelay",
  "params": {},
  "status": "proposed | approved | queued | executed | cancelled | expired",
  "approvals": 0,
  "threshold": 0,
  "eta": "ISO-8601 timestamp or null",
  "expiresAt": "ISO-8601 timestamp",
  "createdAt": "ISO-8601 timestamp"
}
```

`approvals` is the current approval count and `eta` is the earliest execution
time once queued. The console must not offer direct parameter editing; all
changes are submitted as proposals.
