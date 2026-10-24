"use client";

/**
 * OracleFeedAggregatorPanel (#248)
 *
 * Displays the live oracle aggregation state for a vault's underlying
 * asset. Shows:
 *  - Accepted median price with source count and age.
 *  - Per-feed status rows (accepted / stale / deviant / excluded).
 *  - HALT banner when the aggregator cannot produce a valid median.
 *  - Previous median and epoch-jump indicator.
 *
 * Data is passed in as props; fetching is the caller's responsibility.
 */

import React, { useState } from "react";
import type {
  AggregationResult,
  FeedReading,
  ExcludedFeed,
  AggregationStatus,
} from "../lib/vault/oracleAggregator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRICE_SCALE = 10_000_000n; // 7 decimal places

function fmtPrice(n: bigint): string {
  const s = n.toString().padStart(8, "0");
  const int = s.slice(0, s.length - 7) || "0";
  const frac = s.slice(s.length - 7);
  return `${int}.${frac.replace(/0+$/, "") || "0"}`;
}

function fmtAge(ts: number): string {
  const ageS = Math.round((Date.now() / 1000) - ts);
  if (ageS < 60) return `${ageS}s ago`;
  return `${Math.floor(ageS / 60)}m ${ageS % 60}s ago`;
}

const STATUS_CONFIG: Record<AggregationStatus, { label: string; color: string }> = {
  OK:           { label: "Live",          color: "var(--call)" },
  HALT_QUORUM:  { label: "Halted · Quorum", color: "var(--put)" },
  HALT_JUMP:    { label: "Halted · Jump",   color: "var(--put)" },
  HALT_NO_FEEDS:{ label: "Halted · No Feeds", color: "var(--put)" },
};

const EXCLUSION_LABELS: Record<string, string> = {
  stale:            "Stale",
  invalid_price:    "Invalid price",
  deviation:        "Deviant",
  dex_vwap_excluded:"DEX VWAP (ref-only)",
  non_finite:       "Non-finite",
};

// ---------------------------------------------------------------------------
// Accepted feed row
// ---------------------------------------------------------------------------

function AcceptedRow({ feed }: { feed: FeedReading }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 120px 90px 80px",
        gap: 8,
        padding: "6px 12px",
        fontSize: 11,
        borderBottom: "1px solid var(--border-default)",
        alignItems: "center",
        color: "var(--text-mid)",
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-hi)" }}>
        {feed.feedId}
        <span
          style={{
            marginLeft: 6,
            fontSize: 9,
            color: "var(--text-lo)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {feed.provenance}
        </span>
      </span>
      <span style={{ fontFamily: "var(--font-mono)" }}>{fmtPrice(feed.price)}</span>
      <span style={{ color: "var(--text-lo)" }}>{fmtAge(feed.timestamp)}</span>
      <span
        style={{
          fontSize: 10,
          color: "var(--call)",
          textAlign: "right",
          fontWeight: 600,
        }}
      >
        ✓ accepted
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Excluded feed row
// ---------------------------------------------------------------------------

function ExcludedRow({ exc }: { exc: ExcludedFeed }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 120px 90px 80px",
        gap: 8,
        padding: "6px 12px",
        fontSize: 11,
        borderBottom: "1px solid var(--border-default)",
        alignItems: "center",
        color: "var(--text-lo)",
        opacity: 0.7,
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)" }}>{exc.feedId}</span>
      <span style={{ fontFamily: "var(--font-mono)" }}>{fmtPrice(exc.rejectedPrice)}</span>
      <span>—</span>
      <span
        style={{
          fontSize: 10,
          color: exc.reason === "deviation" ? "var(--atm)" : "var(--put)",
          textAlign: "right",
          fontWeight: 600,
        }}
      >
        ✗ {EXCLUSION_LABELS[exc.reason] ?? exc.reason}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feed table header
// ---------------------------------------------------------------------------

function FeedTableHeader() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 120px 90px 80px",
        gap: 8,
        padding: "5px 12px",
        fontSize: 10,
        color: "var(--text-lo)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        borderBottom: "1px solid var(--border-default)",
      }}
    >
      <span>Feed ID</span>
      <span>Price</span>
      <span>Age</span>
      <span style={{ textAlign: "right" }}>Status</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

interface OracleFeedAggregatorPanelProps {
  /** The latest aggregation result for this vault's underlying asset. */
  result: AggregationResult | null;
  /** The previous epoch's accepted median (for the jump indicator). */
  previousMedian?: bigint | null;
  loading?: boolean;
}

