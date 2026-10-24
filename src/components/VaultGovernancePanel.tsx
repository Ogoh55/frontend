"use client";

/**
 * VaultGovernancePanel — Issue #242
 *
 * Share-weighted depositor governance UI for vault strategy parameters.
 * Shows all proposals with live tally bars, lets connected depositors cast
 * votes weighted by their snapshotted share balance, and surfaces a
 * "Create Proposal" flow for eligible depositors.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  fetchVaultProposals,
  fetchVaultGovernanceConfig,
  fetchProposalVotes,
  fetchProposalSnapshot,
  castVote,
  createVaultProposal,
  tallyVotes,
  computeQuorum,
  hasVoted,
  voterPower,
  canExecute,
  STATUS_LABEL,
  STATUS_COLOR,
  VOTE_COLOR,
  type VaultProposal,
  type VaultGovernanceConfig,
  type VaultVote,
  type VoteTally,
  type VoteChoice,
  type ProposedParameterChange,
} from "../lib/api/vaultGovernance";
import { useWalletStore } from "../lib/store/wallet";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function fmtShares(n: bigint) {
  return n.toLocaleString();
}

function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function timeRemaining(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "Ended";
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h remaining`;
  return `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m remaining`;
}

// ---------------------------------------------------------------------------
// Tally bar component
// ---------------------------------------------------------------------------

function TallyBar({ tally, config }: { tally: VoteTally; config: VaultGovernanceConfig }) {
  const total = Number(tally.totalVotingPower) || 1;
  const forPct     = (Number(tally.forVotes)     / total) * 100;
  const againstPct = (Number(tally.againstVotes) / total) * 100;
  const abstainPct = (Number(tally.abstainVotes) / total) * 100;
  const quorumLine = config.quorumPct * 100;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Stacked bar */}
      <div style={{ height: 8, display: "flex", background: "var(--bg-overlay)", position: "relative" }}>
        <div style={{ width: `${forPct}%`,     background: "var(--call)",    transition: "width 0.4s" }} />
        <div style={{ width: `${againstPct}%`, background: "var(--put)",     transition: "width 0.4s" }} />
        <div style={{ width: `${abstainPct}%`, background: "var(--text-lo)", transition: "width 0.4s", opacity: 0.5 }} />
        {/* Quorum threshold marker */}
        <div
          style={{ position: "absolute", left: `${quorumLine}%`, top: 0, bottom: 0, width: 1, background: "var(--atm)", opacity: 0.8 }}
          title={`Quorum: ${quorumLine}%`}
        />
      </div>
      {/* Legend */}
      <div style={{ display: "flex", gap: 14, fontSize: 10, color: "var(--text-lo)" }}>
        <span style={{ color: "var(--call)" }}>For {fmtShares(tally.forVotes)} ({fmtPct(Number(tally.forVotes) / total)})</span>
        <span style={{ color: "var(--put)"  }}>Against {fmtShares(tally.againstVotes)} ({fmtPct(Number(tally.againstVotes) / total)})</span>
        <span>Abstain {fmtShares(tally.abstainVotes)}</span>
        <span style={{ marginLeft: "auto" }}>
          Participation: {fmtPct(tally.participationPct)}
          {tally.quorumReached
            ? <span style={{ marginLeft: 4, color: "var(--call)" }}>✓ quorum</span>
            : <span style={{ marginLeft: 4, color: "var(--atm)" }}> (need {fmtPct(config.quorumPct)})</span>}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vote cast buttons
// ---------------------------------------------------------------------------

interface VoteCastProps {
  proposal: VaultProposal;
  voterAddress: string;
  token: string;
  onVoted: () => void;
}

