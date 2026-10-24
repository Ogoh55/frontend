# Vault SLOs, Alerting Thresholds, and On-Call Runbooks

This document defines the service-level objectives (SLOs) for the vault stack
(contract, indexer, API, frontend read path), the Prometheus-style alert rules
derived from the metrics emitted by the epoch ledger and NAV reconciliation
jobs, and the on-call runbooks for each alert.

Alerts are derived from existing metrics rather than duplicating computation.
Each alert maps to exactly one runbook section below.

---

## 1. Service-Level Objectives

| SLO | Signal | Target | Measurement |
| --- | --- | --- | --- |
| **Epoch close timeliness** | `vault_epoch_close_delay_seconds` (actual close time − expected close time) | p95 ≤ 60s, p99 ≤ 300s | Per epoch, measured at close |
| **Redemption queue latency** | `vault_redemption_queue_age_seconds` (age of oldest pending redemption) | p95 ≤ 15m, p99 ≤ 60m | Continuous, excluding wind-down windows |
| **Vault API availability** | `vault_api_request_total{status=~"5.."}` / total | ≥ 99.9% over 30d | 5m rolling ratio |
| **Vault API p95 latency** | `vault_api_request_duration_seconds` histogram | p95 ≤ 400ms | 5m rolling |
| **Indexer lag** | `vault_indexer_ledger_lag` (Soroban ledger − indexed ledger) | p95 ≤ 5 ledgers, p99 ≤ 20 ledgers | Continuous |
| **NAV reconciliation drift** | `vault_nav_drift_bps` (\|on-chain NAV − reported NAV\| in bps) | ≤ 5 bps steady state, 0 bps at epoch close | Per reconciliation run |

### Expected-behaviour exclusions

- A vault legitimately sitting in a **closed-epoch window** must not trip epoch
  or queue alerts. Alerts gate on `vault_epoch_state{state="open"}` and the
  `vault_wind_down_active` flag.
- A **queue backlog right after a wind-down announcement** is expected; queue
  latency alerts are suppressed while `vault_wind_down_active == 1` for the
  documented grace period (`VAULT_WIND_DOWN_GRACE`, default 30m).

### Per-environment thresholds

Thresholds are configurable per environment (staging vs. production) via the
runtime config already used by the NPM-style config loader. The values below
are the **production** defaults; staging uses looser windows (see
`alerting/thresholds.staging.yaml`).

---

## 2. Alert Rules (Prometheus)

Each rule has a **short window** (catch genuine stalls) and a **long window**
(avoid flapping). Warning and critical tiers are provided.

```yaml
groups:
  - name: vault-slos
    rules:
      # --- Epoch close timeliness ---
      - alert: VaultEpochCloseDelayedWarning
        expr: |
          max_over_time(vault_epoch_close_delay_seconds[5m]) > 60
          and on() (vault_epoch_state{state="open"} == 1)
        for: 5m
        labels: { severity: warning, runbook: "#rb-epoch-close" }
        annotations:
          summary: "Epoch close delayed > 60s"
      - alert: VaultEpochCloseDelayedCritical
        expr: |
          max_over_time(vault_epoch_close_delay_seconds[15m]) > 300
          and on() (vault_epoch_state{state="open"} == 1)
        for: 10m
        labels: { severity: critical, runbook: "#rb-epoch-close" }
        annotations:
          summary: "Epoch close delayed > 300s (possible missed/duplicated close)"

      # --- Redemption queue latency ---
      - alert: VaultRedemptionQueueLatencyWarning
        expr: |
          max_over_time(vault_redemption_queue_age_seconds[10m]) > 900
          and on() (vault_wind_down_active == 0)
        for: 10m
        labels: { severity: warning, runbook: "#rb-redemption-queue" }
      - alert: VaultRedemptionQueueLatencyCritical
        expr: |
          max_over_time(vault_redemption_queue_age_seconds[30m]) > 3600
          and on() (vault_wind_down_active == 0)
        for: 15m
        labels: { severity: critical, runbook: "#rb-redemption-queue" }

      # --- Vault API availability ---
      - alert: VaultApiAvailabilityWarning
        expr: |
          sum(rate(vault_api_request_total{status=~"5.."}[5m]))
            / sum(rate(vault_api_request_total[5m])) > 0.001
        for: 10m
        labels: { severity: warning, runbook: "#rb-api-availability" }
      - alert: VaultApiAvailabilityCritical
        expr: |
          sum(rate(vault_api_request_total{status=~"5.."}[5m]))
            / sum(rate(vault_api_request_total[5m])) > 0.01
        for: 5m
        labels: { severity: critical, runbook: "#rb-api-availability" }

      # --- Vault API p95 latency ---
      - alert: VaultApiLatencyWarning
        expr: |
          histogram_quantile(0.95,
            sum(rate(vault_api_request_duration_seconds_bucket[5m])) by (le)) > 0.4
        for: 10m
        labels: { severity: warning, runbook: "#rb-api-latency" }
      - alert: VaultApiLatencyCritical
        expr: |
          histogram_quantile(0.95,
            sum(rate(vault_api_request_duration_seconds_bucket[5m])) by (le)) > 1.0
        for: 5m
        labels: { severity: critical, runbook: "#rb-api-latency" }

      # --- Indexer lag ---
      - alert: VaultIndexerLagWarning
        expr: max_over_time(vault_indexer_ledger_lag[5m]) > 5
        for: 5m
        labels: { severity: warning, runbook: "#rb-indexer-lag" }
      - alert: VaultIndexerLagCritical
        expr: max_over_time(vault_indexer_ledger_lag[15m]) > 20
        for: 10m
        labels: { severity: critical, runbook: "#rb-indexer-lag" }

      # --- NAV reconciliation drift ---
      - alert: VaultNavDriftWarning
        expr: max_over_time(vault_nav_drift_bps[10m]) > 5
        for: 10m
        labels: { severity: warning, runbook: "#rb-nav-drift" }
      - alert: VaultNavDriftCritical
        expr: |
          max_over_time(vault_nav_drift_bps[15m]) > 25
          or on() (vault_nav_drift_bps > 0 and vault_epoch_state{state="closing"} == 1)
        for: 5m
        labels: { severity: critical, runbook: "#rb-nav-drift" }
```

