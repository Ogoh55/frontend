# Vault On-Call: SLOs, Alerting Thresholds, and Runbooks

This document defines the service-level objectives (SLOs) for the vault stack
(contract, indexer, API, frontend read path), the Prometheus alert rules that
enforce them, and the runbook the on-call engineer follows for each alert.

Each alert maps to exactly one runbook section below. Alerts are derived from
metrics already emitted by the epoch ledger and NAV reconciliation jobs; no
alert recomputes vault state independently.

## Severity definitions

| Severity | Meaning | Response |
| --- | --- | --- |
| `critical` | Depositor funds or epoch integrity at risk; user-visible outage. | Page on-call immediately. Acknowledge within 5 min, mitigate within 30 min. |
| `warning` | SLO burn trending toward breach; degraded but functional. | Page on-call during business hours; acknowledge within 30 min. |
| `info` | Anomaly worth a look, no user impact yet. | Ticket, review next business day. |

## On-call rota and escalation

- **Primary on-call**: rotates weekly (Mon 09:00 UTC handoff). Owns all `critical`
  and `warning` pages.
- **Secondary on-call**: rotates weekly, one week behind primary. Escalation target
  if primary does not acknowledge within 10 min.
- **Vault owner / protocol lead**: escalation target for any `critical` alert not
  mitigated within 30 min, and required approver for engaging the emergency pause.
- **Escalation path**: primary → secondary (10 min) → vault owner (30 min) →
  incident commander + comms (45 min).
- Rota is maintained in the team calendar; the current primary is also surfaced on
  the `/api/health` response (`on_call` field) so responders can confirm ownership.

## SLOs

| SLO | Target | Metric source |
| --- | --- | --- |
| Epoch close timeliness | Actual close within 5 min of expected close for 99% of epochs | `vault_epoch_close_delay_seconds` (epoch ledger) |
| Redemption queue latency | 95% of redemptions fulfilled within 1 epoch; none older than 2 epochs | `vault_redemption_queue_age_seconds` (epoch ledger) |
| Vault API availability | 99.9% of 5xx-free requests over 30 days | `http_requests_total{job="vault-api"}` |
| Vault API p95 latency | p95 < 400 ms over 30 days | `http_request_duration_seconds{job="vault-api"}` |
| Indexer lag | Indexer within 30 s of Soroban ledger tip for 99% of the time | `vault_indexer_ledger_lag_seconds` |
| NAV reconciliation drift | On-chain NAV vs. reported NAV drift < 0.1% at all times | `vault_nav_drift_ratio` (reconciliation job) |

Thresholds are configurable per environment via the runtime config
(`config/staging.*` vs `config/production.*`); the values below are the
production defaults. Staging uses the same rules with relaxed thresholds so
fault-injection game days do not page production on-call.

## Alert rules

