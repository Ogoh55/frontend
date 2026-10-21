"use client";

/**
 * VaultHealthPanel
 *
 * Full health-score panel for the vault detail page sidebar.
 * Shows:
 *  - Composite score ring / numeric display
 *  - Letter grade with plain-language label
 *  - 5-factor breakdown with percentage bars and score values
 *  - Methodology footnote
 */

import React, { useState } from "react";
import type { VaultHealthScore } from "../lib/vaultHealth";
import { gradeColor, gradeBg, gradeLabel } from "../lib/vaultHealth";

interface VaultHealthPanelProps {
  healthScore: VaultHealthScore;
}

// Map a 0–100 factor score to a bar colour.
function factorBarColor(score: number): string {
  if (score >= 70) return "var(--call)";
  if (score >= 45) return "var(--atm)";
  return "var(--put)";
}

export function VaultHealthPanel({ healthScore }: VaultHealthPanelProps) {
  const { grade, composite, factors } = healthScore;
  const color  = gradeColor(grade);
  const bg     = gradeBg(grade);
  const label  = gradeLabel(grade);

  const [showMethodology, setShowMethodology] = useState(false);

  return (
    <div
      style={{
        border: `1px solid ${color}`,
        background: "var(--bg-raised)",
        padding: 0,
        overflow: "hidden",
      }}
      aria-label={`Vault Health Score: Grade ${grade}, ${composite} out of 100. ${label}`}
    >
      {/* Header row */}
      <div style={{
        padding: "10px 14px",
        background: bg,
        borderBottom: `1px solid ${color}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color,
        }}>
          Vault Health Score
        </span>
        {/* Grade pill */}
        <span style={{
          display: "inline-flex",
          alignItems: "baseline",
          gap: 4,
          padding: "2px 8px",
          background: "var(--bg-overlay)",
          border: `1px solid ${color}`,
        }}>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 18,
            fontWeight: 700,
            lineHeight: 1,
            color,
          }}>
            {grade}
          </span>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-mid)",
          }}>
            {composite}/100
          </span>
        </span>
      </div>

      <div style={{ padding: "12px 14px" }}>
        {/* Plain-language summary */}
        <p style={{ fontSize: 11, color: "var(--text-mid)", lineHeight: 1.5, margin: "0 0 12px" }}>
          {label}
        </p>

        {/* Score bar — composite */}
        <div style={{ marginBottom: 14 }}>
          <div style={{
            height: 6,
            background: "var(--bg-overlay)",
            borderRadius: 1,
            overflow: "hidden",
          }}>
            <div style={{
              height: "100%",
              width: `${composite}%`,
              background: color,
              transition: "width 500ms ease",
            }} />
          </div>
        </div>

        {/* Factor breakdown */}
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {Object.values(factors).map(f => (
            <div key={f.label}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span
                  title={f.description}
                  style={{
                    fontSize: 10,
                    color: "var(--text-lo)",
                    cursor: "help",
                    borderBottom: "1px dotted var(--border-default)",
                  }}
                >
                  {f.label}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 600,
                  color: factorBarColor(f.score),
                }}>
                  {f.score}
                  <span style={{ color: "var(--text-lo)", fontWeight: 400 }}> / 100</span>
                </span>
              </div>
              {/* Factor bar */}
              <div style={{
                height: 3,
                background: "var(--bg-overlay)",
                borderRadius: 1,
                overflow: "hidden",
              }}>
                <div style={{
                  height: "100%",
                  width: `${f.score}%`,
                  background: factorBarColor(f.score),
                  transition: "width 500ms ease",
                }} />
              </div>
            </div>
          ))}
        </div>

        {/* Methodology toggle */}
        <div style={{ marginTop: 12, borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }}>
          <button
            onClick={() => setShowMethodology(v => !v)}
            aria-expanded={showMethodology}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-lo)",
              fontSize: 10,
              padding: 0,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span style={{ fontSize: 9, transform: showMethodology ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform 200ms" }}>▶</span>
            Scoring methodology
          </button>

          {showMethodology && (
            <div style={{
              marginTop: 8,
              fontSize: 10,
              color: "var(--text-lo)",
              lineHeight: 1.6,
            }}>
              <p style={{ margin: "0 0 6px" }}>
                The composite score is a weighted average of five factors:
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  {Object.values(factors).map(f => (
                    <tr key={f.label} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                      <td style={{ padding: "3px 0", fontSize: 9, color: "var(--text-lo)" }}>{f.label}</td>
                      <td style={{ padding: "3px 0", fontSize: 9, textAlign: "right", color: "var(--text-mid)", fontFamily: "var(--font-mono)" }}>
                        {Math.round(f.weight * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ margin: "8px 0 0", fontSize: 9, fontStyle: "italic" }}>
                Grades: A ≥ 80 · B ≥ 65 · C ≥ 50 · D ≥ 35 · E &lt; 35.
                Based on historical epoch data and vault parameters. Not financial advice.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
