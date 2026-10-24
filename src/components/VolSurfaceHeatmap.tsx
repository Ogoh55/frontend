"use client";

import { useQuant } from "../lib/hooks/useQuant";
import type { SurfaceCell } from "../lib/volSurface";

const MONEYNESS = [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2];
const EXPIRY_DAYS = [7, 14, 30, 60, 90, 180];

interface Props {
  baseVol: number;
  selectedExpiryDays?: number;
}

function cellColor(cell: SurfaceCell, minIv: number, maxIv: number): string {
  const t = maxIv > minIv ? (cell.iv - minIv) / (maxIv - minIv) : 0.5;
  const alpha = 0.06 + t * 0.34;
  return `rgba(181,150,101,${alpha.toFixed(3)})`;
}

export function VolSurfaceHeatmap({ baseVol, selectedExpiryDays }: Props) {
  const { data: grid, loading } = useQuant("surfaceGrid", {
    baseVol,
    moneyness: MONEYNESS,
    expiryDays: EXPIRY_DAYS,
  });

  if (!grid) {
    return (
      <div style={{ fontSize: 10, color: "var(--text-lo)", padding: 8 }}>
        {loading ? "Computing surface…" : "—"}
      </div>
    );
  }

  const allIvs = grid.flat().map(c => c.iv);
  const minIv = Math.min(...allIvs);
  const maxIv = Math.max(...allIvs);

  return (
    <div>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-lo)", marginBottom: 8 }}>
        Volatility Surface
      </div>
      {/* Horizontal scroll belongs to this element, not the page. */}
      <div className="zn-table-scroll zn-no-scrollbar">
      <table style={{ borderCollapse: "collapse" }}
        aria-label={`Implied volatility surface, ${(minIv * 100).toFixed(0)}% to ${(maxIv * 100).toFixed(0)}% IV, by strike moneyness and days to expiry`}>
        <thead>
          <tr>
            <th style={{ width: 36 }} />
            {MONEYNESS.map(m => (
              <th key={m} scope="col" style={{
                fontSize: 8, fontFamily: "var(--font-mono)", fontWeight: 500,
                color: m === 1 ? "var(--atm)" : "var(--text-lo)", padding: "0 0 4px",
              }}>
                {Math.round(m * 100)}%
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, i) => {
            const isSelectedExpiry = EXPIRY_DAYS[i] === selectedExpiryDays;
            return (
              <tr key={i} style={{ background: isSelectedExpiry ? "rgba(201,151,76,0.06)" : undefined }}>
                <th scope="row" style={{
                  fontSize: 9, fontFamily: "var(--font-mono)",
                  color: isSelectedExpiry ? "var(--atm)" : "var(--text-lo)",
                  fontWeight: isSelectedExpiry ? 700 : 400, paddingRight: 6, textAlign: "right",
                }}>
                  {EXPIRY_DAYS[i]}D
                </th>
                {row.map((cell, j) => {
                  const isAtm = cell.moneyness === 1;
                  return (
                    <td key={j}
                      title={`${Math.round(cell.moneyness * 100)}% strike, ${cell.days}D: ${(cell.iv * 100).toFixed(1)}% IV`}
                      style={{
                        width: 32, height: 24,
                        border: isAtm ? "1px solid rgba(201,151,76,0.4)" : "1px solid var(--border-subtle)",
                        background: cellColor(cell, minIv, maxIv),
                        textAlign: "center", fontSize: 8, fontFamily: "var(--font-mono)",
                        color: isAtm ? "var(--atm)" : "var(--text-mid)", fontWeight: isAtm ? 700 : 400,
                      }}>
                      {Math.round(cell.iv * 100)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <span className="num" style={{ fontSize: 9, color: "var(--text-lo)" }}>{(minIv * 100).toFixed(0)}%</span>
        <div style={{
          width: 96, height: 8,
          background: "linear-gradient(90deg, rgba(181,150,101,0.06), rgba(181,150,101,0.40))",
        }} />
        <span className="num" style={{ fontSize: 9, color: "var(--text-lo)" }}>{(maxIv * 100).toFixed(0)}%</span>
        <span style={{ fontSize: 9, color: "var(--text-lo)", marginLeft: 4 }}>Implied Vol</span>
      </div>
    </div>
  );
}
