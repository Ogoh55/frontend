"use client";

/**
 * VaultHealthBadge
 *
 * Compact badge displaying a vault's letter grade (A–E) and composite score.
 * Designed for use on the vaults listing page alongside or in place of the
 * riskRating badge.
 *
 * Renders a small coloured box with:
 *   - The letter grade (A–E)
 *   - The numeric score (e.g. "78")
 *   - An accessible tooltip on hover/focus listing the five factor scores
 */

import React, { useState, useRef } from "react";
import type { VaultHealthScore } from "../lib/vaultHealth";
import { gradeColor, gradeBg, gradeLabel } from "../lib/vaultHealth";

interface VaultHealthBadgeProps {
  healthScore: VaultHealthScore;
  /** Optional extra CSS class. */
  className?: string;
}

export function VaultHealthBadge({ healthScore }: VaultHealthBadgeProps) {
  const { grade, composite, factors } = healthScore;
  const color = gradeColor(grade);
  const bg    = gradeBg(grade);
  const label = gradeLabel(grade);

  const [tooltipVisible, setTooltipVisible] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  const tooltipId = `vault-health-tooltip-${grade}-${composite}`;

  return (
    <span
      ref={containerRef}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, position: "relative" }}
    >
      {/* Badge */}
      <span
        role="img"
        aria-label={`Vault health grade ${grade}: ${label} (score ${composite}/100)`}
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        tabIndex={0}
        onMouseEnter={() => setTooltipVisible(true)}
        onMouseLeave={() => setTooltipVisible(false)}
        onFocus={() => setTooltipVisible(true)}
        onBlur={() => setTooltipVisible(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 7px",
          background: bg,
          border: `1px solid ${color}`,
          color,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.04em",
          cursor: "default",
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontSize: 12, lineHeight: 1 }}>{grade}</span>
        <span style={{ opacity: 0.8, fontSize: 9 }}>{composite}</span>
      </span>

      {/* Tooltip */}
      {tooltipVisible && (
        <span
          id={tooltipId}
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            zIndex: 100,
            background: "var(--bg-overlay)",
            border: "1px solid var(--border-default)",
            padding: "10px 12px",
            minWidth: 220,
            pointerEvents: "none",
          }}
        >
          {/* Header */}
          <span style={{
            display: "block",
            fontSize: 10,
            fontWeight: 700,
            color,
            marginBottom: 6,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}>
            Health Grade {grade} · {composite}/100
          </span>
          <span style={{ display: "block", fontSize: 10, color: "var(--text-mid)", marginBottom: 8, lineHeight: 1.4 }}>
            {label}
          </span>
          {/* Factor rows */}
          {Object.values(factors).map(f => (
            <span key={f.label} style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 3 }}>
              <span style={{ fontSize: 9, color: "var(--text-lo)" }}>{f.label}</span>
              <span style={{
                fontSize: 9,
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color: f.score >= 70 ? "var(--call)" : f.score >= 45 ? "var(--atm)" : "var(--put)",
              }}>
                {f.score}
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