```yaml
groups:
  - name: vault-slo
    rules:
      # --- Epoch close timeliness ---
      - alert: VaultEpochCloseStalled
        expr: vault_epoch_close_delay_seconds > 300
        for: 2m
        labels: { severity: critical, runbook: epoch-close-stalled }
        annotations:
          summary: "Epoch {{ $labels.epoch }} close is >5m past expected"
      - alert: VaultEpochCloseDelayed
        expr: vault_epoch_close_delay_seconds > 120
        for: 15m
        labels: { severity: warning, runbook: epoch-close-stalled }
        annotations:
          summary: "Epoch close trending late (>2m for 15m)"

      # --- Redemption queue latency ---
      - alert: VaultRedemptionQueueStalled
        expr: vault_redemption_queue_age_seconds > 2 * vault_epoch_duration_seconds
        for: 5m
        labels: { severity: critical, runbook: redemption-queue-stalled }
        annotations:
          summary: "Redemptions older than 2 epochs in queue"
      - alert: VaultRedemptionQueueBacklog
        expr: vault_redemption_queue_age_seconds > vault_epoch_duration_seconds
        for: 30m
        labels: { severity: warning, runbook: redemption-queue-stalled }
        annotations:
          summary: "Redemption queue backlog older than 1 epoch"

      # --- Vault API availability & latency ---
      - alert: VaultApiAvailabilityBurn
        expr: |
          sum(rate(http_requests_total{job="vault-api",code=~"5.."}[5m]))
            / sum(rate(http_requests_total{job="vault-api"}[5m])) > 0.05
        for: 5m
        labels: { severity: critical, runbook: api-availability }
        annotations:
          summary: "Vault API 5xx rate >5% over 5m"
      - alert: VaultApiAvailabilitySlowBurn
        expr: |
          sum(rate(http_requests_total{job="vault-api",code=~"5.."}[1h]))
            / sum(rate(http_requests_total{job="vault-api"}[1h])) > 0.01
        for: 1h
        labels: { severity: warning, runbook: api-availability }
        annotations:
          summary: "Vault API 5xx rate >1% over 1h"
      - alert: VaultApiLatencyHigh
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_seconds_bucket{job="vault-api"}[5m])) by (le)) > 0.4
        for: 10m
        labels: { severity: warning, runbook: api-latency }
        annotations:
          summary: "Vault API p95 latency >400ms for 10m"

      # --- Indexer lag ---
      - alert: VaultIndexerLagCritical
        expr: vault_indexer_ledger_lag_seconds > 120
        for: 2m
        labels: { severity: critical, runbook: indexer-lag }
        annotations:
          summary: "Indexer >120s behind Soroban ledger tip"
      - alert: VaultIndexerLagWarning
        expr: vault_indexer_ledger_lag_seconds > 30
        for: 15m
        labels: { severity: warning, runbook: indexer-lag }
        annotations:
          summary: "Indexer >30s behind ledger tip for 15m"

      # --- NAV reconciliation drift ---
      - alert: VaultNavDriftCritical
        expr: vault_nav_drift_ratio > 0.001
        for: 1m
        labels: { severity: critical, runbook: nav-drift }
        annotations:
          summary: "On-chain vs reported NAV drift >0.1%"
      - alert: VaultNavDriftWarning
        expr: vault_nav_drift_ratio > 0.0005
        for: 30m
        labels: { severity: warning, runbook: nav-drift }
        annotations:
          summary: "NAV drift >0.05% sustained 30m"
```

Short `for:` windows catch genuine stalls; the paired long-window rules avoid
flapping on transient blips. Alerts are suppressed during a documented wind-down
(`vault_wind_down_active == 1`) and while a vault is legitimately inside a
closed-epoch window (`vault_epoch_state == "closed"`), so expected behaviour does
not page.

## Runbooks

### epoch-close-stalled

- **Symptom**: `VaultEpochCloseStalled` / `VaultEpochCloseDelayed` — an epoch did
  not close within its expected window.
- **Likely causes**: keeper/cron not running, insufficient gas on the close tx,
  Soroban RPC degraded, or a stuck close transaction.
- **Verify**: check `GET /api/health` (`epoch_state`, `last_close_at`), then
  `GET /api/epochs/current` for expected vs. actual close time. Confirm the
  keeper process is alive and the last close tx hash on the explorer.
- **Mitigate**: restart the keeper; if the close tx is stuck, re-submit via the
  admin close endpoint. If the contract is unresponsive, engage the emergency
  pause (below) to prevent deposits into a stale epoch.
- **Escalate**: secondary after 10 min; vault owner after 30 min.

### redemption-queue-stalled

- **Symptom**: `VaultRedemptionQueueStalled` / `VaultRedemptionQueueBacklog` —
  redemptions aging past one or two epochs.
- **Likely causes**: epoch close stalled (see above), indexer lag hiding fulfilled
  redemptions, or a processing job failure.
- **Verify**: `GET /api/redemptions/queue` for oldest age and count; cross-check
  `GET /api/health` indexer lag. Confirm the redemption processor is running.
