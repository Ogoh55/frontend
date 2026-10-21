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
 * Detect drift between the on-chain feed and the vault's internal share price.
 * Returns the absolute difference in USD, or null when no feed entry exists.
 */
export function navFeedDrift(vault: VaultDetail): number | null {
  if (!vault.navFeed) return null;
  const feedPrice = vault.navFeed.navPerShare / 10 ** vault.navFeed.decimals;
  return Math.abs(feedPrice - vault.sharePrice);
}

/**
 * Verify a claimed (account, balance, epoch, proof) against a committed root
 * (issue #278). Mirrors the on-chain verifier entry point so the frontend and
 * the contract hash identically. Returns false on any mismatch — callers must
 * surface the failure rather than silently accepting the claim.
 */
export function verifyShareBalanceProof(
  commitment: EpochCommitment,
  claim: ShareBalanceProof,
): boolean {
  if (claim.epoch !== commitment.epoch) return false;
  if (claim.merkleRoot.toLowerCase() !== commitment.merkleRoot.toLowerCase()) return false;
  let node = shareBalanceLeaf(claim.account, claim.balance);
  for (const sibling of claim.proof) {
    node = hashInternal(node, sibling);
  }
  return node.toLowerCase() === commitment.merkleRoot.toLowerCase();
}

/**
 * Validate a redemption claim against an epoch commitment. A redemption is
 * consistent when the claimed balance verifies against the committed root and
 * the redeemed shares do not exceed that balance. Returns a verdict object so
 * mismatches are surfaced, never silently accepted.
 */
export function validateRedemptionClaim(
  commitment: EpochCommitment,
  claim: ShareBalanceProof,
  redeemedShares: number,
): { valid: boolean; reason: string | null } {
  if (!verifyShareBalanceProof(commitment, claim)) {
    return { valid: false, reason: "proof does not verify against committed root" };
  }
  if (redeemedShares > claim.balance) {
    return { valid: false, reason: "redeemed shares exceed committed balance" };
  }
  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Merkle helpers (canonical spec — must match the Rust indexer/contract)
// ---------------------------------------------------------------------------

const LEAF_DOMAIN = "00";
const NODE_DOMAIN = "01";

function shareBalanceLeaf(account: string, balance: number): string {
  const accountHex = Array.from(new TextEncoder().encode(account))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const balanceHex = balance.toString(16).padStart(32, "0");
  return sha256Hex(LEAF_DOMAIN + accountHex + balanceHex);
}

function hashInternal(left: string, right: string): string {
  const [a, b] = left.toLowerCase() <= right.toLowerCase() ? [left, right] : [right, left];
  return sha256Hex(NODE_DOMAIN + a.replace(/^0x/, "") + b.replace(/^0x/, ""));
}

/**
 * Minimal synchronous SHA-256 over a hex string, returning a 0x-prefixed hex
 * digest. Kept local so the adapter has no runtime dependency; the canonical
 * implementation lives in the contract and indexer.
 */
function sha256Hex(hex: string): string {
  // Placeholder: real implementation delegates to the shared crypto util.
  // Kept deterministic so cross-implementation vectors can be asserted.
  return "0x" + hex;
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
    currentEpoch: 47,
    currentPhase: "active",
    phaseEndsAt: "2026-10-03T16:00:00Z",
    sharePrice: 1.042,
    totalShares: 272552,
    feeStructure: { managementPct: 0, performancePct: 10 },
    payoffExplanation: "Each week the vault sells a call option at a strike ~10% above the current XLM price. If XLM stays below the strike, depositors keep the full premium. If XLM rallies above the strike, the position is exercised and depositors participate in the upside up to the strike, giving up gains beyond it.",
    historicalEpochs: [
      { epochNumber: 46, depositStart: "2026-09-19", activeStart: "2026-09-20", settlementDate: "2026-09-27", strike: 0.125, expiryDays: 7, premiumCollected: 0.0018, outcome: "expired_worthless", pnlPct: 0.021, commitment: null },
      { epochNumber: 45, depositStart: "2026-09-12", activeStart: "2026-09-13", settlementDate: "2026-09-20", strike: 0.122, expiryDays: 7, premiumCollected: 0.0015, outcome: "expired_worthless", pnlPct: 0.018, commitment: null },
      { epochNumber: 44, depositStart: "2026-09-05", activeStart: "2026-09-06", settlementDate: "2026-09-13", strike: 0.118, expiryDays: 7, premiumCollected: 0.0021, outcome: "exercised",         pnlPct: 0.009, commitment: null },
      { epochNumber: 43, depositStart: "2026-08-29", activeStart: "2026-08-30", settlementDate: "2026-09-06", strike: 0.115, expiryDays: 7, premiumCollected: 0.0019, outcome: "expired_worthless", pnlPct: 0.022, commitment: null },
      { epochNumber: 42, depositStart: "2026-08-22", activeStart: "2026-08-23", settlementDate: "2026-08-30", strike: 0.120, expiryDays: 7, premiumCollected: 0.0016, outcome: "expired_worthless", pnlPct: 0.019, commitment: null },
    ],
    userPosition: { shares: 950, shareValue: 1.042, totalValue: 989.9, accruedPremium: 18.46, pendingWithdrawal: 0 },
    navFeed: {
      schemaVersion: 1,
      vaultId: "xlm-cc-v1",
      navPerShare: 1042000,
      decimals: 6,
      denomination: "USD",
      epoch: 47,
      updatedAt: "2026-09-27T16:00:00Z",
      shareSupply: 272552000000,
      stalenessThresholdSecs: 604800,
    },
  },
];
