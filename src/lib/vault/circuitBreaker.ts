/**
 * Vault Drawdown Circuit Breakers (#256)
 *
 * Defines the thresholds, state machine, and evaluation logic for automated
 * circuit breakers that halt a vault strategy without human intervention when
 * realized or mark-to-market losses breach configured thresholds.
 *
 * Architecture:
 *  - Pure evaluation functions (no side-effects) check current metrics against
 *    a BreakerConfig and return a BreakerDecision.
 *  - VaultBreakerState holds the current machine state and is persisted by the
 *    caller (zustand store / backend).
 *  - The recovery path is explicit: a halted vault must pass a ClearanceCheck
 *    before transitioning back to ACTIVE.
 *  - All logic is pure and unit-tested; I/O is the caller's responsibility.
 */

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type BreakerStatus =
  | "ACTIVE"    // normal operation, strategy may write new positions
  | "WARNED"    // first threshold breached; new positions are blocked
  | "HALTED"    // second threshold breached; strategy fully stopped
  | "RECOVERING"; // thresholds now clear; awaiting operator acknowledgement

/**
 * Reason codes surfaced in the UI and included in audit logs.
 * Each maps to a specific check in evaluateBreakers().
 */
export type BreakerTrigger =
  | "REALIZED_DRAWDOWN_WARN"   // realized P&L crossed warn threshold
  | "REALIZED_DRAWDOWN_HALT"   // realized P&L crossed halt threshold
  | "MTM_DRAWDOWN_WARN"        // mark-to-market drawdown crossed warn threshold
  | "MTM_DRAWDOWN_HALT"        // mark-to-market drawdown crossed halt threshold
  | "EPOCH_LOSS_WARN"          // single-epoch loss crossed warn threshold
  | "EPOCH_LOSS_HALT"          // single-epoch loss crossed halt threshold
  | "MANUAL_HALT"              // operator-initiated halt
  | "NONE";                    // no trigger

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Per-vault breaker configuration.  All threshold values are fractions of
 * the vault's high-water-mark NAV (e.g. 0.05 = 5%).
 *
 * Two-tier thresholds (warn < halt) allow the UI to surface an early
 * warning before positions are blocked.
 */
export interface BreakerConfig {
  /** Fraction of HWM NAV: realized losses trigger a warning above this. */
  realizedDrawdownWarn: number;
  /** Fraction of HWM NAV: realized losses halt the strategy above this. */
  realizedDrawdownHalt: number;
  /** Fraction of HWM NAV: MTM losses trigger a warning above this. */
  mtmDrawdownWarn: number;
  /** Fraction of HWM NAV: MTM losses halt the strategy above this. */
  mtmDrawdownHalt: number;
  /** Fraction of epoch starting NAV: single-epoch P&L triggers a warning. */
  epochLossWarn: number;
  /** Fraction of epoch starting NAV: single-epoch P&L halts the strategy. */
  epochLossHalt: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  realizedDrawdownWarn: 0.05,  // 5% of HWM
  realizedDrawdownHalt: 0.10,  // 10% of HWM
  mtmDrawdownWarn: 0.07,
  mtmDrawdownHalt: 0.15,
  epochLossWarn: 0.03,
  epochLossHalt: 0.08,
};

// ---------------------------------------------------------------------------
// Metrics input
// ---------------------------------------------------------------------------

