/**
 * load-tests/k6/vault-read-steady.js — Issue #244
 *
 * Sustained read-path load test for vault listing and detail endpoints.
 * Used to find the per-instance throughput ceiling before epoch spikes are
 * modelled — run this first to establish a baseline RPS and p99 latency for
 * the read path under steady traffic, then use vault-epoch-spike.js to model
 * the synchronised burst on top.
 *
 * Usage
 * -----
 *   k6 run load-tests/k6/vault-read-steady.js
 *   k6 run --env BASE_URL=https://staging.example.com \
 *           --env TARGET_RPS=50 \
 *           load-tests/k6/vault-read-steady.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";
import { randomItem } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE_URL  = __ENV.BASE_URL   || "http://localhost:3000";
const VAULT_IDS = (__ENV.VAULT_IDS || "xlm-cc-v1,btc-csp-v1,eth-ic-v1,sol-wheel-v1").split(",");
// Target constant arrival rate in requests-per-second.
const TARGET_RPS = parseInt(__ENV.TARGET_RPS || "30", 10);

const listLatency   = new Trend("steady_list_ms",   true);
const detailLatency = new Trend("steady_detail_ms",  true);
const errors        = new Rate("steady_error_rate");

export const options = {
  scenarios: {
    steady_reads: {
      executor:               "constant-arrival-rate",
      rate:                   TARGET_RPS,
      timeUnit:               "1s",
      duration:               "120s",
      preAllocatedVUs:        TARGET_RPS * 2,
      maxVUs:                 TARGET_RPS * 10,
      gracefulStop:           "10s",
    },
  },
  thresholds: {
    steady_list_ms:   ["p(95)<400", "p(99)<800"],
    steady_detail_ms: ["p(95)<500", "p(99)<1000"],
    steady_error_rate: ["rate<0.005"],
    http_req_failed:   ["rate<0.01"],
  },
};

export default function () {
  // 70 % detail reads, 30 % list reads.
  if (Math.random() < 0.7) {
    const vaultId = randomItem(VAULT_IDS);
    const res = http.get(`${BASE_URL}/api/v1/vaults/${vaultId}`, {
      tags: { name: "vault_detail_steady" },
    });
    detailLatency.add(res.timings.duration);
    const ok = check(res, { "detail 2xx": r => r.status >= 200 && r.status < 300 });
    errors.add(!ok);
  } else {
    const res = http.get(`${BASE_URL}/api/v1/vaults`, {
      tags: { name: "vault_list_steady" },
    });
    listLatency.add(res.timings.duration);
    const ok = check(res, { "list 2xx": r => r.status >= 200 && r.status < 300 });
    errors.add(!ok);
  }
}
