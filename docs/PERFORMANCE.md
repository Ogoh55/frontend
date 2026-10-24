# Vault Contract Resource Budgets

This document defines the Soroban resource budgets for every vault contract entry
point, how they are measured, and the headroom each entry point must keep against
the current network limits. It is the reference for the CI regression gate and for
the frontend's fee estimation (which consumes the published per-entry-point
numbers).

## Why this exists

Soroban transactions fail outright when they exceed network resource limits. A
vault epoch close can touch every depositor, every open position, and multiple
strategy modules in a single invocation, so a design that works with 5 test
depositors can be un-submittable with 5,000. Without a known footprint we cannot
give depositors an honest fee preview, and an epoch close that intermittently
fails is an operational outage.

## Current Soroban limits (reference)

These are the per-transaction limits the budgets are measured against. Update
this table if the network limits change; the CI gate reads the budgets below, not
this table, so a limit change requires a deliberate budget review.

| Resource              | Per-transaction limit |
| --------------------- | --------------------- |
| CPU instructions      | 100,000,000           |
| Memory (bytes)        | 40,000,000            |
| Ledger entry reads    | 100                   |
| Ledger entry writes   | 100                   |
| Read bytes            | 200,000               |
| Write bytes           | 132,096               |

## Measurement harness

Benchmarks live under `scripts/` and run against the contract test harness using
Soroban's budget accounting. The harness is deterministic: fixed seeds, fixed
account/asset identifiers, and a fixed operation order, so numbers are comparable
across runs and across PRs.

Each benchmark reports, per entry point:

- CPU instructions
- memory bytes
- ledger entry reads and writes
- read bytes and write bytes

Run the harness locally with:

```
./scripts/bench-vault.sh
```

The harness emits a machine-readable report (JSON) that the CI gate compares
against the budgets in the next section, and that is attached to release
artifacts for the frontend's fee estimation.

## Worst-case scenarios

Budgets are set from worst cases, not averages. Each entry point is benchmarked
at a representative size and at its worst case:

| Entry point            | Representative        | Worst case                                   |
| ---------------------- | --------------------- | -------------------------------------------- |
| `deposit`              | 100 depositors        | vault at capacity, new depositor             |
| `request_withdrawal`   | 100 queued            | full withdrawal queue                        |
| `execute_withdrawal`   | 100 queued            | full withdrawal queue, last entry            |
| `close_epoch`          | 100 depositors        | at capacity, many expired positions          |
| `rollover_strategy`    | 1 strategy            | all strategy modules, full position set      |
| `settlement_callback`  | 1 settlement          | settlement spanning all open positions       |

## Per-entry-point budgets

Budgets are the worst-case measured values rounded up, with explicit headroom
against the limits above. The CI gate fails when a benchmarked entry point
exceeds its budget by more than the defined threshold (see below).

| Entry point            | CPU instructions | Memory (bytes) | Entry reads | Entry writes |
| ---------------------- | ---------------- | -------------- | ----------- | ------------ |
| `deposit`              | 8,000,000        | 3,000,000      | 12          | 6            |
| `request_withdrawal`   | 6,000,000        | 2,500,000      | 10          | 4            |
| `execute_withdrawal`   | 10,000,000       | 4,000,000      | 16          | 8            |
| `close_epoch`          | 45,000,000       | 18,000,000     | 60          | 40           |
| `rollover_strategy`    | 20,000,000       | 8,000,000      | 30          | 20           |
| `settlement_callback`  | 15,000,000       | 6,000,000      | 24          | 16           |

Headroom against the per-transaction limits:

- CPU: the largest budget (`close_epoch`, 45M) keeps 55% headroom.
- Memory: the largest budget (`close_epoch`, 18M) keeps 55% headroom.
- Entry reads/writes: every budget stays at or below 60% of the limit.

If a worst-case benchmark cannot fit these budgets, the entry point must be
optimized (see below) rather than the budget raised. Raising a budget requires a
reviewed change to this document explaining why the cost is unavoidable.

## Optimization guidelines for hot paths

When a benchmark exceeds its budget, apply these in order:

1. **Batch/cursor processing.** Process depositor sets and withdrawal queue
   entries in bounded batches with a persisted cursor, so a single invocation
   never touches the whole set. Beware that adding a cursor shifts cost into the
   next invocation; benchmark the follow-up call too.
2. **Avoid unnecessary persistent-entry reads.** Read each persistent entry at
   most once per invocation and reuse the value; do not re-read to check state
   that was already loaded.
3. **Minimize stored value sizes.** Store compact representations (packed flags,
   smaller integer widths where safe) so read/write bytes stay low.
4. **Choose instance vs persistent deliberately.** Small, frequently-read
   contract-wide config belongs in instance storage; per-depositor and
   per-position data belongs in persistent storage keyed by account/position.

## CI regression gate

The CI workflow runs the benchmark harness and compares each entry point's
measured resources against the budgets above. The gate fails when any measured
value exceeds its budget by more than **10%** (the defined threshold). This
threshold absorbs run-to-run noise while catching real creep.

On failure, the CI job prints the offending entry point, the measured value, the
budget, and the percentage over budget, so the fix is obvious.

## Published numbers

Per-entry-point resource numbers are published alongside release artifacts (the
JSON report emitted by the harness) so the frontend's fee estimation can consume
them. The frontend fee-preview UX itself is handled by the transaction
simulation issue and is out of scope here.
