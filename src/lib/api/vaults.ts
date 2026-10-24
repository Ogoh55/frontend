import { apiGet, apiPost, ApiError } from "./client";
import { toCsv, type CsvColumn } from "../csv";

/**
 * Typed data adapter for the Vaults feature.
 *
 * Reads go through the BFF against the frozen vault REST contract:
 *
 * The Phase 2 options vault contract is scaffolded under `contracts/vault`
 * (crate `zenith-options-vault`), but it is not yet deployed and the backend
 * API is not yet available. This module is unrelated to the margin-collateral
 * vault in `./vault.ts`. When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
 * implementation below is used. Swap in the real implementation by
 * setting NEXT_PUBLIC_VAULTS=live, which calls the backend vault registry
 * (Zenith-options/backend) through the REST contract below.
 *
 * Backend contract (for when the real API lands):
 *
 *   GET /api/v1/vaults
 *   → VaultSummary[]
 *
 *   GET /api/v1/vaults/{id}
 *   → VaultDetail (404 → null)
 *
 * Gating lives in the page layer (`useFlag("vaults")`); this module never
 * returns placeholder data.
 *
 * Deposit/withdraw are not implemented yet (out of scope for the read path):
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number; disclosure_version: string }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
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

// ---------------------------------------------------------------------------
// Lifecycle state machine (see docs/vault-lifecycle.md)
// ---------------------------------------------------------------------------

export const VAULT_STATUSES = ["draft", "open", "paused", "winding_down", "closed"] as const;
export type VaultStatus = (typeof VAULT_STATUSES)[number];

/** Funds-affecting user actions gated by vault status. */
export type VaultAction = "deposit" | "withdraw";

/** Who may trigger a transition. Operator actions are governance-gated (out of scope here). */
export type VaultActor = "operator" | "guardian" | "system";

export interface VaultTransition {
  from: VaultStatus;
  to: VaultStatus;
  actor: VaultActor;
}

export const VAULT_TRANSITIONS: readonly VaultTransition[] = [
  { from: "draft", to: "open", actor: "operator" },
  { from: "open", to: "paused", actor: "guardian" },
  { from: "open", to: "winding_down", actor: "operator" },
  { from: "paused", to: "open", actor: "operator" },
  { from: "paused", to: "winding_down", actor: "operator" },
  { from: "winding_down", to: "closed", actor: "system" },
];

export interface VaultStatusPolicy {
  label: string;
  permittedActions: readonly VaultAction[];
}

export const VAULT_STATUS_POLICY: Record<VaultStatus, VaultStatusPolicy> = {
  draft:        { label: "Draft",        permittedActions: [] },
  open:         { label: "Open",         permittedActions: ["deposit", "withdraw"] },
  paused:       { label: "Paused",       permittedActions: [] },
  winding_down: { label: "Winding Down", permittedActions: ["withdraw"] },
  closed:       { label: "Closed",       permittedActions: [] },
};

/** Read-only fallback for any status this client does not know about. */
const UNKNOWN_STATUS_POLICY: VaultStatusPolicy = { label: "Unknown", permittedActions: [] };

export function isVaultStatus(status: unknown): status is VaultStatus {
  return typeof status === "string" && (VAULT_STATUSES as readonly string[]).includes(status);
}

/** Resolves policy for a raw status string. Unknown statuses are read-only, never actionable. */
export function vaultStatusPolicy(status: string): VaultStatusPolicy {
  return isVaultStatus(status) ? VAULT_STATUS_POLICY[status] : UNKNOWN_STATUS_POLICY;
}

/**
 * Applies a transition. Re-applying the current status is an idempotent no-op
 * (`changed: false`, so no history entry is written). Illegal edges or wrong actors throw.
 */
export function applyVaultTransition(
  current: VaultStatus,
  to: VaultStatus,
  actor: VaultActor
): { status: VaultStatus; changed: boolean } {
  if (current === to) return { status: current, changed: false };
  const edge = VAULT_TRANSITIONS.find(t => t.from === current && t.to === to);
  if (!edge) throw new Error(`Illegal vault transition: ${current} → ${to}`);
  if (edge.actor !== actor) throw new Error(`Actor ${actor} may not move vault ${current} → ${to}`);
  return { status: to, changed: true };
}

/**
 * Summary shown on the /vaults listing page. Fields the backend does not
 * serve yet are `null` and must render as absent, never as zero.
 */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  status: VaultStatus;
  /** Trailing 12-month APY estimate (0–1, e.g. 0.18 = 18%). */
  apy: number | null;
  /** APY methodology note shown in tooltip. */
  apyMethodology: string;
  /** Total value locked in USD. */
  tvl: number | null;
  /** Maximum TVL before the vault is full. */
  capacity: number | null;
  currentStrike: number | null;
  currentExpiry: string | null; // ISO date
  riskRating: RiskRating;
  description: string;
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
  draft:        "Draft",
  open:         "Open",
  paused:       "Paused",
  winding_down: "Winding Down",
  closed:       "Closed",
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
  /** Null until the first epoch has started. */
  currentEpoch: number | null;
  currentPhase: EpochPhase | null;
  phaseEndsAt: string | null; // ISO — when the current phase ends
  sharePrice: number | null; // current NAV per share in USD; null or 0 = no NAV
  totalShares: number;
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
  /** Role assignments scoped to this vault only. */
  roles: VaultRoleGrant[];
}

