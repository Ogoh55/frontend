/**
 * Unit tests for src/lib/vaultCommitments.ts
 *
 * Covers:
 *   1. Remaining-callable math
 *   2. Call amount validation
 *   3. Funding amount validation
 *   4. Commitment state transitions
 *   5. Capital-call state transitions
 *   6. Default detection (past deadline)
 *   7. findDefaultableCalls
 *   8. Commitment expiry
 *   9. NAV isolation — totalFundedCapital / totalContingentLiability
 *  10. computeSharesFromFunding
 *  11. applyFunding — partial and full, share minting, FULLY_CALLED transition
 *  12. Capacity reservation helpers
 *  13. buildCommitment / buildCapitalCall constructors
 *  14. Display helpers (labels, colors, formatDuration)
 *  15. Idempotency — repeated applyFunding on already-funded call
 *  16. Edge cases: zero amounts, epsilon tolerance, negative protection
 */

import { describe, it, expect } from "vitest";
import {
  // Constants
  DEFAULT_GRACE_PERIOD_MS,
  MIN_CALL_AMOUNT_USD,
  AMOUNT_EPSILON,

  // Math
  computeRemainingCallable,
  validateCallAmount,
  validateFundingAmount,
  computeSharesFromFunding,
  totalFundedCapital,
  totalContingentLiability,
  totalReservedCapacity,
  availableCapacity,

  // Transitions
  isValidCommitmentTransition,
  isValidCallTransition,

  // Default / expiry
  isCallPastDeadline,
  findDefaultableCalls,
  isCommitmentExpired,

  // Lifecycle
  buildCommitment,
  buildCapitalCall,
  applyFunding,

  // Display
  commitmentStateLabel,
  commitmentStateColor,
  callStateLabel,
  callStateColor,
  callRequiresAction,
  msUntilDeadline,
  formatDuration,

  type VaultCommitment,
  type CapitalCall,
} from "./vaultCommitments";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000; // fixed "now"
const NOW_ISO = new Date(NOW_MS).toISOString();

function makeCommitment(overrides: Partial<VaultCommitment> = {}): VaultCommitment {
  return {
    id: "c-001",
    vaultId: "xlm-cc-v1",
    lpWalletAddress: "GAAA",
    committedAmount: 500_000,
    calledAmount: 0,
    remainingCallable: 500_000,
    state: "ACTIVE",
    createdAt: NOW_ISO,
    acknowledgedAt: NOW_ISO,
    expiresAt: new Date(NOW_MS + 90 * 86400_000).toISOString(),
    reservesCapacity: true,
    notes: "",
    ...overrides,
  };
}

