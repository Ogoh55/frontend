/**
 * Unit tests for src/lib/vaultReferral.ts
 *
 * Tests cover:
 *   - Attribution rules (allowed, self-referral, circular, ineligible, first-touch)
 *   - Reward eligibility (funded, hold period, volume cap)
 *   - Loyalty accrual (streak advance, reset, tier promotion)
 *   - Loyalty multipliers and tier helpers
 *   - Epoch reward computation
 *   - Merkle tree construction (determinism, odd/even leaves)
 *   - Merkle proof generation and verification
 *   - Repeated recompute produces identical merkle root
 *   - Referral code generation (format, determinism)
 *   - Edge cases: empty trees, unknown addresses, clawback, max tier
 */

import { describe, it, expect } from "vitest";
import {
  // Constants
  MIN_HOLD_EPOCHS,
  REFERRER_MIN_ELIGIBILITY_SCORE,
  REFERRER_MAX_VOLUME_USD,
  MIN_LOYALTY_BALANCE_SHARES,
  EPOCHS_PER_TIER,
  BASE_REWARD_RATE,
  REFERRAL_COMMISSION_RATE,
  LOYALTY_MULTIPLIERS,

  // Attribution checks
  checkAttributionAllowed,
  checkReferralRewardEligibility,

  // Loyalty
  loyaltyMultiplier,
  advanceLoyaltyState,
  computeEpochReward,
  epochsToNextTier,

  // Merkle
  encodeMerkleLeaf,
  hashLeaf,
  hashPair,
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,

  // Utilities
  generateReferralCode,
  buildReferralLink,
  normaliseAddress,
  loyaltyTierLabel,
  loyaltyTierColor,

  type ReferralAttribution,
  type LoyaltyState,
  type EpochSnapshot,
  type MerkleLeaf,
} from "./vaultReferral";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAttribution(overrides: Partial<ReferralAttribution> = {}): ReferralAttribution {
  return {
    referrerAddress: "GAAA1111",
    refereeAddress: "GBBB2222",
    referralCode: "TESTCODE1",
    attributedAtMs: Date.now() - 86400_000,
    fundedAtMs: Date.now() - 3600_000,
    ...overrides,
  };
}

