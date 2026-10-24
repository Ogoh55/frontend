# Vault SLOs, Alerting Thresholds, and On-Call Runbooks

This document defines the service-level objectives (SLOs) for the vault stack
(contract, indexer, API, frontend read path), the Prometheus-style alert rules
derived from the metrics emitted by the epoch ledger and NAV reconciliation
jobs, and one runbook per alert so the on-call engineer has a concrete first
action during an epoch-boundary incident.

Alerts are derived from existing metrics — the epoch ledger and reconciliation
jobs already emit the underlying signals. Do not duplicate computation in the
alerting layer; alert on the emitted series.

---

## 1. Service-Level Objectives

| SLO | Signal | Target | Measurement |
| --- | --- | --- | --- |
| **Epoch close timeliness** | `vault_epoch_close_delay_seconds` (actual close time − expected close time) | p95 ≤ 60s, p99 ≤ 300s | Per epoch, measured at close |
| **Redemption queue latency** | `vault_redemption_queue_oldest_age_seconds` | p95 ≤ 15m, p99 ≤ 60m | Continuous, per queued request |
| **Vault API availability** | `vault_api_request_total{status=~"5.."}` / total | ≥ 99.9% over 30d | Rolling 30d |
| **Vault API p95 latency** | `vault_api_request_duration_seconds` | p95 ≤ 400ms | Rolling 5m |
| **Indexer lag** | `vault_indexer_ledger_lag` (Soroban ledger − indexed ledger) | p95 ≤ 5 ledgers, p99 ≤ 20 ledgers | Continuous |
| **NAV reconciliation drift** | `vault_nav_drift_bps` (\|on-chain NAV − reported NAV\| in bps) | ≤ 5 bps | Per reconciliation run |

Expected behaviour that must **not** page:

- A vault legitimately sitting in a closed-epoch window (no close expected).
- A redemption queue backlog immediately after a wind-down announcement
  (`vault_wind_down_active == 1`).

Thresholds are configurable per environment (staging vs. production) via the
runtime config; the values below are the production defaults. Staging uses
looser windows and lower severities so fault-injection does not page.

---

## 2. Alert Rules (Prometheus-style)

Each alert maps to exactly one runbook section below. Every rule uses a short
window to catch genuine stalls and a long window to avoid flapping.

```yaml
groups:
  - name: vault-slo
    rules:
      # --- Epoch close timeliness ---
      - alert: VaultEpochCloseDelayed
        expr: vault_epoch_close_delay_seconds > 60
        for: 2m
        labels: { severity: warning, runbook: "#rb-epoch-close" }
        annotations:
          summary: "Epoch close delayed > 60s"
      - alert: VaultEpochCloseStalled
        expr: vault_epoch_close_delay_seconds > 300
        for: 5m
        labels: { severity: critical, runbook: "#rb-epoch-close" }
        annotations:
          summary: "Epoch close stalled > 300s"

      # --- Redemption queue latency ---
      - alert: VaultRedemptionQueueSlow
        expr: vault_redemption_queue_oldest_age_seconds > 900 and vault_wind_down_active == 0
        for: 10m
        labels: { severity: warning, runbook: "#rb-redemption-queue" }
      - alert: VaultRedemptionQueueStalled
        expr: vault_redemption_queue_oldest_age_seconds > 3600 and vault_wind_down_active == 0
        for: 15m
        labels: { severity: critical, runbook: "#rb-redemption-queue" }

      # --- Vault API availability ---
      - alert: VaultApiErrorRateHigh
        expr: sum(rate(vault_api_request_total{status=~"5.."}[5m])) / sum(rate(vault_api_request_total[5m])) > 0.01
        for: 5m
        labels: { severity: warning, runbook: "#rb-api-availability" }
      - alert: VaultApiDown
        expr: sum(rate(vault_api_request_total{status=~"5.."}[5m])) / sum(rate(vault_api_request_total[5m])) > 0.05
        for: 10m
        labels: { severity: critical, runbook: "#rb-api-availability" }

      # --- Vault API p95 latency ---
      - alert: VaultApiLatencyHigh
        expr: histogram_quantile(0.95, sum(rate(vault_api_request_duration_seconds_bucket[5m])) by (le)) > 0.4
        for: 10m
        labels: { severity: warning, runbook: "#rb-api-latency" }
      - alert: VaultApiLatencyCritical
        expr: histogram_quantile(0.95, sum(rate(vault_api_request_duration_seconds_bucket[5m])) by (le)) > 1.0
        for: 15m
        labels: { severity: critical, runbook: "#rb-api-latency" }

      # --- Indexer lag ---
      - alert: VaultIndexerLagHigh
        expr: vault_indexer_ledger_lag > 5
        for: 5m
        labels: { severity: warning, runbook: "#rb-indexer-lag" }
      - alert: VaultIndexerLagCritical
        expr: vault_indexer_ledger_lag > 20
        for: 10m
        labels: { severity: critical, runbook: "#rb-indexer-lag" }

      # --- NAV reconciliation drift ---
      - alert: VaultNavDriftHigh
        expr: vault_nav_drift_bps > 5
        for: 5m
        labels: { severity: warning, runbook: "#rb-nav-drift" }
      - alert: VaultNavDriftCritical
        expr: vault_nav_drift_bps > 25
        for: 10m
        labels: { severity: critical, runbook: "#rb-nav-drift" }
```

