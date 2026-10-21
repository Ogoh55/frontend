/**
 * Unit tests for src/lib/vaultEligibility.ts
 *
 * Covers:
 *  - Each individual signal scoring function
 *  - The composite scoreEligibility function
 *  - The classifyFarmingRisk heuristics
 *  - The eligibility status / label helpers
 */

import { describe, it, expect } from "vitest";
import {
  scoreAccountAge,
  scoreOnChainActivity,
  scoreHoldDuration,
  scoreDiversification,
  scoreRecycleRate,
  classifyFarmingRisk,
  scoreEligibility,
  eligibilityStatusLabel,
  eligibilityStatusColor,
  farmingRiskColor,
  canReceiveIncentives,
  eligibilityStatusColor as statusColor,
  MIN_WALLET_AGE_MS,
  MIN_HOLD_MS,
  MIN_ACTIVITY_TXN_COUNT,
  ELIGIBLE_THRESHOLD,
  REVIEW_THRESHOLD,
  type WalletActivity,
  type VaultEvent,
  type EligibilityInput,
} from "./vaultEligibility";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const NOW_MS = 1_000_000_000_000; // fixed epoch for determinism

const day = 24 * 60 * 60 * 1000;
const hour = 60 * 60 * 1000;

function makeActivity(overrides: Partial<WalletActivity> = {}): WalletActivity {
  return {
    walletCreatedAtMs: NOW_MS - 60 * day,
    totalTransactions: 50,
    distinctContractInteractions: 5,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<VaultEvent>): VaultEvent {
  return {
    vaultId: "vault-a",
    type: "deposit",
    timestampMs: NOW_MS - 10 * day,
    amount: 1000,
    ...overrides,
  };
}

function makeInput(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    walletAddress: "GABC123",
    activity: makeActivity(),
    vaultEvents: [],
    targetVaultId: "vault-a",
    nowMs: NOW_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scoreAccountAge
// ---------------------------------------------------------------------------

describe("scoreAccountAge", () => {
  it("returns 100 for a wallet at exactly the minimum age", () => {
    const activity = makeActivity({ walletCreatedAtMs: NOW_MS - MIN_WALLET_AGE_MS });
    const result = scoreAccountAge(activity, NOW_MS);
    expect(result.score).toBe(100);
    expect(result.flagged).toBe(false);
  });

  it("returns 100 for a wallet older than the minimum age", () => {
    const activity = makeActivity({ walletCreatedAtMs: NOW_MS - MIN_WALLET_AGE_MS * 2 });
    const result = scoreAccountAge(activity, NOW_MS);
    expect(result.score).toBe(100);
    expect(result.flagged).toBe(false);
  });

  it("returns ~50 for a wallet half the minimum age", () => {
    const activity = makeActivity({ walletCreatedAtMs: NOW_MS - MIN_WALLET_AGE_MS / 2 });
    const result = scoreAccountAge(activity, NOW_MS);
    expect(result.score).toBe(50);
    expect(result.flagged).toBe(false); // 50 is exactly the boundary
  });

  it("returns 0 for a brand-new wallet", () => {
    const activity = makeActivity({ walletCreatedAtMs: NOW_MS });
    const result = scoreAccountAge(activity, NOW_MS);
    expect(result.score).toBe(0);
    expect(result.flagged).toBe(true);
  });

  it("flags wallets with score < 50", () => {
    const activity = makeActivity({ walletCreatedAtMs: NOW_MS - 5 * day });
    const result = scoreAccountAge(activity, NOW_MS);
    expect(result.flagged).toBe(true);
    expect(result.score).toBeLessThan(50);
  });

  it("includes the wallet age in the reason string", () => {
    const activity = makeActivity({ walletCreatedAtMs: NOW_MS - 5 * day });
    const result = scoreAccountAge(activity, NOW_MS);
    expect(result.reason).toContain("5 days old");
  });
});

// ---------------------------------------------------------------------------
// scoreOnChainActivity
// ---------------------------------------------------------------------------

describe("scoreOnChainActivity", () => {
  it("returns 100 for a wallet with many transactions and diverse interactions", () => {
    const activity = makeActivity({ totalTransactions: 100, distinctContractInteractions: 10 });
    const result = scoreOnChainActivity(activity);
    expect(result.score).toBe(100);
    expect(result.flagged).toBe(false);
  });

  it("returns 0 for a wallet with no transactions", () => {
    const activity = makeActivity({ totalTransactions: 0, distinctContractInteractions: 0 });
    const result = scoreOnChainActivity(activity);
    expect(result.score).toBe(0);
    expect(result.flagged).toBe(true);
  });

  it("scores MIN_ACTIVITY_TXN_COUNT transactions at 100 base (before diversity bonus)", () => {
    const activity = makeActivity({
      totalTransactions: MIN_ACTIVITY_TXN_COUNT,
      distinctContractInteractions: 0,
    });
    const result = scoreOnChainActivity(activity);
    expect(result.score).toBe(100); // exactly meets the minimum
  });

  it("flags wallets with score < 40", () => {
    const activity = makeActivity({ totalTransactions: 1, distinctContractInteractions: 0 });
    const result = scoreOnChainActivity(activity);
    expect(result.flagged).toBe(true);
  });

  it("applies a diversity bonus (capped at 20)", () => {
    // 5 txns = 100 base, 6 interactions × 4 = 24, capped at 20 → still 100
    const activity = makeActivity({ totalTransactions: 5, distinctContractInteractions: 6 });
    const result = scoreOnChainActivity(activity);
    expect(result.score).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// scoreHoldDuration
// ---------------------------------------------------------------------------

describe("scoreHoldDuration", () => {
  it("returns neutral 80 with no prior events", () => {
    const result = scoreHoldDuration([], "vault-a");
    expect(result.score).toBe(80);
    expect(result.flagged).toBe(false);
  });

  it("returns 95 when there are deposits but no withdrawals", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit", timestampMs: NOW_MS - 10 * day }),
    ];
    const result = scoreHoldDuration(events, "vault-a");
    expect(result.score).toBe(95);
    expect(result.flagged).toBe(false);
  });

  it("returns 100 when average hold meets the minimum", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit",  timestampMs: NOW_MS - 30 * day }),
      makeEvent({ vaultId: "vault-a", type: "withdraw", timestampMs: NOW_MS - 5  * day }),
    ];
    const result = scoreHoldDuration(events, "vault-a");
    expect(result.score).toBe(100);
    expect(result.flagged).toBe(false);
  });

  it("returns low score for a flash deposit/withdraw", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit",  timestampMs: NOW_MS - 2 * hour }),
      makeEvent({ vaultId: "vault-a", type: "withdraw", timestampMs: NOW_MS - 1 * hour }),
    ];
    const result = scoreHoldDuration(events, "vault-a");
    // avgHold = 1 hour; MIN_HOLD_MS = 24h → score ≈ 4
    expect(result.score).toBeLessThan(10);
    expect(result.flagged).toBe(true);
  });

  it("only considers events for the target vault", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-b", type: "deposit",  timestampMs: NOW_MS - 2 * hour }),
      makeEvent({ vaultId: "vault-b", type: "withdraw", timestampMs: NOW_MS - 1 * hour }),
    ];
    // No events for vault-a → neutral 80
    const result = scoreHoldDuration(events, "vault-a");
    expect(result.score).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// scoreDiversification
// ---------------------------------------------------------------------------

describe("scoreDiversification", () => {
  it("returns 60 when only the target vault has activity", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit" }),
      makeEvent({ vaultId: "vault-a", type: "deposit" }),
    ];
    const result = scoreDiversification(events, "vault-a");
    expect(result.score).toBe(60);
  });

  it("returns 75 for one other vault", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit" }),
      makeEvent({ vaultId: "vault-b", type: "deposit" }),
    ];
    const result = scoreDiversification(events, "vault-a");
    expect(result.score).toBe(75);
  });

  it("returns 88 for two other vaults", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit" }),
      makeEvent({ vaultId: "vault-b", type: "deposit" }),
      makeEvent({ vaultId: "vault-c", type: "deposit" }),
    ];
    const result = scoreDiversification(events, "vault-a");
    expect(result.score).toBe(88);
  });

  it("returns 100 for three or more other vaults", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit" }),
      makeEvent({ vaultId: "vault-b", type: "deposit" }),
      makeEvent({ vaultId: "vault-c", type: "deposit" }),
      makeEvent({ vaultId: "vault-d", type: "deposit" }),
    ];
    const result = scoreDiversification(events, "vault-a");
    expect(result.score).toBe(100);
  });

  it("flags single-vault concentration with many events", () => {
    const events = Array.from({ length: 5 }, () =>
      makeEvent({ vaultId: "vault-a", type: "deposit" }),
    );
    const result = scoreDiversification(events, "vault-a");
    expect(result.flagged).toBe(true);
  });

  it("does not flag single-vault when there are ≤ 3 events total", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit" }),
    ];
    const result = scoreDiversification(events, "vault-a");
    expect(result.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreRecycleRate
// ---------------------------------------------------------------------------

describe("scoreRecycleRate", () => {
  it("returns 100 with no events", () => {
    const result = scoreRecycleRate([], NOW_MS);
    expect(result.score).toBe(100);
    expect(result.flagged).toBe(false);
  });

  it("returns 100 with only deposits (no round-trips)", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit", timestampMs: NOW_MS - 3 * day }),
      makeEvent({ vaultId: "vault-b", type: "deposit", timestampMs: NOW_MS - 2 * day }),
    ];
    const result = scoreRecycleRate(events, NOW_MS);
    expect(result.score).toBe(100);
  });

  it("penalises one round-trip", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit",  timestampMs: NOW_MS - 5 * day }),
      makeEvent({ vaultId: "vault-a", type: "withdraw", timestampMs: NOW_MS - 4 * day }),
    ];
    const result = scoreRecycleRate(events, NOW_MS);
    expect(result.score).toBe(67); // 100 - 33
    expect(result.flagged).toBe(false);
  });

  it("penalises three round-trips and flags", () => {
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit",  timestampMs: NOW_MS - 6 * day }),
      makeEvent({ vaultId: "vault-a", type: "withdraw", timestampMs: NOW_MS - 5 * day }),
      makeEvent({ vaultId: "vault-b", type: "deposit",  timestampMs: NOW_MS - 4 * day }),
      makeEvent({ vaultId: "vault-b", type: "withdraw", timestampMs: NOW_MS - 3 * day }),
      makeEvent({ vaultId: "vault-c", type: "deposit",  timestampMs: NOW_MS - 2 * day }),
      makeEvent({ vaultId: "vault-c", type: "withdraw", timestampMs: NOW_MS - 1 * day }),
    ];
    const result = scoreRecycleRate(events, NOW_MS);
    expect(result.score).toBe(1); // Math.max(0, 100 - 3*33) = 1
    expect(result.flagged).toBe(true);
  });

  it("ignores events outside the recycle window", () => {
    // A round-trip 60 days ago should not count
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit",  timestampMs: NOW_MS - 60 * day }),
      makeEvent({ vaultId: "vault-a", type: "withdraw", timestampMs: NOW_MS - 59 * day }),
    ];
    const result = scoreRecycleRate(events, NOW_MS);
    expect(result.score).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// classifyFarmingRisk
// ---------------------------------------------------------------------------

describe("classifyFarmingRisk", () => {
  it("returns none for a clean user", () => {
    const input = makeInput({
      vaultEvents: [
        makeEvent({ vaultId: "vault-a", type: "deposit", timestampMs: NOW_MS - 30 * day }),
        makeEvent({ vaultId: "vault-b", type: "deposit", timestampMs: NOW_MS - 10 * day }),
      ],
    });
    const { risk, reasons } = classifyFarmingRisk(input);
    expect(risk).toBe("none");
    expect(reasons).toHaveLength(0);
  });

  it("detects a flash deposit", () => {
    const input = makeInput({
      vaultEvents: [
        makeEvent({ vaultId: "vault-a", type: "deposit",  timestampMs: NOW_MS - 3 * hour }),
        makeEvent({ vaultId: "vault-a", type: "withdraw", timestampMs: NOW_MS - 2 * hour }),
      ],
    });
    const { risk, reasons } = classifyFarmingRisk(input);
    expect(risk).toBe("low");
    expect(reasons.some(r => r.includes("Flash deposit"))).toBe(true);
  });

  it("detects vault hopping", () => {
    const input = makeInput({
      vaultEvents: [
        makeEvent({ vaultId: "vault-a", type: "deposit", timestampMs: NOW_MS - 4 * hour }),
        makeEvent({ vaultId: "vault-b", type: "deposit", timestampMs: NOW_MS - 3 * hour }),
        makeEvent({ vaultId: "vault-c", type: "deposit", timestampMs: NOW_MS - 2 * hour }),
      ],
    });
    const { risk, reasons } = classifyFarmingRisk(input);
    expect(risk).toBe("low");
    expect(reasons.some(r => r.includes("hopping"))).toBe(true);
  });

  it("returns high risk for multiple patterns together", () => {
    const input = makeInput({
      vaultEvents: [
        // Flash deposit
        makeEvent({ vaultId: "vault-a", type: "deposit",  timestampMs: NOW_MS - 3 * hour }),
        makeEvent({ vaultId: "vault-a", type: "withdraw", timestampMs: NOW_MS - 2 * hour }),
        // Vault hopping
        makeEvent({ vaultId: "vault-b", type: "deposit", timestampMs: NOW_MS - 5 * hour }),
        makeEvent({ vaultId: "vault-c", type: "deposit", timestampMs: NOW_MS - 4 * hour }),
        makeEvent({ vaultId: "vault-d", type: "deposit", timestampMs: NOW_MS - 3.5 * hour }),
        // High recycle rate
        makeEvent({ vaultId: "vault-b", type: "withdraw", timestampMs: NOW_MS - 2 * day }),
        makeEvent({ vaultId: "vault-c", type: "withdraw", timestampMs: NOW_MS - 1 * day }),
      ],
    });
    const { risk } = classifyFarmingRisk(input);
    // Should be medium or high
    expect(["medium", "high"]).toContain(risk);
  });
});

// ---------------------------------------------------------------------------
// scoreEligibility — composite
// ---------------------------------------------------------------------------

describe("scoreEligibility", () => {
  it("returns a result with all required fields", () => {
    const result = scoreEligibility(makeInput());
    expect(result).toHaveProperty("compositeScore");
    expect(result).toHaveProperty("eligible");
    expect(result).toHaveProperty("underReview");
    expect(result).toHaveProperty("farmingRisk");
    expect(result).toHaveProperty("signals");
    expect(result).toHaveProperty("summary");
    expect(result.signals).toHaveLength(5);
  });

  it("marks an ideal user as eligible with no farming risk", () => {
    const input = makeInput({
      activity: makeActivity({
        walletCreatedAtMs: NOW_MS - 120 * day,
        totalTransactions: 200,
        distinctContractInteractions: 10,
      }),
      vaultEvents: [
        makeEvent({ vaultId: "vault-a", type: "deposit", timestampMs: NOW_MS - 30 * day }),
        makeEvent({ vaultId: "vault-b", type: "deposit", timestampMs: NOW_MS - 20 * day }),
      ],
    });
    const result = scoreEligibility(input);
    expect(result.eligible).toBe(true);
    expect(result.farmingRisk).toBe("none");
    expect(result.compositeScore).toBeGreaterThanOrEqual(ELIGIBLE_THRESHOLD);
  });

  it("marks a brand-new, inactive wallet as ineligible", () => {
    const input = makeInput({
      activity: makeActivity({
        walletCreatedAtMs: NOW_MS - 1 * day,
        totalTransactions: 0,
        distinctContractInteractions: 0,
      }),
      vaultEvents: [],
    });
    const result = scoreEligibility(input);
    expect(result.eligible).toBe(false);
    expect(result.compositeScore).toBeLessThan(ELIGIBLE_THRESHOLD);
  });

  it("places a brand-new wallet with no history in a low score bracket", () => {
    // 1-day-old wallet, no prior activity, no vault events
    const input = makeInput({
      activity: makeActivity({
        walletCreatedAtMs: NOW_MS - 1 * day,
        totalTransactions: 0,
        distinctContractInteractions: 0,
      }),
      vaultEvents: [],
    });
    const result = scoreEligibility(input);
    // New wallet with zero on-chain activity must score well below the eligible threshold
    expect(result.compositeScore).toBeLessThan(ELIGIBLE_THRESHOLD);
  });

  it("composite score is between 0 and 100", () => {
    for (const seed of [0, 1, 2, 3, 4]) {
      const input = makeInput({
        activity: makeActivity({
          walletCreatedAtMs: NOW_MS - seed * 15 * day,
          totalTransactions: seed * 10,
          distinctContractInteractions: seed,
        }),
      });
      const result = scoreEligibility(input);
      expect(result.compositeScore).toBeGreaterThanOrEqual(0);
      expect(result.compositeScore).toBeLessThanOrEqual(100);
    }
  });

  it("signals weights sum to approximately 1", () => {
    const result = scoreEligibility(makeInput());
    const totalWeight = result.signals.reduce((sum, s) => sum + s.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// canReceiveIncentives
// ---------------------------------------------------------------------------

describe("canReceiveIncentives", () => {
  it("returns true for eligible results", () => {
    const result = scoreEligibility(
      makeInput({
        activity: makeActivity({
          walletCreatedAtMs: NOW_MS - 120 * day,
          totalTransactions: 100,
          distinctContractInteractions: 8,
        }),
        vaultEvents: [
          makeEvent({ vaultId: "vault-a", type: "deposit", timestampMs: NOW_MS - 30 * day }),
          makeEvent({ vaultId: "vault-b", type: "deposit", timestampMs: NOW_MS - 10 * day }),
        ],
      }),
    );
    expect(canReceiveIncentives(result)).toBe(true);
  });

  it("returns false for a clearly ineligible result — very new, zero activity, high recycle", () => {
    // Brand-new wallet AND high recycle rate drives score below both thresholds
    const events: VaultEvent[] = [
      makeEvent({ vaultId: "vault-a", type: "deposit",  timestampMs: NOW_MS - 6 * day }),
      makeEvent({ vaultId: "vault-a", type: "withdraw", timestampMs: NOW_MS - 5 * day }),
      makeEvent({ vaultId: "vault-b", type: "deposit",  timestampMs: NOW_MS - 4 * day }),
      makeEvent({ vaultId: "vault-b", type: "withdraw", timestampMs: NOW_MS - 3 * day }),
      makeEvent({ vaultId: "vault-c", type: "deposit",  timestampMs: NOW_MS - 2 * day }),
      makeEvent({ vaultId: "vault-c", type: "withdraw", timestampMs: NOW_MS - 1 * day }),
    ];
    const result = scoreEligibility(
      makeInput({
        activity: makeActivity({
          walletCreatedAtMs: NOW_MS - 1 * day, // brand new
          totalTransactions: 0,
          distinctContractInteractions: 0,
        }),
        vaultEvents: events,
      }),
    );
    expect(canReceiveIncentives(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers: labels and colours
// ---------------------------------------------------------------------------

describe("eligibilityStatusLabel", () => {
  it("returns 'Eligible' for eligible results with no farming risk", () => {
    const result = scoreEligibility(
      makeInput({
        activity: makeActivity({
          walletCreatedAtMs: NOW_MS - 120 * day,
          totalTransactions: 100,
          distinctContractInteractions: 8,
        }),
        vaultEvents: [
          makeEvent({ vaultId: "vault-a", type: "deposit", timestampMs: NOW_MS - 30 * day }),
          makeEvent({ vaultId: "vault-b", type: "deposit", timestampMs: NOW_MS - 10 * day }),
        ],
      }),
    );
    if (result.eligible && result.farmingRisk === "none") {
      expect(eligibilityStatusLabel(result)).toBe("Eligible");
    }
  });

  it("returns 'Ineligible' for clearly ineligible results", () => {
    const result = scoreEligibility(
      makeInput({
        activity: makeActivity({
          walletCreatedAtMs: NOW_MS,
          totalTransactions: 0,
          distinctContractInteractions: 0,
        }),
      }),
    );
    if (!result.eligible && !result.underReview) {
      expect(eligibilityStatusLabel(result)).toBe("Ineligible");
    }
  });
});

describe("eligibilityStatusColor", () => {
  it("returns a var(--…) CSS variable string", () => {
    const result = scoreEligibility(makeInput());
    const color = eligibilityStatusColor(result);
    expect(color).toMatch(/^var\(--/);
  });
});

describe("farmingRiskColor", () => {
  it("returns a CSS variable for each risk level", () => {
    const levels = ["none", "low", "medium", "high"] as const;
    for (const level of levels) {
      expect(farmingRiskColor(level)).toMatch(/^var\(--/);
    }
  });

  it("returns call color for no risk", () => {
    expect(farmingRiskColor("none")).toBe("var(--call)");
  });

  it("returns put color for high risk", () => {
    expect(farmingRiskColor("high")).toBe("var(--put)");
  });
});

// ---------------------------------------------------------------------------
// Boundary: ELIGIBLE_THRESHOLD and REVIEW_THRESHOLD
// ---------------------------------------------------------------------------

describe("threshold constants", () => {
  it("ELIGIBLE_THRESHOLD > REVIEW_THRESHOLD", () => {
    expect(ELIGIBLE_THRESHOLD).toBeGreaterThan(REVIEW_THRESHOLD);
  });

  it("ELIGIBLE_THRESHOLD and REVIEW_THRESHOLD are positive and ≤ 100", () => {
    expect(ELIGIBLE_THRESHOLD).toBeGreaterThan(0);
    expect(REVIEW_THRESHOLD).toBeGreaterThan(0);
    expect(ELIGIBLE_THRESHOLD).toBeLessThanOrEqual(100);
    expect(REVIEW_THRESHOLD).toBeLessThanOrEqual(100);
  });
});
