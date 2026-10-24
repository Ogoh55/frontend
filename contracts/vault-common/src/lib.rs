//! Shared building blocks for the Phase 2 options vault contracts.
//!
//! This crate is deliberately free of economic logic. It defines the
//! storage layout, role model, authorization helpers, error codes and the
//! event schema that every strategy entry-point contract is built on.
//!
//! Naming: this is the *options* vault (Phase 2, share-based strategy
//! vaults). It is unrelated to the single-vault margin-collateral contract
//! addressed by `NEXT_PUBLIC_VAULT_CONTRACT_ID`.

#![no_std]

use soroban_sdk::{contracterror, contracttype, Address, BytesN, Env, Symbol};

/// Instance-storage TTL policy, in ledgers (~5s per ledger).
/// Bump when the remaining TTL falls below ~30 days, extend to ~60 days.
pub const TTL_THRESHOLD: u32 = 17_280 * 30;
pub const TTL_EXTEND_TO: u32 = 17_280 * 60;

/// Basis-point ceiling for fee configuration (100%).
pub const MAX_BPS: u32 = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Option-writing strategy run by a vault. Fixed at initialization.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Strategy {
    CoveredCall,
    CashSecuredPut,
    IronCondor,
    Wheel,
}

/// Registry entry identifying a vault instance.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultInfo {
    pub vault_id: Symbol,
    pub underlying: Symbol,
    pub strategy: Strategy,
}

/// Role assignments. `admin` gates upgrades and role changes; `operator`
/// runs the strategy day to day; `pauser` can halt value-moving paths.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Roles {
    pub admin: Address,
    pub operator: Address,
    pub pauser: Address,
}

/// Fee configuration in basis points (1 bp = 0.01%). Integers only.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FeeConfig {
    pub management_bps: u32,
    pub performance_bps: u32,
}

/// Net asset value and share supply. Integer base units only.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Nav {
    pub total_assets: i128,
    pub total_shares: i128,
}

/// Instance-storage keys. Every piece of contract state lives under exactly
/// one of these variants, so the layout is reviewable in one place. Each
/// vault instance is its own contract address, which keeps state for
/// multiple vaults from colliding on the same contract set.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Initialized,
    Info,
    Roles,
    Fees,
    Epoch,
    Nav,
    Paused,
}

/// Errors returned by vault entry points.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    NotPaused = 5,
    InvalidFee = 6,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Typed event schema. Each event publishes topics `(name, actor)` and a
/// data payload, so indexers can filter by event name and by signer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VaultEvent {
    Initialize { admin: Address, info: VaultInfo },
    Pause { by: Address },
    Unpause { by: Address },
    AdminTransfer { old_admin: Address, new_admin: Address },
    Upgrade { by: Address, wasm_hash: BytesN<32> },
}

impl VaultEvent {
    pub fn emit(self, env: &Env) {
        match self {
            VaultEvent::Initialize { admin, info } => {
                env.events().publish(
                    (Symbol::new(env, "initialize"), admin),
                    info,
                );
            }
            VaultEvent::Pause { by } => {
                env.events().publish((Symbol::new(env, "pause"), by), ());
            }
            VaultEvent::Unpause { by } => {
                env.events().publish((Symbol::new(env, "unpause"), by), ());
            }
            VaultEvent::AdminTransfer { old_admin, new_admin } => {
                env.events().publish(
                    (Symbol::new(env, "admin_transfer"), old_admin),
                    new_admin,
                );
            }
            VaultEvent::Upgrade { by, wasm_hash } => {
                env.events().publish((Symbol::new(env, "upgrade"), by), wasm_hash);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

pub fn bump(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Initialized)
}

pub fn require_initialized(env: &Env) -> Result<(), VaultError> {
    if is_initialized(env) {
        Ok(())
    } else {
        Err(VaultError::NotInitialized)
    }
}

pub fn load_roles(env: &Env) -> Result<Roles, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::Roles)
        .ok_or(VaultError::NotInitialized)
}

pub fn load_info(env: &Env) -> Result<VaultInfo, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::Info)
        .ok_or(VaultError::NotInitialized)
}

pub fn load_fees(env: &Env) -> Result<FeeConfig, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::Fees)
        .ok_or(VaultError::NotInitialized)
}

pub fn load_epoch(env: &Env) -> Result<u32, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::Epoch)
        .ok_or(VaultError::NotInitialized)
}

pub fn load_nav(env: &Env) -> Result<Nav, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::Nav)
        .ok_or(VaultError::NotInitialized)
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn store_roles(env: &Env, roles: &Roles) {
    env.storage().instance().set(&DataKey::Roles, roles);
}

pub fn store_epoch(env: &Env, epoch: u32) {
    env.storage().instance().set(&DataKey::Epoch, &epoch);
}

/// Guard for every value-moving entry point. Strategy and epoch operations
/// must call this before touching state.
pub fn require_not_paused(env: &Env) -> Result<(), VaultError> {
    if is_paused(env) {
        Err(VaultError::Paused)
    } else {
        Ok(())
    }
}

pub fn validate_fees(fees: &FeeConfig) -> Result<(), VaultError> {
    if fees.management_bps > MAX_BPS || fees.performance_bps > MAX_BPS {
        Err(VaultError::InvalidFee)
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Authorization helpers
//
// Each helper requires the caller's signature first, then checks the role.
// A missing signature aborts the invocation; a wrong signer gets
// `VaultError::Unauthorized`.
// ---------------------------------------------------------------------------

/// Admin-only. The admin is intentionally separate from the operator so
/// that upgrades and role changes sit one step removed from day-to-day
/// strategy operations.
pub fn require_admin(env: &Env, caller: &Address) -> Result<Roles, VaultError> {
    caller.require_auth();
    let roles = load_roles(env)?;
    if *caller != roles.admin {
        return Err(VaultError::Unauthorized);
    }
    Ok(roles)
}

/// Strategy/keeper operator only.
pub fn require_operator(env: &Env, caller: &Address) -> Result<Roles, VaultError> {
    caller.require_auth();
    let roles = load_roles(env)?;
    if *caller != roles.operator {
        return Err(VaultError::Unauthorized);
    }
    Ok(roles)
}

/// Emergency pauser or admin.
pub fn require_pauser_or_admin(env: &Env, caller: &Address) -> Result<Roles, VaultError> {
    caller.require_auth();
    let roles = load_roles(env)?;
    if *caller != roles.pauser && *caller != roles.admin {
        return Err(VaultError::Unauthorized);
    }
    Ok(roles)
}

/// Stores the full initial state. Called once from `initialize`.
pub fn store_initial_state(
    env: &Env,
    info: &VaultInfo,
    roles: &Roles,
    fees: &FeeConfig,
) {
    let storage = env.storage().instance();
    storage.set(&DataKey::Initialized, &true);
    storage.set(&DataKey::Info, info);
    storage.set(&DataKey::Roles, roles);
    storage.set(&DataKey::Fees, fees);
    storage.set(&DataKey::Epoch, &0u32);
    storage.set(&DataKey::Nav, &Nav { total_assets: 0, total_shares: 0 });
    storage.set(&DataKey::Paused, &false);
    bump(env);
}
