# Zenith Soroban contracts

## Vault contract set (Phase 2 options vaults)

Two vault concepts exist in this project. Do not conflate them in code or docs.

| Concept | Where it lives | Referenced from |
| --- | --- | --- |
| **Margin-collateral vault** (existing, single-vault) | Deployed contract addressed by `NEXT_PUBLIC_VAULT_CONTRACT_ID` | `src/lib/api/vault.ts` |
| **Options vault** (Phase 2, this directory) | `contracts/vault` (`zenith-options-vault`) | `src/lib/api/vaults.ts` (mock adapter, not yet wired) |

### Crates

| Crate | Path | Purpose |
| --- | --- | --- |
| `zenith-options-vault-common` | `vault-common/` | Shared storage keys, roles, auth helpers, errors, event schema. No economic logic. |
| `zenith-options-vault` | `vault/` | Contract entry points. One contract instance per vault. |

### Design

- **Strategy.** `Strategy` is one of `CoveredCall`, `CashSecuredPut`, `IronCondor`, `Wheel`. It is set at `initialize` and stored under `DataKey::Info`.
- **Storage.** All state lives under the `DataKey` enum in `vault-common`: `Initialized`, `Info`, `Roles`, `Fees`, `Epoch`, `Nav`, `Paused`. Each vault instance is a separate contract address, so state for several vaults never shares a key space.
- **Roles.**
  - `admin` gates `admin_transfer`, `unpause`, and `upgrade`. It also must sign `initialize`.
  - `operator` gates `advance_epoch`.
  - `pauser` (or `admin`) gates `pause`.
  - Every mutating entry point calls `require_auth` on the caller, then checks the role. A wrong signer returns `Unauthorized`.
- **Pause.** `advance_epoch` is blocked while paused. Future value-moving entry points must call `require_not_paused`.
- **Upgrade.** Admin only and separate from the operator role. Emits `upgrade` before the WASM is swapped.
- **Numerics.** Integer base units only. Fees are in basis points. No floating-point types in storage.
- **Events.** Each event publishes topics `(name, actor)` and a data payload:

  | Event | Topics | Data |
  | --- | --- | --- |
  | `initialize` | `admin` | `VaultInfo` |
  | `pause` | `by` | `()` |
  | `unpause` | `by` | `()` |
  | `admin_transfer` | `old_admin` | `new_admin` |
  | `upgrade` | `by` | `wasm_hash` |

### Out of scope for this scaffold

Deposits and withdrawals, NAV math, epoch rollover automation, the backend API, and frontend wiring.

### Build

```sh
cd contracts
cargo build --release --target wasm32-unknown-unknown -p zenith-options-vault
```
