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
      { epochNumber: 10, depositStart: "2026-08-25", activeStart: "2026-08-29", settlementDate: "2026-09-28", strike: 3100, expiryDays: 30, premiumCollected: 28, outcome: "expired_worthless", pnlPct: 0.012 },
    ],
    userPosition: null,
  },
];
