# Vault Surfaces — Disambiguation Reference

Two entirely separate vault surfaces exist in this codebase. They share no
code, no env vars, no routes, and no contract addresses. This document is the
single authoritative reference for telling them apart.

---

## Quick-reference table

| Dimension | Margin-Collateral Vault | Phase 2 Options Vaults |
|-----------|------------------------|------------------------|
| **Purpose** | Holds collateral that backs open option positions | Share-based, epoch-driven vaults that *write* options |
| **Instances** | One per network (global) | Many (registry) |
| **Source file** | `src/lib/api/vault.ts` (**singular**) | `src/lib/api/vaults.ts` (**plural**) |
| **Env var** | `NEXT_PUBLIC_VAULT_CONTRACT_ID` | `NEXT_PUBLIC_VAULTS=mock\|live` |
| **Contract** | Deployed Soroban contract (C…) | `contracts/vault` — not yet deployed |
| **BFF base path** | `/api/v1/onchain/*` | `/api/v1/vaults/*` |
| **App route** | `/vault` (balance panel) | `/vaults` (listing + detail) |
| **Signers** | Freighter → VaultWalletAdapter (#252) | VaultWalletAdapter (#252) |
| **Data mode** | Always live (or throws if unconfigured) | `NEXT_PUBLIC_VAULTS=mock` (default) / `live` |
| **Contract crate** | N/A (pre-existing) | `zenith-options-vault` (`contracts/vault/`) |

---

## 1. Margin-Collateral Vault  (`vault.ts` — singular)

This vault is **already deployed**. It accepts user collateral and tracks how
much of it is locked against open positions.

### What it does

- `depositToVault(address, amount, session, idempotencyKey)` — builds an XDR
  via `POST /api/v1/onchain/build-deposit`, signs it, submits, and confirms.
- `withdrawFromVault(address, amount, session, freeCollateral, idempotencyKey)` —
  same flow via `POST /api/v1/onchain/build-withdraw`. Validates amount ≤
  free collateral before building.
- `fetchVaultHistory(address)` — reads deposit/withdraw events from Horizon's
  contract-events endpoint.

### Env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `NEXT_PUBLIC_VAULT_CONTRACT_ID` | **Yes** | Soroban contract address (C…) |
| `NEXT_PUBLIC_STELLAR_NETWORK` | No (defaults `testnet`) | Picks network passphrase |
| `NEXT_PUBLIC_HORIZON_URL` | No (defaults testnet URL) | Horizon for event history |

> **Do not** use `NEXT_PUBLIC_CONTRACT_VAULT_TESTNET` / `NEXT_PUBLIC_CONTRACT_VAULT_MAINNET`
> for this module. Those keys are wired to the governance contract registry
> (`src/env.ts → governableContractIds.vault`) and select the Phase 2 vault
> contract at the relevant network boundary. The margin-collateral vault has
> its own key (`NEXT_PUBLIC_VAULT_CONTRACT_ID`) to keep the two paths
> independently configurable. Tracking issue: F-10 in
> `docs/security/vault-threat-model.md`.

---

## 2. Phase 2 Options Vaults  (`vaults.ts` — plural)

These vaults are **not yet deployed**. The frontend adapter is wired to mock
data by default; setting `NEXT_PUBLIC_VAULTS=live` switches to the real BFF
(and will throw until the backend is live).

### What it does

- Exposes a typed registry of option-writing vaults: `fetchVaults()`,
  `fetchVaultDetail(id)`.
- Epoch-driven: each vault cycles through `deposit → active → settlement`
  phases; `EpochRecord` tracks strike, premium, outcome, and P&L.
- Share-based NAV: depositors hold shares priced at `sharePrice` (USD/share);
  fees are taken as performance and management basis points.
- Multi-asset collateral: each vault declares one `CollateralAsset` at
  creation (USDC, XLM, etc.).

### Env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `NEXT_PUBLIC_VAULTS` | No (defaults `mock`) | `mock` = fixture data; `live` = real BFF |

### Mock vs live

```
NEXT_PUBLIC_VAULTS=mock   → VAULT_FIXTURE_DATA from src/lib/fixtures/vaults.ts
NEXT_PUBLIC_VAULTS=live   → GET /api/v1/vaults (requires deployed backend)
```

Mock data is defined in `src/lib/fixtures/vaults.ts` (extracted from the
inline blob — see issue #254). It is the single source of truth for local dev,
unit tests, Storybook stories, and the Playwright mock backend.

---

## How to avoid common mistakes

| Mistake | How to catch it |
|---------|----------------|
| Importing from `vault` instead of `vaults` (or vice versa) | Check the use-case: collateral balance = `vault.ts`; epoch/share product = `vaults.ts` |
| Using `NEXT_PUBLIC_VAULT_CONTRACT_ID` for the options vault | Wrong — options vaults do not have a single contract ID in the frontend |
| Hardcoding vault addresses | Use env vars or the fixture layer; never commit a contract address into logic |
| Adding mock data inline to a page | Put it in `src/lib/fixtures/vaults.ts` instead (issue #254) |

---

## Contract scaffold (`contracts/vault/`)

The Rust/Soroban contract for Phase 2 options vaults lives in `contracts/vault/`
(crate: `zenith-options-vault`). Shared types are in `contracts/vault-common/`
(crate: `zenith-options-vault-common`).

Current scope: `initialize`, `pause`, `unpause`, `admin_transfer`, `upgrade`,
`advance_epoch`. Deposits, withdrawals, NAV math, and the backend API are **out
of scope** for the current scaffold — see `contracts/README.md`.

---

*Last updated: issues #251, #252, #253, #254*
