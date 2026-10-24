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

/**
 * Reference for the epoch strike rule in docs/oracle-policy.md §4. Display and
 * reproduction only: the vault contract is the source of truth.
 *
 * Bisects for the call strike whose delta equals `targetDelta`, then snaps to
 * the nearest listed strike. Ties go to the higher strike. Returns null when
 * the inputs are out of range, so the caller can halt the epoch.
 */
export function selectStrike(
  spot: number,
  vol: number,
  days: number,
  targetDelta: number,
  listedStrikes: number[]
): number | null {
  if (!(spot > 0 && vol > 0 && days > 0 && targetDelta > 0 && targetDelta < 1)) return null;
  if (listedStrikes.length === 0) return null;
  const t = days / 365;
  // Delta falls as strike rises, so search upward when delta is still too high.
  let lo = spot * 0.01;
  let hi = spot * 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (bs(spot, mid, vol, t, true).delta > targetDelta) lo = mid;
    else hi = mid;
  }
  const target = (lo + hi) / 2;
  let best = listedStrikes[0];
  for (const k of listedStrikes) {
    const d = Math.abs(k - target);
    const bestD = Math.abs(best - target);
    if (d < bestD || (d === bestD && k > best)) best = k;
  }
  return best;
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

/**
 * Deposit and withdrawal pricing rule for option-writing vaults (issue #208).
 *
 * Economic rationale: a vault's NAV jumps when premium is credited and when
 * assignment losses are recognized at epoch close. If shares were priced
 * against realized NAV alone, a depositor entering just before a premium
 * credit would buy in cheap and collect the credit, and a holder exiting just
 * before a known loss would sell out rich. Both extract value from remaining
 * LPs at no risk.
 *
 * Rule:
 * - Pricing NAV includes premium accrued but not yet realized, and subtracts
 *   known-but-unrealized losses. A minter pays for its share of pending premium
 *   and a redeemer is charged for its share of pending losses, so the price
 *   already reflects what the epoch close will book. Excluding pending premium
 *   instead would dilute existing LPs on every mint, which is why this is the
 *   default and the only mode here.
 * - Deposits are closed for `cutoffLedgers` ledgers before the epoch close
 *   ledger. The close is bounded by ledger number, not wall-clock time, so a
 *   late or skipped ledger cannot stall the window open. Once the close ledger
 *   has passed, deposits reopen at the accrual-inclusive price, so an epoch
 *   that fails to close cannot lock deposits.
 * - Redemptions use the same pricing ledger as deposits, including queued
 *   withdrawals. A round trip inside one epoch therefore returns the deposit
 *   less only the configured early-exit fee.
 *
 * The vault contract is the source of truth. These helpers exist for display,
 * previews, and re-deriving historical share issuance from indexed events.
 */
export interface VaultPricingParams {
  // Deposits are blocked for this many ledgers before the epoch close ledger.
  cutoffLedgers: number;
  // Lots are redeemable only after this many epochs have closed since mint.
  minHoldEpochs: number;
  // Early-exit fee in basis points for a lot that has been held zero epochs.
  earlyExitFeeBps: number;
  // The fee decays linearly to zero over this many epochs.
  earlyExitFeeDecayEpochs: number;
}

// Placeholder defaults. Real values are set per vault through the governed
// parameter path, not by client code.
export const DEFAULT_PRICING_PARAMS: VaultPricingParams = {
  cutoffLedgers: 12,
  minHoldEpochs: 1,
  earlyExitFeeBps: 50,
  earlyExitFeeDecayEpochs: 3,
};

export interface VaultLedgerState {
  navUsd: number;
  accruedPremiumUsd: number;
  knownLossUsd: number;
  shareSupply: number;
}

/**
 * Returns the ledger sequence a deposit or withdrawal at `now` is priced
 * against, or null when deposits are closed by the pre-close cutoff.
 */
export function pricingLedgerSequence(
  now: number,
  epochCloseLedger: number,
  params: VaultPricingParams = DEFAULT_PRICING_PARAMS
): number | null {
  const cutoffStart = epochCloseLedger - params.cutoffLedgers;
  if (now >= cutoffStart && now < epochCloseLedger) return null;
  return now;
}

/**
 * Share price including accrued-but-unrealized premium and excluding known
 * losses. Returns null when no shares are outstanding.
 */
export function pricingNavPerShare(state: VaultLedgerState): number | null {
  if (!(state.shareSupply > 0)) return null;
  return (state.navUsd + state.accruedPremiumUsd - state.knownLossUsd) / state.shareSupply;
}

/**
 * Whether a lot minted `epochsHeld` epochs ago can be redeemed yet.
 */
export function isRedeemable(epochsHeld: number, params: VaultPricingParams = DEFAULT_PRICING_PARAMS): boolean {
  return epochsHeld >= params.minHoldEpochs;
}

/**
 * Early-exit fee in basis points for a lot held `epochsHeld` closed epochs.
 * Decays linearly to zero, so a holder who stays through the decay window
 * pays nothing.
 */
export function earlyExitFeeBps(epochsHeld: number, params: VaultPricingParams = DEFAULT_PRICING_PARAMS): number {
  if (epochsHeld >= params.earlyExitFeeDecayEpochs) return 0;
  const remaining = 1 - Math.max(0, epochsHeld) / params.earlyExitFeeDecayEpochs;
  return params.earlyExitFeeBps * remaining;
}
