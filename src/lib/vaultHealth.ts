/**
 * Vault Health Scoring Engine
 *
 * Computes a composite 0–100 health score for a vault from the data already
 * available in VaultSummary / VaultDetail. The score is used by depositors to
 * quickly assess a vault's safety, consistency, and efficiency before
 * committing funds.
 *
 * Factors and weights
 * ───────────────────
 * 1. Win rate           (25%) — share of historical epochs that expired
 *                               worthless (premium fully retained).
 * 2. Return consistency (20%) — inverse of the standard deviation of epoch
 *                               P&L percentages; lower variance → higher score.
 * 3. Drawdown control   (20%) — based on the worst single-epoch loss; smaller
 *                               max-drawdown → higher score.
 * 4. Strategy risk      (20%) — base score derived from the vault's inherent
 *                               strategy risk class (iron condor > covered call
 *                               > cash-secured put > wheel).
 * 5. Capacity headroom  (15%) — how far below full the vault is; a vault
 *                               approaching capacity is harder to enter/exit and
 *                               may compress future yields.
 *
 * Each factor is scored 0–100 independently, then the composite is the
 * weighted average. Factors with no data (e.g. no epoch history) fall back to
 * a neutral 50.
 *
 * Grade thresholds
 * ─────────────────
 *   A  ≥ 80    (strong health)
 *   B  ≥ 65    (above average)
 *   C  ≥ 50    (average — watch closely)
 *   D  ≥ 35    (below average — elevated risk)
 *   E  <  35   (poor health)
 */

import type { VaultStrategy, VaultSummary, EpochRecord } from "./api/vaults";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VaultGrade = "A" | "B" | "C" | "D" | "E";

export interface VaultFactorScore {
  /** Descriptive label for the UI. */
  label: string;
  /** Brief tooltip explaining what this factor measures. */
  description: string;
  /** 0–100. */
  score: number;
  /** Weight applied to compute the composite (0–1). */
  weight: number;
}

export interface VaultHealthScore {
  /** Composite score 0–100 (weighted average of factor scores). */
  composite: number;
  /** Letter grade derived from the composite score. */
  grade: VaultGrade;
  /** Individual factor breakdown for the health panel UI. */
  factors: {
    winRate: VaultFactorScore;
    returnConsistency: VaultFactorScore;
    drawdownControl: VaultFactorScore;
    strategyRisk: VaultFactorScore;
    capacityHeadroom: VaultFactorScore;
  };
}

// ---------------------------------------------------------------------------
// Factor weights — must sum to 1
// ---------------------------------------------------------------------------

const WEIGHTS = {
  winRate:          0.25,
  returnConsistency: 0.20,
  drawdownControl:   0.20,
  strategyRisk:      0.20,
  capacityHeadroom:  0.15,
} as const;

// ---------------------------------------------------------------------------
// Grade thresholds
// ---------------------------------------------------------------------------

const GRADE_THRESHOLDS: [number, VaultGrade][] = [
  [80, "A"],
  [65, "B"],
  [50, "C"],
  [35, "D"],
  [0,  "E"],
];

export function gradeFromScore(score: number): VaultGrade {
  for (const [threshold, grade] of GRADE_THRESHOLDS) {
    if (score >= threshold) return grade;
  }
  return "E";
}

// ---------------------------------------------------------------------------
// Factor 1: Win rate
// ---------------------------------------------------------------------------

/**
 * Score = win_rate × 100.
 * An epoch "wins" when it expires worthless (premium fully retained).
 * Exercised or active epochs are considered non-wins.
 */
export function winRateScore(epochs: EpochRecord[]): number {
  const settled = epochs.filter(e => e.outcome !== "active");
  if (settled.length === 0) return 50; // neutral when no history
  const wins = settled.filter(e => e.outcome === "expired_worthless").length;
  return (wins / settled.length) * 100;
}

// ---------------------------------------------------------------------------
// Factor 2: Return consistency
// ---------------------------------------------------------------------------

