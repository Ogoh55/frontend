/**
 * Typed data adapter interface for the Vaults feature.
 *
 * The vault smart contracts and backend API are not yet available.
 * When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
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
 *   POST /api/v1/vaults/{id}/deposit   { amount: number }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

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

/**
 * SEP-41 share-token metadata for a vault's LP share ledger (issue #215).
 *
 * LP shares are exposed as a SEP-41 compliant token so wallets, explorers,
 * and other Soroban contracts can query balances/supply and (when enabled)
 * transfer positions. `decimals` must match the frontend's share-price
 * formatting assumptions; `transferable` is a per-vault policy flag that
 * defaults to off until depositor eligibility/disclosure gating is in place
 * and can be flipped without redeploying the vault.
 */
export interface VaultShareToken {
  /** SEP-41 `name()` — human-readable token name. */
  name: string;
  /** SEP-41 `symbol()` — short ticker used to label positions in the UI. */
  symbol: string;
  /** SEP-41 `decimals()` — must match frontend share-price scaling. */
  decimals: number;
  /** SEP-41 `total_supply()` — total LP shares outstanding. */
  totalSupply: number;
  /**
   * Per-vault transfer policy. When false, `transfer`/`transfer_from` are
   * rejected on-chain; mint/burn via deposit/redemption still work.
   */
  transferable: boolean;
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
  /** SEP-41 share-token identity for this vault's LP shares. */
  shareToken: VaultShareToken;
}

// ---------------------------------------------------------------------------
// Simulation / fee estimation / failure surfacing (issue #214)
// ---------------------------------------------------------------------------

/** Vault operation that can be simulated before signing. */
export type VaultOperation = "deposit" | "withdraw";

/**
 * Contract error codes surfaced by the vault contracts. Mapped to
 * human-readable copy in `messages/`; the raw code is always preserved so
 * the UI can fall back to it with a support reference.
 */
export type VaultErrorCode =
  | "EPOCH_CLOSED"
  | "DEPOSITS_CLOSED"
  | "VAULT_PAUSED"
  | "CAPACITY_EXCEEDED"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_SHARES"
  | "QUOTE_STALE"
  | "AUTHORIZATION_FAILED"
  | "TRANSFERS_DISABLED";

/** Resource + inclusion fee breakdown returned by `simulateTransaction`. */
export interface VaultFeeEstimate {
  /** Resource fee (CPU/mem/ledger-entry footprint) in stroops. */
  resourceFee: number;
  /** Inclusion fee (base fee × operations) in stroops. */
  inclusionFee: number;
  /** Total estimated cost in stroops (resourceFee + inclusionFee). */
  totalFee: number;
  /** Number of ledger entries in the footprint (grows on first-time entry). */
  footprintEntries: number;
  /** True when the simulation created a new ledger entry (first deposit costs more). */
  createsEntry: boolean;
}

/** Result of simulating a vault deposit/withdraw before signing. */
export interface VaultSimulationResult {
  operation: VaultOperation;
  vaultId: string;
  /** Quoted shares (deposit) or assets (withdraw) at the quoted NAV. */
  quotedShares: number;
  quotedAssets: number;
  /** NAV per share used for the quote. */
  quotedNav: number;
  /** Minimum acceptable shares/assets after slippage guard. */
  minReceived: number;
  /** Slippage tolerance applied (0–1). */
  slippage: number;
  /** ISO timestamp when the quote was produced. */
  quotedAt: string;
  /** Ledger sequence the quote was produced against. */
  ledger: number;
  fees: VaultFeeEstimate;
  /** Base64 XDR of the prepared transaction, ready to sign. */
  preparedXdr: string;
}

/** Failure surfaced from simulation or submission. */
export interface VaultSimulationFailure {
  operation: VaultOperation;
  vaultId: string;
  /** Mapped contract error code, or null when the failure is not a contract error. */
  code: VaultErrorCode | null;
  /** Raw error code/message from the contract or RPC, always preserved. */
  rawCode: string;
  /** Footprint size at the time of failure, for diagnostics. */
  footprintEntries: number;
}

/** Bounded slippage guard range (0.1%–5%). */
export const MIN_SLIPPAGE = 0.001;
export const MAX_SLIPPAGE = 0.05;
/** Quotes older than this window must be re-simulated before signing. */
export const QUOTE_STALENESS_MS = 30_000;

/** Clamp a user-supplied slippage into the bounded range. */
export function clampSlippage(slippage: number): number {
  if (!Number.isFinite(slippage)) return MIN_SLIPPAGE;
  return Math.min(MAX_SLIPPAGE, Math.max(MIN_SLIPPAGE, slippage));
}

/** True when a quote is older than the configured staleness window. */
export function isQuoteStale(quotedAt: string, now: number = Date.now()): boolean {
  const ts = Date.parse(quotedAt);
  if (Number.isNaN(ts)) return true;
  return now - ts > QUOTE_STALENESS_MS;
}

/**
 * Map a raw contract/RPC error to a known `VaultErrorCode`, or null when it
 * is not a recognized contract error. Matching is case-insensitive and
 * tolerant of the `Error(Contract, #N)` shape returned by Soroban RPC.
 */
export function mapVaultErrorCode(raw: string): VaultErrorCode | null {
  const normalized = raw.toUpperCase();
  const table: Array<[VaultErrorCode, RegExp]> = [
    ["EPOCH_CLOSED", /EPOCH[_ ]?CLOSED/],
    ["DEPOSITS_CLOSED", /DEPOSITS?[_ ]?CLOSED/],
    ["VAULT_PAUSED", /VAULT[_ ]?PAUSED|PAUSED/],
    ["CAPACITY_EXCEEDED", /CAPACITY[_ ]?EXCEEDED|VAULT[_ ]?FULL/],
    ["INSUFFICIENT_BALANCE", /INSUFFICIENT[_ ]?BALANCE/],
    ["INSUFFICIENT_SHARES", /INSUFFICIENT[_ ]?SHARES/],
    ["QUOTE_STALE", /QUOTE[_ ]?STALE|STALE[_ ]?QUOTE|SLIPPAGE/],
    ["TRANSFERS_DISABLED", /TRANSFERS?[_ ]?DISABLED|NOT[_ ]?TRANSFERABLE/],
    ["AUTHORIZATION_FAILED", /AUTHORIZ|UNAUTHORIZED|NOT[_ ]?AUTHORIZED/],
  ];
  for (const [code, pattern] of table) {
    if (pattern.test(normalized)) return code;
  }
  return null;
}

/**
 * Build the final deposit/withdraw transaction via `simulateTransaction`,
 * returning the fee breakdown, quoted shares/assets, and prepared XDR.
 *
 * The live path is gated behind NEXT_PUBLIC_VAULTS=live; until the contract
 * client is wired in, this throws a typed error the UI can surface.
 */
export async function simulateVaultTransaction(params: {
  vaultId: string;
  operation: VaultOperation;
  amount: number;
  slippage: number;
}): Promise<VaultSimulationResult> {
  if (process.env.NEXT_PUBLIC_VAULTS !== "live") {
    throw new Error("Vault simulation is not yet implemented");
  }
  // Live implementation: build the operation, call Soroban RPC
  // `simulateTransaction`, and return the fee breakdown + prepared XDR.
  throw new Error("Vault simulation is not yet implemented");
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
    apyMethodology: "Trailing 12-

/* … truncated 6054 chars — edit only what you need near the top … */
