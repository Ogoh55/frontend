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

/**
 * Stable, versioned moneyness band used as the strike-bucket key for
 * concentration limits. Buckets are enums (not free strings) so the sizing
 * step and contract enforcement can never disagree on a key.
 */
export type StrikeBucket = "deep_otm" | "otm" | "atm" | "itm" | "deep_itm";

/**
 * Declarative concentration limits for a vault, each expressed as a fraction
 * of the committed epoch NAV (0–1). Evaluated by the shared
 * `evaluateExposure()` helper so sizing and enforcement cannot drift.
 */
export interface ExposureLimits {
  /** Max fraction of NAV written against a single underlying. */
  perUnderlying: number;
  /** Max fraction of NAV written into a single strike bucket. */
  perStrikeBucket: number;
  /** Max fraction of NAV written into a single expiry. */
  perExpiry: number;
}

/** Current written exposure, keyed by the same dimensions as the limits. */
export interface ExposureState {
  /** Committed epoch NAV used as the denominator (no live mark). */
  nav: number;
  byUnderlying: Record<string, number>;
  byStrikeBucket: Partial<Record<StrikeBucket, number>>;
  byExpiry: Record<string, number>;
}

/** A strategy intent requesting a written notional before sizing. */
export interface StrategyIntent {
  underlying: string;
  strikeBucket: StrikeBucket;
  expiry: string; // ISO date
  requestedNotional: number;
}

/** Recorded clamp decision for observability. */
export interface SizingDecision {
  approvedNotional: number;
  clamped: boolean;
  /** Tightest binding dimension, or null when unclamped. */
  reason: "perUnderlying" | "perStrikeBucket" | "perExpiry" | null;
  /** Remaining headroom (in notional) on the binding dimension. */
  remainingHeadroom: number;
}

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
  /** Declarative concentration limits (fractions of NAV). */
  exposureLimits: ExposureLimits;
  /** Current written exposure used by the sizing step. */
  exposure: ExposureState;
}

// ---------------------------------------------------------------------------
// Shared exposure evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the tightest applicable remaining limit for an intent and clamp
 * the requested notional to it. Both the sizing step and the contract
 * enforcement boundary call this so they can never drift.
 *
 * A vault already over a (newly-tightened) limit yields zero headroom on
 * that dimension, so new writes are blocked while existing positions roll
 * off — no revert of unrelated operations.
 */
export function evaluateExposure(
  limits: ExposureLimits,
  state: ExposureState,
  intent: StrategyIntent,
): SizingDecision {
  const nav = state.nav;
  const headroom = (limit: number, used: number): number =>
    Math.max(0, limit * nav - used);

  const candidates: Array<{
    reason: NonNullable<SizingDecision["reason"]>;
    remaining: number;
  }> = [
    {
      reason: "perUnderlying",
      remaining: headroom(limits.perUnderlying, state.byUnderlying[intent.underlying] ?? 0),
    },
    {
      reason: "perStrikeBucket",
      remaining: headroom(limits.perStrikeBucket, state.byStrikeBucket[intent.strikeBucket] ?? 0),
    },
    {
      reason: "perExpiry",
      remaining: headroom(limits.perExpiry, state.byExpiry[intent.expiry] ?? 0),
    },
  ];

  const tightest = candidates.reduce((a, b) => (b.remaining < a.remaining ? b : a));
  const approvedNotional = Math.max(0, Math.min(intent.requestedNotional, tightest.remaining));
  const clamped = approvedNotional < intent.requestedNotional;

  return {
    approvedNotional,
    clamped,
    reason: clamped ? tightest.reason : null,
    remainingHeadroom: tightest.remaining,
  };
}

/**
 * Validate that a limit set is not jointly unsatisfiable (each dimension must
 * be a positive fraction of NAV). Called on config write.
 */