/**
 * Measures how stable epoch returns are.
 *
 * We compute the population standard deviation of pnlPct across settled epochs
 * and map it to a 0–100 score:
 *
 *   σ ≤ 0.005  → 100   (returns extremely tight)
 *   σ ≥ 0.08   →   0   (very wide spread — unreliable)
 *
 * Linear interpolation between those bounds.
 */
export function returnConsistencyScore(epochs: EpochRecord[]): number {
  const settled = epochs.filter(e => e.outcome !== "active");
  if (settled.length < 2) return 50;

  const pnls = settled.map(e => e.pnlPct);
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
  const sigma = Math.sqrt(variance);

  const LOW_SIGMA  = 0.005; // below → score 100
  const HIGH_SIGMA = 0.080; // above → score 0
  const clamped = Math.max(LOW_SIGMA, Math.min(HIGH_SIGMA, sigma));
  return ((HIGH_SIGMA - clamped) / (HIGH_SIGMA - LOW_SIGMA)) * 100;
}

// ---------------------------------------------------------------------------
// Factor 3: Drawdown control
// ---------------------------------------------------------------------------

/**
 * Score is based on the worst epoch loss (most negative pnlPct).
 *
 *   maxLoss = 0       → 100   (no losses at all)
 *   maxLoss ≥ -0.10   →   0   (−10% or worse epoch loss)
 *
 * Positive-only history (no losses) yields 100.
 */
export function drawdownControlScore(epochs: EpochRecord[]): number {
  const settled = epochs.filter(e => e.outcome !== "active");
  if (settled.length === 0) return 50;

  const worstPnl = Math.min(...settled.map(e => e.pnlPct));
  if (worstPnl >= 0) return 100; // no loss epoch on record

  const MAX_TOLERABLE_LOSS = -0.10; // −10%
  // clamped in [MAX_TOLERABLE_LOSS, 0]
  const clamped = Math.max(MAX_TOLERABLE_LOSS, worstPnl);
  // At clamped=0 → score 100; at clamped=MAX_TOLERABLE_LOSS → score 0
  return (1 - clamped / MAX_TOLERABLE_LOSS) * 100;
}

// ---------------------------------------------------------------------------
// Factor 4: Strategy risk
// ---------------------------------------------------------------------------

/**
 * Each strategy has an inherent risk profile. We assign a base score that
 * reflects the defined/undefined nature of risk and the typical magnitude of
 * adverse moves for depositors.
 *
 *   iron_condor       → 90 (limited-risk both ways; losses capped at spread width)
 *   covered_call      → 75 (defined; forfeits upside, no downside beyond holding)
 *   cash_secured_put  → 55 (defined; assignment risk = buying at strike)
 *   wheel             → 40 (high volatility harvesting; directional risk on assignment)
 */
const STRATEGY_RISK_SCORES: Record<VaultStrategy, number> = {
  iron_condor:      90,
  covered_call:     75,
  cash_secured_put: 55,
  wheel:            40,
};

export function strategyRiskScore(strategy: VaultStrategy): number {
  return STRATEGY_RISK_SCORES[strategy] ?? 50;
}

// ---------------------------------------------------------------------------
// Factor 5: Capacity headroom
// ---------------------------------------------------------------------------

/**
 * A vault approaching its capacity ceiling is harder to enter (less liquidity)
 * and may see compressed future yields as deploying capital becomes harder.
 *
 *   utilization ≤ 0.50 → 100  (plenty of room)
 *   utilization ≥ 0.95 →   0  (essentially full)
 */
export function capacityHeadroomScore(tvl: number, capacity: number): number {
  if (capacity <= 0) return 50;
  const utilization = Math.min(1, tvl / capacity);
  const LOW_UTIL  = 0.50;
  const HIGH_UTIL = 0.95;
  if (utilization <= LOW_UTIL)  return 100;
  if (utilization >= HIGH_UTIL) return 0;
  return ((HIGH_UTIL - utilization) / (HIGH_UTIL - LOW_UTIL)) * 100;
}

// ---------------------------------------------------------------------------
// Composite scorer
// ---------------------------------------------------------------------------

/**
 * Compute the full health score for a vault.
 *
 * @param summary - The VaultSummary fields (always available on listing page).
 * @param epochs  - Historical epoch records; omit or pass [] when not available.
 */
export function computeVaultHealthScore(
  summary: Pick<VaultSummary, "strategy" | "tvl" | "capacity">,
  epochs: EpochRecord[] = []
): VaultHealthScore {
  const wr   = winRateScore(epochs);
  const rc   = returnConsistencyScore(epochs);
  const dd   = drawdownControlScore(epochs);
  const sr   = strategyRiskScore(summary.strategy);
  const ch   = capacityHeadroomScore(summary.tvl, summary.capacity);

  const composite =
    wr  * WEIGHTS.winRate +
    rc  * WEIGHTS.returnConsistency +
    dd  * WEIGHTS.drawdownControl +
    sr  * WEIGHTS.strategyRisk +
    ch  * WEIGHTS.capacityHeadroom;

  const rounded = Math.round(composite);

  return {
    composite: rounded,
    grade: gradeFromScore(rounded),
    factors: {
      winRate: {
        label: "Win Rate",
        description: "Share of historical epochs where the option expired worthless and depositors kept the full premium.",
        score: Math.round(wr),
        weight: WEIGHTS.winRate,
      },
      returnConsistency: {
        label: "Return Consistency",
        description: "Inverse of epoch-return volatility. Low variance means depositors can plan around more predictable yields.",
        score: Math.round(rc),
        weight: WEIGHTS.returnConsistency,
      },
      drawdownControl: {
        label: "Drawdown Control",
        description: "Based on the worst single-epoch loss on record. Smaller maximum drawdowns indicate better risk management.",
        score: Math.round(dd),
        weight: WEIGHTS.drawdownControl,
      },
      strategyRisk: {
        label: "Strategy Risk Profile",
        description: "Inherent risk class of the vault's strategy. Limited-risk structures (iron condor) score higher than directional strategies (wheel).",
        score: Math.round(sr),
        weight: WEIGHTS.strategyRisk,
      },
      capacityHeadroom: {
        label: "Capacity Headroom",
        description: "How far the vault is from its maximum TVL. Vaults nearing capacity may have reduced liquidity and lower future yields.",
        score: Math.round(ch),
        weight: WEIGHTS.capacityHeadroom,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers for the UI
// ---------------------------------------------------------------------------

/** CSS variable name for the grade colour (matches the project's design tokens). */
export function gradeColor(grade: VaultGrade): string {
  switch (grade) {
    case "A": return "var(--call)";       // green
    case "B": return "var(--call-dim)";   // muted green — swap to --brand for blue if preferred
    case "C": return "var(--atm)";        // yellow/amber
    case "D": return "var(--put-dim)";    // muted red
    case "E": return "var(--put)";        // red
  }
}

/** Solid background tint for badge/panel backgrounds. */
export function gradeBg(grade: VaultGrade): string {
  switch (grade) {
    case "A": return "var(--call-dim)";
    case "B": return "var(--call-dim)";
    case "C": return "var(--atm-dim)";
    case "D": return "var(--put-dim)";
    case "E": return "var(--put-dim)";
  }
}

/** One-line plain-language summary of the health grade for screen readers and tooltips. */
export function gradeLabel(grade: VaultGrade): string {
  switch (grade) {
    case "A": return "Strong health — consistent performance and low risk";
    case "B": return "Above-average health — solid track record with modest risk";
    case "C": return "Average health — watch for volatility and strategy risk";
    case "D": return "Below-average health — elevated risk, consider carefully";
    case "E": return "Poor health — high risk factors present";
  }
}
