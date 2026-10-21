// Black-Scholes pricing shared by the options chain and portfolio pages.
// Mirrors the server-side engine in backend/src/main.rs closely enough for
// client-side previews; trades still settle against the on-chain price.

import { formatNumber, formatPrice, formatStrike } from "./format";
export interface Greeks {
  premium: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

export interface Market {
  sym: string;
  price: number;
  vol: number;
}

export interface Expiry {
  label: string;
  days: number;
}

export const MARKETS: Market[] = [
  { sym: "XLM", price: 0.1182, vol: 0.82 },
  { sym: "BTC", price: 67420.5, vol: 0.65 },
  { sym: "ETH", price: 3512.8, vol: 0.72 },
  { sym: "SOL", price: 182.45, vol: 0.91 },
];

export const EXPIRIES: Expiry[] = [
  { label: "7D", days: 7 },
  { label: "14D", days: 14 },
  { label: "30D", days: 30 },
  { label: "60D", days: 60 },
  { label: "90D", days: 90 },
  { label: "180D", days: 180 },
];

// Flat risk-free rate used by bs() below and by the lognormal terminal
// distribution in probability.ts — matches the backend's hardcoded r=0.05.
export const RISK_FREE_RATE = 0.05;

// Abramowitz–Stegun 26.2.17 approximation, |error| < 7.5e-8.
export function normCDF(x: number): number {
  if (x < -7) return 0;
  if (x > 7) return 1;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = k * (0.31938153 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  return x >= 0 ? 1 - pdf * p : pdf * p;
}

export function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function bs(S: number, K: number, vol: number, t: number, isCall: boolean): Greeks {
  if (t <= 0) {
    const p = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    return { premium: p, delta: isCall ? 1 : -1, gamma: 0, theta: 0, vega: 0, iv: vol };
  }
  const st = Math.sqrt(t);
  const r = RISK_FREE_RATE;
  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * t) / (vol * st);
  const d2 = d1 - vol * st;
  const disc = Math.exp(-r * t);
  const pdf = normPDF(d1);
  const premium = isCall
    ? S * normCDF(d1) - K * disc * normCDF(d2)
    : K * disc * normCDF(-d2) - S * normCDF(-d1);
  const delta = isCall ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = pdf / (S * vol * st);
  const theta = isCall
    ? (-(S * pdf * vol) / (2 * st) - r * K * disc * normCDF(d2)) / 365
    : (-(S * pdf * vol) / (2 * st) + r * K * disc * normCDF(-d2)) / 365;
  return { premium: Math.max(0, premium), delta, gamma, theta, vega: (S * pdf * st) / 100, iv: vol };
}

// Realistic crypto vol smile: left (put) skew, curvature, far-wing steepening.
export function smileVol(base: number, moneyness: number): number {
  return Math.max(
    0.1,
    base - 0.15 * (moneyness - 1) + 0.08 * (moneyness - 1) ** 2 +
      0.12 * Math.max(0, (Math.abs(moneyness - 1) - 0.15) ** 2)
  );
}

// Deterministic pseudo-random in [0, 1), seeded by a number. Used for display-only
// figures (mock vol/OI) that must render identically on the server and client —
// Math.random() during render causes React hydration mismatches.
export function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/**
 * Legacy magnitude-based helpers, kept as thin NaN/zero-safe wrappers over
 * `./format`. Prefer the instrument-aware formatters in `./format`.
 */
export const fmtN = (n: number, d = 4) =>
  !Number.isFinite(n) ? formatNumber(n, d) : Math.abs(n) > 0 && Math.abs(n) < 0.0001 ? n.toExponential(2) : formatNumber(n, d);

export const fmtSpot = (n: number) => (n >= 1000 ? formatPrice("BTC", n) : formatPrice("XLM", n));

export const fmtK = (n: number) => (n >= 1000 ? formatStrike("BTC", n) : formatStrike("XLM", n));

// ---------------------------------------------------------------------------
// Vault delta-hedging (issue #297)
//
// Per-vault hedging policy plus vault-level Greeks aggregation and the
// band-trigger / fail-safe logic that the keeper service drives. On-chain
// enforcement (max notional, kill switch, cadence) is authoritative; these
// helpers mirror it so the keeper and UI agree on what a hedge should be.
// ---------------------------------------------------------------------------

export type HedgeInstrument = "underlying" | "perp" | "futures";

export interface HedgePolicy {
  /** Master enable flag. When false the keeper performs zero hedge trades. */
  enabled: boolean;
  /** Hard kill switch — overrides `enabled` and blocks all hedge execution. */
  killSwitch: boolean;
  /** Desired portfolio delta (in underlying units). */
  targetDelta: number;
  /** Allowed drift around `targetDelta` before a rehedge is triggered. */
  tolerance: number;
  /** Venue used to place hedge orders. */
  instrument: HedgeInstrument;
  /** Absolute cap on hedge notional; enforced in-contract. */
  maxHedgeNotional: number;
  /** Minimum seconds between rehedges to rate-limit churn. */
  rehedgeIntervalSec: number;
}

export const DEFAULT_HEDGE_POLICY: HedgePolicy = {
  enabled: false,
  killSwitch: false,
  targetDelta: 0,
  tolerance: 0.1,
  instrument: "underlying",
  maxHedgeNotional: 0,
  rehedgeIntervalSec: 3600,
};

/** A single open written option position contributing to vault Greeks. */
export interface WrittenPosition {
  /** Signed contract quantity: negative for written (short) options. */
  qty: number;
  /** Contract multiplier (underlying units per contract). */
  multiplier: number;
  spot: number;
  strike: number;
  vol: number;
  /** Time to expiry in years. */
  t: number;
  isCall: boolean;
}

export interface VaultGreeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

/**
 * Aggregate vault-level Greeks from open written positions using the shared
 * Black-Scholes engine. Delta/gamma/vega/theta are summed in underlying units
 * (per-contract Greeks scaled by qty * multiplier).
 */
export function vaultGreeks(positions: WrittenPosition[]): VaultGreeks {
  const agg: VaultGreeks = { delta: 0, gamma: 0, vega: 0, theta: 0 };
  for (const p of positions) {
    if (!Number.isFinite(p.spot) || p.spot <= 0 || !Number.isFinite(p.vol) || p.vol <= 0) continue;
    const g = bs(p.spot, p.strike, p.vol, p.t, p.isCall);
    const scale = p.qty * p.multiplier;
    agg.delta += g.delta * scale;
    agg.gamma += g.gamma * scale;
    agg.vega += g.vega * scale;
    agg.theta += g.theta * scale;
  }
  return agg;
}

export interface HedgeDecision {
  /** Whether a hedge trade should be executed this cycle. */
  shouldHedge: boolean;
  /** Signed hedge size in underlying units (0 when no trade). */
  hedgeQty: number;
  /** Signed hedge notional in quote currency (0 when no trade). */
  hedgeNotional: number;
  /** Human-readable reason for the decision (for logs / analytics). */
  reason: string;
}

/**
 * Decide whether to rehedge given the current vault Greeks, policy, and the
 * last rehedge timestamp. Fails safe (no trade) on stale/missing prices, a
 * disabled policy, an engaged kill switch, or a cadence violation. The hedge
 * size is clamped to `maxHedgeNotional` so an off-chain bug cannot overshoot.
 */
export function evaluateHedge(
  greeks: VaultGreeks,
  policy: HedgePolicy,
  spot: number,
  nowSec: number,
  lastHedgeSec: number
): HedgeDecision {
  const none = (reason: string): HedgeDecision => ({ shouldHedge: false, hedgeQty: 0, hedgeNotional: 0, reason });

  if (!policy.enabled) return none("policy disabled");
  if (policy.killSwitch) return none("kill switch engaged");
  if (!Number.isFinite(spot) || spot <= 0) return none("stale or missing price feed");
  if (!Number.isFinite(greeks.delta)) return none("invalid greeks");
  if (nowSec - lastHedgeSec < policy.rehedgeIntervalSec) return none("rehedge cadence not elapsed");

  const drift = greeks.delta - policy.targetDelta;
  if (Math.abs(drift) <= policy.tolerance) return none("within delta band");

  // Hedge by trading against the drift to bring delta back to target.
  let hedgeQty = -drift;
  let hedgeNotional = Math.abs(hedgeQty) * spot;
  if (policy.maxHedgeNotional > 0 && hedgeNotional > policy.maxHedgeNotional) {
    const clamped = policy.maxHedgeNotional / spot;
    hedgeQty = Math.sign(hedgeQty) * clamped;
    hedgeNotional = policy.maxHedgeNotional;
  }

  return { shouldHedge: true, hedgeQty, hedgeNotional, reason: "delta breach" };
}
