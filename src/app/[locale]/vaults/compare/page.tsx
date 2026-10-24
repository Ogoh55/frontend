"use client";

import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "../../../../components/AppHeader";
import { WalletConnect } from "../../../../components/WalletConnect";
import {
  capacityUtilization,
  effectiveStatus,
  fetchVaults,
  fmtFeePct,
  fmtPct,
  fmtStrike,
  fmtUsd,
  parseVaultIds,
  totalFeePct,
  VAULT_COMPARE_MAX,
  VAULT_RISK_LABELS,
  VAULT_STATUS_LABELS,
  VAULT_STRATEGY_LABELS,
  type VaultSummary,
} from "../../../../lib/api/vaults";

const LABEL_STYLE = { fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)" } as const;

const CELL_STYLE = {
  padding: "10px 12px", fontSize: 12, color: "var(--text-mid)", borderBottom: "1px solid var(--border-subtle)",
  minWidth: 150, verticalAlign: "top", lineHeight: 1.5,
} as const;

const ROW_HEADER_STYLE = {
  ...CELL_STYLE, ...LABEL_STYLE, position: "sticky", left: 0, background: "var(--bg-raised)", minWidth: 120, zIndex: 1,
} as const;

interface MetricRow {
  label: string;
  value: (v: VaultSummary) => ReactNode;
  emphasis?: boolean;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Each row is one metric, aligned across every compared vault. */
const ROWS: { section: string; rows: MetricRow[] }[] = [
  {
    section: "Vault",
    rows: [
      { label: "Strategy", value: v => VAULT_STRATEGY_LABELS[v.strategy] },
      { label: "Underlying", value: v => `${v.underlying}/USD` },
      { label: "Status", value: v => VAULT_STATUS_LABELS[effectiveStatus(v)] },
      { label: "Description", value: v => v.description },
    ],
  },
  {
    section: "Returns",
    rows: [
      { label: "APY (trailing 12M)", value: v => fmtPct(v.apy), emphasis: true },
      { label: "Max drawdown", value: v => fmtPct(v.maxDrawdownPct) },
      { label: "TVL", value: v => fmtUsd(v.tvl) },
      { label: "Capacity", value: v => `${fmtUsd(v.tvl)} / ${fmtUsd(v.capacity)}` },
      { label: "Capacity used", value: v => fmtPct(capacityUtilization(v), 0) },
    ],
  },
  {
    section: "Risk & epochs",
    rows: [
      { label: "Risk rating", value: v => VAULT_RISK_LABELS[v.riskRating] },
      { label: "Epoch length", value: v => `${v.epochDays} days` },
      { label: "Current strike", value: v => fmtStrike(v.currentStrike) },
      { label: "Current expiry", value: v => fmtDate(v.currentExpiry) },
    ],
  },
  {
    section: "Fee schedule",
    rows: [
      { label: "Management fee", value: v => fmtFeePct(v.feeStructure.managementPct) },
      { label: "Performance fee", value: v => fmtFeePct(v.feeStructure.performancePct) },
      { label: "Total fees", value: v => fmtFeePct(totalFeePct(v)) },
    ],
  },
];

function VaultCompare() {
  const searchParams = useSearchParams();
  const ids = useMemo(() => parseVaultIds(searchParams.get("ids")), [searchParams]);

  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchVaults()
      .then(v => { if (!cancelled) setVaults(v); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error"); });
    return () => { cancelled = true; };
  }, [attempt]);

  // Preserve the order from the URL, and drop ids that don't match a vault.
  const selected = useMemo(() => {
    if (!vaults) return [];
    const byId = new Map(vaults.map(v => [v.id, v]));
    return ids.map(id => byId.get(id)).filter((v): v is VaultSummary => Boolean(v));
  }, [vaults, ids]);

  const loading = vaults === null && error === null;
  const unknownCount = vaults ? ids.length - selected.length : 0;

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

          <Link href="/vaults" style={{ fontSize: 11, color: "var(--text-lo)", textDecoration: "none" }}>
            ← All vaults
          </Link>

          <div style={{ margin: "12px 0 24px" }}>
            <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, fontWeight: 600, marginBottom: 6 }}>
              Compare Vaults
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-mid)", maxWidth: 620 }}>
              Metrics, fee schedule and risk characteristics for up to {VAULT_COMPARE_MAX} vaults, side by side.
            </p>
          </div>

          {loading && <div className="skeleton" style={{ height: 320, width: "100%" }} />}

          {error && (
            <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 16px", border: "1px solid var(--put)", background: "var(--put-dim)", color: "var(--put)", fontSize: 12 }}>
              <span>Failed to load vaults: {error}</span>
              <button type="button" onClick={() => setAttempt(a => a + 1)} style={{
                background: "none", border: "1px solid var(--put)", color: "var(--put)", padding: "4px 12px", cursor: "pointer", fontSize: 11,
              }}>
                Retry
              </button>
            </div>
          )}

          {vaults && selected.length < 2 && (
            <div style={{ padding: "32px 16px", border: "1px dashed var(--border-default)", textAlign: "center", fontSize: 13, color: "var(--text-mid)" }}>
              Select at least 2 vaults to compare.
              <div style={{ marginTop: 12 }}>
                <Link href="/vaults" style={{ color: "var(--brand)", fontWeight: 700, textDecoration: "none" }}>
                  Back to vaults →
                </Link>
              </div>
            </div>
          )}

          {vaults && selected.length >= 2 && (
            <>
              {unknownCount > 0 && (
                <p role="status" style={{ fontSize: 11, color: "var(--atm)", marginBottom: 12 }}>
                  {unknownCount} unknown {unknownCount === 1 ? "vault was" : "vaults were"} left out of this comparison.
                </p>
              )}
              <div style={{ overflowX: "auto", border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 120 + selected.length * 170 }}>
                  <caption className="sr-only">Side-by-side comparison of selected vaults</caption>
                  <thead>
                    <tr>
                      <th scope="col" style={{ ...ROW_HEADER_STYLE, borderBottom: "1px solid var(--border-default)" }}>
                        <span className="sr-only">Metric</span>
                      </th>
                      {selected.map(v => (
                        <th scope="col" key={v.id} style={{ ...CELL_STYLE, borderBottom: "1px solid var(--border-default)", color: "var(--text-hi)" }}>
                          <Link href={`/vaults/${v.id}`} style={{ color: "var(--text-hi)", fontWeight: 700, textDecoration: "none" }}>
                            {v.name}
                          </Link>
                          <div style={{ fontSize: 10, color: "var(--text-lo)", fontWeight: 400 }}>{v.underlying}/USD</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map(group => (
                      <SectionRows key={group.section} section={group.section} rows={group.rows} vaults={selected} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Disclaimer */}
          <div style={{
            marginTop: 40, padding: "14px 16px",
            border: "1px solid var(--border-subtle)", background: "var(--bg-raised)",
            fontSize: 11, color: "var(--text-lo)", lineHeight: 1.6,
          }}>
            <strong style={{ color: "var(--text-mid)" }}>Risk Disclosure:</strong>{" "}
            Fees and risk characteristics shown here are summaries. Read each vault&apos;s payoff explanation before depositing.
            Past APY does not guarantee future returns. Vault smart contracts are unaudited.
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionRows({ section, rows, vaults }: { section: string; rows: MetricRow[]; vaults: VaultSummary[] }) {
  return (
    <>
      <tr>
        <th scope="rowgroup" colSpan={vaults.length + 1} style={{ ...LABEL_STYLE, textAlign: "left", padding: "10px 12px 6px", background: "var(--bg-overlay)" }}>
          {section}
        </th>
      </tr>
      {rows.map(row => (
        <tr key={row.label}>
          <th scope="row" style={ROW_HEADER_STYLE}>{row.label}</th>
          {vaults.map(v => (
            <td key={v.id} className="num" style={{
              ...CELL_STYLE,
              color: row.emphasis ? "var(--call)" : CELL_STYLE.color,
              fontWeight: row.emphasis ? 700 : 400,
            }}>
              {row.value(v)}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default function VaultComparePage() {
  return (
    <Suspense fallback={<div style={{ background: "var(--bg)", minHeight: "100vh" }} />}>
      <VaultCompare />
    </Suspense>
  );
}
