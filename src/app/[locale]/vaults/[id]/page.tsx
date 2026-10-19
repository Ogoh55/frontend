"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { use } from "react";
import { AppHeader } from "../../../../components/AppHeader";
import { WalletConnect } from "../../../../components/WalletConnect";
import { useWalletStore } from "../../../../lib/store/wallet";
import {
  fetchVaultDetail,
  depositToVault,
  withdrawFromVault,
  type VaultDetail,
  type EpochPhase,
} from "../../../../lib/api/vaults";

const PHASE_LABELS: Record<EpochPhase, string> = {
  deposit:    "Deposit Window",
  active:     "Epoch Active",
  settlement: "Settlement",
};

const PHASE_COLORS: Record<EpochPhase, string> = {
  deposit:    "var(--call)",
  active:     "var(--brand)",
  settlement: "var(--atm)",
};

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateShort(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function VaultDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const token = useWalletStore(s => s.session);

  const [vault, setVault] = useState<VaultDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawShares, setWithdrawShares] = useState("");
  const [txStatus, setTxStatus] = useState<null | "pending" | "success" | "error">(null);
  const [txMessage, setTxMessage] = useState("");
  const [activeFlow, setActiveFlow] = useState<"deposit" | "withdraw" | null>(null);

  useEffect(() => {
    fetchVaultDetail(id)
      .then(v => { setVault(v); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [id, token]);

  const handleDeposit = async () => {
    if (!vault || !token) return;
    const amount = parseFloat(depositAmount);
    if (isNaN(amount) || amount <= 0) return;
    setTxStatus("pending");
    setTxMessage("");
    try {
      const result = await depositToVault(vault.id, depositAmount.trim());
      setTxStatus("success");
      setTxMessage(`Deposit confirmed. TX: ${result.tx_id}`);
      setDepositAmount("");
    } catch (e) {
      setTxStatus("error");
      setTxMessage(e instanceof Error ? e.message : "Deposit failed");
    }
  };

  const handleWithdraw = async () => {
    if (!vault || !token) return;
    const shares = parseFloat(withdrawShares);
    if (isNaN(shares) || shares <= 0) return;
    setTxStatus("pending");
    setTxMessage("");
    try {
      const result = await withdrawFromVault(vault.id, withdrawShares.trim());
      setTxStatus("success");
      setTxMessage(
        result.queued
          ? `Withdrawal queued for epoch end. TX: ${result.tx_id}`
          : `Withdrawal confirmed. TX: ${result.tx_id}`
      );
      setWithdrawShares("");
    } catch (e) {
      setTxStatus("error");
      setTxMessage(e instanceof Error ? e.message : "Withdrawal failed");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", overflow: "hidden", fontFamily: "var(--font-sans)" }}>
      <AppHeader>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 1, height: 16, background: "var(--border-default)", margin: "0 8px" }} />
          <WalletConnect />
        </div>
      </AppHeader>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "24px 24px 64px" }}>
          {/* Breadcrumb */}
          <div style={{ fontSize: 12, color: "var(--text-lo)", marginBottom: 20 }}>
            <Link href="/vaults" style={{ color: "var(--text-lo)", textDecoration: "none" }}>Vaults</Link>
            <span style={{ margin: "0 6px" }}>›</span>
            <span>{vault?.name ?? id}</span>
          </div>

          {loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="skeleton" style={{ height: 80, width: "100%" }} />
              <div className="skeleton" style={{ height: 200, width: "100%" }} />
            </div>
          )}

          {error && (
            <div style={{ padding: "12px 16px", border: "1px solid var(--put)", background: "var(--put-dim)", color: "var(--put)", fontSize: 12 }}>
              {error}
            </div>
          )}

          {!loading && !error && !vault && (
            <div style={{ fontSize: 13, color: "var(--text-lo)" }}>Vault not found.</div>
          )}

          {vault && (
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
              {/* Main column */}
              <div style={{ flex: 1, minWidth: 340, display: "flex", flexDirection: "column", gap: 16 }}>

                {/* Header */}
                <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div>
                      <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 600, marginBottom: 4 }}>{vault.name}</h1>
                      <div style={{ fontSize: 12, color: "var(--text-mid)" }}>{vault.description}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="num" style={{ fontSize: 22, fontWeight: 700, color: "var(--call)" }}>
                        {(vault.apy * 100).toFixed(1)}%
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-lo)" }}>trailing APY</div>
                    </div>
                  </div>

                  {/* Stats row */}
                  <div style={{ display: "flex", gap: 0, borderTop: "1px solid var(--border-default)", marginTop: 12 }}>
                    {[
                      { label: "TVL", value: fmtUsd(vault.tvl) },
                      { label: "Share Price", value: `$${vault.sharePrice.toFixed(4)}` },
                      { label: "Epoch", value: `#${vault.currentEpoch}` },
                      { label: "Mgmt Fee", value: vault.feeStructure.managementPct > 0 ? `${vault.feeStructure.managementPct}%` : "None" },
                      { label: "Perf Fee", value: `${vault.feeStructure.performancePct}%` },
                    ].map((s, i) => (
                      <div key={s.label} style={{
                        flex: 1, padding: "10px 12px",
                        borderLeft: i > 0 ? "1px solid var(--border-default)" : "none",
                      }}>
                        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", marginBottom: 3 }}>{s.label}</div>
                        <div className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{s.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Epoch timeline */}
                <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-hi)", marginBottom: 12 }}>Epoch Timeline</div>
                  <div style={{ display: "flex", gap: 0 }}>
                    {(["deposit", "active", "settlement"] as EpochPhase[]).map((phase, i) => {
                      const isCurrent = phase === vault.currentPhase;
                      const isPast = (["deposit", "active", "settlement"] as EpochPhase[]).indexOf(vault.currentPhase) > i;
                      return (
                        <div key={phase} style={{ flex: 1, position: "relative" }}>
                          <div style={{
                            height: 4,
                            background: isCurrent ? PHASE_COLORS[phase] : isPast ? "var(--border-strong)" : "var(--bg-overlay)",
                            marginBottom: 6,
                          }} />
                          <div style={{
                            fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em",
                            color: isCurrent ? PHASE_COLORS[phase] : isPast ? "var(--text-mid)" : "var(--text-lo)",
                            fontWeight: isCurrent ? 700 : 400,
                          }}>
                            {PHASE_LABELS[phase]}
                          </div>
                          {isCurrent && (
                            <div style={{ fontSize: 9, color: "var(--text-lo)", marginTop: 2 }}>
                              Ends {fmtDate(vault.phaseEndsAt)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--bg-elevated)", border: `1px solid ${PHASE_COLORS[vault.currentPhase]}`, borderLeft: `3px solid ${PHASE_COLORS[vault.currentPhase]}` }}>
                    <span style={{ fontSize: 11, color: PHASE_COLORS[vault.currentPhase], fontWeight: 600 }}>
                      {vault.currentPhase === "deposit" && "Deposits open · Withdrawals processed at epoch start"}
                      {vault.currentPhase === "active" && "Epoch in progress · Withdrawals queued until settlement"}
                      {vault.currentPhase === "settlement" && "Settling position · Final P&L being calculated"}
                    </span>
                  </div>
                </div>

                {/* Payoff explanation */}
                <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-hi)", marginBottom: 8 }}>How This Vault Works</div>
                  <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.7 }}>{vault.payoffExplanation}</div>
                </div>

                {/* Historical epochs */}
                <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
                  <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-default)", fontSize: 11, fontWeight: 600, color: "var(--text-hi)" }}>
                    Historical Epochs
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                        {["Epoch", "Active", "Settlement", "Strike", "Premium/Share", "Outcome", "Return"].map(h => (
                          <th key={h} style={{
                            padding: "6px 12px", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em",
                            color: "var(--text-lo)", textAlign: "right", fontWeight: 500, background: "var(--bg-overlay)",
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {vault.historicalEpochs.map(ep => (
                        <tr key={ep.epochNumber} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                          <td className="num" style={{ padding: "8px 12px", fontSize: 11, textAlign: "right", color: "var(--text-lo)" }}>#{ep.epochNumber}</td>
                          <td className="num" style={{ padding: "8px 12px", fontSize: 11, textAlign: "right", color: "var(--text-mid)" }}>{fmtDateShort(ep.activeStart)}</td>
                          <td className="num" style={{ padding: "8px 12px", fontSize: 11, textAlign: "right", color: "var(--text-mid)" }}>{fmtDateShort(ep.settlementDate)}</td>
                          <td className="num" style={{ padding: "8px 12px", fontSize: 11, textAlign: "right", color: "var(--atm)" }}>
                            {ep.strike >= 1000
                              ? `$${ep.strike.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                              : `$${ep.strike.toFixed(4)}`}
                          </td>
                          <td className="num" style={{ padding: "8px 12px", fontSize: 11, textAlign: "right", color: "var(--text-hi)" }}>
                            ${ep.premiumCollected.toFixed(ep.premiumCollected < 1 ? 4 : 2)}
                          </td>
                          <td style={{ padding: "8px 12px", textAlign: "right" }}>
                            <span style={{
                              fontSize: 9, padding: "2px 6px", textTransform: "uppercase",
                              background: ep.outcome === "expired_worthless" ? "var(--call-dim)" : "var(--put-dim)",
                              color: ep.outcome === "expired_worthless" ? "var(--call)" : "var(--put)",
                            }}>
                              {ep.outcome === "expired_worthless" ? "Expired" : ep.outcome === "exercised" ? "Exercised" : "Active"}
                            </span>
                          </td>
                          <td className="num" style={{
                            padding: "8px 12px", fontSize: 11, fontWeight: 600, textAlign: "right",
                            color: ep.pnlPct >= 0 ? "var(--call)" : "var(--put)",
                          }}>
                            {ep.pnlPct >= 0 ? "+" : ""}{(ep.pnlPct * 100).toFixed(2)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Right sidebar: user position + deposit/withdraw */}
              <div style={{ flex: "0 0 280px", minWidth: 240, display: "flex", flexDirection: "column", gap: 12 }}>

                {/* User position */}
                {vault.userPosition && (
                  <div style={{ border: "1px solid var(--brand)", background: "var(--brand-dim)", padding: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--brand)", marginBottom: 12 }}>Your Position</div>
                    {[
                      { label: "Shares", value: vault.userPosition.shares.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
                      { label: "Total Value", value: `$${vault.userPosition.totalValue.toFixed(2)}` },
                      { label: "Accrued Premium", value: `$${vault.userPosition.accruedPremium.toFixed(2)}` },
                      ...(vault.userPosition.pendingWithdrawal > 0 ? [{ label: "Queued Withdrawal", value: `${vault.userPosition.pendingWithdrawal} shares` }] : []),
                    ].map(s => (
                      <div key={s.label} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border-subtle)" }}>
                        <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{s.label}</span>
                        <span className="num" style={{ fontSize: 11, fontWeight: 600, color: "var(--text-hi)" }}>{s.value}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Fee disclosure */}
                <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-mid)", marginBottom: 8 }}>Fee Disclosure</div>
                  <div style={{ fontSize: 11, color: "var(--text-lo)", lineHeight: 1.6 }}>
                    {vault.feeStructure.managementPct > 0 && (
                      <div>Management: {vault.feeStructure.managementPct}% annually on TVL</div>
                    )}
                    {vault.feeStructure.managementPct === 0 && (
                      <div>No management fee</div>
                    )}
                    <div>Performance: {vault.feeStructure.performancePct}% on net positive epoch returns</div>
                  </div>
                </div>

                {/* Deposit / Withdraw flows */}
                {!token ? (
                  <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 16, fontSize: 12, color: "var(--text-mid)", textAlign: "center" }}>
                    <div style={{ marginBottom: 10 }}>Connect your wallet to deposit or withdraw.</div>
                    <WalletConnect />
                  </div>
                ) : (
                  <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
                    {/* Tab switcher */}
                    <div style={{ display: "flex", borderBottom: "1px solid var(--border-default)" }}>
                      {(["deposit", "withdraw"] as const).map(flow => (
                        <button key={flow} onClick={() => { setActiveFlow(activeFlow === flow ? null : flow); setTxStatus(null); }}
                          style={{
                            flex: 1, padding: "10px 0", border: "none", cursor: "pointer",
                            fontSize: 12, textTransform: "capitalize", fontWeight: 600,
                            background: activeFlow === flow ? "var(--bg-elevated)" : "transparent",
                            color: activeFlow === flow ? "var(--text-hi)" : "var(--text-lo)",
                            borderBottom: activeFlow === flow ? "2px solid var(--brand)" : "2px solid transparent",
                            marginBottom: -1,
                          }}>
                          {flow}
                        </button>
                      ))}
                    </div>

                    {activeFlow === "deposit" && (
                      <div style={{ padding: 16 }}>
                        <div style={{ fontSize: 11, color: "var(--text-mid)", marginBottom: 12 }}>
                          Deposit USDC into the vault. Shares are issued at the current NAV of{" "}
                          <span className="num" style={{ color: "var(--text-hi)" }}>${vault.sharePrice.toFixed(4)}</span>/share.
                        </div>
                        <div style={{ marginBottom: 12 }}>
                          <label style={{ fontSize: 10, color: "var(--text-lo)", display: "block", marginBottom: 4 }}>Amount (USDC)</label>
                          <input
                            type="number"
                            min={0}
                            value={depositAmount}
                            onChange={e => setDepositAmount(e.target.value)}
                            placeholder="0.00"
                            style={{
                              width: "100%", padding: "8px 10px",
                              background: "var(--bg-overlay)", border: "1px solid var(--border-default)",
                              color: "var(--text-hi)", fontFamily: "var(--font-mono)", fontSize: 13,
                            }}
                          />
                          {depositAmount && !isNaN(parseFloat(depositAmount)) && parseFloat(depositAmount) > 0 && (
                            <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
                              ≈ {(parseFloat(depositAmount) / vault.sharePrice).toFixed(4)} shares
                            </div>
                          )}
                        </div>
                        {/* Queued withdrawal notice if epoch is active */}
                        {vault.currentPhase === "active" && (
                          <div style={{ marginBottom: 10, fontSize: 10, color: "var(--atm)", padding: "6px 8px", background: "var(--atm-dim)" }}>
                            Deposits during active epochs are queued for the next epoch start.
                          </div>
                        )}
                        <button
                          onClick={handleDeposit}
                          disabled={txStatus === "pending" || !depositAmount || isNaN(parseFloat(depositAmount)) || parseFloat(depositAmount) <= 0}
                          style={{
                            width: "100%", padding: "10px 0", background: "var(--brand)",
                            color: "var(--bg)", border: "none", fontSize: 13, fontWeight: 700,
                            cursor: txStatus === "pending" ? "default" : "pointer",
                            opacity: txStatus === "pending" ? 0.6 : 1,
                          }}
                        >
                          {txStatus === "pending" ? "Confirming…" : "Deposit"}
                        </button>
                      </div>
                    )}

                    {activeFlow === "withdraw" && (
                      <div style={{ padding: 16 }}>
                        <div style={{ fontSize: 11, color: "var(--text-mid)", marginBottom: 12 }}>
                          Withdrawal requests are queued and processed at the end of the current epoch.
                          Shares are redeemed at the final NAV after settlement.
                        </div>
                        <div style={{ marginBottom: 12 }}>
                          <label style={{ fontSize: 10, color: "var(--text-lo)", display: "block", marginBottom: 4 }}>Shares to Withdraw</label>
                          <input
                            type="number"
                            min={0}
                            value={withdrawShares}
                            onChange={e => setWithdrawShares(e.target.value)}
                            placeholder="0.0000"
                            style={{
                              width: "100%", padding: "8px 10px",
                              background: "var(--bg-overlay)", border: "1px solid var(--border-default)",
                              color: "var(--text-hi)", fontFamily: "var(--font-mono)", fontSize: 13,
                            }}
                          />
                          {withdrawShares && !isNaN(parseFloat(withdrawShares)) && parseFloat(withdrawShares) > 0 && (
                            <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
                              ≈ ${(parseFloat(withdrawShares) * vault.sharePrice).toFixed(2)} USDC at current NAV
                            </div>
                          )}
                        </div>
                        <div style={{ marginBottom: 10, fontSize: 10, color: "var(--text-lo)", lineHeight: 1.5 }}>
                          Queued withdrawals are processed at epoch settlement. You will receive USDC at the final share price after fees.
                        </div>
                        <button
                          onClick={handleWithdraw}
                          disabled={txStatus === "pending" || !withdrawShares || isNaN(parseFloat(withdrawShares)) || parseFloat(withdrawShares) <= 0}
                          style={{
                            width: "100%", padding: "10px 0",
                            background: "var(--bg-elevated)", border: "1px solid var(--border-default)",
                            color: "var(--text-hi)", fontSize: 13, fontWeight: 700,
                            cursor: txStatus === "pending" ? "default" : "pointer",
                            opacity: txStatus === "pending" ? 0.6 : 1,
                          }}
                        >
                          {txStatus === "pending" ? "Queuing…" : "Queue Withdrawal"}
                        </button>
                      </div>
                    )}

                    {/* TX status */}
                    {txStatus && txStatus !== "pending" && (
                      <div style={{
                        margin: "0 16px 16px",
                        padding: "8px 12px",
                        border: `1px solid ${txStatus === "success" ? "var(--call)" : "var(--put)"}`,
                        background: txStatus === "success" ? "var(--call-dim)" : "var(--put-dim)",
                        fontSize: 11,
                        color: txStatus === "success" ? "var(--call)" : "var(--put)",
                      }}>
                        {txMessage}
                      </div>
                    )}
                  </div>
                )}

                {/* Risk disclosure summary */}
                <div style={{ fontSize: 10, color: "var(--text-lo)", lineHeight: 1.5, padding: "0 4px" }}>
                  Vault contracts are unaudited. Deposits may be exposed to smart contract risk and
                  assignment risk. Past returns do not guarantee future results.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
