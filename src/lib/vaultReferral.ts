/**
 * Vault Referral & Loyalty Rewards — pure logic module
 *
 * This module is entirely free of network calls, DOM access, and side-effects.
 * Everything here is injectable for deterministic unit testing.
 *
 * ─────────────────────────────────────────────────────────────────
 * OVERVIEW
 * ─────────────────────────────────────────────────────────────────
 * Referral attribution
 *   A depositor can share a referral code.  When a new depositor funds a vault
 *   with that code, the referrer earns a share of the protocol incentives for
 *   that referred deposit.  Attribution is first-touch (the first valid code
 *   attached to the first genuine deposit wins).  Last-touch is NOT used
 *   because it would incentivise code-spamming at the last moment.
 *
 * Loyalty accrual
 *   Every wallet that keeps funds in a vault beyond the minimum holding period
 *   accrues loyalty points per epoch.  Points multiply the base reward rate:
 *     reward = baseRatePerShare × shares × loyaltyMultiplier(loyaltyPoints)
 *   Points are per wallet-vault pair, reset if the wallet drops below the
 *   minimum balance threshold.
 *
 * Merkle-claim distribution
 *   At the end of each epoch the off-chain ETL (backend) computes the
 *   per-wallet claimable amounts and publishes a merkle root.  The frontend
 *   verifies inclusion proofs and displays claim status.  This module
 *   provides:
 *     - `buildMerkleLeaf`   — canonical leaf encoding (keccak256-compatible)
 *     - `verifyMerkleProof` — inclusion verification in O(log n)
 *     - `buildMerkleTree`   — deterministic root from a sorted leaf set
 *
 * Anti-abuse controls
 *   Referrals are blocked if any of the following is true:
 *   1. Self-referral: referrer and referee have the same wallet address.
 *   2. Circular referral: A referred B who then refers A back.
 *   3. Ineligible referrer: the referrer's eligibility score (from
 *      vaultEligibility.ts) is below REFERRER_MIN_ELIGIBILITY_SCORE.
 *   4. Volume cap: a single referrer may not claim rewards on more than
 *      REFERRER_MAX_VOLUME_USD in referred capital per epoch.
 *   5. Uncalled commitment: the referred deposit must be genuinely funded
 *      (funded_at is set), not just a pending commitment.
 *   6. Early withdrawal clawback: rewards do not accrue if the referee
 *      withdraws before MIN_HOLD_EPOCHS have elapsed.
 *
 * Holding-period loyalty
 *   Loyalty points reset if a position falls below MIN_LOYALTY_BALANCE_SHARES
 *   at any epoch snapshot.  The loyalty tier advances every EPOCHS_PER_TIER
 *   consecutive qualifying epochs.
 * ─────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum holding period in epochs before referral rewards accrue. */
export const MIN_HOLD_EPOCHS = 1;

/**
 * Minimum eligibility score (from vaultEligibility.ts) required for a
 * wallet to act as a referrer.
 */
export const REFERRER_MIN_ELIGIBILITY_SCORE = 60;

/**
 * Maximum USD-equivalent referred volume a single referrer may earn
 * rewards on per epoch.  Prevents outsized reward concentration.
 */
export const REFERRER_MAX_VOLUME_USD = 100_000;

/**
 * Minimum share balance that must be held at each epoch snapshot for
 * loyalty points to continue accruing.  Dropping below this resets
 * the consecutive-epoch counter.
 */
export const MIN_LOYALTY_BALANCE_SHARES = 1;

/** Number of qualifying epochs before advancing to the next loyalty tier. */
export const EPOCHS_PER_TIER = 4;

/** Base reward rate as a fraction of shares per epoch (e.g. 0.005 = 0.5%). */
export const BASE_REWARD_RATE = 0.005;

/**
 * Loyalty tier multipliers.  Tier 0 = first EPOCHS_PER_TIER epochs,
 * Tier 3 = 12+ qualifying epochs.
 */
