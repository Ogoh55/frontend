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
 *
 *   GET /api/v1/vaults/{id}/nav-feed
 *   → NavFeedEntry   (on-chain NAV-per-share feed, issue #277)
 *
 *   GET /api/v1/vaults/{id}/epochs/{epoch}/commitment
 *   → EpochCommitment   (share-balance Merkle commitment, issue #278)
 *
 *   GET /api/v1/vaults/{id}/epochs/{epoch}/proof?account={account}
 *   → ShareBalanceProof   (Merkle proof for a depositor's balance, issue #278)
 *
 *   GET /api/v1/vaults/{id}/positions
 *   → WrittenPosition[]   (open written positions, issue #279)
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/**
 * On-chain NAV / share-price feed entry (issue #277).
 *
 * The feed contract is a thin, append-only reader of committed values — the
 * vault remains the single source of truth. Consumers should read this shape
 * rather than deriving a price themselves.
 *
 * Consumer contract:
 * - `navPerShare` is the committed NAV per share for `epoch`, denominated in
 *   `denomination` (explicitly stated; multi-asset vaults report the quote
 *   asset, e.g. "USD").
 * - `decimals` is the number of decimals consumers must assume for
 *   `navPerShare` (and `shareSupply`). Do not infer precision from the value.
 * - `schemaVersion` lets consumers detect a breaking change to this shape.
 * - `updatedAt` is the ledger time of the update. A value is STALE when
 *   `now - updatedAt > stalenessThresholdSecs`; a stale value means the vault
 *   skipped or delayed an epoch and the price must NOT be trusted as current.
 *   Stale values are reported, never silently refreshed.
 * - Rounding: `navPerShare` is truncated (not rounded up) to `decimals`; very
 *   small share supplies may therefore lose precision — consumers must treat
 *   the value as a lower bound, not an exact quote.
 */
export interface NavFeedEntry {
  /** Feed schema version; bump on any breaking change to this shape. */
  schemaVersion: number;
  /** Vault the value belongs to. */
  vaultId: string;
  /** Committed NAV per share, scaled by 10^decimals. */
  navPerShare: number;
  /** Decimals consumers must assume for navPerShare / shareSupply. */
  decimals: number;
  /** Denomination of navPerShare (explicit for multi-asset vaults). */
  denomination: string;
  /** Epoch number the committed value came from. */
  epoch: number;
  /** Ledger time (ISO) the feed entry was last updated. */
  updatedAt: string;
  /** Total share supply at commit time, scaled by 10^decimals. */
  shareSupply: number;
  /** Age (seconds) beyond which the value is considered stale. */
  stalenessThresholdSecs: number;
}

/**
 * On-chain share-balance Merkle commitment for one epoch (issue #278).
 *
 * Tree construction spec (canonical, versioned via `commitmentVersion`):
 * - Leaf encoding: `sha256(0x00 || account_utf8 || 0x00 || balance_u128_be)`.
 *   `account` is the canonical Stellar account string (G.../C...); `balance`
 *   is the share balance scaled by 10^decimals, encoded as a 16-byte
 *   big-endian unsigned integer. The 0x00 domain prefix separates leaves
 *   from internal nodes.
 * - Ordering rule: leaves are sorted ascending by the raw 32-byte leaf hash
 *   (byte-wise lexicographic). Ordering is therefore independent of input
 *   order and stable across implementations.
 * - Internal nodes: `sha256(0x01 || left || right)`.
 * - Odd node at any level is promoted unchanged to the next level (no
 *   duplication). An empty epoch commits the all-zero root; a single-holder
 *   epoch commits that holder's leaf hash as the root.
 * - Max committed size: 4096 leaves per epoch (Soroban resource budget).
 *   Epochs exceeding this commit a `chunked` commitment: the root is the
 *   root over per-chunk roots, and `chunkCount` is published so verifiers can
 *   reconstruct the same tree.
 */
export interface EpochCommitment {
  /** Commitment schema version; bump on any breaking change to the spec. */
  commitmentVersion: number;
  /** Vault the commitment belongs to. */
  vaultId: string;
  /** Epoch number the snapshot was taken at. */
  epoch: number;
  /** Merkle root over the epoch's share balances (hex, 0x-prefixed). */
  merkleRoot: string;
  /** Number of leaves committed in the epoch. */
  leafCount: number;
  /** Number of chunks when the epoch exceeded the max committed size. */
  chunkCount: number;
  /** NAV per share committed alongside the root, scaled by 10^decimals. */
  navPerShare: number;
  /** Decimals for navPerShare / balances. */
  decimals: number;
  /** Ledger time (ISO) the commitment was written on-chain. */
  committedAt: string;
}

/** Merkle proof for a single depositor's share balance at an epoch. */
export interface ShareBalanceProof {
  /** Vault the proof belongs to. */
  vaultId: string;
  /** Epoch the proof is against. */
  epoch: number;
  /** Account the balance belongs to. */
  account: string;
  /** Share balance, scaled by 10^decimals. */
  balance: number;
  /** Sibling hashes from leaf to root (hex, 0x-prefixed). */
  proof: string[];
  /** Root the proof should verify against. */
  merkleRoot: string;
}

/**
 * Option leg type for a written position (issue #279).
 * `call`/`put` are single-leg; `iron_condor` positions carry two legs and
 * are represented as two `WrittenPosition` rows sharing a `groupId`.
 */
export type OptionType = "call" | "put";

/**
 * One open written option position held by a vault (issue #279).
 *
 * These are the inputs the risk panel needs to compute assignment
 * probability, max loss, breakeven, and aggregate Greeks. All fields are
 * sourced from the same places used elsewhere in the app (spot from the
 * vault's underlying price feed, IV from the pricing layer, strike/expiry
 * from the vault contract).
 *
 * Consumers must treat any `null` input as "unavailable" and degrade the
 * panel rather than substituting a default — a missing IV or stale spot feed
 * must never render a modelled number.
 */
export interface WrittenPosition {
  /** Stable id for the position (used as React key / memo key). */
  id: string;
  /** Vault that wrote the position. */
  vaultId: string;
  /** Epoch the position was written in. */
  epoch: number;
  /** Strategy bucket the position belongs to. */
  strategy: VaultStrategy;
  /** Leg type. */
  type: OptionType;
  /** Strike price in the underlying's quote currency. */
  strike: number;
  /** Expiry as an ISO date. */
  expiry: string;
  /** Number of contracts written (1 contract = 100 shares). */
  contracts: number;
  /** Notional in USD (contracts * 100 * spot at write time). */
  notional: number;
  /** Premium collected per contract, in USD. */
  premiumPerContract: number;
  /** Implied volatility used for pricing (annualised, e.g. 0.65 = 65%). */
  impliedVol: number | null;
  /** Spot price of the underlying at the time of the snapshot. */
  spot: number | null;
  /** Ledger time (ISO) the spot/IV inputs were captured. */
  inputsAsOf: string | null;
  /** Optional backend-provided Greeks; override local estimates when set. */
  greeks?: Partial<PositionGreeks> | null;
  /** Optional backend-provided assignment probability (0–1). */
  assignmentProbability?: number | null;
  /** Groups legs of a multi-leg strategy (e.g. iron condor). */
  groupId?: string | null;
}

/** Per-position Greeks (issue #279). */
export interface PositionGreeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
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
  /** Committed share-balance Merkle root for this epoch (issue #278). */
  commitment: EpochCommitment | null;
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
  /** On-chain NAV feed entry for reconciliation against `sharePrice`. */
  navFeed: NavFeedEntry | null;
  /**
   * Open written positions for the current epoch (issue #279).
   * Empty array means the vault has no open written exposure; `null` means
   * the positions feed is unavailable and the risk panel must degrade.
   */
  writtenPositions: WrittenPosition[] | null;
}

/**
 * Staleness verdict for a feed entry, callable by consumers.
 * A vault that skips or delays an epoch goes stale — the feed never lies.
 */
export function isNavFeedStale(entry: NavFeedEntry, now: Date = new Date()): boolean {
  const ageSecs = (now.getTime() - new Date(entry.updatedAt).getTime()) / 1000;
  return ageSecs > entry.stalenessThresholdSecs;
}

/**
 * Detect dri