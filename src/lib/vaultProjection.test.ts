import { describe, expect, it } from "vitest";
import { projectVaultReturns } from "./vaultProjection";
import type { EpochRecord } from "./api/vaults";

const epochs: EpochRecord[] = [
  {
    epochNumber: 2,
    depositStart: "2026-01-08",
    activeStart: "2026-01-09",
    settlementDate: "2026-01-15",
    strike: 100,
    expiryDays: 7,
    premiumCollected: 1,
    outcome: "expired_worthless",
    pnlPct: -0.1,
  },
  {
    epochNumber: 1,
    depositStart: "2026-01-01",
    activeStart: "2026-01-02",
    settlementDate: "2026-01-08",
    strike: 100,
    expiryDays: 7,
    premiumCollected: 1,
    outcome: "expired_worthless",
    pnlPct: 0.2,
  },
];

describe("projectVaultReturns", () => {
  it("compounds historical epoch returns in chronological order", () => {
    const projection = projectVaultReturns(1000, 14, epochs);

    expect(projection.projectedValue).toBeCloseTo(1080);
    expect(projection.returnPct).toBeCloseTo(0.08);
    expect(projection.completedEpochs).toBe(2);
    expect(projection.coveredDays).toBe(14);
  });

  it("only includes epochs completed within the holding period", () => {
    const projection = projectVaultReturns(1000, 10, epochs);

    expect(projection.projectedValue).toBe(1200);
    expect(projection.completedEpochs).toBe(1);
    expect(projection.coveredDays).toBe(7);
    expect(projection.availableDays).toBe(14);
  });

  it("does not extrapolate when the holding period exceeds available history", () => {
    const projection = projectVaultReturns(1000, 30, epochs);

    expect(projection.projectedValue).toBe(1080);
    expect(projection.completedEpochs).toBe(2);
    expect(projection.availableDays).toBe(14);
  });

  it("rejects invalid deposits, holding periods, and historical returns", () => {
    expect(() => projectVaultReturns(0, 7, epochs)).toThrow(/deposit amount/i);
    expect(() => projectVaultReturns(100, 0, epochs)).toThrow(/holding period/i);
    expect(() =>
      projectVaultReturns(100, 7, [{ ...epochs[0], pnlPct: -1.1 }])
    ).toThrow(/invalid return/i);
  });
});
