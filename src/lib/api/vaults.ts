/**
 * Vault transaction receipts client.
 *
 * Receipts are keyed by the client-generated idempotency key so an optimistic
 * UI row and a later backend row collapse into a single record. Amounts are
 * carried as decimal strings (never floats) to preserve precision.
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