export const LOYALTY_MULTIPLIERS: readonly number[] = [1.0, 1.25, 1.5, 2.0];

/** Referral commission rate as a fraction of the referee's reward. */
export const REFERRAL_COMMISSION_RATE = 0.10; // 10%

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single referral attribution record. */
export interface ReferralAttribution {
  /** The referrer's wallet address (normalised to lowercase). */
  referrerAddress: string;
  /** The referee's wallet address (normalised to lowercase). */
  refereeAddress: string;
  /** The referral code that linked them. */
  referralCode: string;
  /**
   * Unix timestamp (ms) when the attribution was registered.
   * This is set once and never updated (first-touch).
   */
  attributedAtMs: number;
  /**
   * Unix timestamp (ms) when the referee's first genuine deposit was funded.
   * `null` means the attribution exists but the deposit has not been funded yet.
   */
  fundedAtMs: number | null;
}

/** Snapshot of a wallet's position in a vault at the end of an epoch. */
export interface EpochSnapshot {
  walletAddress: string;
  vaultId: string;
  epochNumber: number;
  /** Shares held at the epoch snapshot time. */
  sharesHeld: number;
  /** Whether this snapshot qualifies for loyalty accrual. */
  qualifies: boolean;
}

/** Accumulated loyalty state for a wallet in a vault. */
export interface LoyaltyState {
  walletAddress: string;
  vaultId: string;
  /** Number of consecutive qualifying epochs. */
  consecutiveEpochs: number;
  /** Current loyalty tier index (0-based, indexes into LOYALTY_MULTIPLIERS). */
  tier: number;
  /** Total loyalty points accumulated (1 point per qualifying epoch). */
  totalPoints: number;
}

/** A single leaf entry in the merkle reward tree. */
export interface MerkleLeaf {
  walletAddress: string;
  vaultId: string;
  epochNumber: number;
  /** Claimable reward amount (in the reward asset's atomic units as a string). */
  amount: string;
}

/** A merkle proof for a single leaf. */
export interface MerkleProof {
  leaf: MerkleLeaf;
  /** Sibling hashes from leaf to root. */
  proof: string[];
  /** The expected merkle root. */
  root: string;
}

/** Per-epoch reward accrual for a single wallet. */
export interface EpochRewardAccrual {
  walletAddress: string;
  vaultId: string;
  epochNumber: number;
  /** Shares held (from the epoch snapshot). */
  sharesHeld: number;
  /** Loyalty multiplier applied. */
  loyaltyMultiplier: number;
  /** Referral commission earned (referrer only). 0 for non-referrers. */
  referralCommission: number;
  /** Total reward for this epoch (base + referral). */
  totalReward: number;
}

