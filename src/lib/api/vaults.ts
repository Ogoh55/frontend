/**
 * Typed data adapter for the Vaults feature.
 *
 * Reads go through the BFF against the frozen vault REST contract:
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
 *   POST /api/v1/vaults/{id}/deposit   { amount: number }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
 */

import { apiGet, ApiError } from "./client";

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/**
 * Summary shown on the /vaults listing page. Fields the backend does not
 * serve yet are `null` and must render as absent, never as zero.
 */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
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
  feeStructure: { managementPct: number; performancePct: number };
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
}

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

export function fetchVaults(token?: string | null): Promise<VaultSummary[]> {
  return apiGet<VaultSummary[]>("/api/v1/vaults", token ?? null);
}

export async function fetchVaultDetail(id: string, token?: string | null): Promise<VaultDetail | null> {
  try {
    return await apiGet<VaultDetail>(`/api/v1/vaults/${encodeURIComponent(id)}`, token ?? null);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function depositToVault(
  _id: string,
  _amount: number,
  _token: string
): Promise<{ tx_id: string }> {
  throw new Error("Vault deposits are not yet available");
}

export async function withdrawFromVault(
  _id: string,
  _shares: number,
  _token: string
): Promise<{ tx_id: string; queued: boolean }> {
  throw new Error("Vault withdrawals are not yet available");
}