export function OracleFeedAggregatorPanel({
  result,
  previousMedian,
  loading = false,
}: OracleFeedAggregatorPanelProps) {
  const [showExcluded, setShowExcluded] = useState(false);

  const status = result?.status ?? null;
  const statusCfg = status ? STATUS_CONFIG[status] : null;
  const isHalt = status && status !== "OK";

  let jumpPct: number | null = null;
  if (result?.median && previousMedian && previousMedian > 0n) {
    const diff = result.median > previousMedian
      ? result.median - previousMedian
      : previousMedian - result.median;
    jumpPct = Number(diff * 10_000n / previousMedian) / 100;
  }

  return (
    <section
      style={{
        border: `1px solid ${isHalt ? "var(--put)" : "var(--border-default)"}`,
        background: "var(--bg-raised)",
      }}
      aria-label="Oracle feed aggregation"
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-default)",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13 }}>
          Oracle Feeds
          {result && (
            <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 11, color: "var(--text-lo)" }}>
              {result.asset} · {result.kind}
            </span>
          )}
        </span>
        {statusCfg && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: statusCfg.color,
              display: "flex",
              alignItems: "center",
              gap: 5,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
            role="status"
            aria-label={`Oracle status: ${statusCfg.label}`}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: statusCfg.color,
              }}
            />
            {statusCfg.label}
          </span>
        )}
      </div>

      {/* HALT banner */}
      {isHalt && result && (
        <div
          style={{
            padding: "10px 16px",
            background: "rgba(var(--put-rgb, 220,53,69), 0.08)",
            borderBottom: "1px solid var(--put)",
            fontSize: 11,
            color: "var(--put)",
          }}
          role="alert"
          aria-live="assertive"
        >
          <span style={{ fontWeight: 700 }}>
            {STATUS_CONFIG[result.status].label}
          </span>
          {" — "}
          {result.status === "HALT_QUORUM" &&
            `Only ${result.acceptedFeeds.length} valid feed${result.acceptedFeeds.length !== 1 ? "s" : ""} after exclusions. Epoch cannot advance.`}
          {result.status === "HALT_JUMP" &&
            `Price jumped ${jumpPct !== null ? `${jumpPct.toFixed(2)}%` : ""} vs previous epoch median — exceeds max epoch-jump bound. Epoch cannot advance.`}
          {result.status === "HALT_NO_FEEDS" &&
            "No feeds were supplied. Epoch cannot advance."}
        </div>
      )}

      {loading && (
        <div style={{ padding: "20px 16px", fontSize: 12, color: "var(--text-lo)", textAlign: "center" }}>
          Loading oracle data…
        </div>
      )}

      {!loading && result && (
        <div>
          {/* Summary stats */}
          <div
            style={{
              display: "flex",
              gap: 24,
              padding: "10px 16px",
              borderBottom: "1px solid var(--border-default)",
              flexWrap: "wrap",
            }}
          >
            {result.status === "OK" && result.median !== null && (
              <Stat
                label="Median Price"
                value={fmtPrice(result.median)}
                valueColor="var(--call)"
              />
            )}
            <Stat
              label="Accepted Feeds"
              value={`${result.acceptedFeeds.length}`}
            />
            {result.excludedFeeds.length > 0 && (
              <Stat
                label="Excluded Feeds"
                value={`${result.excludedFeeds.length}`}
                valueColor="var(--put)"
              />
            )}
            {result.oldestAcceptedAt !== null && (
              <Stat
                label="Oldest Source"
                value={fmtAge(result.oldestAcceptedAt)}
              />
            )}
            {previousMedian && result.median && jumpPct !== null && (
              <Stat
                label="vs Prev Epoch"
                value={`${jumpPct >= 0 ? "+" : ""}${jumpPct.toFixed(2)}%`}
                valueColor={
                  Math.abs(jumpPct) > 5
                    ? "var(--put)"
                    : Math.abs(jumpPct) > 2
                    ? "var(--atm)"
                    : "var(--call)"
                }
              />
            )}
          </div>

          {/* Feed table */}
          {(result.acceptedFeeds.length > 0 || result.excludedFeeds.length > 0) && (
            <div>
              <FeedTableHeader />
              {result.acceptedFeeds.map(f => (
                <AcceptedRow key={f.feedId} feed={f} />
              ))}
              {result.excludedFeeds.length > 0 && (
                <>
                  <button
                    onClick={() => setShowExcluded(v => !v)}
                    style={{
                      width: "100%",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: "6px 12px",
                      fontSize: 10,
                      color: "var(--text-lo)",
                      textAlign: "left",
                      borderBottom: showExcluded
                        ? "none"
                        : "1px solid var(--border-default)",
                    }}
                    aria-expanded={showExcluded}
                  >
                    {showExcluded ? "▲ Hide" : "▼ Show"} {result.excludedFeeds.length} excluded feed
                    {result.excludedFeeds.length !== 1 ? "s" : ""}
                  </button>
                  {showExcluded &&
                    result.excludedFeeds.map(e => (
                      <ExcludedRow key={e.feedId} exc={e} />
                    ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {!loading && !result && (
        <div style={{ padding: "20px 16px", fontSize: 12, color: "var(--text-lo)", textAlign: "center" }}>
          No oracle data available for this epoch.
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
      <span
        style={{
          fontSize: 10,
          color: "var(--text-lo)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: valueColor,
          fontFamily: "var(--font-mono)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
