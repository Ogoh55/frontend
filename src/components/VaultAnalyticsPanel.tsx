"use client";

import { useState, type KeyboardEvent } from "react";
import type { AttributionLeg, NavPoint, VaultAnalytics } from "../lib/api/vaults";

const LEG_LABELS: Record<AttributionLeg, string> = {
  covered_call_premium: "Covered call premium",
  csp_premium: "Cash-secured put premium",
  condor_credit: "Iron condor credits",
  wheel_assignment: "Wheel assignment effects",
};

const YIELD_LABELS: Record<VaultAnalytics["realisedYield"][number]["window"], string> = {
  last_epoch: "Last epoch",
  last_4_epochs: "Last 4 epochs",
  since_inception: "Since inception",
};

function fmtPct(v: number | null, signed = false) {
  if (v === null || !Number.isFinite(v)) return "Not provided";
  const s = (v * 100).toFixed(2);
  return `${signed && v > 0 ? "+" : ""}${s}%`;
}

function fmtUsd(v: number, dp = 4) {
  return `$${v.toFixed(dp)}`;
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtTimestamp(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
}

const sectionStyle = { border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 16 } as const;
const titleStyle = { fontSize: 11, fontWeight: 600, color: "var(--text-hi)", marginBottom: 12 } as const;
const thStyle = {
  padding: "6px 12px", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em",
  color: "var(--text-lo)", textAlign: "right", fontWeight: 500, background: "var(--bg-overlay)",
} as const;
const tdStyle = { padding: "8px 12px", fontSize: 11, textAlign: "right", color: "var(--text-mid)" } as const;

function NavChart({ points, active, onSelect }: { points: NavPoint[]; active: number; onSelect: (i: number) => void }) {
  const width = 720;
  const height = 200;
  const PAD = { t: 12, r: 12, b: 26, l: 56 };
  const W = width - PAD.l - PAD.r;
  const H = height - PAD.t - PAD.b;

  const navs = points.map(p => p.navPerShare);
  const lo = Math.min(...navs);
  const hi = Math.max(...navs);
  const range = Math.max(hi - lo, 1e-6);
  const toX = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const toY = (v: number) => H - ((v - lo) / range) * H;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(p.navPerShare).toFixed(1)}`).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="presentation" aria-hidden="true">
      <g transform={`translate(${PAD.l},${PAD.t})`}>
        {points.map((p, i) => p.epochEnd && (
          <g key={`marker-${p.epochNumber}`}>
            <line x1={toX(i)} y1={0} x2={toX(i)} y2={H} stroke="var(--border-subtle)" strokeDasharray="3 3" />
            <text x={toX(i)} y={H + 14} textAnchor="middle" fill="var(--text-lo)" fontSize={9} fontFamily="var(--font-mono)">
              #{p.epochNumber}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--brand)" strokeWidth={1.75} strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={`pt-${p.epochNumber}`} onClick={() => onSelect(i)} style={{ cursor: "pointer" }}>
            <circle
              cx={toX(i)}
              cy={toY(p.navPerShare)}
              r={i === active ? 5 : 3}
              fill={p.partial ? "var(--bg-raised)" : "var(--brand)"}
              stroke="var(--brand)"
              strokeWidth={1.5}
            />
            {p.feeEvent && (
              <text x={toX(i)} y={toY(p.navPerShare) - 8} textAnchor="middle" fill="var(--atm)" fontSize={9}>
                ▲
              </text>
            )}
          </g>
        ))}
        <text x={-8} y={toY(hi) + 4} textAnchor="end" fill="var(--text-lo)" fontSize={9} fontFamily="var(--font-mono)">
          {hi.toFixed(4)}
        </text>
        <text x={-8} y={toY(lo) + 4} textAnchor="end" fill="var(--text-lo)" fontSize={9} fontFamily="var(--font-mono)">
          {lo.toFixed(4)}
        </text>
        <line x1={toX(active)} y1={0} x2={toX(active)} y2={H} stroke="var(--text-lo)" strokeWidth={1} />
      </g>
    </svg>
  );
}

export function VaultAnalyticsPanel({ analytics }: { analytics: VaultAnalytics }) {
  const { navHistory, premiums, realisedYield, projectedYield, attribution } = analytics;
  const [active, setActive] = useState(Math.max(0, navHistory.length - 1));
  const safeActive = Math.min(active, Math.max(0, navHistory.length - 1));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = navHistory.length - 1;
    const next: Record<string, number> = {
      ArrowRight: safeActive + 1, ArrowUp: safeActive + 1,
      ArrowLeft: safeActive - 1, ArrowDown: safeActive - 1,
      Home: 0, End: last,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    setActive(Math.min(last, Math.max(0, next[e.key])));
  };

  const cur = navHistory[safeActive];
  const maxAttr = Math.max(0.0001, ...attribution.map(a => Math.abs(a.contribution)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Data range and refresh time */}
      <div style={{ ...sectionStyle, padding: "12px 16px", fontSize: 11, color: "var(--text-mid)", display: "flex", flexWrap: "wrap", gap: 16 }}>
        <span>Data range: <span className="num" style={{ color: "var(--text-hi)" }}>{fmtDate(analytics.dataFrom)} – {fmtDate(analytics.dataTo)}</span></span>
        <span>Refreshed: <span className="num" style={{ color: "var(--text-hi)" }}>{fmtTimestamp(analytics.refreshedAt)}</span></span>
        {analytics.partialData && (
          <span style={{ color: "var(--atm)" }}>Partial data: indexer backfill in progress. Hollow points are incomplete.</span>
        )}
      </div>

      {/* NAV per share */}
      <div style={sectionStyle}>
        <div style={titleStyle}>NAV per Share</div>
        {navHistory.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-lo)" }}>No completed epochs yet. NAV history appears after the first settlement.</div>
        ) : navHistory.length < 2 ? (
          <div style={{ fontSize: 12, color: "var(--text-lo)" }}>
            Only one epoch mark so far. A chart needs at least two.
          </div>
        ) : (
          <div
            role="group"
            tabIndex={0}
            aria-label={`NAV per share chart, ${navHistory.length} epoch marks. Use arrow keys, Home and End to move between epochs.`}
            onKeyDown={onKeyDown}
            style={{ outline: "none" }}
          >
            <NavChart points={navHistory} active={safeActive} onSelect={setActive} />
            {cur && (
              <div aria-live="polite" style={{ fontSize: 11, color: "var(--text-mid)", marginTop: 8 }}>
                Epoch <span className="num" style={{ color: "var(--text-hi)" }}>#{cur.epochNumber}</span> · {fmtDate(cur.date)} ·
                NAV <span className="num" style={{ color: "var(--text-hi)" }}>{fmtUsd(cur.navPerShare)}</span>
                {cur.partial && <span style={{ color: "var(--atm)" }}> · partial data</span>}
                {cur.feeEvent && <span style={{ color: "var(--atm)" }}> · NAV reset after fee event (not a loss)</span>}
              </div>
            )}
          </div>
        )}

        {/* Table alternative: same navHistory array as the chart */}
        {navHistory.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ fontSize: 11, color: "var(--text-mid)", cursor: "pointer" }}>View NAV data as table</summary>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
              <caption style={{ textAlign: "left", fontSize: 10, color: "var(--text-lo)", paddingBottom: 6 }}>
                NAV per share at each epoch settlement
              </caption>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                  {["Epoch", "Settlement", "NAV / share", "Notes"].map(h => (
                    <th key={h} scope="col" style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {navHistory.map(p => (
                  <tr key={p.epochNumber} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <th scope="row" className="num" style={{ ...tdStyle, color: "var(--text-lo)", fontWeight: 400 }}>#{p.epochNumber}</th>
                    <td className="num" style={tdStyle}>{fmtDate(p.date)}</td>
                    <td className="num" style={{ ...tdStyle, color: "var(--text-hi)" }}>{fmtUsd(p.navPerShare)}</td>
                    <td style={{ ...tdStyle, textAlign: "left", fontSize: 10 }}>
                      {[p.partial && "Partial", p.feeEvent && "Fee event reset"].filter(Boolean).join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      {/* Realised and projected yield */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Yield</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
              <th scope="col" style={{ ...thStyle, textAlign: "left" }}>Realised window</th>
              <th scope="col" style={thStyle}>Return</th>
            </tr>
          </thead>
          <tbody>
            {realisedYield.map(y => (
              <tr key={y.window} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 400 }}>{YIELD_LABELS[y.window]}</th>
                <td className="num" style={{ ...tdStyle, color: y.value !== null && y.value < 0 ? "var(--put)" : "var(--text-hi)" }}>
                  {fmtPct(y.value, true)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--bg-elevated)", fontSize: 11, color: "var(--text-mid)" }}>
          <div style={{ fontWeight: 600, color: "var(--text-hi)", marginBottom: 4 }}>Projected yield (estimate)</div>
          {projectedYield ? (
            <>
              <div className="num" style={{ marginBottom: 4 }}>{fmtPct(projectedYield.value)} annualised, forward-looking estimate</div>
              <div style={{ fontSize: 10, color: "var(--text-lo)", lineHeight: 1.5 }}>{projectedYield.methodology}</div>
            </>
          ) : (
            <div style={{ fontSize: 10, color: "var(--text-lo)" }}>The backend has not published a forward-looking estimate for this vault.</div>
          )}
        </div>
      </div>

      {/* Premium per epoch and cumulative fees */}
      <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-default)", fontSize: 11, fontWeight: 600, color: "var(--text-hi)" }}>
          Premium Collected per Epoch
        </div>
        {premiums.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-lo)" }}>No premium recorded yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {["Epoch", "Premium / share", "Fees / share", "Cumulative fees / share"].map(h => (
                  <th key={h} scope="col" style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {premiums.map(p => (
                <tr key={p.epochNumber} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <th scope="row" className="num" style={{ ...tdStyle, color: "var(--text-lo)", fontWeight: 400 }}>#{p.epochNumber}</th>
                  <td className="num" style={{ ...tdStyle, color: "var(--text-hi)" }}>{fmtUsd(p.premiumPerShare)}</td>
                  <td className="num" style={tdStyle}>{fmtUsd(p.feesPerShare)}</td>
                  <td className="num" style={tdStyle}>{fmtUsd(p.cumulativeFeesPerShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Attribution by strategy leg */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Return Attribution by Strategy Leg</div>
        {attribution.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-lo)" }}>No attribution available yet.</div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {attribution.map(a => (
              <li key={a.leg}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                  <span style={{ color: "var(--text-mid)" }}>{LEG_LABELS[a.leg]}</span>
                  <span className="num" style={{ color: a.contribution < 0 ? "var(--put)" : "var(--call)", fontWeight: 600 }}>
                    {fmtPct(a.contribution, true)}
                  </span>
                </div>
                <div style={{ height: 6, background: "var(--bg-overlay)" }} aria-hidden="true">
                  <div style={{
                    height: "100%",
                    width: `${(Math.abs(a.contribution) / maxAttr) * 100}%`,
                    background: a.contribution < 0 ? "var(--put)" : "var(--call)",
                  }} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <div style={{ marginTop: 12, fontSize: 10, color: "var(--text-lo)", lineHeight: 1.5 }}>
          Methodology: each leg&apos;s contribution is its compounded epoch return over the window, as reported by the backend, shown before fees.
        </div>
      </div>
    </div>
  );
}
