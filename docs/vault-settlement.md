# Vault ↔ Options Engine Settlement — Handshake Spec

## Issue #183: Settlement and Assignment/Exercise Integration

---

## Scope of this document

The authoritative implementation lives in the vault contract crate and the options-engine contract client, neither of which is in this repository. This frontend only consumes vault and settlement state through the BFF (`src/lib/api/vault.ts`, `src/lib/api/settlement.ts`). The payoff helpers in `src/lib/api/payoff.ts` and `src/lib/payoff.ts` are reference shapes, not the source of truth.

This document defines the contract-side message and entry-point surface that the vault must implement. Frontend work should consume it once the contract ships. Strike and expiry selection, backend settlement-history persistence, and UI display of assignment events are out of scope.

---

## Message Contract

Settlement is a two-phase handshake. The engine **reports** an outcome, then the vault **applies** it. Each phase is a separate transaction so that a crash between them is detectable from on-chain state alone.

| Message | Direction | Phase | Purpose |
|---|---|---|---|
| `PositionOpened` | engine → vault | — | Records a written position against the current epoch and locks its collateral. |
| `PositionExpiring` | engine → vault | — | Marks the position as expiring at `T`. Freezes it from further roll or close. |
| `SettlementReport` | engine → vault | 1 (report) | Stores the terminal outcome for each leg: `spot_T`, exercised flag, and the cash or delivery amount. Does not move collateral or NAV. |
| `SettlementApply` | vault (self-triggered) | 2 (apply) | Moves collateral, updates NAV through the share-accounting primitives, and writes the epoch event. |
| `CollateralMovement` | vault → custody | — | Transfers collateral to the holder or back to the vault. Destination is always the bound custody account, never a caller-supplied address. |

### Entry points (proposed)

- `open_position(position_id, epoch_id, legs)`: engine-only.
- `expire_position(position_id)`: engine-only, callable after `T`.
- `report_settlement(epoch_id, report)`: engine-only. Stores a `SettlementReport` keyed by `epoch_id`. Idempotent per `epoch_id`.
- `apply_settlement(epoch_id)`: permissionless, but only proceeds when a complete report exists for the epoch. Consumes the report.

Every cross-contract call is guarded against re-entrancy. NAV is never observable in a mid-update state: all NAV writes for an epoch happen in the single `apply_settlement` call.

---

## Epoch State Machine

```
Open ──► Expiring ──► Reported ──► Applied ──► Closed
                         │
                         └──(engine stale/unavailable/timeout/revert)──► Paused
                                                                          │
                                  Paused ──(retry report or admin recovery)┘──► Reported
```

- **Paused** is a recoverable state. Entering it is explicit and recorded as an epoch event. The epoch does not roll forward, and new deposits and withdrawals against that epoch's NAV are blocked until it leaves `Paused`.
- A `Reported` epoch that fails `apply_settlement` must not revert silently to `Expiring`. It goes to `Paused` so the failure stays visible.

---

## Assignment and Exercise Rules

Every rule below assumes a **complete leg set** for the epoch. See "All-or-nothing" below.

### Cash-secured put (short put) assigned

- Trigger: short put is in the money at `S_T < K`.
- Settlement: the vault pays `(K − S_T) × N` from collateral.
- Result: the vault's underlying exposure is the cash equivalent. It is not converted to the underlying, because the existing settlement model is cash-settled.
- NAV: the intrinsic loss `(K − S_T) × N` is booked against NAV. The premium received is booked as realized P&L.

### Covered call (short call) assigned

- Trigger: short call is in the money at `S_T > K`.
- Settlement: the vault's underlying is delivered at `K` per contract, or the cash equivalent `(S_T − K) × N` is paid if the engine settles in cash.
- NAV: the premium is booked as realized P&L. The difference between `K` and the position's cost basis is booked against NAV.

> **Open decision:** the existing settlement docs (`src/app/docs/settlement/page.mdx`) describe European cash settlement only. The issue asks for physical delivery of the underlying on covered-call assignment. Pick one before implementation. This spec assumes cash settlement, with physical delivery as a flag per series, but the choice is not made.

### Out-of-the-money or long positions

- No collateral movement. The option expires worthless. Short-side premium is realized, and collateral is released back to free collateral after the exercise window.

---

## All-or-Nothing per Epoch

Multi-leg structures (iron condors, spreads) settle as one unit:

- `apply_settlement` requires a `SettlementReport` covering every leg in the epoch. A partial report is rejected.
- If any leg fails to compute, the whole epoch goes to `Paused`. No partial collateral movement is allowed.

---

## Failure Modes

| Failure | Behavior |
|---|---|
| Engine reverts on `report_settlement` | Epoch → `Paused`. Event records the revert reason. Retry is permitted. |
| Engine unavailable or report stale past the timeout | Epoch → `Paused`. Admin or keeper may trigger a re-report. |
| `apply_settlement` reverts | No state change. Epoch → `Paused`. Report is preserved for retry. |
| Crash between report and apply | Detectable: epoch is `Reported` with no `Applied` event. Recovery re-runs `apply_settlement`. |

---

## Custody and Security Constraints

- Collateral can only move to the bound custody account set at vault initialization. Caller-supplied destination addresses are rejected.
- Settlement entry points that move funds are engine-only or are gated on a complete, previously reported epoch.
- No cross-contract call may leave NAV mid-update.

---

## Test Matrix (for the contract crate)

Integration tests use a mocked engine and assert NAV after each scenario:

| Scenario | Expected NAV effect |
|---|---|
| ITM expiry, short call, cash | Loss on intrinsic, premium realized |
| OTM expiry, short call | Premium realized, no collateral move |
| ITM expiry, short put | Loss on intrinsic, premium realized |
| OTM expiry, short put | Premium realized, no collateral move |
| Covered call assigned | Premium realized, delivery or cash booked |
| Cash-secured put assigned | Intrinsic loss booked, premium realized |
| Multi-leg (iron condor), one leg fails | Whole epoch `Paused`, NAV unchanged |
| Engine revert on report | Epoch `Paused`, NAV unchanged |
| Engine timeout | Epoch `Paused`, NAV unchanged |