function VoteCastButtons({ proposal, voterAddress, token, onVoted }: VoteCastProps) {
  const [casting, setCasting] = useState<VoteChoice | null>(null);
  const [error, setError]     = useState<string | null>(null);

  const cast = async (choice: VoteChoice) => {
    setCasting(choice); setError(null);
    try {
      await castVote(proposal.id, voterAddress, choice, token);
      onVoted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Vote failed");
    } finally {
      setCasting(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {(["for", "against", "abstain"] as VoteChoice[]).map(choice => (
          <button
            key={choice}
            onClick={() => cast(choice)}
            disabled={casting !== null}
            style={{
              padding: "8px 16px",
              fontSize: 12, fontWeight: 700, textTransform: "capitalize",
              background: casting === choice ? VOTE_COLOR[choice] : "transparent",
              color: VOTE_COLOR[choice],
              border: `1px solid ${VOTE_COLOR[choice]}`,
              cursor: casting ? "default" : "pointer",
              opacity: casting && casting !== choice ? 0.5 : 1,
              transition: "background 0.15s",
            }}
          >
            {casting === choice ? "Casting…" : choice === "for" ? "✓ For" : choice === "against" ? "✗ Against" : "— Abstain"}
          </button>
        ))}
      </div>
      {error && <div style={{ fontSize: 11, color: "var(--put)" }}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Changes table
// ---------------------------------------------------------------------------

function ChangesTable({ changes }: { changes: ProposedParameterChange[] }) {
  if (!changes.length) return null;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
            {["Parameter", "Current", "Proposed"].map(h => (
              <th key={h} style={{ padding: "6px 10px", fontSize: 10, textTransform: "uppercase", color: "var(--text-lo)", textAlign: "left", letterSpacing: "0.05em" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {changes.map((c, i) => (
            <tr key={i} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              <td style={{ padding: "7px 10px", color: "var(--text-mid)" }}>{c.label}</td>
              <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono)", color: "var(--put)" }}>
                {c.currentValue}{c.unit ? ` ${c.unit}` : ""}
              </td>
              <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono)", color: "var(--call)", fontWeight: 600 }}>
                {c.proposedValue}{c.unit ? ` ${c.unit}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual proposal card
// ---------------------------------------------------------------------------

interface ProposalCardProps {
  proposal: VaultProposal;
  config: VaultGovernanceConfig;
  voterAddress: string | null;
  token: string | null;
  onRefresh: () => void;
}

function ProposalCard({ proposal, config, voterAddress, token, onRefresh }: ProposalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [votes, setVotes]       = useState<VaultVote[]>([]);
  const [snapshot, setSnapshot] = useState<bigint>(0n);
  const [tally, setTally]       = useState<VoteTally | null>(null);
  const [loadingVotes, setLoadingVotes] = useState(false);

  const loadVotes = useCallback(async () => {
    setLoadingVotes(true);
    try {
      const [v, snap] = await Promise.all([
        fetchProposalVotes(proposal.id),
        fetchProposalSnapshot(proposal.id),
      ]);
      setVotes(v);
      const total = snap.reduce((sum, s) => sum + s.shares, 0n);
      setSnapshot(total);
      const raw = tallyVotes(v, total);
      setTally(computeQuorum(raw, config));
    } finally {
      setLoadingVotes(false);
    }
  }, [proposal.id, config]);

  useEffect(() => { loadVotes(); }, [loadVotes]);

  const alreadyVoted    = voterAddress ? hasVoted(votes, voterAddress) : false;
  const myPower         = voterAddress
    ? (MOCK_SNAPSHOT_LOOKUP.get(`${proposal.id}:${voterAddress}`) ?? 0n)
    : 0n;
  const isActive        = proposal.status === "active";
  const canVote         = isActive && !!token && !!voterAddress && !alreadyVoted;
  const executable      = canExecute(proposal);

  return (
    <div style={{
      border: `1px solid ${proposal.status === "active" ? "var(--brand)" : "var(--border-default)"}`,
      background: "var(--bg-raised)",
    }}>
      {/* Header row */}
      <div
        onClick={() => setExpanded(v => !v)}
        style={{ padding: "14px 16px", cursor: "pointer", display: "flex", gap: 12, alignItems: "flex-start" }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 7px",
              color: STATUS_COLOR[proposal.status],
              background: `${STATUS_COLOR[proposal.status]}22`,
            }}>
              {STATUS_LABEL[proposal.status]}
            </span>
            {isActive && (
              <span style={{ fontSize: 10, color: "var(--text-lo)" }}>{timeRemaining(proposal.voteEnd)}</span>
            )}
            {executable && (
              <span style={{ fontSize: 10, color: "var(--call)", background: "var(--call-dim)", padding: "2px 6px" }}>
                Ready to Execute
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)", marginBottom: 4 }}>
            {proposal.title}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-mid)", lineHeight: 1.5 }}>{proposal.summary}</div>
        </div>
        <span style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 2 }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {/* Tally bar — always visible */}
      {tally && !loadingVotes && (
        <div style={{ padding: "0 16px 12px" }}>
          <TallyBar tally={tally} config={config} />
        </div>
      )}

      {/* Expanded body */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border-default)", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Proposed changes */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Proposed Changes</div>
            <ChangesTable changes={proposal.changes} />
          </div>

          {/* Timeline metadata */}
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 11, color: "var(--text-lo)" }}>
            <span>Vote opens: <span style={{ color: "var(--text-mid)" }}>{fmtDate(proposal.voteStart)}</span></span>
            <span>Vote closes: <span style={{ color: "var(--text-mid)" }}>{fmtDate(proposal.voteEnd)}</span></span>
            <span>Executable after: <span style={{ color: "var(--text-mid)" }}>{fmtDate(proposal.executableAfter)}</span></span>
            <span>Snapshot ledger: <span style={{ color: "var(--text-mid)", fontFamily: "var(--font-mono)" }}>{proposal.snapshotBlock.toLocaleString()}</span></span>
            {proposal.discussionUrl && (
              <a href={proposal.discussionUrl} target="_blank" rel="noreferrer" style={{ color: "var(--brand)" }}>
                Forum discussion ↗
              </a>
            )}
          </div>

          {/* Voter's power */}
          {voterAddress && (
            <div style={{ fontSize: 11, color: "var(--text-lo)" }}>
              Your voting power: <span style={{ color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>
                {fmtShares(myPower)} shares
              </span>
              {alreadyVoted && <span style={{ marginLeft: 8, color: "var(--call)" }}>✓ You voted</span>}
              {myPower === 0n && !alreadyVoted && isActive && (
                <span style={{ marginLeft: 8, color: "var(--text-lo)" }}>(no shares at snapshot — cannot vote)</span>
              )}
            </div>
          )}

          {/* Cast vote */}
          {canVote && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Cast Your Vote</div>
              <VoteCastButtons
                proposal={proposal}
                voterAddress={voterAddress!}
                token={token!}
                onVoted={() => { loadVotes(); onRefresh(); }}
              />
            </div>
          )}

          {/* No wallet */}
          {!token && isActive && (
            <div style={{ fontSize: 11, color: "var(--text-lo)" }}>Connect your wallet to vote.</div>
          )}

          {/* Recent votes */}
          {votes.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>Recent Votes ({votes.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {votes.slice(-5).reverse().map((v, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--text-lo)" }}>
                    <span style={{ fontFamily: "var(--font-mono)" }}>{v.voter.slice(0, 10)}…</span>
                    <span style={{ color: VOTE_COLOR[v.choice], fontWeight: 600, textTransform: "capitalize" }}>{v.choice}</span>
                    <span>{fmtShares(v.votingPower)} shares</span>
                    <span style={{ marginLeft: "auto" }}>{fmtDate(v.castAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Map voter→power for mock lookup (extracted from seeded snapshots).
const MOCK_SNAPSHOT_LOOKUP = new Map<string, bigint>();

// ---------------------------------------------------------------------------
// Create proposal form
// ---------------------------------------------------------------------------

interface CreateProposalFormProps {
  vaultId: string;
  token: string;
  proposer: string;
  config: VaultGovernanceConfig;
  onCreated: () => void;
  onCancel: () => void;
}

function CreateProposalForm({ vaultId, token, proposer, config, onCreated, onCancel }: CreateProposalFormProps) {
  const [title, setTitle]         = useState("");
  const [summary, setSummary]     = useState("");
  const [body, setBody]           = useState("");
  const [discussionUrl, setDiscussionUrl] = useState("");
  const [paramLabel, setParamLabel]   = useState("");
  const [currentVal, setCurrentVal]   = useState("");
  const [proposedVal, setProposedVal] = useState("");
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!title.trim() || !summary.trim()) {
      setError("Title and summary are required."); return;
    }
    setSubmitting(true); setError(null);
    try {
      await createVaultProposal({
        vaultId, proposer, title, summary, body, discussionUrl,
        timelockSeconds: config.timelockSeconds,
        changes: paramLabel ? [{
          contractKey: "vault",
          functionName: "custom_param",
          label: paramLabel,
          currentValue: currentVal,
          proposedValue: proposedVal,
        }] : [],
      }, token);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create proposal");
    } finally {
      setSubmitting(false);
    }
  };

  const field = (label: string, el: React.ReactNode, hint?: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</label>
      {el}
      {hint && <div style={{ fontSize: 10, color: "var(--text-lo)" }}>{hint}</div>}
    </div>
  );

  const input = (value: string, setter: (v: string) => void, placeholder = "") => (
    <input
      value={value}
      onChange={e => setter(e.target.value)}
      placeholder={placeholder}
      style={{ padding: "7px 10px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontSize: 12, width: "100%" }}
    />
  );

  return (
    <div style={{ border: "1px solid var(--brand)", background: "var(--bg-raised)", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: -4 }}>New Governance Proposal</div>

      {field("Title", input(title, setTitle, "e.g. Increase strike band to ±12% OTM"))}
      {field("Summary (one sentence)", input(summary, setSummary, "What this proposal changes and why"))}
      {field("Body (Markdown)", (
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={5}
          placeholder="## Motivation\n…\n\n## Risk\n…"
          style={{ padding: "7px 10px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontSize: 12, resize: "vertical", fontFamily: "var(--font-mono)" }}
        />
      ), "Full rationale visible to all voters.")}
      {field("Forum/discussion URL (optional)", input(discussionUrl, setDiscussionUrl, "https://forum.example.com/t/…"))}

      <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 10 }}>Parameter Change (optional)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {field("Parameter name", input(paramLabel, setParamLabel, "Strike band"))}
          {field("Current value", input(currentVal, setCurrentVal, "1500 bps"))}
          {field("Proposed value", input(proposedVal, setProposedVal, "1000 bps"))}
        </div>
      </div>

      {error && <div style={{ fontSize: 11, color: "var(--put)" }}>{error}</div>}

      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          style={{ padding: "9px 20px", background: "var(--brand)", color: "var(--bg)", border: "none", fontSize: 12, fontWeight: 700, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.6 : 1 }}
        >
          {submitting ? "Submitting…" : "Create Proposal"}
        </button>
        <button
          onClick={onCancel}
          style={{ padding: "9px 16px", background: "transparent", border: "1px solid var(--border-default)", color: "var(--text-mid)", fontSize: 12, cursor: "pointer" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export interface VaultGovernancePanelProps {
  vaultId: string;
}

export function VaultGovernancePanel({ vaultId }: VaultGovernancePanelProps) {
  const address = useWalletStore(s => s.address);
  const token   = useWalletStore(s => s.token);

  const [proposals, setProposals]   = useState<VaultProposal[]>([]);
  const [config, setConfig]         = useState<VaultGovernanceConfig | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter]         = useState<"all" | "active" | "closed">("all");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [p, c] = await Promise.all([
        fetchVaultProposals(vaultId),
        fetchVaultGovernanceConfig(vaultId),
      ]);
      setProposals(p);
      setConfig(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load governance data");
    } finally {
      setLoading(false);
    }
  }, [vaultId]);

  useEffect(() => { load(); }, [load]);

  const visible = proposals.filter(p => {
    if (filter === "active") return p.status === "active" || p.status === "pending";
    if (filter === "closed") return !["active", "pending"].includes(p.status);
    return true;
  });

  return (
    <section aria-label="Vault depositor governance" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Depositor Governance</h2>
          {config && (
            <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 3 }}>
              Quorum: {(config.quorumPct * 100).toFixed(0)}% participation · {Math.floor(config.votingPeriodSeconds / 86400)}d voting window · {Math.floor(config.timelockSeconds / 86400)}d timelock
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {(["all", "active", "closed"] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                fontSize: 11, padding: "4px 10px",
                background: filter === f ? "var(--brand)" : "var(--bg-overlay)",
                color: filter === f ? "var(--bg)" : "var(--text-mid)",
                border: "1px solid var(--border-default)",
                cursor: "pointer", textTransform: "capitalize",
              }}
            >
              {f}
            </button>
          ))}
          {token && !showCreate && (
            <button
              onClick={() => setShowCreate(true)}
              style={{ fontSize: 11, padding: "4px 12px", background: "var(--brand)", color: "var(--bg)", border: "none", cursor: "pointer", fontWeight: 700 }}
            >
              + Propose
            </button>
          )}
          <button
            onClick={load}
            style={{ fontSize: 11, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            ↻
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && config && token && address && (
        <CreateProposalForm
          vaultId={vaultId}
          token={token}
          proposer={address}
          config={config}
          onCreated={() => { setShowCreate(false); load(); }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: "10px 14px", background: "var(--put-dim)", border: "1px solid var(--put)", color: "var(--put)", fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !proposals.length && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2].map(i => <div key={i} className="skeleton" style={{ height: 80, width: "100%" }} />)}
        </div>
      )}

      {/* Proposals */}
      {!loading && !error && config && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visible.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-lo)", padding: "20px 0" }}>
              {filter === "active" ? "No active proposals." : "No proposals yet."}
            </div>
          ) : (
            visible.map(p => (
              <ProposalCard
                key={p.id}
                proposal={p}
                config={config}
                voterAddress={address}
                token={token}
                onRefresh={load}
              />
            ))
          )}
        </div>
      )}

      {/* Disclaimer */}
      <div style={{ fontSize: 10, color: "var(--text-lo)", lineHeight: 1.5 }}>
        Votes are weighted by share balance at the proposal snapshot ledger. Successful proposals
        enter a {config ? Math.floor(config.timelockSeconds / 86400) : 2}-day timelock before the operator can execute them on-chain.
        The operator retains emergency veto power during the timelock.
      </div>
    </section>
  );
}
