"use client";

/**
 * VaultExecutionPanel (#245)
 *
 * Displays the option-sale execution history for a vault epoch:
 *  - Fill results per leg (venue, premium collected, fill price vs reference).
 *  - Unfilled legs with the reason (no acceptable quote / expired).
 *  - Epoch execution summary (total premium, last fill timestamp).
 *
 * The panel is read-only; execution itself is driven by the keeper backend.
 */

import React, { useState } from "react";
import type {
  EpochExecutionSummary,
  FillResult,
  ExecutionVenue,
} from "../lib/vault/optionSaleExecution";
import type { OptionKind } from "../lib/vault/strategyTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtUnits(n: bigint, decimals = 7): string {
  const s = n.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  const frac = s.slice(s.length - decimals).replace(/0+$/, "") || "0";
  return `${int}.${frac}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const VENUE_COLOR: Record<ExecutionVenue, string> = {
  auction: "var(--call)",
  rfq:     "var(--brand)",
  amm:     "var(--atm)",
};

const KIND_COLOR: Record<OptionKind, string> = {
  Call: "var(--call)",
  Put:  "var(--put)",
};

function premiumSlippage(fill: FillResult): number | null {
  if (fill.referencePriceUsed === 0n) return null;
  const slippage = fill.referencePriceUsed - fill.premiumPerContract;
  return Number((slippage * 10_000n) / fill.referencePriceUsed) / 100; // percent
}

// ---------------------------------------------------------------------------
// Single fill row
// ---------------------------------------------------------------------------

interface FillRowProps {
  fill: FillResult;
  index: number;
}

function FillRow({ fill, index }: FillRowProps) {
  const slippage = premiumSlippage(fill);
  const slippageColor =
    slippage === null ? "var(--text-lo)"
    : slippage < 5 ? "var(--call)"
    : slippage < 15 ? "var(--atm)"
    : "var(--put)";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "28px 80px 60px 1fr 1fr 1fr 80px",
        gap: 8,
        padding: "7px 12px",
        fontSize: 11,
        color: "var(--text-mid)",
        borderBottom: "1px solid var(--border-default)",
        alignItems: "center",
      }}
    >
      <span style={{ color: "var(--text-lo)" }}>{index + 1}</span>
      <span style={{ color: KIND_COLOR[fill.option.kind], fontWeight: 600 }}>
        {fill.option.kind} {fmtUnits(fill.option.strike)}
      </span>
      <span style={{ color: VENUE_COLOR[fill.venue], textTransform: "uppercase", fontWeight: 600 }}>
        {fill.venue}
      </span>
      <span style={{ fontFamily: "var(--font-mono)" }}>
        {fmtUnits(fill.premiumPerContract)} / contract
      </span>
      <span style={{ fontFamily: "var(--font-mono)", color: "var(--call)" }}>
        +{fmtUnits(fill.totalPremiumCollected)} total
      </span>
      <span style={{ color: slippageColor }}>
        {slippage === null ? "—" : `${slippage.toFixed(2)}% vs ref`}
      </span>
      <span style={{ color: "var(--text-lo)", textAlign: "right" }}>
        {fmtDate(fill.filledAt)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header row
// ---------------------------------------------------------------------------

function TableHeader() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "28px 80px 60px 1fr 1fr 1fr 80px",
        gap: 8,
        padding: "6px 12px",
        fontSize: 10,
        color: "var(--text-lo)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        borderBottom: "1px solid var(--border-default)",
      }}
    >
      <span>#</span>
      <span>Strike</span>
      <span>Venue</span>
      <span>Per Contract</span>
      <span>Total Premium</span>
      <span>vs Reference</span>
      <span style={{ textAlign: "right" }}>Filled At</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

interface VaultExecutionPanelProps {
  summary: EpochExecutionSummary | null;
  /** Whether the panel is in a loading state. */
  loading?: boolean;
}

export function VaultExecutionPanel({ summary, loading = false }: VaultExecutionPanelProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <section
      style={{
        border: "1px solid var(--border-default)",
        background: "var(--bg-raised)",
      }}
      aria-label="Epoch execution details"
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "var(--text-hi)",
        }}
        aria-expanded={expanded}
      >
        <span style={{ fontWeight: 700, fontSize: 13 }}>
          Option Sale Execution
          {summary && (
            <span style={{ marginLeft: 10, fontWeight: 400, fontSize: 11, color: "var(--text-lo)" }}>
              Epoch {summary.epoch}
            </span>
          )}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-lo)" }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div>
          {/* Summary bar */}
          {summary && (
            <div
              style={{
                display: "flex",
                gap: 24,
                padding: "10px 16px",
                borderTop: "1px solid var(--border-default)",
                borderBottom: "1px solid var(--border-default)",
                fontSize: 11,
                flexWrap: "wrap",
              }}
            >
              <Stat
                label="Total Premium"
                value={`+${fmtUnits(summary.totalPremiumCollected)}`}
                valueColor="var(--call)"
              />
              <Stat
                label="Filled Legs"
                value={`${summary.fills.length}`}
              />
              {summary.unfilledLegs > 0 && (
                <Stat
                  label="Unfilled Legs"
                  value={`${summary.unfilledLegs}`}
                  valueColor="var(--put)"
                />
              )}
              {summary.lastFillAt && (
                <Stat
                  label="Last Fill"
                  value={fmtDate(summary.lastFillAt)}
                />
              )}
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div style={{ padding: "20px 16px", fontSize: 12, color: "var(--text-lo)", textAlign: "center" }}>
              Loading execution data…
            </div>
          )}

          {/* Empty */}
          {!loading && (!summary || summary.fills.length === 0) && (
            <div style={{ padding: "20px 16px", fontSize: 12, color: "var(--text-lo)", textAlign: "center" }}>
              No fills recorded for this epoch yet.
            </div>
          )}

          {/* Fill table */}
          {!loading && summary && summary.fills.length > 0 && (
            <div role="table" aria-label="Fill results">
              <TableHeader />
              {summary.fills.map((fill, i) => (
                <FillRow key={fill.fillId} fill={fill} index={i} />
              ))}
            </div>
          )}

          {/* Unfilled legs notice */}
          {!loading && summary && summary.unfilledLegs > 0 && (
            <div
              style={{
                padding: "8px 16px",
                fontSize: 11,
                color: "var(--put)",
                borderTop: "1px solid var(--border-default)",
              }}
            >
              ⚠ {summary.unfilledLegs} leg{summary.unfilledLegs > 1 ? "s" : ""} received no acceptable
              quote — no position was opened for those legs this epoch.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tiny stat cell
// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  valueColor = "var(--text-hi)",
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: valueColor, fontFamily: "var(--font-mono)" }}>
        {value}
      </span>
    </div>
  );
}
