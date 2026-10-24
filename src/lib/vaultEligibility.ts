/**
 * Vault Eligibility: Anti-Sybil Scoring & Reward-Farming Detection
 *
 * This module implements a fully client-side, pure-function eligibility
 * scoring engine for vault incentives. It is designed to be:
 *   - Unit-testable without DOM or network dependencies
 *   - Composable: each signal is its own function, combined by `scoreEligibility`
 *   - Transparent: every decision comes with a human-readable `reason`
 *
 * Anti-Sybil signals
 * ──────────────────
 * 1. Account age          — wallets created very recently are suspicious.
 * 2. On-chain activity    — low transaction counts indicate throwaway addresses.
 * 3. Minimum balance hold — wallets that deposit and immediately withdraw are
 *                           not providing real liquidity.
 * 4. Diversification      — accounts that only ever interact with one vault are
 *                           likely farming reward programs, not providing genuine yield.
 * 5. Single-block burst   — multiple vaults deposited into within the same ledger
 *                           (or within a few seconds) is a strong farming indicator.
 *
 * Reward-farming detection signals
 * ─────────────────────────────────
 * 1. Flash deposit        — deposit followed by withdrawal within MIN_HOLD_SECONDS
 * 2. Rapid recycling      — high deposit+withdraw frequency in a short rolling window
 * 3. Vault hopping        — depositing into N different vaults within VAULT_HOP_WINDOW_MS
 * 4. Round-trip velocity  — ratio of (withdrawals / deposits) exceeds threshold in window
 *
 * Composite score
 * ───────────────
 * Each signal contributes a weight to a 0–100 score.
 * Score ≥ ELIGIBLE_THRESHOLD   → eligible for incentives
 * Score ≥ REVIEW_THRESHOLD     → eligible but flagged for review
 * Score  < REVIEW_THRESHOLD    → ineligible (deposit allowed but no incentives)
 *
 * The `farmingRisk` enum is orthogonal: a high score can still carry a
 * farming-risk flag if the pattern matches known farming heuristics.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum wallet age in milliseconds for full age-score credit. */
export const MIN_WALLET_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Below this number of on-chain transactions, the activity score is penalised.
 * Genuinely new users should still be able to deposit; the penalty is partial.
 */
export const MIN_ACTIVITY_TXN_COUNT = 5;

/** Minimum time (ms) a deposit must be held before withdrawal for full hold score. */
export const MIN_HOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Window (ms) used for vault-hopping detection.
 * Depositing into > MAX_VAULTS_IN_WINDOW vaults within this window is suspicious.
 */
export const VAULT_HOP_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours
export const MAX_VAULTS_IN_HOP_WINDOW = 2;

/**
 * Rapid-recycling window: more than MAX_RECYCLES deposits+withdrawals within
 * this many milliseconds is a farming indicator.
 */
export const RECYCLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_RECYCLES_IN_WINDOW = 3;

/** Composite score thresholds. */
export const ELIGIBLE_THRESHOLD = 60;
export const REVIEW_THRESHOLD   = 40;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single deposit or withdrawal event recorded for a wallet. */
export interface VaultEvent {
  /** Unique vault ID this event belongs to. */
  vaultId: string;
  /** "deposit" | "withdraw" */
  type: "deposit" | "withdraw";
  /** Unix timestamp in milliseconds. */
  timestampMs: number;
  /** Amount in USD (or vault asset, treated as a scalar). */
  amount: number;
}

/** Summarised on-chain activity for the wallet. */
export interface WalletActivity {
  /** Unix timestamp (ms) when the wallet was first seen on-chain. */
  walletCreatedAtMs: number;
  /** Total number of on-chain transactions (all types). */
  totalTransactions: number;
  /**
   * Number of distinct contracts interacted with besides the vault.
   * Higher = more "real" user.
   */
  distinctContractInteractions: number;
}

/** Input to the eligibility scorer. */
export interface EligibilityInput {
  walletAddress: string;
  activity: WalletActivity;
  /** Full event history for this wallet across all vaults. */
  vaultEvents: VaultEvent[];
  /** The vault being deposited into right now. */
  targetVaultId: string;
  /** Current timestamp in milliseconds (injectable for testing). */
  nowMs: number;
}

