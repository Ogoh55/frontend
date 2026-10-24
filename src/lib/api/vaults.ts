import { apiGet, apiPost } from "./client";

/**
 * Vault transaction receipts client.
 *
 * Receipts are keyed by the client-generated idempotency key so an optimistic
 * UI row and a later backend row collapse into a single record. Amounts are
 * carried as decimal strings (never floats) to preserve precision.
 *
 * This module also exposes the read-only diagnostics client used by the
 * internal depositor support console. The diagnostics client is issued a
 * read-scoped token and only ever calls GET endpoints, so a UI regression
 * cannot escalate into a state-changing call.
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
 *   → VaultDetail
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number; disclosure_version: string }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean; request_id: string }
 *   POST /api/v1/vaults/{id}/withdrawals/{request_id}/cancel → { returned_shares: number }
 *
 *   GET /api/v1/vaults/positions
 *   → VaultPositionWire[]  (one row per vault the wallet holds; `error` set when that vault failed)
 *
 *   POST /api/v1/vaults/disclosures/acknowledge
 *     { disclosure_version, text_hash, jurisdiction_attested }  → DisclosureAcknowledgement
 *   GET  /api/v1/vaults/disclosures/me  → DisclosureAcknowledgement[]
 *
 * Deposits are rejected server-side (403 with a PolicyReasonCode) unless the
 * wallet holds an acknowledgement for the current disclosure version. The
 * client check in the UI is advisory only.
 *
 * Withdrawal queue semantics (mock implements these; the live contract must match):
 *
 *   - Request: shares are escrowed on request. Escrowed shares stay in totalShares
 *     (so NAV per share is unaffected by the queue) but cannot be requested again.
 *   - Ordering: requests are served by (request epoch, then seq). Requests from an
 *     earlier epoch are always served first. `seq` is a monotonic tie-break assigned
 *     at request time. Unfilled requests keep their epoch, seq and requestedAt.
 *   - Fill: each epoch cohort is valued at the processing NAV. If the remaining
 *     liquidity covers the cohort, every request fills 100%. If it does not, every
 *     request in that cohort fills the same pro-rata fraction, and later cohorts get
 *     nothing this pass. `fillFraction` is recorded per request.
 *   - Processing: a keeper calls `processWithdrawalQueue` at an epoch boundary with the
 *     NAV per share and liquidity at that point. At most MAX_COHORTS_PER_PASS cohorts
 *     are examined per call. Filled shares leave totalShares and the user's shares.
 *   - Settlement NAV: a processed request pays out at the NAV passed to the keeper,
 *     not the NAV at request time.
 *   - Cancellation: only requests still in the queue can be cancelled. The escrow that
 *     remains is returned in full. Any part already filled stays paid out.
 *   - Pause: not modeled in the mock. The intended rule is that a paused vault blocks new
 *     requests but still processes queued ones.
 *
 * Depositor privacy (issue #231):
 *
 *   GET  /api/v1/vaults/privacy/export?wallet={address}
 *   → DepositorDataExport
 *
 *   POST /api/v1/vaults/privacy/deletion-request  { wallet: string; reason?: string }
 *   → DeletionRequestReceipt
 *
 *   GET  /api/v1/vaults/privacy/deletion-request/{id}
 *   → DeletionRequestReceipt
 *
 * Public read-only partner API (issue #233):
 *
 *   GET /api/public/v1/vaults?limit={n}&cursor={c}
 *   → PublicVaultListResponse
 *
 *   GET /api/public/v1/vaults/{id}
 *   → PublicVaultDetail
 *
 *   GET /api/public/v1/vaults/{id}/epochs?limit={n}&cursor={c}
 *   → PublicEpochHistoryResponse
 *
 * The public surface is a projection over the same vault registry/epoch
 * ledger, served from a cache independent of the authenticated read path.
 * It never exposes per-depositor data (see `toPublicVaultSummary`).
 *
 * See docs/privacy/vault-data-inventory.md for the data inventory, retention
 * windows, and the deletion/export workflow this module mirrors.
 */
import { useWalletStore } from '@/lib/store/wallet';
import { bffFetch } from "./client";
import { toCsv, type CsvColumn } from "../csv";

export type VaultTxType =
  | 'deposit'
  | 'redemption_request'
  | 'redemption'
  | 'epoch_payout'
  | 'fee_charge';

