/**
 * load-tests/k6/vault-epoch-spike.js — Issue #244
 *
 * Repeatable k6 load-testing harness for the vault read and write paths.
 * Simulates the synchronised traffic spike at an epoch boundary: depositors
 * checking vault state, submitting withdrawals, and claiming incentives all
 * arrive concurrently.
 *
 * Usage
 * -----
 *   # Install k6: https://k6.io/docs/getting-started/installation/
 *   k6 run load-tests/k6/vault-epoch-spike.js
 *
 *   # Override target URL and vault IDs:
 *   k6 run --env BASE_URL=https://staging.example.com \
 *           --env VAULT_IDS=xlm-cc-v1,btc-csp-v1 \
 *           --env USERS=200 \
 *           load-tests/k6/vault-epoch-spike.js
 *
 *   # Write a k6 summary JSON for the capacity plan report:
 *   k6 run --out json=load-tests/results/latest.json \
 *           load-tests/k6/vault-epoch-spike.js
 *
 * Scenarios
 * ---------
 *  browse_vaults        — Steady background read traffic (GET /api/v1/vaults).
 *  epoch_spike_reads    — Burst of vault-detail reads at epoch boundary.
 *  epoch_spike_writes   — Burst of deposit/withdraw posts at epoch boundary.
 *  incentive_claims     — Synchronised POST /incentives/claim after epoch rolls.
 *
 * Thresholds (capacity targets)
 * ------------------------------
 *  p(95) HTTP duration < 800 ms on read endpoints at peak concurrency.
 *  p(95) HTTP duration < 2000 ms on write endpoints at peak concurrency.
 *  Error rate < 1% across all scenarios.
 *
 * Dependencies
 * ------------
 *  k6 >= 0.48  (native fetch + scenarios API)
 *  No external k6 extensions required.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { randomItem } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL   = __ENV.BASE_URL   || "http://localhost:3000";
const VAULT_IDS  = (__ENV.VAULT_IDS || "xlm-cc-v1,btc-csp-v1,eth-ic-v1,sol-wheel-v1").split(",");
const VU_COUNT   = parseInt(__ENV.USERS || "150", 10);

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const vaultListDuration   = new Trend("vault_list_duration_ms",   true);
const vaultDetailDuration = new Trend("vault_detail_duration_ms",  true);
const depositDuration     = new Trend("vault_deposit_duration_ms", true);
const withdrawDuration    = new Trend("vault_withdraw_duration_ms",true);
const claimDuration       = new Trend("vault_claim_duration_ms",   true);
const errorRate           = new Rate("vault_error_rate");
const depositErrors       = new Counter("vault_deposit_errors");
const withdrawErrors      = new Counter("vault_withdraw_errors");

// ---------------------------------------------------------------------------
// k6 scenario definitions
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    // ── 1. Steady background reads ──────────────────────────────────────────
    browse_vaults: {
      executor:          "ramping-vus",
      startVUs:          0,
      stages: [
        { duration: "30s", target: Math.floor(VU_COUNT * 0.3) },  // ramp up
        { duration: "60s", target: Math.floor(VU_COUNT * 0.3) },  // sustain
        { duration: "15s", target: 0 },                            // ramp down
      ],
      gracefulRampDown:  "10s",
      exec:              "browseFn",
      tags: { scenario: "browse_vaults" },
    },

    // ── 2. Epoch-boundary read spike ────────────────────────────────────────
    epoch_spike_reads: {
      executor:          "ramping-vus",
      startVUs:          0,
      startTime:         "40s",   // kicks in mid-run to simulate epoch rollover
      stages: [
        { duration: "5s",  target: VU_COUNT },  // sharp spike
        { duration: "30s", target: VU_COUNT },  // sustained peak
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown:  "5s",
      exec:              "epochReadFn",
      tags: { scenario: "epoch_spike_reads" },
    },

    // ── 3. Epoch-boundary write spike ───────────────────────────────────────
    epoch_spike_writes: {
      executor:          "ramping-vus",
      startVUs:          0,
      startTime:         "45s",
      stages: [
        { duration: "5s",  target: Math.floor(VU_COUNT * 0.4) },
        { duration: "20s", target: Math.floor(VU_COUNT * 0.4) },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown:  "5s",
      exec:              "epochWriteFn",
      tags: { scenario: "epoch_spike_writes" },
    },

    // ── 4. Incentive-claim burst ─────────────────────────────────────────────
    incentive_claims: {
      executor:          "ramping-vus",
      startVUs:          0,
      startTime:         "50s",
      stages: [
        { duration: "3s",  target: Math.floor(VU_COUNT * 0.6) },
        { duration: "15s", target: Math.floor(VU_COUNT * 0.6) },
        { duration: "5s",  target: 0 },
      ],
      gracefulRampDown:  "5s",
      exec:              "claimFn",
      tags: { scenario: "incentive_claims" },
    },
  },

  // ── Pass/fail thresholds (capacity targets) ─────────────────────────────
  thresholds: {
    // Read endpoints: p95 < 800 ms
    vault_list_duration_ms:   ["p(95)<800"],
    vault_detail_duration_ms: ["p(95)<800"],
    // Write endpoints: p95 < 2000 ms
    vault_deposit_duration_ms:  ["p(95)<2000"],
    vault_withdraw_duration_ms: ["p(95)<2000"],
    vault_claim_duration_ms:    ["p(95)<2000"],
    // Overall error rate < 1%
    vault_error_rate: ["rate<0.01"],
    // Built-in http_req_duration as a sanity fallback
    http_req_duration: ["p(95)<2500"],
    http_req_failed:   ["rate<0.02"],
  },
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Build a fake Bearer token — real auth is out of scope for load tests;
 *  the staging environment must accept these test tokens or be configured
 *  with a load-test bypass header. */