/** Risk level for reward-farming detection. */
export type FarmingRiskLevel = "none" | "low" | "medium" | "high";

/** Result for a single scoring signal. */
export interface SignalResult {
  /** Human-readable signal name. */
  name: string;
  /** 0–100: the signal's contribution score (100 = perfect, 0 = worst). */
  score: number;
  /** Weight of this signal in the composite (0–1). */
  weight: number;
  /** Plain-language explanation surfaced to the user and auditors. */
  reason: string;
  /** Whether this specific signal failed the minimum bar. */
  flagged: boolean;
}

/** Full eligibility result. */
export interface EligibilityResult {
  /** Composite 0–100 eligibility score. */
  compositeScore: number;
  /** Whether the wallet is eligible for vault incentives. */
  eligible: boolean;
  /** Whether the wallet is eligible but flagged for manual review. */
  underReview: boolean;
  /** Farming risk classification (orthogonal to eligibility score). */
  farmingRisk: FarmingRiskLevel;
  /** Individual signal breakdown. */
  signals: SignalResult[];
  /** Summary message for display. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Signal weights — must sum to 1.0
// ---------------------------------------------------------------------------

const WEIGHTS = {
  accountAge:       0.25,
  onChainActivity:  0.20,
  holdDuration:     0.25,
  diversification:  0.15,
  recycleRate:      0.15,
} as const;

// ---------------------------------------------------------------------------
// Pure signal functions
// ---------------------------------------------------------------------------

/**
 * Signal 1: Account age.
 *
 * Scores how old the wallet is relative to MIN_WALLET_AGE_MS.
 * Scales linearly from 0 (brand-new) to 100 (age ≥ MIN_WALLET_AGE_MS).
 */
export function scoreAccountAge(
  activity: WalletActivity,
  nowMs: number,
): SignalResult {
  const ageMs = nowMs - activity.walletCreatedAtMs;
  const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
  const minDays = MIN_WALLET_AGE_MS / (24 * 60 * 60 * 1000);
  const score = Math.min(100, Math.max(0, (ageMs / MIN_WALLET_AGE_MS) * 100));

  const flagged = score < 50;
  const reason =
    score >= 100
      ? `Wallet is ${ageDays} days old — meets the ${minDays}-day minimum.`
      : score >= 50
      ? `Wallet is ${ageDays} days old (${minDays}-day minimum preferred, partial credit).`
      : `Wallet is only ${ageDays} days old. Newly created wallets receive reduced incentive eligibility.`;

  return { name: "Account Age", score: Math.round(score), weight: WEIGHTS.accountAge, reason, flagged };
}

/**
 * Signal 2: On-chain activity.
 *
 * Scores transaction volume and contract diversity. Low-activity wallets
 * are more likely to be created purely for reward farming.
 */
export function scoreOnChainActivity(
  activity: WalletActivity,
): SignalResult {
  const txScore = Math.min(100, (activity.totalTransactions / MIN_ACTIVITY_TXN_COUNT) * 100);
  // Bonus for diverse contract interactions (capped at 20 pts)
  const diversityBonus = Math.min(20, activity.distinctContractInteractions * 4);
  const score = Math.min(100, txScore + diversityBonus);

  const flagged = score < 40;
  const reason =
    activity.totalTransactions === 0
      ? "No on-chain transaction history found. This wallet has no prior activity."
      : activity.totalTransactions < MIN_ACTIVITY_TXN_COUNT
      ? `Only ${activity.totalTransactions} on-chain transaction${activity.totalTransactions === 1 ? "" : "s"} found. Wallets with limited history receive reduced eligibility.`
      : `${activity.totalTransactions} on-chain transactions with ${activity.distinctContractInteractions} distinct contract interactions.`;

  return { name: "On-Chain Activity", score: Math.round(score), weight: WEIGHTS.onChainActivity, reason, flagged };
}

/**
 * Signal 3: Hold duration.
 *
 * Examines past deposit/withdraw pairs for this wallet.
 * Short-duration rounds (deposit then quick withdrawal) reduce the score.
 * Returns a neutral 80 if there is no prior history (new depositor).
 */
export function scoreHoldDuration(
  vaultEvents: VaultEvent[],
  targetVaultId: string,
): SignalResult {
  const deposits = vaultEvents
    .filter(e => e.type === "deposit" && e.vaultId === targetVaultId)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const withdrawals = vaultEvents
    .filter(e => e.type === "withdraw" && e.vaultId === targetVaultId)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (deposits.length === 0) {
    return {
      name: "Hold Duration",
      score: 80,
      weight: WEIGHTS.holdDuration,
      reason: "No prior deposit history for this vault — neutral score applied.",
      flagged: false,
    };
  }

  // Match each deposit with its subsequent withdrawal (if any)
  const holdDurationsMs: number[] = [];
  for (const dep of deposits) {
    const matchedWithdraw = withdrawals.find(w => w.timestampMs > dep.timestampMs);
    if (matchedWithdraw) {
      holdDurationsMs.push(matchedWithdraw.timestampMs - dep.timestampMs);
    }
  }

  if (holdDurationsMs.length === 0) {
    // Deposits with no matched withdrawal: still holding — good signal
    return {
      name: "Hold Duration",
      score: 95,
      weight: WEIGHTS.holdDuration,
      reason: `${deposits.length} deposit${deposits.length === 1 ? "" : "s"} with no withdrawal yet — full hold score.`,
      flagged: false,
    };
  }

  const avgHoldMs = holdDurationsMs.reduce((s, v) => s + v, 0) / holdDurationsMs.length;
  const score = Math.min(100, Math.max(0, (avgHoldMs / MIN_HOLD_MS) * 100));
  const avgHoldHours = Math.round(avgHoldMs / (60 * 60 * 1000));
  const minHoldHours = MIN_HOLD_MS / (60 * 60 * 1000);

  const flagged = avgHoldMs < MIN_HOLD_MS / 2;
  const reason =
    score >= 100
      ? `Average hold duration is ${avgHoldHours}h — well above the ${minHoldHours}h threshold.`
      : score >= 50
      ? `Average hold duration is ${avgHoldHours}h (${minHoldHours}h preferred for full score).`
      : `Average hold duration is only ${avgHoldHours}h. Very short holds suggest liquidity recycling rather than genuine provision.`;

  return { name: "Hold Duration", score: Math.round(score), weight: WEIGHTS.holdDuration, reason, flagged };
}

/**
 * Signal 4: Vault diversification.
 *
 * Wallets that only interact with a single vault (especially one with active
 * incentives) are more likely to be farming programs than genuine depositors.
 * A wallet active in multiple vaults or other DeFi protocols receives a bonus.
 */
export function scoreDiversification(
  vaultEvents: VaultEvent[],
  targetVaultId: string,
): SignalResult {
  const allVaultIds = new Set(vaultEvents.map(e => e.vaultId));
  const otherVaultCount = [...allVaultIds].filter(id => id !== targetVaultId).length;

  // 0 other vaults → 60; 1 → 75; 2 → 88; 3+ → 100
  const scoreMap: Record<number, number> = { 0: 60, 1: 75, 2: 88 };
  const score = otherVaultCount >= 3 ? 100 : scoreMap[otherVaultCount] ?? 60;

  const flagged = otherVaultCount === 0 && vaultEvents.length > 3;
  const reason =
    otherVaultCount === 0
      ? `All vault activity is concentrated in this single vault. Diversified users receive a higher eligibility score.`
      : `Wallet has interacted with ${otherVaultCount} other vault${otherVaultCount === 1 ? "" : "s"}, indicating genuine protocol participation.`;

  return { name: "Vault Diversification", score, weight: WEIGHTS.diversification, reason, flagged };
}

/**
 * Signal 5: Recycle rate.
 *
 * Detects rapid deposit→withdraw cycling in a rolling RECYCLE_WINDOW_MS window.
 * Each round-trip within the window reduces the score.
 */
export function scoreRecycleRate(
  vaultEvents: VaultEvent[],
  nowMs: number,
): SignalResult {
  const windowStart = nowMs - RECYCLE_WINDOW_MS;
  const recentEvents = vaultEvents.filter(e => e.timestampMs >= windowStart);

  // Count vaults where both a deposit and withdrawal occurred within the window
  const vaultIds = new Set(recentEvents.map(e => e.vaultId));
  let roundTrips = 0;
  for (const vaultId of vaultIds) {
    const hasDeposit = recentEvents.some(e => e.vaultId === vaultId && e.type === "deposit");
    const hasWithdraw = recentEvents.some(e => e.vaultId === vaultId && e.type === "withdraw");
    if (hasDeposit && hasWithdraw) roundTrips++;
  }

  // 0 → 100, 1 → 70, 2 → 40, 3+ → 0
  const score = Math.max(0, 100 - roundTrips * 33);
  const windowDays = Math.round(RECYCLE_WINDOW_MS / (24 * 60 * 60 * 1000));

  const flagged = roundTrips >= MAX_RECYCLES_IN_WINDOW;
  const reason =
    roundTrips === 0
      ? `No deposit/withdrawal round-trips in the past ${windowDays} days.`
      : roundTrips === 1
      ? `1 deposit/withdrawal round-trip in the past ${windowDays} days — borderline.`
      : `${roundTrips} deposit/withdrawal round-trips in the past ${windowDays} days. This pattern is associated with reward farming.`;

  return { name: "Recycle Rate", score: Math.round(score), weight: WEIGHTS.recycleRate, reason, flagged };
}

// ---------------------------------------------------------------------------
// Farming-risk classifier (orthogonal to eligibility score)
// ---------------------------------------------------------------------------

/**
 * Classifies the farming risk level based on heuristic pattern matching.
 * This is intentionally separate from the composite score so that a wallet
 * can have a high eligibility score but still be flagged for a specific pattern.
 */
export function classifyFarmingRisk(
  input: EligibilityInput,
): { risk: FarmingRiskLevel; reasons: string[] } {
  const reasons: string[] = [];

  // 1. Flash deposit: last deposit immediately followed by a withdrawal
  const targetDeposits = input.vaultEvents
    .filter(e => e.vaultId === input.targetVaultId && e.type === "deposit")
    .sort((a, b) => b.timestampMs - a.timestampMs); // newest first

  if (targetDeposits.length > 0) {
    const lastDeposit = targetDeposits[0];
    const immediateWithdraw = input.vaultEvents.find(
      e =>
        e.vaultId === input.targetVaultId &&
        e.type === "withdraw" &&
        e.timestampMs > lastDeposit.timestampMs &&
        e.timestampMs - lastDeposit.timestampMs < MIN_HOLD_MS / 2,
    );
    if (immediateWithdraw) {
      const holdMins = Math.round(
        (immediateWithdraw.timestampMs - lastDeposit.timestampMs) / 60000,
      );
      reasons.push(`Flash deposit detected: last deposit was withdrawn after only ${holdMins} minutes.`);
    }
  }

  // 2. Vault hopping: deposits into multiple vaults within VAULT_HOP_WINDOW_MS
  const hopWindowStart = input.nowMs - VAULT_HOP_WINDOW_MS;
  const recentDeposits = input.vaultEvents.filter(
    e => e.type === "deposit" && e.timestampMs >= hopWindowStart,
  );
  const recentVaultIds = new Set(recentDeposits.map(e => e.vaultId));
  if (recentVaultIds.size > MAX_VAULTS_IN_HOP_WINDOW) {
    const windowHours = VAULT_HOP_WINDOW_MS / (60 * 60 * 1000);
    reasons.push(
      `Vault hopping: deposited into ${recentVaultIds.size} different vaults within ${windowHours}h.`,
    );
  }

  // 3. High round-trip velocity: many short-cycle events
  const windowStart = input.nowMs - RECYCLE_WINDOW_MS;
  const recentEvents = input.vaultEvents.filter(e => e.timestampMs >= windowStart);
  const vaultIdsInWindow = new Set(recentEvents.map(e => e.vaultId));
  let roundTrips = 0;
  for (const vaultId of vaultIdsInWindow) {
    const hasDeposit = recentEvents.some(
      e => e.vaultId === vaultId && e.type === "deposit",
    );
    const hasWithdraw = recentEvents.some(
      e => e.vaultId === vaultId && e.type === "withdraw",
    );
    if (hasDeposit && hasWithdraw) roundTrips++;
  }
  if (roundTrips >= MAX_RECYCLES_IN_WINDOW) {
    const windowDays = RECYCLE_WINDOW_MS / (24 * 60 * 60 * 1000);
    reasons.push(
      `High recycle velocity: ${roundTrips} round-trips across vaults in the past ${windowDays} days.`,
    );
  }

  // Classify
  const risk: FarmingRiskLevel =
    reasons.length === 0
      ? "none"
      : reasons.length === 1
      ? "low"
      : reasons.length === 2
      ? "medium"
      : "high";

  return { risk, reasons };
}

// ---------------------------------------------------------------------------
// Composite scorer
// ---------------------------------------------------------------------------

/**
 * Compute the full eligibility result for a wallet attempting to deposit.
 *
 * All inputs are plain data; no network calls, no side effects.
 */
export function scoreEligibility(input: EligibilityInput): EligibilityResult {
  const ageSig     = scoreAccountAge(input.activity, input.nowMs);
  const actSig     = scoreOnChainActivity(input.activity);
  const holdSig    = scoreHoldDuration(input.vaultEvents, input.targetVaultId);
  const divSig     = scoreDiversification(input.vaultEvents, input.targetVaultId);
  const recycleSig = scoreRecycleRate(input.vaultEvents, input.nowMs);

  const signals: SignalResult[] = [ageSig, actSig, holdSig, divSig, recycleSig];

  const compositeRaw =
    ageSig.score     * WEIGHTS.accountAge      +
    actSig.score     * WEIGHTS.onChainActivity +
    holdSig.score    * WEIGHTS.holdDuration    +
    divSig.score     * WEIGHTS.diversification +
    recycleSig.score * WEIGHTS.recycleRate;

  const compositeScore = Math.round(compositeRaw);

  const eligible    = compositeScore >= ELIGIBLE_THRESHOLD;
  const underReview = !eligible && compositeScore >= REVIEW_THRESHOLD;

  const { risk: farmingRisk, reasons: farmingReasons } =
    classifyFarmingRisk(input);

  const summary = buildSummary(compositeScore, eligible, underReview, farmingRisk, farmingReasons);

  return {
    compositeScore,
    eligible,
    underReview,
    farmingRisk,
    signals,
    summary,
  };
}

function buildSummary(
  score: number,
  eligible: boolean,
  underReview: boolean,
  farmingRisk: FarmingRiskLevel,
  farmingReasons: string[],
): string {
  if (eligible && farmingRisk === "none") {
    return `Eligible for vault incentives (score: ${score}/100).`;
  }

  if (eligible && farmingRisk !== "none") {
    return (
      `Eligible for incentives (score: ${score}/100), but flagged for reward-farming review. ` +
      farmingReasons[0]
    );
  }

  if (underReview) {
    return (
      `Eligibility under review (score: ${score}/100). ` +
      `Incentives will be applied after manual review.`
    );
  }

  return (
    `Not eligible for vault incentives at this time (score: ${score}/100). ` +
    `Continue participating in the protocol to improve your eligibility score.`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns whether the wallet passes the minimum bar for receiving
 * any vault incentives (eligible OR under review).
 */
export function canReceiveIncentives(result: EligibilityResult): boolean {
  return result.eligible || result.underReview;
}

/**
 * Returns a short user-facing status label.
 */
export function eligibilityStatusLabel(result: EligibilityResult): string {
  if (result.eligible && result.farmingRisk === "none") return "Eligible";
  if (result.eligible && result.farmingRisk !== "none") return "Eligible (flagged)";
  if (result.underReview) return "Under review";
  return "Ineligible";
}

/**
 * Returns a CSS variable name for the status colour.
 */
export function eligibilityStatusColor(result: EligibilityResult): string {
  if (result.eligible && result.farmingRisk === "none") return "var(--call)";
  if (result.eligible && result.farmingRisk !== "none") return "var(--atm)";
  if (result.underReview) return "var(--atm)";
  return "var(--put)";
}

/**
 * Returns a CSS variable name for a farming-risk badge colour.
 */
export function farmingRiskColor(risk: FarmingRiskLevel): string {
  switch (risk) {
    case "none":   return "var(--call)";
    case "low":    return "var(--atm)";
    case "medium": return "var(--put-dim)";
    case "high":   return "var(--put)";
  }
}
