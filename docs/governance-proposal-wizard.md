# Proposal Wizard (Issue #89)

Route: **`/governance/new`**

A four-step flow for drafting, simulating and submitting a governance proposal.

```
Details  →  Actions  →  Simulate  →  Review & submit
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/lib/governance/actions.ts` | Catalog of governable contracts/functions, typed argument encoding, form generation, human-readable summaries, danger rules |
| `src/lib/governance/strkey.ts` | Dependency-free Stellar `G…` / `C…` checksum validation |
| `src/lib/governance/simulation.ts` | Reads current on-chain values and renders `current → proposed` diffs |
| `src/lib/governance/draft.ts` | Versioned local draft persistence and metadata validation |
| `src/lib/governance/submit.ts` | Threshold gate, fee estimate, proposal payload, Soroban submission |
| `src/lib/governance/markdown.ts` | Safe Markdown subset for the body preview (AST, no `dangerouslySetInnerHTML`) |
| `src/app/governance/new/page.tsx` | Route adapter |
| `src/app/governance/new/_components/` | `ProposalWizard` plus one component per step |

`ProposalWizard` takes every external dependency as a prop — `signer`, `proposer`,
`contractIds`, `governorContractId`, `thresholdState`, `reader` — so the flow renders
and is tested without a wallet, a network, or the Next.js router.

## Step 1 — Details

Title (8–120), summary (≤280), Markdown description (≥40) and an optional discussion
link restricted to `http`/`https`. The description is rendered live beside the form.

## Step 2 — Actions

Contract and function come from dropdowns populated by `GOVERNABLE_CONTRACTS`. Argument
inputs are **generated from the function's declared params** — adding a governable
function to the catalog needs no changes to the wizard.

Catalogued contracts: `market`, `vault`, `oracle`, `governor`, `timelock`, `deployer`.
Supported param types: `u32`, `u64`, `u128`, `i128`, `bool`, `address`, `contract`,
`symbol`, `string`, `vec<address>`.

Each action renders a plain-English summary, e.g.

> Put collateral ratio → Collateral ratio 110%

Flagged as **high impact** (requires extra confirmation before submitting):
`market.set_paused`, `market.set_collateral_address`, `vault.set_paused`,
`oracle.set_feeds`, `timelock.set_admin`, `deployer.upgrade_contract`.

## Step 3 — Simulate

For every parameter with a `readMethod`, the current on-chain value is read through the
injected `ValueReader` and shown beside the proposed value with a delta and direction.
A read that fails is reported as a partial preview rather than blocking or hiding it.

This step is viewable even when actions are invalid, so errors are visible — but the flow
cannot advance to Review until the simulation is clean.

## Step 4 — Review and submit

Shows the rendered proposal, the proposer's threshold progress, and a fee estimate. High
impact proposals replace the submit button and require ticking an explicit acknowledgement.

Submission builds the `submit_proposal` argument tuple and forwards it through the shared
pipeline (`executeContractCall` + `createPipelineEventHandler`), so progress appears in
the normal transaction tracker and failed transactions remain retryable.

## Drafts

Autosaved (debounced 300 ms) to `localStorage` under `zenith_governance_proposal_draft`,
version-stamped. Reads are defensive: malformed or stale payloads fall back to an empty
draft instead of throwing. The draft is cleared only after a confirmed submission.

## Configuration

Contract IDs are read through `src/env.ts` (per the repo's `no-restricted-properties`
lint rule), with one optional variable per contract per network:

```
NEXT_PUBLIC_CONTRACT_GOVERNOR_TESTNET
NEXT_PUBLIC_CONTRACT_MARKET_TESTNET
NEXT_PUBLIC_CONTRACT_VAULT_TESTNET
NEXT_PUBLIC_CONTRACT_ORACLE_TESTNET
NEXT_PUBLIC_CONTRACT_TIMELOCK_TESTNET
NEXT_PUBLIC_CONTRACT_DEPLOYER_TESTNET
```

…and the matching `*_MAINNET` variables. All are optional; unset entries surface as a
"Contracts not configured" notice, and submission is refused rather than sent to a zero
address.

## Wiring the wallet

`src/lib/store/wallet.ts` is a **zero-byte file on `main`**, so this feature does not
import it. The route reads the signer from `ProposalSignerProvider`
(`_components/wallet.tsx`), which defaults to "not connected":

