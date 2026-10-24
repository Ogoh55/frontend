# Cross-Strategy Vault Allocator: Rebalancing Policy

An allocator vault holds shares of child strategy vaults (covered call, cash-secured put,
iron condor, wheel). LPs deposit once into the allocator and receive allocator shares; they
never interact with child vaults directly.

## Policy

- Each child is `(vaultId, targetWeight, driftBand)`.
- `targetWeight` values are 0–1 and must sum to 1.
- `driftBand` is 0 < band ≤ 1. A child breaches when `|currentWeight − targetWeight| > driftBand`.
- The policy is governed and versioned. Every change bumps `version`, so each rebalance can be
  traced to the policy that triggered it.
- An allocator may not hold shares of itself or of any other allocator. Validation rejects
  both at configuration time.

## NAV

- Allocator NAV is the sum of child holdings, each marked at that child's last published epoch NAV.
- A child is **tradeable** only when its NAV is published for the current epoch and it is not paused.
- If any child is untradeable, or priced from a stale mark, the allocator NAV is flagged
  `degraded` and the untradeable children are listed. It is never silently priced at a stale value.

## Rebalancing

- A rebalance is due when at least one child has breached its drift band **and** is tradeable.
- Rebalancing never forces an early exit from a child that would incur an avoidable penalty,
  unless the trigger explicitly allows it.
- Rebalancing respects each child's epoch state and deposit capacity. A child deposit that is
  rejected by capacity is partially filled.
- Total allocator NAV is conserved across a rebalance, apart from accounted fees.
- Rebalancing is a permissionless call, rate-limited so a keeper can trigger it. The system remains
  safe if no one calls it.

## Fees

- The allocator fee and each child vault's fee are shown as separate layers.
- Reported APY is computed once on the allocator NAV. Child fees are not counted a second time.
- The fee disclosure must state both layers.

## Out of scope

- Quantitative signal generation.
- Automated optimization of target weights.