/** Live metrics evaluated on every epoch tick and position update. */
export interface VaultBreakerMetrics {
  /** Current NAV per share (USD). */
  currentNav: number;
  /** High-water-mark NAV per share (USD). */
  hwmNav: number;
  /** NAV per share at the start of the current epoch (USD). */
  epochStartNav: number;
  /** Realized P&L for the current epoch (may be negative). */
  epochRealizedPnl: number;
  /** Mark-to-market P&L for open positions in the current epoch. */
  epochMtmPnl: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface VaultBreakerState {
  status: BreakerStatus;
  trigger: BreakerTrigger;
  /** ISO timestamp when the current status was entered. */
  since: string;
  /** ISO timestamp when recovering status was acknowledged (or null). */
  acknowledgedAt: string | null;
  /** Snapshot of the metrics that triggered the last transition. */
  triggeringMetrics: VaultBreakerMetrics | null;
}

export function initialBreakerState(): VaultBreakerState {
  return {
    status: "ACTIVE",
    trigger: "NONE",
    since: new Date().toISOString(),
    acknowledgedAt: null,
    triggeringMetrics: null,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface BreakerDecision {
  /** Recommended new status (may be same as current). */
  newStatus: BreakerStatus;
  trigger: BreakerTrigger;
  /** Human-readable description for the audit log / UI toast. */
  description: string;
}

/**
 * Pure function: given current metrics and config, returns the recommended
 * breaker status transition.  The caller is responsible for persisting the
 * new state and triggering halt side-effects (stop strategy, block deposits).
 *
 * Priority order: HALT > WARN.  Once HALTED or RECOVERING, only
 * `acknowledgeRecovery()` can transition back to ACTIVE.
 */
export function evaluateBreakers(
  metrics: VaultBreakerMetrics,
  config: BreakerConfig,
  currentStatus: BreakerStatus
): BreakerDecision {
  // Once halted, only an explicit operator ack can recover.
  if (currentStatus === "HALTED" || currentStatus === "RECOVERING") {
    return {
      newStatus: currentStatus,
      trigger: "NONE",
      description: "Vault is halted; awaiting operator acknowledgement.",
    };
  }

  const hwm = metrics.hwmNav;
  if (hwm <= 0) {
    // Degenerate case — can't compute meaningful drawdown.
    return { newStatus: currentStatus, trigger: "NONE", description: "HWM NAV is zero; skipping breaker check." };
  }

  const realizedDrawdown = -metrics.epochRealizedPnl / hwm;
  const mtmDrawdown = -(metrics.epochMtmPnl + metrics.epochRealizedPnl) / hwm;
  const epochStartNav = metrics.epochStartNav > 0 ? metrics.epochStartNav : hwm;
  const epochLoss = (epochStartNav - metrics.currentNav) / epochStartNav;

  // Check HALT conditions first (highest priority).
  if (realizedDrawdown >= config.realizedDrawdownHalt) {
    return {
      newStatus: "HALTED",
      trigger: "REALIZED_DRAWDOWN_HALT",
      description: `Realized drawdown ${(realizedDrawdown * 100).toFixed(2)}% exceeded halt threshold ${(config.realizedDrawdownHalt * 100).toFixed(2)}%.`,
    };
  }
  if (mtmDrawdown >= config.mtmDrawdownHalt) {
    return {
      newStatus: "HALTED",
      trigger: "MTM_DRAWDOWN_HALT",
      description: `MTM drawdown ${(mtmDrawdown * 100).toFixed(2)}% exceeded halt threshold ${(config.mtmDrawdownHalt * 100).toFixed(2)}%.`,
    };
  }
  if (epochLoss >= config.epochLossHalt) {
    return {
      newStatus: "HALTED",
      trigger: "EPOCH_LOSS_HALT",
      description: `Epoch loss ${(epochLoss * 100).toFixed(2)}% exceeded halt threshold ${(config.epochLossHalt * 100).toFixed(2)}%.`,
    };
  }

  // Check WARN conditions.
  if (realizedDrawdown >= config.realizedDrawdownWarn) {
    return {
      newStatus: "WARNED",
      trigger: "REALIZED_DRAWDOWN_WARN",
      description: `Realized drawdown ${(realizedDrawdown * 100).toFixed(2)}% exceeded warning threshold ${(config.realizedDrawdownWarn * 100).toFixed(2)}%.`,
    };
  }
  if (mtmDrawdown >= config.mtmDrawdownWarn) {
    return {
      newStatus: "WARNED",
      trigger: "MTM_DRAWDOWN_WARN",
      description: `MTM drawdown ${(mtmDrawdown * 100).toFixed(2)}% exceeded warning threshold ${(config.mtmDrawdownWarn * 100).toFixed(2)}%.`,
    };
  }
  if (epochLoss >= config.epochLossWarn) {
    return {
      newStatus: "WARNED",
      trigger: "EPOCH_LOSS_WARN",
      description: `Epoch loss ${(epochLoss * 100).toFixed(2)}% exceeded warning threshold ${(config.epochLossWarn * 100).toFixed(2)}%.`,
    };
  }

  return {
    newStatus: "ACTIVE",
    trigger: "NONE",
    description: "All metrics within thresholds.",
  };
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Apply an evaluated decision to the current state and return the new state.
 * Handles the ACTIVE → HALTED escalation without stepping through WARNED.
 */
export function applyBreakerDecision(
  state: VaultBreakerState,
  decision: BreakerDecision,
  metrics: VaultBreakerMetrics,
  now = new Date().toISOString()
): VaultBreakerState {
  if (decision.newStatus === state.status) return state;

  // ACTIVE → RECOVERING is not a valid transition via evaluation.
  // RECOVERING can only be entered by acknowledgeRecovery().
  return {
    status: decision.newStatus,
    trigger: decision.trigger,
    since: now,
    acknowledgedAt: null,
    triggeringMetrics: metrics,
  };
}

/**
 * Operator clears the halt after verifying that metrics are back within
 * thresholds.  Transitions HALTED → RECOVERING.
 *
 * @throws if the vault is not currently HALTED.
 */
export function initiateRecovery(
  state: VaultBreakerState,
  now = new Date().toISOString()
): VaultBreakerState {
  if (state.status !== "HALTED") {
    throw new Error(`Cannot initiate recovery from status "${state.status}"; vault must be HALTED.`);
  }
  return { ...state, status: "RECOVERING", since: now };
}

/**
 * Clears RECOVERING → ACTIVE after the operator has confirmed that metrics
 * are healthy and the strategy is safe to resume.
 *
 * @throws if the vault is not currently RECOVERING.
 */
export function acknowledgeRecovery(
  state: VaultBreakerState,
  now = new Date().toISOString()
): VaultBreakerState {
  if (state.status !== "RECOVERING") {
    throw new Error(`Cannot acknowledge recovery from status "${state.status}"; vault must be RECOVERING.`);
  }
  return {
    status: "ACTIVE",
    trigger: "NONE",
    since: now,
    acknowledgedAt: now,
    triggeringMetrics: null,
  };
}

/**
 * Manual operator halt (e.g. from the operator console).
 * Valid from ACTIVE or WARNED.
 */
export function manualHalt(
  state: VaultBreakerState,
  metrics: VaultBreakerMetrics,
  now = new Date().toISOString()
): VaultBreakerState {
  if (state.status === "HALTED" || state.status === "RECOVERING") {
    return state; // no-op
  }
  return {
    status: "HALTED",
    trigger: "MANUAL_HALT",
    since: now,
    acknowledgedAt: null,
    triggeringMetrics: metrics,
  };
}

// ---------------------------------------------------------------------------
// Guards (used by the UI and vault operation callers)
// ---------------------------------------------------------------------------

/** Returns true when the vault may write new positions. */
export function canWritePositions(state: VaultBreakerState): boolean {
  return state.status === "ACTIVE";
}

/** Returns true when new deposits should be blocked. */
export function depositsBlocked(state: VaultBreakerState): boolean {
  return state.status === "HALTED" || state.status === "RECOVERING";
}

/** Returns a short human-readable status label. */
export function breakerStatusLabel(status: BreakerStatus): string {
  switch (status) {
    case "ACTIVE": return "Active";
    case "WARNED": return "Warning";
    case "HALTED": return "Halted";
    case "RECOVERING": return "Recovering";
  }
}
