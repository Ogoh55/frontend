/**
 * Typed data adapter for the Vaults feature.
 *
 * NEXT_PUBLIC_VAULTS=mock (the default) serves the in-module fixtures below.
 * NEXT_PUBLIC_VAULTS=live calls the v1 REST contract through the BFF, which
 * attaches the session bearer server-side (see src/lib/bff/allowlist.ts).
 *
 * Contract: docs/api/vaults-v1.openapi.yaml (frozen; additive changes only
 * within v1, breaking changes go to /api/v2).
 *
 *   GET  /api/v1/vaults                     → VaultSummary[]     (not paginated in v1)
 *   GET  /api/v1/vaults/{id}                → VaultDetail | 404
 *   POST /api/v1/vaults/{id}/deposit        { amount: Amount }   → { tx_id }
 *   POST /api/v1/vaults/{id}/withdraw       { shares: Amount }   → { tx_id, queued }
 *
 * Wire conventions: entity fields are camelCase; timestamps are ISO-8601;
 * USD amounts and share counts are fixed-point decimal strings (e.g. "1042.5000000")
 * and are converted to number only at the decode boundary for display.
 * Errors are `{ error: { code, message } }`; see VaultErrorCode.
 */

import { env } from "../../env";

/** Fixed-point decimal string on the wire, e.g. "1042.5000000". */
export type Amount = string;

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

export const VAULT_STRATEGIES: readonly VaultStrategy[] = ["covered_call", "cash_secured_put", "iron_condor", "wheel"];
export const RISK_RATINGS: readonly RiskRating[] = ["low", "medium", "high"];
export const EPOCH_PHASES: readonly EpochPhase[] = ["deposit", "active", "settlement"];

/**
 * Error codes in the v1 contract. `vault_paused` and `vault_at_capacity` are
 * both HTTP 409; the UI distinguishes them so it can say "paused" vs "full".
 * `malformed_response` is client-side only: the body failed decoding.
 */
export const VAULT_ERROR_CODES = [
  "vault_not_found",
  "vault_paused",
  "vault_at_capacity",
  "unauthorized",
  "invalid_request",
  "rate_limited",
  "backend_unavailable",
  "malformed_response",
] as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number];

export class VaultApiError extends Error {
  constructor(readonly status: number, readonly code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultApiError";
  }
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
      { epochNumber: 10, depositStart: "2026-08-25", activeStart: "2026-08-29", settlementDate: "2026-09-28", strike: 3100, expiryDays: 30, premiumCollected: 28, outcome: "expired_worthless", pnlPct: 0.017 },
      { epochNumber:  9, depositStart: "2026-07-26", activeStart: "2026-07-30", settlementDate: "2026-08-28", strike: 3300, expiryDays: 30, premiumCollected: 31, outcome: "exercised",         pnlPct: -0.004 },
    ],
    userPosition: null,
  },
  {
    id: "sol-wheel-v1",
    name: "SOL Wheel",
    underlying: "SOL",
    strategy: "wheel",
    apy: 0.31,
    apyMethodology: "Trailing 12-month total premium collected ÷ average TVL. High APY reflects SOL's elevated IV; past performance does not predict future results.",
    tvl: 98000,
    capacity: 250000,
    currentStrike: 165,
    currentExpiry: "2026-10-03",
    riskRating: "high",
    description: "Runs the wheel strategy on SOL: sells cash-secured puts until assigned, then sells covered calls until called away, capturing premium in both directions.",
    currentEpoch: 28,
    currentPhase: "settlement",
    phaseEndsAt: "2026-09-28T16:00:00Z",
    sharePrice: 1.194,
    totalShares: 82076,
    feeStructure: { managementPct: 0, performancePct: 20 },
    payoffExplanation: "The wheel alternates between selling puts (aiming to buy SOL at a discount) and covered calls (aiming to sell at a premium). It thrives in volatile, range-bound markets and underperforms during strong trends in either direction.",
    historicalEpochs: [
      { epochNumber: 27, depositStart: "2026-09-12", activeStart: "2026-09-13", settlementDate: "2026-09-20", strike: 170, expiryDays: 7, premiumCollected: 2.8, outcome: "expired_worthless", pnlPct: 0.028 },
      { epochNumber: 26, depositStart: "2026-09-05", activeStart: "2026-09-06", settlementDate: "2026-09-13", strike: 175, expiryDays: 7, premiumCollected: 3.2, outcome: "exercised",         pnlPct: 0.011 },
    ],
    userPosition: null,
  },
];

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Live transport and decoding (v1 contract)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const VAULTS_ROUTE = "/api/bff/api/v1/vaults";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const FIXED_POINT = /^-?\d+(\.\d+)?$/;

