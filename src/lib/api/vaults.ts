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
 *
 *   Admin corrections (issue #293) — four-eyes approval, append-only:
 *   GET  /api/v1/vaults/{id}/corrections            → VaultCorrection[]
 *   POST /api/v1/vaults/{id}/corrections            { type, reason, evidenceUrl, supersedes, payload } → VaultCorrection
 *   POST /api/v1/vaults/{id}/corrections/{cid}/approve  → VaultCorrection
 *   POST /api/v1/vaults/{id}/corrections/{cid}/reject   → VaultCorrection
 *   POST /api/v1/vaults/{id}/corrections/{cid}/apply    → VaultCorrection
 *   POST /api/v1/vaults/{id}/corrections/{cid}/preview  → CorrectionPreview
 *
 *   Tranche waterfall (issue #295) — pure/deterministic, callable off-chain:
 *   GET  /api/v1/vaults/{id}/tranches               → VaultTranche[]
 *   POST /api/v1/vaults/{id}/tranches/preview       { epochPremium, realizedLoss, fees } → TrancheWaterfallResult
 *
 *   Idle-collateral lending yield (issue #296) — narrow adapter, degrades to
 *   "no external yield" when the lending market is paused/unavailable:
 *   GET  /api/v1/vaults/{id}/collateral-policy     → CollateralDeploymentPolicy
 *   GET  /api/v1/vaults/{id}/collateral-yield      → CollateralYieldBreakdown
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
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
  /**
   * Idle-collateral lending yield attributed to this epoch (issue #296).
   * Tracked separately from strategy P&L so yield attribution stays auditable.
   */
  collateralYield?: CollateralYieldLedgerEntry;
}

/** The user's position in a vault. */
export interface UserVaultPosition {
  shares: number;
  shareValue: number; // current USD value per share
  totalValue: number;
  accruedPremium: number;
  pendingWithdrawal: number; // shares queued for withdrawal at epoch end
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
  /** Tranche configuration + per-tranche NAV (issue #295). */
  tranches: VaultTranche[];
  /** Idle-collateral lending policy + current yield breakdown (issue #296). */
  collateralPolicy: CollateralDeploymentPolicy;
  collateralYield: CollateralYieldBreakdown;
}

// ---------------------------------------------------------------------------
// Idle-collateral lending yield (issue #296)
// ---------------------------------------------------------------------------

/**
 * Per-strategy collateral-deployment policy. Idle collateral may be swept into
 * a Soroban lending market up to `targetUtilization` of idle cash, but a
 * `minLiquidBuffer` is always retained and collateral backing open written
 * positions is never deployed.
 */
export interface CollateralDeploymentPolicy {
  strategy: VaultStrategy;
  /** Share of idle cash that may be lent (0–1). */
  targetUtilization: number;
  /** Minimum liquid buffer retained, as a share of NAV (0–1). */
  minLiquidBuffer: number;
  /** Whether the lending integration is enabled for this vault. */
  enabled: boolean;
}

/**
 * Amount of idle collateral that may be swept given the policy and the
 * collateral reserved for open written positions. Pure/deterministic.
 */
export function computeDeployableCollateral(
  policy: CollateralDeploymentPolicy,
  idleCash: number,
  reservedForOpenPositions: number,
  nav: number,
): number {
  if (!policy.enabled) return 0;
  // Hard rule: collateral needed for open written positions is never deployed.
  const free = Math.max(0, idleCash - reservedForOpenPositions);
  const buffer = Math.max(0, nav * policy.minLiquidBuffer);
  const afterBuffer = Math.max(0, free - buffer);
  const utilization = Math.min(1, Math.max(0, policy.targetUtilization));
  return afterBuffer * utilization;
}

/**
 * Epoch-ledger entry tracking lent principal and accrued interest separately
 * from strategy P&L so yield attribution remains auditable.
 */
export interface CollateralYieldLedgerEntry {
  epochNumber: number;
  /** Principal swept into the lending market this epoch (USD). */
  lentPrincipal: number;
  /** Interest accrued on lent principal this epoch (USD). */
  accruedInterest: number;
  /** Principal unwound before settlement (USD). */
  unwoundPrincipal: number;
  /** True when the lending market was unavailable and yield degraded to 0. */
  degraded: boolean;
}

/** Collateral-yield breakdown surfaced on the vault detail page. */
export interface CollateralYieldBreakdown {
  /** Currently lent principal (USD). */
  lentPrincipal: number;
  /** Interest accrued to date on lent principal (USD). */
  accruedInterest: number;
  /** Effective APY contribution from lending yield (0–1). */
  yieldApy: number;
  /** True when the lending market is paused/unavailable (no external yield). */
  degraded: boolean;
  /** Per-epoch ledger entries for auditable yield attribution. */
  epochs: CollateralYieldLedgerEntry[];
}

// ---------------------------------------------------------------------------
// Tranche waterfall (issue #295)
// ---------------------------------------------------------------------------

/** Seniority rank; lower rank = more senior (paid first, loss-absorbed last). */
export type TrancheRank = "senior" | "junior";

/**
 * Per-tranche configuration. Weights are the target share of NAV and must sum
 * to 1 across all tranches (validated by `validateTrancheConfig`).
 */
export interface VaultTrancheConfig {
  id: string;
  rank: TrancheRank;
  /** Target share of aggregate NAV (0–1). All tranches must sum to 1. */
  targetWeight: number;
  /** Senior target yield per epoch (0–1). Ignored for junior tranches. */
  targetYield: number;
  /** Share of epoch premium routed to this tranche (0–1). */
  premiumSplit: number;
  /** Share of fees charged against this tranche (0–1). */
  feeSplit: number;
}

/** Live tranche state: config plus tranche-scoped share accounting. */
export interface VaultTranche extends VaultTrancheConfig {
  /** Tranche-scoped NAV in USD. */
  nav: number;
  /** Tranche-scoped shares outstanding. */
  shares: number;
  /** Tranche NAV per share in USD (distinct per tranche). */
  navPerShare: number;
  /** Senior target yield not met this epoch, carried forward (USD). */
  yieldShortfall: number;
}

/** Inputs to the deterministic waterfall for a single epoch close. */
export interface TrancheWaterfallInput {
  /** Aggregate NAV at epoch start (USD). */
  nav: number;
  /** Premium collected this epoch (USD). */
  epochPremium: number;
  /** Realized assignment loss this epoch (USD, >= 0). */
  realizedLoss: number;
  /** Fees charged this epoch (USD). */
  fees: number;
  /** Loss buffer absorbing losses before tranches (USD). */
  lossBuffer: number;
  tranches: VaultTrancheConfig[];
}

/** Per-tranche allocation produced by the waterfall. */
export interface TrancheWaterfallAllocation {
  id: string;
  rank: TrancheRank;
  /** Premium allocated to this tranche (USD). */
  premium: number;
  /** Fees charged against this tranche (USD). */
  fees: number;
  /** Loss absorbed by this tranche (USD). */
  loss: number;
  /** Net change to tranche NAV (premium - fees - loss). */
  netDelta: number;
  /** Senior target yield not met, carried forward (USD). */
  yieldShortfall: number;
}

/** Result of the waterfall; allocations conserve total value. */
export interface TrancheWaterfallResult {
  allocations: TrancheWaterfallAllocation[];
  /** Loss absorbed by the buffer before tranches. */
  bufferAbsorbed: number;
  /** Aggregate NAV after the waterfall. */
  resultingNav: number;
}

/**
 * Validate tranche configuration: weights must sum to 1 (within rounding
 * tolerance) and there must be exactly one senior and one junior tranche.
 */
export function validateTrancheConfig(tranches: VaultTrancheConfig[]): void {
  if (tranches.length !== 2) {
    throw new Error("Exactly one senior and one junior tranche are required");
  }
  const senior = tranches.filter((t) => t.rank === "senior");
  const junior = tranches.filter((t) => t.rank === "junior");
  if (senior.length !== 1 || junior.length !== 1) {
    throw new Error("Exactly one senior and one junior tranche are required");
  }
  const total = tranches.reduce((sum, t) => sum + t.targetWeight, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`Tranche target weights must sum to 1 (got ${total})`);
  }
}

/**
 * Pure/deterministic waterfall applied at each epoch close. Order:
 *   1. Loss buffer absorbs realized losses first.
 *   2. Senior coupon/target yield is paid from premium.
 *   3. Junior receives residual premium.
 *   4. Remaining losses are applied junior-first.
 *
 * Integer rounding is applied per-tranche and any residual is assigned to the
 * junior tranche so total value is conserved (never created or destroyed).
 * Callable off-chain for pre-deposit tranche NAV preview.
 */
export function computeTrancheWaterfall(
  input: TrancheWaterfallInput,
): TrancheWaterfallResult {
  validateTrancheConfig(input.tranches);

  const senior = input.tranches.find((t) => t.rank === "senior")!;
  const junior = input.tranches.find((t) => t.rank === "junior")!;

  // 1. Loss buffer absorbs losses first.
  const bufferAbsorbed = Math.min(input.lossBuffer, input.realizedLoss);
  let remainingLoss = input.realizedLoss - bufferAbsorbed;

  // 2. Senior coupon/target yield from premium.
  const seniorNav = input.nav * senior.targetWeight;
  const seniorTarget = seniorNav * senior.targetYield;
  const seniorPremium = Math.min(input.epochPremium, seniorTarget);
  const seniorShortfall = Math.max(0, seniorTarget - seniorPremium);
  const juniorPremium = input.epochPremium - seniorPremium;

  // 3. Fees split per tranche.
  const seniorFees = input.fees * senior.feeSplit;
  const juniorFees = input.fees * junior.feeSplit;

  // 4. Remaining losses applied junior-first.
  const juniorLoss = Math.min(remainingLoss, juniorPremium + juniorFees);
  remainingLoss -= juniorLoss;
  const seniorLoss = remainingLoss;

  const allocations: TrancheWaterfallAllocation[] = [
    {
      id: senior.id,
      rank: "senior",
      premium: seniorPremium,
      fees: seniorFees,
      loss: seniorLoss,
      netDelta: seniorPremium - seniorFees - seniorLoss,
      yieldShortfall: seniorShortfall,
    },
    {
      id: junior.id,
      rank: "junior",
      premium: juniorPremium,
      fees: juniorFees,
      loss: juniorLoss,
      netDelta: juniorPremium - juniorFees - juniorLoss,
      yieldShortfall: 0,
    },
  ];

  const resultingNav =
    input.nav +
    allocations.reduce((sum, a) => sum + a.netDelta, 0) -
    bufferAbsorbed;

  return { allocations, bufferAbsorbed, resultingNav };
}
