"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppHeader } from "../../../components/AppHeader";
import { WalletConnect } from "../../../components/WalletConnect";
import {
  capacityUtilization,
  effectiveStatus,
  filterVaults,
  fetchVaults,
  fmtFeePct,
  fmtPct,
  fmtUsd,
  parseVaultQuery,
  serializeVaultQuery,
  sortVaults,
  totalFeePct,
  VAULT_COMPARE_MAX,
  VAULT_RISK_LABELS,
  VAULT_SORT_LABELS,
  VAULT_STATUS_LABELS,
  VAULT_STRATEGY_LABELS,
  type RiskRating,
  type VaultQuery,
  type VaultSortKey,
  type VaultStatus,
  type VaultStrategy,
  type VaultSummary,
} from "../../../lib/api/vaults";
import { useFlag } from "../../../lib/flags";

const ABSENT = "—";

/** Metrics where a smaller value is the better one, so the first click sorts ascending. */
const SORT_DEFAULT_DIR: Record<VaultSortKey, "asc" | "desc"> = {
  apy: "desc",
  utilization: "desc",
  tvl: "desc",
  drawdown: "asc",
  fees: "asc",
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

const LABEL_STYLE = { fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)" } as const;

const SELECT_STYLE = {
  background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-hi)",
  fontSize: 12, padding: "6px 8px", minWidth: 140,
} as const;

const TH_STYLE = {
  ...LABEL_STYLE, padding: "8px 10px", textAlign: "left", whiteSpace: "nowrap", borderBottom: "1px solid var(--border-default)",
} as const;

const TD_STYLE = { padding: "10px", fontSize: 12, color: "var(--text-mid)", borderBottom: "1px solid var(--border-subtle)", whiteSpace: "nowrap" } as const;