// ---------------------------------------------------------------------------
// Share-lot accounting (cost basis, realized and unrealized PnL)
//
// Shared by the API and any client-side display. Rebuilding the ledger from
// the same event stream always yields the same output: events are ordered by
// (ledger, seq) and lots by (acquiredLedger, lotId). Schema: docs/vault-lot-ledger.md
// ---------------------------------------------------------------------------

/** Lot relief method. Stored on every ledger row so a future change cannot rewrite history. */
export type LotReliefMethod = "fifo";
export const DEFAULT_LOT_RELIEF_METHOD: LotReliefMethod = "fifo";

/** Share amounts at or below this are rounding residue, never a lot. */
export const DUST_SHARES = 1e-9;

/** A dated acquisition lot held by one depositor in one vault. */
export interface VaultShareLot {
  lotId: string;
  vaultId: string;
  acquiredLedger: number;
  acquiredAt: string; // ledger close time (ISO), never receipt time
  /** Shares still held from this lot. */
  shares: number;
  /** Cost basis still attached to the remaining shares, in USD. */
  costUsd: number;
  /** NAV per share used when the shares were minted. */
  navPerShare: number;
}

/** A lot-affecting event as indexed from the vault contract. */
export interface VaultLotEvent {
  seq: number;
  kind: "deposit" | "transfer_in" | "redemption" | "transfer_out";
  ledger: number;
  ledgerAt: string;
  vaultId: string;
  shares: number;
  /** deposit/transfer_in: cost in USD. redemption/transfer_out: gross proceeds in USD. */
  amountUsd: number;
  /** Fees that reduce proceeds. Management fees are already reflected in NAV and are not repeated here. */
  feesUsd: number;
  navPerShare: number;
}

/** One ledger row per lot-affecting event. This is the export row. */
export interface VaultLedgerRow {
  seq: number;
  kind: VaultLotEvent["kind"];
  ledger: number;
  ledgerAt: string;
  vaultId: string;
  shares: number;
  amountUsd: number;
  feesUsd: number;
  navPerShare: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  lotMethod: LotReliefMethod;
}

export interface LotRelief {
  shares: number;
  costBasisUsd: number;
  /** Gross proceeds minus fees. */
  netProceedsUsd: number;
  realizedPnlUsd: number;
  consumed: { lotId: string; shares: number; costUsd: number }[];
  remainingLots: VaultShareLot[];
}

function byLotOrder(a: VaultShareLot, b: VaultShareLot): number {
  return a.acquiredLedger - b.acquiredLedger || a.lotId.localeCompare(b.lotId);
}

/**
 * Relieves `shares` from the lots in FIFO order and returns the realized PnL.
 * Throws rather than producing a negative basis when `shares` exceeds the tracked lots.
 */
export function relieveLotsFifo(
  lots: VaultShareLot[],
  shares: number,
  grossProceedsUsd: number,
  feesUsd: number
): LotRelief {
  if (!(shares > DUST_SHARES)) throw new Error(`Relief quantity must be positive, got ${shares}`);
  if (feesUsd < 0) throw new Error(`Fees cannot be negative, got ${feesUsd}`);
  const available = lots.reduce((sum, lot) => sum + lot.shares, 0);
  if (shares > available + DUST_SHARES) {
    throw new Error(`Cannot relieve ${shares} shares: only ${available} tracked`);
  }

  let remaining = shares;
  let costBasisUsd = 0;
  const consumed: LotRelief["consumed"] = [];
  const remainingLots: VaultShareLot[] = [];

  for (const lot of [...lots].sort(byLotOrder)) {
    if (remaining <= DUST_SHARES) {
      remainingLots.push(lot);
      continue;
    }
    const take = Math.min(lot.shares, remaining);
    const costUsd = lot.shares > 0 ? lot.costUsd * (take / lot.shares) : 0;
    remaining -= take;
    costBasisUsd += costUsd;
    consumed.push({ lotId: lot.lotId, shares: take, costUsd });

    const left = lot.shares - take;
    if (left > DUST_SHARES) {
      remainingLots.push({ ...lot, shares: left, costUsd: lot.costUsd - costUsd });
    }
  }

  const netProceedsUsd = grossProceedsUsd - feesUsd;
  return {
    shares,
    costBasisUsd,
    netProceedsUsd,
    realizedPnlUsd: netProceedsUsd - costBasisUsd,
    consumed,
    remainingLots,
  };
}

