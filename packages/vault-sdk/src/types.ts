/**
 * Wire models for the Phase 2 vault REST contract.
 *
 * Mirrors the interfaces in `src/lib/api/vaults.ts`, which is the only
 * written description of the contract in this repository. Enum-like fields
 * accept any string so a newer backend that adds a strategy, phase, or
 * outcome does not break existing integrators.
 */

/** Known values plus any string a newer backend may send. */
export type KnownOrUnknown<T extends string> = T | (string & Record<never, never>);

export type VaultStrategy = KnownOrUnknown<"covered_call" | "cash_secured_put" | "iron_condor" | "wheel">;
export type RiskRating = KnownOrUnknown<"low" | "medium" | "high">;
export type EpochPhase = KnownOrUnknown<"deposit" | "active" | "settlement">;
export type EpochOutcome = KnownOrUnknown<"expired_worthless" | "exercised" | "active">;

/** Summary shown on the vault listing. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  /** Trailing 12-month APY estimate (0–1, e.g. 0.18 = 18%). */
  apy: number;
  apyMethodology: string;
  /** Total value locked in USD. */
  tvl: number;
  /** Maximum TVL before the vault is full. */
  capacity: number;
  currentStrike: number;
  /** ISO date. */
  currentExpiry: string;
  riskRating: RiskRating;
  description: string;
}

/** One historical epoch record. */
export interface EpochRecord {
  epochNumber: number;
  /** ISO timestamp. */
  depositStart: string;
  /** ISO timestamp. */
  activeStart: string;
  /** ISO timestamp. */
  settlementDate: string;
  strike: number;
  expiryDays: number;
  /** Per share, in USD. */
  premiumCollected: number;
  outcome: EpochOutcome;
  /** Epoch return; positive means profit for depositors. */
  pnlPct: number;
}

/** The caller's position in a vault. */
export interface UserVaultPosition {
  shares: number;
  /** Current USD value per share. */
  shareValue: number;
  totalValue: number;
  accruedPremium: number;
  /** Shares queued for withdrawal at epoch end. */
  pendingWithdrawal: number;
}

export interface FeeStructure {
  managementPct: number;
  performancePct: number;
}

/** Full detail for a single vault. */
export interface VaultDetail extends VaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  /** ISO timestamp when the current phase ends. */
  phaseEndsAt: string;
  /** Current NAV per share in USD. */
  sharePrice: number;
  totalShares: number;
  feeStructure: FeeStructure;
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
}

/** Response to `POST /api/v1/vaults/{id}/deposit`. */
export interface DepositResult {
  tx_id: string;
}

/** Response to `POST /api/v1/vaults/{id}/withdraw`. */
export interface WithdrawResult {
  tx_id: string;
  /** True when the shares are queued for the next epoch end. */
  queued: boolean;
}
