/**
 * Typed data adapter interface for the Vaults feature.
 *
 * The vault smart contracts and backend API are not yet available.
 * When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
 * implementation below is used. Swap in the real implementation by
 * setting NEXT_PUBLIC_VAULTS=live and implementing `fetchVaultsLive`.
 *
 * Backend contract (for when the real API lands):
 *
 *   GET /api/v1/vaults
 *   → VaultSummary[]
 *
 *   GET /api/v1/vaults/{id}
 *   → VaultDetail
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

// ---------------------------------------------------------------------------
// Multi-asset collateral support (issue #217)
// ---------------------------------------------------------------------------

/**
 * Canonical collateral asset descriptor for a vault.
 *
 * A vault declares exactly one collateral asset at creation and it is
 * immutable afterwards. Classic Stellar assets use 7 decimals; Soroban
 * token contracts may declare arbitrary decimals. All contract math works
 * in base units; display units are derived at the API boundary via
 * `normalizeAmount` / `formatAssetAmount`.
 */
export interface CollateralAsset {
  /** Asset code, e.g. "USDC" or "AQUA". */
  code: string;
  /**
   * Classic Stellar issuer (G...) for classic assets, or the Soroban token
   * contract id (C...) for token contracts. Null for native XLM.
   */
  issuer: string | null;
  /** Soroban token contract id (C...) when the asset is a token contract. */
  contractId: string | null;
  /** Declared decimals for the asset (7 for classic Stellar assets). */
  decimals: number;
}

/** Classic Stellar assets always use 7 decimals. */
export const CLASSIC_ASSET_DECIMALS = 7;

/**
 * Per-network allowlist of supported collateral assets. Vault creation is
 * validated against this list; assets without a healthy oracle are excluded.
 */
export interface CollateralAllowlist {
  network: "mainnet" | "testnet" | "futurenet";
  assets: CollateralAsset[];
}

/**
 * Single shared normalization helper: convert a base-unit integer amount
 * into display units using the asset's declared decimals. Used for share
 * pricing, NAV, capacity, and fee math so no module re-implements scaling.
 */
export function normalizeAmount(baseUnits: bigint | number, decimals: number): number {
  const units = typeof baseUnits === "bigint" ? baseUnits : BigInt(Math.trunc(baseUnits));
  return Number(units) / 10 ** decimals;
}

/** Inverse of `normalizeAmount`: display units → base-unit integer. */
export function toBaseUnits(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}

/**
 * Validate that a display-unit amount does not exceed the asset's declared
 * decimals. Returns an error message for over-precision amounts, or null.
 */
export function validateAssetPrecision(amount: number, decimals: number): string | null {
  if (!Number.isFinite(amount) || amount < 0) return "Amount must be a non-negative number";
  const scaled = amount * 10 ** decimals;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    return `Amount exceeds ${decimals} decimal places for this asset`;
  }
  return null;
}

/**
 * Format a base-unit amount for display using the asset's decimals.
 * Very small share prices are preserved (never rounded to zero) by
 * falling back to significant-digit formatting.
 */
export function formatAssetAmount(baseUnits: bigint | number, decimals: number): string {
  const value = normalizeAmount(baseUnits, decimals);
  if (value === 0) return "0";
  if (Math.abs(value) < 0.01) return value.toPrecision(4);
  return value.toLocaleString(undefined, { maximumFractionDigits: Math.min(decimals, 6) });
}

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  /** Immutable collateral asset this vault operates in. */
  collateralAsset: CollateralAsset;
  /** Trailing 12-month APY estimate (0–1, e.g. 0.18 = 18%). */
  apy: number;
  /** APY methodology note shown in tooltip. */
  apyMethodology: string;
  /** Total value locked in USD. */
  tvl: number;
  /** Maximum TVL before the vault is full. */
  capacity: number;
  currentStrike: number;
  currentExpiry: string; // ISO date
  riskRating: RiskRating;
  description: string;
}

/** One historical epoch record. */
export interface EpochRecord {
  epochNumber: number;
  depositStart: string; // ISO
  activeStart: string;
  settlementDate: string;
  strike: number;
  expiryDays: number;
  premiumCollected: number; // per share, in USD
  outcome: "expired_worthless" | "exercised" | "active";
  pnlPct: number; // epoch return, positive = profit for depositors
}

/** The user's position in a vault. */
export interface UserVaultPosition {
  shares: number;
  shareValue: number; // current USD value per share
  totalValue: number;
  accruedPremium: number;
  pendingWithdrawal: number; // shares queued for withdrawal at epoch end
}

/**
 * SEP-41 share-token metadata for a vault's LP share ledger (issue #215).
 *
 * LP shares are exposed as a SEP-41 compliant token so wallets, explorers,
 * and other Soroban contracts can query balances/supply and (when enabled)
 * transfer positions. `decimals` must match the frontend's share-price
 * formatting assumptions; `transferable` is a per-vault policy flag that
 * defaults to off until depositor eligibility/disclosure gating is in place
 * and can be flipped without redeploying the vault.
 */