function makeLoyaltyState(overrides: Partial<LoyaltyState> = {}): LoyaltyState {
  return {
    walletAddress: "GAAA1111",
    vaultId: "xlm-cc-v1",
    consecutiveEpochs: 0,
    tier: 0,
    totalPoints: 0,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<EpochSnapshot> = {}): EpochSnapshot {
  return {
    walletAddress: "GAAA1111",
    vaultId: "xlm-cc-v1",
    epochNumber: 1,
    sharesHeld: 100,
    qualifies: true,
    ...overrides,
  };
}

function makeLeaf(overrides: Partial<MerkleLeaf> = {}): MerkleLeaf {
  return {
    walletAddress: "GAAA1111",
    vaultId: "xlm-cc-v1",
    epochNumber: 1,
    amount: "4750000",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Attribution checks
// ---------------------------------------------------------------------------

describe("checkAttributionAllowed", () => {
  it("allows a valid attribution with no conflicts", () => {
    const result = checkAttributionAllowed("GAAA", "GBBB", [], 80);
    expect(result.allowed).toBe(true);
  });

  it("blocks self-referral", () => {
    const result = checkAttributionAllowed("GAAA", "GAAA", [], 80);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/self-referral/i);
  });

  it("blocks self-referral case-insensitively", () => {
    const result = checkAttributionAllowed("GAAA", "gaaa", [], 80);
    expect(result.allowed).toBe(false);
  });

  it("blocks if referee already has an attribution (first-touch)", () => {
    const existing = [makeAttribution({ refereeAddress: "GBBB" })];
    const result = checkAttributionAllowed("GAAA", "GBBB", existing, 80);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/already has a referral/i);
  });

  it("blocks circular referral (referee has already referred our referrer)", () => {
    // GBBB referred GAAA → now GAAA tries to refer GBBB back
    const existing = [makeAttribution({ referrerAddress: "GBBB", refereeAddress: "GAAA" })];
    const result = checkAttributionAllowed("GAAA", "GBBB", existing, 80);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/circular/i);
  });

  it("blocks ineligible referrer (score below minimum)", () => {
    const result = checkAttributionAllowed("GAAA", "GBBB", [], REFERRER_MIN_ELIGIBILITY_SCORE - 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/eligibility score/i);
  });

  it("allows referrer with exactly the minimum eligibility score", () => {
    const result = checkAttributionAllowed("GAAA", "GBBB", [], REFERRER_MIN_ELIGIBILITY_SCORE);
    expect(result.allowed).toBe(true);
  });

  it("does not block if a different wallet has an attribution for the same referrer", () => {
    // GAAA already referred GCCC; GAAA wants to refer GBBB — allowed
    const existing = [makeAttribution({ referrerAddress: "GAAA", refereeAddress: "GCCC" })];
    const result = checkAttributionAllowed("GAAA", "GBBB", existing, 80);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Referral reward eligibility
// ---------------------------------------------------------------------------

describe("checkReferralRewardEligibility", () => {
  it("allows an eligible funded deposit that has been held long enough", () => {
    const attr = makeAttribution({ fundedAtMs: Date.now() - 10_000 });
    const result = checkReferralRewardEligibility(attr, MIN_HOLD_EPOCHS, 0);
    expect(result.allowed).toBe(true);
  });

  it("blocks unfunded (commitment-only) deposits", () => {
    const attr = makeAttribution({ fundedAtMs: null });
    const result = checkReferralRewardEligibility(attr, MIN_HOLD_EPOCHS, 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/funded deposit/i);
  });

  it("blocks early withdrawal — epochs held below minimum", () => {
    const attr = makeAttribution();
    const result = checkReferralRewardEligibility(attr, MIN_HOLD_EPOCHS - 1, 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/epoch.*before referral rewards/i);
  });

  it("blocks when referrer has exceeded per-epoch volume cap", () => {
    const attr = makeAttribution();
    const result = checkReferralRewardEligibility(attr, MIN_HOLD_EPOCHS, REFERRER_MAX_VOLUME_USD + 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/volume/i);
  });

  it("allows at exactly the volume cap boundary", () => {
    const attr = makeAttribution();
    const result = checkReferralRewardEligibility(attr, MIN_HOLD_EPOCHS, REFERRER_MAX_VOLUME_USD);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Loyalty multipliers and tier helpers
// ---------------------------------------------------------------------------

describe("loyaltyMultiplier", () => {
  it("returns 1.0x for 0 consecutive epochs (tier 0)", () => {
    expect(loyaltyMultiplier(0)).toBe(LOYALTY_MULTIPLIERS[0]);
  });

  it("returns correct multiplier at tier boundary", () => {
    expect(loyaltyMultiplier(EPOCHS_PER_TIER)).toBe(LOYALTY_MULTIPLIERS[1]);
    expect(loyaltyMultiplier(EPOCHS_PER_TIER * 2)).toBe(LOYALTY_MULTIPLIERS[2]);
    expect(loyaltyMultiplier(EPOCHS_PER_TIER * 3)).toBe(LOYALTY_MULTIPLIERS[3]);
  });

  it("caps at the highest tier", () => {
    expect(loyaltyMultiplier(EPOCHS_PER_TIER * 100)).toBe(
      LOYALTY_MULTIPLIERS[LOYALTY_MULTIPLIERS.length - 1],
    );
  });
});

describe("epochsToNextTier", () => {
  it("returns EPOCHS_PER_TIER for 0 consecutive epochs", () => {
    expect(epochsToNextTier(0)).toBe(EPOCHS_PER_TIER);
  });

  it("decrements correctly within a tier", () => {
    expect(epochsToNextTier(2)).toBe(EPOCHS_PER_TIER - 2);
  });

  it("returns 0 at maximum tier", () => {
    expect(epochsToNextTier(EPOCHS_PER_TIER * 3)).toBe(0);
    expect(epochsToNextTier(EPOCHS_PER_TIER * 100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Loyalty state advancement
// ---------------------------------------------------------------------------

describe("advanceLoyaltyState", () => {
  it("increments consecutiveEpochs and totalPoints on qualifying epoch", () => {
    const state = makeLoyaltyState();
    const snapshot = makeSnapshot({ qualifies: true, sharesHeld: 10 });
    const next = advanceLoyaltyState(state, snapshot);
    expect(next.consecutiveEpochs).toBe(1);
    expect(next.totalPoints).toBe(1);
    expect(next.tier).toBe(0);
  });

  it("advances tier after EPOCHS_PER_TIER qualifying epochs", () => {
    let state = makeLoyaltyState();
    for (let i = 0; i < EPOCHS_PER_TIER; i++) {
      state = advanceLoyaltyState(state, makeSnapshot({ epochNumber: i + 1 }));
    }
    expect(state.tier).toBe(1);
    expect(state.consecutiveEpochs).toBe(EPOCHS_PER_TIER);
  });

  it("resets consecutiveEpochs and tier on non-qualifying epoch", () => {
    let state = makeLoyaltyState({ consecutiveEpochs: EPOCHS_PER_TIER, tier: 1, totalPoints: EPOCHS_PER_TIER });
    const snapshot = makeSnapshot({ qualifies: false, sharesHeld: 0 });
    state = advanceLoyaltyState(state, snapshot);
    expect(state.consecutiveEpochs).toBe(0);
    expect(state.tier).toBe(0);
    // Total points are preserved on reset
    expect(state.totalPoints).toBe(EPOCHS_PER_TIER);
  });

  it("resets when shares fall below minimum balance threshold", () => {
    let state = makeLoyaltyState({ consecutiveEpochs: 3, tier: 0, totalPoints: 3 });
    const snapshot = makeSnapshot({ qualifies: true, sharesHeld: MIN_LOYALTY_BALANCE_SHARES - 1 });
    state = advanceLoyaltyState(state, snapshot);
    expect(state.consecutiveEpochs).toBe(0);
    expect(state.tier).toBe(0);
  });

  it("throws if snapshot does not match wallet/vault", () => {
    const state = makeLoyaltyState({ walletAddress: "GAAA", vaultId: "v1" });
    const badSnapshot = makeSnapshot({ walletAddress: "GCCC", vaultId: "v1" });
    expect(() => advanceLoyaltyState(state, badSnapshot)).toThrow();
  });

  it("caps tier at the maximum tier value", () => {
    let state = makeLoyaltyState();
    for (let i = 0; i < EPOCHS_PER_TIER * (LOYALTY_MULTIPLIERS.length + 5); i++) {
      state = advanceLoyaltyState(state, makeSnapshot({ epochNumber: i + 1 }));
    }
    expect(state.tier).toBe(LOYALTY_MULTIPLIERS.length - 1);
  });
});

// ---------------------------------------------------------------------------
// 5. Epoch reward computation
// ---------------------------------------------------------------------------

describe("computeEpochReward", () => {
  it("computes base reward correctly at tier 0", () => {
    const result = computeEpochReward(1000, 0, 0);
    expect(result.sharesHeld).toBe(1000);
    expect(result.loyaltyMultiplier).toBeCloseTo(LOYALTY_MULTIPLIERS[0]);
    expect(result.baseReward ?? result.totalReward).toBeCloseTo(1000 * BASE_REWARD_RATE * LOYALTY_MULTIPLIERS[0], 8);
    expect(result.referralCommission).toBe(0);
  });

  it("applies loyalty multiplier correctly", () => {
    const r0 = computeEpochReward(1000, 0);
    const r1 = computeEpochReward(1000, EPOCHS_PER_TIER);
    expect(r1.totalReward).toBeCloseTo(r0.totalReward * (LOYALTY_MULTIPLIERS[1] / LOYALTY_MULTIPLIERS[0]), 8);
  });

  it("adds referral commission on top of base reward", () => {
    const refereeBaseReward = 100;
    const result = computeEpochReward(1000, 0, refereeBaseReward);
    expect(result.referralCommission).toBeCloseTo(refereeBaseReward * REFERRAL_COMMISSION_RATE, 8);
    expect(result.totalReward).toBeCloseTo(
      1000 * BASE_REWARD_RATE * LOYALTY_MULTIPLIERS[0] + refereeBaseReward * REFERRAL_COMMISSION_RATE,
      8,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Merkle leaf encoding and hashing
// ---------------------------------------------------------------------------

describe("encodeMerkleLeaf", () => {
  it("produces a stable colon-delimited string", () => {
    const leaf = makeLeaf();
    const encoded = encodeMerkleLeaf(leaf);
    expect(encoded).toBe(
      `${normaliseAddress(leaf.walletAddress)}:${leaf.vaultId}:${leaf.epochNumber}:${leaf.amount}`,
    );
  });

  it("normalises wallet address to lowercase", () => {
    const upper = makeLeaf({ walletAddress: "GAAA1111" });
    const lower = makeLeaf({ walletAddress: "gaaa1111" });
    expect(encodeMerkleLeaf(upper)).toBe(encodeMerkleLeaf(lower));
  });
});

describe("hashLeaf", () => {
  it("returns a 64-character hex string", () => {
    const h = hashLeaf("test");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashLeaf("hello")).toBe(hashLeaf("hello"));
  });

  it("different inputs produce different hashes (no trivial collision)", () => {
    expect(hashLeaf("a")).not.toBe(hashLeaf("b"));
  });
});

describe("hashPair", () => {
  it("is order-independent (commutative)", () => {
    expect(hashPair("aaa", "bbb")).toBe(hashPair("bbb", "aaa"));
  });

  it("produces a 64-char hex string", () => {
    expect(hashPair("x", "y")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 7. Merkle tree construction
// ---------------------------------------------------------------------------

describe("buildMerkleTree", () => {
  it("returns a stable root for an empty set", () => {
    const { root, leafHashes, layers } = buildMerkleTree([]);
    expect(typeof root).toBe("string");
    expect(leafHashes).toHaveLength(0);
    expect(layers).toHaveLength(0);
  });

  it("returns the leaf hash as root for a single leaf", () => {
    const leaf = makeLeaf();
    const { root, leafHashes } = buildMerkleTree([leaf]);
    expect(root).toBe(leafHashes[0]);
  });

  it("builds a correct 2-leaf tree", () => {
    const leaves = [makeLeaf({ epochNumber: 1 }), makeLeaf({ epochNumber: 2 })];
    const { root, layers } = buildMerkleTree(leaves);
    expect(layers).toHaveLength(2); // leaf layer + root layer
    expect(root).toBe(layers[layers.length - 1][0]);
  });

  it("handles odd number of leaves (duplicates last)", () => {
    const leaves = [
      makeLeaf({ epochNumber: 1 }),
      makeLeaf({ epochNumber: 2 }),
      makeLeaf({ epochNumber: 3 }),
    ];
    const { root } = buildMerkleTree(leaves);
    expect(typeof root).toBe("string");
    expect(root).toHaveLength(64);
  });

  it("is deterministic: same leaves in different order produce same root", () => {
    const l1 = makeLeaf({ walletAddress: "GAAA", epochNumber: 1 });
    const l2 = makeLeaf({ walletAddress: "GBBB", epochNumber: 2 });
    const l3 = makeLeaf({ walletAddress: "GCCC", epochNumber: 3 });

    const { root: root1 } = buildMerkleTree([l1, l2, l3]);
    const { root: root2 } = buildMerkleTree([l3, l1, l2]);
    const { root: root3 } = buildMerkleTree([l2, l3, l1]);

    expect(root1).toBe(root2);
    expect(root2).toBe(root3);
  });

  it("repeated ETL recompute produces identical root (idempotent)", () => {
    const leaves = [
      makeLeaf({ walletAddress: "GA1", amount: "100" }),
      makeLeaf({ walletAddress: "GB2", amount: "200" }),
      makeLeaf({ walletAddress: "GC3", amount: "300" }),
    ];
    const roots = Array.from({ length: 5 }, () => buildMerkleTree(leaves).root);
    expect(new Set(roots).size).toBe(1); // all identical
  });
});

// ---------------------------------------------------------------------------
// 8. Merkle proof generation and verification
// ---------------------------------------------------------------------------

describe("generateMerkleProof + verifyMerkleProof", () => {
  const leaves: MerkleLeaf[] = [
    makeLeaf({ walletAddress: "GA", epochNumber: 1, amount: "100" }),
    makeLeaf({ walletAddress: "GB", epochNumber: 2, amount: "200" }),
    makeLeaf({ walletAddress: "GC", epochNumber: 3, amount: "300" }),
    makeLeaf({ walletAddress: "GD", epochNumber: 4, amount: "400" }),
  ];

  it("generates a proof for each leaf", () => {
    for (const leaf of leaves) {
      const proof = generateMerkleProof(leaf, leaves);
      expect(proof).not.toBeNull();
      expect(proof!.proof.length).toBeGreaterThan(0);
    }
  });

  it("verifies each generated proof as valid", () => {
    for (const leaf of leaves) {
      const proof = generateMerkleProof(leaf, leaves);
      expect(proof).not.toBeNull();
      expect(verifyMerkleProof(proof!)).toBe(true);
    }
  });

  it("returns null for a leaf not in the tree", () => {
    const outsideLeaf = makeLeaf({ walletAddress: "GNOBODY", epochNumber: 99 });
    const proof = generateMerkleProof(outsideLeaf, leaves);
    expect(proof).toBeNull();
  });

  it("fails verification if the amount is tampered", () => {
    const leaf = leaves[0];
    const proof = generateMerkleProof(leaf, leaves)!;
    const tampered = { ...proof, leaf: { ...proof.leaf, amount: "9999999999" } };
    expect(verifyMerkleProof(tampered)).toBe(false);
  });

  it("fails verification if the wallet address is tampered", () => {
    const leaf = leaves[0];
    const proof = generateMerkleProof(leaf, leaves)!;
    const tampered = { ...proof, leaf: { ...proof.leaf, walletAddress: "GATTACKER" } };
    expect(verifyMerkleProof(tampered)).toBe(false);
  });

  it("fails verification if a sibling hash is tampered", () => {
    const leaf = leaves[0];
    const proof = generateMerkleProof(leaf, leaves)!;
    const tamperedProof = [...proof.proof];
    tamperedProof[0] = "a".repeat(64);
    const tampered = { ...proof, proof: tamperedProof };
    expect(verifyMerkleProof(tampered)).toBe(false);
  });

  it("works for a single-leaf tree", () => {
    const single = [makeLeaf()];
    const proof = generateMerkleProof(single[0], single)!;
    expect(proof).not.toBeNull();
    expect(verifyMerkleProof(proof)).toBe(true);
  });

  it("works for an odd-sized tree", () => {
    const odd = [
      makeLeaf({ walletAddress: "GA", epochNumber: 1 }),
      makeLeaf({ walletAddress: "GB", epochNumber: 2 }),
      makeLeaf({ walletAddress: "GC", epochNumber: 3 }),
    ];
    for (const leaf of odd) {
      const proof = generateMerkleProof(leaf, odd);
      expect(proof).not.toBeNull();
      expect(verifyMerkleProof(proof!)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Referral code utilities
// ---------------------------------------------------------------------------

describe("generateReferralCode", () => {
  it("returns a 10-character uppercase alphanumeric code", () => {
    const code = generateReferralCode("GAAA1111");
    expect(code).toHaveLength(10);
    expect(code).toMatch(/^[A-Z0-9]{10}$/);
  });

  it("is deterministic for the same address", () => {
    expect(generateReferralCode("GAAA1111")).toBe(generateReferralCode("GAAA1111"));
  });

  it("produces different codes for different addresses", () => {
    const c1 = generateReferralCode("GAAA1111");
    const c2 = generateReferralCode("GBBB2222");
    expect(c1).not.toBe(c2);
  });

  it("normalises address before hashing (case-insensitive)", () => {
    expect(generateReferralCode("GAAA1111")).toBe(generateReferralCode("gaaa1111"));
  });
});

describe("buildReferralLink", () => {
  it("appends ?ref=CODE to the origin", () => {
    const link = buildReferralLink("https://app.zenith.finance", "TESTCODE1");
    expect(link).toBe("https://app.zenith.finance/vaults?ref=TESTCODE1");
  });

  it("strips trailing slash from origin", () => {
    const link = buildReferralLink("https://app.zenith.finance/", "TESTCODE1");
    expect(link).toBe("https://app.zenith.finance/vaults?ref=TESTCODE1");
  });
});

// ---------------------------------------------------------------------------
// 10. Tier display helpers
// ---------------------------------------------------------------------------

describe("loyaltyTierLabel", () => {
  it("returns correct labels for all tiers", () => {
    expect(loyaltyTierLabel(0)).toBe("Bronze");
    expect(loyaltyTierLabel(1)).toBe("Silver");
    expect(loyaltyTierLabel(2)).toBe("Gold");
    expect(loyaltyTierLabel(3)).toBe("Platinum");
  });

  it("caps at the last tier label", () => {
    expect(loyaltyTierLabel(99)).toBe("Platinum");
  });
});

describe("loyaltyTierColor", () => {
  it("returns a CSS variable string for each tier", () => {
    for (let t = 0; t <= 3; t++) {
      expect(loyaltyTierColor(t)).toMatch(/^var\(--/);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Anti-abuse: clawback (early withdrawal scenario)
// ---------------------------------------------------------------------------

describe("clawback / early withdrawal", () => {
  it("blocks reward when deposit withdrawn before MIN_HOLD_EPOCHS", () => {
    const attr = makeAttribution({ fundedAtMs: Date.now() - 1000 });
    // epochsHeld = 0, which is below MIN_HOLD_EPOCHS = 1
    const result = checkReferralRewardEligibility(attr, 0, 0);
    expect(result.allowed).toBe(false);
  });

  it("allows reward after exactly MIN_HOLD_EPOCHS have elapsed", () => {
    const attr = makeAttribution({ fundedAtMs: Date.now() - 86400_000 });
    const result = checkReferralRewardEligibility(attr, MIN_HOLD_EPOCHS, 0);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. normaliseAddress
// ---------------------------------------------------------------------------

describe("normaliseAddress", () => {
  it("lowercases and trims the address", () => {
    expect(normaliseAddress("  GAAA  ")).toBe("gaaa");
  });
});
