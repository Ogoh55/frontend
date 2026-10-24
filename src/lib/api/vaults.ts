/**
 * Typed data adapter interface for the Vaults feature.
 *
 * The Phase 2 options vault contract is scaffolded under `contracts/vault`
 * (crate `zenith-options-vault`), but it is not yet deployed and the backend
 * API is not yet available. This module is unrelated to the margin-collateral
 * vault in `./vault.ts`. When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
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
 *   POST /api/v1/vaults/{id}/deposit   { amount: number; disclosure_version: string }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
 *
 *   GET /api/v1/vaults/{id}/epochs
 *   → VaultEpochLedgerEntry[]   (append-only, derived from on-chain epoch events)
 *
 *   POST /api/v1/vaults/disclosures/acknowledge
 *     { disclosure_version, text_hash, jurisdiction_attested }  → DisclosureAcknowledgement
 *   GET  /api/v1/vaults/disclosures/me  → DisclosureAcknowledgement[]
 *
 * Deposits are rejected server-side (403 with a PolicyReasonCode) unless the
 * wallet holds an acknowledgement for the current disclosure version. The
 * client check in the UI is advisory only.
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";
/** `full` is derived from TVL vs. capacity in `effectiveStatus`; the backend may also report it. */
export type VaultStatus = "open" | "paused" | "closed_to_deposits" | "full";

/**
 * Per-vault roles. Each vault is its own tenant boundary: a holder of a role
 * on one vault has no implicit authority over any other vault.
 *
 * - depositor: may deposit and withdraw/redeem
 * - operator: may set strategy parameters and roll epochs
 * - guardian: may pause new deposits and new epochs only (never unpause or change parameters)
 * - emergency_authority: protocol-level emergency authority, scoped to this vault
 */
export type VaultRole = "depositor" | "operator" | "guardian" | "emergency_authority";

/** One role assignment on a vault. */
export interface VaultRoleGrant {
  role: VaultRole;
  /** Account address of the role holder. */
  holder: string;
  /** ISO timestamp of when the role was granted. */
  grantedAt: string;
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
  status: VaultStatus;
  /** Epoch length (tenor) in days. */
  epochDays: number;
  /** Fees as whole percentages, e.g. performancePct: 10 = 10%. */
  feeStructure: { managementPct: number; performancePct: number };
  /** Worst peak-to-trough drawdown (0–1). Null until the vault has enough settled epochs. */
  maxDrawdownPct: number | null;
}

// ---------------------------------------------------------------------------
// Listing query: filter + sort state, shared by the index and compare views.
// Parsed from and serialized to URL search params, so views are shareable.
// ---------------------------------------------------------------------------

export const VAULT_SORT_KEYS = ["apy", "utilization", "tvl", "drawdown", "fees"] as const;
export type VaultSortKey = (typeof VAULT_SORT_KEYS)[number];
export type VaultSortDir = "asc" | "desc";

export const VAULT_STRATEGY_LABELS: Record<VaultStrategy, string> = {
  covered_call:      "Covered Call",
  cash_secured_put:  "Cash-Secured Put",
  iron_condor:       "Iron Condor",
  wheel:             "Wheel",
};

export const VAULT_STATUS_LABELS: Record<VaultStatus, string> = {
  open:               "Open",
  paused:             "Paused",
  closed_to_deposits: "Closed to deposits",
  full:               "Full",
};

export const VAULT_RISK_LABELS: Record<RiskRating, string> = {
  low:    "Low",
  medium: "Medium",
  high:   "High",
};

export const VAULT_SORT_LABELS: Record<VaultSortKey, string> = {
  apy:         "APY",
  utilization: "Capacity used",
  tvl:         "TVL",
  drawdown:    "Max drawdown",
  fees:        "Fees",
};

/** Maximum vaults that can be placed side by side on the compare view. */
export const VAULT_COMPARE_MAX = 4;

export interface VaultQuery {
  strategy: VaultStrategy | null;
  underlying: string | null;
  status: VaultStatus | null;
  risk: RiskRating | null;
  /** Epoch length in days. */
  tenor: number | null;
  sort: VaultSortKey;
  dir: VaultSortDir;
  /** Vault ids selected for comparison. */
  ids: string[];
}