const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isDate = (x: unknown): x is string => isStr(x) && ISO_DATE.test(x);
const isDateTime = (x: unknown): x is string => isStr(x) && ISO_DATETIME.test(x);
const isAmount = (x: unknown): x is Amount => isStr(x) && FIXED_POINT.test(x);
const isOneOf = <T extends string>(values: readonly T[]) => (x: unknown): x is T =>
  isStr(x) && (values as readonly string[]).includes(x);
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

function malformed(route: string, field: string): VaultApiError {
  return new VaultApiError(200, "malformed_response", `Malformed vault response from ${route}: invalid "${field}"`);
}

function asObj(v: unknown, route: string): Obj {
  if (!isObj(v)) throw malformed(route, "(root)");
  return v;
}

function field<T>(o: Obj, key: string, route: string, ok: (x: unknown) => x is T): T {
  const x = o[key];
  if (!ok(x)) throw malformed(route, key);
  return x;
}

/** Amount fields arrive as fixed-point strings; numbers are for display only. */
const money = (o: Obj, key: string, route: string): number => Number(field(o, key, route, isAmount));

function decodeSummary(o: Obj, route: string): VaultSummary {
  return {
    id: field(o, "id", route, isStr),
    name: field(o, "name", route, isStr),
    underlying: field(o, "underlying", route, isStr),
    strategy: field(o, "strategy", route, isOneOf(VAULT_STRATEGIES)),
    apy: field(o, "apy", route, isNum),
    apyMethodology: field(o, "apyMethodology", route, isStr),
    tvl: money(o, "tvl", route),
    capacity: money(o, "capacity", route),
    currentStrike: money(o, "currentStrike", route),
    currentExpiry: field(o, "currentExpiry", route, isDate),
    riskRating: field(o, "riskRating", route, isOneOf(RISK_RATINGS)),
    description: field(o, "description", route, isStr),
  };
}

function decodeEpoch(v: unknown, route: string): EpochRecord {
  const o = asObj(v, route);
  return {
    epochNumber: field(o, "epochNumber", route, isNum),
    depositStart: field(o, "depositStart", route, isDate),
    activeStart: field(o, "activeStart", route, isDate),
    settlementDate: field(o, "settlementDate", route, isDate),
    strike: money(o, "strike", route),
    expiryDays: field(o, "expiryDays", route, isNum),
    premiumCollected: money(o, "premiumCollected", route),
    outcome: field(o, "outcome", route, isOneOf(["expired_worthless", "exercised", "active"] as const)),
    pnlPct: field(o, "pnlPct", route, isNum),
  };
}

function decodePosition(v: unknown, route: string): UserVaultPosition | null {
  if (v === null) return null;
  const o = asObj(v, route);
  return {
    shares: money(o, "shares", route),
    shareValue: money(o, "shareValue", route),
    totalValue: money(o, "totalValue", route),
    accruedPremium: money(o, "accruedPremium", route),
    pendingWithdrawal: money(o, "pendingWithdrawal", route),
  };
}