- **Mitigate**: resolve any underlying epoch-close stall first; restart the
  redemption processor; if backlog is due to a wind-down, confirm
  `vault_wind_down_active` and annotate the incident rather than paging further.
- **Escalate**: secondary after 10 min; vault owner after 30 min.

### api-availability

- **Symptom**: `VaultApiAvailabilityBurn` / `VaultApiAvailabilitySlowBurn` —
  elevated 5xx rate on the vault API.
- **Likely causes**: upstream RPC/indexer failure, bad deploy, or DB saturation.
- **Verify**: `GET /api/health` (dependency status), check recent deploys in
  `RELEASING.md`, inspect error logs for the failing route.
- **Mitigate**: roll back the last deploy per `RELEASING.md`; if upstream RPC is
  down, fail over to the secondary RPC endpoint.
- **Escalate**: secondary after 10 min; vault owner after 30 min.

### api-latency

- **Symptom**: `VaultApiLatencyHigh` — p95 latency above 400 ms.
- **Likely causes**: slow indexer queries, cold cache, or DB contention.
- **Verify**: `GET /api/health` latency breakdown; check DB connection pool and
  slow-query logs.
- **Mitigate**: warm caches, scale API replicas, or shed non-critical read paths.
- **Escalate**: secondary if latency persists past 30 min.

### indexer-lag

- **Symptom**: `VaultIndexerLagCritical` / `VaultIndexerLagWarning` — indexer
  behind the Soroban ledger tip.
- **Likely causes**: RPC throttling, indexer crash, or a ledger gap.
- **Verify**: `GET /api/health` (`indexer_lag_seconds`, `ledger_tip`); compare to
  the public Soroban ledger tip.
- **Mitigate**: restart the indexer; if RPC is throttling, switch to the backup
  RPC. Do not trust NAV/queue reads until lag is back under 30 s.
- **Escalate**: secondary after 10 min; vault owner after 30 min.

### nav-drift

- **Symptom**: `VaultNavDriftCritical` / `VaultNavDriftWarning` — reported NAV
  diverges from on-chain NAV.
- **Likely causes**: reconciliation job stale, indexer lag, or a genuine on-chain
  state change not yet reflected.
- **Verify**: `GET /api/vault/nav` (reported) vs. on-chain NAV from the contract;
  check `GET /api/health` indexer lag and last reconciliation timestamp.
- **Mitigate**: if drift is due to indexer lag, resolve that first; if drift is
  genuine and material, engage the emergency pause to halt deposits/withdrawals
  until reconciled, and notify the vault owner.
- **Escalate**: vault owner immediately for `critical`; secondary for `warning`.

## Engaging the emergency pause / kill switch

The vault exposes an admin emergency pause. Engage it only when depositor funds
or epoch integrity are at risk and mitigation is not immediate:

1. Confirm with the vault owner (required approver for `critical`).
2. Call the admin pause endpoint (`POST /api/admin/pause`) or the contract's
   `pause` entry point via the admin key.
3. Verify `GET /api/health` reports `paused: true`.
4. Announce in the incident channel and open a follow-up to unpause after
   reconciliation.

## Validating alerts (game day)

Each alert is validated by deliberately injecting its failure condition in a
non-production environment and recording the result:

- Epoch close: stop the keeper and confirm `VaultEpochCloseStalled` fires.
- Redemption queue: pause the processor and confirm the queue alert fires.
- API availability/latency: inject 5xx / latency via the fault-injection proxy.
- Indexer lag: pause the indexer and confirm lag alerts fire.
- NAV drift: feed a mismatched NAV into the reconciliation job.

Record each game-day result (alert fired, runbook followed, endpoints reachable)
in the incident log. The runbooks' named endpoints (`/api/health`,
`/api/epochs/current`, `/api/redemptions/queue`, `/api/vault/nav`,
`/api/admin/pause`) are asserted to exist by the API health test suite.
