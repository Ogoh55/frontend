# Vault Upgrade & Storage Migration Runbook (Issue #205)

This runbook covers the governed upgrade path for the Phase 2 vault contract:
WASM replacement plus versioned storage migration. The goal is that a bug fix
or strategy parameter change never requires redeploying the vault or moving
depositor capital by hand.

The contract source lives in the
[contracts repo](https://github.com/Zenith-options/contracts/tree/main/vault).
The vault indexer and the backend vault registry live in the
[backend repo](https://github.com/Zenith-options/backend). This document is the
operator-facing spec those components implement against.

---

## Principles

1. **Upgrades are authorized.** Only the admin authority can replace WASM or run
   a migration. The admin is a Soroban account or multisig/timelock address, never
   a single hot key.
2. **Upgrades are observable.** Every upgrade and migration step emits an event
   that the indexer records for the operator console timeline.
3. **Upgrades are non-destructive to share accounting.** Total shares, total
   assets and NAV-per-share must be bit-identical before and after a migration
   for the same ledger state.

---

## Storage schema versioning

Every vault instance stores a `DataKey::SchemaVersion` entry, written on `init`.

| Key | Written by | Read by | Notes |
| --- | --- | --- | --- |
| `DataKey::SchemaVersion` | `init`, each migration step | every entry point | Holds the current `u32` schema version. |

- Every entry point reads `SchemaVersion` first. If it is behind the version the
  WASM expects, the call fails and the operator must run the migration.
- The `SchemaVersion` entry's TTL is extended together with the other persistent
  vault state, so it cannot expire while depositor data is still live.

### Admin authority

- The admin address is stored at `init`.
- The admin can only be changed by a **two-step transfer**: the current admin
  proposes a new admin, and the proposed admin accepts. There is no single-call
  rotation.

---

## Upgrade

The upgrade entry point calls `update_current_contract_wasm` and is gated by the
admin check.

### Preconditions

The upgrade is rejected unless **all** of the following hold:

- The vault is not mid-epoch.
- The vault is not paused or in emergency mode.

The only override is an explicit `force` argument. Using `force` must be
recorded in the emitted event, and it should only be used during an incident
response that has been signed off by the governance multisig.

### Rollback

- The previous WASM hash is retained in storage before every upgrade.
- Rolling back is an upgrade to the retained hash, under the same
  `SchemaVersion` scheme and the same preconditions.
- A rollback must not run a downgrade migration. Migrations are forward-only.

### Backend registry

After each upgrade, the operator records the **contract ID + WASM hash** pairing
in the backend vault registry. The registry is the source of truth for which
WASM is live for each vault, and it must match the on-chain value before the
upgrade is considered complete.

---

## Migration

Migrations are per-version functions. Each one transforms the persistent layout
from version `N` to `N + 1`.

### Rules

- **Admin only.** The migration entry point checks the admin authority.
- **Idempotent.** Re-running a completed step is a no-op.
- **Resumable.** Each call processes one key range and returns a resume cursor.
  A partially completed migration is finished by calling again with that cursor.
- **Chunked.** Each call reads and writes no more entries than fit in one
  ledger's resource budget. Do not migrate a whole vault in one transaction.
- **Version bump last.** `SchemaVersion` is updated only after the final chunk
  of a version's migration succeeds.

### Invariant check

After the final chunk, the migration asserts that the following values are
bit-identical to the pre-migration snapshot taken at the same ledger:

- total shares
- total assets
- NAV-per-share

If any value differs, the migration reverts. The version is not bumped.

---

## Events

The indexer consumes these events for the operator console timeline.

| Event | When | Payload |
| --- | --- | --- |
| `upgrade_proposed` | Upgrade call accepted, before WASM swap | new WASM hash, previous WASM hash, `force` flag, caller |
| `upgraded` | WASM swap complete | new WASM hash, previous WASM hash, ledger |
| `migration_step` | Each chunk completes | from version, to version, resume cursor, entries processed |
| `migration_complete` | Final chunk and invariant check pass | new schema version, total shares, total assets, NAV-per-share |
| `admin_transfer_proposed` | Current admin proposes a new admin | current admin, proposed admin |
| `admin_transfer_accepted` | Proposed admin accepts | old admin, new admin |

---

## Operator procedure

1. **Snapshot.** Record total shares, total assets and NAV-per-share at the
   current ledger.
2. **Check preconditions.** Confirm the vault is not mid-epoch and not paused.
   If it is, wait or use `force` under the incident process above.
3. **Upgrade.** Submit the upgrade from the admin multisig/timelock. Confirm the
   `upgraded` event.
4. **Migrate.** Call the migration entry point until `migration_complete` is
   emitted. Keep the resume cursor from each `migration_step` event.
5. **Verify.** Compare the post-migration NAV values to the snapshot from step 1.
6. **Record.** Update the backend vault registry with the contract ID and new
   WASM hash.
7. **Smoke test.** Confirm a deposit and a withdraw still succeed on the upgraded
   vault. Test on testnet before mainnet.

### Rollback procedure

1. Confirm the failure and whether it is in WASM or in migrated data.
2. If the WASM is at fault, upgrade back to the retained previous WASM hash.
3. If the data is at fault and the invariant check failed, the migration has
   already reverted. Do not force a partial migration.
4. Record the rollback in the backend registry.

---

## Testing requirements

- **Unit:** populate a vault, bump the version, and assert the NAV and share
  invariants.
- **Fuzz:** interrupt a migration partway through, then resume from the cursor.
  The final state must match an uninterrupted run.
- **Testnet integration:** upgrade a vault with live parameters, then confirm
  deposit and withdraw still work.
- **Negative:** a non-admin caller cannot upgrade or migrate.

---

## Out of scope

- Governance voting UX. This is covered by the operator console issue.
- The content of individual strategy fixes shipped through an upgrade.