---

## 3. Severity Definitions

| Severity | Meaning | Response |
| --- | --- | --- |
| **critical** | Depositor funds or epoch integrity at risk; user-visible outage or NAV mismatch. | Page on-call immediately; acknowledge within 5m; engage kill switch if funds at risk. |
| **warning** | SLO burn trending; degraded but not yet user-impacting. | Notify on-call channel; investigate within 30m during business hours, next business day otherwise. |
| **info** | Informational; no action required. | Logged only. |

---

## 4. On-Call Rota & Escalation

- **Primary on-call:** rotates weekly (Mon 09:00 UTC). Owns all `critical` pages.
- **Secondary on-call:** backup for primary; auto-paged if primary does not
  acknowledge a `critical` within 5 minutes.
- **Escalation path:** Primary → Secondary → Vault engineering lead →
  Protocol owner. Each step escalates after 10 minutes without acknowledgement.
- **Paging:** handled by the existing alerting integration; this document does
  not mandate a commercial paging vendor.
- **Handoff:** at rota change, review open alerts and any in-flight incidents.

---

## 5. Runbooks

### <a id="rb-epoch-close"></a>RB-1 · Epoch close delayed (`VaultEpochCloseDelayed*`)

- **Symptom:** `vault_epoch_close_delay_seconds` exceeds threshold while the
  vault is in an open epoch.
- **Likely causes:** keeper/cron not running; transaction failing on-chain;
  RPC congestion; duplicated close attempt reverting.
- **Verification:**
  1. `GET /api/vault/epoch/status` — confirm `state` and `expectedCloseAt`.
  2. `GET /api/vault/epoch/history?limit=5` — check for missed/duplicated closes.
  3. Inspect keeper logs for the close transaction hash.
- **Mitigation:** re-trigger the epoch close via the keeper; if the close tx
  reverts, check RPC health and retry. If a duplicate close is suspected, do
  **not** re-run blindly — verify on-chain epoch id first.
- **Escalation:** critical → page secondary + vault engineering lead.
- **Kill switch:** if a close is stuck mid-state and funds are at risk, engage
  the emergency pause (see §6).

### <a id="rb-redemption-queue"></a>RB-2 · Redemption queue latency (`VaultRedemptionQueueLatency*`)

- **Symptom:** oldest pending redemption age exceeds threshold (outside
  wind-down grace).
- **Likely causes:** processor stalled; insufficient liquid reserves; upstream
  indexer lag blocking settlement.
- **Verification:**
  1. `GET /api/vault/redemptions/queue` — inspect pending count and oldest age.
  2. `GET /api/vault/liquidity` — confirm available reserves.
  3. Cross-check indexer lag (RB-4).
- **Mitigation:** restart the redemption processor; if reserves are short,
  escalate to treasury. Do not manually settle outside the queue.
