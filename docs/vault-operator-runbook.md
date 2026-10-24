# Vault Operator Runbook

Internal console: `/vaults/operator`. Use it when automation needs a human to
intervene or inspect. The automated epoch lifecycle runs by default.

## Access

- Sign in with an operator wallet (WalletConnect in the header). Sessions go
  through the BFF; the bearer token stays in the httpOnly cookie.
- Operator authorization is enforced by the backend. A non-operator gets 403
  and nothing changes. The console does not decide who is an operator.

## Dashboard

| Field | Meaning |
| --- | --- |
| Epoch / epoch state | Current epoch number and phase (`deposit`, `active`, `settlement`). |
| Last rollover | When the epoch last rolled over (UTC). |
| Pending redemptions | Unfulfilled redemption tickets. |
| Capacity utilisation | TVL ÷ capacity. |
| Pause status | `PAUSED` or `Active`. |
| State age | Seconds since the indexer last caught up. |

If state age exceeds 60 seconds, the indexer is lagging. Every action is
disabled and the console shows a banner. Click **Refresh**, and wait for the
indexer before acting. Do not act on stale state.

## Actions

Every action opens a confirmation panel. Type the vault id exactly to enable
the action button. Buttons are disabled while a request is in flight, so a double
click sends one request.

- **Trigger rollover / Retry rollover.** The request carries the epoch you saw.
  If the vault has moved on, the backend returns 409 and nothing changes.
  Reload the status, then decide again.
- **Pause vault.** Stops deposits and withdrawals. Use for an incident.
- **Resume vault.** Reopens deposits and withdrawals. Only after the incident
  is understood.
- **Resolve stuck-queue alert.** Acknowledges the alert after the unfulfilled
  tickets are handled.

## Parameter changes

Parameter changes never write to the vault directly.

1. Choose the parameter and the new value. **Review diff** shows `-` current
   and `+` proposed.
2. Confirm by typing the vault id. The console submits a governance proposal
   and returns its id.
3. The vault changes only after the proposal passes the approval path.

## Audit log

The log shows every operator action for the selected vault: time, actor, vault,
action, before, and after. The newest entry is first. Entries are written by the
backend, not the console.

## Incident checklist

1. Check state age. If the indexer is stale, refresh and wait.
2. If deposits or withdrawals are unsafe, pause the vault and note why.
3. Check open stuck-queue alerts and the pending redemption count.
4. Retry the rollover only if the epoch is still the one you saw.
5. Confirm the audit log shows your action with the right before and after.
6. Resume the vault once the cause is cleared.

## Known limits

- The live operator endpoints live in the vault backend and are not in this
  repository. Until `NEXT_PUBLIC_VAULTS=live` is set, the console runs on mock
  data and shows no real vault state.
- The console does not change on-chain governance or timelock settings.