export const DEFAULT_VAULT_QUERY: VaultQuery = {
  strategy: null,
  underlying: null,
  status: null,
  risk: null,
  tenor: null,
  sort: "apy",
  dir: "desc",
  ids: [],
};

function pickOne<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** Parses a comma-separated id list, dropping blanks and duplicates and capping at VAULT_COMPARE_MAX. */
export function parseVaultIds(raw: string | null): string[] {
  if (!raw) return [];
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  return [...new Set(ids)].slice(0, VAULT_COMPARE_MAX);
}

/**
 * Reads the query from URL search params. Unknown or malformed values degrade
 * to defaults rather than throwing. `knownUnderlyings` is the set present in the
 * loaded data, so a stale or hand-typed underlying is ignored.
 */
export function parseVaultQuery(
  source: { get(name: string): string | null },
  knownUnderlyings: readonly string[] = []
): VaultQuery {
  const underlying = source.get("underlying");
  const tenor = Number(source.get("tenor"));
  return {
    strategy: pickOne(source.get("strategy"), Object.keys(VAULT_STRATEGY_LABELS) as VaultStrategy[]),
    underlying: underlying && knownUnderlyings.includes(underlying) ? underlying : null,
    status: pickOne(source.get("status"), Object.keys(VAULT_STATUS_LABELS) as VaultStatus[]),
    risk: pickOne(source.get("risk"), Object.keys(VAULT_RISK_LABELS) as RiskRating[]),
    tenor: Number.isInteger(tenor) && tenor > 0 ? tenor : null,
    sort: pickOne(source.get("sort"), VAULT_SORT_KEYS) ?? DEFAULT_VAULT_QUERY.sort,
    dir: pickOne(source.get("dir"), ["asc", "desc"] as const) ?? DEFAULT_VAULT_QUERY.dir,
    ids: parseVaultIds(source.get("ids")),
  };
}

/** Serializes a query to a search string, omitting defaults so the default view has a clean URL. */
export function serializeVaultQuery(q: VaultQuery): string {
  const p = new URLSearchParams();
  if (q.strategy) p.set("strategy", q.strategy);
  if (q.underlying) p.set("underlying", q.underlying);
  if (q.status) p.set("status", q.status);
  if (q.risk) p.set("risk", q.risk);
  if (q.tenor) p.set("tenor", String(q.tenor));
  if (q.sort !== DEFAULT_VAULT_QUERY.sort) p.set("sort", q.sort);
  if (q.dir !== DEFAULT_VAULT_QUERY.dir) p.set("dir", q.dir);
  if (q.ids.length) p.set("ids", q.ids.join(","));
  return p.toString();
}

// ---------------------------------------------------------------------------
// Shared metric definitions. Use these wherever APY, utilization, fees or
// drawdown are shown or compared so the numbers mean the same thing everywhere.
// ---------------------------------------------------------------------------

/** Vault status, with `full` derived from TVL reaching capacity. */
export function effectiveStatus(v: VaultSummary): VaultStatus {
  return v.tvl >= v.capacity ? "full" : v.status;
}

/** Share of capacity used (0–1+). */
export function capacityUtilization(v: VaultSummary): number {
  return v.capacity > 0 ? v.tvl / v.capacity : 0;
}

/** Management plus performance fee, in whole percent. */
export function totalFeePct(v: VaultSummary): number {
  return v.feeStructure.managementPct + v.feeStructure.performancePct;
}

function sortValue(v: VaultSummary, key: VaultSortKey): number | null {
  switch (key) {
    case "apy":         return v.apy;
    case "utilization": return capacityUtilization(v);
    case "tvl":         return v.tvl;
    case "drawdown":    return v.maxDrawdownPct;
    case "fees":        return totalFeePct(v);
  }
}

