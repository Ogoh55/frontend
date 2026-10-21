"use client";

/**
 * VaultOperatorCallPanel — operator-facing commitment and capital-call management.
 *
 * Displays:
 *   - All LP commitments for the vault (pending, active, defaulted, etc.)
 *   - Issue a new capital call against any active commitment
 *   - Mark a call as defaulted or waive the unfunded remainder
 *   - Create a new commitment for an LP
 *   - Capacity reservation summary
 */

import { useEffect, useState, useCallback } from "react";
import {
  getVaultCommitments,
  getCapitalCalls,
  createCommitment,
  issueCapitalCall,
  defaultCapitalCall,
  waiveCapitalCall,
  type CreateCommitmentRequest,
  type IssueCapitalCallRequest,
} from "../lib/api/vaultCommitments";
import {
  callStateLabel,
  callStateColor,
  commitmentStateLabel,
  commitmentStateColor,
  callRequiresAction,
  isCallPastDeadline,
  formatDuration,
  msUntilDeadline,
  totalReservedCapacity,
  totalContingentLiability,
  type VaultCommitment,
  type CapitalCall,
} from "../lib/vaultCommitments";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function truncAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
        color, border: `1px solid ${color}`, padding: "2px 7px",
      }}
    >
      {label}
    </span>
  );
}

