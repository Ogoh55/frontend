"use client";

/**
 * VaultCommitmentsPanel — LP-facing commitments and capital-call panel.
 *
 * Displays:
 *   - LP's commitment status (committed, called, remaining callable)
 *   - Outstanding capital calls with funding deadline countdown
 *   - Fund/acknowledge flow with amount input and confirmation
 *   - Default warnings when a call is past its deadline
 *   - Signed-acknowledgement gate before the commitment becomes active
 *   - Event history log
 */

import { useEffect, useState, useCallback } from "react";
import {
  getVaultCommitments,
  getCapitalCalls,
  acknowledgeCommitment,
  fundCapitalCall,
  type FundCallResult,
} from "../lib/api/vaultCommitments";
import {
  callStateLabel,
  callStateColor,
  commitmentStateLabel,
  commitmentStateColor,
  callRequiresAction,
  msUntilDeadline,
  formatDuration,
  isCallPastDeadline,
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ flex: 1, padding: "10px 12px" }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", marginBottom: 3 }}>
        {label}
      </div>
      <div className="num" style={{ fontSize: 13, fontWeight: 600, color: color ?? "var(--text-hi)" }}>
        {value}
      </div>
    </div>
  );
}

function CallCard({
  call,
  nowMs,
  onFund,
  funding,
}: {
  call: CapitalCall;
  nowMs: number;
  onFund: (callId: string, amount: number) => void;
  funding: boolean;
}) {
  const [amount, setAmount] = useState("");
  const remaining = call.callAmount - call.fundedAmount;
  const pastDeadline = isCallPastDeadline(call, nowMs);
  const msLeft = msUntilDeadline(call, nowMs);
  const needsAction = callRequiresAction(call);
  const stateColor = callStateColor(call.state);

  return (
    <div
      style={{
        border: `1px solid ${pastDeadline && needsAction ? "var(--put)" : "var(--border-default)"}`,
        background: pastDeadline && needsAction ? "var(--put-dim)" : "var(--bg-overlay)",
        padding: "12px 14px",
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-lo)" }}>{call.id}</span>
          {call.note && (
            <div style={{ fontSize: 11, color: "var(--text-mid)", marginTop: 2 }}>{call.note}</div>
          )}
        </div>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: stateColor,
            border: `1px solid ${stateColor}`,
            padding: "2px 7px",
          }}
        >
          {callStateLabel(call.state)}
        </span>
      </div>

      <div style={{ display: "flex", gap: 0, borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }}>
        <StatCell label="Call Amount" value={`$${fmtUsd(call.callAmount)}`} />
        <StatCell label="Funded" value={`$${fmtUsd(call.fundedAmount)}`} color="var(--call)" />
        <StatCell label="Remaining" value={`$${fmtUsd(remaining)}`} color={remaining > 0 ? "var(--atm)" : "var(--text-lo)"} />
        <StatCell
          label="Deadline"
          value={needsAction ? formatDuration(msLeft) : fmtDate(call.fundingDeadline)}
          color={pastDeadline && needsAction ? "var(--put)" : needsAction ? "var(--atm)" : "var(--text-lo)"}
        />
      </div>

      {pastDeadline && needsAction && (
        <div
          role="alert"
          style={{ marginTop: 8, padding: "6px 10px", background: "var(--put-dim)", border: "1px solid var(--put)", fontSize: 11, color: "var(--put)" }}
        >
          ⚠ This call is past its funding deadline. Funding it now is subject to operator discretion (late payment).
        </div>
      )}

      {needsAction && (
        <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="number"
            min={0}
            max={remaining}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder={`Up to $${fmtUsd(remaining)}`}
            aria-label="Funding amount"
            style={{
              flex: 1, padding: "7px 10px",
              background: "var(--bg-overlay)", border: "1px solid var(--border-default)",
              color: "var(--text-hi)", fontFamily: "var(--font-mono)", fontSize: 12,
            }}
          />
          <button
            onClick={() => {
              const v = parseFloat(amount);
              if (!isNaN(v) && v > 0) onFund(call.id, v);
            }}
            disabled={funding || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0}
            style={{
              padding: "7px 16px", fontSize: 11, fontWeight: 700,
              background: "var(--brand)", color: "var(--bg)", border: "none",
              cursor: funding ? "not-allowed" : "pointer",
              opacity: funding ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {funding ? "Funding…" : "Fund"}
          </button>
          <button
            onClick={() => {
              const v = remaining;
              setAmount(v.toFixed(2));
            }}
            style={{
              padding: "7px 10px", fontSize: 10,
              background: "var(--bg-elevated)", color: "var(--text-mid)", border: "1px solid var(--border-default)",
              cursor: "pointer",
            }}
          >
            Max
          </button>
        </div>
      )}

      {call.state === "FUNDED" && call.sharesMinted != null && (
        <div style={{ marginTop: 8, fontSize: 10, color: "var(--call)" }}>
          Funded epoch #{call.fundingEpoch} · {call.sharesMinted.toFixed(4)} shares minted @ ${call.sharePrice?.toFixed(4)}/share
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface VaultCommitmentsPanelProps {
  walletAddress: string | null | undefined;
  token: string | null | undefined;
  vaultId: string;
  /** Current vault share price for share-minting preview. */
  sharePrice: number;
  /** Current epoch number. */
  currentEpoch: number;
}

export function VaultCommitmentsPanel({
  walletAddress,
  token,
  vaultId,
  sharePrice,
  currentEpoch,
}: VaultCommitmentsPanelProps) {
  const [commitment, setCommitment] = useState<VaultCommitment | null>(null);
  const [calls, setCalls] = useState<CapitalCall[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ackLoading, setAckLoading] = useState(false);
  const [fundingCallId, setFundingCallId] = useState<string | null>(null);
  const [fundResult, setFundResult] = useState<FundCallResult | null>(null);
  const [fundError, setFundError] = useState<string | null>(null);
  const [nowMs] = useState(() => Date.now());

  const loadData = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      const commitments = await getVaultCommitments(vaultId, { lpWalletAddress: walletAddress }, token);
      const lp = commitments[0] ?? null;
      setCommitment(lp);
      if (lp) {
        const c = await getCapitalCalls(vaultId, lp.id, token);
        setCalls(c);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load commitment data.");
    } finally {
      setLoading(false);
    }
  }, [walletAddress, vaultId, token]);

  useEffect(() => { if (walletAddress) loadData(); }, [walletAddress, loadData]);

  const handleAcknowledge = async () => {
    if (!commitment || !walletAddress) return;
    setAckLoading(true);
    setError(null);
    try {
      const updated = await acknowledgeCommitment(vaultId, commitment.id, walletAddress, token);
      setCommitment(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Acknowledgement failed.");
    } finally {
      setAckLoading(false);
    }
  };

  const handleFund = async (callId: string, amount: number) => {
    if (!walletAddress) return;
    setFundingCallId(callId);
    setFundError(null);
    setFundResult(null);
    try {
      const result = await fundCapitalCall(
        vaultId,
        callId,
        { fundingAmount: amount, fundingEpoch: currentEpoch, sharePrice },
        walletAddress,
        token,
      );
      setFundResult(result);
      await loadData();
    } catch (e) {
      setFundError(e instanceof Error ? e.message : "Funding failed.");
    } finally {
      setFundingCallId(null);
    }
  };

  if (!walletAddress) {
    return (
      <section
        aria-label="Institutional Commitments"
        style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: "16px 18px" }}
      >
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 8 }}>
          Institutional Commitment
        </div>
        <div style={{ fontSize: 12, color: "var(--text-lo)" }}>
          Connect your wallet to view your commitment and capital calls.
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Institutional Commitments"
      style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}
    >
      {/* Header */}
      <div style={{ padding: "13px 18px 10px", borderBottom: "1px solid var(--border-subtle)" }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)" }}>
          Institutional Commitment
        </div>
      </div>

      {loading && !commitment && (
        <div style={{ padding: "16px 18px" }}>
          <div className="skeleton" style={{ height: 12, width: "70%" }} />
        </div>
      )}

      {error && (
        <div role="alert" style={{ padding: "10px 18px", fontSize: 11, color: "var(--put)" }}>{error}</div>
      )}

      {!loading && !commitment && !error && (
        <div style={{ padding: "14px 18px", fontSize: 12, color: "var(--text-lo)" }}>
          No commitment found for this vault. Contact the vault operator to set one up.
        </div>
      )}

      {commitment && (
        <>
          {/* Commitment summary stats */}
          <div
            style={{
              display: "flex", gap: 0,
              borderBottom: "1px solid var(--border-subtle)",
              borderLeft: `3px solid ${commitmentStateColor(commitment.state)}`,
            }}
          >
            <StatCell label="Committed" value={`$${fmtUsd(commitment.committedAmount)}`} />
            <StatCell label="Called" value={`$${fmtUsd(commitment.calledAmount)}`} color="var(--brand)" />
            <StatCell
              label="Remaining"
              value={`$${fmtUsd(commitment.remainingCallable)}`}
              color={commitment.remainingCallable > 0 ? "var(--call)" : "var(--text-lo)"}
            />
            <StatCell
              label="Status"
              value={commitmentStateLabel(commitment.state)}
              color={commitmentStateColor(commitment.state)}
            />
          </div>

          {commitment.notes && (
            <div style={{ padding: "8px 18px", fontSize: 11, color: "var(--text-lo)", borderBottom: "1px solid var(--border-subtle)" }}>
              {commitment.notes}
            </div>
          )}

          {/* Acknowledgement gate */}
          {commitment.state === "PENDING_ACKNOWLEDGEMENT" && (
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-subtle)" }}>
              <div style={{ fontSize: 12, color: "var(--atm)", marginBottom: 10, lineHeight: 1.6 }}>
                Your commitment requires your acknowledgement before capital calls can be issued.
                By acknowledging, you confirm the commitment terms and your intent to fund called capital.
              </div>
              <div style={{ marginBottom: 10, fontSize: 11, color: "var(--text-mid)", lineHeight: 1.6 }}>
                <strong style={{ color: "var(--text-hi)" }}>Committed:</strong> ${fmtUsd(commitment.committedAmount)}<br />
                <strong style={{ color: "var(--text-hi)" }}>Expires:</strong> {fmtDate(commitment.expiresAt)}<br />
                <strong style={{ color: "var(--text-hi)" }}>Capacity reserved:</strong> {commitment.reservesCapacity ? "Yes" : "No"}
              </div>
              <button
                onClick={handleAcknowledge}
                disabled={ackLoading}
                style={{
                  padding: "9px 20px", fontSize: 12, fontWeight: 700,
                  background: "var(--brand)", color: "var(--bg)", border: "none",
                  cursor: ackLoading ? "not-allowed" : "pointer",
                  opacity: ackLoading ? 0.6 : 1,
                }}
              >
                {ackLoading ? "Acknowledging…" : "Acknowledge Commitment"}
              </button>
            </div>
          )}

          {/* Fund result / error */}
          {fundResult && (
            <div
              role="status"
              style={{ padding: "8px 18px", background: "var(--call-dim)", borderBottom: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--call)" }}
            >
              Funded ${fmtUsd(fundResult.call.fundedAmount)} · {fundResult.call.sharesMinted?.toFixed(4)} shares minted ·{" "}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>{fundResult.txId.slice(0, 24)}…</span>
            </div>
          )}
          {fundError && (
            <div
              role="alert"
              style={{ padding: "8px 18px", background: "var(--put-dim)", borderBottom: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--put)" }}
            >
              {fundError}
            </div>
          )}

          {/* Capital calls */}
          {calls.length > 0 && (
            <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border-subtle)" }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", marginBottom: 8 }}>
                Capital Calls ({calls.length})
              </div>
              {calls.map(call => (
                <CallCard
                  key={call.id}
                  call={call}
                  nowMs={nowMs}
                  onFund={handleFund}
                  funding={fundingCallId === call.id}
                />
              ))}
            </div>
          )}

          {calls.length === 0 && commitment.state === "ACTIVE" && (
            <div style={{ padding: "12px 18px", fontSize: 12, color: "var(--text-lo)" }}>
              No capital calls have been issued yet. The vault operator will notify you when a call is issued.
            </div>
          )}

          {/* Expiry notice */}
          <div style={{ padding: "8px 18px", fontSize: 10, color: "var(--text-lo)" }}>
            Commitment expires {fmtDate(commitment.expiresAt)} · Created {fmtDate(commitment.createdAt)}
          </div>
        </>
      )}
    </section>
  );
}
