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
 *   GET /api/v1/vaults/{id}/epoch-schedule?count=N
 *   → EpochBoundaryPreview   (dry-run: next N boundaries, no side effects)
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
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
// Epoch schedule (issue #286)
//
// Deterministic, UTC-anchored epoch boundary scheduling. All math is pure and
// independent of server local time; the scheduler only emits "boundary due"
// events and the epoch pipeline consumes them.
// ---------------------------------------------------------------------------

/**
 * Per-vault schedule configuration. Anchors are always explicit UTC instants
 * (ISO-8601 with `Z`); server local time is never consulted.
 *
 * - `fixed_interval`: boundaries every `intervalSeconds` starting at `anchor`.
 * - `calendar_monthly`: boundaries on the same day-of-month / time-of-day as
 *   `anchor`, clamped to the last day of shorter months (expiry-aligned).
 */
export type EpochScheduleConfig =
  | {
      kind: "fixed_interval";
      /** UTC anchor instant (ISO-8601, must end in `Z`). */
      anchor: string;
      /** Interval between boundaries in seconds (> 0). */
      intervalSeconds: number;
    }
  | {
      kind: "calendar_monthly";
      /** UTC anchor instant (ISO-8601, must end in `Z`). */
      anchor: string;
    };

/** How the scheduler recovers boundaries missed while the service was down. */
export type MissedBoundaryPolicy = "process_once" | "process_sequentially" | "skip_with_record";

/** Persisted boundary state, keyed by (vault, epoch index). */
export interface EpochBoundaryState {
  vaultId: string;
  /** Zero-based epoch index this boundary closes. */
  epochIndex: number;
  /** Deterministic UTC boundary instant (ISO-8601). */
  boundaryAt: string;
  status: "pending" | "processed" | "skipped";
  /** Set when the boundary was skipped under `skip_with_record`. */
  skipReason?: string;
}

/** A single upcoming boundary in a dry-run preview. */
export interface EpochBoundaryPreviewItem {
  epochIndex: number;
  boundaryAt: string; // ISO-8601 UTC
}

/** Dry-run/preview result: the next N boundaries for a vault. */
export interface EpochBoundaryPreview {
  vaultId: string;
  schedule: EpochScheduleConfig;
  /** Ledger close time the preview was computed against (ISO-8601 UTC). */
  ledgerCloseTime: string;
  boundaries: EpochBoundaryPreviewItem[];
}

/**
 * Clock-skew tolerance in seconds. A boundary is considered due only when the
 * ledger close time is at or past `boundaryAt + tolerance`. This absorbs small
 * disagreements between the local clock and Stellar ledger close time.
 */
export const EPOCH_CLOCK_SKEW_TOLERANCE_SECONDS = 30;

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;