export type VaultTxStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'reconciled';

export interface VaultReceipt {
  /** Client-generated idempotency key — the canonical receipt identity. */
  idempotencyKey: string;
  vaultId: string;
  account: string;
  type: VaultTxType;
  /** Decimal string, e.g. "1000.00". */
  amount: string;
  /** Decimal string share delta (positive for deposits, negative for redemptions). */
  shareDelta: string;
  /** NAV that applied at execution, as a decimal string. Null until known. */
  navAtExecution: string | null;
  /** Fee charged, as a decimal string. */
  fee: string;
  status: VaultTxStatus;
  /** Stellar transaction hash — only present once submitted. */
  txHash: string | null;
  /** ISO timestamp of the last status change. */
  updatedAt: string;
}

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

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  status: VaultStatus;
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

export interface VaultHistoryFilters {
  vaultId?: string;
  account?: string;
}

export interface VaultHistoryResult {
  receipts: VaultReceipt[];
  /** True when the backend could not be reached and data is degraded. */
  degraded: boolean;
}

const RECEIPTS_STORAGE_KEY = 'zenith.vault.receipts.v1';

function readLocalReceipts(): VaultReceipt[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECEIPTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VaultReceipt[]) : [];
  } catch {
    return [];
  }
}

function writeLocalReceipts(receipts: VaultReceipt[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECEIPTS_STORAGE_KEY, JSON.stringify(receipts));
  } catch {
    // Storage may be unavailable (private mode / quota) — receipts still live
    // in memory for the session.
  }
}

/**
 * Persist a receipt keyed by its idempotency key. Re-submitting the same key
 * updates the existing record instead of creating a duplicate.
 */
export function upsertReceipt(receipt: VaultReceipt): void {
  const existing = readLocalReceipts();
  const idx = existing.findIndex(
    (r) => r.idempotencyKey === receipt.idempotencyKey,
  );
  if (idx >= 0) {
    existing[idx] = receipt;
  } else {
    existing.push(receipt);
  }
  writeLocalReceipts(existing);
}

/**
 * Fetch vault receipts for the given filters. Falls back to locally persisted
 * receipts when the backend is unreachable so the surface never renders blank.
 */
export async function fetchVaultHistory(
  filters: VaultHistoryFilters = {},
): Promise<VaultHistoryResult> {
  const account = filters.account ?? useWalletStore.getState().address ?? undefined;
  const local = readLocalReceipts().filter(
    (r) =>
      (!filters.vaultId || r.vaultId === filters.vaultId) &&
      (!account || r.account === account),
  );

  try {
    const params = new URLSearchParams();
    if (filters.vaultId) params.set('vaultId', filters.vaultId);
    if (account) params.set('account', account);
    const res = await fetch(`/api/vaults/history?${params.toString()}`);
    if (!res.ok) throw new Error(`history ${res.status}`);
    const remote = (await res.json()) as VaultReceipt[];

    // Collapse remote rows with local optimistic rows by idempotency key.
    const merged = new Map<string, VaultReceipt>();
    for (const r of local) merged.set(r.idempotencyKey, r);
    for (const r of remote) merged.set(r.idempotencyKey, r);
    return { receipts: Array.from(merged.values()), degraded: false };
  } catch {
    return { receipts: local, degraded: true };
  }
}

// ---------------------------------------------------------------------------
// Read-only diagnostics client (internal depositor support console)
// ---------------------------------------------------------------------------

/**
 * The only lookup keys the diagnostics console accepts. Each maps to a single
 * consolidated diagnostic view returned by the read-only backend endpoint.
 */
export type DiagnosticsLookup =
  | { kind: 'vault'; vaultId: string }
  | { kind: 'account'; account: string }
  | { kind: 'tx'; txHash: string }
  | { kind: 'receipt'; idempotencyKey: string };

/** A single field's on-chain vs backend value, with drift made explicit. */
export interface DiagnosticField {
  label: string;
  onChain: string | null;
  backend: string | null;
  /** True when onChain and backend disagree (or one side is missing). */
  drift: boolean;
}

export interface DiagnosticDrift {
  /** Human-readable description of the discrepancy. */
  detail: string;
  /** ISO timestamp of the reconciliation job that reported the drift. */
  reportedAt: string;
}