/** Unrealized PnL on the lots still held, marked at `markNavPerShare`. */
export function unrealizedPnl(lots: VaultShareLot[], markNavPerShare: number): number {
  return lots.reduce((sum, lot) => sum + (lot.shares * markNavPerShare - lot.costUsd), 0);
}

/**
 * Replays lot-affecting events into lots and ledger rows.
 * Deterministic: the same events always produce the same rows and lots.
 */
export function buildLotLedger(events: VaultLotEvent[]): { rows: VaultLedgerRow[]; lots: VaultShareLot[] } {
  const ordered = [...events].sort((a, b) => a.ledger - b.ledger || a.seq - b.seq);
  let lots: VaultShareLot[] = [];
  const rows: VaultLedgerRow[] = [];

  for (const ev of ordered) {
    const base = {
      seq: ev.seq,
      kind: ev.kind,
      ledger: ev.ledger,
      ledgerAt: ev.ledgerAt,
      vaultId: ev.vaultId,
      shares: ev.shares,
      amountUsd: ev.amountUsd,
      feesUsd: ev.feesUsd,
      navPerShare: ev.navPerShare,
      lotMethod: DEFAULT_LOT_RELIEF_METHOD,
    };

    if (ev.kind === "deposit" || ev.kind === "transfer_in") {
      // Dust minted from rounding never becomes a lot.
      if (ev.shares > DUST_SHARES) {
        lots.push({
          lotId: `${ev.vaultId}:${ev.seq}`,
          vaultId: ev.vaultId,
          acquiredLedger: ev.ledger,
          acquiredAt: ev.ledgerAt,
          shares: ev.shares,
          costUsd: ev.amountUsd,
          navPerShare: ev.navPerShare,
        });
      }
      rows.push({ ...base, costBasisUsd: ev.amountUsd, realizedPnlUsd: 0 });
      continue;
    }

    const relief = relieveLotsFifo(lots, ev.shares, ev.amountUsd, ev.feesUsd);
    lots = relief.remainingLots;
    rows.push({ ...base, costBasisUsd: relief.costBasisUsd, realizedPnlUsd: relief.realizedPnlUsd });
  }

  return { rows, lots: [...lots].sort(byLotOrder) };
}

/** Export schema version. Bump on any column change. */
export const VAULT_EXPORT_SCHEMA_VERSION = 1;

export type VaultExportFormat = "csv" | "json";

export const VAULT_EXPORT_COLUMNS: CsvColumn<VaultLedgerRow>[] = [
  { header: "schema_version", value: () => VAULT_EXPORT_SCHEMA_VERSION },
  { header: "seq", value: r => r.seq },
  { header: "event_kind", value: r => r.kind },
  { header: "ledger", value: r => r.ledger },
  { header: "ledger_at", value: r => r.ledgerAt },
  { header: "vault_id", value: r => r.vaultId },
  { header: "shares", value: r => r.shares },
  { header: "amount_usd", value: r => r.amountUsd },
  { header: "fees_usd", value: r => r.feesUsd },
  { header: "nav_per_share", value: r => r.navPerShare },
  { header: "cost_basis_usd", value: r => r.costBasisUsd },
  { header: "realized_pnl_usd", value: r => r.realizedPnlUsd },
  { header: "lot_method", value: r => r.lotMethod },
];

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_VAULTS: VaultDetail[] = [
  {
    id: "xlm-cc-v1",
    name: "XLM Covered Call",
    underlying: "XLM",
    strategy: "covered_call",
    status: "open",
    apy: 0.22,
    apyMethodology: "Trailing 12-month annualized premium income ÷ average TVL. Does not include spot price change of the underlying.",
    tvl: 284000,
    capacity: 500000,
    currentStrike: 0.13,
    currentExpiry: "2026-10-03",
    riskRating: "medium",
    description: "Writes weekly out-of-the-money covered calls on XLM. Collects premium each epoch; the vault holds XLM as collateral.",
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
    status: "open",
    apy: 0.15,
    apyMethodology: "Trailing 12-month annualized premium income ÷ average USDC TVL. Excludes BTC spot risk — depositors are exposed to assignment at the strike price.",
    tvl: 1850000,
    capacity: 3000000,
    currentStrike: 60000,
    currentExpiry: "2026-10-17",
    riskRating: "high",
    description: "Writes monthly cash-secured puts on BTC. The vault holds USDC as collateral; assignment means acquiring BTC at the strike.",
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
    status: "open",
    apy: 0.18,
    apyMethodology: "Trailing 12-month net premium income (both spreads) ÷ average USDC collateral deployed.",
    tvl: 620000,
    capacity: 1000000,
    currentStrike: 3200,
    currentExpiry: "2026-10-10",
    riskRating: "low",
    description: "Sells 30-day iron condors on ETH, targeting a range-bound market. Limited loss profile; wins when ETH stays between the two breakevens.",
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
   