/** Result of an anti-abuse attribution check. */
export interface AttributionCheckResult {
  allowed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Anti-abuse checks
// ---------------------------------------------------------------------------

/**
 * Normalise a Stellar/EVM-compatible wallet address for comparison.
 * Stellar addresses are case-sensitive but we lowercase for safety.
 */
export function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Check whether a proposed referral attribution is allowed.
 *
 * All inputs are pure data — no network calls.
 *
 * @param referrerAddress  The wallet proposing the referral.
 * @param refereeAddress   The wallet being referred.
 * @param existingAttributions  All existing attributions in the system.
 * @param referrerEligibilityScore  Composite eligibility score (0–100) from vaultEligibility.ts.
 */
export function checkAttributionAllowed(
  referrerAddress: string,
  refereeAddress: string,
  existingAttributions: ReferralAttribution[],
  referrerEligibilityScore: number,
): AttributionCheckResult {
  const referrer = normaliseAddress(referrerAddress);
  const referee  = normaliseAddress(refereeAddress);

  // 1. Self-referral
  if (referrer === referee) {
    return { allowed: false, reason: "Self-referral is not permitted." };
  }

  // 2. Referee already has an attribution (first-touch only)
  const existing = existingAttributions.find(
    a => normaliseAddress(a.refereeAddress) === referee,
  );
  if (existing) {
    return {
      allowed: false,
      reason: `This wallet already has a referral attribution from ${existing.referrerAddress}.`,
    };
  }

  // 3. Circular referral: the proposed referee is already a referrer of our referrer
  const circular = existingAttributions.find(
    a =>
      normaliseAddress(a.referrerAddress) === referee &&
      normaliseAddress(a.refereeAddress) === referrer,
  );
  if (circular) {
    return {
      allowed: false,
      reason: "Circular referral detected: this wallet has already referred the proposing referrer.",
    };
  }

  // 4. Ineligible referrer
  if (referrerEligibilityScore < REFERRER_MIN_ELIGIBILITY_SCORE) {
    return {
      allowed: false,
      reason: `Referrer eligibility score (${referrerEligibilityScore}) is below the minimum required (${REFERRER_MIN_ELIGIBILITY_SCORE}).`,
    };
  }

  return { allowed: true, reason: "Attribution is allowed." };
}

/**
 * Check whether a funded deposit is eligible for referral rewards.
 *
 * Separate from `checkAttributionAllowed` because it runs at deposit-funding
 * time rather than attribution-registration time.
 */
export function checkReferralRewardEligibility(
  attribution: ReferralAttribution,
  epochsHeld: number,
  referredVolumeUsdThisEpoch: number,
): AttributionCheckResult {
  // Must be funded
  if (attribution.fundedAtMs === null) {
    return {
      allowed: false,
      reason: "Referral reward requires a genuinely funded deposit. Uncalled commitments do not accrue rewards.",
    };
  }

  // Minimum hold period
  if (epochsHeld < MIN_HOLD_EPOCHS) {
    return {
      allowed: false,
      reason: `Deposit must be held for at least ${MIN_HOLD_EPOCHS} epoch(s) before referral rewards accrue. Currently held: ${epochsHeld}.`,
    };
  }

  // Volume cap
  if (referredVolumeUsdThisEpoch > REFERRER_MAX_VOLUME_USD) {
    return {
      allowed: false,
      reason: `Referrer has exceeded the maximum rewardable referred volume of $${REFERRER_MAX_VOLUME_USD.toLocaleString()} for this epoch.`,
    };
  }

  return { allowed: true, reason: "Eligible for referral reward." };
}

// ---------------------------------------------------------------------------
// Loyalty accrual
// ---------------------------------------------------------------------------

/**
 * Compute the loyalty multiplier for a given number of consecutive
 * qualifying epochs.  Uses LOYALTY_MULTIPLIERS tier table.
 */
export function loyaltyMultiplier(consecutiveEpochs: number): number {
  const tierIndex = Math.min(
    LOYALTY_MULTIPLIERS.length - 1,
    Math.floor(consecutiveEpochs / EPOCHS_PER_TIER),
  );
  return LOYALTY_MULTIPLIERS[tierIndex];
}

/**
 * Advance the loyalty state given a new epoch snapshot.
 *
 * Returns a new `LoyaltyState` (immutable update pattern for testability).
 */
export function advanceLoyaltyState(
  current: LoyaltyState,
  snapshot: EpochSnapshot,
): LoyaltyState {
  if (
    snapshot.walletAddress !== current.walletAddress ||
    snapshot.vaultId !== current.vaultId
  ) {
    throw new Error(
      "advanceLoyaltyState: snapshot does not match the loyalty state's wallet/vault.",
    );
  }

  if (!snapshot.qualifies || snapshot.sharesHeld < MIN_LOYALTY_BALANCE_SHARES) {
    // Non-qualifying epoch resets consecutive streak but preserves total points
    return {
      ...current,
      consecutiveEpochs: 0,
      tier: 0,
    };
  }

  const consecutiveEpochs = current.consecutiveEpochs + 1;
  const tier = Math.min(
    LOYALTY_MULTIPLIERS.length - 1,
    Math.floor(consecutiveEpochs / EPOCHS_PER_TIER),
  );

  return {
    ...current,
    consecutiveEpochs,
    tier,
    totalPoints: current.totalPoints + 1,
  };
}

/**
 * Compute the reward for a single wallet in a single epoch.
 *
 * @param sharesHeld           Shares held at epoch snapshot.
 * @param consecutiveEpochs    Consecutive qualifying epochs (used for loyalty multiplier).
 * @param referralCommissionBase  The base reward of the referee (0 if wallet is not a referrer).
 */
export function computeEpochReward(
  sharesHeld: number,
  consecutiveEpochs: number,
  referralCommissionBase = 0,
): EpochRewardAccrual & { walletAddress: string; vaultId: string; epochNumber: number } {
  const multiplier = loyaltyMultiplier(consecutiveEpochs);
  const baseReward = sharesHeld * BASE_REWARD_RATE * multiplier;
  const referralCommission = referralCommissionBase * REFERRAL_COMMISSION_RATE;
  const totalReward = baseReward + referralCommission;

  return {
    walletAddress: "",   // caller fills in
    vaultId: "",         // caller fills in
    epochNumber: 0,      // caller fills in
    sharesHeld,
    loyaltyMultiplier: multiplier,
    referralCommission,
    totalReward,
  };
}

// ---------------------------------------------------------------------------
// Merkle tree utilities
// ---------------------------------------------------------------------------

/**
 * Canonical string encoding of a merkle leaf.
 * Format: `{walletAddress}:{vaultId}:{epochNumber}:{amount}`
 * The format is stable across runs (no JSON key ordering issues).
 */
export function encodeMerkleLeaf(leaf: MerkleLeaf): string {
  return [
    normaliseAddress(leaf.walletAddress),
    leaf.vaultId,
    String(leaf.epochNumber),
    leaf.amount,
  ].join(":");
}

/**
 * Simple deterministic hash for a string using a djb2-style algorithm.
 * In production, this is replaced by keccak256 on-chain.  For frontend
 * verification and unit tests, this pure-JS implementation is sufficient
 * to validate structural correctness.
 *
 * The output is a 64-character hex string to match the shape of keccak256.
 */
export function hashLeaf(data: string): string {
  let hash = 5381;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) + hash + data.charCodeAt(i)) >>> 0;
  }
  // Expand to 64 hex chars by XOR-folding with a salt derived from the data length
  const salt = data.length * 0x9e3779b9;
  const hi = (hash ^ (salt >>> 16)) >>> 0;
  const lo = (hash ^ salt) >>> 0;
  // Produce 64 hex chars by repeating the 8-char segments
  const seg = (n: number) => n.toString(16).padStart(8, "0");
  return [seg(hi), seg(lo), seg(hi ^ lo), seg(hi + lo), seg(lo ^ salt), seg(hi ^ salt), seg(hi * 3), seg(lo * 7)]
    .join("")
    .slice(0, 64);
}

