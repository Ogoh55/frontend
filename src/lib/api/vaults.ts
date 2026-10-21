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
 *   GET  /api/v1/vaults/{id}/orders    → VaultOrder[]
 *   POST /api/v1/vaults/{id}/orders    { side, shares, price, partial, expiresAt } → VaultOrder
 *   POST /api/v1/vaults/{id}/orders/{orderId}/fill { shares } → { tx_id: string }
 *   POST /api/v1/vaults/{id}/orders/{orderId}/cancel → { tx_id: string }
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/** Instrument used to hedge a vault's directional exposure. */
export type HedgeInstrument = "underlying" | "perp" | "futures";

/**
 * Per-vault delta-hedging policy (issue #297).
 *
 * The policy is enforced on-chain; the keeper service only proposes hedge
 * trades. A disabled policy or an engaged kill switch must result in zero
 * hedge trades. `maxHedgeNotional` is a hard cap in USD that the contract
 * clamps against so an off-chain bug cannot overshoot.
 */
export interface HedgePolicy {
  /** Master enable flag. When false, no hedge trades are ever executed. */
  enabled: boolean;
  /** Hard kill switch — overrides `enabled` and halts all hedging. */
  killSwitch: boolean;
  /** Target portfolio delta (e.g. 0 = delta-neutral). */
  targetDelta: number;
  /** Allowed drift around the target before a rehedge is triggered. */
  deltaTolerance: number;
  /** Instrument used to execute hedge trades. */
  hedgeInstrument: HedgeInstrument;
  /** Maximum absolute hedge notional in USD, enforced in-contract. */
  maxHedgeNotional: number;
  /** Minimum seconds between rehedges to rate-limit hedge churn. */
  rehedgeIntervalSecs: number;
}

/** Current hedge status surfaced for a vault. */
export interface HedgeStatus {
  policy: HedgePolicy;
  /** Aggregate portfolio delta of open written positions. */
  portfolioDelta: number;
  /** Aggregate portfolio gamma (informational). */
  portfolioGamma: number;
  /** Aggregate portfolio vega (informational). */
  portfolioVega: number;
  /** Current hedge position notional in USD (signed). */
  hedgeNotional: number;
  /** Whether the current delta is outside the configured band. */
  outsideBand: boolean;
  /** Timestamp of the last executed hedge trade, if any. */
  lastHedgeAt: string | null;
  /** True when the price feed is stale and hedging is failing safe. */
  staleOracle: boolean;
}

/** A single hedge trade recorded in the epoch ledger. */
export interface HedgeTrade {
  epochNumber: number;
  timestamp: string; // ISO
  instrument: HedgeInstrument;
  /** Signed notional in USD (positive = long hedge, negative = short). */
  notional: number;
  /** Realized hedge P&L in USD, attributed separately from option premium. */
  hedgePnl: number;
  /** Portfolio delta before and after the hedge. */
  deltaBefore: number;
  deltaAfter: number;
}

// ---------------------------------------------------------------------------
// Secondary transfer facility (issue #300)
// ---------------------------------------------------------------------------

/** Side of a secondary-market order for vault LP shares. */
export type VaultOrderSide = "bid" | "offer";

/** Lifecycle state of a secondary-market order. */
export type VaultOrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "expired";

/**
 * A resting or immediately-fillable order for vault LP shares.
 *
 * Price is denominated in the vault's share-price terms (USD per share) and
 * must sit inside the configurable band around the latest attested NAV. The
 * contract re-verifies price band, expiry, nonce and parties at settlement,
 * so the off-chain store is only a discovery surface.
 */
export interface VaultOrder {
  id: string;
  vaultId: string;
  /** Tranche identifier when the vault is tranched; null for single-tranche. */
  tranche: string | null;
  side: VaultOrderSide;
  /** Maker (order owner) address. */
  maker: string;
  /** Remaining shares available to fill. */
  shares: number;
  /** Original order size in shares. */
  originalShares: number;
  /** Limit price in USD per share. */
  price: number;
  /** Whether the order may be partially filled. */
  partial: boolean;
  status: VaultOrderStatus;
  /** ISO timestamp after which the order can no longer be filled. */
  expiresAt: string;
  createdAt: string;
  /** Replay-protection nonce signed into the order parameters. */
  nonce: number;
}

/**
 * Configurable pricing band around the latest attested NAV for a vault's
 * secondary transfer facility. Prices outside `[nav*(1-discount), nav*(1+premium)]`
 * are rejected at order creation and at settlement.
 */
export interface VaultOrderPricingBand {
  /** Maximum premium over NAV, e.g. 0.05 = +5%. */
  maxPremiumPct: number;
  /** Maximum discount under NAV, e.g. 0.05 = -5%. */
  maxDiscountPct: number;
  /** Latest attested NAV per share used as the band anchor. */
  attestedNav: number;
  /** ISO timestamp of the NAV attestation. */
  attestedAt: string;
  /** True when the attestation is stale or under dispute; settlement is blocked. */
  stale: boolean;
  /** True when a NAV dispute is open; settlement is blocked. */
  disputed: boolean;
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
  /** Hedge P&L for the epoch, attributed separately from option premium. */
  hedgePnl?: number;
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
  /** Delta-hedging policy and live status, when configured. */
  hedgeStatus?: HedgeStatus;
  /** Hedge trades recorded in the current epoch ledger. */
  hedgeTrades?: HedgeTrade[];
  /** Pricing band for the secondary transfer facility, when enabled. */
  orderPricingBand?: VaultOrderPricingBand;
  /** Resting and immediately-fillable orders for this vault's LP shares. */
  orders?: VaultOrder[];
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
    hedgeStatus: {
      policy: {
        enabled: true,
        killSwitch: false,
        targetDelta: 0,
        deltaTolerance: 0.1,
        hedgeInstrument: "perp",
        maxHedgeNotional: 50000,
        rehedgeIntervalSecs: 3600,
      },
      portfolioDelta: 0.34,
      portfolioGamma: -0.02,
      portfolioVega: -12.4,
      hedgeNotional: -32000,
      outsideBand: true,
      lastHedgeAt: "2026-09-27T15:00:00Z",
      staleOracle: false,
    },
    hedgeTrades: [
      { epochNumber: 46, timestamp: "2026-09-27T15:00:00Z", instrument: "perp", notional: -32000, hedgePnl: 412.5, deltaBefore: 0.42, deltaAfter: 0.05 },
    ],
    orderPricingBand: {
      maxPremiumPct: 0.05,
      maxDiscountPct: 0.05,
      attestedNav: 1.042,
      attestedAt: "2026-09-27T16:00:00Z",
      stale: false,
      disputed: false,
    },
    orders: [
      { id: "ord-1", vaultId: "xlm-cc-v1", tranche: null, side: "offer", maker: "GABC…XYZ", shares: 500, originalShares: 500, price: 1.05, partial: true, status: "open", expiresAt: "2026-10-04T16:00:00Z", createdAt: "2026-09-28T09:12:00Z", nonce: 1 },
      { id: "ord-2", vaultId: "xlm-cc-v1", tranche: null, side: "bid", maker: "GDEF…UVW", shares: 250, originalShares: 250, price: 1.01, partial: false, status: "open", expiresAt: "2026-10-02T16:00:00Z", createdAt: "2026-09-28T11:40:00Z", nonce: 2 },
    ],
  },
];