function decodeDetail(v: unknown, route: string): VaultDetail {
  const o = asObj(v, route);
  const fees = asObj(o.feeStructure, route);
  if (!Array.isArray(o.historicalEpochs)) throw malformed(route, "historicalEpochs");
  return {
    ...decodeSummary(o, route),
    currentEpoch: field(o, "currentEpoch", route, isNum),
    currentPhase: field(o, "currentPhase", route, isOneOf(EPOCH_PHASES)),
    phaseEndsAt: field(o, "phaseEndsAt", route, isDateTime),
    sharePrice: money(o, "sharePrice", route),
    totalShares: money(o, "totalShares", route),
    feeStructure: { managementPct: field(fees, "managementPct", route, isNum), performancePct: field(fees, "performancePct", route, isNum) },
    payoffExplanation: field(o, "payoffExplanation", route, isStr),
    historicalEpochs: o.historicalEpochs.map(e => decodeEpoch(e, route)),
    userPosition: decodePosition(o.userPosition, route),
  };
}

/** Maps a non-2xx response to a VaultApiError, preferring the server's code when it is one we know. */
function toApiError(status: number, body: unknown): VaultApiError {
  const err = isObj(body) ? body.error : undefined;
  const code = isObj(err) && isOneOf(VAULT_ERROR_CODES)(err.code) ? err.code : fallbackCode(status);
  const message = isObj(err) && isStr(err.message) ? err.message : `Vaults API request failed (${status})`;
  return new VaultApiError(status, code, message);
}

function fallbackCode(status: number): VaultErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "vault_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "backend_unavailable";
  return "invalid_request";
}

/** One request through the BFF. The session bearer is attached server-side; no token is sent from here. */
async function vaultRequest(route: string, init?: { method: "POST"; body: Obj }): Promise<unknown> {
  const url = `${VAULTS_ROUTE}${route}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: init ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new VaultApiError(0, "backend_unavailable", "Vaults API is unreachable");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, body);
  if (body === null) throw malformed(url, "(body)");
  return body;
}

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

export async function fetchVaults(): Promise<VaultSummary[]> {
  if (env.NEXT_PUBLIC_VAULTS === "live") {
    const body = await vaultRequest("/api/v1/vaults");
    if (!Array.isArray(body)) throw malformed("/api/v1/vaults", "(root)");
    return body.map(v => decodeSummary(asObj(v, "/api/v1/vaults"), "/api/v1/vaults"));
  }
  return Promise.resolve(MOCK_VAULTS.map(({ historicalEpochs, userPosition, ...summary }) => summary));
}

/** Resolves to null for an unknown id (live 404 or missing mock). */
export async function fetchVaultDetail(id: string): Promise<VaultDetail | null> {
  if (env.NEXT_PUBLIC_VAULTS === "live") {
    const route = `/api/v1/vaults/${encodeURIComponent(id)}`;
    try {
      return decodeDetail(await vaultRequest(route), route);
    } catch (e) {
      if (e instanceof VaultApiError && e.code === "vault_not_found") return null;
      throw e;
    }
  }
  return Promise.resolve(MOCK_VAULTS.find(v => v.id === id) ?? null);
}

/** `amount` is a fixed-point string in USD; the backend rejects anything else with invalid_request. */
export async function depositToVault(id: string, amount: Amount): Promise<{ tx_id: string }> {
  if (env.NEXT_PUBLIC_VAULTS === "live") {
    const route = `/api/v1/vaults/${encodeURIComponent(id)}/deposit`;
    const o = asObj(await vaultRequest(route, { method: "POST", body: { amount } }), route);
    return { tx_id: field(o, "tx_id", route, isStr) };
  }
  // Mock: simulate a 600ms network round-trip
  await new Promise(r => setTimeout(r, 600));
  return { tx_id: `mock-tx-deposit-${id}-${amount}-${Date.now()}` };
}

/** `shares` is a fixed-point string of share units. */
export async function withdrawFromVault(id: string, shares: Amount): Promise<{ tx_id: string; queued: boolean }> {
  if (env.NEXT_PUBLIC_VAULTS === "live") {
    const route = `/api/v1/vaults/${encodeURIComponent(id)}/withdraw`;
    const o = asObj(await vaultRequest(route, { method: "POST", body: { shares } }), route);
    return { tx_id: field(o, "tx_id", route, isStr), queued: field(o, "queued", route, (x): x is boolean => typeof x === "boolean") };
  }
  await new Promise(r => setTimeout(r, 600));
  return { tx_id: `mock-tx-withdraw-${id}-${shares}-${Date.now()}`, queued: true };
}
