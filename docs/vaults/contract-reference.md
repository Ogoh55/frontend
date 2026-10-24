# Vault Contract Reference

> **Status:** Phase 2 reference. This document is the authoritative interface
> description for the Soroban vault contract suite. It is generated from the
> checked-in contract spec where possible; narrative sections are hand-written.
> If this document and the exported contract spec disagree, the spec wins and
> this document is a bug — open a PR.
>
> Related docs: [Architecture overview](./architecture.md) ·
> [Operator guide](./operator-guide.md) · [Integrator guide](./integrator-guide.md)

## Scope and status

This reference covers the vault contracts that are **shipped** in Phase 2.
Features that are flag-gated or not yet deployed are called out explicitly in
[Not yet shipped](#not-yet-shipped) so integrators are not misled.

## Contracts

| Contract | Purpose |
| --- | --- |
| `vault` | Core vault: deposits, withdrawals, share accounting, epoch lifecycle. |
| `strategy` | Strategy plugin interface implemented by each strategy contract. |
| `registry` | Strategy registry and parameter storage. |

## Entry points

All entry points are Soroban contract functions. Argument and return types use
the Soroban SDK `Val`/`Udt` conventions; amounts are `i128` in the asset's
smallest unit unless stated otherwise.

### `vault`

| Function | Arguments | Returns | Auth |
| --- | --- | --- | --- |
| `initialize` | `admin: Address`, `asset: Address`, `registry: Address` | `()` | `admin` |
| `deposit` | `from: Address`, `amount: i128` | `shares: i128` | `from` |
| `request_withdraw` | `from: Address`, `shares: i128` | `()` | `from` |
| `claim_withdraw` | `from: Address` | `amount: i128` | `from` |
| `open_epoch` | `operator: Address` | `epoch_id: u32` | `operator` |
| `close_epoch` | `operator: Address`, `epoch_id: u32` | `()` | `operator` |
| `set_paused` | `admin: Address`, `paused: bool` | `()` | `admin` |
| `upgrade` | `admin: Address`, `new_wasm_hash: BytesN<32>` | `()` | `admin` |

### `strategy` (plugin interface)

| Function | Arguments | Returns | Auth |
| --- | --- | --- | --- |
| `total_assets` | — | `i128` | none (read-only) |
| `deposit` | `amount: i128` | `()` | `vault` |
| `withdraw` | `amount: i128` | `i128` | `vault` |
| `harvest` | — | `i128` | `vault` |

### `registry`

| Function | Arguments | Returns | Auth |
| --- | --- | --- | --- |
| `set_strategy` | `admin: Address`, `strategy: Address` | `()` | `admin` |
| `get_strategy` | — | `Address` | none (read-only) |
| `set_param` | `admin: Address`, `key: Symbol`, `value: i128` | `()` | `admin` |
| `get_param` | `key: Symbol` | `i128` | none (read-only) |

## Error codes

Errors are returned as `Result::Err(ContractError)` with the following codes.

| Code | Name | Meaning |
| --- | --- | --- |
| 1 | `NotInitialized` | Contract has not been initialized. |
| 2 | `AlreadyInitialized` | `initialize` called more than once. |
| 3 | `Unauthorized` | Caller failed the required authorization check. |
| 4 | `Paused` | Operation blocked because the vault is paused. |
| 5 | `InvalidAmount` | Amount is zero or negative where not allowed. |
| 6 | `InsufficientShares` | Withdraw request exceeds caller's share balance. |
| 7 | `EpochNotOpen` | Epoch operation requires an open epoch. |
| 8 | `EpochAlreadyOpen` | `open_epoch` called while an epoch is open. |
| 9 | `EpochMismatch` | `epoch_id` does not match the current epoch. |
| 10 | `StrategyError` | Underlying strategy call failed. |

## Events

Events are emitted with topics `(Symbol, ...)` and a data payload. Integrators
should decode by topic; see the [integrator guide](./integrator-guide.md#event-decoding).

| Event | Topics | Data |
| --- | --- | --- |
| `deposit` | `("deposit", from)` | `(shares: i128, amount: i128)` |
| `withdraw_requested` | `("withdraw_requested", from)` | `(shares: i128)` |
| `withdraw_claimed` | `("withdraw_claimed", from)` | `(amount: i128)` |
| `epoch_opened` | `("epoch_opened",)` | `(epoch_id: u32)` |
| `epoch_closed` | `("epoch_closed",)` | `(epoch_id: u32, total_assets: i128)` |
| `paused` | `("paused",)` | `(paused: bool)` |
| `upgraded` | `("upgraded",)` | `(new_wasm_hash: BytesN<32>)` |

## Storage entries

Storage keys are defined in the contract's `DataKey` enum. Persistent entries
survive across ledger entries; instance entries are tied to the contract instance.

| Key | Durability | Type | Description |
| --- | --- | --- | --- |
| `Admin` | instance | `Address` | Vault admin. |
| `Asset` | instance | `Address` | Underlying asset contract. |
| `Registry` | instance | `Address` | Strategy registry contract. |
| `Paused` | instance | `bool` | Emergency pause flag. |
| `EpochId` | instance | `u32` | Current epoch id. |
| `EpochOpen` | instance | `bool` | Whether an epoch is currently open. |
| `TotalShares` | instance | `i128` | Total outstanding shares. |
| `TotalAssets` | instance | `i128` | Total assets under management. |
| `Shares(Address)` | persistent | `i128` | Per-holder share balance. |
| `PendingWithdraw(Address)` | persistent | `i128` | Shares queued for withdrawal. |

## Authorization

- **Admin-only:** `initialize`, `set_paused`, `upgrade`, and all `registry`
  mutators. The admin `Address` must authorize the invocation.
- **Operator:** `open_epoch` and `close_epoch` require the operator `Address` to
  authorize. The operator is configured out-of-band by the admin.
- **User:** `deposit`, `request_withdraw`, and `claim_withdraw` require the
  calling `from` address to authorize.
- **Strategy:** `deposit`, `withdraw`, and `harvest` on a strategy require the
  vault contract address to authorize; strategies must reject any other caller.

## Upgrade mechanism

The vault is upgradeable via `upgrade(admin, new_wasm_hash)`. The admin must
authorize the call. On success the contract emits an `upgraded` event and the
new WASM takes effect for subsequent invocations. Storage layout is preserved
across upgrades; any migration must be performed by the new WASM on first call.
See the [operator guide](./operator-guide.md#upgrades) for the runbook.

## Not yet shipped

- **Flag-gated vaults:** multiple concurrent vaults behind a feature flag are
  not deployed. Only the single Phase 2 vault is live.
- **Cross-vault rebalancing:** not implemented.
- **On-chain parameter governance:** parameters are set by the admin via
  `registry.set_param`; there is no on-chain voting yet.

Integrators should treat anything in this section as unavailable and not build
against it.