---

## 3. Severity Definitions

| Severity | Meaning | Response |
| --- | --- | --- |
| **critical** | Depositor funds or epoch integrity at risk; user-visible outage or NAV drift. | Page on-call immediately; acknowledge within 5m; engage kill switch if funds at risk. |
| **warning** | SLO at risk but not yet breached; degradation possible. | Notify on-call channel; investigate within 30m during business hours, next business day otherwise. |
| **info** | Expected/benign state change (e.g. wind-down). | No page; logged for context. |

---

## 4. On-Call Rota & Escalation Path

- **Primary on-call:** rotates weekly (Mon 09:00 UTC). Owns all `critical` pages.
- **Secondary on-call:** backup for primary; engaged if primary does not ack a
  `critical` page within 5 minutes.
- **Escalation:** primary → secondary (5m) → vault tech lead (15m) → engineering
  manager (30m). Escalation contacts live in the team on-call schedule.
- **Handoff:** at rotation change, review open alerts and any in-flight
  incidents; note state in the incident channel.

---

## 5. Runbooks

### <a id="rb-epoch-close"></a>RB-1: Epoch Close Delayed / Stalled

- **Symptom:** `VaultEpochCloseDelayed` / `VaultEpochCloseStalled` firing;
  `vault_epoch_close_delay_seconds` above threshold.
- **Likely causes:** keeper/cron not running, transaction submission failure,
  RPC congestion, contract revert on close.
- **Verification:**
  - Check epoch status: `GET /api/vault/epoch/current` (expected vs. actual close time).
  - Check keeper health: `GET /api/health` and indexer logs for close attempts.
  - Confirm on-chain epoch state via the Soroban RPC for the vault contract.
- **Mitigation:** restart the epoch-close keeper; if a close tx reverted, inspect
  the revert reason before retrying. Do **not** manually force a duplicate close.
- **Kill switch:** if a duplicate or partial close is suspected, engage the vault
  emergency pause (see §6) before retrying.
- **Escalation:** critical → page secondary + vault tech lead.

### <a id="rb-redemption-queue"></a>RB-2: Redemption Queue Slow / Stalled

- **Symptom:** `VaultRedemptionQueueSlow` / `VaultRedemptionQueueStalled`;
  oldest queued request age above threshold (suppressed during wind-down).
- **Likely causes:** processor backlog, insufficient liquid reserves, stuck
  settlement job.
- **Verification:**
  - Queue depth and oldest age: `GET /api/vault/redemptions/queue`.
  - Processor health: `GET /api/health`; check settlement worker logs.
- **Mitigation:** restart the redemption processor; if reserves are short,
  escalate to treasury — do not bypass the queue ordering.
- **Kill switch:** if redemptions are being processed out of order or double-paid,
  engage emergency pause (§6).
- **Escalation:** critical → page secondary + treasury.

### <a id="rb-api-availability"></a>RB-3: Vault API Availability

