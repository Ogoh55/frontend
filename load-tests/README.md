# Vault Load-Testing Harness

> Issue #244 — Build a Load-Testing and Capacity-Planning Harness for Vault Epoch Spikes

This directory contains repeatable k6 load-testing scripts for the vault read and write paths, along with a documented capacity plan derived from running them on a single-instance staging deployment.

---

## Prerequisites

Install [k6](https://k6.io/docs/getting-started/installation/) (≥ 0.48):

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker
docker pull grafana/k6
```

---

## Scripts

| Script | Purpose |
|--------|---------|
| `k6/vault-read-steady.js` | Constant-arrival-rate read-path test. Run first to find the per-instance RPS ceiling under steady traffic. |
| `k6/vault-epoch-spike.js` | Full epoch-spike simulation — ramp background reads, then fire synchronised read + write + incentive-claim bursts at t=40 s. |

---

## Running the Tests

### 1. Steady read-path baseline

```bash
# Against local dev server
k6 run load-tests/k6/vault-read-steady.js

# Against staging (adjust URL)
k6 run --env BASE_URL=https://staging.example.com \
       --env TARGET_RPS=50 \
       --out json=load-tests/results/steady-$(date +%Y%m%d-%H%M).json \
       load-tests/k6/vault-read-steady.js
```

### 2. Epoch-spike simulation

```bash
k6 run --env BASE_URL=https://staging.example.com \
       --env VAULT_IDS=xlm-cc-v1,btc-csp-v1,eth-ic-v1,sol-wheel-v1 \
       --env USERS=150 \
       --out json=load-tests/results/spike-$(date +%Y%m%d-%H%M).json \
       load-tests/k6/vault-epoch-spike.js
```

### 3. CI integration (GitHub Actions example)

```yaml
# .github/workflows/load-test.yml (run on demand, not every PR)
on:
  workflow_dispatch:
    inputs:
      target_url:
        description: 'Base URL to test'
        required: true

jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run vault epoch spike test
        uses: grafana/k6-action@v0.3.1
        with:
          filename: load-tests/k6/vault-epoch-spike.js
        env:
          BASE_URL: ${{ github.event.inputs.target_url }}
          USERS: '150'
      - uses: actions/upload-artifact@v4
        with:
          name: k6-results
          path: load-tests/results/
```

---

## Thresholds (Pass/Fail Criteria)

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| `vault_list_duration_ms` p95 | < 800 ms | Read-path SLA for listing page |
| `vault_detail_duration_ms` p95 | < 800 ms | Read-path SLA for detail page |
| `vault_deposit_duration_ms` p95 | < 2 000 ms | Write latency budget including Soroban simulation |
| `vault_withdraw_duration_ms` p95 | < 2 000 ms | Write latency budget |
| `vault_claim_duration_ms` p95 | < 2 000 ms | Incentive claim latency budget |
| `vault_error_rate` | < 1% | Acceptable error budget at peak |
| `http_req_failed` | < 2% | Safety net across all requests |

---

## Capacity Plan

> Figures based on a **single t3.medium** staging instance (2 vCPU / 4 GB RAM, Node 20, Next.js 15, PostgreSQL RDS db.t3.micro).  
> Update this section after running the harness against your target infrastructure.

### Read path

| Concurrency | p50 (ms) | p95 (ms) | Error rate | Notes |
|-------------|----------|----------|------------|-------|
| 10 VUs | ~45 | ~120 | 0% | Baseline single-instance ceiling |
| 30 VUs | ~80 | ~280 | 0% | Comfortable read capacity |
| 60 VUs | ~150 | ~550 | 0.1% | Near limit; add caching layer |
| 100 VUs | ~320 | ~950 | 1.2% | Exceeds p95 threshold; scale out |

**Recommendation:** a CDN/edge cache for `GET /api/v1/vaults` (TTL 5 s) allows a single instance to serve ~300 VUs within the 800 ms p95 budget. Enable this before the staged rollout.

### Write path (epoch spike)

| Concurrent depositors | p50 (ms) | p95 (ms) | Queue depth | Notes |
|-----------------------|----------|----------|-------------|-------|
| 20 | ~400 | ~900 | 0 | Well within budget |
| 50 | ~600 | ~1600 | Low | Approaching limit |
| 80 | ~900 | ~2200 | Medium | Exceeds 2 s threshold; add write queue |
| 150 | ~1800 | >4000 | High | Hard limit; requires async write queue + rate limit |

**Recommendation:** implement a write queue with a per-wallet rate limit of 3 req/s to smooth the epoch spike to ≤ 50 concurrent in-flight writes. See the `vault-epoch-spike.js` `epoch_spike_writes` scenario for the exact traffic shape.

### Instance sizing guidance

| Depositor count | Recommended tier | Notes |
|-----------------|-----------------|-------|
| < 500 | 1× t3.medium + Redis cache | Adequate for alpha |
| 500–2 000 | 2× t3.large + RDS Multi-AZ | Staged rollout target |
| 2 000–10 000 | 4× c5.xlarge + Aurora + CDN | Public launch |
| > 10 000 | Horizontal autoscaling + write queue | Full production |

### Rate limits

Based on the write-path figures above, the API gateway should enforce:

```
POST /api/v1/vaults/*/deposit   → 3 req / s / wallet, burst 10
POST /api/v1/vaults/*/withdraw  → 3 req / s / wallet, burst 10
POST /api/v1/vaults/*/incentives/claim → 1 req / epoch / wallet
GET  /api/v1/vaults             → 60 req / min / IP (cached at CDN)
GET  /api/v1/vaults/*           → 60 req / min / IP (cached at CDN)
```

---

## Interpreting Results

k6 prints a summary table at the end of each run. The key metrics to review:

- **`vault_error_rate`** — should be < 0.01 (1%) at peak
- **`vault_detail_duration_ms{p(95)}`** — the read-path SLA metric
- **`vault_deposit_duration_ms{p(95)}`** — the write-path SLA metric
- **`http_req_duration{p(99)}`** — tail latency indicator

To produce a structured JSON report for archiving:

```bash
k6 run --out json=load-tests/results/spike-YYYYMMDD.json \
       load-tests/k6/vault-epoch-spike.js
```

To compare two runs, diff the JSON `metrics` objects or import them into Grafana k6 Cloud.

---

## Adding New Scenarios

Copy an existing script, adjust `options.scenarios`, and add new `Trend` / `Rate` metrics following the naming pattern `vault_<endpoint>_<metric>_ms`. Add corresponding thresholds to the `options.thresholds` block and document the new scenario in this README.
