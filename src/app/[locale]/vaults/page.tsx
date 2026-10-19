"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppHeader } from "../../../components/AppHeader";
import { WalletConnect } from "../../../components/WalletConnect";
import { fetchVaults, type VaultSummary, type VaultStrategy, type RiskRating } from "../../../lib/api/vaults";
import { useFlag } from "../../../lib/flags";

const ABSENT = "—";

const STRATEGY_LABELS: Record<VaultStrategy, string> = {
  covered_call:      "Covered Call",
  cash_secured_put:  "Cash-Secured Put",
  iron_condor:       "Iron Condor",
  wheel:             "Wheel",
};

const RISK_COLORS: Record<RiskRating, string> = {
  low:    "var(--call)",
  medium: "var(--atm)",
  high:   "var(--put)",
};

const RISK_BG: Record<RiskRating, string> = {
  low:    "var(--call-dim)",
  medium: "var(--atm-dim)",
  high:   "var(--put-dim)",
};

function capacityPct(tvl: number, capacity: number) {
  return Math.min(100, (tvl / capacity) * 100);
}

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export default function VaultsPage() {
  const vaultsEnabled = useFlag("vaults");
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apyTooltip, setApyTooltip] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultsEnabled) return;
    setLoading(true);
    setError(null);
    fetchVaults()
      .then(v => { setVaults(v); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [vaultsEnabled]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", overflow: "hidden", fontFamily: "var(--font-sans)" }}>
      <AppHeader>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 1, height: 16, background: "var(--border-default)", margin: "0 8px" }} />
          <WalletConnect />
        </div>
      </AppHeader>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 24px 64px" }}>

          {/* Page header */}
          <div style={{ marginBottom: 32 }}>
            <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, fontWeight: 600, marginBottom: 6 }}>
              Option-Writing Vaults
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-mid)", maxWidth: 620 }}>
              Earn passive yield by providing liquidity to automated option-writing strategies.
              Premiums are collected each epoch and compounded into your share price.
            </p>
          </div>

          {!vaultsEnabled && (
            <div style={{ padding: "12px 16px", border: "1px solid var(--border-default)", background: "var(--bg-raised)", color: "var(--text-mid)", fontSize: 12 }}>
              Vaults are not available on this deployment.
            </div>
          )}

          {vaultsEnabled && loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[1, 2, 3].map(i => (
                <div key={i} className="skeleton" style={{ height: 120, width: "100%" }} />
              ))}
            </div>
          )}

          {vaultsEnabled && error && (
            <div style={{ padding: "12px 16px", border: "1px solid var(--put)", background: "var(--put-dim)", color: "var(--put)", fontSize: 12 }}>
              Failed to load vaults: {error}
            </div>
          )}

          {vaultsEnabled && !loading && !error && vaults.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--text-lo)" }}>No vaults are live yet.</div>
          )}

          {/* APY tooltip overlay */}
          {apyTooltip && (
            <div
              onClick={() => setApyTooltip(null)}
              style={{
                position: "fixed", inset: 0, zIndex: 50, display: "flex",
                alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)",
              }}
            >
              <div onClick={e => e.stopPropagation()} style={{
                maxWidth: 380, padding: 20, background: "var(--bg-overlay)",
                border: "1px solid var(--border-default)", fontSize: 13, color: "var(--text-mid)",
                lineHeight: 1.6,
              }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 8 }}>
                  APY Methodology
                </div>
                {apyTooltip}
                <button onClick={() => setApyTooltip(null)} style={{
                  marginTop: 14, display: "block", background: "none", border: "1px solid var(--border-default)",
                  color: "var(--text-lo)", padding: "4px 12px", cursor: "pointer", fontSize: 11,
                }}>Close</button>
              </div>
            </div>
          )}

          {/* Vault cards */}
          {vaultsEnabled && !loading && !error && vaults.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {vaults.map(vault => {
                const cap = vault.tvl != null && vault.capacity ? capacityPct(vault.tvl, vault.capacity) : null;
                const capColor = cap === null ? "var(--text-lo)" : cap >= 90 ? "var(--put)" : cap >= 70 ? "var(--atm)" : "var(--call)";
                return (
                  <div key={vault.id} style={{
                    border: "1px solid var(--border-default)", background: "var(--bg-raised)",
                    padding: 20, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start",
                  }}>
                    {/* Left: identity */}
                    <div style={{ minWidth: 180, flex: "0 0 200px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <div style={{
                          width: 32, height: 32, borderRadius: 0,
                          background: "var(--bg-overlay)", border: "1px solid var(--border-default)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--atm)",
                        }}>
                          {vault.underlying}
                        </div>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-hi)" }}>{vault.name}</div>
                          <div style={{ fontSize: 10, color: "var(--text-lo)" }}>{STRATEGY_LABELS[vault.strategy]}</div>
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-mid)", lineHeight: 1.5, overflowWrap: "anywhere" }}>{vault.description}</div>
                      {/* Risk rating */}
                      <div style={{ marginTop: 10 }}>
                        <span style={{
                          fontSize: 10, padding: "2px 8px", textTransform: "uppercase", letterSpacing: "0.06em",
                          background: RISK_BG[vault.riskRating], color: RISK_COLORS[vault.riskRating],
                          border: `1px solid ${RISK_COLORS[vault.riskRating]}`,
                        }}>
                          {vault.riskRating} risk
                        </span>
                      </div>
                    </div>

                    {/* Center: stats grid */}
                    <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px 20px" }}>
                      {/* APY */}
                      <div>
                        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 3 }}>
                          APY (trailing 12M)
                          <button
                            onClick={() => setApyTooltip(vault.apyMethodology)}
                            title="APY methodology"
                            style={{ marginLeft: 4, background: "none", border: "none", cursor: "pointer", color: "var(--text-lo)", fontSize: 9, padding: 0, textDecoration: "underline" }}
                          >ⓘ</button>
                        </div>
                        <div className="num" style={{ fontSize: 18, fontWeight: 700, color: "var(--call)" }}>
                          {vault.apy != null ? `${(vault.apy * 100).toFixed(1)}%` : ABSENT}
                        </div>
                      </div>
                      {/* TVL */}
                      <div>
                        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 3 }}>TVL</div>
                        <div className="num" style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)" }}>{vault.tvl != null ? fmtUsd(vault.tvl) : ABSENT}</div>
                      </div>
                      {/* Capacity */}
                      <div>
                        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 3 }}>
                          Capacity
                        </div>
                        <div className="num" style={{ fontSize: 12, color: capColor }}>
                          {vault.tvl != null && vault.capacity != null ? `${fmtUsd(vault.tvl)} / ${fmtUsd(vault.capacity)}` : ABSENT}
                        </div>
                        <div style={{ height: 3, background: "var(--bg-overlay)", marginTop: 4 }}>
                          <div style={{ width: `${cap ?? 0}%`, height: "100%", background: capColor, transition: "width 400ms" }} />
                        </div>
                      </div>
                      {/* Current epoch strike */}
                      <div>
                        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 3 }}>Current Strike</div>
                        <div className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--atm)" }}>
                          {vault.currentStrike == null
                            ? ABSENT
                            : vault.currentStrike >= 1000
                              ? `$${vault.currentStrike.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                              : `$${vault.currentStrike.toFixed(4)}`}
                        </div>
                      </div>
                      {/* Expiry */}
                      <div>
                        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 3 }}>Expiry</div>
                        <div className="num" style={{ fontSize: 13, color: "var(--text-mid)" }}>
                          {vault.currentExpiry
                            ? new Date(vault.currentExpiry).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                            : ABSENT}
                        </div>
                      </div>
                      {/* Underlying */}
                      <div>
                        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 3 }}>Underlying</div>
                        <div className="num" style={{ fontSize: 13, color: "var(--text-hi)" }}>{vault.underlying}/USD</div>
                      </div>
                    </div>

                    {/* Right: CTA */}
                    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", gap: 8, minWidth: 120 }}>
                      <Link href={`/vaults/${vault.id}`} style={{
                        display: "block", padding: "10px 20px", background: "var(--brand)",
                        color: "var(--bg)", fontSize: 13, fontWeight: 700, textDecoration: "none",
                        textAlign: "center",
                      }}>
                        View Vault →
                      </Link>
                      {cap !== null && cap >= 100 && (
                        <div style={{ fontSize: 10, color: "var(--put)", textAlign: "center" }}>Vault full</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Disclaimer */}
          <div style={{
            marginTop: 40, padding: "14px 16px",
            border: "1px solid var(--border-subtle)", background: "var(--bg-raised)",
            fontSize: 11, color: "var(--text-lo)", lineHeight: 1.6,
          }}>
            <strong style={{ color: "var(--text-mid)" }}>Risk Disclosure:</strong>{" "}
            Option-writing vaults carry the risk of assignment at the strike price (for put vaults)
            or capping upside gains (for call vaults). Past APY does not guarantee future returns.
            Vault smart contracts are unaudited. Do not deposit more than you can afford to lose.
          </div>
        </div>
      </div>
    </div>
  );
}