- **Symptom:** `VaultApiErrorRateHigh` / `VaultApiDown`; 5xx rate above threshold.
- **Likely causes:** upstream dependency down, bad deploy, DB saturation.
- **Verification:** `GET /api/health` (liveness/readiness); check recent deploys
  and dependency status.
- **Mitigation:** roll back the last deploy (see `RELEASING.md`); scale or restart
  the API service.
- **Kill switch:** not typically required for read-path availability; engage only
  if writes are corrupting state.
- **Escalation:** critical → page secondary.

### <a id="rb-api-latency"></a>RB-4: Vault API p95 Latency

- **Symptom:** `VaultApiLatencyHigh` / `VaultApiLatencyCritical`; p95 above SLO.
- **Likely causes:** slow DB queries, indexer lag feeding stale reads, resource
  saturation.
- **Verification:** `GET /api/health`; check DB query latency and indexer lag
  (`vault_indexer_ledger_lag`).
- **Mitigation:** scale API replicas; address indexer lag (RB-5) if it is the root
  cause.
- **Kill switch:** not required for latency alone.
- **Escalation:** critical → page secondary.

### <a id="rb-indexer-lag"></a>RB-5: Indexer Lag

- **Symptom:** `VaultIndexerLagHigh` / `VaultIndexerLagCritical`;
  `vault_indexer_ledger_lag` above threshold.
- **Likely causes:** Soroban RPC throttling, indexer crash, cursor stuck.
- **Verification:** `GET /api/health` (indexer status); compare indexed ledger to
  Soroban RPC latest ledger.
- **Mitigation:** restart the indexer; if the cursor is stuck, resume from the last
  confirmed ledger — never skip ledgers.
- **Kill switch:** if stale reads could misprice NAV, engage emergency pause (§6).
- **Escalation:** critical → page secondary + vault tech lead.

### <a id="rb-nav-drift"></a>RB-6: NAV Reconciliation Drift

- **Symptom:** `VaultNavDriftHigh` / `VaultNavDriftCritical`;
  `vault_nav_drift_bps` above threshold.
- **Likely causes:** stale indexer data, reconciliation job bug, on-chain state
  change not yet indexed.
- **Verification:**
  - Reported NAV: `GET /api/vault/nav`.
  - Compare against on-chain NAV via Soroban RPC for the vault contract.
  - Check last reconciliation run status in the reconciliation job logs.
- **Mitigation:** re-run reconciliation after confirming indexer is caught up
  (RB-5). If drift persists, **engage emergency pause (§6)** to halt deposits and
  epoch closes until reconciled.
- **Escalation:** critical → page secondary + vault tech lead immediately.

---

## 6. Engaging the Vault Kill Switch / Emergency Pause

The vault exposes an emergency pause that halts deposits, epoch closes, and
redemption processing. Use it when funds or epoch integrity are at risk.

1. Confirm the incident warrants a pause (NAV drift, duplicate close, out-of-order
   redemptions).
2. Invoke the pause via the vault admin endpoint / contract admin call per
   `RELEASING.md`; record the reason and timestamp in the incident channel.
3. Verify paused state: `GET /api/vault/status` reports paused.
4. Resolve the root cause, then unpause only after reconciliation confirms state.

---

## 7. Validation (Fault Injection)

Each alert is validated by deliberately injecting its failure condition in a
non-production environment and recording the result:

| Alert | Injection | Expected |
| --- | --- | --- |
| Epoch close | Pause the close keeper | `VaultEpochCloseDelayed` then `Stalled` |
| Redemption queue | Stop the processor | `VaultRedemptionQueueSlow` then `Stalled` |
| API availability | Force 5xx on `/api/vault/*` | `VaultApiErrorRateHigh` then `VaultApiDown` |
| API latency | Inject 1s delay | `VaultApiLatencyHigh` then `Critical` |
| Indexer lag | Stop the indexer | `VaultIndexerLagHigh` then `Critical` |
| NAV drift | Feed a stale NAV | `VaultNavDriftHigh` then `Critical` |

Also assert that every endpoint named in the runbooks exists
(`/api/health`, `/api/vault/epoch/current`, `/api/vault/redemptions/queue`,
`/api/vault/nav`, `/api/vault/status`).