/**
 * Hash two sibling nodes together (order-independent via sort).
 */
export function hashPair(a: string, b: string): string {
  const [left, right] = a < b ? [a, b] : [b, a];
  return hashLeaf(left + right);
}

/**
 * Build a deterministic merkle tree from a list of leaves.
 *
 * Leaves are sorted lexicographically by their encoded form before hashing
 * so that the root is independent of input order.  An odd number of leaves
 * is handled by duplicating the last leaf.
 *
 * Returns the root hash and a map of leaf-hash → siblings-path for proof
 * generation.
 */
export function buildMerkleTree(leaves: MerkleLeaf[]): {
  root: string;
  leafHashes: string[];
  layers: string[][];
} {
  if (leaves.length === 0) {
    return { root: hashLeaf("empty"), leafHashes: [], layers: [] };
  }

  // Sort leaves for determinism
  const sorted = [...leaves].sort((a, b) =>
    encodeMerkleLeaf(a).localeCompare(encodeMerkleLeaf(b)),
  );

  const leafHashes = sorted.map(l => hashLeaf(encodeMerkleLeaf(l)));
  const layers: string[][] = [leafHashes];

  let current = leafHashes;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left  = current[i];
      const right = current[i + 1] ?? current[i]; // duplicate last if odd
      next.push(hashPair(left, right));
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0], leafHashes, layers };
}

