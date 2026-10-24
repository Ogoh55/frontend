# Vault Operator Guide

This guide describes the operational procedures for running the Phase 2 vault stack: opening and closing epochs, rolling strategies, changing parameters, and triggering an emergency pause. Each procedure lists its preconditions and the observable effects you should expect.

> **Status:** The vault contracts are not yet deployed to mainnet. Vaults are flag-gated behind `VAULTS_ENABLED`; see [Architecture](./architecture.md) for the current rollout state. Do not run these procedures against production until the flag is enabled for your environment.

For the contract interface itself (entry points, arguments, error codes, events), see the [Contract Reference](./contract-reference.md). For integration details, see the [Integrator Guide](./integrator-guide.md).

## Roles and authorization

| Role | Capability |
| --- | --- |
| `admin` | Change parameters, roll strategy, upgrade the contract, unpause |
| `operator` | Open and close epochs |
| `guardian` | Trigger emergency pause |

All privileged calls require the caller to authorize the invocation (Soroban `require_auth`). Confirm your key is registered for the role before attempting a procedure.

## Preconditions (all procedures)

- The vault contract is deployed and `VAULTS_ENABLED` is set for the target environment.
- You hold the key for the required role and it is funded for transaction fees.
- You have the current contract ID and the latest parameter snapshot (see [Contract Reference](./contract-reference.md#storage-entries)).
- The indexer/backend is healthy so state changes are observable (see the [backend repository](https://github.com/Zenith-options/backend)).

## Open an epoch

**Precondition:** no epoch is currently open; the vault is not paused.

1. Confirm the current epoch state via the read-only API (`GET /vaults/:id/epochs/current`) or the SDK `getCurrentEpoch`.
2. Submit `open_epoch` with the operator key.
3. **Expected effects:** a new epoch is created in `Open` state, an `epoch_opened` event is emitted, and the indexer records the new epoch. Deposits are accepted for the open epoch.

## Close an epoch

**Precondition:** an epoch is open and the settlement inputs are available.

1. Verify the open epoch ID and that all deposits for the epoch have been indexed.
2. Submit `close_epoch` with the operator key.
3. **Expected effects:** the epoch transitions to `Closed`, an `epoch_closed` event is emitted, and settlement is queued. Withdrawals for the settled epoch become claimable once settlement completes.

If `close_epoch` returns an error, consult the error codes in the [Contract Reference](./contract-reference.md#error-codes) before retrying; do not resubmit blindly.

## Roll a strategy

**Precondition:** you hold the `admin` role; no epoch is mid-settlement.

1. Confirm the target strategy plugin is registered and its interface matches the current contract spec.
2. Submit `set_strategy` with the new strategy identifier.
3. **Expected effects:** a `strategy_changed` event is emitted and subsequent epochs route through the new strategy. Existing settled epochs are unaffected.

## Change parameters

**Precondition:** you hold the `admin` role.

1. Review the parameter you intend to change and its bounds in the [Contract Reference](./contract-reference.md#storage-entries).
2. Submit `set_params` with only the fields you are changing.
3. **Expected effects:** a `params_changed` event is emitted and the new values are readable from storage. Out-of-bounds values are rejected with the corresponding error code.

## Trigger emergency pause

**Precondition:** you hold the `guardian` (or `admin`) role.

1. Submit `pause` immediately if you observe anomalous behavior.
2. **Expected effects:** a `paused` event is emitted; `open_epoch`, `close_epoch`, and deposits are rejected while paused. Withdrawals of already-settled epochs remain available unless the pause policy states otherwise.
3. To resume, an `admin` submits `unpause`; a `resumed` event is emitted.

## Related documentation

- [Architecture overview](./architecture.md)
- [Contract reference](./contract-reference.md)
- [Integrator guide](./integrator-guide.md)
- [Security invariants](../security/invariants.md)
- [Releasing](../../RELEASING.md)
