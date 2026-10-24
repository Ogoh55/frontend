# Vaults feature-flag rollout

The `vaults` flag (`src/lib/flags/registry.ts`) ships off (`defaultValue: false`).
This document is the rollout plan and rollback runbook. The default and stage are
recorded in `src/lib/flags/rollout.json`, which `scripts/check-flag-rollout.mjs`
checks in CI, so changing the default requires changing that file in the same PR.

Contract state cannot be rolled back. Everything below is about the frontend
gate and the operator actions around it.

## How the gate works

- `resolveFlag` order: query override (dev only) > `NEXT_PUBLIC_FLAG_VAULTS` env
  var > remote config (`FLAGS_CONFIG_URL`, refreshed every 60 s) > registry default.
- The layout resolves flags on the server and passes them to `FlagsProvider`, so
  SSR and hydration agree.
- Every vault adapter call takes `{ enabled }` from `useFlag("vaults")`
  (`src/lib/api/vaults.ts`). One check covers list, detail, and deposit.

### Kill-switch caveat

`NEXT_PUBLIC_FLAG_VAULTS` outranks remote config and is baked in at build time.
If it is set in an environment, the remote kill switch does nothing there. Keep it
unset in staging and production, and use it only for local development.

## Stages and entry/exit gates

| Stage | Who sees vaults | Entry gate | Exit gate |
|---|---|---|---|
| `internal` (current) | Allowlisted wallets only (`allowlists.vaults` in remote config) | Contracts deployed on the target network; backend implements the same gates | ≥ 2 full epochs with no failed settlements; NAV drift within the threshold the vault owner signs off on; deposit and redemption queues drain within one epoch |
| `canary` | Invited depositors, TVL capped at a per-vault `capacity` enforced by the vault contract and backend | Internal exit met; capacity cap verified on-chain (a UI-only cap is not enough); runbook rehearsed on staging | ≥ 4 epochs with settlement success rate ≥ 99%; epoch-transition health green; no queue backlog older than one epoch; no unresolved NAV-drift incidents |
| `ga` | Everyone | Canary exit met; `rollout.json` stage set to `ga` and `vaults` default changed in the same PR | Stage is final; rollback is the kill switch below |

The signals to watch at each gate are epoch-transition health, NAV drift (share
price vs. the backend's reference), deposit and redemption queue depth, and
settlement success rate. Dashboards are out of scope for this repo.

### Moving a stage

1. Change the allowlist or remote config first. Do not change the registry default
   until `ga`.
2. For `ga`, change `defaultValue` in `registry.ts` and `stage` in `rollout.json`
   in the same PR. The CI guard fails if only one of them changes.
3. Record the gate evidence in the PR description.

## Kill switch

Flipping `vaults` to `false` in remote config (or removing the allowlist entry
for a wallet) is the kill switch. It does not require a deploy.

**Off stops:**
- New deposits (`depositToVault` throws; the deposit tab is hidden).
- New epoch starts (backend and contract; the frontend has no epoch-start action).
- Listing of vaults the user has no position in, and the detail page for them.

**Off keeps live:**
- Existing vaults and their history for any wallet that holds a position.
- Withdrawals and queued redemptions (`withdrawFromVault` is never gated, and the
  withdraw tab stays visible on a held position).
- Epochs already in progress, which settle on the contract's schedule.

A user who is mid-deposit when the flag flips keeps the transaction they already
submitted. The adapter checks the flag when the call is made, so a request sent
before the flip completes.

## Rollback runbook

Contract state cannot be rolled back. Rolling back the flag does not return any
deposited collateral. It only stops new inflows and new epochs.

1. **Confirm the trigger** against the gate signals. Record the time.
2. **Flip the kill switch.** Set `vaults` to `false` in the remote config at
   `FLAGS_CONFIG_URL` (or remove the wallet from the allowlist). Confirm
   `NEXT_PUBLIC_FLAG_VAULTS` is unset in the target environment.
3. **Confirm the UI.** Within about 60 s (the remote config refresh interval), the
   `/vaults` list shows "Vaults are not yet available" for a wallet with no
   position. A wallet with a position still sees its vault, history, and withdraw
   tab.
4. **Confirm the backend.** The backend must reject new deposits and new epoch starts
   while accepting withdrawals and processing queued redemptions. This is a
   backend change; the frontend cannot verify it.
5. **Keep the queue moving.** Confirm queued redemptions still settle at the next
   epoch boundary. If they do not, page the vaults owner. Do not disable withdrawals.
6. **Post-incident.** Record the trigger, the time the flag flipped, and the time the
   UI reflected it.

### What stays live vs. what is disabled

| Stays live | Disabled by the kill switch |
|---|---|
| Existing vaults with a user position | New deposits (UI and adapter) |
| Vault history and epoch records for those vaults | Deposit tab on `/vaults/[id]` |
| Withdraw tab and queued redemptions | Listing of vaults with no user position |
| Epochs already in progress (settle on schedule) | New epoch starts (backend and contract) |
| Settlement and redemption processing (backend) | Vault entry points for users without a position |

A flag flip must never make an existing position disappear. If a change would do
that, it is a bug.

## Testing the gate

- The adapter takes `{ enabled }` at its boundary. With it false, `fetchVaults`
  returns only positions the user holds, `fetchVaultDetail` returns `null` for
  non-held vaults, and `depositToVault` rejects. `withdrawFromVault` is unchanged.
- The pages show "Vaults are not yet available" when the flag is off and the vault
  is not held. The mock values are not rendered.

## Related

- Release and rollback conventions: [RELEASING.md](../RELEASING.md)
- Contribution conventions: [CONTRIBUTING.md](../CONTRIBUTING.md)
- Backend that must honor the same gates: https://github.com/Zenith-options/backend