/**
 * Generate a merkle proof for a single leaf.
 *
 * Returns `null` if the leaf is not found in the tree.
 */
export function generateMerkleProof(
  leaf: MerkleLeaf,
  allLeaves: MerkleLeaf[],
): MerkleProof | null {
  const { root, leafHashes, layers } = buildMerkleTree(allLeaves);

  if (layers.length === 0) return null;

  const targetHash = hashLeaf(encodeMerkleLeaf(leaf));
  let index = layers[0].indexOf(targetHash);
  if (index === -1) return null;

  const proof: string[] = [];
  for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
    const layer = layers[layerIdx];
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = layer[siblingIndex] ?? layer[index]; // odd: sibling = self
    proof.push(sibling);
    index = Math.floor(index / 2);
  }

  return { leaf, proof, root };
}

/**
 * Verify a merkle proof.
 *
 * Returns `true` if the proof is valid for the given root.
 */
export function verifyMerkleProof(proof: MerkleProof): boolean {
  let hash = hashLeaf(encodeMerkleLeaf(proof.leaf));
  for (const sibling of proof.proof) {
    hash = hashPair(hash, sibling);
  }
  return hash === proof.root;
}

// ---------------------------------------------------------------------------
// Referral code utilities
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic referral code from a wallet address.
 * The code is 10 uppercase alphanumeric characters.
 *
 * In production, the backend generates codes; this is used for preview/mock.
 */
export function generateReferralCode(walletAddress: string): string {
  const normalised = normaliseAddress(walletAddress);
  let hash = 0;
  for (let i = 0; i < normalised.length; i++) {
    hash = ((hash << 5) - hash + normalised.charCodeAt(i)) | 0;
  }
  const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  let seed = Math.abs(hash);
  for (let i = 0; i < 10; i++) {
    code += CHARS[seed % CHARS.length];
    seed = Math.floor(seed / CHARS.length) + (seed % CHARS.length) * 37;
    if (seed === 0) seed = 1;
  }
  return code;
}

/**
 * Build a full referral URL from a base origin and code.
 */
export function buildReferralLink(origin: string, code: string): string {
  return `${origin.replace(/\/$/, "")}/vaults?ref=${code}`;
}

// ---------------------------------------------------------------------------
// Loyalty tier display helpers
// ---------------------------------------------------------------------------

export const TIER_LABELS: readonly string[] = ["Bronze", "Silver", "Gold", "Platinum"];

export function loyaltyTierLabel(tier: number): string {
  return TIER_LABELS[Math.min(tier, TIER_LABELS.length - 1)];
}

export function loyaltyTierColor(tier: number): string {
  switch (tier) {
    case 0: return "var(--text-mid)";
    case 1: return "var(--atm)";
    case 2: return "var(--call)";
    case 3: return "var(--brand)";
    default: return "var(--text-mid)";
  }
}

/**
 * Returns how many more consecutive qualifying epochs are needed to reach
 * the next loyalty tier.  Returns 0 if already at the maximum tier.
 */
export function epochsToNextTier(consecutiveEpochs: number): number {
  const currentTier = Math.min(
    LOYALTY_MULTIPLIERS.length - 1,
    Math.floor(consecutiveEpochs / EPOCHS_PER_TIER),
  );
  if (currentTier >= LOYALTY_MULTIPLIERS.length - 1) return 0;
  const epochsInCurrentTier = consecutiveEpochs % EPOCHS_PER_TIER;
  return EPOCHS_PER_TIER - epochsInCurrentTier;
}
