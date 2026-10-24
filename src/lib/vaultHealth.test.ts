import { describe, it, expect } from "vitest";
import {
  winRateScore,
  returnConsistencyScore,
  drawdownControlScore,
  strategyRiskScore,
  capacityHeadroomScore,
  computeVaultHealthScore,
  gradeFromScore,
  gradeColor,
  gradeBg,
  gradeLabel,
  type VaultGrade,
} from "./vaultHealth";
import type { EpochRecord } from "./api/vaults";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function epoch(overrides: Partial<EpochRecord> = {}): EpochRecord {
  return {
    epochNumber: 1,
    depositStart: "2026-09-01",
    activeStart:  "2026-09-02",
    settlementDate: "2026-09-09",
    strike: 100,
    expiryDays: 7,
    premiumCollected: 1.5,
    outcome: "expired_worthless",
    pnlPct: 0.02,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// gradeFromScore
// ---------------------------------------------------------------------------

describe("gradeFromScore", () => {
  it("returns A for scores >= 80", () => {
    expect(gradeFromScore(80)).toBe("A");
    expect(gradeFromScore(100)).toBe("A");
    expect(gradeFromScore(95)).toBe("A");
  });

  it("returns B for scores 65–79", () => {
    expect(gradeFromScore(65)).toBe("B");
    expect(gradeFromScore(79)).toBe("B");
    expect(gradeFromScore(72)).toBe("B");
  });

  it("returns C for scores 50–64", () => {
    expect(gradeFromScore(50)).toBe("C");
    expect(gradeFromScore(64)).toBe("C");
  });

  it("returns D for scores 35–49", () => {
    expect(gradeFromScore(35)).toBe("D");
    expect(gradeFromScore(49)).toBe("D");
  });

  it("returns E for scores < 35", () => {
    expect(gradeFromScore(34)).toBe("E");
    expect(gradeFromScore(0)).toBe("E");
  });
});

// ---------------------------------------------------------------------------
// winRateScore
// ---------------------------------------------------------------------------

describe("winRateScore", () => {
  it("returns 50 when there are no settled epochs", () => {
    expect(winRateScore([])).toBe(50);
    // 'active' epochs don't count as settled
    expect(winRateScore([epoch({ outcome: "active" })])).toBe(50);
  });

  it("returns 100 when all epochs expired worthless", () => {
    const epochs = [
      epoch({ outcome: "expired_worthless" }),
      epoch({ outcome: "expired_worthless" }),
      epoch({ outcome: "expired_worthless" }),
    ];
    expect(winRateScore(epochs)).toBe(100);
  });

  it("returns 0 when all epochs were exercised", () => {
    const epochs = [
      epoch({ outcome: "exercised" }),
      epoch({ outcome: "exercised" }),
    ];
    expect(winRateScore(epochs)).toBe(0);
  });

  it("returns 50 for a 50% win rate", () => {
    const epochs = [
      epoch({ outcome: "expired_worthless" }),
      epoch({ outcome: "exercised" }),
    ];
    expect(winRateScore(epochs)).toBe(50);
  });

  it("ignores active epochs when computing the rate", () => {
    const epochs = [
      epoch({ outcome: "expired_worthless" }),
      epoch({ outcome: "expired_worthless" }),
      epoch({ outcome: "active" }), // should not affect numerator or denominator
    ];
    expect(winRateScore(epochs)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// returnConsistencyScore
// ---------------------------------------------------------------------------

describe("returnConsistencyScore", () => {
  it("returns 50 for a single settled epoch (insufficient data)", () => {
    expect(returnConsistencyScore([epoch()])).toBe(50);
  });

  it("returns 50 when there are no settled epochs", () => {
    expect(returnConsistencyScore([])).toBe(50);
  });

  it("returns 100 for perfectly identical returns (σ = 0)", () => {
    const epochs = [
      epoch({ pnlPct: 0.02, outcome: "expired_worthless" }),
      epoch({ pnlPct: 0.02, outcome: "expired_worthless" }),
      epoch({ pnlPct: 0.02, outcome: "expired_worthless" }),
    ];
    expect(returnConsistencyScore(epochs)).toBe(100);
  });

  it("returns a lower score for high-variance returns", () => {
    const stable = [
      epoch({ pnlPct: 0.021, outcome: "expired_worthless" }),
      epoch({ pnlPct: 0.019, outcome: "expired_worthless" }),
      epoch({ pnlPct: 0.020, outcome: "expired_worthless" }),
    ];
    const volatile = [
      epoch({ pnlPct:  0.10, outcome: "expired_worthless" }),
      epoch({ pnlPct: -0.08, outcome: "exercised" }),
      epoch({ pnlPct:  0.05, outcome: "expired_worthless" }),
    ];
    expect(returnConsistencyScore(stable)).toBeGreaterThan(returnConsistencyScore(volatile));
  });

  it("returns 0 when σ >= 0.08 (very wide spread)", () => {
    // Two epochs maximally far apart: +20% and -20%, σ ≈ 0.20 → clamped to 0.08
    const epochs = [
      epoch({ pnlPct:  0.20, outcome: "expired_worthless" }),
      epoch({ pnlPct: -0.20, outcome: "exercised" }),
    ];
    expect(returnConsistencyScore(epochs)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// drawdownControlScore
// ---------------------------------------------------------------------------

describe("drawdownControlScore", () => {
  it("returns 50 for no epoch data", () => {
    expect(drawdownControlScore([])).toBe(50);
  });

  it("returns 100 when all epochs are profitable", () => {
    const epochs = [
      epoch({ pnlPct: 0.02, outcome: "expired_worthless" }),
      epoch({ pnlPct: 0.01, outcome: "expired_worthless" }),
    ];
    expect(drawdownControlScore(epochs)).toBe(100);
  });

  it("returns 0 when worst loss is -10% or worse", () => {
    const epochs = [
      epoch({ pnlPct: 0.02, outcome: "expired_worthless" }),
      epoch({ pnlPct: -0.10, outcome: "exercised" }),
    ];
    expect(drawdownControlScore(epochs)).toBe(0);
  });

  it("returns 0 when worst loss is worse than -10%", () => {
    const epochs = [
      epoch({ pnlPct: -0.20, outcome: "exercised" }),
    ];
    expect(drawdownControlScore(epochs)).toBe(0);
  });

  it("interpolates linearly between 0% and -10% loss", () => {
    // Worst loss = -5% → half of -10% range → score 50
    const epochs = [epoch({ pnlPct: -0.05, outcome: "exercised" })];
    expect(drawdownControlScore(epochs)).toBeCloseTo(50, 0);
  });

  it("ignores active epochs", () => {
    const epochs = [
      epoch({ pnlPct: 0.01, outcome: "expired_worthless" }),
      epoch({ pnlPct: -0.01, outcome: "active" }), // should not count
    ];
    // Only settled epoch has pnlPct 0.01, so no loss → 100
    expect(drawdownControlScore(epochs)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// strategyRiskScore
// ---------------------------------------------------------------------------

describe("strategyRiskScore", () => {
  it("ranks strategies by inherent risk: iron_condor > covered_call > cash_secured_put > wheel", () => {
    const ic = strategyRiskScore("iron_condor");
    const cc = strategyRiskScore("covered_call");
    const csp = strategyRiskScore("cash_secured_put");
    const wh = strategyRiskScore("wheel");
    expect(ic).toBeGreaterThan(cc);
    expect(cc).toBeGreaterThan(csp);
    expect(csp).toBeGreaterThan(wh);
  });

  it("returns each strategy's exact documented base score", () => {
    expect(strategyRiskScore("iron_condor")).toBe(90);
    expect(strategyRiskScore("covered_call")).toBe(75);
    expect(strategyRiskScore("cash_secured_put")).toBe(55);
    expect(strategyRiskScore("wheel")).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// capacityHeadroomScore
// ---------------------------------------------------------------------------

describe("capacityHeadroomScore", () => {
  it("returns 50 for zero capacity (degenerate input)", () => {
    expect(capacityHeadroomScore(0, 0)).toBe(50);
  });

  it("returns 100 when utilization <= 50%", () => {
    expect(capacityHeadroomScore(100_000, 500_000)).toBe(100); // 20%
    expect(capacityHeadroomScore(250_000, 500_000)).toBe(100); // 50%
  });

  it("returns 0 when utilization >= 95%", () => {
    expect(capacityHeadroomScore(950_000, 1_000_000)).toBe(0); // 95%
    expect(capacityHeadroomScore(999_000, 1_000_000)).toBe(0); // 99.9%
    expect(capacityHeadroomScore(1_200_000, 1_000_000)).toBe(0); // over capacity
  });

  it("interpolates linearly between 50% and 95% utilization", () => {
    // Utilization = 72.5% (midpoint of [50%, 95%]) → score should be ~50
    const score = capacityHeadroomScore(725_000, 1_000_000);
    expect(score).toBeCloseTo(50, 0);
  });

  it("higher utilization yields lower score", () => {
    const low  = capacityHeadroomScore(200_000, 1_000_000);
    const high = capacityHeadroomScore(800_000, 1_000_000);
    expect(low).toBeGreaterThan(high);
  });
});

// ---------------------------------------------------------------------------
// computeVaultHealthScore (composite)
// ---------------------------------------------------------------------------

describe("computeVaultHealthScore", () => {
  const base = { strategy: "covered_call" as const, tvl: 284_000, capacity: 500_000 };

  it("returns a composite in [0, 100]", () => {
    const result = computeVaultHealthScore(base, []);
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(100);
  });

  it("composite is an integer (rounded)", () => {
    const result = computeVaultHealthScore(base, [epoch(), epoch()]);
    expect(Number.isInteger(result.composite)).toBe(true);
  });

  it("grade is consistent with the composite score", () => {
    const result = computeVaultHealthScore(base, [epoch(), epoch()]);
    if (result.composite >= 80) expect(result.grade).toBe("A");
    else if (result.composite >= 65) expect(result.grade).toBe("B");
    else if (result.composite >= 50) expect(result.grade).toBe("C");
    else if (result.composite >= 35) expect(result.grade).toBe("D");
    else expect(result.grade).toBe("E");
  });

  it("returns all five factor breakdowns", () => {
    const result = computeVaultHealthScore(base, []);
    const keys = Object.keys(result.factors);
    expect(keys).toContain("winRate");
    expect(keys).toContain("returnConsistency");
    expect(keys).toContain("drawdownControl");
    expect(keys).toContain("strategyRisk");
    expect(keys).toContain("capacityHeadroom");
  });

  it("each factor has score, weight, label, and description", () => {
    const result = computeVaultHealthScore(base, []);
    for (const f of Object.values(result.factors)) {
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(100);
      expect(f.weight).toBeGreaterThan(0);
      expect(typeof f.label).toBe("string");
      expect(typeof f.description).toBe("string");
    }
  });

  it("factor weights sum to 1.0", () => {
    const result = computeVaultHealthScore(base, []);
    const totalWeight = Object.values(result.factors).reduce((s, f) => s + f.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  it("a vault with perfect history scores higher than one with mixed history", () => {
    const perfect = [
      epoch({ outcome: "expired_worthless", pnlPct: 0.02 }),
      epoch({ outcome: "expired_worthless", pnlPct: 0.021 }),
      epoch({ outcome: "expired_worthless", pnlPct: 0.019 }),
    ];
    const mixed = [
      epoch({ outcome: "expired_worthless", pnlPct: 0.02 }),
      epoch({ outcome: "exercised", pnlPct: -0.08 }),
    ];
    const scorePerfect = computeVaultHealthScore(base, perfect).composite;
    const scoreMixed   = computeVaultHealthScore(base, mixed).composite;
    expect(scorePerfect).toBeGreaterThan(scoreMixed);
  });

  it("defaults epochs to [] when omitted", () => {
    const r1 = computeVaultHealthScore(base);
    const r2 = computeVaultHealthScore(base, []);
    expect(r1.composite).toBe(r2.composite);
    expect(r1.grade).toBe(r2.grade);
  });

  it("iron_condor vault scores higher on strategyRisk factor than wheel vault", () => {
    const ic = computeVaultHealthScore({ ...base, strategy: "iron_condor" }, []);
    const wh = computeVaultHealthScore({ ...base, strategy: "wheel" }, []);
    expect(ic.factors.strategyRisk.score).toBeGreaterThan(wh.factors.strategyRisk.score);
  });

  it("nearly-full vault scores lower on capacityHeadroom than a half-full one", () => {
    const nearFull = computeVaultHealthScore({ ...base, tvl: 490_000, capacity: 500_000 }, []);
    const halfFull = computeVaultHealthScore({ ...base, tvl: 200_000, capacity: 500_000 }, []);
    expect(nearFull.factors.capacityHeadroom.score).toBeLessThan(halfFull.factors.capacityHeadroom.score);
  });
});

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

describe("gradeColor / gradeBg / gradeLabel", () => {
  const grades: VaultGrade[] = ["A", "B", "C", "D", "E"];

  it("gradeColor returns a CSS variable string for each grade", () => {
    for (const g of grades) {
      expect(gradeColor(g)).toMatch(/^var\(/);
    }
  });

  it("gradeBg returns a CSS variable string for each grade", () => {
    for (const g of grades) {
      expect(gradeBg(g)).toMatch(/^var\(/);
    }
  });

  it("gradeLabel returns a non-empty string for each grade", () => {
    for (const g of grades) {
      const label = gradeLabel(g);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("A and E grades have distinct colors", () => {
    expect(gradeColor("A")).not.toBe(gradeColor("E"));
  });
});