function CommitmentRow({
  commitment,
  calls,
  nowMs,
  onIssueCall,
  onDefault,
  onWaive,
  issuingFor,
}: {
  commitment: VaultCommitment;
  calls: CapitalCall[];
  nowMs: number;
  onIssueCall: (commitmentId: string, amount: number, note: string) => void;
  onDefault: (callId: string) => void;
  onWaive: (callId: string, note: string) => void;
  issuingFor: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [callAmount, setCallAmount] = useState("");
  const [callNote, setCallNote] = useState("");
  const [waiveNote, setWaiveNote] = useState<Record<string, string>>({});
  const openCalls = calls.filter(c => callRequiresAction(c));
  const defaultableCalls = calls.filter(c => (c.state === "ISSUED" || c.state === "PARTIALLY_FUNDED") && isCallPastDeadline(c, nowMs));

  return (
    <div
      style={{
        border: "1px solid var(--border-default)",
        background: "var(--bg-overlay)",
        marginBottom: 6,
      }}
    >
      {/* Row header */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: "100%", padding: "10px 12px", background: "none", border: "none",
          display: "flex", alignItems: "center", gap: 10, cursor: "pointer", textAlign: "left",
        }}
        aria-expanded={expanded}
      >
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-mid)", minWidth: 130 }}>
          {truncAddr(commitment.lpWalletAddress)}
        </span>
        <span className="num" style={{ fontSize: 11, color: "var(--text-hi)", minWidth: 90 }}>
          ${fmtUsd(commitment.committedAmount)}
        </span>
        <span className="num" style={{ fontSize: 11, color: "var(--call)", minWidth: 90 }}>
          ${fmtUsd(commitment.remainingCallable)} left
        </span>
        <StatusBadge label={commitmentStateLabel(commitment.state)} color={commitmentStateColor(commitment.state)} />
        {defaultableCalls.length > 0 && (
          <StatusBadge label={`${defaultableCalls.length} overdue`} color="var(--put)" />
        )}
        {openCalls.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--atm)", marginLeft: "auto" }}>
            {openCalls.length} open call{openCalls.length !== 1 ? "s" : ""}
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--text-lo)", marginLeft: openCalls.length ? 0 : "auto" }}>
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "12px 14px" }}>
          {/* Commitment details */}
          <div style={{ display: "flex", gap: 20, marginBottom: 12, flexWrap: "wrap", fontSize: 11, color: "var(--text-mid)" }}>
            <span><span style={{ color: "var(--text-lo)" }}>ID: </span><span style={{ fontFamily: "var(--font-mono)" }}>{commitment.id}</span></span>
            <span><span style={{ color: "var(--text-lo)" }}>Expires: </span>{fmtDate(commitment.expiresAt)}</span>
            <span><span style={{ color: "var(--text-lo)" }}>Reserves capacity: </span>{commitment.reservesCapacity ? "Yes" : "No"}</span>
            {commitment.acknowledgedAt && <span><span style={{ color: "var(--text-lo)" }}>Acknowledged: </span>{fmtDate(commitment.acknowledgedAt)}</span>}
          </div>
          {commitment.notes && (
            <div style={{ marginBottom: 10, fontSize: 11, color: "var(--text-lo)" }}>{commitment.notes}</div>
          )}

          {/* Existing calls */}
          {calls.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", marginBottom: 6 }}>
                Capital Calls
              </div>
              {calls.map(call => {
                const pastDeadline = isCallPastDeadline(call, nowMs);
                const msl = msUntilDeadline(call, nowMs);
                return (
                  <div
                    key={call.id}
                    style={{
                      padding: "8px 10px", marginBottom: 4,
                      background: pastDeadline && callRequiresAction(call) ? "var(--put-dim)" : "var(--bg-raised)",
                      border: `1px solid ${pastDeadline && callRequiresAction(call) ? "var(--put)" : "var(--border-subtle)"}`,
                      display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-lo)" }}>{call.id}</span>
                    <span className="num" style={{ fontSize: 11 }}>${fmtUsd(call.callAmount)}</span>
                    <span className="num" style={{ fontSize: 11, color: "var(--call)" }}>
                      ${fmtUsd(call.fundedAmount)} funded
                    </span>
                    <StatusBadge label={callStateLabel(call.state)} color={callStateColor(call.state)} />
                    {callRequiresAction(call) && (
                      <span style={{ fontSize: 10, color: pastDeadline ? "var(--put)" : "var(--atm)" }}>
                        {formatDuration(msl)}
                      </span>
                    )}
                    {/* Default button */}
                    {(call.state === "ISSUED" || call.state === "PARTIALLY_FUNDED") && (
                      <button
                        onClick={() => onDefault(call.id)}
                        style={{
                          marginLeft: "auto", padding: "4px 10px", fontSize: 10, fontWeight: 700,
                          background: "var(--put-dim)", color: "var(--put)",
                          border: "1px solid var(--put)", cursor: "pointer",
                        }}
                      >
                        Mark Default
                      </button>
                    )}
                    {/* Waive button */}
                    {(call.state === "ISSUED" || call.state === "PARTIALLY_FUNDED" || call.state === "DEFAULTED") && (
                      <div style={{ display: "flex", gap: 4, alignItems: "center", marginLeft: call.state === "DEFAULTED" ? "auto" : 0 }}>
                        <input
                          value={waiveNote[call.id] ?? ""}
                          onChange={e => setWaiveNote(n => ({ ...n, [call.id]: e.target.value }))}
                          placeholder="Waiver note…"
                          style={{
                            padding: "4px 8px", fontSize: 10,
                            background: "var(--bg-overlay)", border: "1px solid var(--border-default)",
                            color: "var(--text-hi)", width: 120,
                          }}
                        />
                        <button
                          onClick={() => onWaive(call.id, waiveNote[call.id] ?? "")}
                          style={{
                            padding: "4px 10px", fontSize: 10, fontWeight: 700,
                            background: "var(--bg-elevated)", color: "var(--text-mid)",
                            border: "1px solid var(--border-default)", cursor: "pointer",
                          }}
                        >
                          Waive
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Issue new call */}
          {commitment.state === "ACTIVE" && commitment.remainingCallable > 0 && (
            <div style={{ marginTop: 8, padding: "10px 12px", background: "var(--bg-raised)", border: "1px solid var(--border-subtle)" }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", marginBottom: 8 }}>
                Issue Capital Call (max ${fmtUsd(commitment.remainingCallable)})
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  type="number"
                  min={0}
                  max={commitment.remainingCallable}
                  value={callAmount}
                  onChange={e => setCallAmount(e.target.value)}
                  placeholder="Amount (USD)"
                  aria-label="Capital call amount"
                  style={{
                    flex: 1, minWidth: 120, padding: "7px 10px",
                    background: "var(--bg-overlay)", border: "1px solid var(--border-default)",
                    color: "var(--text-hi)", fontFamily: "var(--font-mono)", fontSize: 12,
                  }}
                />
                <input
                  value={callNote}
                  onChange={e => setCallNote(e.target.value)}
                  placeholder="Note (optional)"
                  aria-label="Capital call note"
                  style={{
                    flex: 2, minWidth: 140, padding: "7px 10px",
                    background: "var(--bg-overlay)", border: "1px solid var(--border-default)",
                    color: "var(--text-hi)", fontSize: 12,
                  }}
                />
                <button
                  onClick={() => {
                    const v = parseFloat(callAmount);
                    if (!isNaN(v) && v > 0) {
                      onIssueCall(commitment.id, v, callNote);
                      setCallAmount("");
                      setCallNote("");
                    }
                  }}
                  disabled={issuingFor === commitment.id || !callAmount || isNaN(parseFloat(callAmount)) || parseFloat(callAmount) <= 0}
                  style={{
                    padding: "7px 16px", fontSize: 11, fontWeight: 700,
                    background: "var(--brand)", color: "var(--bg)", border: "none",
                    cursor: issuingFor === commitment.id ? "not-allowed" : "pointer",
                    opacity: issuingFor === commitment.id ? 0.6 : 1,
                    whiteSpace: "nowrap",
                  }}
                >
                  {issuingFor === commitment.id ? "Issuing…" : "Issue Call"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface VaultOperatorCallPanelProps {
  operatorAddress: string | null | undefined;
  token: string | null | undefined;
  vaultId: string;
  vaultCapacity: number;
  currentTvl: number;
}

export function VaultOperatorCallPanel({
  operatorAddress,
  token,
  vaultId,
  vaultCapacity,
  currentTvl,
}: VaultOperatorCallPanelProps) {
  const [commitments, setCommitments] = useState<VaultCommitment[]>([]);
  const [callsMap, setCallsMap] = useState<Record<string, CapitalCall[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuingFor, setIssuingFor] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [opSuccess, setOpSuccess] = useState<string | null>(null);
  const [nowMs] = useState(() => Date.now());

  // New commitment form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newLp, setNewLp] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newExpiry, setNewExpiry] = useState(() => {
    const d = new Date(Date.now() + 90 * 86400_000);
    return d.toISOString().split("T")[0];
  });
  const [newReserves, setNewReserves] = useState(true);
  const [newNotes, setNewNotes] = useState("");
  const [creatingCommitment, setCreatingCommitment] = useState(false);

  const loadData = useCallback(async () => {
    if (!operatorAddress) return;
    setLoading(true);
    setError(null);
    try {
      const cs = await getVaultCommitments(vaultId, { allForOperator: true, operatorAddress }, token);
      setCommitments(cs);
      const map: Record<string, CapitalCall[]> = {};
      await Promise.all(
        cs.map(async c => {
          map[c.id] = await getCapitalCalls(vaultId, c.id, token);
        }),
      );
      setCallsMap(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load commitments.");
    } finally {
      setLoading(false);
    }
  }, [operatorAddress, vaultId, token]);

  useEffect(() => { if (operatorAddress) loadData(); }, [operatorAddress, loadData]);

  const handleIssueCall = async (commitmentId: string, amount: number, note: string) => {
    if (!operatorAddress) return;
    setIssuingFor(commitmentId);
    setOpError(null);
    setOpSuccess(null);
    try {
      await issueCapitalCall(vaultId, commitmentId, { callAmount: amount, note } as IssueCapitalCallRequest, operatorAddress, token);
      setOpSuccess(`Capital call of $${fmtUsd(amount)} issued.`);
      await loadData();
    } catch (e) {
      setOpError(e instanceof Error ? e.message : "Failed to issue capital call.");
    } finally {
      setIssuingFor(null);
    }
  };

  const handleDefault = async (callId: string) => {
    if (!operatorAddress) return;
    setOpError(null);
    setOpSuccess(null);
    try {
      await defaultCapitalCall(vaultId, callId, operatorAddress, token);
      setOpSuccess("Call marked as defaulted.");
      await loadData();
    } catch (e) {
      setOpError(e instanceof Error ? e.message : "Failed to mark default.");
    }
  };

  const handleWaive = async (callId: string, note: string) => {
    if (!operatorAddress) return;
    setOpError(null);
    setOpSuccess(null);
    try {
      await waiveCapitalCall(vaultId, callId, note, operatorAddress, token);
      setOpSuccess("Call waived.");
      await loadData();
    } catch (e) {
      setOpError(e instanceof Error ? e.message : "Failed to waive call.");
    }
  };

  const handleCreateCommitment = async () => {
    if (!operatorAddress) return;
    const amount = parseFloat(newAmount);
    if (!newLp || isNaN(amount) || amount <= 0) return;
    setCreatingCommitment(true);
    setOpError(null);
    setOpSuccess(null);
    try {
      const req: CreateCommitmentRequest = {
        lpWalletAddress: newLp,
        committedAmount: amount,
        expiresAt: new Date(newExpiry + "T00:00:00Z").toISOString(),
        reservesCapacity: newReserves,
        notes: newNotes,
      };
      await createCommitment(vaultId, req, operatorAddress, token);
      setOpSuccess(`Commitment created for ${truncAddr(newLp)}.`);
      setShowNewForm(false);
      setNewLp(""); setNewAmount(""); setNewNotes("");
      await loadData();
    } catch (e) {
      setOpError(e instanceof Error ? e.message : "Failed to create commitment.");
    } finally {
      setCreatingCommitment(false);
    }
  };

  if (!operatorAddress) {
    return (
      <section
        aria-label="Operator Commitment Management"
        style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: "16px 18px" }}
      >
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 8 }}>
          Operator: Commitment Management
        </div>
        <div style={{ fontSize: 12, color: "var(--text-lo)" }}>Connect as vault operator to manage commitments.</div>
      </section>
    );
  }

  const reservedCapacity = totalReservedCapacity(commitments);
  const contingentLiability = totalContingentLiability(Object.values(callsMap).flat());
  const allCalls = Object.values(callsMap).flat();
  const overdueCalls = allCalls.filter(c => (c.state === "ISSUED" || c.state === "PARTIALLY_FUNDED") && isCallPastDeadline(c, nowMs));

  return (
    <section aria-label="Operator Commitment Management" style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
      {/* Header */}
      <div style={{ padding: "13px 18px 10px", borderBottom: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)" }}>
          Operator: Commitment Management
        </div>
        <button
          onClick={() => setShowNewForm(f => !f)}
          style={{
            padding: "4px 12px", fontSize: 10, fontWeight: 700,
            background: showNewForm ? "var(--bg-overlay)" : "var(--brand)",
            color: showNewForm ? "var(--text-mid)" : "var(--bg)",
            border: "none", cursor: "pointer",
          }}
        >
          {showNewForm ? "Cancel" : "+ New Commitment"}
        </button>
      </div>

      {/* Portfolio summary */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border-subtle)" }}>
        {[
          { label: "Commitments", value: String(commitments.length) },
          { label: "Reserved Capacity", value: `$${fmtUsd(reservedCapacity)}`, color: "var(--atm)" },
          { label: "Contingent Liability", value: `$${fmtUsd(contingentLiability)}`, color: contingentLiability > 0 ? "var(--atm)" : "var(--text-lo)" },
          { label: "Overdue Calls", value: String(overdueCalls.length), color: overdueCalls.length > 0 ? "var(--put)" : "var(--text-lo)" },
        ].map((s, i) => (
          <div key={s.label} style={{ flex: 1, padding: "9px 11px", borderLeft: i > 0 ? "1px solid var(--border-subtle)" : "none" }}>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", marginBottom: 3 }}>{s.label}</div>
            <div className="num" style={{ fontSize: 12, fontWeight: 600, color: s.color ?? "var(--text-hi)" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Feedback */}
      {opSuccess && (
        <div role="status" style={{ padding: "8px 18px", background: "var(--call-dim)", borderBottom: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--call)" }}>
          {opSuccess}
        </div>
      )}
      {opError && (
        <div role="alert" style={{ padding: "8px 18px", background: "var(--put-dim)", borderBottom: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--put)" }}>
          {opError}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "10px 18px", fontSize: 11, color: "var(--put)" }}>{error}</div>
      )}

      {/* New commitment form */}
      {showNewForm && (
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-overlay)" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", marginBottom: 10 }}>
            Create New Commitment
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--text-lo)", display: "block", marginBottom: 3 }}>LP Wallet Address</label>
              <input
                value={newLp}
                onChange={e => setNewLp(e.target.value)}
                placeholder="G…"
                style={{ width: "100%", padding: "7px 10px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 10, color: "var(--text-lo)", display: "block", marginBottom: 3 }}>Committed Amount (USD)</label>
                <input
                  type="number"
                  min={0}
                  value={newAmount}
                  onChange={e => setNewAmount(e.target.value)}
                  placeholder="e.g. 500000"
                  style={{ width: "100%", padding: "7px 10px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontFamily: "var(--font-mono)", fontSize: 12 }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 10, color: "var(--text-lo)", display: "block", marginBottom: 3 }}>Expiry Date</label>
                <input
                  type="date"
                  value={newExpiry}
                  onChange={e => setNewExpiry(e.target.value)}
                  style={{ width: "100%", padding: "7px 10px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontSize: 12 }}
                />
              </div>
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--text-lo)", display: "block", marginBottom: 3 }}>Notes</label>
              <input
                value={newNotes}
                onChange={e => setNewNotes(e.target.value)}
                placeholder="Optional notes for the LP"
                style={{ width: "100%", padding: "7px 10px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontSize: 12 }}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-mid)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={newReserves}
                onChange={e => setNewReserves(e.target.checked)}
              />
              Reserve vault capacity for this commitment
            </label>
            <button
              onClick={handleCreateCommitment}
              disabled={creatingCommitment || !newLp || !newAmount || isNaN(parseFloat(newAmount))}
              style={{
                alignSelf: "flex-start", padding: "8px 20px", fontSize: 12, fontWeight: 700,
                background: "var(--brand)", color: "var(--bg)", border: "none",
                cursor: creatingCommitment ? "not-allowed" : "pointer",
                opacity: creatingCommitment ? 0.6 : 1,
              }}
            >
              {creatingCommitment ? "Creating…" : "Create Commitment"}
            </button>
          </div>
        </div>
      )}

      {/* Commitments list */}
      {loading && commitments.length === 0 && (
        <div style={{ padding: "16px 18px" }}>
          <div className="skeleton" style={{ height: 44, width: "100%", marginBottom: 6 }} />
          <div className="skeleton" style={{ height: 44, width: "100%" }} />
        </div>
      )}

      {!loading && commitments.length === 0 && !error && (
        <div style={{ padding: "14px 18px", fontSize: 12, color: "var(--text-lo)" }}>
          No commitments for this vault yet. Use "New Commitment" to add one.
        </div>
      )}

      {commitments.length > 0 && (
        <div style={{ padding: "12px 14px" }}>
          {commitments.map(c => (
            <CommitmentRow
              key={c.id}
              commitment={c}
              calls={callsMap[c.id] ?? []}
              nowMs={nowMs}
              onIssueCall={handleIssueCall}
              onDefault={handleDefault}
              onWaive={handleWaive}
              issuingFor={issuingFor}
            />
          ))}
        </div>
      )}

      <div style={{ padding: "8px 18px", fontSize: 10, color: "var(--text-lo)", borderTop: "1px solid var(--border-subtle)" }}>
        NAV note: unfunded capital calls are contingent liabilities only and never affect share price.
      </div>
    </section>
  );
}
