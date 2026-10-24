# Vault Testing Harness

Status: **planned, not yet implemented.** This document tracks the correctness
harness for issue #203 and records what exists in this repo today, what is
blocked on other repos, and the invariants the harness must enforce before the
vaults flag leaves canary.

## Layers

The vault stack runs through four layers. Each needs its own test layer:

| Layer | Lives in | Status in this repo |
|---|---|---|
| Soroban vault contracts | Contracts repo (not here) | Not present. `contracts/` only holds `fixtures/` (API schemas) and `perf/` |
| Indexer | Backend repo (not here) | Not present |
| Vault API | Backend repo (`/api/v1/vaults`, not here) | Not present. `e2e/mockBackend.ts` has no vault routes |
| Frontend adapter | `src/lib/api/vaults.ts` | Mock only. The `live` branch of every function throws |

Nothing in this repo can exercise the contract → indexer → API → adapter path
end to end yet. The first real gate is the live adapter.

## Invariants to enforce

Share math uses 7-decimal Stellar amounts. Use integer (i128) arithmetic in the
contract and in any reference model. Do not use floats for share math.

1. **Share supply.** Sum of all holder balances equals tracked total supply after every operation.
2. **NAV monotonicity.** In a fee-free epoch with no realized losses, NAV per share never decreases.
3. **Withdrawal bound.** A holder can never withdraw more assets than `shares × NAV / totalShares`, rounded down.
4. **No immediate extraction.** Deposit followed by immediate redeem returns no more than the deposit, net of rounding.
5. **Conservation.** Total value in ≥ total value out across any operation sequence.

Rounding direction is part of the invariant: deposits round shares down, and
redemptions round assets down, so the vault keeps the dust.

## Edge cases to cover

- First depositor on a zero-supply vault (share-price inflation attack). Needs a virtual-share offset or a minimum initial deposit.
- Zero-supply vault: withdraw and redeem must revert, not divide by zero.
- Extremely large and dust deposits, at the 7-decimal boundary.
- Epoch rollover with an empty queue, and with a partially filled queue.

## Fuzz and sequence testing

Stateful sequences over: deposit, redeem request, epoch rollover, premium
collection, fee accrual, and settlement callbacks.

- Runs use fixed seeds in CI so failures reproduce.
- Every failing sequence is saved under `contracts/fixtures/regressions/` as a fixture, with the seed and the operation list.
- Extended campaigns run locally with a larger iteration count and a random seed. The exact command will be added with the harness.

## CI wiring (planned)

- A separate job per layer in `.github/workflows/ci.yml`, each with `timeout-minutes` set.
- Fast invariant tests run on every PR. Extended fuzz runs are scheduled, not per-PR.
- The integration job runs against the mock backend first, then against the real backend once it is available.

## Mutation check

Every invariant must have a deliberately failing demonstration: mutate the
contract locally (for example, round shares up on deposit) and confirm the
harness fails. Record the mutation next to the invariant.

## Blockers

- Vault contracts, indexer, and vault API are not in this repo. The harness for layers 1–3 must live in (or be pinned to) those repos.
- `NEXT_PUBLIC_VAULTS=live` is not implemented in `src/lib/api/vaults.ts`, so the adapter cannot be exercised against a real backend.
- `e2e/mockBackend.ts` needs `/api/v1/vaults` routes before the adapter can be tested through Playwright.