export function filterVaults(vaults: readonly VaultSummary[], q: VaultQuery): VaultSummary[] {
  return vaults.filter(v =>
    (!q.strategy || v.strategy === q.strategy) &&
    (!q.underlying || v.underlying === q.underlying) &&
    (!q.status || effectiveStatus(v) === q.status) &&
    (!q.risk || v.riskRating === q.risk) &&
    (q.tenor === null || v.epochDays === q.tenor)
  );
}

/**
 * Sorts by the query's key and direction. Vaults with no value for the key
 * (e.g. no drawdown history yet) always sort last, and ties break on id so
 * the order is deterministic.
 */
export function sortVaults(vaults: readonly VaultSummary[], q: VaultQuery): VaultSummary[] {
  const sign = q.dir === "asc" ? 1 : -1;
  return [...vaults].sort((a, b) => {
    const av = sortValue(a, q.sort);
    const bv = sortValue(b, q.sort);
    if (av === null && bv === null) return a.id.localeCompare(b.id);
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * sign || a.id.localeCompare(b.id);
  });
}

/** Percent from a 0–1 fraction. Null renders as an em dash. */
export function fmtPct(n: number | null, digits = 1): string {
  return n === null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

/** Whole-percent fee, e.g. 10 → "10%". */
export function fmtFeePct(n: number): string {
  return n === 0 ? "None" : `${n}%`;
}

export function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function fmtStrike(n: number) {
  return n >= 1000
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${n.toFixed(4)}`;
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

/** Schema version of VaultEpochLedgerEntry. Bump on any breaking field change. */
export const VAULT_EPOCH_LEDGER_SCHEMA_VERSION = 1;

/**
 * One append-only epoch ledger row, derived from on-chain epoch events.
 * Rows are never edited in place; a correction is a new reconciliation row.
 */
export interface VaultEpochLedgerEntry {
  schemaVersion: typeof VAULT_EPOCH_LEDGER_SCHEMA_VERSION;
  vaultId: string;
  epochNumber: number;
  strategy: VaultStrategy;
  startedAt: string; // ISO — on-chain epoch start timestamp
  endedAt: string | null; // ISO — null while the epoch is still open
  premium: number; // USD, total premium collected in the epoch
  realizedPnl: number; // USD
  navBefore: number; // USD per share at epoch start
  navAfter: number | null; // USD per share at epoch end; null while open
  feeTaken: number; // USD, management + performance fees taken in the epoch
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
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
  /** Role assignments scoped to this vault only. */
  roles: VaultRoleGrant[];
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
    status: "open",
    epochDays: 7,
    maxDrawdownPct: 0.07,
    currentEpoch: 47,
    currentPhase: "active",
    phaseEndsAt: "2026-10-03T16:00:00Z",
    sharePrice: 1.042,
    totalShares: 272552,
    roles: [
      { role: "operator", holder: "GXLMCC_OPERATOR_MOCK", grantedAt: "2026-01-15T00:00:00Z" },
      { role: "guardian", holder: "GXLMCC_GUARDIAN_MOCK", grantedAt: "2026-01-15T00:00:00Z" },
      { role: "emergency_authority", holder: "GPROTOCOL_EMERGENCY_MOCK", grantedAt: "2026-01-15T00:00:00Z" },
    ],
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
    status: "open",
    epochDays: 30,
    maxDrawdownPct: 0.21,
    currentEpoch: 18,
    currentPhase: "active",
    phaseEndsAt: "2026-10-17T20:00:00Z",
    sharePrice: 1.088,
    totalShares: 1700368,
    roles: [
      { role: "operator", holder: "GBTCCSP_OPERATOR_MOCK", grantedAt: "2026-02-01T00:00:00Z" },
      { role: "guardian", holder: "GBTCCSP_GUARDIAN_MOCK", grantedAt: "2026-02-01T00:00:00Z" },
      { role: "emergency_authority", holder: "GPROTOCOL_EMERGENCY_MOCK", grantedAt: "2026-02-01T00:00:00Z" },
    ],
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
    status: "open",
    epochDays: 30,
    maxDrawdownPct: null,
    currentEpoch: 11,
    currentPhase: "deposit",
    phaseEndsAt: "2026-09-28T12:00:00Z",
    sharePrice: 1.021,
    totalShares: 607247,
    roles: [
      { role: "operator", holder: "GETHIC_OPERATOR_MOCK", grantedAt: "2026-02-15T00:00:00Z" },
      { role: "guardian", holder: "GETHIC_GUARDIAN_MOCK", grantedAt: "2026-02-15T00:00:00Z" },
      { role: "emergency_authority", holder: "GPROTOCOL_EMERGENCY_MOCK", grantedAt: "2026-02-15T00:00:00Z" },
    ],
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
    status: "closed_to_deposits",
    epochDays: 7,
    maxDrawdownPct: null,
    currentEpoch: 28,
    currentPhase: "settlement",
    phaseEndsAt: "2026-09-28T16:00:00Z",
    sharePrice: 1.194,
    totalShares: 82076,
    roles: [
      { role: "operator", holder: "GSOLWHEEL_OPERATOR_MOCK", grantedAt: "2026-03-01T00:00:00Z" },
      { role: "guardian", holder: "GSOLWHEEL_GUARDIAN_MOCK", grantedAt: "2026-03-01T00:00:00Z" },
      { role: "emergency_authority", holder: "GPROTOCOL_EMERGENCY_MOCK", grantedAt: "2026-03-01T00:00:00Z" },
    ],
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
// Depositor disclosure & eligibility
// ---------------------------------------------------------------------------

/**
 * Current risk-disclosure version. Bump this whenever the copy under
 * `vaultDisclosure.p1`–`p5` in messages/en.json changes, so every wallet
 * re-acknowledges. Acknowledgements for older versions stay in the audit
 * trail unchanged.
 */
export const VAULT_DISCLOSURE_VERSION = "2026-10-19.1";

export type PolicyReasonCode =
  | "DISCLOSURE_NOT_ACCEPTED"
  | "DISCLOSURE_VERSION_STALE"
  | "JURISDICTION_NOT_ELIGIBLE";

/** Policy rejection. `code` is stable and is what the UI maps to copy. */
export class VaultPolicyError extends Error {
  code: PolicyReasonCode;

  constructor(code: PolicyReasonCode) {
    super(code);
    this.name = "VaultPolicyError";
    this.code = code;
  }
}

/**
 * One row in the acknowledgement audit trail. Deliberately holds no personal
 * data beyond the wallet address and the self-declared jurisdiction attestation.
 */
export interface DisclosureAcknowledgement {
  wallet: string;
  disclosureVersion: string;
  /** SHA-256 (hex) of the disclosure text as rendered to the user. */
  textHash: string;
  jurisdictionAttested: boolean;
  acceptedAt: string; // ISO
}

export interface AcknowledgeDisclosureInput {
  wallet: string;
  disclosureVersion: string;
  textHash: string;
  jurisdictionAttested: boolean;
}

/** SHA-256 hex digest of the disclosure text, used to fingerprint what was accepted. */
export async function hashDisclosureText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

// Mock persistence standing in for the backend's append-only acknowledgement table.
const MOCK_ACK_STORAGE_KEY = "zenith.vaults.disclosureAcks.v1";

function readMockAcks(): DisclosureAcknowledgement[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(MOCK_ACK_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function appendMockAck(ack: DisclosureAcknowledgement): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MOCK_ACK_STORAGE_KEY, JSON.stringify([...readMockAcks(), ack]));
}

/** Server-side rule: the wallet's latest acknowledgement must match the current version. */
function assertDisclosureAccepted(wallet: string, disclosureVersion: string): void {
  if (disclosureVersion !== VAULT_DISCLOSURE_VERSION) {
    throw new VaultPolicyError("DISCLOSURE_VERSION_STALE");
  }
  const latest = readMockAcks().filter(a => a.wallet === wallet).at(-1);
  if (!latest) throw new VaultPolicyError("DISCLOSURE_NOT_ACCEPTED");
  if (latest.disclosureVersion !== VAULT_DISCLOSURE_VERSION) {
    throw new VaultPolicyError("DISCLOSURE_VERSION_STALE");
  }
  if (!latest.jurisdictionAttested) throw new VaultPolicyError("JURISDICTION_NOT_ELIGIBLE");
}

/** Records the wallet's acceptance of the current disclosure version. */
export async function acknowledgeDisclosure(
  input: AcknowledgeDisclosureInput,
  _token: string
): Promise<DisclosureAcknowledgement> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiPost<DisclosureAcknowledgement>("/api/v1/vaults/disclosures/acknowledge", {...}, token);
    throw new Error("Live vaults API not yet implemented");
  }
  if (input.disclosureVersion !== VAULT_DISCLOSURE_VERSION) {
    throw new VaultPolicyError("DISCLOSURE_VERSION_STALE");
  }
  if (!input.jurisdictionAttested) throw new VaultPolicyError("JURISDICTION_NOT_ELIGIBLE");
  await new Promise(r => setTimeout(r, 300));
  const ack: DisclosureAcknowledgement = {
    wallet: input.wallet,
    disclosureVersion: input.disclosureVersion,
    textHash: input.textHash,
    jurisdictionAttested: input.jurisdictionAttested,
    acceptedAt: new Date().toISOString(),
  };
  appendMockAck(ack);
  return ack;
}

/** Returns every acknowledgement recorded for the given wallet, oldest first. */
export async function fetchMyDisclosureAcknowledgements(
  wallet: string,
  _token: string
): Promise<DisclosureAcknowledgement[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiGet<DisclosureAcknowledgement[]>("/api/v1/vaults/disclosures/me", token);
    throw new Error("Live vaults API not yet implemented");
  }
  return Promise.resolve(readMockAcks().filter(a => a.wallet === wallet));
}

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

export async function fetchVaults(): Promise<VaultSummary[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiGet<VaultSummary[]>("/api/v1/vaults");
    throw new Error("Live vaults API not yet implemented");
  }
  return Promise.resolve(MOCK_VAULTS.map(({ historicalEpochs, userPosition, roles, ...summary }) => summary));
}

export async function fetchVaultDetail(id: string, _token?: string | null): Promise<VaultDetail | null> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiGet<VaultDetail>(`/api/v1/vaults/${id}`, token);
    throw new Error("Live vaults API not yet implemented");
  }
  return Promise.resolve(MOCK_VAULTS.find(v => v.id === id) ?? null);
}

export async function fetchVaultEpochHistory(
  id: string,
  _token?: string | null
): Promise<VaultEpochLedgerEntry[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiGet<VaultEpochLedgerEntry[]>(`/api/v1/vaults/${id}/epochs`, token);
    throw new Error("Live vaults API not yet implemented");
  }
  // Mock: no ledger rows; backfill of pre-existing mock epochs is out of scope.
  return Promise.resolve([]);
}

export async function depositToVault(
  id: string,
  amount: number,
  _token: string,
  disclosure: { wallet: string; disclosureVersion: string }
): Promise<{ tx_id: string }> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiPost<{tx_id:string}>(`/api/v1/vaults/${id}/deposit`, { amount, disclosure_version }, token);
    throw new Error("Live vaults API not yet implemented");
  }
  // Mock server-side gate: the live backend derives the wallet from the bearer token.
  assertDisclosureAccepted(disclosure.wallet, disclosure.disclosureVersion);
  // Mock: simulate a 600ms network round-trip
  await new Promise(r => setTimeout(r, 600));
  return { tx_id: `mock-tx-deposit-${id}-${amount.toFixed(0)}-${Date.now()}` };
}

export async function withdrawFromVault(
  id: string,
  shares: number,
  _token: string
): Promise<{ tx_id: string; queued: boolean }> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: return apiPost<{tx_id:string;queued:boolean}>(`/api/v1/vaults/${id}/withdraw`, { shares }, token);
    throw new Error("Live vaults API not yet implemented");
  }
  await new Promise(r => setTimeout(r, 600));
  return { tx_id: `mock-tx-withdraw-${id}-${shares.toFixed(0)}-${Date.now()}`, queued: true };
}

// ---------------------------------------------------------------------------
// Cross
