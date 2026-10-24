# Vault SLOs, Alerting Thresholds, and On-Call Runbooks

This document defines the service-level objectives (SLOs) for the vault stack
(contract, indexer, API, frontend read path), the Prometheus-style alert rules
derived from the metrics emitted by the epoch ledger and NAV reconciliation
jobs, and the on-call runbooks for each alert.

Alerts are derived from existing metrics — the epoch ledger and reconciliation
jobs already emit the underlying signals. Do not duplicate computation in the
alerting layer; alert on the emitted series.

---

## 1. Service-Level Objectives

| SLO | Signal | Target | Measurement |
| --- | --- | --- | --- |
| **Epoch close timeliness** | `vault_epoch_close_delay_seconds` (actual close time − expected close time) | p95 ≤ 60s, p99 ≤ 300s | Rolling 30d |
| **Redemption queue latency** | `vault_redemption_queue_age_seconds` (age of oldest pending redemption) | p95 ≤ 15m, p99 ≤ 60m | Rolling 30d |
| **Vault API availability** | `vault_api_request_total{status=~"5.."}` / total | ≥ 99.9% success | Rolling 30d |
| **Vault API p95 latency** | `vault_api_request_duration_seconds` histogram | p95 ≤ 400ms | Rolling 30d |
| **Indexer lag** | `vault_indexer_ledger_lag` (Soroban ledger seq − indexed seq) | p95 ≤ 5 ledgers, p99 ≤ 20 ledgers | Rolling 30d |
| **NAV reconciliation drift** | `vault_nav_drift_bps` (abs on-chain vs computed NAV, basis points) | p99 ≤ 10 bps | Rolling 30d |

Expected behaviour that must **not** page:

- A vault legitimately sitting in a closed-epoch window (no close expected).
- A redemption queue backlog immediately after a wind-down announcement
  (`vault_wind_down_active == 1`).

Thresholds are configurable per environment (staging vs. production) via the
runtime config; the values below are the production defaults. Staging uses the
same rules with relaxed thresholds (see §2.1).

---

## 2. Alert Rules

Each alert maps to exactly one runbook section in §3. Every rule uses a short
window to catch genuine stalls and a long window to avoid flapping.

```yaml
groups:
  - name: vault-slo
    rules:
      # --- Epoch close timeliness -------------------------------------
      - alert: VaultEpochCloseDelayed
        expr: vault_epoch_close_delay_seconds > 60
        for: 2m
        labels: { severity: warning, runbook: "#31-epoch-close-delayed" }
        annotations:
          summary: "Epoch close delayed > 60s"
      - alert: VaultEpochCloseStalled
        expr: vault_epoch_close_delay_seconds > 300
        for: 5m
        labels: { severity: critical, runbook: "#31-epoch-close-delayed" }
        annotations:
          summary: "Epoch close stalled > 300s"

      # --- Redemption queue latency -----------------------------------
      - alert: VaultRedemptionQueueSlow
        expr: vault_redemption_queue_age_seconds > 900 and vault_wind_down_active == 0
        for: 5m
        labels: { severity: warning, runbook: "#32-redemption-queue-latency" }
      - alert: VaultRedemptionQueueStalled
        expr: vault_redemption_queue_age_seconds > 3600 and vault_wind_down_active == 0
        for: 10m
        labels: { severity: critical, runbook: "#32-redemption-queue-latency" }

      # --- API availability & latency ---------------------------------
      - alert: VaultApiErrorRateHigh
        expr: |
          sum(rate(vault_api_request_total{status=~"5.."}[5m]))
            / sum(rate(vault_api_request_total[5m])) > 0.01
        for: 5m
        labels: { severity: warning, runbook: "#33-vault-api-availability" }
      - alert: VaultApiErrorRateCritical
        expr: |
          sum(rate(vault_api_request_total{status=~"5.."}[5m]))
            / sum(rate(vault_api_request_total[5m])) > 0.05
        for: 10m
        labels: { severity: critical, runbook: "#33-vault-api-availability" }
      - alert: VaultApiLatencyHigh
        expr: histogram_quantile(0.95, sum(rate(vault_api_request_duration_seconds_bucket[5m])) by (le)) > 0.4
        for: 10m
        labels: { severity: warning, runbook: "#33-vault-api-availability" }

      # --- Indexer lag -------------------------------------------------
      - alert: VaultIndexerLagHigh
        expr: vault_indexer_ledger_lag > 5
        for: 5m
        labels: { severity: warning, runbook: "#34-indexer-lag" }
      - alert: VaultIndexerLagCritical
        expr: vault_indexer_ledger_lag > 20
        for: 10m
        labels: { severity: critical, runbook: "#34-indexer-lag" }

      # --- NAV reconciliation drift -----------------------------------
      - alert: VaultNavDriftHigh
        expr: vault_nav_drift_bps > 10
        for: 5m
        labels: { severity: warning, runbook: "#35-nav-reconciliation-drift" }
      - alert: VaultNavDriftCritical
        expr: vault_nav_drift_bps > 50
        for: 10m
        labels: { severity: critical, runbook: "#35-nav-reconciliation-drift" }
```

