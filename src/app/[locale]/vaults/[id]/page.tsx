"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { use } from "react";
import { useTranslations } from "next-intl";
import { AppHeader } from "../../../../components/AppHeader";
import { WalletConnect } from "../../../../components/WalletConnect";
import { VaultReturnProjection } from "../../../../components/VaultReturnProjection";
import { useWalletStore } from "../../../../lib/store/wallet";
import { useIdempotencyKey } from "../../../../lib/hooks/useIdempotencyKey";
import { useFlag } from "../../../../lib/flags";
import { downloadBlob } from "../../../../lib/csv";
import {
  fetchVaultDetail,
  depositToVault,
  withdrawFromVault,
  fetchVaultExport,
  vaultStatusPolicy,
  acknowledgeDisclosure,
  fetchMyDisclosureAcknowledgements,
  hashDisclosureText,
  VaultPolicyError,
  VAULT_DISCLOSURE_VERSION,
  type VaultDetail,
  type EpochPhase,
  type VaultExportFormat,
  type DisclosureAcknowledgement,
  type PolicyReasonCode,
} from "../../../../lib/api/vaults";
import { VaultGovernancePanel } from "../../../../components/VaultGovernancePanel";

const ABSENT = "—";

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
  const vaultsEnabled = useFlag("vaults");
  const address = useWalletStore(s => s.address);
  const { keyFor, complete } = useIdempotencyKey();
  const t = useTranslations("vaultDisclosure");

  const [vault, setVault] = useState<VaultDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawShares, setWithdrawShares] = useState("");
  const [txStatus, setTxStatus] = useState<null | "pending" | "success" | "error">(null);
  const [txMessage, setTxMessage] = useState("");
  const [activeFlow, setActiveFlow] = useState<"deposit" | "withdraw" | null>(null);
  const [disclosuresAcknowledged, setDisclosuresAcknowledged] = useState(false);

  // Disclosure gate. `acks` is null while loading for the connected wallet.
  const [acks, setAcks] = useState<DisclosureAcknowledgement[] | null>(null);
  const [acceptRisks, setAcceptRisks] = useState(false);
  const [attestJurisdiction, setAttestJurisdiction] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [policyReason, setPolicyReason] = useState<PolicyReasonCode | null>(null);

  const disclosureParagraphs = [t("p1"), t("p2"), t("p3"), t("p4"), t("p5")];
  const disclosureText = disclosureParagraphs.join("\n\n");

  const currentAck = acks?.find(a => a.disclosureVersion === VAULT_DISCLOSURE_VERSION && a.jurisdictionAttested) ?? null;
  // Server-reported rejections take precedence over the local view of the records.
  const gateReason: PolicyReasonCode | null = policyReason ?? (
    acks === null || currentAck
      ? null
      : acks.length > 0 ? "DISCLOSURE_VERSION_STALE" : "DISCLOSURE_NOT_ACCEPTED"
  );

  useEffect(() => {
    if (!vaultsEnabled) return;
    setLoading(true);
    setError(null);
    fetchVaultDetail(id, token, { enabled: vaultsEnabled })
      .then(v => { setVault(v); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [id, token, vaultsEnabled]);

  const nav = vault?.sharePrice && vault.sharePrice > 0 ? vault.sharePrice : null;

  const permittedActions = vault ? vaultStatusPolicy(vault.status).permittedActions : [];

  // Re-query acknowledgements whenever the connected wallet changes, and clear any
  // checkbox or rejection state that belonged to the previous wallet.
  useEffect(() => {
    setAcks(null);
    setPolicyReason(null);
    setAcceptRisks(false);
    setAttestJurisdiction(false);
    if (!address || !token) return;
    let cancelled = false;
    fetchMyDisclosureAcknowledgements(address, token)
      .then(list => { if (!cancelled) setAcks(list); })
      .catch(e => { if (!cancelled) { setAcks([]); setTxStatus("error"); setTxMessage(e.message); } });
    return () => { cancelled = true; };
  }, [address, token]);

  const refreshAcks = () => {
    if (!address || !token) return;
    fetchMyDisclosureAcknowledgements(address, token).then(setAcks).catch(() => {});
  };

  const handleAcknowledge = async () => {
    if (!address || !token || !acceptRisks || !attestJurisdiction) return;
    setAcknowledging(true);
    try {
      const textHash = await hashDisclosureText(disclosureText);
      const ack = await acknowledgeDisclosure(
        { wallet: address, disclosureVersion: VAULT_DISCLOSURE_VERSION, textHash, jurisdictionAttested: attestJurisdiction },
        token
      );
      setAcks(prev => [...(prev ?? []), ack]);
      setPolicyReason(null);
    } catch (e) {
      if (e instanceof VaultPolicyError) setPolicyReason(e.code);
      else setTxMessage(e instanceof Error ? e.message : "Acknowledgement failed");
    } finally {
      setAcknowledging(false);
    }
  };

  const handleDeposit = async () => {
    if (!vault || !token || !address || !currentAck || gateReason || !disclosuresAcknowledged || !permittedActions.includes("deposit")) return;
    const amount = parseFloat(depositAmount);
    if (isNaN(amount) || amount <= 0) return;
    setTxStatus("pending");
    setTxMessage("");
    try {
      // Carry the acknowledged version so the backend can reject a stale one mid-form.
      const result = await depositToVault(vault.id, amount, token, {
        wallet: address,
        disclosureVersion: currentAck.disclosureVersion,
        idempotencyKey: keyFor({ vault: vault.id, amount }),
        enabled: vaultsEnabled,
      });
      complete();
      setTxStatus("success");
      setTxMessage(`Deposit confirmed. TX: ${result.tx_id}`);
      setDepositAmount("");
      // Reconcile the displayed position with backend truth.
      fetchVaultDetail(id, token).then(v => v && setVault(v)).catch(() => {});
    } catch (e) {
      setTxStatus(null);
      if (e instanceof VaultPolicyError) {
        setPolicyReason(e.code);
        refreshAcks();
      } else {
        setTxStatus("error");
        setTxMessage(e instanceof Error ? e.message : "Deposit failed");
      }
    }
  };

  const handleWithdraw = async () => {
    if (!vault || !token || !permittedActions.includes("withdraw")) return;
    const shares = parseFloat(withdrawShares);
    if (isNaN(shares) || shares <= 0) return;
    setTxStatus("pending");
    setTxMessage("");
    try {
      const result = await withdrawFromVault(vault.id, shares, token);
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

  const handleExport = async (format: VaultExportFormat) => {
    if (!vault || !token) return;
    try {
      const blob = await fetchVaultExport(vault.id, format, token);
      downloadBlob(`${vault.id}-lots.${format}`, blob);
    } catch (e) {
      setTxStatus("error");
      setTxMessage(e instanceof Error ? e.message : "Export failed");
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

          {!vaultsEnabled && (
            <div style={{ padding: "12px 16px", border: "1px solid var(--border-default)", background: "var(--bg-raised)", color: "var(--text-mid)", fontSize: 12 }}>
              Vaults are not available on this deployment.
            </div>
          )}

          {vaultsEnabled && loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="skeleton" style={{ height: 80, width: "100%" }} />
              <div className="skeleton" style={{ height: 200, width: "100%" }} />
            </div>
          )}

          {vaultsEnabled && error && (
            <div style={{ padding: "12px 16px", border: "1px solid var(--put)", background: "var(--put-dim)", color: "var(--put)", fontSize: 12 }}>
              Failed to load vault: {error}
            </div>
          )}

          {!loading && !error && !vault && !vaultsEnabled && (
            <div style={{ fontSize: 13, color: "var(--text-mid)" }}>Vaults are not yet available.</div>
          )}

          {!loading && !error && !vault && vaultsEnabled && (
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
                      <div style={{ fontSize: 12, color: "var(--text-mid)", overflowWrap: "anywhere" }}>{vault.description}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="num" style={{ fontSize: 22, fontWeight: 700, color: "var(--call)" }}>
                        {vault.apy != null ? `${(vault.apy * 100).toFixed(1)}%` : ABSENT}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-lo)" }}>trailing APY</div>
                    </div>
                  </div>

                  {/* Stats row */}
                  <div style={{ display: "flex", gap: 0, borderTop: "1px solid var(--border-default)", marginTop: 12 }}>
                    {[
                      { label: "TVL", value: vault.tvl != null ? fmtUsd(vault.tvl) : ABSENT },
                      { label: "Share Price", value: nav != null ? `$${nav.toFixed(4)}` : ABSENT },
                      { label: "Epoch", value: vault.currentEpoch != null ? `#${vault.currentEpoch}` : ABSENT },
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
                  {!vault.currentPhase && (
                    <div style={{ fontSize: 11, color: "var(--text-lo)" }}>No epoch has started yet.</div>
                  )}
                  <div style={{ display: "flex", gap: 0 }}>
                    {(["deposit", "active", "settlement"] as EpochPhase[]).map((phase, i) => {
                      const isCurrent = phase === vault.currentPhase;
                      const isPast = vault.currentPhase != null && (["deposit", "active", "settlement"] as EpochPhase[]).indexOf(vault.currentPhase) > i;
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
                          {isCurrent && vault.phaseEndsAt && (
                            <div style={{ fontSize: 9, color: "var(--text-lo)", marginTop: 2 }}>
                              Ends {fmtDate(vault.phaseEndsAt)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {vault.currentPhase && (
                    <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--bg-elevated)", border: `1px solid ${PHASE_COLORS[vault.currentPhase]}`, borderLeft: `3px solid ${PHASE_COLORS[vault.currentPhase]}` }}>
                      <span style={{ fontSize: 11, color: PHASE_COLORS[vault.currentPhase], fontWeight: 600 }}>
                        {vault.currentPhase === "deposit" && "Deposits open · Withdrawals processed at epoch start"}
                        {vault.currentPhase === "active" && "Epoch in progress · Withdrawals queued until settlement"}
                        {vault.currentPhase === "settlement" && "Settling position · Final P&L being calculated"}
                      </span>
                    </div>
                  )}
                </div>

                {/* Payoff explanation */}
                <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-hi)", marginBottom: 8 }}>How This Vault Works</div>
                  <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.7, overflowWrap: "anywhere" }}>{vault.payoffExplanation}</div>
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
                      {vault.historicalEpochs.length === 0 && (
                        <tr>
                          <td colSpan={7} style={{ padding: "12px 16px", fontSize: 11, color: "var(--text-lo)", textAlign: "center" }}>
                            No completed epochs yet.
                          </td>
                        </tr>
                      )}
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

                <VaultReturnProjection historicalEpochs={vault.historicalEpochs} />
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
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      {(["csv", "json"] as const).map(format => (
                        <button
                          key={format}
                          type="button"
                          onClick={() => handleExport(format)}
                          disabled={!token}
                          style={{ flex: 1, padding: "6px 0", fontSize: 11, fontWeight: 600, border: "1px solid var(--brand)", background: "transparent", color: "var(--brand)", cursor: token ? "pointer" : "not-allowed" }}
                        >
                          Export {format.toUpperCase()}
                        </button>
                      ))}
                    </div>
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
                ) : permittedActions.length === 0 ? (
                  <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 16, fontSize: 12, color: "var(--text-mid)", textAlign: "center" }}>
                    <div style={{ marginBottom: 6, fontWeight: 600, color: "var(--text-hi)" }}>Vault {vaultStatusPolicy(vault.status).label}</div>
                    <div>Deposits and withdrawals are not available in this status.</div>
                  </div>
                ) : (
                  <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
                    {/* Tab switcher */}
                    <div style={{ display: "flex", borderBottom: "1px solid var(--border-default)" }}>
                      {(["deposit", "withdraw"] as const)
                        .filter(flow => permittedActions.includes(flow))
                        .filter(flow => flow !== "deposit" || vaultsEnabled)
                        .map(flow => (
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

                    {activeFlow === "deposit" && vaultsEnabled && permittedActions.includes("deposit") && (
                      <div style={{ padding: 16 }}>
                        {acks === null && (
                          <div style={{ marginBottom: 12, fontSize: 11, color: "var(--text-lo)" }}>{t("checking")}</div>
                        )}
                        {acks !== null && !currentAck && (
                          <div style={{ marginBottom: 14, border: "1px solid var(--border-default)", background: "var(--bg-overlay)", padding: 12 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-hi)", marginBottom: 8 }}>{t("title")}</div>
                            <div style={{ fontSize: 10, color: "var(--text-lo)", marginBottom: 8 }}>
                              {t("versionLabel", { version: VAULT_DISCLOSURE_VERSION })}
                            </div>
                            <div style={{ maxHeight: 180, overflowY: "auto", fontSize: 11, color: "var(--text-mid)", lineHeight: 1.6, marginBottom: 10 }}>
                              {disclosureParagraphs.map((p, i) => (
                                <p key={i} style={{ marginBottom: 6 }}>{p}</p>
                              ))}
                            </div>
                            <label style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--text-mid)", marginBottom: 8, cursor: "pointer" }}>
                              <input type="checkbox" checked={acceptRisks} onChange={e => setAcceptRisks(e.target.checked)} style={{ marginTop: 2 }} />
                              <span>{t("acceptRisks")}</span>
                            </label>
                            <label style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--text-mid)", marginBottom: 10, cursor: "pointer" }}>
                              <input type="checkbox" checked={attestJurisdiction} onChange={e => setAttestJurisdiction(e.target.checked)} style={{ marginTop: 2 }} />
                              <span>{t("attestJurisdiction")}</span>
                            </label>
                            <button
                              onClick={handleAcknowledge}
                              disabled={acknowledging || !acceptRisks || !attestJurisdiction}
                              style={{
                                width: "100%", padding: "8px 0", background: "var(--bg-elevated)",
                                border: "1px solid var(--brand)", color: "var(--text-hi)", fontSize: 12, fontWeight: 600,
                                cursor: acknowledging || !acceptRisks || !attestJurisdiction ? "default" : "pointer",
                                opacity: acknowledging || !acceptRisks || !attestJurisdiction ? 0.6 : 1,
                              }}
                            >
                              {acknowledging ? t("accepting") : t("accept")}
                            </button>
                          </div>
                        )}
                        {currentAck && (
                          <div style={{ marginBottom: 12, fontSize: 10, color: "var(--text-lo)" }}>
                            {t("versionLabel", { version: VAULT_DISCLOSURE_VERSION })} · {t("acceptedAt", { date: fmtDate(currentAck.acceptedAt) })}
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: "var(--text-mid)", marginBottom: 12 }}>
                          {nav != null ? (
                            <>
                              Deposit USDC into the vault. Shares are issued at the current NAV of{" "}
                              <span className="num" style={{ color: "var(--text-hi)" }}>${nav.toFixed(4)}</span>/share.
                            </>
                          ) : (
                            "Deposit USDC into the vault. NAV per share is not available yet."
                          )}
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
                          {nav != null && depositAmount && !isNaN(parseFloat(depositAmount)) && parseFloat(depositAmount) > 0 && (
                            <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
                              ≈ {(parseFloat(depositAmount) / nav).toFixed(4)} shares
                            </div>
                          )}
                        </div>
                        {/* Queued withdrawal notice if epoch is active */}
                        {vault.currentPhase === "active" && (
                          <div style={{ marginBottom: 10, fontSize: 10, color: "var(--atm)", padding: "6px 8px", background: "var(--atm-dim)" }}>
                            Deposits during active epochs are queued for the next epoch start.
                          </div>
                        )}
                        {/* Depositor disclosures: shown and acknowledged before the deposit can be submitted */}
                        <div style={{ marginBottom: 12, padding: 10, border: "1px solid var(--border-default)", background: "var(--bg-overlay)", fontSize: 10, color: "var(--text-lo)", lineHeight: 1.6 }}>
                          <div><span style={{ color: "var(--text-mid)" }}>Risk level:</span> {vault.riskRating}</div>
                          <div><span style={{ color: "var(--text-mid)" }}>Strategy:</span> {vault.description}</div>
                          <div>
                            <span style={{ color: "var(--text-mid)" }}>Fees:</span>{" "}
                            {vault.feeStructure.managementPct}% management annually, {vault.feeStructure.performancePct}% performance
                          </div>
                          <div>
                            Deposits are queued and redemptions are processed through the withdrawal queue at epoch end;
                            redemption at the final NAV is not guaranteed to match the current share price.
                          </div>
                          <label style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 8, color: "var(--text-hi)", cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={disclosuresAcknowledged}
                              onChange={e => setDisclosuresAcknowledged(e.target.checked)}
                              style={{ marginTop: 2 }}
                            />
                            <span>I have read the risk level, strategy, fees and queue/redemption terms above.</span>
                          </label>
                        </div>
                        {gateReason && (
                          <div role="alert" style={{ marginBottom: 10, fontSize: 10, color: "var(--put)", padding: "6px 8px", background: "var(--put-dim)" }}>
                            <strong>{t("depositBlocked")}:</strong> {t(`reason.${gateReason}`)}
                          </div>
                        )}
                        <button
                          onClick={handleDeposit}
                          disabled={!disclosuresAcknowledged || txStatus === "pending" || !currentAck || !!gateReason || !depositAmount || isNaN(parseFloat(depositAmount)) || parseFloat(depositAmount) <= 0}
                          style={{
                            width: "100%", padding: "10px 0", background: "var(--brand)",
                            color: "var(--bg)", border: "none", fontSize: 13, fontWeight: 700,
                            cursor: txStatus === "pending" || !currentAck || gateReason ? "default" : "pointer",
                            opacity: txStatus === "pending" || !currentAck || gateReason ? 0.6 : 1,
                          }}
                        >
                          {txStatus === "pending" ? "Confirming