function authHeader(vuId) {
  return { Authorization: `Bearer load-test-vu-${vuId}` };
}

function checkOk(res, label) {
  const ok = check(res, {
    [`${label}: status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${label}: response time < 3s`]: (r) => r.timings.duration < 3000,
  });
  errorRate.add(!ok);
  return ok;
}

// ---------------------------------------------------------------------------
// Scenario functions
// ---------------------------------------------------------------------------

/** Background vault listing + detail reads. */
export function browseFn() {
  group("browse_vaults", () => {
    const listRes = http.get(`${BASE_URL}/api/v1/vaults`, { tags: { name: "vault_list" } });
    vaultListDuration.add(listRes.timings.duration);
    checkOk(listRes, "vault_list");

    if (listRes.status === 200) {
      const vaultId = randomItem(VAULT_IDS);
      const detailRes = http.get(`${BASE_URL}/api/v1/vaults/${vaultId}`, {
        tags: { name: "vault_detail" },
      });
      vaultDetailDuration.add(detailRes.timings.duration);
      checkOk(detailRes, "vault_detail");
    }

    sleep(2 + Math.random() * 3);
  });
}

/** Epoch-boundary read spike: all VUs fetch vault state simultaneously. */
export function epochReadFn() {
  group("epoch_spike_reads", () => {
    const vaultId   = randomItem(VAULT_IDS);
    const detailRes = http.get(`${BASE_URL}/api/v1/vaults/${vaultId}`, {
      tags: { name: "epoch_read_spike" },
    });
    vaultDetailDuration.add(detailRes.timings.duration);
    checkOk(detailRes, "epoch_read_spike");

    // Also poll epoch phase transition endpoint.
    const phaseRes = http.get(`${BASE_URL}/api/v1/vaults/${vaultId}/epoch`, {
      tags: { name: "epoch_phase" },
    });
    checkOk(phaseRes, "epoch_phase");

    sleep(0.5 + Math.random());
  });
}

/** Epoch-boundary write spike: deposits and withdrawals flood in. */
export function epochWriteFn() {
  const vuId   = __VU;
  const headers = Object.assign({}, JSON_HEADERS, authHeader(vuId));

  group("epoch_spike_writes", () => {
    const vaultId = randomItem(VAULT_IDS);

    // Alternate between deposits and withdrawals to simulate realistic mix.
    if (vuId % 2 === 0) {
      // Deposit: random amount between $10 and $10,000.
      const amount = (10 + Math.random() * 9990).toFixed(2);
      const res = http.post(
        `${BASE_URL}/api/v1/vaults/${vaultId}/deposit`,
        JSON.stringify({ amount: parseFloat(amount) }),
        { headers, tags: { name: "vault_deposit" } }
      );
      depositDuration.add(res.timings.duration);
      if (!checkOk(res, "vault_deposit")) depositErrors.add(1);
    } else {
      // Withdrawal request: random share count.
      const shares = (1 + Math.random() * 999).toFixed(4);
      const res = http.post(
        `${BASE_URL}/api/v1/vaults/${vaultId}/withdraw`,
        JSON.stringify({ shares: parseFloat(shares) }),
        { headers, tags: { name: "vault_withdraw" } }
      );
      withdrawDuration.add(res.timings.duration);
      if (!checkOk(res, "vault_withdraw")) withdrawErrors.add(1);
    }

    sleep(1 + Math.random() * 2);
  });
}

/** Incentive / premium-claim burst immediately after epoch rolls. */
export function claimFn() {
  const vuId    = __VU;
  const headers = Object.assign({}, JSON_HEADERS, authHeader(vuId));

  group("incentive_claims", () => {
    const vaultId = randomItem(VAULT_IDS);
    const res = http.post(
      `${BASE_URL}/api/v1/vaults/${vaultId}/incentives/claim`,
      JSON.stringify({ epoch: "latest" }),
      { headers, tags: { name: "vault_claim" } }
    );
    claimDuration.add(res.timings.duration);
    if (!checkOk(res, "vault_claim")) errorRate.add(1);

    sleep(0.5 + Math.random() * 1.5);
  });
}