### 2.1 Per-environment thresholds

Thresholds are read from runtime config so staging and production can differ.
Staging overrides (relaxed, to avoid noise on synthetic traffic):

| Alert | Production | Staging |
| --- | --- | --- |
| `VaultEpochCloseDelayed` / `Stalled` | 60s / 300s | 300s / 900s |
| `VaultRedemptionQueueSlow` / `Stalled` | 15m / 60m | 60m / 240m |
| `VaultApiErrorRateHigh` / `Critical` | 1% / 5% | 5% / 20% |
| `VaultIndexerLagHigh` / `Critical` | 5 / 20 ledgers | 20 / 60 ledgers |
| `VaultNavDriftHigh` / `Critical` | 10 / 50 bps | 50 / 200 bps |

---

## 3. Runbooks

Each runbook follows the same structure: **symptom → likely causes →
verification → mitigation → escalation → kill switch**.

### 3.1 Epoch close delayed

- **Symptom:** `VaultEpochCloseDelayed` / `VaultEpochCloseStalled` firing;
  `vault_epoch_close_delay_seconds` above threshold.
- **Likely causes:** keeper/cron not running; RPC/Soroban submission failure;
  contract revert on close; clock skew between keeper and chain.
- **Verification:**
  - `GET /api/vault/epoch/status` — confirm current epoch and expected close.
  - `GET /api/vault/epoch/ledger` — confirm last recorded close.
  - Check keeper logs for the close transaction hash and its status.
- **Mitigation:** re-trigger the epoch close via the keeper; if the transaction
  reverted, inspect the revert reason before retrying. Do **not** manually
  advance the epoch without confirming on-chain state.
- **Escalation:** if not resolved within 15m, page the vault on-call lead (§4).
- **Kill switch:** if a duplicate or partial close is suspected, engage the
  emergency pause (§5) before any retry.

### 3.2 Redemption queue latency

- **Symptom:** `VaultRedemptionQueueSlow` / `VaultRedemptionQueueStalled`;
  oldest pending redemption age above threshold (suppressed during wind-down).
- **Likely causes:** processor worker down; insufficient liquid assets to
  service redemptions; stuck transaction in the queue.
- **Verification:**
  - `GET /api/vault/redemptions/queue` — inspect pending items and ages.
  - `GET /api/vault/liquidity` — confirm available liquid assets.
- **Mitigation:** restart the redemption processor; if liquidity-bound, escalate
  to treasury rather than forcing redemptions.
- **Escalation:** page vault on-call lead if queue age exceeds 60m.
- **Kill switch:** pause new redemptions via emergency pause if the queue is
  corrupt; existing queued items must be reconciled manually.

### 3.3 Vault API availability

- **Symptom:** `VaultApiErrorRateHigh` / `VaultApiErrorRateCritical` /
  `VaultApiLatencyHigh`.