function parseUtcAnchor(anchor: string): number {
  if (!anchor.endsWith("Z")) {
    throw new Error(`Epoch schedule anchor must be an explicit UTC instant (…Z): ${anchor}`);
  }
  const ms = Date.parse(anchor);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid epoch schedule anchor: ${anchor}`);
  }
  return ms;
}

/**
 * Pure boundary computation. Returns the UTC instant (ms since epoch) of the
 * boundary for `epochIndex` (zero-based) under `config`. Deterministic for a
 * given (config, epochIndex) regardless of server local time.
 */
export function computeBoundaryMs(config: EpochScheduleConfig, epochIndex: number): number {
  if (!Number.isInteger(epochIndex) || epochIndex < 0) {
    throw new Error(`epochIndex must be a non-negative integer: ${epochIndex}`);
  }
  const anchorMs = parseUtcAnchor(config.anchor);

  if (config.kind === "fixed_interval") {
    if (!Number.isFinite(config.intervalSeconds) || config.intervalSeconds <= 0) {
      throw new Error(`intervalSeconds must be > 0: ${config.intervalSeconds}`);
    }
    return anchorMs + epochIndex * config.intervalSeconds * MS_PER_SECOND;
  }

  // calendar_monthly: advance whole UTC months from the anchor, clamping the
  // day-of-month to the last day of the target month (e.g. Jan 31 → Feb 28/29).
  const anchor = new Date(anchorMs);
  const anchorDay = anchor.getUTCDate();
  const anchorHour = anchor.getUTCHours();
  const anchorMinute = anchor.getUTCMinutes();
  const anchorSecond = anchor.getUTCSeconds();
  const anchorMillis = anchor.getUTCMilliseconds();

  const targetMonthIndex = anchor.getUTCMonth() + epochIndex;
  const targetYear = anchor.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(anchorDay, lastDayOfMonth);

  return Date.UTC(
    targetYear,
    targetMonth,
    targetDay,
    anchorHour,
    anchorMinute,
    anchorSecond,
    anchorMillis,
  );
}

/** Pure boundary computation returning an ISO-8601 UTC string. */
export function computeBoundary(config: EpochScheduleConfig, epochIndex: number): string {
  return new Date(computeBoundaryMs(config, epochIndex)).toISOString();
}

/**
 * Returns the epoch index of the most recent boundary at or before
 * `ledgerCloseTimeMs`, or -1 if the anchor is still in the future.
 */
export function latestBoundaryIndex(
  config: EpochScheduleConfig,
  ledgerCloseTimeMs: number,
): number {
  const anchorMs = parseUtcAnchor(config.anchor);
  if (ledgerCloseTimeMs < anchorMs) return -1;

  if (config.kind === "fixed_interval") {
    const intervalMs = config.intervalSeconds * MS_PER_SECOND;
    return Math.floor((ledgerCloseTimeMs - anchorMs) / intervalMs);
  }

  // calendar_monthly: walk months forward from the anchor. Bounded by the
  // number of whole months between anchor and ledger close time.
  const anchor = new Date(anchorMs);
  const close = new Date(ledgerCloseTimeMs);
  let months =
    (close.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (close.getUTCMonth() - anchor.getUTCMonth());
  if (months < 0) months = 0;
  // Correct for clamping: the boundary for `months` may still be in the future.
  while (months > 0 && computeBoundaryMs(config, months) > ledgerCloseTimeMs) {
    months -= 1;
  }
  return months;
}

/**
 * Clock-skew policy: a boundary is due when the ledger close time is at or past
 * `boundaryAt + EPOCH_CLOCK_SKEW_TOLERANCE_SECONDS`. If the local clock is
 * behind the ledger, the ledger close time governs; if ahead, the tolerance
 * prevents premature triggering.
 */
export function isBoundaryDue(
  config: EpochScheduleConfig,
  epochIndex: number,
  ledgerCloseTimeMs: number,
): boolean {
  const boundaryMs = computeBoundaryMs(config, epochIndex);
  return ledgerCloseTimeMs >= boundaryMs + EPOCH_CLOCK_SKEW_TOLERANCE_SECONDS * MS_PER_SECOND;
}

/**
 * Missed-boundary recovery. Given the last processed epoch index and the
 * current ledger close time, returns the boundaries that are due but not yet
 * processed, honouring the per-config recovery policy. Never returns an index
 * that has already been processed, so triggering is idempotent per
 * (vault, epoch index).
 */
export function dueBoundaries(
  config: EpochScheduleConfig,
  lastProcessedEpochIndex: number,
  ledgerCloseTimeMs: number,
  policy: MissedBoundaryPolicy,
): EpochBoundaryPreviewItem[] {
  const latest = latestBoundaryIndex(config, ledgerCloseTimeMs);
  const firstDue = lastProcessedEpochIndex + 1;
  if (latest < firstDue) return [];

  const indices: number[] = [];
  if (policy === "process_sequentially") {
    for (let i = firstDue; i <= latest; i += 1) indices.push(i);
  } else {
    // process_once and skip_with_record both advance to the latest boundary;
    // skip_with_record additionally records the skipped indices on-chain.
    indices.push(latest);
  }

  return indices.map((epochIndex) => ({
    epochIndex,
    boundaryAt: computeBoundary(config, epochIndex),
  }));
}

/**
 * Dry-run/preview: lists the next `count` boundaries for a vault starting from
 * the first unprocessed epoch index. Pure — performs no side effects.
 */
export function previewBoundaries(
  config: EpochScheduleConfig,
  lastProcessedEpochIndex: number,
  count: number,
): EpochBoundaryPreviewItem[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`count must be a non-negative integer: ${count}`);
  }
  const start = lastProcessedEpochIndex + 1;
  const items: EpochBoundaryPreviewItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const epochIndex = start + i;
    items.push({ epochIndex, boundaryAt: computeBoundary(config, epochIndex) });
  }
  return items;
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
      { epochNumber: 10, depositStart: "2026-08-25", activeStart: "2026-08-29", settlementDate: "2026-09-28", strike: 3100, expiryDays: 30, premiumCollected: 28, outcome: "expired_worthless", pnlPct: 0.016 },
    ],
    userPosition: null,
  },
];