export interface DiagnosticsView {
  lookup: DiagnosticsLookup;
  vaultId: string | null;
  account: string | null;
  /** Side-by-side on-chain vs backend state, drift flagged per field. */
  fields: DiagnosticField[];
  /** Drift reported by reconciliation jobs, surfaced rather than hidden. */
  drift: DiagnosticDrift[];
  /** Queue position for pending withdrawals, if applicable. */
  queuePosition: number | null;
  /** Receipt status summary, if applicable. */
  receiptStatus: VaultTxStatus | null;
  /** NAV provenance (source + timestamp) as a decimal string, if known. */
  navProvenance: string | null;
  /** Halt reason when the vault is halted, otherwise null. */
  haltReason: string | null;
  /** ISO timestamp of the last reconciled on-chain state. */
  lastReconciledAt: string | null;
  /** True when the backend could not be reached and data is degraded. */
  degraded: boolean;
}

export interface DiagnosticsPage {
  views: DiagnosticsView[];
  /** Opaque cursor for the next page of a large account history. */
  nextCursor: string | null;
  degraded: boolean;
}

/**
 * Read-scoped token issued to the diagnostics client. It is intentionally
 * separate from the operator token so the API surface — not UI hiding —
 * enforces that diagnostics can never mutate state.
 */
export interface DiagnosticsAuth {
  /** Read-scoped bearer token; the backend rejects any write with it. */
  readToken: string;
  /** Authenticated internal user the lookup is attributed to. */
  actor: string;
}

function lookupParams(lookup: DiagnosticsLookup): URLSearchParams {
  const params = new URLSearchParams();
  switch (lookup.kind) {
    case 'vault':
      params.set('vaultId', lookup.vaultId);
      break;
    case 'account':
      params.set('account', lookup.account);
      break;
    case 'tx':
      params.set('txHash', lookup.txHash);
      break;
    case 'receipt':
      params.set('idempotencyKey', lookup.idempotencyKey);
      break;
  }
  return params;
}

/**
 * Perform a single consolidated read-only diagnostic lookup. Only issues a GET
 * with the read-scoped token; the backend records the lookup in the immutable
 * audit log attributed to the authenticated internal user.
 */
export async function fetchDiagnostics(
  lookup: DiagnosticsLookup,
  auth: DiagnosticsAuth,
  cursor?: string,
): Promise<DiagnosticsPage> {
  const params = lookupParams(lookup);
  if (cursor) params.set('cursor', cursor);

  try {
    const res = await fetch(`/api/internal/diagnostics?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.readToken}`,
        'X-Internal-Actor': auth.actor,
      },
    });
    if (!res.ok) throw new Error(`diagnostics ${res.status}`);
    const body = (await res.json()) as Omit<DiagnosticsPage, 'degraded'>;
    return { ...body, degraded: false };
  } catch {
    return { views: [], nextCursor: null, degraded: true };
  }
}

/** The user's position in a vault. */
export interface UserVaultPosition {
  shares: number;
  shareValue: number; // current USD value per share
  totalValue: number;
  accruedPremium: number;
  pendingWithdrawal: number; // shares escrowed in unprocessed withdrawal requests
}

export type WithdrawalStatus = "queued" | "processed" | "cancelled";

/** One redemption request in a vault's withdrawal queue. */
export interface WithdrawalRequest {
  id: string;
  vaultId: string;
  /** Epoch the request was made in. Earlier epochs are served first. */
  requestEpoch: number;
  /** Monotonic tie-break within an epoch, assigned at request time. */
  seq: number;
  /** ISO time of the original request. Kept when unfilled requests carry forward. */
  requestedAt: string;
  requestedShares: number;
  /** Shares still escrowed and not yet redeemed. */
  escrowedShares: number;
  filledShares: number;
  /** filledShares / requestedShares, 0–1. Updated on every processing pass. */
  fillFraction: number;
  /** USD paid out, summed over every pass at that pass's processing NAV. */
  payoutUsd: number;
  status: WithdrawalStatus;
}

/** State of the vault at the point where the withdrawal queue is processed. */
export interface ProcessingPoint {
  /** NAV per share at processing. Requests settle at this price. */
  navPerShare: number;
  /** USD of liquid capital available to pay out. */
  liquidityUsd: number;
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
      seq:
