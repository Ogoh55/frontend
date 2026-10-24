/**
 * vaultGovernance.ts — Issue #242
 *
 * Share-weighted depositor governance for vault strategy parameters.
 *
 * Mechanism
 * ---------
 * 1. An operator or depositor creates a `VaultProposal` targeting one or more
 *    economic parameters (strike band, target capacity, fee policy, etc.).
 * 2. At proposal creation a snapshot of share balances is taken so voting
 *    power is fixed and cannot be gamed by buying shares during the vote.
 * 3. Depositors vote FOR / AGAINST / ABSTAIN, weighted by their snapshotted
 *    share balance.
 * 4. If quorum is reached and FOR > AGAINST the proposal enters a configurable
 *    timelock delay, after which the operator can execute it on-chain through
 *    the existing governance pipeline (src/lib/governance/submit.ts).
 * 5. The operator retains veto power during the timelock (emergency override).
 *
 * This module owns:
 *   - Type definitions for proposals, votes, snapshots, tallies
 *   - Pure business-logic: `tallyVotes`, `computeQuorum`, `canExecute`
 *   - Mock store + async adapter functions for the UI
 *   - Integration glue back to the existing governance/actions catalog
 */

import type { AuditActionType } from "./vaultAudit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProposalStatus =
  | "pending"     // created, voting not yet open
  | "active"      // voting window is open
  | "defeated"    // voting closed; did not reach quorum or FOR <= AGAINST
  | "succeeded"   // voting closed; quorum met and FOR > AGAINST
  | "queued"      // in timelock
  | "executed"    // on-chain execution confirmed
  | "cancelled";  // operator cancelled before execution

export type VoteChoice = "for" | "against" | "abstain";

/** A governable parameter the proposal wants to change. */
export interface ProposedParameterChange {
  /** Key matching GOVERNABLE_CONTRACTS catalog (e.g. "vault"). */
  contractKey: string;
  /** On-chain function name (e.g. "set_withdrawal_fee_bps"). */
  functionName: string;
  /** Human label. */
  label: string;
  /** Current value (string for display). */
  currentValue: string;
  /** Proposed new value (string for display; encoded separately for on-chain). */
  proposedValue: string;
  unit?: string;
}

/** Snapshotted share balance for one depositor. */
export interface ShareSnapshot {
  vaultId: string;
  snapshotBlock: number; // Stellar ledger sequence at snapshot time
  snapshotAt: string;    // ISO
  depositor: string;     // G-address
  shares: bigint;        // raw share units
}

/** One depositor's recorded vote. */
export interface VaultVote {
  proposalId: string;
  voter: string;      // G-address
  choice: VoteChoice;
  /** Voting power used (= snapshotted share balance at proposal creation). */
  votingPower: bigint;
  castAt: string;     // ISO
  /** Optional on-chain tx hash if vote was registered on-chain. */
  txHash?: string;
}

/** The live vote tally. */
export interface VoteTally {
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  totalVotingPower: bigint;  // sum of all snapshotted shares
  participationPct: number;  // (for+against+abstain) / total, 0–1
  quorumReached: boolean;
  /** True when FOR > AGAINST and quorum is met. */
  passing: boolean;
}

/** A vault governance proposal. */
export interface VaultProposal {
  id: string;
  vaultId: string;
  title: string;
  summary: string;
  /** Markdown body. */
  body: string;
  discussionUrl: string;
  /** G-address of the proposer. */
  proposer: string;
  status: ProposalStatus;
  /** ISO — when the voting window opens. */
  voteStart: string;
  /** ISO — when the voting window closes. */
  voteEnd: string;
  /** ISO — earliest on-chain execution date (voteEnd + timelockSeconds). */
  executableAfter: string;
  /** Seconds of timelock delay after a successful vote. */
  timelockSeconds: number;
  changes: ProposedParameterChange[];
  /** Ledger sequence at which share balances were snapshotted. */
  snapshotBlock: number;
  createdAt: string;
  updatedAt: string;
  /** Associated audit trail action type. */
  auditAction?: AuditActionType;
}

/** Governance configuration for a vault. */
export interface VaultGovernanceConfig {
  vaultId: string;
  /** Minimum quorum as a fraction of total shares (e.g. 0.1 = 10%). */
  quorumPct: number;
  /** Voting window duration in seconds. */
  votingPeriodSeconds: number;
  /** Timelock delay in seconds after a successful vote. */
  timelockSeconds: number;
  /** Minimum shares required to create a proposal (anti-spam). */
  proposalThresholdShares: bigint;
}

// ---------------------------------------------------------------------------
// Pure business logic
// ---------------------------------------------------------------------------

/**
 * Compute the running vote tally from a list of votes and the total
 * snapshotted voting power.
 */
export function tallyVotes(votes: VaultVote[], totalVotingPower: bigint): VoteTally {
  let forVotes     = 0n;
  let againstVotes = 0n;
  let abstainVotes = 0n;

  for (const v of votes) {
    if (v.choice === "for")     forVotes     += v.votingPower;
    if (v.choice === "against") againstVotes += v.votingPower;
    if (v.choice === "abstain") abstainVotes += v.votingPower;
  }

  const participated = forVotes + againstVotes + abstainVotes;
  const participationPct = totalVotingPower > 0n
    ? Number(participated) / Number(totalVotingPower)
    : 0;

  return {
    forVotes, againstVotes, abstainVotes,
    totalVotingPower,
    participationPct,
    quorumReached: false, // filled by computeQuorum
    passing: false,       // filled by computeQuorum
  };
}

/** Enrich a tally with quorum and passing state from the vault config. */
export function computeQuorum(tally: VoteTally, config: VaultGovernanceConfig): VoteTally {
  const quorumReached = tally.participationPct >= config.quorumPct;
  const passing       = quorumReached && tally.forVotes > tally.againstVotes;
  return { ...tally, quorumReached, passing };
}

/** True when a proposal can be submitted to the on-chain timelock. */
export function canExecute(proposal: VaultProposal): boolean {
  if (proposal.status !== "queued") return false;
  return new Date() >= new Date(proposal.executableAfter);
}

/** True when a depositor has already voted on this proposal. */
export function hasVoted(votes: VaultVote[], voter: string): boolean {
  return votes.some(v => v.voter === voter);
}

/** Voter's snapshotted power on a proposal (0n if not a depositor). */
export function voterPower(snapshot: ShareSnapshot[], voter: string): bigint {
  return snapshot.find(s => s.depositor === voter)?.shares ?? 0n;
}

// ---------------------------------------------------------------------------
// Mock store
// ---------------------------------------------------------------------------

const MOCK_CONFIG: Record<string, VaultGovernanceConfig> = {
  "xlm-cc-v1": {
    vaultId: "xlm-cc-v1",
    quorumPct: 0.10,
    votingPeriodSeconds: 3 * 24 * 3600,  // 3 days
    timelockSeconds:     2 * 24 * 3600,  // 2 days
    proposalThresholdShares: 1_000n,
  },
  "btc-csp-v1": {
    vaultId: "btc-csp-v1",
    quorumPct: 0.10,
    votingPeriodSeconds: 3 * 24 * 3600,
    timelockSeconds:     2 * 24 * 3600,
    proposalThresholdShares: 500n,
  },
};

function defaultConfig(vaultId: string): VaultGovernanceConfig {
  return {
    vaultId,
    quorumPct: 0.10,
    votingPeriodSeconds: 3 * 24 * 3600,
    timelockSeconds:     2 * 24 * 3600,
    proposalThresholdShares: 1_000n,
  };
}

// Proposals keyed by vaultId.
const MOCK_PROPOSALS: Map<string, VaultProposal[]> = new Map();

// Votes keyed by proposalId.
const MOCK_VOTES: Map<string, VaultVote[]> = new Map();

// Snapshots keyed by proposalId.
const MOCK_SNAPSHOTS: Map<string, ShareSnapshot[]> = new Map();

function ensureProposals(vaultId: string): VaultProposal[] {
  if (!MOCK_PROPOSALS.has(vaultId)) {
    const now = Date.now();
    const seeds: VaultProposal[] = [
      {
        id: `${vaultId}-prop-001`,
        vaultId,
        title: "Tighten strike-selection band from ±15% to ±10% OTM",
        summary: "Reduce maximum strike distance from 15% out-of-the-money to 10% to lower assignment risk and improve premium consistency.",
        body: "## Motivation\nRecent epoch volatility has caused the vault to write calls and puts at the outer edge of the allowed band, increasing assignment frequency. Tightening the band to ±10% produces higher-probability-of-expiry positions.\n\n## Risk\nLower premium per epoch; higher likelihood of profit. Reduces upside capture in trending markets.",
        discussionUrl: "https://forum.example.com/t/strike-band-proposal",
        proposer: "GCEXAMPLEDEPOSITOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        status: "active",
        voteStart: new Date(now - 24 * 3600 * 1000).toISOString(),
        voteEnd:   new Date(now + 48 * 3600 * 1000).toISOString(),
        executableAfter: new Date(now + 48 * 3600 * 1000 + 2 * 24 * 3600 * 1000).toISOString(),
        timelockSeconds: 2 * 24 * 3600,
        snapshotBlock: 52_100_000,
        changes: [
          { contractKey: "vault", functionName: "set_strike_band_bps", label: "Strike band", currentValue: "1500", proposedValue: "1000", unit: "bps" },
        ],
        createdAt: new Date(now - 25 * 3600 * 1000).toISOString(),
        updatedAt: new Date(now - 24 * 3600 * 1000).toISOString(),
        auditAction: "parameter_change",
      },
      {
        id: `${vaultId}-prop-002`,
        vaultId,
        title: "Increase vault capacity from $500K to $1M",
        summary: "Stage TVL cap increase following Epoch 46 risk review showing healthy utilisation.",
        body: "## Motivation\nThe vault has operated at >90% capacity for five consecutive epochs with no incidents. Increasing capacity allows more depositors to participate.\n\n## Risk\nHigher TVL requires proportionally larger position sizes; liquidity in the options market may need monitoring.",
        discussionUrl: "https://forum.example.com/t/capacity-increase",
        proposer: "GCEXAMPLEDEPOSITOR2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        status: "succeeded",
        voteStart: new Date(now - 10 * 24 * 3600 * 1000).toISOString(),
        voteEnd:   new Date(now -  7 * 24 * 3600 * 1000).toISOString(),
        executableAfter: new Date(now - 5 * 24 * 3600 * 1000).toISOString(),
        timelockSeconds: 2 * 24 * 3600,
        snapshotBlock: 52_000_000,
        changes: [
          { contractKey: "vault", functionName: "set_capacity_usd", label: "Target capacity", currentValue: "500000", proposedValue: "1000000", unit: "USD" },
        ],
        createdAt: new Date(now - 11 * 24 * 3600 * 1000).toISOString(),
        updatedAt: new Date(now -  7 * 24 * 3600 * 1000).toISOString(),
        auditAction: "capacity_change",
      },
    ];
    MOCK_PROPOSALS.set(vaultId, seeds);

    // Seed votes for the active proposal.
    const activeId = seeds[0].id;
    MOCK_VOTES.set(activeId, [
      { proposalId: activeId, voter: "GCVOTER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", choice: "for",     votingPower: 12_500n, castAt: new Date(now - 20 * 3600 * 1000).toISOString() },
      { proposalId: activeId, voter: "GCVOTER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", choice: "for",     votingPower:  8_200n, castAt: new Date(now - 18 * 3600 * 1000).toISOString() },
      { proposalId: activeId, voter: "GCVOTER3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", choice: "against", votingPower:  5_100n, castAt: new Date(now - 12 * 3600 * 1000).toISOString() },
      { proposalId: activeId, voter: "GCVOTER4DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", choice: "abstain", votingPower:  2_000n, castAt: new Date(now -  6 * 3600 * 1000).toISOString() },
    ]);
    MOCK_SNAPSHOTS.set(activeId, [
      { vaultId, snapshotBlock: 52_100_000, snapshotAt: seeds[0].voteStart, depositor: "GCVOTER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", shares: 12_500n },
      { vaultId, snapshotBlock: 52_100_000, snapshotAt: seeds[0].voteStart, depositor: "GCVOTER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", shares:  8_200n },
      { vaultId, snapshotBlock: 52_100_000, snapshotAt: seeds[0].voteStart, depositor: "GCVOTER3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", shares:  5_100n },
      { vaultId, snapshotBlock: 52_100_000, snapshotAt: seeds[0].voteStart, depositor: "GCVOTER4DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", shares:  2_000n },
      { vaultId, snapshotBlock: 52_100_000, snapshotAt: seeds[0].voteStart, depositor: "GCEXAMPLEDEPOSITOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",  shares:    950n },
    ]);

    // Votes for the succeeded proposal.
    const succeededId = seeds[1].id;
    MOCK_VOTES.set(succeededId, [
      { proposalId: succeededId, voter: "GCVOTER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", choice: "for", votingPower: 12_500n, castAt: new Date(now - 9 * 24 * 3600 * 1000).toISOString() },
      { proposalId: succeededId, voter: "GCVOTER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", choice: "for", votingPower:  8_200n, castAt: new Date(now - 9 * 24 * 3600 * 1000).toISOString() },
      { proposalId: succeededId, voter: "GCVOTER3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", choice: "for", votingPower:  5_100n, castAt: new Date(now - 8 * 24 * 3600 * 1000).toISOString() },
    ]);
  }
  return MOCK_PROPOSALS.get(vaultId)!;
}

// ---------------------------------------------------------------------------
// Async adapters
// ---------------------------------------------------------------------------

export async function fetchVaultGovernanceConfig(vaultId: string): Promise<VaultGovernanceConfig> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vaults/${vaultId}/governance/config`);
    if (!res.ok) throw new Error(`Failed to fetch governance config (${res.status})`);
    return res.json() as Promise<VaultGovernanceConfig>;
  }
  return Promise.resolve(MOCK_CONFIG[vaultId] ?? defaultConfig(vaultId));
}

export async function fetchVaultProposals(vaultId: string): Promise<VaultProposal[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vaults/${vaultId}/governance/proposals`);
    if (!res.ok) throw new Error(`Failed to fetch proposals (${res.status})`);
    return res.json() as Promise<VaultProposal[]>;
  }
  return Promise.resolve([...ensureProposals(vaultId)].reverse());
}

export async function fetchProposalVotes(proposalId: string): Promise<VaultVote[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vault-proposals/${proposalId}/votes`);
    if (!res.ok) throw new Error(`Failed to fetch votes (${res.status})`);
    return res.json() as Promise<VaultVote[]>;
  }
  return Promise.resolve([...(MOCK_VOTES.get(proposalId) ?? [])]);
}

export async function fetchProposalSnapshot(proposalId: string): Promise<ShareSnapshot[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vault-proposals/${proposalId}/snapshot`);
    if (!res.ok) throw new Error(`Failed to fetch snapshot (${res.status})`);
    return res.json() as Promise<ShareSnapshot[]>;
  }
  return Promise.resolve([...(MOCK_SNAPSHOTS.get(proposalId) ?? [])]);
}

export async function castVote(
  proposalId: string,
  voter: string,
  choice: VoteChoice,
  _token: string
): Promise<VaultVote> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vault-proposals/${proposalId}/votes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voter, choice }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `Vote failed (${res.status})`);
    }
    return res.json() as Promise<VaultVote>;
  }

  // Mock: check snapshot for voting power.
  const votes   = MOCK_VOTES.get(proposalId) ?? [];
  const snapArr = MOCK_SNAPSHOTS.get(proposalId) ?? [];

  if (votes.some(v => v.voter === voter)) {
    throw new Error("You have already voted on this proposal.");
  }

  const power = snapArr.find(s => s.depositor === voter)?.shares ?? 0n;
  if (power === 0n) {
    throw new Error("You had no shares at the snapshot block and cannot vote on this proposal.");
  }

  const vote: VaultVote = {
    proposalId,
    voter,
    choice,
    votingPower: power,
    castAt: new Date().toISOString(),
    txHash: `mock-tx-vote-${proposalId}-${voter.slice(0, 8)}-${Date.now()}`,
  };

  const updated = [...votes, vote];
  MOCK_VOTES.set(proposalId, updated);
  return vote;
}

export async function createVaultProposal(
  input: Omit<VaultProposal, "id" | "status" | "createdAt" | "updatedAt" | "snapshotBlock" | "voteStart" | "voteEnd" | "executableAfter">,
  _token: string
): Promise<VaultProposal> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vaults/${input.vaultId}/governance/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `Create proposal failed (${res.status})`);
    }
    return res.json() as Promise<VaultProposal>;
  }

  const cfg = MOCK_CONFIG[input.vaultId] ?? defaultConfig(input.vaultId);
  const now = Date.now();
  const voteStart      = new Date(now + 300_000).toISOString();  // 5 min delay
  const voteEnd        = new Date(now + 300_000 + cfg.votingPeriodSeconds * 1000).toISOString();
  const executableAfter = new Date(now + 300_000 + cfg.votingPeriodSeconds * 1000 + cfg.timelockSeconds * 1000).toISOString();

  const proposal: VaultProposal = {
    ...input,
    id: `${input.vaultId}-prop-${Date.now()}`,
    status: "pending",
    snapshotBlock: 52_100_000 + Math.floor(Math.random() * 10_000),
    voteStart, voteEnd, executableAfter,
    timelockSeconds: cfg.timelockSeconds,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const existing = ensureProposals(input.vaultId);
  existing.unshift(proposal);
  MOCK_VOTES.set(proposal.id, []);
  return proposal;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<ProposalStatus, string> = {
  pending:   "Pending",
  active:    "Active",
  defeated:  "Defeated",
  succeeded: "Succeeded",
  queued:    "In Timelock",
  executed:  "Executed",
  cancelled: "Cancelled",
};

export const STATUS_COLOR: Record<ProposalStatus, string> = {
  pending:   "var(--text-lo)",
  active:    "var(--brand)",
  defeated:  "var(--put)",
  succeeded: "var(--call)",
  queued:    "var(--atm)",
  executed:  "var(--call)",
  cancelled: "var(--text-lo)",
};

export const VOTE_COLOR: Record<VoteChoice, string> = {
  for:     "var(--call)",
  against: "var(--put)",
  abstain: "var(--text-lo)",
};
