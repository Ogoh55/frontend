# Oracle policy: strike selection and collateral valuation

Status: **proposed**. Numeric bounds and haircuts below are starting values
for the risk committee to ratify, not measured calibrations. Every figure in
this document is normative for the vault contract once adopted, and it is
enforced on-chain, not in this frontend.

## Why this exists

`src/lib/pricing.ts` is a client-side preview. It is never a source of truth
for custody or settlement. Two decisions must not rest on it or on
operator-declared numbers:

1. **Strike selection**: which listed strike the vault sells each epoch.
2. **Collateral valuation**: what posted collateral is worth for haircut and
   exposure checks.

If either input is unverified, an operator can pick favourable strikes, or
depositors can be mispriced into or out of an epoch. The rules below remove
both paths.

## 1. Price sources

| Input | Primary | Cross-check | Trust assumption |
|---|---|---|---|
| Underlying spot (per asset) | Backend-signed price attestation (Ed25519, signed by the options engine in `Zenith-options/backend`) | Third-party on-chain Stellar oracle feed for the same asset | Attestation key is held by the backend and rotated through governance. The third-party feed is trusted for its own liveness and accuracy, not for correctness. |
| Option mark / implied vol (per listed strike) | Backend-signed attestation | None on-chain | Backend is trusted. Its IV is checked only for staleness and sanity bounds. |
| Stellar DEX (SDEX) trade VWAP | Reference only, not consumed on-chain | - | Thin markets make a single DEX print manipulable. It is used off-chain for monitoring and alerts. |

Rules:

- The contract **never** computes option marks or IV from Black-Scholes and
  never accepts a price from an operator-supplied argument. The `bs()` function
  in `pricing.ts` is display-only.
- A source that fails validation is excluded. It is not replaced by a local
  estimate.

### Fallback ordering (spot)

1. Backend attestation, if valid and fresh.
2. Third-party feed, if valid and fresh **and** it agrees with the attestation
   within the deviation bound. If the attestation is absent, the feed alone is
   not accepted: the epoch halts (see §2).
3. Otherwise: **halt**. There is no third fallback.

## 2. On-chain validation

Validation is a pure function of `(sources, timestamps, bounds)`. It takes no
ambient state, so it can be tested exhaustively.

| Bound | Starting value | Applies to |
|---|---|---|
| `MAX_SPOT_AGE` | 60 s before epoch close | Spot attestation and feed |
| `MAX_IV_AGE` | 300 s before epoch close | Option marks and IV |
| `MAX_SPOT_DEVIATION` | 1.0% of mid, attestation vs feed | Spot |
| `MAX_IV_DEVIATION` | 2 vol points, attestation vs prior epoch IV for same strike | IV sanity |
| `MAX_EPOCH_JUMP` | 10% vs the previous epoch's snapshot spot | Spot |
| `MAX_STABLE_DEPEG` | 1.0% from 1.00 | Stablecoin collateral |

Timestamps are compared against the **ledger close time** at epoch close, not
the client clock.

Hard-stop rule: if any check fails, the epoch **does not advance**. The
contract emits `EpochHalted(epoch, reason)` and leaves state unchanged. Prices
are not re-read mid-epoch. The halt can be cleared only by a fresh, valid
snapshot submitted at a later ledger.

Feeds that report after the epoch deadline are rejected. They cannot be
used to backdate a snapshot.

All prices are normalized to **7 decimals** (the Stellar asset scale) at
ingestion, using each asset's declared decimals. Zero, negative, or
non-finite values are rejected as invalid. They are not treated as "missing".

## 3. Snapshot

Pulled and validated at the epoch boundary, cached for the whole epoch, and
never re-read. The snapshot is stored with these fields:

- `epoch`, `ledger_seq`, `close_time`
- `spot` (7 dp), `spot_ts`, `spot_sources` (ids of the sources used)
- `iv`, `iv_ts`, per listed strike
- `listed_strikes_hash` (hash of the sorted listed set)
- `target_delta`, `bounds_version`
- `algo_strike`, `final_strike`, `selection` (`Algorithmic` | `Override`)
- `override_reason` (only when `selection = Override`)

The snapshot is what an audit replays. Given it, anyone can recompute
`algo_strike` and confirm the same value.

## 4. Strike selection (deterministic)

Inputs: spot `S`, vol `σ` (decimal, > 0), days to expiry `D` (> 0),
`t = D / 365`, target call delta `Δ*` in `(0, 1)` (default 0.25), and the
sorted listed strike set `L` (non-empty).

1. Solve for the strike `K*` whose Black-Scholes call delta equals `Δ*`, using
   the flat rate `r = 0.05`. Delta decreases monotonically in `K`, so
   bisection on `[S·0.01, S·100]` for a fixed 200 iterations gives a
   reproducible result.
2. Snap `K*` to the nearest element of `L` by absolute distance.
3. **Tie-break**: if two listed strikes are equidistant from `K*`, choose the
   **higher** strike. For a sold call that is the further-OTM, more
   conservative choice. The rule does not depend on list order.
4. If `L` is empty, or `Δ*` / `σ` / `D` is out of range, return no strike and
   halt the epoch.

Reference implementation: `selectStrike` in `src/lib/pricing.ts`. It is for
reference and reproduction only. The on-chain implementation must produce the
same output for the same inputs (use fixed-point with a documented precision,
and the same tie rule).

Property the test suite must hold: the returned strike is always an element of
`L`.

## 5. Operator override

The operator may replace `algo_strike` with another listed strike only when:

- the replacement is within **±2 listed strikes** of `algo_strike`, and
- the replacement's delta is within **±0.05** of `Δ*` (computed from the same
  snapshot), and
- a non-empty `reason` is supplied.

Each override emits `StrikeOverride(epoch, algo_strike, final_strike, reason)`.
The chosen strike still passes the risk module's exposure caps. A failed cap
rejects the override and the epoch falls back to `algo_strike` if that
passes; otherwise the epoch halts.

## 6. Collateral mark-to-market

Collateral is valued as `value = qty · spot · (1 − haircut)` using the epoch
snapshot price. Deposits accepted before the snapshot are valued at the
snapshot, not at the deposit-time price. This means a price move between
deposit and close cannot change what was accepted.

| Asset class | Examples | Price source | Haircut (proposed) |
|---|---|---|---|
| Native XLM | XLM | Spot attestation | 20% |
| Major wrapped crypto | BTC, ETH | Spot attestation | 15% |
| Other crypto | SOL and others | Spot attestation | 25% |
| USD stablecoin | USDC | Spot attestation, peg check | 2% |

For a stablecoin, a deviation from 1.00 beyond `MAX_STABLE_DEPEG` halts the
epoch. It is not valued at the depegged price. Haircuts are set by governance
and changed only through the timelock.

## 7. Edge cases

| Case | Handling |
|---|---|
| Stale, zero, or inverted price (bid > ask, or `high < low`) | Rejected. Epoch halts if no valid source remains. |
| Price jump between deposit and close | Deposits are valued at the snapshot. A jump over `MAX_EPOCH_JUMP` halts the epoch. |
| Thin market, wide spread | SDEX prints are not consumed on-chain. Spread does not change the attested mid. |
| Mixed asset decimals | Normalized to 7 dp at ingestion. |
| Feed reports after deadline | Rejected. |
| Deviation bound trips during a roll | Halt. The roll does not proceed on a partially validated snapshot. |

## 8. Out of scope

- Building or operating an oracle provider.
- Historical vol surface modeling.
- Accuracy of the client-side pricing layer in `src/lib/pricing.ts`.