- **Escalation:** critical → secondary + treasury.
- **Kill switch:** pause new redemptions if the queue cannot drain safely.

### <a id="rb-api-availability"></a>RB-3 · Vault API availability (`VaultApiAvailability*`)

- **Symptom:** 5xx ratio exceeds threshold.
- **Likely causes:** upstream dependency down (indexer/DB/RPC); bad deploy;
  resource exhaustion.
- **Verification:**
  1. `GET /api/health` — overall health.
  2. `GET /api/vault/health` — vault-specific dependencies.
  3. Check recent deploys (see `RELEASING.md`).
- **Mitigation:** roll back the last deploy if correlated; otherwise restore the
  failing dependency. Frontend read path degrades to cached reads.
- **Escalation:** critical → secondary + platform on-call.
- **Kill switch:** not typically required for availability alone.

### <a id="rb-api-latency"></a>RB-4 · Vault API p95 latency (`VaultApiLatency*`)

- **Symptom:** p95 request duration exceeds threshold.
- **Likely causes:** slow DB queries; indexer lag causing cache misses; RPC
  latency.
- **Verification:**
  1. `GET /api/vault/health` — dependency latencies.
  2. Check DB slow-query logs and cache hit ratio.
- **Mitigation:** scale API replicas; warm caches; if caused by indexer lag,
  follow RB-5.
- **Escalation:** warning → on-call channel; critical → secondary.
- **Kill switch:** not required.

### <a id="rb-indexer-lag"></a>RB-5 · Indexer lag (`VaultIndexerLag*`)

- **Symptom:** `vault_indexer_ledger_lag` exceeds threshold.
- **Likely causes:** Soroban RPC degraded; indexer crashed; cursor stuck.
- **Verification:**
  1. `GET /api/indexer/status` — current vs. chain ledger.
  2. Compare against Soroban RPC `getLatestLedger`.
- **Mitigation:** restart indexer; if RPC is degraded, fail over to backup RPC.
  Do not advance the cursor manually without verifying the ledger.
- **Escalation:** critical → secondary + platform on-call.
- **Kill switch:** pause epoch close if lag prevents a correct NAV computation.

### <a id="rb-nav-drift"></a>RB-6 · NAV reconciliation drift (`VaultNavDrift*`)

- **Symptom:** `vault_nav_drift_bps` exceeds threshold, or any drift at epoch
  close.
- **Likely causes:** stale indexer state; reconciliation job bug; on-chain
  event missed; rounding mismatch.
- **Verification:**
  1. `GET /api/vault/nav` — reported NAV.
  2. `GET /api/vault/nav/reconcile` — on-chain vs. reported diff.
  3. Cross-check indexer lag (RB-5).
- **Mitigation:** if drift is due to indexer lag, resolve RB-5 first. If drift
  persists at epoch close, **engage the emergency pause** before closing the
  epoch to prevent settling at a wrong NAV.
- **Escalation:** critical → secondary + vault engineering lead + protocol owner.
- **Kill switch:** engage emergency pause (see §6) if drift is unresolved at
  epoch close.

---

## 6. Emergency Pause / Kill Switch

The vault exposes an emergency pause used by the runbooks above.

1. Confirm the incident warrants a pause (NAV drift at close, stuck epoch with
   funds at risk, unsafe redemption drain).
2. Engage via the admin endpoint `POST /api/vault/emergency/pause` (requires
   admin auth) **or** the on-chain `pause` entry point if the API is unavailable.
3. Announce in the incident channel and record the reason.
4. Resume only after the root cause is fixed and verified; use
   `POST /api/vault/emergency/resume`.

---

## 7. Validation (Game-Day / Fault Injection)

Each alert is validated by deliberately injecting its failure condition in a
**non-production** environment and recording the result:

| Alert | Injection | Expected |
| --- | --- | --- |
| Epoch close delayed | Pause keeper | Warning then critical fire |
| Redemption queue latency | Stop processor | Warning then critical fire |
| API availability | Force 5xx on `/api/vault/*` | Warning then critical fire |
| API latency | Inject 1s delay | Warning then critical fire |
| Indexer lag | Stop indexer | Warning then critical fire |
| NAV drift | Perturb reported NAV | Warning then critical fire |

Runbooks' named endpoints (`/api/health`, `/api/vault/health`,
`/api/vault/epoch/status`, `/api/vault/redemptions/queue`,
`/api/vault/nav/reconcile`, `/api/indexer/status`) are asserted to exist by the
health-surface tests.
