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
// Vault-written position risk metrics (issue #279)
//
// Shared helper used by both the per-vault risk panel and the portfolio
// surface so the two agree. Per-position metrics are computed with the local
// Black-Scholes model above, then aggregated. A backend-provided Greek can
// override the local estimate via `overrides` without changing components.
//
// Methodology (also documented in docs/RISK_METRICS.md):
//   - Model: Black-Scholes with flat r = RISK_FREE_RATE, lognormal terminal
//     distribution, no dividends, no early exercise.
//   - Assignment probability = N(d2) for calls, N(-d2) for puts (risk-neutral
//     probability of finishing ITM).
//   - Max loss per written contract = (strike - premium) * notional for calls
//     (unbounded upside), (strike - premium) * notional for puts (spot -> 0).
//   - Breakeven = strike +/- premium for calls/puts respectively.
//   - Figures are modelled estimates, not guarantees.
// ---------------------------------------------------------------------------

// Minimum time-to-expiry (in years) used for Greeks so theta/gamma do not
// blow up as t -> 0. ~1 hour. Positions below this are flagged as clamped.
export const MIN_T_YEARS = 1 / (365 * 24);

// Spot older than this (ms) is treated as stale and metrics degrade to
// "unavailable" rather than rendering a nonsense number.
export const STALE_SPOT_MS = 5 * 60 * 1000;

export type OptionSide = "call" | "put";

export interface WrittenPosition {
  id: string;
  strategy: string;
  side: OptionSide;
  strike: number;
  /** Contracts written (positive). */
  qty: number;
  /** Notional in quote currency per contract (e.g. underlying units). */
  notional: number;
  /** Implied vol as a decimal (0.82 = 82%). */
  iv?: number;
  /** Time to expiry in years. */
  tYears?: number;
  /** Optional backend-provided Greek overrides. */
  overrides?: Partial<Pick<Greeks, "delta" | "gamma" | "vega" | "theta">>;
}

export interface RiskInputs {
  spot: number;
  /** Timestamp (ms) the spot was observed; used for staleness. */
  spotAsOf?: number;
  /** Reference "now" in ms; defaults to Date.now(). */
  now?: number;
}

export interface PositionRisk {
  id: string;
  strategy: string;
  side: OptionSide;
  strike: number;
  qty: number;
  notional: number;
  /** Modelled assignment probability (0..1), or null when unavailable. */
  assignmentProb: number | null;
  /** Modelled max loss in quote currency, or null when unavailable. */
  maxLoss: number | null;
  /** Breakeven spot price, or null when unavailable. */
  breakeven: number | null;
  /** Signed Greeks scaled by qty (short written => negated). */
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  /** True when t was clamped to MIN_T_YEARS for Greek stability. */
  clamped: boolean;
  /** Reason metrics are unavailable, if any. */
  unavailable?: string;
}

export interface StrategyBucket {
  strategy: string;
  count: number;
  notional: number;
}

export interface VaultRiskSummary {
  positions: PositionRisk[];
  byStrategy: StrategyBucket[];
  totals: {
    delta: number;
    gamma: number;
    vega: number;
    theta: number;
    maxLoss: number;
  };
  /** True if any position had a missing/stale input. */
  degraded: boolean;
  /** Human-readable reasons for degradation. */
  notes: string[];
}

