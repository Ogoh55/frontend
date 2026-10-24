/**
 * Vault Share Lockups, Vesting, and Early-Exit Penalty Schedules (#246)
 *
 * Provides the contract logic, redemption-queue interaction, and the
 * data model needed for a vault to enforce optional share lockups with
 * configurable vesting and an early-exit penalty that protects
 * long-term LPs from epoch-timing arbitrage.
 *
 * Design
 * ------
 *  - A `LockupSchedule` is configured per vault (or per deposit cohort).
 *  - Each deposit is tracked as a `LockedPosition` that carries its own
 *    unlock timeline.
 *  - `vestingFraction(position, now)` returns the fraction of shares that
 *    are unlocked at any given time (0–1).
 *  - `earlyExitPenalty(position, shares, now)` computes the fee due when
 *    a depositor redeems before their lockup has fully elapsed.
 *  - `processRedemptionWithLockup` is the gate that the withdrawal queue
 *    must call before processing a `WithdrawalRequest`; it returns the
 *    adjusted share count and penalty.
 *  - All functions are pure (no I/O); state lives in the store the caller
 *    manages.
 *
 * Vesting models
 * --------------
 *  - `cliff`:   0 % until cliff epoch, then 100 % instantly.
 *  - `linear`:  pro-rata over `durationEpochs` starting from `startEpoch`.
 *  - `graded`:  custom per-epoch tranches (must sum to 1).
 *
 * Penalty model
 * -------------
 *  - Flat basis-point deduction on the pro-rata redeemable value of the
 *    early-exiting shares. The penalty is taken as shares, not as assets,
 *    so the vault NAV is unaffected; the penalty shares are redistributed
 *    to remaining LPs by burning them (reducing totalShares → raising NAV
 *    per share).
 */

// ---------------------------------------------------------------------------
// Vesting schedule
// ---------------------------------------------------------------------------

export type VestingModel = "cliff" | "linear" | "graded";

export interface GradedTranche {
  /** The epoch number (inclusive) at which this tranche becomes unlocked. */
  atEpoch: number;
  /** Fraction unlocked at this tranche, in basis points (e.g. 2500 = 25%). Sum must equal 10_000. */
  fractionBps: number;
}

/**
 * Per-vault lockup schedule. Applied to all deposits unless the vault
 * is configured for per-deposit cohort overrides.
 */
export interface LockupSchedule {
  vaultId: string;
  /** Epoch from which the lockup begins. Deposits made in earlier epochs carry no lockup. */
  effectiveFromEpoch: number;
  vestingModel: VestingModel;
  /** Cliff / linear: epoch at which the full unlock (cliff) or start of vesting (linear) begins. */
  cliffEpoch: number;
  /** Linear / graded: total epochs over which vesting completes. */
  durationEpochs: number;
  /** Graded model: ordered list of tranches. Must sum to 10_000 bps. */
  tranches: GradedTranche[];
  /** Early-exit penalty in basis points of the redeemable share value. */
  earlyExitPenaltyBps: number;
  /** Whether this schedule is currently active. Deactivating it does NOT retroactively remove locks. */
  active: boolean;
}

export const MAX_PENALTY_BPS = 3_000; // 30% hard cap

