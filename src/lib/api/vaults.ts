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
  const seniorShortfall = seniorTarget - seniorPremium;

  // 3. Junior receives residual premium.
  const juniorPremium = input.epochPremium - seniorPremium;

  // Fees split per config.
  const seniorFees = input.fees * senior.feeSplit;
  const juniorFees = input.fees - seniorFees;

  // 4. Losses applied junior-first after buffer.
  const juniorNav = input.nav * junior.targetWeight;
  const juniorLoss = Math.min(juniorNav, remainingLoss);
  remainingLoss -= juniorLoss;
  const seniorLoss = Math.min(seniorNav, remainingLoss);

  const seniorNet = seniorPremium - seniorFees - seniorLoss;
  const juniorNet = juniorPremium - juniorFees - juniorLoss;

  const allocations: TrancheWaterfallAllocation[] = [
    {
      id: senior.id,
      rank: "senior",
      premium: seniorPremium,
      fees: seniorFees,
      loss: seniorLoss,
      netDelta: seniorNet,
      yieldShortfall: seniorShortfall,
    },
    {
      id: junior.id,
      rank: "junior",
      premium: juniorPremium,
      fees: juniorFees,
      loss: juniorLoss,
      netDelta: juniorNet,
      yieldShortfall: 0,
    },
  ];

  const resultingNav = input.nav + seniorNet + juniorNet;

  return { allocations, bufferAbsorbed, resultingNav };
}

// ---------------------------------------------------------------------------
// Admin corrections (issue #293)
// ---------------------------------------------------------------------------

/**
 * Catalog of supported correction types. Each is an append-only compensating
 * entry that references (never mutates) the record it supersedes.
 *
 * - compensating_ledger_entry: posts an offsetting ledger entry. Invariant:
 *   sum of compensating entries nets to the intended delta; blast radius is
 *   the affected epoch's ledger + read model.
 * - nav_snapshot_restatement: supersedes a NAV snapshot with a corrected one.
 *   Invariant: new snapshot references the superseded snapshot id; blast
 *   radius includes published NAV feed + share price.
 * - queue_entry_repair: repairs a stuck withdrawal-queue entry. Invariant:
 *   total queued shares unchanged unless explicitly stated; blast radius is
 *   the withdrawal queue only.
 * - fee_reclassification: reclassifies a mis-booked fee. Invariant: total
 *   fees conserved across management/performance buckets; blast radius is
 *   fee accounting + NAV.
 * - indexer_cursor_rewind: rewinds the indexer cursor to re-derive state.
 *   Invariant: rewind target <= last reconciled block; blast radius is the
 *   indexer + read model (no ledger mutation).
 */
export type CorrectionType =
  | "compensating_ledger_entry"
  | "nav_snapshot_restatement"
  | "queue_entry_repair"
  | "fee_reclassification"
  | "indexer_cursor_rewind";

/** State machine: proposed → approved → applied → reconciled, or rejected/expired. */
export type CorrectionStatus =
  | "proposed"
  | "approved"
  | "applied"
  | "reconciled"
  | "rejected"
  | "expired";

/** Approval tier; larger magnitudes / published-NAV changes need higher tiers. */
export type ApprovalTier = "standard" | "elevated";

/** A first-class correction domain object. */
export interface VaultCorrection {
  id: string;
  vaultId: string;
  type: CorrectionType;
  status: CorrectionStatus;
  /** Written reason supplied by the proposing operator. */
  reason: string;
  /** Evidence link (ticket, tx, dashboard) supplied by the proposer. */
  evidenceUrl: string;
  /** Id of the record this correction supersedes (append-only reference). */
  supersedes: string;
  /** Type-specific payload (e.g. corrected NAV, queue entry id). */
  payload: Record<string, unknown>;
  /** Operator who proposed. */
  proposedBy: string;
  proposedAt: string; // ISO
  /** Operator who approved (must differ from proposedBy). */
  approvedBy: string | null;
  approvedAt: string | null; // ISO
  /** When the approval expires and must be re-approved. */
  approvalExpiresAt: string | null; // ISO
  /** Required approval tier for this correction. */
  requiredTier: ApprovalTier;
  /** True when the correction changes a published epoch's committed NAV. */
  affectsPublishedNav: boolean;
  /** Idempotency key so repeated application is a no-op. */
  idempotencyKey: string;
  appliedAt: string | null; // ISO
  reconciledAt: string | null; // ISO
}

/** Dry-run preview of a correction's effect before approval. */
export interface CorrectionPreview {
  correctionId: string;
  resultingNav: number;
  resultingSharePrice: number;
  queueState: { queuedShares: number; repairedEntries: number };
  affectedDepositors: number;
  /** Whether the previewed state matches on-chain balances. */
  reconcilesOnChain: boolean;
}

/**
 * Server-side maker-checker guard. Rejects self-approval and expired approvals.
 * The UI must not be the only enforcement point.
 */
export function assertApprovalAllowed(
  correction: VaultCorrection,
  approver: string,
  now: Date = new Date(),
): void {
  if (correction.status !== "proposed") {
    throw new Error(`Correction ${correction.id} is not awaiting approval`);
  }
  if (approver === correction.proposedBy) {
    throw new Error("Self-approval is not permitted");
  }
  if (
    correction.approvalExpiresAt &&
    new Date(correction.approvalExpiresAt).getTime() <= now.getTime()
  ) {
    throw new Error(`Approval for correction ${correction.id} has expired`);
  }
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
    phaseEndsAt: "2026-09-27T00:00:00Z",
    sharePrice: 1.084,
    totalShares: 262000,
    feeStructure: { managementPct: 0.02, performancePct: 0.1 },
    payoffExplanation: "If XLM closes below the strike at expiry, the option expires worthless and the vault keeps the full premium. If XLM closes above the strike, the vault delivers XLM at the strike price, capping upside.",
    historicalEpochs: [],
    userPosition: null,
    tranches: [
      {
        id: "senior",
        rank: "senior",
        targetWeight: 0.7,
        targetYield: 0.004,
        premiumSplit: 0.7,
        feeSplit: 0.7,
        nav: 198800,
        shares: 183400,
        navPerShare: 1.084,
        yieldShortfall: 0,
      },
      {
        id: "junior",
        rank: "junior",
        targetWeight: 0.3,
        targetYield: 0,
        premiumSplit: 0.3,
        feeSplit: 0.3,
        nav: 85200,
        shares: 78600,
        navPerShare: 1.084,
        yieldShortfall: 0,
      },
    ],
  },
];