export function validateExposureLimits(limits: ExposureLimits): string[] {
  const errors: string[] = [];
  (["perUnderlying", "perStrikeBucket", "perExpiry"] as const).forEach((key) => {
    const v = limits[key];
    if (!(v > 0 && v <= 1)) {
      errors.push(`${key} must be a fraction of NAV in (0, 1]`);
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_VAULTS: VaultDetail[] = [
  {
    id: "xlm-cc-v1",
    name: "XLM Covered Call",
    underlying: "XLM",
    strategy: "covered_call",
    apy: 0.22,
    apyMethodology: "Trailing 12-month annualized premium income ÷ average TVL. Does not include spot price change of the underlying.",
    tvl: 284000,
    capacity: 500000,
    currentStrike: 0.13,
    currentExpiry: "2026-10-03",
    riskRating: "medium",
    description: "Writes weekly out-of-the-money covered calls on XLM. Collects premium each epoch; the vault holds XLM as collateral.",
    currentEpoch: 47,
    currentPhase: "active",
    phaseEndsAt: "2026-10-03T16:00:00Z",
    sharePrice: 1.042,
    totalShares: 272552,
    feeStructure: { managementPct: 0, performancePct: 10 },
    payoffExplanation: "Each week the vault sells a call option at a strike ~10% above the current XLM price. If XLM stays below the strike, depositors keep the full premium. If XLM rallies above the strike, the position is exercised and depositors participate in the upside up to the strike, giving up gains beyond it.",
    historicalEpochs: [
      { epochNumber: 46, depositStart: "2026-09-19", activeStart: "2026-09-20", settlementDate: "2026-09-27", strike: 0.125, expiryDays: 7, premiumCollected: 0.0018, outcome: "expired_worthless", pnlPct: 0.021 },
      { epochNumber: 45, depositStart: "2026-09-12", activeStart: "2026-09-13", settlementDate: "2026-09-20", strike: 0.122, expiryDays: 7, premiumCollected: 0.0015, outcome: "expired_worthless", pnlPct: 0.018 },
      { epochNumber: 44, depositStart: "2026-09-05", activeStart: "2026-09-06", settlementDate: "2026-09-13", strike: 0.118, expiryDays: 7, premiumCollected: 0.0021, outcome: "exercised",         pnlPct: 0.009 },
      { epochNumber: 43, depositStart: "2026-08-29", activeStart: "2026-08-30", settlementDate: "2026-09-06", strike: 0.115, expiryDays: 7, premiumCollected: 0.0019, outcome: "expired_worthless", pnlPct: 0.022 },
      { epochNumber: 42, depositStart: "2026-08-22", activeStart: "2026-08-23", settlementDate: "2026-08-30", strike: 0.120, expiryDays: 7, premiumCollected: 0.0016, outcome: "expired_worthless", pnlPct: 0.019 },
    ],
    userPosition: { shares: 950, shareValue: 1.042, totalValue: 989.9, accruedPremium: 18.46, pendingWithdrawal: 0 },
    exposureLimits: { perUnderlying: 0.5, perStrikeBucket: 0.35, perExpiry: 0.4 },
    exposure: {
      nav: 284000,
      byUnderlying: { XLM: 142000 },
      byStrikeBucket: { otm: 142000 },
      byExpiry: { "2026-10-03": 142000 },
    },
  },
  {
    id: "btc-csp-v1",
    name: "BTC Cash-Secured Put",
    underlying: "BTC",
    strategy: "cash_secured_put",
    apy: 0.15,
    apyMethodology: "Trailing 12-month annualized premium income ÷ average USDC TVL. Excludes BTC spot risk — depositors are exposed to assignment at the strike price.",
    tvl: 1850000,
    capacity: 3000000,
    currentStrike: 60000,
    currentExpiry: "2026-10-17",
    riskRating: "high",
    description: "Writes monthly cash-secured puts on BTC. The vault holds USDC as collateral; assignment means acquiring BTC at the strike.",
    currentEpoch: 18,
    currentPhase: "active",
    phaseEndsAt: "2026-10-17T20:00:00Z",
    sharePrice: 1.088,
    totalShares: 1700368,
    feeStructure: { managementPct: 0.5, performancePct: 15 },
    payoffExplanation: "Each month the vault sells a put option at a strike ~10% below the current BTC price, backed by USDC. If BTC stays above the strike, depositors keep the premium. If BTC falls below the strike, the vault is assigned and acquires BTC at the strike — a risk equivalent to a limit buy order.",
    historicalEpochs: [
      { epochNumber: 17, depositStart: "2026-08-15", activeStart: "2026-08-19", settlementDate: "2026-09-20", strike: 59000, expiryDays: 30, premiumCollected: 420, outcome: "expired_worthless", pnlPct: 0.013 },
      { epochNumber: 16, depositStart: "2026-07-18", activeStart: "2026-07-22", settlementDate: "2026-08-16", strike: 55000, expiryDays: 30, premiumCollected: 380, outcome: "expired_worthless", pnlPct: 0.011 },
      { epochNumber: 15, depositStart: "2026-06-21", activeStart: "2026-06-24", settlementDate: "2026-07-19", strike: 57000, expiryDays: 30, premiumCollected: 440, outcome: "expired_worthless", pnlPct: 0.014 },
    ],
    userPosition: null,
    exposureLimits: { perUnderlying: 0.6, perStrikeBucket: 0.4, perExpiry: 0.5 },
    exposure: {
      nav: 1850000,
      byUnderlying: { BTC: 925000 },
      byStrikeBucket: { otm: 925000 },
      byExpiry: { "2026-10-17": 925000 },
    },
  },
  {
    id: "eth-ic-v1",
    name: "ETH Iron Condor",
    underlying: "ETH",
    strategy: "iron_condor",
    apy: 0.18,
    apyMethodology: "Trailing 12-month net premium income (both spreads) ÷ average USDC collateral deployed.",
    tvl: 620000,
    capacity: 1000000,
    currentStrike: 3200,
    currentExpiry: "2026-10-10",
    riskRating: "low",
    description: "Sells 30-day iron condors on ETH, targeting a range-bound market. Limited loss profile; wins when ETH stays between the two breakevens.",
    currentEpoch: 11,
    currentPhase: "deposit",
    phaseEndsAt: "2026-09-28T12:00:00Z",
    sharePrice: 1.021,
    totalShares: 607247,
    feeStructure: { managementPct: 0, performancePct: 10 },
    payoffExplanation: "The vault simultaneously sells an out-of-the-money call spread and a put spread on ETH. Maximum profit is the combined net premium, achieved if ETH expires between the two short strikes. Maximum loss is limited to the spread width minus the premium.",
    historicalEpochs: [
      { epochNumber: 10, depositStart: "2026-08-25", activeStart: "2026-08-29", settlementDate: "2026-09-28", strike: 3100, expiryDays: 30, premiumCollected: 28, outcome: "expired_worthless", pnlPct: 0.016 },
    ],
    userPosition: null,
    exposureLimits: { perUnderlying: 0.4, perStrikeBucket: 0.25, perExpiry: 0.3 },
    exposure: {
      nav: 620000,
      byUnderlying: { ETH: 186000 },
      byStrikeBucket: { otm: 124000, atm: 62000 },
      byExpiry: { "2026-10-10": 186000 },
    },
  },
];
