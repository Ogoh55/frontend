//! Phase 2 option-writing vault contract.
//!
//! Scaffold only: storage layout, roles, pause and upgrade surface, and the
//! event schema. Deposits, withdrawals, NAV math and epoch automation are
//! deliberately absent and land in later issues.
//!
//! Not to be confused with the single-vault margin-collateral contract
//! addressed by `NEXT_PUBLIC_VAULT_CONTRACT_ID`.

#![no_std]

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};
use zenith_options_vault_common::{
    bump, is_initialized, is_paused, load_epoch, load_fees, load_info, load_nav, load_roles,
    require_admin, require_initialized, require_not_paused, require_operator,
    require_pauser_or_admin, set_paused, store_epoch, store_initial_state, store_roles,
    validate_fees, FeeConfig, Nav, Roles, VaultError, VaultEvent, VaultInfo,
};

#[contract]
pub struct ZenithOptionsVault;

#[contractimpl]
impl ZenithOptionsVault {
    /// One-time setup. Requires the admin's signature so that a third party
    /// cannot front-run deployment and install their own roles.
    pub fn initialize(
        env: Env,
        roles: Roles,
        info: VaultInfo,
        fees: FeeConfig,
    ) -> Result<(), VaultError> {
        if is_initialized(&env) {
            return Err(VaultError::AlreadyInitialized);
        }
        roles.admin.require_auth();
        validate_fees(&fees)?;

        store_initial_state(&env, &info, &roles, &fees);
        VaultEvent::Initialize { admin: roles.admin, info }.emit(&env);
        Ok(())
    }

    /// Halts value-moving paths. Callable by the emergency pauser or admin.
    pub fn pause(env: Env, caller: Address) -> Result<(), VaultError> {
        require_initialized(&env)?;
        require_pauser_or_admin(&env, &caller)?;
        if is_paused(&env) {
            return Err(VaultError::Paused);
        }

        set_paused(&env, true);
        bump(&env);
        VaultEvent::Pause { by: caller }.emit(&env);
        Ok(())
    }

    /// Resumes value-moving paths. Admin only, so the pauser alone cannot
    /// re-enable a vault it has halted.
    pub fn unpause(env: Env, caller: Address) -> Result<(), VaultError> {
        require_initialized(&env)?;
        require_admin(&env, &caller)?;
        if !is_paused(&env) {
            return Err(VaultError::NotPaused);
        }

        set_paused(&env, false);
        bump(&env);
        VaultEvent::Unpause { by: caller }.emit(&env);
        Ok(())
    }

    /// Hands the admin role to `new_admin`. The incoming admin must also
    /// authorize, which guards against transferring to an address nobody
    /// controls.
    pub fn admin_transfer(env: Env, caller: Address, new_admin: Address) -> Result<(), VaultError> {
        require_initialized(&env)?;
        let mut roles = require_admin(&env, &caller)?;
        new_admin.require_auth();

        let old_admin = roles.admin.clone();
        roles.admin = new_admin.clone();
        store_roles(&env, &roles);
        bump(&env);
        VaultEvent::AdminTransfer { old_admin, new_admin }.emit(&env);
        Ok(())
    }

    /// Replaces the contract WASM. Admin only; the operator cannot upgrade.
    pub fn upgrade(env: Env, caller: Address, wasm_hash: BytesN<32>) -> Result<(), VaultError> {
        require_initialized(&env)?;
        require_admin(&env, &caller)?;

        bump(&env);
        VaultEvent::Upgrade { by: caller, wasm_hash: wasm_hash.clone() }.emit(&env);
        env.deployer().update_current_contract_wasm(wasm_hash);
        Ok(())
    }

    /// Advances the epoch counter. Operator only, and blocked while paused.
    /// The counter is the only state touched here; rollover logic is out of
    /// scope for this scaffold.
    pub fn advance_epoch(env: Env, caller: Address) -> Result<u32, VaultError> {
        require_initialized(&env)?;
        require_operator(&env, &caller)?;
        require_not_paused(&env)?;

        let next = load_epoch(&env)?.checked_add(1).expect("epoch overflow");
        store_epoch(&env, next);
        bump(&env);
        Ok(next)
    }

    // -----------------------------------------------------------------------
    // Read-only views
    // -----------------------------------------------------------------------

    pub fn get_info(env: Env) -> Result<VaultInfo, VaultError> {
        load_info(&env)
    }

    pub fn get_roles(env: Env) -> Result<Roles, VaultError> {
        load_roles(&env)
    }

    pub fn get_fees(env: Env) -> Result<FeeConfig, VaultError> {
        load_fees(&env)
    }

    pub fn get_epoch(env: Env) -> Result<u32, VaultError> {
        load_epoch(&env)
    }

    pub fn get_nav(env: Env) -> Result<Nav, VaultError> {
        load_nav(&env)
    }

    pub fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }
}
