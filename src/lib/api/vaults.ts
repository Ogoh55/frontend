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
 *   POST /api/v1/vaults/{id}/emergency-redeem  { shares: number }  → { tx_id: string; penalty_bps: number }
 *
 * Realtime (shared spot/vol WebSocket, see SpotFeedContext):
 *
 *   subscribe: { op: "subscribe", topic: "vault:<id>", schema: VAULT_TICK_SCHEMA_VERSION }
 *   message:   { topic: "vault:<id>", schema: VAULT_TICK_SCHEMA_VERSION, data: VaultTick }
 *
 * The envelope mirrors the existing spot/vol feed (topic + schema version +
 * data) so vaults reuse the same connection and versioning scheme rather than
 * introducing a second realtime contract.
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/**
 * Version of the vault realtime tick envelope. Bump alongside the vault event
 * schema versioning work; clients ignore ticks whose schema they don't know.
 */
export const VAULT_TICK_SCHEMA_VERSION = 1;

/**
 * Live vault state pushed over the shared spot/vol WebSocket, keyed by vault id.
 * Epoch countdown is derived locally from `epochEndsAt` + `serverTime` so the
 * client never trusts per-second server pushes and tolerates clock skew.
 */
export interface VaultTick {
  /** NAV per share in USD. */
  navPerShare: number;
  /** Current epoch number. */
  epochNumber: number;
  /** ISO timestamp when the current epoch closes (authoritative). */
  epochEndsAt: string;
  /** Shares queued for redemption at epoch settlement. */
  queueDepth: number;
  /** ISO timestamp of the last authoritative update from the backend. */
  updatedAt: string;
  /** Server clock at publish time (ISO), used to correct client skew. */
  serverTime: string;
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

/**
 * Objective on-chain triggers that unlock the emergency break-glass exit.
 * Mirrors the contract's `emergency_conditions_met()` predicate — at least
 * one must be true for `emergency_redeem` to be callable.
 */
export type EmergencyTrigger =
  | "operator_halt"
  | "nav_stale"
  | "lifecycle_failure";

/**
 * Break-glass exit configuration and current trigger state for a vault.
 * The redeemable amount is priced off the last committed epoch snapshot NAV
 * (never a live mark) so the exit is deterministic.
 */
export interface EmergencyExitInfo {
  /** True when at least one objective trigger is currently satisfied. */
  conditionsMet: boolean;
  /** Which triggers are currently active (empty when none). */
  activeTriggers: EmergencyTrigger[];
  /** Exit penalty/buffer in basis points, disclosed pre-signature. */
  penaltyBps: number;
  /** NAV per share from the last committed epoch snapshot (USD). */
  snapshotNavPerShare: number;
  /** Max shares redeemable this trigger window (rate limit / TVL cap). */
  remainingCapacityShares: number;
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
  /** Break-glass exit state; null when the vault has no emergency path. */
  emergencyExit: EmergencyExitInfo | null;
}

/**
 * Compute the deterministic emergency redemption payout for `shares`.
 * Uses the last committed epoch snapshot NAV and applies the exit penalty.
 * Returns null when the break-glass conditions are not met.
 */
export function computeEmergencyRedemption(
  info: EmergencyExitInfo,
  shares: number,
): { grossValue: number; penalty: number; netValue: number } | null {
  if (!info.conditionsMet || shares <= 0) return null;
  const grossValue = shares * info.snapshotNavPerShare;
  const penalty = grossValue * (info.penaltyBps / 10_000);
  return { grossValue, penalty, netValue: grossValue - penalty };
}

/**
 * Derive seconds remaining until epoch close from an authoritative tick.
 * Corrects for client/server clock skew using the tick's `serverTime` and
 * clamps at zero so a stale tick never renders a negative countdown.
 */
export function secondsToEpochClose(
  tick: Pick<VaultTick, "epochEndsAt" | "serverTime">,
  now: number = Date.now(),
): number {
  const skew = now - Date.parse(tick.serverTime);
  const remainingMs = Date.parse(tick.epochEndsAt) - (now - skew);
  return Math.max(0, Math.floor(remainingMs / 1000));
}

/**
 * Build the subscribe frame for a vault topic on the shared feed connection.
 * Subscriptions are lazy (issued on mount) and released on unmount by the
 * context owner; this helper only shapes the outbound message.
 */
export function vaultSubscriptionFrame(vaultId: string): {
  op: "subscribe";
  topic: string;
  schema: number;
} {
  return { op: "subscribe", topic: `vault:${vaultId}`, schema: VAULT_TICK_SCHEMA_VERSION };
}

/**
 * Type guard for an inbound vault tick message on the shared connection.
 * Rejects unknown schema versions so a backend bump can't crash the client.
 */
export function isVaultTickMessage(
  msg: unknown,
): msg is { topic: string; schema: number; data: VaultTick } {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.topic === "string" &&
    m.topic.startsWith("vault:") &&
    m.schema === VAULT_TICK_SCHEMA_VERSION &&
    typeof m.data === "object" &&
    m.data !== null
  );
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
    emergencyExit: {
      conditionsMet: false,
      activeTriggers: [],
      penaltyBps: 150,
      snapshotNavPerShare: 1.042,
      remainingCapacityShares: 27255,
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
    payoffExplanation: "Each month the vault sells a put option at a strike ~10% below the current BTC price, backed by USDC. If BTC stays above the strike, the put expires worthless and depositors keep the premium. If BTC falls below the strike, the vault is assigned BTC at the strike and depositors hold BTC at that cost basis.",
    historicalEpochs: [
      { epochNumber: 17, depositStart: "2026-08-17", activeStart: "2026-08-18", settlementDate: "2026-09-17", strike: 58000, expiryDays: 30, premiumCollected: 0.012, outcome: "expired_worthless", pnlPct: 0.011 },
      { epochNumber: 16, depositStart: "2026-07-17", activeStart: "2026-07-18", settlementDate: "2026-08-17", strike: 55000, expiryDays: 30, premiumCollected: 0.014, outcome: "expired_worthless", pnlPct: 0.013 },
    ],
    userPosition: null,
    emergencyExit: {
      conditionsMet: false,
      activeTriggers: [],
      penaltyBps: 200,
      snapshotNavPerShare: 1.088,
      remainingCapacityShares: 170036,
    },
  },
];

export async function fetchVaults(): Promise<VaultSummary[]> {
  return MOCK_VAULTS.map(({ historicalEpochs: _h, userPosition: _u, emergencyExit: _e, ...summary }) => summary);
}

export async function fetchVaultDetail(id: string): Promise<VaultDetail | null> {
  return MOCK_VAULTS.find((v) => v.id === id) ?? null;
}