export interface VaultShareToken {
  /** SEP-41 `name()` — human-readable token name. */
  name: string;
  /** SEP-41 `symbol()` — short ticker used to label positions in the UI. */
  symbol: string;
  /** SEP-41 `decimals()` — must match frontend share-price scaling. */
  decimals: number;
  /** SEP-41 `total_supply()` — total LP shares outstanding. */
  totalSupply: number;
  /**
   * Per-vault transfer policy. When false, `transfer`/`transfer_from` are
   * rejected on-chain; mint/burn via deposit/redemption still work.
   */
  transferable: boolean;
}

/** Full detail for a single vault. */
export interface VaultDetail extends VaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string; // ISO — when the current phase ends
  sharePrice: number; // current NAV per share in USD
  totalShares: number;
  feeStructure: { managementPct: number; performancePct: number };
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
  /** SEP-41 share-token identity for this vault's LP shares. */
  shareToken: VaultShareToken;
  /** On-chain fee policy + last crystallization (issue #216). */
  feePolicy: VaultFeePolicy;
}

// ---------------------------------------------------------------------------
// Fee policy / high-water mark / crystallization (issue #216)
// ---------------------------------------------------------------------------

/**
 * Hard upper bound on any configured fee rate, in basis points (30%).
 * Enforced at configuration time on-chain (governance/timelock path) and
 * mirrored here so the UI can validate before submitting a change.
 */
export const MAX_FEE_BPS = 3_000;

/**
 * Per-vault fee policy. Rates are in basis points (1 bps = 0.01%).
 *
 * - `managementFeeBps` is charged per epoch on NAV.
 * - `performanceFeeBps` is charged only on new profits above the
 *   persistent high-water mark (never on recovered drawdowns).
 * - `feeRecipient` is the Stellar address that receives crystallized fees.
 *
 * Changes are only possible through the vault governance/timelock path.
 */
export interface VaultFeePolicy {
  managementFeeBps: number;
  performanceFeeBps: number;
  /** Stellar address (G.../C...) receiving crystallized fees. */
  feeRecipient: string;
  /**
   * Persistent high-water mark: the highest NAV-per-share at which a
   * performance fee has been crystallized. Stored in contract storage with
   * an explicit TTL policy (not derived from NAV history).
   */
  highWaterMark: number;
  /** Last epoch at which fees were crystallized, or null if never. */
  lastCrystallization: FeeCrystallization | null;
}

/**
 * Result of crystallizing fees at epoch close. Fees are computed and
 * settled inside the same transaction as epoch close, before the epoch NAV
 * is finalized, so the published NAV already reflects fees.
 */
export interface FeeCrystallization {
  epochNumber: number;
  /** NAV per share before fees were deducted. */
  navBeforeFees: number;
  /** NAV per share after fees were deducted (the published NAV). */
  navAfterFees: number;
  /** High-water mark in effect before this crystallization. */
  highWaterMarkBefore: number;
  /** High-water mark after this crystallization (raised only on new highs). */
  highWaterMarkAfter: number;
  managementFee: number;
  performanceFee: number;
  totalFee: number;
  /** Recipient the fees were transferred to. */
  feeRecipient: string;
  /** Transaction hash of the on-chain settlement transfer. */
  settlementTxHash: string;
  /** ISO timestamp of crystallization. */
  crystallizedAt: string;
}

/** True when a fee rate is within the hard maximum bound. */
export function isValidFeeBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= MAX_FEE_BPS;
}

/**
 * Compute the fees that would crystallize for an epoch, given the NAV per
 * share before fees and the current high-water mark.
 *
 * Semantics:
 * - Management fee = `navBeforeFees * managementFeeBps / 10_000`.
 * - Performance fee is charged only on the portion of NAV above the
 *   high-water mark: `max(0, navBeforeFees - highWaterMark) * performanceFeeBps / 10_000`.
 *   On loss or zero-profit epochs (NAV <= HWM) no performance fee is charged.
 * - The high-water mark is raised to `navBeforeFees` only when a new high
 *   is reached; it is never lowered on loss epochs.
 * - Dust policy: fees are floored to the smallest representable unit; a
 *   sub-unit fee rounds to zero rather than accruing forever.
 */
export function computeEpochFees(
  navBeforeFees: number,
  policy: Pick<VaultFeePolicy, "managementFeeBps" | "performanceFeeBps" | "highWaterMark">,
): { managementFee: number; performanceFee: number; totalFee: number; highWaterMarkAfter: number } {
  const nav = Math.max(0, navBeforeFees);
  const managementFee = Math.floor((nav * policy.managementFeeBps) / 10_000);
  const gains = Math.max(0, nav - policy.highWaterMark);
  const performanceFee = Math.floor((gains * policy.performanceFeeBps) / 10_000);
  const highWaterMarkAfter = nav > policy.highWaterMark ? nav : policy.highWaterMark;
  return {
    managementFee,
    performanceFee,
    totalFee: managementFee + performanceFee,
    highWaterMarkAfter,
  };
}

// ---------------------------------------------------------------------------
// Simulation / fee estimation / failure surfacing (issue #214)
// ----------

/* … truncated 4354 chars — edit only what you need near the top … */
