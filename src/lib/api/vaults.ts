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
 */
import { useWalletStore } from '@/lib/store/wallet';

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
