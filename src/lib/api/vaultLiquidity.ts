/**
 * vaultLiquidity.ts — Issue #241
 *
 * Redemption liquidity management: cash buffer configuration and
 * just-in-time (JIT) position-unwind planning for the vault withdrawal queue.
 *
 * Concept
 * -------
 * Each vault keeps a configurable fraction of TVL as idle cash (the "cash
 * buffer").  When queued redemptions arrive, the engine first draws from the
 * buffer.  If the buffer is insufficient it builds a least-cost unwind plan —
 * ordered by liquidity, realised-loss, and proximity to expiry — and surfaces
 * it to the operator for review before execution.
 *
 * This module owns:
 *   1. `CashBufferConfig`         — per-vault buffer/policy settings
 *   2. `UnwindCandidate`          — a position eligible for unwind
 *   3. `buildUnwindPlan`          — ranks candidates by cost, returns a plan
 *   4. `evaluateLiquidityNeeds`   — compares buffer against queue, returns verdict
 *   5. Mock data + adapter functions for the UI
 */

// ---------------------------------------------------------------------------
// Types — buffer configuration
// ---------------------------------------------------------------------------

export type UnwindPriority = "least_loss" | "nearest_expiry" | "largest_notional";

export interface CashBufferConfig {
  /** Vault this config belongs to. */
  vaultId: string;
  /**
   * Target cash buffer as a fraction of TVL (e.g. 0.05 = 5%).
   * The vault aims to keep at least this much idle at epoch start.
   */
  targetBufferPct: number;
  /**
   * Hard minimum: if the buffer falls below this fraction an alert fires
   * and new deposits are paused until the buffer is replenished.
   */
  minBufferPct: number;
  /** Primary sort criterion when choosing which positions to unwind first. */
  unwindPriority: UnwindPriority;
  /**
   * Maximum slippage the unwind engine will accept before escalating to the
   * operator rather than executing automatically (0–1, e.g. 0.02 = 2%).
   */
  maxSlippagePct: number;
  /** Whether the JIT unwind may execute automatically or always requires
   *  operator sign-off. */
  requireOperatorApproval: boolean;
}

// ---------------------------------------------------------------------------
// Types — unwind candidates and plan
// ---------------------------------------------------------------------------

export type PositionType = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel_put" | "wheel_call";

export interface UnwindCandidate {
  positionId: string;
  positionType: PositionType;
  /** Underlying asset symbol, e.g. "XLM", "BTC". */
  underlying: string;
  /** Strike price in USD. */
  strike: number;
  /** ISO date of option expiry. */
  expiryDate: string;
  /** Days until expiry. */
  daysToExpiry: number;
  /** Notional value of the position in USD. */
  notionalUsd: number;
  /** Estimated USD proceeds if unwound at current mid-market. */
  proceedsUsd: number;
  /** Estimated realised loss vs. current mark (negative = loss). */
  realisedPnlUsd: number;
  /** Estimated bid-ask slippage as a fraction of notional (0–1). */
  estimatedSlippage: number;
  /** How easy it is to close this position (1 = easiest). */
  liquidityScore: number;
}

/** A single unwind step in the ranked plan. */
export interface UnwindStep {
  rank: number;
  candidate: UnwindCandidate;
  /** Cumulative cash unlocked after executing up to and including this step. */
  cumulativeProceedsUsd: number;
  /** Whether executing this step would satisfy the full redemption demand. */
  sufficientAtThisStep: boolean;
}

/** Full JIT unwind plan for a redemption batch. */
export interface UnwindPlan {
  vaultId: string;
  /** Total cash needed to satisfy all queued redemptions. */
  redemptionDemandUsd: number;
  /** Cash available in the buffer before any unwinds. */
  bufferAvailableUsd: number;
  /** Cash gap that must be covered by unwinds. */
  gapUsd: number;
  /** Ranked list of unwind steps needed to close the gap. */
  steps: UnwindStep[];
  /** True when the plan can cover the full demand within slippage limits. */
  feasible: boolean;
  /** Total realised loss from executing all steps in the plan. */
  totalRealisedLossUsd: number;
  /** Maximum single-step slippage in the plan. */
  maxStepSlippage: number;
  /** Whether operator approval is required before execution. */
  requiresApproval: boolean;
  /** ISO timestamp when the plan was computed. */
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Types — liquidity verdict
// ---------------------------------------------------------------------------

export type LiquidityStatus =
  | "healthy"      // buffer > target; no unwinds needed
  | "buffer_draw"  // buffer < target but can cover queue from buffer alone
  | "jit_needed"   // buffer insufficient; unwind plan must execute
  | "insufficient" // even with full unwind the demand cannot be met
  | "alert";       // buffer below hard minimum; halt deposits

export interface LiquidityNeedsResult {
  status: LiquidityStatus;
  bufferUsd: number;
  bufferPct: number;
  queuedRedemptionUsd: number;
  shortfallUsd: number;
  plan: UnwindPlan | null;
  /** Human summary for the operator dashboard. */
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Score a candidate for sorting: lower score = unwind first.
 * Weights: liquidity (highest), slippage, realised loss, expiry proximity.
 */
function candidateScore(c: UnwindCandidate, priority: UnwindPriority): number {
  switch (priority) {
    case "least_loss":
      // Primary: lowest realised loss; secondary: highest liquidity.
      return c.realisedPnlUsd * -1 + (1 - c.liquidityScore) * 1000;
    case "nearest_expiry":
      // Primary: shortest DTE so we close soon-to-expire positions first.
      return c.daysToExpiry * 100 + (1 - c.liquidityScore) * 10;
    case "largest_notional":
      // Primary: largest position first (closes the gap fastest).
      return -c.notionalUsd + (1 - c.liquidityScore) * 1000;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Build a JIT unwind plan: rank candidates by cost and greedily select until
 * the gap is covered or candidates are exhausted.
 */
export function buildUnwindPlan(
  vaultId: string,
  redemptionDemandUsd: number,
  bufferAvailableUsd: number,
  candidates: UnwindCandidate[],
  config: CashBufferConfig
): UnwindPlan {
  const gapUsd = Math.max(0, redemptionDemandUsd - bufferAvailableUsd);
  const computedAt = new Date().toISOString();

  if (gapUsd === 0) {
    return {
      vaultId, redemptionDemandUsd, bufferAvailableUsd, gapUsd,
      steps: [], feasible: true, totalRealisedLossUsd: 0,
      maxStepSlippage: 0, requiresApproval: false, computedAt,
    };
  }

  // Sort candidates by unwind priority score (ascending = cheapest first).
  const ranked = [...candidates].sort(
    (a, b) => candidateScore(a, config.unwindPriority) - candidateScore(b, config.unwindPriority)
  );

  const steps: UnwindStep[] = [];
  let covered = 0;
  let totalLoss = 0;
  let maxSlippage = 0;

  for (const candidate of ranked) {
    if (covered >= gapUsd) break;
    covered += candidate.proceedsUsd;
    totalLoss += Math.min(0, candidate.realisedPnlUsd);
    maxSlippage = Math.max(maxSlippage, candidate.estimatedSlippage);

    steps.push({
      rank: steps.length + 1,
      candidate,
      cumulativeProceedsUsd: covered,
      sufficientAtThisStep: covered >= gapUsd,
    });
  }

  const feasible = covered >= gapUsd;
  const requiresApproval =
    config.requireOperatorApproval || maxSlippage > config.maxSlippagePct;

  return {
    vaultId, redemptionDemandUsd, bufferAvailableUsd, gapUsd,
    steps, feasible,
    totalRealisedLossUsd: totalLoss,
    maxStepSlippage: maxSlippage,
    requiresApproval,
    computedAt,
  };
}

/**
 * Evaluate whether the vault's current cash buffer and position portfolio
 * can service the queued redemption demand.
 */
export function evaluateLiquidityNeeds(
  tvlUsd: number,
  bufferUsd: number,
  queuedRedemptionUsd: number,
  candidates: UnwindCandidate[],
  config: CashBufferConfig
): LiquidityNeedsResult {
  const bufferPct = tvlUsd > 0 ? bufferUsd / tvlUsd : 0;

  // Alert: buffer below hard minimum.
  if (bufferPct < config.minBufferPct) {
    return {
      status: "alert",
      bufferUsd, bufferPct, queuedRedemptionUsd,
      shortfallUsd: queuedRedemptionUsd,
      plan: null,
      message: `Cash buffer (${(bufferPct * 100).toFixed(1)}%) is below the hard minimum (${(config.minBufferPct * 100).toFixed(1)}%). New deposits paused.`,
    };
  }

  // Healthy: buffer exceeds target and covers the queue.
  if (bufferUsd >= queuedRedemptionUsd && bufferPct >= config.targetBufferPct) {
    return {
      status: "healthy",
      bufferUsd, bufferPct, queuedRedemptionUsd,
      shortfallUsd: 0,
      plan: null,
      message: `Buffer healthy at ${(bufferPct * 100).toFixed(1)}% TVL. Redemption queue fully covered by cash.`,
    };
  }

  // Buffer draw: below target but still sufficient for the queue.
  if (bufferUsd >= queuedRedemptionUsd) {
    return {
      status: "buffer_draw",
      bufferUsd, bufferPct, queuedRedemptionUsd,
      shortfallUsd: 0,
      plan: null,
      message: `Buffer at ${(bufferPct * 100).toFixed(1)}% TVL (below ${(config.targetBufferPct * 100).toFixed(1)}% target). Queue covered; replenish after epoch settlement.`,
    };
  }

  // JIT needed: build the unwind plan.
  const plan = buildUnwindPlan(
    config.vaultId,
    queuedRedemptionUsd,
    bufferUsd,
    candidates,
    config
  );

  if (!plan.feasible) {
    return {
      status: "insufficient",
      bufferUsd, bufferPct, queuedRedemptionUsd,
      shortfallUsd: queuedRedemptionUsd - bufferUsd - candidates.reduce((s, c) => s + c.proceedsUsd, 0),
      plan,
      message: `Insufficient liquidity: even a full portfolio unwind cannot satisfy redemption demand of $${queuedRedemptionUsd.toLocaleString()}. Operator intervention required.`,
    };
  }

  return {
    status: "jit_needed",
    bufferUsd, bufferPct, queuedRedemptionUsd,
    shortfallUsd: plan.gapUsd,
    plan,
    message: `JIT unwind required: ${plan.steps.length} position(s) must be closed to cover $${plan.gapUsd.toLocaleString()} shortfall. Est. loss: $${Math.abs(plan.totalRealisedLossUsd).toLocaleString()}.`,
  };
}

// ---------------------------------------------------------------------------
// Default configs and mock data
// ---------------------------------------------------------------------------

export const DEFAULT_CASH_BUFFER_CONFIGS: Record<string, CashBufferConfig> = {
  "xlm-cc-v1": {
    vaultId: "xlm-cc-v1",
    targetBufferPct: 0.05,
    minBufferPct: 0.02,
    unwindPriority: "least_loss",
    maxSlippagePct: 0.02,
    requireOperatorApproval: false,
  },
  "btc-csp-v1": {
    vaultId: "btc-csp-v1",
    targetBufferPct: 0.07,
    minBufferPct: 0.03,
    unwindPriority: "nearest_expiry",
    maxSlippagePct: 0.015,
    requireOperatorApproval: true,
  },
  "eth-ic-v1": {
    vaultId: "eth-ic-v1",
    targetBufferPct: 0.06,
    minBufferPct: 0.025,
    unwindPriority: "least_loss",
    maxSlippagePct: 0.02,
    requireOperatorApproval: false,
  },
  "sol-wheel-v1": {
    vaultId: "sol-wheel-v1",
    targetBufferPct: 0.08,
    minBufferPct: 0.04,
    unwindPriority: "largest_notional",
    maxSlippagePct: 0.025,
    requireOperatorApproval: true,
  },
};

const MOCK_CANDIDATES: Record<string, UnwindCandidate[]> = {
  "xlm-cc-v1": [
    {
      positionId: "xlm-cc-pos-001",
      positionType: "covered_call",
      underlying: "XLM",
      strike: 0.13,
      expiryDate: "2026-10-03",
      daysToExpiry: 10,
      notionalUsd: 18_400,
      proceedsUsd: 17_200,
      realisedPnlUsd: -1_200,
      estimatedSlippage: 0.008,
      liquidityScore: 0.82,
    },
    {
      positionId: "xlm-cc-pos-002",
      positionType: "covered_call",
      underlying: "XLM",
      strike: 0.135,
      expiryDate: "2026-10-10",
      daysToExpiry: 17,
      notionalUsd: 22_100,
      proceedsUsd: 21_400,
      realisedPnlUsd: -700,
      estimatedSlippage: 0.009,
      liquidityScore: 0.78,
    },
  ],
  "btc-csp-v1": [
    {
      positionId: "btc-csp-pos-001",
      positionType: "cash_secured_put",
      underlying: "BTC",
      strike: 60_000,
      expiryDate: "2026-10-03",
      daysToExpiry: 10,
      notionalUsd: 120_000,
      proceedsUsd: 116_000,
      realisedPnlUsd: -4_000,
      estimatedSlippage: 0.012,
      liquidityScore: 0.91,
    },
  ],
};

function defaultCandidates(): UnwindCandidate[] {
  return [];
}

// ---------------------------------------------------------------------------
// Async adapters (mock / live)
// ---------------------------------------------------------------------------

export async function fetchCashBufferConfig(vaultId: string): Promise<CashBufferConfig> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vaults/${vaultId}/liquidity/config`);
    if (!res.ok) throw new Error(`Failed to fetch buffer config (${res.status})`);
    return res.json() as Promise<CashBufferConfig>;
  }
  return Promise.resolve(
    DEFAULT_CASH_BUFFER_CONFIGS[vaultId] ?? {
      vaultId,
      targetBufferPct: 0.05,
      minBufferPct: 0.02,
      unwindPriority: "least_loss" as UnwindPriority,
      maxSlippagePct: 0.02,
      requireOperatorApproval: false,
    }
  );
}

export async function saveCashBufferConfig(config: CashBufferConfig): Promise<void> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vaults/${config.vaultId}/liquidity/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`Failed to save buffer config (${res.status})`);
    return;
  }
  DEFAULT_CASH_BUFFER_CONFIGS[config.vaultId] = config;
  await new Promise(r => setTimeout(r, 300));
}

export async function fetchUnwindCandidates(vaultId: string): Promise<UnwindCandidate[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vaults/${vaultId}/liquidity/candidates`);
    if (!res.ok) throw new Error(`Failed to fetch unwind candidates (${res.status})`);
    return res.json() as Promise<UnwindCandidate[]>;
  }
  return Promise.resolve(MOCK_CANDIDATES[vaultId] ?? defaultCandidates());
}

export async function fetchLiquidityStatus(
  vaultId: string,
  tvlUsd: number,
  bufferUsd: number,
  queuedRedemptionUsd: number
): Promise<LiquidityNeedsResult> {
  const [config, candidates] = await Promise.all([
    fetchCashBufferConfig(vaultId),
    fetchUnwindCandidates(vaultId),
  ]);
  return evaluateLiquidityNeeds(tvlUsd, bufferUsd, queuedRedemptionUsd, candidates, config);
}

export async function executeUnwindStep(
  vaultId: string,
  positionId: string,
  _token: string
): Promise<{ tx_id: string }> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vaults/${vaultId}/liquidity/unwind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionId }),
    });
    if (!res.ok) throw new Error(`Unwind execution failed (${res.status})`);
    return res.json() as Promise<{ tx_id: string }>;
  }
  await new Promise(r => setTimeout(r, 800));
  return { tx_id: `mock-tx-unwind-${positionId}-${Date.now()}` };
}