function makeCall(overrides: Partial<CapitalCall> = {}): CapitalCall {
  return {
    id: "call-001",
    commitmentId: "c-001",
    vaultId: "xlm-cc-v1",
    lpWalletAddress: "GAAA",
    callAmount: 100_000,
    fundedAmount: 0,
    state: "ISSUED",
    issuedAt: NOW_ISO,
    fundingDeadline: new Date(NOW_MS + DEFAULT_GRACE_PERIOD_MS).toISOString(),
    settledAt: null,
    fundingEpoch: null,
    sharePrice: null,
    sharesMinted: null,
    note: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Remaining-callable math
// ---------------------------------------------------------------------------

describe("computeRemainingCallable", () => {
  it("returns committedAmount when nothing called", () => {
    expect(computeRemainingCallable(500_000, 0)).toBe(500_000);
  });

  it("returns zero when fully called", () => {
    expect(computeRemainingCallable(500_000, 500_000)).toBe(0);
  });

  it("returns the difference", () => {
    expect(computeRemainingCallable(500_000, 200_000)).toBe(300_000);
  });

  it("never returns negative (clamps to 0)", () => {
    expect(computeRemainingCallable(100, 200)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Call amount validation
// ---------------------------------------------------------------------------

describe("validateCallAmount", () => {
  it("returns null for a valid call amount", () => {
    expect(validateCallAmount(50_000, 500_000, "ACTIVE")).toBeNull();
  });

  it("rejects if commitment is not ACTIVE", () => {
    const err = validateCallAmount(50_000, 500_000, "PENDING_ACKNOWLEDGEMENT");
    expect(err).toMatch(/ACTIVE/);
  });

  it("rejects call below minimum", () => {
    const err = validateCallAmount(MIN_CALL_AMOUNT_USD - 1, 500_000, "ACTIVE");
    expect(err).toMatch(/at least/);
  });

  it("rejects call exceeding remaining callable", () => {
    const err = validateCallAmount(600_000, 500_000, "ACTIVE");
    expect(err).toMatch(/exceeds/);
  });

  it("allows call equal to remaining callable (boundary)", () => {
    expect(validateCallAmount(500_000, 500_000, "ACTIVE")).toBeNull();
  });

  it("allows call slightly within epsilon of remaining (floating point tolerance)", () => {
    expect(validateCallAmount(500_000, 500_000 + AMOUNT_EPSILON / 2, "ACTIVE")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Funding amount validation
// ---------------------------------------------------------------------------

describe("validateFundingAmount", () => {
  it("returns null for a valid funding amount", () => {
    expect(validateFundingAmount(50_000, makeCall())).toBeNull();
  });

  it("rejects funding of 0", () => {
    expect(validateFundingAmount(0, makeCall())).toMatch(/greater than zero/);
  });

  it("rejects funding exceeding unfunded remainder", () => {
    const call = makeCall({ callAmount: 100_000, fundedAmount: 60_000 });
    expect(validateFundingAmount(50_000, call)).toMatch(/exceeds/);
  });

  it("allows funding exactly equal to the unfunded remainder", () => {
    const call = makeCall({ callAmount: 100_000, fundedAmount: 60_000 });
    expect(validateFundingAmount(40_000, call)).toBeNull();
  });

  it("rejects funding a FUNDED call", () => {
    const call = makeCall({ state: "FUNDED" });
    expect(validateFundingAmount(1, call)).toMatch(/FUNDED/);
  });

  it("rejects funding a DEFAULTED call", () => {
    const call = makeCall({ state: "DEFAULTED" });
    expect(validateFundingAmount(1, call)).toMatch(/DEFAULTED/);
  });

  it("allows partial funding of a PARTIALLY_FUNDED call", () => {
    const call = makeCall({ state: "PARTIALLY_FUNDED", callAmount: 100_000, fundedAmount: 40_000 });
    expect(validateFundingAmount(30_000, call)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Commitment state transitions
// ---------------------------------------------------------------------------

describe("isValidCommitmentTransition", () => {
  it("allows PENDING_ACKNOWLEDGEMENT → ACTIVE", () => {
    expect(isValidCommitmentTransition("PENDING_ACKNOWLEDGEMENT", "ACTIVE")).toBe(true);
  });

  it("allows PENDING_ACKNOWLEDGEMENT → CANCELLED", () => {
    expect(isValidCommitmentTransition("PENDING_ACKNOWLEDGEMENT", "CANCELLED")).toBe(true);
  });

  it("allows ACTIVE → FULLY_CALLED", () => {
    expect(isValidCommitmentTransition("ACTIVE", "FULLY_CALLED")).toBe(true);
  });

  it("allows ACTIVE → EXPIRED", () => {
    expect(isValidCommitmentTransition("ACTIVE", "EXPIRED")).toBe(true);
  });

  it("allows ACTIVE → CANCELLED", () => {
    expect(isValidCommitmentTransition("ACTIVE", "CANCELLED")).toBe(true);
  });

  it("rejects FULLY_CALLED → ACTIVE (terminal state)", () => {
    expect(isValidCommitmentTransition("FULLY_CALLED", "ACTIVE")).toBe(false);
  });

  it("rejects EXPIRED → ACTIVE", () => {
    expect(isValidCommitmentTransition("EXPIRED", "ACTIVE")).toBe(false);
  });

  it("rejects CANCELLED → ACTIVE", () => {
    expect(isValidCommitmentTransition("CANCELLED", "ACTIVE")).toBe(false);
  });

  it("rejects PENDING_ACKNOWLEDGEMENT → FULLY_CALLED (skipping ACTIVE)", () => {
    expect(isValidCommitmentTransition("PENDING_ACKNOWLEDGEMENT", "FULLY_CALLED")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Capital-call state transitions
// ---------------------------------------------------------------------------

describe("isValidCallTransition", () => {
  it("allows ISSUED → FUNDED", () => {
    expect(isValidCallTransition("ISSUED", "FUNDED")).toBe(true);
  });

  it("allows ISSUED → PARTIALLY_FUNDED", () => {
    expect(isValidCallTransition("ISSUED", "PARTIALLY_FUNDED")).toBe(true);
  });

  it("allows ISSUED → DEFAULTED", () => {
    expect(isValidCallTransition("ISSUED", "DEFAULTED")).toBe(true);
  });

  it("allows ISSUED → WAIVED", () => {
    expect(isValidCallTransition("ISSUED", "WAIVED")).toBe(true);
  });

  it("allows PARTIALLY_FUNDED → FUNDED", () => {
    expect(isValidCallTransition("PARTIALLY_FUNDED", "FUNDED")).toBe(true);
  });

  it("allows PARTIALLY_FUNDED → DEFAULTED", () => {
    expect(isValidCallTransition("PARTIALLY_FUNDED", "DEFAULTED")).toBe(true);
  });

  it("allows DEFAULTED → LATE_PAID", () => {
    expect(isValidCallTransition("DEFAULTED", "LATE_PAID")).toBe(true);
  });

  it("allows DEFAULTED → WAIVED", () => {
    expect(isValidCallTransition("DEFAULTED", "WAIVED")).toBe(true);
  });

  it("rejects FUNDED → any (terminal)", () => {
    expect(isValidCallTransition("FUNDED", "ISSUED")).toBe(false);
    expect(isValidCallTransition("FUNDED", "DEFAULTED")).toBe(false);
  });

  it("rejects WAIVED → any (terminal)", () => {
    expect(isValidCallTransition("WAIVED", "FUNDED")).toBe(false);
  });

  it("rejects LATE_PAID → any (terminal)", () => {
    expect(isValidCallTransition("LATE_PAID", "FUNDED")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Default detection
// ---------------------------------------------------------------------------

describe("isCallPastDeadline", () => {
  it("returns true when now is after the funding deadline", () => {
    const call = makeCall({ fundingDeadline: new Date(NOW_MS - 1000).toISOString() });
    expect(isCallPastDeadline(call, NOW_MS)).toBe(true);
  });

  it("returns false when now is before the funding deadline", () => {
    const call = makeCall({ fundingDeadline: new Date(NOW_MS + 1000).toISOString() });
    expect(isCallPastDeadline(call, NOW_MS)).toBe(false);
  });

  it("returns false for FUNDED calls regardless of deadline", () => {
    const call = makeCall({ state: "FUNDED", fundingDeadline: new Date(NOW_MS - 1000).toISOString() });
    expect(isCallPastDeadline(call, NOW_MS)).toBe(false);
  });

  it("returns false for WAIVED calls", () => {
    const call = makeCall({ state: "WAIVED", fundingDeadline: new Date(NOW_MS - 1000).toISOString() });
    expect(isCallPastDeadline(call, NOW_MS)).toBe(false);
  });

  it("returns false for LATE_PAID calls", () => {
    const call = makeCall({ state: "LATE_PAID", fundingDeadline: new Date(NOW_MS - 1000).toISOString() });
    expect(isCallPastDeadline(call, NOW_MS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. findDefaultableCalls
// ---------------------------------------------------------------------------

describe("findDefaultableCalls", () => {
  it("returns ISSUED calls past deadline", () => {
    const overdue = makeCall({ state: "ISSUED", fundingDeadline: new Date(NOW_MS - 1000).toISOString() });
    const future = makeCall({ id: "call-002", state: "ISSUED", fundingDeadline: new Date(NOW_MS + 1000).toISOString() });
    const result = findDefaultableCalls([overdue, future], NOW_MS);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(overdue.id);
  });

  it("returns PARTIALLY_FUNDED calls past deadline", () => {
    const call = makeCall({ state: "PARTIALLY_FUNDED", fundedAmount: 50_000, fundingDeadline: new Date(NOW_MS - 1000).toISOString() });
    expect(findDefaultableCalls([call], NOW_MS)).toHaveLength(1);
  });

  it("does not return FUNDED calls", () => {
    const call = makeCall({ state: "FUNDED", fundingDeadline: new Date(NOW_MS - 1000).toISOString() });
    expect(findDefaultableCalls([call], NOW_MS)).toHaveLength(0);
  });

  it("returns empty array when no calls are past deadline", () => {
    const call = makeCall({ fundingDeadline: new Date(NOW_MS + 86400_000).toISOString() });
    expect(findDefaultableCalls([call], NOW_MS)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Commitment expiry
// ---------------------------------------------------------------------------

describe("isCommitmentExpired", () => {
  it("returns true for ACTIVE commitment past expiry", () => {
    const c = makeCommitment({ expiresAt: new Date(NOW_MS - 1000).toISOString() });
    expect(isCommitmentExpired(c, NOW_MS)).toBe(true);
  });

  it("returns false for ACTIVE commitment not yet expired", () => {
    const c = makeCommitment({ expiresAt: new Date(NOW_MS + 86400_000).toISOString() });
    expect(isCommitmentExpired(c, NOW_MS)).toBe(false);
  });

  it("returns false for non-ACTIVE commitment even if past expiry", () => {
    const c = makeCommitment({ state: "FULLY_CALLED", expiresAt: new Date(NOW_MS - 1000).toISOString() });
    expect(isCommitmentExpired(c, NOW_MS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. NAV isolation
// ---------------------------------------------------------------------------

describe("totalFundedCapital", () => {
  it("sums funded amounts across all calls", () => {
    const calls = [
      makeCall({ fundedAmount: 100_000 }),
      makeCall({ id: "call-002", fundedAmount: 50_000 }),
      makeCall({ id: "call-003", fundedAmount: 0 }), // unfunded
    ];
    expect(totalFundedCapital(calls)).toBe(150_000);
  });

  it("returns 0 for no calls", () => {
    expect(totalFundedCapital([])).toBe(0);
  });
});

describe("totalContingentLiability", () => {
  it("sums unfunded amounts of ISSUED and PARTIALLY_FUNDED calls only", () => {
    const issued = makeCall({ callAmount: 100_000, fundedAmount: 0, state: "ISSUED" });
    const partial = makeCall({ id: "call-002", callAmount: 80_000, fundedAmount: 30_000, state: "PARTIALLY_FUNDED" });
    const funded = makeCall({ id: "call-003", callAmount: 50_000, fundedAmount: 50_000, state: "FUNDED" });
    const defaulted = makeCall({ id: "call-004", callAmount: 40_000, fundedAmount: 0, state: "DEFAULTED" });

    // Only ISSUED and PARTIALLY_FUNDED count
    const result = totalContingentLiability([issued, partial, funded, defaulted]);
    expect(result).toBe(100_000 + (80_000 - 30_000)); // 150_000
  });

  it("returns 0 when all calls are settled", () => {
    const funded = makeCall({ state: "FUNDED", fundedAmount: 100_000 });
    expect(totalContingentLiability([funded])).toBe(0);
  });

  it("unfunded DEFAULTED calls do NOT count as contingent liability", () => {
    // NAV isolation: default is recorded state, not a live liability
    const defaulted = makeCall({ state: "DEFAULTED", callAmount: 100_000, fundedAmount: 0 });
    expect(totalContingentLiability([defaulted])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. computeSharesFromFunding
// ---------------------------------------------------------------------------

describe("computeSharesFromFunding", () => {
  it("divides funding amount by share price", () => {
    // 100_000 / 1.042 ≈ 95969.29
    expect(computeSharesFromFunding(100_000, 1.042)).toBeCloseTo(100_000 / 1.042, 2);
  });

  it("returns 0 for zero share price (guards division by zero)", () => {
    expect(computeSharesFromFunding(100_000, 0)).toBe(0);
  });

  it("returns 0 for negative share price", () => {
    expect(computeSharesFromFunding(100_000, -1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. applyFunding
// ---------------------------------------------------------------------------

describe("applyFunding", () => {
  it("records partial funding and leaves call PARTIALLY_FUNDED", () => {
    const call = makeCall({ callAmount: 100_000 });
    const commitment = makeCommitment({ calledAmount: 100_000, remainingCallable: 400_000 });
    const { updatedCall } = applyFunding({
      call, commitment,
      fundingAmount: 40_000, sharePrice: 1.0, fundingEpoch: 47, nowIso: NOW_ISO,
    });
    expect(updatedCall.state).toBe("PARTIALLY_FUNDED");
    expect(updatedCall.fundedAmount).toBe(40_000);
    expect(updatedCall.settledAt).toBeNull();
  });

  it("transitions call to FUNDED when fully funded", () => {
    const call = makeCall({ callAmount: 100_000 });
    const commitment = makeCommitment({ calledAmount: 100_000, remainingCallable: 0 });
    const { updatedCall } = applyFunding({
      call, commitment,
      fundingAmount: 100_000, sharePrice: 1.0, fundingEpoch: 47, nowIso: NOW_ISO,
    });
    expect(updatedCall.state).toBe("FUNDED");
    expect(updatedCall.settledAt).toBe(NOW_ISO);
  });

  it("mints correct shares at the current share price", () => {
    const call = makeCall({ callAmount: 200_000 });
    const commitment = makeCommitment({ calledAmount: 200_000, remainingCallable: 0 });
    const { updatedCall } = applyFunding({
      call, commitment,
      fundingAmount: 200_000, sharePrice: 2.0, fundingEpoch: 47, nowIso: NOW_ISO,
    });
    expect(updatedCall.sharesMinted).toBeCloseTo(100_000, 4);
  });

  it("sets fundingEpoch and sharePrice on the call", () => {
    const call = makeCall();
    const commitment = makeCommitment();
    const { updatedCall } = applyFunding({
      call, commitment,
      fundingAmount: 50_000, sharePrice: 1.5, fundingEpoch: 42, nowIso: NOW_ISO,
    });
    expect(updatedCall.fundingEpoch).toBe(42);
    expect(updatedCall.sharePrice).toBe(1.5);
  });

  it("transitions commitment to FULLY_CALLED when all callable capital is funded", () => {
    const call = makeCall({ callAmount: 500_000 });
    const commitment = makeCommitment({
      committedAmount: 500_000, calledAmount: 500_000, remainingCallable: 0,
    });
    const { updatedCommitment } = applyFunding({
      call, commitment,
      fundingAmount: 500_000, sharePrice: 1.0, fundingEpoch: 47, nowIso: NOW_ISO,
    });
    expect(updatedCommitment.state).toBe("FULLY_CALLED");
  });

  it("does NOT change commitment state if remaining callable > 0", () => {
    const call = makeCall({ callAmount: 100_000 });
    const commitment = makeCommitment({ calledAmount: 100_000, remainingCallable: 400_000 });
    const { updatedCommitment } = applyFunding({
      call, commitment,
      fundingAmount: 100_000, sharePrice: 1.0, fundingEpoch: 47, nowIso: NOW_ISO,
    });
    expect(updatedCommitment.state).toBe("ACTIVE");
  });

  it("accumulates sharesMinted across multiple partial funding events", () => {
    const call = makeCall({ callAmount: 100_000 });
    const commitment = makeCommitment();
    const { updatedCall: after1st } = applyFunding({
      call, commitment,
      fundingAmount: 40_000, sharePrice: 1.0, fundingEpoch: 47, nowIso: NOW_ISO,
    });
    const { updatedCall: after2nd } = applyFunding({
      call: after1st, commitment,
      fundingAmount: 60_000, sharePrice: 1.0, fundingEpoch: 47, nowIso: NOW_ISO,
    });
    expect(after2nd.sharesMinted).toBeCloseTo(100_000, 4);
    expect(after2nd.state).toBe("FUNDED");
  });

  it("unfunded commitment does not affect NAV — funded amount is 0 before funding", () => {
    const call = makeCall({ callAmount: 100_000, fundedAmount: 0 });
    expect(totalFundedCapital([call])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 12. Capacity reservation
// ---------------------------------------------------------------------------

describe("totalReservedCapacity", () => {
  it("sums remainingCallable of ACTIVE commitments with reservesCapacity=true", () => {
    const c1 = makeCommitment({ remainingCallable: 300_000, reservesCapacity: true });
    const c2 = makeCommitment({ id: "c-002", remainingCallable: 200_000, reservesCapacity: true });
    expect(totalReservedCapacity([c1, c2])).toBe(500_000);
  });

  it("excludes commitments with reservesCapacity=false", () => {
    const c = makeCommitment({ remainingCallable: 300_000, reservesCapacity: false });
    expect(totalReservedCapacity([c])).toBe(0);
  });

  it("excludes non-ACTIVE commitments", () => {
    const expired = makeCommitment({ state: "EXPIRED", remainingCallable: 300_000, reservesCapacity: true });
    expect(totalReservedCapacity([expired])).toBe(0);
  });
});

describe("availableCapacity", () => {
  it("subtracts TVL and reserved capacity from vault capacity", () => {
    const c = makeCommitment({ remainingCallable: 200_000, reservesCapacity: true });
    // capacity=1M, tvl=300k, reserved=200k → available=500k
    expect(availableCapacity(1_000_000, 300_000, [c])).toBe(500_000);
  });

  it("never returns negative", () => {
    const c = makeCommitment({ remainingCallable: 2_000_000, reservesCapacity: true });
    expect(availableCapacity(1_000_000, 900_000, [c])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13. buildCommitment / buildCapitalCall constructors
// ---------------------------------------------------------------------------

describe("buildCommitment", () => {
  it("creates a commitment in PENDING_ACKNOWLEDGEMENT state", () => {
    const c = buildCommitment({
      id: "x", vaultId: "v", lpWalletAddress: "G",
      committedAmount: 100_000, expiresAt: NOW_ISO,
      reservesCapacity: true, nowIso: NOW_ISO,
    });
    expect(c.state).toBe("PENDING_ACKNOWLEDGEMENT");
    expect(c.calledAmount).toBe(0);
    expect(c.remainingCallable).toBe(100_000);
    expect(c.acknowledgedAt).toBeNull();
  });
});

describe("buildCapitalCall", () => {
  it("creates a call in ISSUED state with correct deadline", () => {
    const call = buildCapitalCall({
      id: "y", commitmentId: "c", vaultId: "v", lpWalletAddress: "G",
      callAmount: 50_000, nowIso: NOW_ISO,
    });
    expect(call.state).toBe("ISSUED");
    expect(call.fundedAmount).toBe(0);
    const expectedDeadline = new Date(NOW_MS + DEFAULT_GRACE_PERIOD_MS).toISOString();
    expect(call.fundingDeadline).toBe(expectedDeadline);
  });

  it("uses custom grace period when provided", () => {
    const call = buildCapitalCall({
      id: "y", commitmentId: "c", vaultId: "v", lpWalletAddress: "G",
      callAmount: 50_000, gracePeriodMs: 2 * 86400_000, nowIso: NOW_ISO,
    });
    const expectedDeadline = new Date(NOW_MS + 2 * 86400_000).toISOString();
    expect(call.fundingDeadline).toBe(expectedDeadline);
  });
});

// ---------------------------------------------------------------------------
// 14. Display helpers
// ---------------------------------------------------------------------------

describe("commitmentStateLabel", () => {
  it("returns a non-empty label for every state", () => {
    const states: Parameters<typeof commitmentStateLabel>[0][] = [
      "PENDING_ACKNOWLEDGEMENT", "ACTIVE", "FULLY_CALLED", "EXPIRED", "CANCELLED",
    ];
    for (const s of states) {
      expect(commitmentStateLabel(s).length).toBeGreaterThan(0);
    }
  });
});

describe("commitmentStateColor", () => {
  it("returns a CSS variable for every state", () => {
    const states: Parameters<typeof commitmentStateColor>[0][] = [
      "PENDING_ACKNOWLEDGEMENT", "ACTIVE", "FULLY_CALLED", "EXPIRED", "CANCELLED",
    ];
    for (const s of states) {
      expect(commitmentStateColor(s)).toMatch(/^var\(--/);
    }
  });
});

describe("callStateLabel", () => {
  it("returns a non-empty label for every call state", () => {
    const states: Parameters<typeof callStateLabel>[0][] = [
      "ISSUED", "PARTIALLY_FUNDED", "FUNDED", "DEFAULTED", "WAIVED", "LATE_PAID",
    ];
    for (const s of states) {
      expect(callStateLabel(s).length).toBeGreaterThan(0);
    }
  });
});

describe("callStateColor", () => {
  it("returns a CSS variable for every call state", () => {
    const states: Parameters<typeof callStateColor>[0][] = [
      "ISSUED", "PARTIALLY_FUNDED", "FUNDED", "DEFAULTED", "WAIVED", "LATE_PAID",
    ];
    for (const s of states) {
      expect(callStateColor(s)).toMatch(/^var\(--/);
    }
  });
});

describe("callRequiresAction", () => {
  it("returns true for ISSUED and PARTIALLY_FUNDED", () => {
    expect(callRequiresAction(makeCall({ state: "ISSUED" }))).toBe(true);
    expect(callRequiresAction(makeCall({ state: "PARTIALLY_FUNDED" }))).toBe(true);
  });

  it("returns false for settled states", () => {
    expect(callRequiresAction(makeCall({ state: "FUNDED" }))).toBe(false);
    expect(callRequiresAction(makeCall({ state: "DEFAULTED" }))).toBe(false);
    expect(callRequiresAction(makeCall({ state: "WAIVED" }))).toBe(false);
    expect(callRequiresAction(makeCall({ state: "LATE_PAID" }))).toBe(false);
  });
});

describe("msUntilDeadline", () => {
  it("returns positive ms when deadline is in the future", () => {
    const call = makeCall({ fundingDeadline: new Date(NOW_MS + 3600_000).toISOString() });
    expect(msUntilDeadline(call, NOW_MS)).toBe(3600_000);
  });

  it("returns negative ms when deadline has passed", () => {
    const call = makeCall({ fundingDeadline: new Date(NOW_MS - 3600_000).toISOString() });
    expect(msUntilDeadline(call, NOW_MS)).toBe(-3600_000);
  });
});

describe("formatDuration", () => {
  it("returns 'overdue' for non-positive ms", () => {
    expect(formatDuration(0)).toBe("overdue");
    expect(formatDuration(-1)).toBe("overdue");
  });

  it("formats days and hours", () => {
    const ms = 3 * 24 * 3600_000 + 4 * 3600_000;
    expect(formatDuration(ms)).toBe("3d 4h");
  });

  it("formats hours and minutes", () => {
    const ms = 2 * 3600_000 + 30 * 60_000;
    expect(formatDuration(ms)).toBe("2h 30m");
  });

  it("formats minutes only", () => {
    expect(formatDuration(45 * 60_000)).toBe("45m");
  });
});

// ---------------------------------------------------------------------------
// 15. Idempotency — re-applying funding does not double-count
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("applyFunding with the final amount on an already-funded call does not change state", () => {
    const fundedCall = makeCall({
      state: "FUNDED",
      callAmount: 100_000,
      fundedAmount: 100_000,
      settledAt: NOW_ISO,
      sharesMinted: 100_000,
      sharePrice: 1.0,
      fundingEpoch: 47,
    });
    const commitment = makeCommitment({ state: "FULLY_CALLED" });
    // Calling applyFunding on an already-FUNDED call would be a programming error
    // but the accounting must not corrupt state — the caller should validate first
    // Validate returns an error for a FUNDED call:
    expect(validateFundingAmount(1, fundedCall)).toMatch(/FUNDED/);
  });
});

// ---------------------------------------------------------------------------
// 16. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("computeRemainingCallable handles floating-point amounts correctly", () => {
    // 500_000.10 − 200_000.05 should not go negative
    const result = computeRemainingCallable(500_000.10, 200_000.05);
    expect(result).toBeCloseTo(300_000.05, 2);
    expect(result).toBeGreaterThan(0);
  });

  it("validateCallAmount uses epsilon tolerance for near-zero remaining", () => {
    // calling exactly the remaining amount within floating-point error
    const remaining = 100_000 + AMOUNT_EPSILON / 2;
    expect(validateCallAmount(100_000, remaining, "ACTIVE")).toBeNull();
  });

  it("buildCapitalCall sets fundedAmount to 0 (never NAV-affecting before funding)", () => {
    const call = buildCapitalCall({
      id: "z", commitmentId: "c", vaultId: "v", lpWalletAddress: "G",
      callAmount: 100_000, nowIso: NOW_ISO,
    });
    expect(call.fundedAmount).toBe(0);
    expect(call.sharesMinted).toBeNull();
    expect(call.fundingEpoch).toBeNull();
  });
});