function VaultsIndex() {
  const vaultsEnabled = useFlag("vaults");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [apyTooltip, setApyTooltip] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultsEnabled) return;
    let cancelled = false;
    setError(null);
    fetchVaults({ enabled: vaultsEnabled })
      .then(v => { if (!cancelled) setVaults(v); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error"); });
    return () => { cancelled = true; };
  }, [attempt, vaultsEnabled]);

  const underlyings = useMemo(
    () => [...new Set((vaults ?? []).map(v => v.underlying))].sort(),
    [vaults]
  );
  const query = useMemo(() => parseVaultQuery(searchParams, underlyings), [searchParams, underlyings]);
  const rows = useMemo(
    () => (vaults ? sortVaults(filterVaults(vaults, query), query) : []),
    [vaults, query]
  );
  const tenors = useMemo(
    () => [...new Set((vaults ?? []).map(v => v.epochDays))].sort((a, b) => a - b),
    [vaults]
  );

  // State lives in the URL. Each change is a push, so back/forward walks through filter states.
  const update = useCallback((patch: Partial<VaultQuery>) => {
    const qs = serializeVaultQuery({ ...query, ...patch });
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [query, pathname, router]);

  const onSort = (key: VaultSortKey) => {
    update(query.sort === key
      ? { dir: query.dir === "asc" ? "desc" : "asc" }
      : { sort: key, dir: SORT_DEFAULT_DIR[key] });
  };

  const toggleCompare = (id: string) => {
    if (query.ids.includes(id)) {
      update({ ids: query.ids.filter(x => x !== id) });
    } else if (query.ids.length < VAULT_COMPARE_MAX) {
      update({ ids: [...query.ids, id] });
    }
  };

  const hasFilters = Boolean(query.strategy || query.underlying || query.status || query.risk) || query.tenor !== null;
  const loading = vaultsEnabled && vaults === null && error === null;

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
          <div style={{ marginBottom: 24 }}>
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

          {/* Filters */}
          {vaultsEnabled && vaults && (
            <div role="group" aria-label="Filter vaults" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 16 }}>
              <FilterSelect label="Strategy" value={query.strategy ?? ""} onChange={v => update({ strategy: (v || null) as VaultStrategy | null })}
                options={Object.entries(VAULT_STRATEGY_LABELS).map(([value, label]) => ({ value, label }))} />
              <FilterSelect label="Underlying" value={query.underlying ?? ""} onChange={v => update({ underlying: v || null })}
                options={underlyings.map(u => ({ value: u, label: u }))} />
              <FilterSelect label="Status" value={query.status ?? ""} onChange={v => update({ status: (v || null) as VaultStatus | null })}
                options={Object.entries(VAULT_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
              <FilterSelect label="Risk" value={query.risk ?? ""} onChange={v => update({ risk: (v || null) as RiskRating | null })}
                options={Object.entries(VAULT_RISK_LABELS).map(([value, label]) => ({ value, label }))} />
              <FilterSelect label="Tenor" value={query.tenor === null ? "" : String(query.tenor)} onChange={v => update({ tenor: v ? Number(v) : null })}
                options={tenors.map(d => ({ value: String(d), label: `${d}-day epochs` }))} />
              {hasFilters && (
                <button type="button" onClick={() => update({ strategy: null, underlying: null, status: null, risk: null, tenor: null })} style={{
                  ...SELECT_STYLE, minWidth: 0, cursor: "pointer", color: "var(--text-lo)",
                }}>
                  Clear filters
                </button>
              )}
            </div>
          )}

          {/* Compare bar */}
          {vaultsEnabled && vaults && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, padding: "10px 12px", marginBottom: 12, border: "1px solid var(--border-subtle)", background: "var(--bg-raised)" }}>
              <span style={{ fontSize: 12, color: "var(--text-mid)" }}>
                {query.ids.length === 0
                  ? `Select 2–${VAULT_COMPARE_MAX} vaults to compare side by side.`
                  : `${query.ids.length} selected for comparison.`}
              </span>
              {query.ids.length >= 2 ? (
                <Link href={`/vaults/compare?ids=${query.ids.join(",")}`} style={{
                  padding: "6px 14px", background: "var(--brand)", color: "var(--bg)", fontSize: 12, fontWeight: 700, textDecoration: "none",
                }}>
                  Compare →
                </Link>
              ) : (
                <span style={{ fontSize: 11, color: "var(--text-lo)" }}>Compare unlocks at 2 vaults</span>
              )}
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[1, 2, 3].map(i => (
                <div key={i} className="skeleton" style={{ height: 44, width: "100%" }} />
              ))}
            </div>
          )}

          {/* Error with retry */}
          {vaultsEnabled && error && (
            <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 16px", border: "1px solid var(--put)", background: "var(--put-dim)", color: "var(--put)", fontSize: 12 }}>
              <span>Failed to load vaults: {error}</span>
              <button type="button" onClick={() => setAttempt(a => a + 1)} style={{
                background: "none", border: "1px solid var(--put)", color: "var(--put)", padding: "4px 12px", cursor: "pointer", fontSize: 11,
              }}>
                Retry
              </button>
            </div>
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

          {/* Vaults disabled */}
          {!loading && !error && !vaultsEnabled && vaults && vaults.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--text-mid)" }}>Vaults are not yet available.</div>
          )}

          {/* Empty */}
          {vaultsEnabled && vaults && rows.length === 0 && (
            <div style={{ padding: "32px 16px", border: "1px dashed var(--border-default)", textAlign: "center", fontSize: 13, color: "var(--text-mid)" }}>
              {vaults.length === 0 ? "No vaults are available yet." : "No vaults match these filters."}
              {hasFilters && (
                <div style={{ marginTop: 12 }}>
                  <button type="button" onClick={() => update({ strategy: null, underlying: null, status: null, risk: null, tenor: null })} style={{
                    background: "none", border: "1px solid var(--border-default)", color: "var(--text-lo)", padding: "4px 12px", cursor: "pointer", fontSize: 11,
                  }}>
                    Clear filters
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Vault table */}
          {vaultsEnabled && vaults && rows.length > 0 && (
            <div style={{ overflowX: "auto", border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 960 }}>
                <caption className="sr-only">
                  Option-writing vaults. Use the column headers to sort.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={TH_STYLE}><span className="sr-only">Compare</span></th>
                    <th scope="col" style={TH_STYLE}>Vault</th>
                    <th scope="col" style={TH_STYLE}>Strategy</th>
                    <th scope="col" style={TH_STYLE}>Status</th>
                    <th scope="col" style={TH_STYLE}>Risk</th>
                    <th scope="col" style={TH_STYLE}>Tenor</th>
                    <SortHeader label="APY" sortKey="apy" query={query} onSort={onSort} />
                    <SortHeader label="Capacity used" sortKey="utilization" query={query} onSort={onSort} />
                    <SortHeader label="TVL" sortKey="tvl" query={query} onSort={onSort} />
                    <SortHeader label="Max drawdown" sortKey="drawdown" query={query} onSort={onSort} />
                    <SortHeader label="Fees" sortKey="fees" query={query} onSort={onSort} />
                    <th scope="col" style={TH_STYLE}><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(vault => {
                    const selected = query.ids.includes(vault.id);
                    const disabled = !selected && query.ids.length >= VAULT_COMPARE_MAX;
                    const status = effectiveStatus(vault);
                    return (
                      <tr key={vault.id}>
                        <td style={TD_STYLE}>
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={disabled}
                            onChange={() => toggleCompare(vault.id)}
                            aria-label={`Compare ${vault.name}`}
                          />
                        </td>
                        <td style={TD_STYLE}>
                          <div style={{ fontWeight: 700, color: "var(--text-hi)" }}>{vault.name}</div>
                          <div style={{ fontSize: 10, color: "var(--text-lo)" }}>{vault.underlying}/USD</div>
                        </td>
                        <td style={TD_STYLE}>{VAULT_STRATEGY_LABELS[vault.strategy]}</td>
                        <td style={TD_STYLE}>{VAULT_STATUS_LABELS[status]}</td>
                        <td style={TD_STYLE}>
                          <span style={{
                            fontSize: 10, padding: "2px 8px", textTransform: "uppercase", letterSpacing: "0.06em",
                            background: RISK_BG[vault.riskRating], color: RISK_COLORS[vault.riskRating],
                            border: `1px solid ${RISK_COLORS[vault.riskRating]}`,
                          }}>
                            {VAULT_RISK_LABELS[vault.riskRating]}
                          </span>
                        </td>
                        <td className="num" style={TD_STYLE}>{vault.epochDays}D</td>
                        <td className="num" style={{ ...TD_STYLE, color: "var(--call)", fontWeight: 700 }}>
                          {fmtPct(vault.apy)}
                          <button
                            type="button"
                            onClick={() => setApyTooltip(vault.apyMethodology)}
                            aria-label={`APY methodology for ${vault.name}`}
                            title="APY methodology"
                            style={{ marginLeft: 4, background: "none", border: "none", cursor: "pointer", color: "var(--text-lo)", fontSize: 9, padding: 0, textDecoration: "underline" }}
                          >ⓘ</button>
                        </td>
                        <td className="num" style={{ ...TD_STYLE, color: capacityUtilization(vault) >= 0.9 ? "var(--put)" : capacityUtilization(vault) >= 0.7 ? "var(--atm)" : "var(--call)" }}>
                          {fmtPct(capacityUtilization(vault), 0)}
                        </td>
                        <td className="num" style={TD_STYLE}>{fmtUsd(vault.tvl)}</td>
                        <td className="num" style={TD_STYLE}>{fmtPct(vault.maxDrawdownPct)}</td>
                        <td className="num" style={TD_STYLE}>{fmtFeePct(totalFeePct(vault))}</td>
                        <td style={TD_STYLE}>
                          <Link href={`/vaults/${vault.id}`} style={{ color: "var(--brand)", fontWeight: 700, textDecoration: "none" }}>
                            View →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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

function FilterSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={LABEL_STYLE}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} style={SELECT_STYLE}>
        <option value="">All</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function SortHeader({ label, sortKey, query, onSort }: {
  label: string;
  sortKey: VaultSortKey;
  query: VaultQuery;
  onSort: (key: VaultSortKey) => void;
}) {
  const active = query.sort === sortKey;
  const arrow = query.dir === "asc" ? "▲" : "▼";
  return (
    <th scope="col" aria-sort={active ? (query.dir === "asc" ? "ascending" : "descending") : "none"} style={TH_STYLE}>
      <button type="button" onClick={() => onSort(sortKey)} aria-label={`Sort by ${VAULT_SORT_LABELS[sortKey]}`} style={{
        ...LABEL_STYLE, background: "none", border: "none", padding: 0, cursor: "pointer", color: active ? "var(--text-hi)" : "var(--text-lo)",
      }}>
        {label}{active && <span aria-hidden="true"> {arrow}</span>}
      </button>
    </th>
  );
}

export default function VaultsPage() {
  return (
    <Suspense fallback={<div style={{ background: "var(--bg)", minHeight: "100vh" }} />}>
      <VaultsIndex />
    </Suspense>
  );
}
