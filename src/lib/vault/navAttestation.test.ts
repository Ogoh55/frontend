/**
 * Tests for navAttestation.ts — #257 Multi-Signer Attested NAV Submission
 */

import { describe, it, expect } from "vitest";
import {
  addAttestation,
  attestationsNeeded,
  canonicalAttestationMessage,
  DEFAULT_NAV_ROUND_CONFIG,
  evaluateRound,
  median,
  navFallback,
  navSubmissionStatusLabel,
  openNavRound,
  relativeSpread,
  type NavAttestation,
  type NavSubmissionRound,
  type NavRoundConfig,
} from "./navAttestation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VAULT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const EPOCH = 12;

function makeAttestation(submitter: string, navPerShare: string, offset = 0): NavAttestation {
  const ts = new Date(1_700_000_000_000 + offset).toISOString();
  return {
    submitter,
    vaultId: VAULT_ID,
    epoch: EPOCH,
    navPerShare,
    submittedAt: ts,
    signature: "deadbeef",
  };
}

const A1 = makeAttestation("GAAA", "1.04200000", 0);
const A2 = makeAttestation("GBBB", "1.04210000", 1000);
const A3 = makeAttestation("GCCC", "1.04190000", 2000);

// ---------------------------------------------------------------------------
// median / relativeSpread
// ---------------------------------------------------------------------------
describe("median", () => {
  it("returns null for empty array", () => expect(median([])).toBeNull());
  it("returns single value", () => expect(median([5])).toBe(5));
  it("returns middle of odd array", () => expect(median([1, 3, 5])).toBe(3));
  it("returns average of middle pair for even array", () => expect(median([1, 2, 3, 4])).toBe(2.5));
  it("handles unsorted input", () => expect(median([5, 1, 3])).toBe(3));
});

describe("relativeSpread", () => {
  it("returns null for empty array", () => expect(relativeSpread([])).toBeNull());
  it("returns 0 for single value", () => expect(relativeSpread([2])).toBe(0));
  it("computes (max-min)/median", () => {
    // values [1, 2, 3], median 2, spread (3-1)/2 = 1
    expect(relativeSpread([1, 2, 3])).toBeCloseTo(1);
  });
  it("returns null when median is zero", () => expect(relativeSpread([0, 0, 0])).toBeNull());
});

// ---------------------------------------------------------------------------
// canonicalAttestationMessage
// ---------------------------------------------------------------------------
describe("canonicalAttestationMessage", () => {
  it("produces deterministic string", () => {
    const msg = canonicalAttestationMessage(A1);
    expect(msg).toBe(`zenith:nav:${VAULT_ID}:${EPOCH}:${A1.navPerShare}:${A1.submittedAt}`);
  });

  it("two different nav values produce different messages", () => {
    const msg1 = canonicalAttestationMessage(A1);
    const msg2 = canonicalAttestationMessage(A2);
    expect(msg1).not.toBe(msg2);
  });
});

