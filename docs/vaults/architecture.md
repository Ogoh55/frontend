# Vault Architecture Overview

This document is the versioned reference for the Phase 2 vault stack. It describes the
components, the lifecycle data flow, and the trust boundaries between them. It is
reviewed as part of any PR that changes the vault interface.

> Status: the Soroban contract suite is not yet deployed to mainnet. Vaults are
> flag-gated in the frontend and SDK; see [What is not yet shipped](#what-is-not-yet-shipped)
> before integrating. For release history see [`RELEASING.md`](../../RELEASING.md); for
> local setup see [`README.md`](../../README.md) and [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Components

```
                 ┌──────────────────────────────────────────────┐
                 │              Soroban contracts               │
                 │  vault · strategy plugin · settlement        │
                 └───────────────┬──────────────────────────────┘
                                 │ events / ledger state
                                 ▼
                 ┌──────────────────────────────────────────────┐
                 │           Indexer / backend                  │
                 │  (https://github.com/Zenith-options/backend) │
                 └───────────────┬──────────────────────────────┘
                                 │ persisted read models
                                 ▼
                 ┌──────────────────────────────────────────────┐
                 │                REST API                      │
                 └───────┬───────────────────────────┬──────────┘
                         │                           │
                         ▼                           ▼
                 ┌───────────────┐           ┌───────────────┐
                 │   Frontend    │           │      SDK      │
                 │ typed adapter │           │ external teams│
                 └───────────────┘           └───────────────┘
```

- **Contracts** — the Soroban suite that holds vault state, runs strategies, and
  settles epochs. Authoritative source of truth for balances and events.
- **Indexer / backend** — consumes contract events and ledger state, builds read
  models, and exposes them over the REST API. Never authoritative for balances.
- **REST API** — read-only surface for the frontend and SDK. See the integrator
  guide for auth, pagination, and error taxonomy.
- **Frontend** — typed adapter in `src/lib/api/vaults.ts` that maps REST responses
  into UI models.
- **SDK** — typed client consumed by outside teams; mirrors the REST surface.

## Data flow: deposit → epoch → settlement → withdrawal

1. **Deposit** — a depositor calls the vault contract's deposit entry point. The
   contract mints/credits shares and emits a deposit event. The indexer records the
   deposit against the current (open) epoch.
2. **Epoch** — an operator opens an epoch, which snapshots the deposit set and the
   strategy allocation. Deposits made after the open belong to the next epoch.
3. **Settlement** — the operator closes the epoch; the strategy plugin reports its
   result, the contract computes the settlement, and emits settlement events. The
   indexer updates read models with the settled share price.
4. **Withdrawal** — a holder calls the withdrawal entry point against settled
   shares. The contract burns shares, releases assets, and emits a withdrawal event
   that the indexer reflects in the REST read models.

Each step is observable through contract events; the REST API and SDK surface the
indexed result, not the raw ledger.

## Trust boundaries

- **Contracts ↔ indexer** — the indexer trusts only on-chain events and ledger
  state. If the indexer is stale or down, balances on chain remain correct; the
  REST API may lag.
- **Indexer ↔ REST API** — the REST API is a projection of the indexer's read
  models. It is read-only and must never be treated as a write path.
- **REST API ↔ frontend / SDK** — clients trust the REST API for display and
  reads only. Any state-changing action goes directly to the contract via a signed
  transaction; clients must not assume the API reflects an action until the
  corresponding event is indexed.
- **Operators** — epoch open/close, strategy roll, parameter changes, and emergency
  pause are privileged contract calls. See the operator guide for preconditions
  and expected observable effects.

## What is not yet shipped

- Mainnet deployment of the contract suite.
- Flag-gated vaults in the frontend and SDK — these are behind feature flags and
  must not be assumed available to integrators.

For the contract interface reference (entry points, arguments, return types, error
codes, events, storage entries, authorization, and upgrade mechanism), see the
contract reference generated from the checked-in contract spec. For security
invariants see [`docs/security/invariants.md`](../security/invariants.md).