- **Likely causes:** upstream dependency (indexer/DB) degraded; deploy in
  progress; resource saturation.
- **Verification:**
  - `GET /api/health` — overall health.
  - `GET /api/vault/health` — vault-specific health.
  - Check recent deploys against `RELEASING.md` rollback procedure.
- **Mitigation:** roll back the last deploy if correlated; scale up if
  saturation; otherwise follow dependency runbooks.
- **Escalation:** page platform on-call if error rate > 5% for 10m.
- **Kill switch:** not applicable — availability alerts do not pause the vault.

### 3.4 Indexer lag

- **Symptom:** `VaultIndexerLagHigh` / `VaultIndexerLagCritical`;
  `vault_indexer_ledger_lag` above threshold.
- **Likely causes:** Soroban RPC throttling; indexer worker crash; network
  partition.
- **Verification:**
  - `GET /api/indexer/status` — last indexed ledger vs. chain head.
  - Compare against Soroban RPC `getLatestLedger`.
- **Mitigation:** restart the indexer worker; if RPC-throttled, switch to a
  backup RPC endpoint.
- **Escalation:** page platform on-call if lag > 20 ledgers for 10m.
- **Kill switch:** not applicable — lag does not pause the vault, but treat
  stale reads as untrusted until caught up.

### 3.5 NAV reconciliation drift

- **Symptom:** `VaultNavDriftHigh` / `VaultNavDriftCritical`;
  `vault_nav_drift_bps` above threshold.
- **Likely causes:** stale indexer data feeding NAV; oracle price divergence;
  reconciliation job failure; genuine on-chain state change not yet indexed.
- **Verification:**
  - `GET /api/vault/nav` — computed NAV.
  - `GET /api/vault/nav/reconciliation` — last reconciliation result and drift.
  - Cross-check on-chain NAV via contract read.
- **Mitigation:** if drift is due to indexer lag, resolve §3.4 first; if genuine
  divergence, halt NAV-dependent operations and investigate.
- **Escalation:** page vault on-call lead immediately for critical drift.
- **Kill switch:** engage emergency pause (§5) if drift exceeds 50 bps and the
  cause is unknown — depositor funds must not move on a drifted NAV.

---

## 4. Severity Definitions & On-Call Rota

| Severity | Meaning | Response |
| --- | --- | --- |
| **critical** | User funds or epoch integrity at risk; SLO breached. | Page immediately; ack ≤ 5m. |
| **warning** | SLO at risk; degradation but no immediate fund risk. | Page during business hours; ack ≤ 30m. |

**On-call rota:** primary vault on-call rotates weekly; secondary platform
on-call backs up. Escalation path: primary → vault on-call lead → platform lead.
Rota and contact details live in the team on-call schedule (linked from the
backend `README.md`).

---

## 5. Emergency Pause / Kill Switch

The vault exposes an emergency pause used by the runbooks above. Engage it only
when a runbook explicitly calls for it (duplicate/partial epoch close, corrupt
redemption queue, or unknown NAV drift > 50 bps).

1. Confirm the condition against the named verification endpoint.
2. Engage the pause via the documented admin path (see `RELEASING.md`).
3. Announce in the incident channel and record the trigger in the incident log.
4. Do not resume until the root cause is resolved and NAV/epoch state is
   reconciled.

---

## 6. Validation (Game Day)

Each alert is validated by deliberately injecting its failure condition in a
non-production environment and recording the result:

| Alert | Injection | Expected |
| --- | --- | --- |
| `VaultEpochCloseDelayed` | Stop keeper | Fires after `for` window |
| `VaultRedemptionQueueSlow` | Pause processor | Fires after `for` window |
| `VaultApiErrorRateHigh` | Inject 5xx | Fires after `for` window |
| `VaultIndexerLagHigh` | Stop indexer | Fires after `for` window |
| `VaultNavDriftHigh` | Feed stale NAV | Fires after `for` window |

Record each game-day result (date, injector, observed alert, time-to-fire) in
the incident log. Assert that every endpoint named in §3 exists before running
the pass.