// ---------------------------------------------------------------------------
// openNavRound
// ---------------------------------------------------------------------------
describe("openNavRound", () => {
  it("creates a PENDING round with no attestations", () => {
    const round = openNavRound(VAULT_ID, EPOCH);
    expect(round.status).toBe("PENDING");
    expect(round.attestations).toHaveLength(0);
    expect(round.acceptedNav).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addAttestation
// ---------------------------------------------------------------------------
describe("addAttestation", () => {
  it("adds an attestation and sets openedAt on first add", () => {
    const round = openNavRound(VAULT_ID, EPOCH);
    const r2 = addAttestation(round, A1);
    expect(r2.attestations).toHaveLength(1);
    expect(r2.openedAt).not.toBeNull();
  });

  it("preserves openedAt on subsequent adds", () => {
    const round = openNavRound(VAULT_ID, EPOCH);
    const r2 = addAttestation(round, A1, "2024-01-01T00:00:00Z");
    const r3 = addAttestation(r2, A2, "2024-01-01T00:01:00Z");
    expect(r3.openedAt).toBe(r2.openedAt);
  });

  it("rejects duplicate submitter", () => {
    const round = openNavRound(VAULT_ID, EPOCH);
    const r2 = addAttestation(round, A1);
    expect(() => addAttestation(r2, A1)).toThrow(/already attested/);
  });

  it("rejects wrong vault_id", () => {
    const round = openNavRound(VAULT_ID, EPOCH);
    const wrongVault = { ...A1, vaultId: "CZZZZZ" };
    expect(() => addAttestation(round, wrongVault)).toThrow(/vault_id/);
  });

  it("rejects wrong epoch", () => {
    const round = openNavRound(VAULT_ID, EPOCH);
    const wrongEpoch = { ...A1, epoch: 99 };
    expect(() => addAttestation(round, wrongEpoch)).toThrow(/epoch/);
  });

  it("rejects adding to a non-PENDING round", () => {
    let round = openNavRound(VAULT_ID, EPOCH);
    round = addAttestation(round, A1);
    round = addAttestation(round, A2);
    round = addAttestation(round, A3);
    round = evaluateRound(round, DEFAULT_NAV_ROUND_CONFIG);
    expect(round.status).toBe("ACCEPTED");
    expect(() => addAttestation(round, makeAttestation("GDDD", "1.04200000"))).toThrow(/ACCEPTED/);
  });
});

// ---------------------------------------------------------------------------
// evaluateRound — ACCEPTED
// ---------------------------------------------------------------------------
describe("evaluateRound — ACCEPTED", () => {
  function buildAcceptedRound(): NavSubmissionRound {
    let round = openNavRound(VAULT_ID, EPOCH);
    round = addAttestation(round, A1);
    round = addAttestation(round, A2);
    round = addAttestation(round, A3);
    return evaluateRound(round, DEFAULT_NAV_ROUND_CONFIG);
  }

  it("reaches ACCEPTED when quorum is met with small spread", () => {
    expect(buildAcceptedRound().status).toBe("ACCEPTED");
  });

  it("accepted NAV is the median of submitted values", () => {
    const round = buildAcceptedRound();
    // Values: 1.04200000, 1.04210000, 1.04190000 → sorted: 1.04190000, 1.04200000, 1.04210000 → median 1.04200000
    expect(parseFloat(round.acceptedNav!)).toBeCloseTo(1.042, 4);
  });

  it("sets closedAt", () => {
    expect(buildAcceptedRound().closedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateRound — DISPUTED
// ---------------------------------------------------------------------------
describe("evaluateRound — DISPUTED", () => {
  it("disputes when spread exceeds tolerance", () => {
    const B1 = makeAttestation("GAAA", "1.000");
    const B2 = makeAttestation("GBBB", "1.050"); // 5% spread, > 0.5% tolerance
    const B3 = makeAttestation("GCCC", "1.025");
    let round = openNavRound(VAULT_ID, EPOCH);
    round = addAttestation(round, B1);
    round = addAttestation(round, B2);
    round = addAttestation(round, B3);
    round = evaluateRound(round, DEFAULT_NAV_ROUND_CONFIG);
    expect(round.status).toBe("DISPUTED");
    expect(round.acceptedNav).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateRound — EXPIRED
// ---------------------------------------------------------------------------
describe("evaluateRound — EXPIRED", () => {
  it("expires after the window without quorum", () => {
    const config: NavRoundConfig = { ...DEFAULT_NAV_ROUND_CONFIG, windowSeconds: 60 };
    let round = openNavRound(VAULT_ID, EPOCH);
    round = addAttestation(round, A1, "2024-01-01T00:00:00Z");
    // Only 1 of 3 required; evaluate 2 minutes later
    round = evaluateRound(round, config, "2024-01-01T00:02:00Z");
    expect(round.status).toBe("EXPIRED");
  });

  it("does not expire before the window closes", () => {
    const config: NavRoundConfig = { ...DEFAULT_NAV_ROUND_CONFIG, windowSeconds: 300 };
    let round = openNavRound(VAULT_ID, EPOCH);
    round = addAttestation(round, A1, "2024-01-01T00:00:00Z");
    round = evaluateRound(round, config, "2024-01-01T00:01:00Z");
    expect(round.status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// navFallback
// ---------------------------------------------------------------------------
describe("navFallback", () => {
  it("returns last accepted NAV on DISPUTED", () => {
    let round = openNavRound(VAULT_ID, EPOCH);
    round = { ...round, status: "DISPUTED", closedAt: new Date().toISOString() };
    const result = navFallback(round, "1.03500000");
    expect(result.reason).toBe("DISPUTED");
    expect(result.fallbackNav).toBe("1.03500000");
  });

  it("returns last accepted NAV on EXPIRED", () => {
    let round = openNavRound(VAULT_ID, EPOCH);
    round = { ...round, status: "EXPIRED", closedAt: new Date().toISOString() };
    const result = navFallback(round, "1.02000000");
    expect(result.reason).toBe("EXPIRED");
    expect(result.fallbackNav).toBe("1.02000000");
  });

  it("throws for non-terminal status", () => {
    const round = openNavRound(VAULT_ID, EPOCH);
    expect(() => navFallback(round, "1.0")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
describe("attestationsNeeded", () => {
  it("returns remaining count to reach quorum", () => {
    let round = openNavRound(VAULT_ID, EPOCH);
    expect(attestationsNeeded(round, DEFAULT_NAV_ROUND_CONFIG)).toBe(3);
    round = addAttestation(round, A1);
    expect(attestationsNeeded(round, DEFAULT_NAV_ROUND_CONFIG)).toBe(2);
  });
});

describe("navSubmissionStatusLabel", () => {
  it("returns readable labels", () => {
    expect(navSubmissionStatusLabel("PENDING")).toBe("Collecting attestations");
    expect(navSubmissionStatusLabel("ACCEPTED")).toBe("Accepted");
    expect(navSubmissionStatusLabel("DISPUTED")).toBe("Disputed");
    expect(navSubmissionStatusLabel("EXPIRED")).toBe("Expired");
  });
});
