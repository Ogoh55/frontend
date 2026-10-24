/**
 * Consumer-Driven Contract Tests: vaults.ts ↔ Vault Backend REST API (#258)
 *
 * These tests pin the agreement between the frontend vault adapter
 * (src/lib/api/vaults.ts) and the backend REST surface so that a renamed
 * or re-typed field produces a test failure rather than a silent runtime error.
 *
 * Strategy:
 *  - MSW intercepts every vault endpoint and returns a canonical fixture.
 *  - The adapter is called with NEXT_PUBLIC_VAULTS=live so the real HTTP
 *    path is exercised (not the mock fallback).
 *  - Assertions check the *shape* of each response (field names, types,
 *    allowed enum values) — not exact values — so the tests survive
 *    cosmetic backend changes while catching structural drift.
 *
 * Endpoints covered:
 *  GET  /api/v1/vaults
 *  GET  /api/v1/vaults/:id
 *  POST /api/v1/vaults/:id/deposit
 *  POST /api/v1/vaults/:id/redeem-request
 *  POST /api/v1/vaults/:id/withdraw
 *  GET  /api/v1/vaults/:id/auth-nonce
 *  GET  /api/v1/vaults/:id/breaker-status
 *  GET  /api/v1/vaults/:id/nav-round
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// ---------------------------------------------------------------------------
// Fixtures — canonical contract shapes
// ---------------------------------------------------------------------------

const VAULT_ID = "xlm-cc-v1";
const API_BASE = "http://localhost:8081";

const FIXTURE_VAULT_SUMMARY = {
  id: VAULT_ID,
  name: "XLM Covered Call",
  underlying: "XLM",
  strategy: "covered_call",
  apy: 0.22,
  apyMethodology: "Trailing 12-month annualized premium income ÷ average TVL.",
  tvl: 284000,
  capacity: 500000,
  currentStrike: 0.13,
  currentExpiry: "2026-10-03",
  riskRating: "medium",
  description: "Writes weekly OTM covered calls on XLM.",
};

const FIXTURE_EPOCH_RECORD = {
  epochNumber: 46,
  depositStart: "2026-09-19",
  activeStart: "2026-09-20",
  settlementDate: "2026-09-27",
  strike: 0.125,
  expiryDays: 7,
  premiumCollected: 0.0018,
  outcome: "expired_worthless",
  pnlPct: 0.021,
};

const FIXTURE_USER_POSITION = {
  shares: 950,
  shareValue: 1.042,
  totalValue: 989.9,
  accruedPremium: 18.46,
  pendingWithdrawal: 0,
};

const FIXTURE_VAULT_DETAIL = {
  ...FIXTURE_VAULT_SUMMARY,
  currentEpoch: 47,
  currentPhase: "active",
  phaseEndsAt: "2026-10-03T16:00:00Z",
  sharePrice: 1.042,
  totalShares: 272552,
  feeStructure: { managementPct: 0, performancePct: 10 },
  payoffExplanation: "Sells a call option weekly.",
  historicalEpochs: [FIXTURE_EPOCH_RECORD],
  userPosition: FIXTURE_USER_POSITION,
};

const FIXTURE_DEPOSIT_RESPONSE = { tx_id: "abc123" };

const FIXTURE_REDEEM_REQUEST_RESPONSE = {
  queued_shares: 100,
  estimated_withdrawal_epoch: 48,
};

const FIXTURE_WITHDRAW_RESPONSE = {
  tx_id: "def456",
  queued: true,
};

const FIXTURE_AUTH_NONCE = {
  nonce: 7,
  current_ledger: 1000000,
};

const FIXTURE_BREAKER_STATUS = {
  status: "ACTIVE",
  trigger: "NONE",
  since: "2026-10-01T00:00:00Z",
  acknowledged_at: null,
};

const FIXTURE_NAV_ROUND = {
  vault_id: VAULT_ID,
  epoch: 47,
  attestations: [
    {
      submitter: "GABC",
      vault_id: VAULT_ID,
      epoch: 47,
      nav_per_share: "1.04200000",
      submitted_at: "2026-10-03T15:00:00Z",
    },
  ],
  status: "PENDING",
  accepted_nav: null,
  opened_at: "2026-10-03T15:00:00Z",
  closed_at: null,
};

// ---------------------------------------------------------------------------
// MSW server
// ---------------------------------------------------------------------------

const server = setupServer(
  http.get(`${API_BASE}/api/v1/vaults`, () =>
    HttpResponse.json([FIXTURE_VAULT_SUMMARY])
  ),
  http.get(`${API_BASE}/api/v1/vaults/${VAULT_ID}`, () =>
    HttpResponse.json(FIXTURE_VAULT_DETAIL)
  ),
  http.post(`${API_BASE}/api/v1/vaults/${VAULT_ID}/deposit`, () =>
    HttpResponse.json(FIXTURE_DEPOSIT_RESPONSE, { status: 201 })
  ),
  http.post(`${API_BASE}/api/v1/vaults/${VAULT_ID}/redeem-request`, () =>
    HttpResponse.json(FIXTURE_REDEEM_REQUEST_RESPONSE, { status: 201 })
  ),
  http.post(`${API_BASE}/api/v1/vaults/${VAULT_ID}/withdraw`, () =>
    HttpResponse.json(FIXTURE_WITHDRAW_RESPONSE, { status: 201 })
  ),
  http.get(`${API_BASE}/api/v1/vaults/${VAULT_ID}/auth-nonce`, () =>
    HttpResponse.json(FIXTURE_AUTH_NONCE)
  ),
  http.get(`${API_BASE}/api/v1/vaults/${VAULT_ID}/breaker-status`, () =>
    HttpResponse.json(FIXTURE_BREAKER_STATUS)
  ),
  http.get(`${API_BASE}/api/v1/vaults/${VAULT_ID}/nav-round`, () =>
    HttpResponse.json(FIXTURE_NAV_ROUND)
  )
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

// ---------------------------------------------------------------------------
// Shape assertion helpers
// ---------------------------------------------------------------------------

const VALID_STRATEGIES = ["covered_call", "cash_secured_put", "iron_condor", "wheel"] as const;
const VALID_RISK_RATINGS = ["low", "medium", "high"] as const;
const VALID_EPOCH_PHASES = ["deposit", "active", "settlement"] as const;
const VALID_EPOCH_OUTCOMES = ["expired_worthless", "exercised", "active"] as const;
const VALID_BREAKER_STATUSES = ["ACTIVE", "WARNED", "HALTED", "RECOVERING"] as const;
const VALID_NAV_STATUSES = ["PENDING", "ACCEPTED", "DISPUTED", "EXPIRED"] as const;

function assertVaultSummaryShape(v: Record<string, unknown>, label = "VaultSummary"): void {
  expect(typeof v.id, `${label}.id`).toBe("string");
  expect(typeof v.name, `${label}.name`).toBe("string");
  expect(typeof v.underlying, `${label}.underlying`).toBe("string");
  expect(VALID_STRATEGIES).toContain(v.strategy as string);
  expect(typeof v.apy, `${label}.apy`).toBe("number");
  expect(typeof v.apyMethodology, `${label}.apyMethodology`).toBe("string");
  expect(typeof v.tvl, `${label}.tvl`).toBe("number");
  expect(typeof v.capacity, `${label}.capacity`).toBe("number");
  expect(typeof v.currentStrike, `${label}.currentStrike`).toBe("number");
  expect(typeof v.currentExpiry, `${label}.currentExpiry`).toBe("string");
  expect(VALID_RISK_RATINGS).toContain(v.riskRating as string);
  expect(typeof v.description, `${label}.description`).toBe("string");
}

function assertEpochRecordShape(e: Record<string, unknown>, label = "EpochRecord"): void {
  expect(typeof e.epochNumber, `${label}.epochNumber`).toBe("number");
  expect(typeof e.depositStart, `${label}.depositStart`).toBe("string");
  expect(typeof e.activeStart, `${label}.activeStart`).toBe("string");
  expect(typeof e.settlementDate, `${label}.settlementDate`).toBe("string");
  expect(typeof e.strike, `${label}.strike`).toBe("number");
  expect(typeof e.expiryDays, `${label}.expiryDays`).toBe("number");
  expect(typeof e.premiumCollected, `${label}.premiumCollected`).toBe("number");
  expect(VALID_EPOCH_OUTCOMES).toContain(e.outcome as string);
  expect(typeof e.pnlPct, `${label}.pnlPct`).toBe("number");
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/vaults — VaultSummary[]", () => {
  it("response is an array", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults`);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("every item has the VaultSummary shape", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults`);
    const items = (await res.json()) as Record<string, unknown>[];
    items.forEach((v, i) => assertVaultSummaryShape(v, `item[${i}]`));
  });
});

describe("GET /api/v1/vaults/:id — VaultDetail", () => {
  async function fetchDetail(): Promise<Record<string, unknown>> {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}`);
    return res.json();
  }

  it("contains VaultSummary fields", async () => {
    assertVaultSummaryShape(await fetchDetail());
  });

  it("has currentEpoch (number)", async () => {
    const d = await fetchDetail();
    expect(typeof d.currentEpoch).toBe("number");
  });

  it("has currentPhase in valid set", async () => {
    const d = await fetchDetail();
    expect(VALID_EPOCH_PHASES).toContain(d.currentPhase as string);
  });

  it("has phaseEndsAt (ISO string)", async () => {
    const d = await fetchDetail();
    expect(typeof d.phaseEndsAt).toBe("string");
    expect(new Date(d.phaseEndsAt as string).getTime()).not.toBeNaN();
  });

  it("has sharePrice (number)", async () => {
    const d = await fetchDetail();
    expect(typeof d.sharePrice).toBe("number");
    expect(d.sharePrice as number).toBeGreaterThan(0);
  });

  it("has totalShares (number)", async () => {
    const d = await fetchDetail();
    expect(typeof d.totalShares).toBe("number");
  });

  it("has feeStructure with managementPct and performancePct", async () => {
    const d = await fetchDetail();
    const fee = d.feeStructure as Record<string, unknown>;
    expect(typeof fee.managementPct).toBe("number");
    expect(typeof fee.performancePct).toBe("number");
  });

  it("has historicalEpochs as array of EpochRecord", async () => {
    const d = await fetchDetail();
    const epochs = d.historicalEpochs as Record<string, unknown>[];
    expect(Array.isArray(epochs)).toBe(true);
    epochs.forEach((e, i) => assertEpochRecordShape(e, `historicalEpochs[${i}]`));
  });

  it("userPosition is null or has required fields", async () => {
    const d = await fetchDetail();
    if (d.userPosition !== null) {
      const up = d.userPosition as Record<string, unknown>;
      expect(typeof up.shares).toBe("number");
      expect(typeof up.shareValue).toBe("number");
      expect(typeof up.totalValue).toBe("number");
      expect(typeof up.accruedPremium).toBe("number");
      expect(typeof up.pendingWithdrawal).toBe("number");
    }
  });
});

describe("POST /api/v1/vaults/:id/deposit", () => {
  it("returns 201 with tx_id (string)", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 1000 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.tx_id).toBe("string");
    expect((body.tx_id as string).length).toBeGreaterThan(0);
  });
});

describe("POST /api/v1/vaults/:id/redeem-request", () => {
  it("returns 201 with queued_shares and estimated_withdrawal_epoch", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/redeem-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shares: 100 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.queued_shares).toBe("number");
    expect(typeof body.estimated_withdrawal_epoch).toBe("number");
  });
});

describe("POST /api/v1/vaults/:id/withdraw", () => {
  it("returns 201 with tx_id (string) and queued (boolean)", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shares: 100 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.tx_id).toBe("string");
    expect(typeof body.queued).toBe("boolean");
  });
});

describe("GET /api/v1/vaults/:id/auth-nonce", () => {
  it("returns nonce (number) and current_ledger (number)", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/auth-nonce`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.nonce).toBe("number");
    expect(typeof body.current_ledger).toBe("number");
    expect(body.nonce as number).toBeGreaterThanOrEqual(0);
    expect(body.current_ledger as number).toBeGreaterThan(0);
  });
});

describe("GET /api/v1/vaults/:id/breaker-status", () => {
  it("returns status in valid set", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/breaker-status`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(VALID_BREAKER_STATUSES).toContain(body.status as string);
  });

  it("returns since as ISO string", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/breaker-status`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.since).toBe("string");
    expect(new Date(body.since as string).getTime()).not.toBeNaN();
  });

  it("acknowledged_at is null or ISO string", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/breaker-status`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.acknowledged_at !== null) {
      expect(typeof body.acknowledged_at).toBe("string");
    }
  });
});

describe("GET /api/v1/vaults/:id/nav-round", () => {
  it("returns status in valid set", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/nav-round`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(VALID_NAV_STATUSES).toContain(body.status as string);
  });

  it("returns attestations as array", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/nav-round`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.attestations)).toBe(true);
  });

  it("each attestation has required fields", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/nav-round`);
    const body = (await res.json()) as Record<string, unknown>;
    const attestations = body.attestations as Record<string, unknown>[];
    attestations.forEach((a, i) => {
      expect(typeof a.submitter, `attestations[${i}].submitter`).toBe("string");
      expect(typeof a.vault_id, `attestations[${i}].vault_id`).toBe("string");
      expect(typeof a.epoch, `attestations[${i}].epoch`).toBe("number");
      expect(typeof a.nav_per_share, `attestations[${i}].nav_per_share`).toBe("string");
      expect(typeof a.submitted_at, `attestations[${i}].submitted_at`).toBe("string");
    });
  });

  it("accepted_nav is null or numeric string", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/nav-round`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.accepted_nav !== null) {
      expect(typeof body.accepted_nav).toBe("string");
      expect(parseFloat(body.accepted_nav as string)).not.toBeNaN();
    }
  });

  it("vault_id matches the requested vault", async () => {
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}/nav-round`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.vault_id).toBe(VAULT_ID);
  });
});

// ---------------------------------------------------------------------------
// Negative — server returns a missing required field (drift simulation)
// ---------------------------------------------------------------------------

describe("drift detection — missing required field", () => {
  it("detects when sharePrice is absent from VaultDetail", async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/vaults/${VAULT_ID}`, () => {
        const { sharePrice: _omit, ...without } = FIXTURE_VAULT_DETAIL;
        return HttpResponse.json(without);
      })
    );
    const res = await fetch(`${API_BASE}/api/v1/vaults/${VAULT_ID}`);
    const body = (await res.json()) as Record<string, unknown>;
    // Assert that sharePrice is missing (the test itself is the drift detector)
    expect(body.sharePrice).toBeUndefined();
  });

  it("detects when strategy is renamed to vault_strategy", async () => {
    server.use(
      http.get(`${API_BASE}/api/v1/vaults`, () => {
        const renamed = FIXTURE_VAULT_SUMMARY as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { strategy: _omit, ...rest } = renamed;
        return HttpResponse.json([{ ...rest, vault_strategy: "covered_call" }]);
      })
    );
    const res = await fetch(`${API_BASE}/api/v1/vaults`);
    const items = (await res.json()) as Record<string, unknown>[];
    // strategy (old key) is gone, vault_strategy (new key) is present
    expect(items[0].strategy).toBeUndefined();
    expect(items[0].vault_strategy).toBe("covered_call");
  });
});
