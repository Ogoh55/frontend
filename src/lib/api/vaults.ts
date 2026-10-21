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
  /** On-chain fee policy + last crystallization (issue #216). */
  feePolicy: VaultFeePolicy;
}

// ---------------------------------------------------------------------------
// Fee policy / high-water mark / crystallization (issue #216)
// ---------------------------------------------------------------------------

/**
 * Hard upper bound on any configured fee rate, in basis points (30%).
 * Enforced at configuration time on-chain (governance/timelock path) and
 * mirrored here so the UI can validate before submitting a change.
 */
export const MAX_FEE_BPS = 3_000;

/**
 * Per-vault fee policy. Rates are in basis points (1 bps = 0.01%).
 *
 * - `managementFeeBps` is charged per epoch on NAV.
 * - `performanceFeeBps` is charged only on new profits above the
 *   persistent high-water mark (never on recovered drawdowns).
 * - `feeRecipient` is the Stellar address that receives crystallized fees.
 *
 * Changes are only possible through the vault governance/timelock path.
 */
export interface VaultFeePolicy {
  managementFeeBps: number;
  performanceFeeBps: number;
  /** Stellar address (G.../C...) receiving crystallized fees. */
  feeRecipient: string;
  /**
   * Persistent high-water mark: the highest NAV-per-share at which a
   * performance fee has been crystallized. Stored in contract storage with
   * an explicit TTL policy (not derived from NAV history).
   */
  highWaterMark: number;
  /** Last epoch at which fees were crystallized, or null if never. */
  lastCrystallization: FeeCrystallization | null;
}

/**
 * Result of crystallizing fees at epoch close. Fees are computed and
 * settled inside the same transaction as epoch close, before the epoch NAV
 * is finalized, so the published NAV already reflects fees.
 */
export interface FeeCrystallization {
  epochNumber: number;
  /** NAV per share before fees were deducted. */
  navBeforeFees: number;
  /** NAV per share after fees were deducted (the published NAV). */
  navAfterFees: number;
  /** High-water mark in effect before this crystallization. */
  highWaterMarkBefore: number;
  /** High-water mark after this crystallization (raised only on new highs). */
  highWaterMarkAfter: number;
  managementFee: number;
  performanceFee: number;
  totalFee: number;
  /** Recipient the fees were transferred to. */
  feeRecipient: string;
  /** Transaction hash of the on-chain settlement transfer. */
  settlementTxHash: string;
  /** ISO timestamp of crystallization. */
  crystallizedAt: string;
}

/** True when a fee rate is within the hard maximum bound. */
export function isValidFeeBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= MAX_FEE_BPS;
}

/**
 * Compute the fees that would crystallize for an epoch, given the NAV per
 * share before fees and the current high-water mark.
 *
 * Semantics:
 * - Management fee = `navBeforeFees * managementFeeBps / 10_000`.
 * - Performance fee is charged only on the portion of NAV above the
 *   high-water mark: `max(0, navBeforeFees - highWaterMark) * performanceFeeBps / 10_000`.
 *   On loss or zero-profit epochs (NAV <= HWM) no performance fee is charged.
 * - The high-water mark is raised to `navBeforeFees` only when a new high
 *   is reached; it is never lowered on loss epochs.
 * - Dust policy: fees are floored to the smallest representable unit; a
 *   sub-unit fee rounds to zero rather than accruing forever.
 */
export function computeEpochFees(
  navBeforeFees: number,
  policy: Pick<VaultFeePolicy, "managementFeeBps" | "performanceFeeBps" | "highWaterMark">,
): { managementFee: number; performanceFee: number; totalFee: number; highWaterMarkAfter: number } {
  const nav = Math.max(0, navBeforeFees);
  const managementFee = Math.floor((nav * policy.managementFeeBps) / 10_000);
  const gains = Math.max(0, nav - policy.highWaterMark);
  const performanceFee = Math.floor((gains * policy.performanceFeeBps) / 10_000);
  const highWaterMarkAfter = nav > policy.highWaterMark ? nav : policy.highWaterMark;
  return {
    managementFee,
    performanceFee,
    totalFee: managementFee + performanceFee,
    highWaterMarkAfter,
  };
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
  | "TRANSFERS_DISABLED"
  | "FEE_BPS_OUT_OF_BOUNDS";

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
    ["FEE_BPS_OUT_OF_BOUNDS", /FEE[_ ]?BPS|BPS[_ ]?OUT[_ ]?OF[_ ]?BOUNDS|FEE[_ ]?TOO[_ ]?HIGH/],
    ["AUTHORIZATION_FAILED", /AUTHORIZ|UNAUTHORIZED|NOT[_ ]?AUTHORIZED/],
  ];
  for (const [code, pattern] of table) {
    if (pattern.test(normalized)) return code;
  }
  return null;
}