export function validateLockupSchedule(s: LockupSchedule): string[] {
  const errors: string[] = [];
  if (s.earlyExitPenaltyBps < 0 || s.earlyExitPenaltyBps > MAX_PENALTY_BPS) {
    errors.push(`earlyExitPenaltyBps must be 0–${MAX_PENALTY_BPS}, got ${s.earlyExitPenaltyBps}`);
  }
  if (s.vestingModel === "graded") {
    const sum = s.tranches.reduce((acc, t) => acc + t.fractionBps, 0);
    if (sum !== 10_000) {
      errors.push(`Graded tranches must sum to 10,000 bps, got ${sum}`);
    }
    for (let i = 1; i < s.tranches.length; i++) {
      if (s.tranches[i].atEpoch <= s.tranches[i - 1].atEpoch) {
        errors.push(`Graded tranches must be in strictly ascending epoch order`);
        break;
      }
    }
  }
  if (s.vestingModel === "linear" && s.durationEpochs <= 0) {
    errors.push("linear durationEpochs must be positive");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Locked position
// ---------------------------------------------------------------------------

/**
 * One depositor's locked share position.  Created at deposit time and
 * carried until all shares are redeemed.
 */
export interface LockedPosition {
  positionId: string;
  vaultId: string;
  depositorAddress: string;
  /** Epoch in which the deposit was made. */
  depositEpoch: number;
  /** ISO timestamp of the deposit. */
  depositedAt: string;
  /** Original shares minted on this deposit. */
  originalShares: bigint;
  /** Shares remaining (original minus any redeemed). */
  remainingShares: bigint;
  /** ID of the `LockupSchedule` governing this position. */
  scheduleId: string;
  /** Total penalty shares burned so far on early exits from this position. */
  totalPenaltySharesBurned: bigint;
}

export function createLockedPosition(
  positionId: string,
  vaultId: string,
  depositorAddress: string,
  depositEpoch: number,
  depositedAt: string,
  shares: bigint,
  scheduleId: string
): LockedPosition {
  if (shares <= 0n) throw new Error("Shares must be positive");
  return {
    positionId,
    vaultId,
    depositorAddress,
    depositEpoch,
    depositedAt,
    originalShares: shares,
    remainingShares: shares,
    scheduleId,
    totalPenaltySharesBurned: 0n,
  };
}

// ---------------------------------------------------------------------------
// Vesting fraction
// ---------------------------------------------------------------------------

/**
 * Returns the fraction of shares that are unlocked at `currentEpoch`,
 * expressed as a value in [0, 1].
 *
 * Deposits made before `schedule.effectiveFromEpoch` are always fully
 * unlocked (returns 1.0).
 */
export function vestingFraction(
  position: LockedPosition,
  schedule: LockupSchedule,
  currentEpoch: number
): number {
  // Positions predating the schedule are unaffected.
  if (position.depositEpoch < schedule.effectiveFromEpoch) return 1;

  const elapsed = currentEpoch - position.depositEpoch;
  if (elapsed < 0) return 0;

  switch (schedule.vestingModel) {
    case "cliff": {
      const cliffElapsed = schedule.cliffEpoch - position.depositEpoch;
      return elapsed >= cliffElapsed ? 1 : 0;
    }

    case "linear": {
      const start = schedule.cliffEpoch - position.depositEpoch;
      if (elapsed < start) return 0;
      const progress = elapsed - start;
      return Math.min(1, progress / schedule.durationEpochs);
    }

    case "graded": {
      let unlocked = 0;
      for (const tranche of schedule.tranches) {
        const trancheElapsed = tranche.atEpoch - position.depositEpoch;
        if (elapsed >= trancheElapsed) {
          unlocked += tranche.fractionBps;
        }
      }
      return Math.min(1, unlocked / 10_000);
    }
  }
}

/**
 * Number of shares that are unlocked for `position` at `currentEpoch`.
 * Floors to the nearest whole share (integer).
 */
export function unlockedShares(
  position: LockedPosition,
  schedule: LockupSchedule,
  currentEpoch: number
): bigint {
  const fraction = vestingFraction(position, schedule, currentEpoch);
  if (fraction >= 1) return position.remainingShares;
  if (fraction <= 0) return 0n;
  // Multiply by 1e9 for precision, then floor
  return (position.remainingShares * BigInt(Math.floor(fraction * 1e9))) / 1_000_000_000n;
}

/**
 * Number of shares that are still locked (i.e. redeemable only with penalty).
 */
export function lockedShares(
  position: LockedPosition,
  schedule: LockupSchedule,
  currentEpoch: number
): bigint {
  return position.remainingShares - unlockedShares(position, schedule, currentEpoch);
}

// ---------------------------------------------------------------------------
// Early-exit penalty
// ---------------------------------------------------------------------------

/**
 * Computes the early-exit penalty for redeeming `requestedShares` from
 * `position` at `currentEpoch`.
 *
 * The penalty is assessed only on shares that are still inside their
 * lock window. The penalty is expressed in shares (not assets) so the
 * caller can burn them from `totalShares` to redistribute the value to
 * remaining LPs.
 *
 * Returns:
 *  - `penaltyShares`: shares to burn as the penalty fee.
 *  - `netShares`: shares the depositor actually receives (`requestedShares - penaltyShares`).
 *  - `unlockedConsumed`: how many of the requested shares were from the unlocked tranche (no penalty).
 *  - `lockedConsumed`: how many of the requested shares were from the locked tranche (subject to penalty).
 */
export interface PenaltyCalculation {
  penaltyShares: bigint;
  netShares: bigint;
  unlockedConsumed: bigint;
  lockedConsumed: bigint;
  penaltyBps: number;
}

export function earlyExitPenalty(
  position: LockedPosition,
  schedule: LockupSchedule,
  currentEpoch: number,
  requestedShares: bigint
): PenaltyCalculation {
  if (requestedShares <= 0n) throw new Error("requestedShares must be positive");
  if (requestedShares > position.remainingShares) {
    throw new Error(
      `Cannot redeem ${requestedShares} shares; only ${position.remainingShares} remaining`
    );
  }

  const unlocked = unlockedShares(position, schedule, currentEpoch);
  const unlockedConsumed = requestedShares <= unlocked ? requestedShares : unlocked;
  const lockedConsumed = requestedShares - unlockedConsumed;

  // Penalty only on the locked portion
  const penaltyShares =
    (lockedConsumed * BigInt(schedule.earlyExitPenaltyBps)) / 10_000n;
  const netShares = requestedShares - penaltyShares;

  return {
    penaltyShares,
    netShares,
    unlockedConsumed,
    lockedConsumed,
    penaltyBps: schedule.earlyExitPenaltyBps,
  };
}

// ---------------------------------------------------------------------------
// Redemption queue integration
// ---------------------------------------------------------------------------

/**
 * The result of processing a redemption request through the lockup gate.
 * The caller must:
 *  1. Burn `penaltyShares` from `totalShares` (NAV per share rises for LPs).
 *  2. Queue `netShares` in the withdrawal queue at the standard fill logic.
 *  3. Persist the updated `LockedPosition`.
 */
export interface RedemptionGateResult {
  originalRequestedShares: bigint;
  penaltyShares: bigint;
  netShares: bigint;
  updatedPosition: LockedPosition;
  gated: boolean;
  /** Human-readable reason for display / audit log. */
  description: string;
}

/**
 * Gate function called by the withdrawal queue before processing any
 * redemption. Returns an adjusted share count (after penalty) and the
 * penalty to burn.
 *
 * When `schedule` is `null` (no lockup active for this vault/cohort),
 * the request passes through without modification.
 */
export function processRedemptionWithLockup(
  position: LockedPosition,
  schedule: LockupSchedule | null,
  currentEpoch: number,
  requestedShares: bigint
): RedemptionGateResult {
  if (!schedule || !schedule.active) {
    const updated: LockedPosition = {
      ...position,
      remainingShares: position.remainingShares - requestedShares,
    };
    return {
      originalRequestedShares: requestedShares,
      penaltyShares: 0n,
      netShares: requestedShares,
      updatedPosition: updated,
      gated: false,
      description: "No active lockup schedule; full redemption permitted.",
    };
  }

  const calc = earlyExitPenalty(position, schedule, currentEpoch, requestedShares);

  const updated: LockedPosition = {
    ...position,
    remainingShares: position.remainingShares - requestedShares,
    totalPenaltySharesBurned: position.totalPenaltySharesBurned + calc.penaltyShares,
  };

  const isEarlyExit = calc.lockedConsumed > 0n;
  const description = isEarlyExit
    ? `Early exit: ${calc.lockedConsumed} locked shares redeemed; penalty = ${calc.penaltyShares} shares (${schedule.earlyExitPenaltyBps} bps). Net: ${calc.netShares} shares queued.`
    : `Full redemption within unlocked tranche; no penalty applied.`;

  return {
    originalRequestedShares: requestedShares,
    penaltyShares: calc.penaltyShares,
    netShares: calc.netShares,
    updatedPosition: updated,
    gated: isEarlyExit,
    description,
  };
}

// ---------------------------------------------------------------------------
// Depositor lockup summary (UI helpers)
// ---------------------------------------------------------------------------

export interface LockupSummary {
  positionId: string;
  vaultId: string;
  totalShares: bigint;
  unlockedShares: bigint;
  lockedShares: bigint;
  vestingPct: number;
  /** Epoch at which the position will be 100% unlocked. Null for graded with partial completion. */
  fullUnlockEpoch: number | null;
  penaltyBps: number;
  depositEpoch: number;
}

export function buildLockupSummary(
  position: LockedPosition,
  schedule: LockupSchedule,
  currentEpoch: number
): LockupSummary {
  const fraction = vestingFraction(position, schedule, currentEpoch);
  const unlocked = unlockedShares(position, schedule, currentEpoch);
  const locked = position.remainingShares - unlocked;

  let fullUnlockEpoch: number | null = null;
  if (schedule.vestingModel === "cliff") {
    fullUnlockEpoch = position.depositEpoch + (schedule.cliffEpoch - position.depositEpoch);
  } else if (schedule.vestingModel === "linear") {
    const start = schedule.cliffEpoch - position.depositEpoch;
    fullUnlockEpoch = position.depositEpoch + start + schedule.durationEpochs;
  } else if (schedule.vestingModel === "graded" && schedule.tranches.length > 0) {
    const last = schedule.tranches[schedule.tranches.length - 1];
    fullUnlockEpoch = last.atEpoch;
  }

  return {
    positionId: position.positionId,
    vaultId: position.vaultId,
    totalShares: position.remainingShares,
    unlockedShares: unlocked,
    lockedShares: locked,
    vestingPct: Math.round(fraction * 10_000) / 100,
    fullUnlockEpoch,
    penaltyBps: schedule.earlyExitPenaltyBps,
    depositEpoch: position.depositEpoch,
  };
}

// ---------------------------------------------------------------------------
// Penalty share burn accounting
// ---------------------------------------------------------------------------

/**
 * Apply the penalty burn to a vault's share state.  Reduces `totalShares`
 * by `penaltyShares`, which increases NAV-per-share for remaining LPs.
 *
 * This function works alongside `vaultShareLedger.ts` — the caller should
 * also call `accrueFees` before burning to avoid stale fee state.
 *
 * Returns the new `totalShares` and the computed NAV-per-share delta for
 * display purposes.
 */
export function applyPenaltyBurn(
  totalShares: bigint,
  nav: bigint,
  penaltyShares: bigint,
  scale: bigint = 10n ** 18n
): { totalShares: bigint; navPerShare: bigint; navPerShareDelta: bigint } {
  if (penaltyShares < 0n) throw new Error("penaltyShares cannot be negative");
  if (penaltyShares > totalShares) {
    throw new Error(`Cannot burn ${penaltyShares} penalty shares; only ${totalShares} outstanding`);
  }
  const prevPrice = totalShares > 0n ? (nav * scale) / totalShares : scale;
  const newTotalShares = totalShares - penaltyShares;
  const newPrice = newTotalShares > 0n ? (nav * scale) / newTotalShares : scale;
  return {
    totalShares: newTotalShares,
    navPerShare: newPrice,
    navPerShareDelta: newPrice - prevPrice,
  };
}