function isFinitePositive(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Compute risk metrics for a single written position. Returns null-valued
 * metrics with an `unavailable` reason when inputs are missing or stale.
 */
export function positionRisk(pos: WrittenPosition, inputs: RiskInputs): PositionRisk {
  const base: PositionRisk = {
    id: pos.id,
    strategy: pos.strategy,
    side: pos.side,
    strike: pos.strike,
    qty: pos.qty,
    notional: pos.notional,
    assignmentProb: null,
    maxLoss: null,
    breakeven: null,
    delta: null,
    gamma: null,
    vega: null,
    theta: null,
    clamped: false,
  };

  const now = inputs.now ?? Date.now();
  if (!isFinitePositive(inputs.spot)) {
    return { ...base, unavailable: "spot price unavailable" };
  }
  if (inputs.spotAsOf != null && now - inputs.spotAsOf > STALE_SPOT_MS) {
    return { ...base, unavailable: "spot price stale" };
  }
  if (!isFinitePositive(pos.strike)) {
    return { ...base, unavailable: "strike unavailable" };
  }
  if (!isFinitePositive(pos.iv)) {
    return { ...base, unavailable: "implied vol unavailable" };
  }
  if (pos.tYears == null || !Number.isFinite(pos.tYears) || pos.tYears < 0) {
    return { ...base, unavailable: "time to expiry unavailable" };
  }

  const S = inputs.spot;
  const K = pos.strike;
  const vol = pos.iv;
  const isCall = pos.side === "call";
  const clamped = pos.tYears < MIN_T_YEARS;
  const t = clamped ? MIN_T_YEARS : pos.tYears;

  const g = bs(S, K, vol, t, isCall);
  const premium = g.premium;

  // Risk-neutral assignment probability = N(d2) for calls, N(-d2) for puts.
  const st = Math.sqrt(t);
  const d2 = (Math.log(S / K) + (RISK_FREE_RATE - 0.5 * vol * vol) * t) / (vol * st);
  const assignmentProb = isCall ? normCDF(d2) : normCDF(-d2);

  // Max loss per written contract. Calls: unbounded upside, modelled as
  // (strike - premium) per unit (spot -> infinity is unbounded; we report the
  // loss at the strike as the modelled floor and label as estimate). Puts:
  // spot -> 0, loss = (strike - premium) per unit.
  const maxLossPerUnit = Math.max(0, K - premium);
  const maxLoss = maxLossPerUnit * pos.qty * pos.notional;

  const breakeven = isCall ? K + premium : K - premium;

  // Written (short) positions: negate Greeks and scale by qty * notional.
  const scale = -pos.qty * pos.notional;
  const delta = pos.overrides?.delta ?? g.delta * scale;
  const gamma = pos.overrides?.gamma ?? g.gamma * scale;
  const vega = pos.overrides?.vega ?? g.vega * scale;
  const theta = pos.overrides?.theta ?? g.theta * scale;

  return {
    ...base,
    assignmentProb,
    maxLoss,
    breakeven,
    delta,
    gamma,
    vega,
    theta,
    clamped,
  };
}

/**
 * Aggregate per-position risk into a vault-level summary. Pure and memoizable;
 * callers should memoize on (positions, inputs) to avoid recomputation.
 */
export function aggregateVaultRisk(
  positions: WrittenPosition[],
  inputs: RiskInputs,
): VaultRiskSummary {
  const computed = positions.map((p) => positionRisk(p, inputs));

  const bucketMap = new Map<string, StrategyBucket>();
  for (const p of computed) {
    const b = bucketMap.get(p.strategy) ?? { strategy: p.strategy, count: 0, notional: 0 };
    b.count += 1;
    b.notional += p.notional * p.qty;
    bucketMap.set(p.strategy, b);
  }

  const totals = { delta: 0, gamma: 0, vega: 0, theta: 0, maxLoss: 0 };
  const notes: string[] = [];
  let degraded = false;
  for (const p of computed) {
    if (p.unavailable) {
      degraded = true;
      notes.push(`${p.id}: ${p.unavailable}`);
      continue;
    }
    if (p.clamped) {
      notes.push(`${p.id}: time to expiry clamped for Greek stability`);
    }
    totals.delta += p.delta ?? 0;
    totals.gamma += p.gamma ?? 0;
    totals.vega += p.vega ?? 0;
    totals.theta += p.theta ?? 0;
    totals.maxLoss += p.maxLoss ?? 0;
  }

  return {
    positions: computed,
    byStrategy: Array.from(bucketMap.values()),
    totals,
    degraded,
    notes,
  };
}