```tsx
<ProposalSignerProvider value={{ signer, address }}>
  {children}
</ProposalSignerProvider>
```

Wrap the app (or this route) in that provider once the wallet store is restored.

## Timelock & multisig approval workflow (Issue #224)

Vault parameter and upgrade changes are **not** applied by the wizard directly. The
wizard only *submits* a proposal; the on-chain governance module enforces the rest.

### Lifecycle

```
propose → approve (× threshold) → queue → delay elapses → execute
                 ↘ cancel (any time before execute)
                 ↘ expire (stale, never queued/executed in time)
```

| Stage | Who | Effect |
| --- | --- | --- |
| `propose` | any signer | Records a typed action payload; emits `ProposalCreated` |
| `approve` | each signer | Adds an approval; emits `ProposalApproved`. Revocable before `queue` |
| `queue` | any signer, once approvals ≥ threshold | Stamps `eta = now + delay`; emits `ProposalQueued` |
| `execute` | anyone, after `eta` and before expiry | Applies the action; emits `ProposalExecuted` |
| `cancel` | proposer or signer | Emits `ProposalCancelled` |
| expiry | — | Proposals past their deadline emit `ProposalExpired` and can no longer execute |

### Governance-only setters

The following privileged setters are reachable **only** through an executed proposal —
there is no separate admin entry point:

- fee bps and fee recipient
- capacity limits
- strategy weights / strategy parameters
- oracle configuration
- contract upgrade authorization

The threshold and delay parameters themselves are also changed only through the same
workflow, so they cannot be lowered without a timelock.

### Edge cases

- Duplicate proposals for the same parameter are rejected.
- Approvals can be revoked before `queue`; a signer-set change does not retroactively
  invalidate already-queued proposals.
- Execution before `eta`, after expiry, or a replay of an executed proposal reverts.
- Replay protection is keyed by proposal id and survives upgrades.

### Backend & operator console

The vault registry/API exposes pending and executed proposals (with `eta` and approval
count) so the operator console can display them **read-only**. Editing parameters directly
from the console is out of scope for this issue.

### Events

`ProposalCreated`, `ProposalApproved`, `ProposalQueued`, `ProposalExecuted`,
`ProposalCancelled`, `ProposalExpired` — all consumable by the indexer.
## Voting weight reads TWAB (Issue #272)

Governance voting weight is read from the vault share token's time-weighted average
balance (TWAB) accumulator rather than an instantaneous share balance, closing the
last-block deposit/withdraw gaming vector. The wizard itself does not compute weight —
it only surfaces the proposer's threshold progress — but the `thresholdState` passed into
`ProposalWizard` is expected to be derived from TWAB-weighted stake.

### TWAB contract surface

The SEP-41 share token maintains a checkpointed cumulative-balance accumulator with
binary-searchable checkpoints and exposes:

- `balance_at(account, timestamp)` — the account's share balance at a ledger timestamp.
- `twab(account, start, end)` — the time-weighted average balance over `[start, end)`.

Checkpoints are written **only** on share mint, burn, and transfer, inside the same
authorization scope as the share mutation so a new entry point cannot bypass the
accumulator. Timestamps are ledger close times (never wall-clock) and are monotonic.

### Rounding and edge cases

- `twab` returns `0` for a zero-length window (`start >= end`) and for windows that
  precede the account's first checkpoint — no division by zero.
- A single checkpoint yields the balance held at that checkpoint across the window.
- First-deposit edge cases: the accumulator seeds at the deposit timestamp, so the
  pre-deposit interval contributes zero weight.
- Integer division truncates toward zero; TWAB is only ever used to *weight* value, never
  to mint it.

### Checkpoint retention / compaction policy

Checkpoint history is bounded to avoid unbounded Soroban storage rent and entry-size
growth. The retention window is coordinated with the storage-TTL work: checkpoints older
than the retention horizon are compacted into a single baseline checkpoint, and the
binary search operates over the retained, sorted checkpoint array with no unbounded
loops. Overflow bounds on the cumulative accumulator are documented alongside the
contract.

## Tests

```
npx jest src/lib/governance src/app/governance
```

219 tests: StrKey checksums, argument encoding, form generation, simulation diffs,
draft persistence, threshold/fee/submission, the Markdown parser, and RTL coverage of the
full four-step flow including the dangerous-action gate.
