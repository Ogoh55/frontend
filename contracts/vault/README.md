# Vault strategy modules

Crates:

- `core` (`vault-core`): the shared `Strategy` trait, intent types and `validate_intent` risk check.
- `strategies` (`vault-strategies`): covered call, cash-secured put, iron condor and wheel, resolved with `strategy_by_id`.

Modules are pure. They take `EpochInputs` (spot, free collateral, remaining capacity, open positions, the options engine's listed set) plus `StrategyParams`, and return an `Intent` (positions to close and open). The epoch engine executes it. Selection is deterministic: closest to target, ties go to the lower strike and then the shorter expiry. Only listed, liquid options inside the tenor window are ever chosen. If none qualify, the intent is a no-op.

## Interface

| Method | Purpose |
| --- | --- |
| `id` | Registry id (`covered_call`, `cash_secured_put`, `iron_condor`, `wheel`) |
| `collateral` | Declared collateral type, checked by the risk module before any open |
| `preview` / `open` | Selection for the next epoch (opens only) |
| `roll` | Close and re-open according to the roll policy |
| `handle_assignment` | Follow-up intent after an in-the-money expiry; `inputs` must reflect post-assignment balances |
| `wind_down` | Close every open position |

## Collateral

| Strategy | Collateral | Locked per contract |
| --- | --- | --- |
| Covered call | Underlying | `underlying_per_contract` |
| Cash-secured put | Settlement | `strike * settlement_per_strike_unit` |
| Iron condor | Settlement | widest wing width `* settlement_per_strike_unit` |
| Wheel | Settlement while in put stage, Underlying while in call stage | as above |

Units come from `EpochInputs`; modules never re-derive decimals. Quantity is capped by free collateral and `capacity_remaining`.

## Strategy parameters (operator-settable, per vault)

| Parameter | Meaning |
| --- | --- |
| `target` | `DeltaBps(n)` target absolute delta (2000 = 0.20) or `OtmBps(n)` OTM distance from spot |
| `min_tenor_days`, `max_tenor_days` | Eligible expiry window (inclusive) |
| `max_positions` | Max concurrent positions (an iron condor uses 4) |
| `roll_policy` | `Always`: close and re-open. `OnlyIfAcceptable`: roll only if the next epoch has an acceptable strike, else hold. `HoldToExpiry`: never roll |
| `wing_width_bps` | Iron condor only: minimum long-wing distance beyond each short strike, in bps of spot |

## Wheel

The stage comes from balances, not stored state: holding at least one contract of underlying, or a short call open, means call stage; otherwise put stage. A put assignment leaves the vault holding the underlying, so the next epoch sells a covered call. A call exercise returns it to puts. If no strike is eligible the wheel stays flat. It always ends in a covered call, a put, or flat.

## Risk check

`validate_intent` rejects an intent that uses the wrong collateral type, is not in the listed set, exceeds position slots, exceeds free collateral, or exceeds remaining capacity.
