"use client";

import type { CompetitionScoringMethod, LeaderboardEntry } from "../../lib/api/types";
import {
  annotateTies,
  displayNameFor,
  entryStatusLabel,
  formatPercentReturn,
  formatRank,
  formatScore,
  formatSignedUsd,
  formatUsd,
  pageCount,
} from "../../lib/competitions";

export interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  scoringMethod: CompetitionScoringMethod;
  total: number;
  page: number;
  pageSize: number;
  search: string;
  loading?: boolean;
  highlightAddress?: string | null;
  onSearchChange: (value: string) => void;
  onPageChange: (page: number) => void;
  /** Copy shown when the board is empty (differs before/during/after). */
  emptyLabel?: string;
}

const HEADERS = ["#", "Trader", "Score", "% Return", "P&L", "Volume", "Trades", "Status"];

/**
 * Leaderboard (issue #93).
 *
 * Rows come from the API already paginated and filtered — search is a server
 * round-trip, not a filter over the current page, so "search by address" finds
 * an entrant on page 40. Ties share a rank (`=3`), disqualified entries stay
 * visible with their status rather than disappearing, and the viewer's own row
 * is highlighted so the personal rank card and the board agree.
 */
export function LeaderboardTable({
  entries,
  scoringMethod,
  total,
  page,
  pageSize,
  search,
  loading,
  highlightAddress,
  onSearchChange,
  onPageChange,
  emptyLabel = "No entries yet.",
}: LeaderboardTableProps) {
  const rows = annotateTies(entries);
  const pages = pageCount(total, pageSize);
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div data-testid="leaderboard">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <input
          aria-label="Search by address or display name"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search address or name"
          style={{
            width: 260, padding: "7px 9px", background: "var(--bg)", border: "1px solid var(--border-default)",
            color: "var(--text-hi)", fontSize: 12, fontFamily: "var(--font-sans)",
          }}
        />
        <span style={{ fontSize: 11, color: "var(--text-lo)" }}>
          {loading ? "Updating…" : total > 0 ? `${first}–${last} of ${total}` : ""}
        </span>
      </div>

      {rows.length === 0 ? (
        <div
          data-testid="leaderboard-empty"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 0",
            border: "1px solid var(--border-subtle)", background: "var(--bg-raised)",
            fontSize: 13, color: "var(--text-mid)",
          }}
        >
          {emptyLabel}
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {HEADERS.map((h, i) => (
                  <th
                    key={h}
                    scope="col"
                    style={{
                      padding: "8px 10px", fontSize: 10, fontWeight: 500, textTransform: "uppercase",
                      letterSpacing: "0.05em", color: "var(--text-lo)", background: "var(--bg-overlay)",
                      textAlign: i <= 1 ? "left" : "right",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const mine = highlightAddress === row.wallet_address;
                const disqualified = row.status === "disqualified";
                const muted = disqualified ? 0.55 : 1;
                return (
                  <tr
                    key={row.wallet_address}
                    data-testid="leaderboard-row"
                    data-tied={row.tied ? "true" : undefined}
                    data-status={row.status}
                    data-mine={mine ? "true" : undefined}
                    style={{
                      borderBottom: "1px solid var(--border-subtle)",
                      background: mine ? "var(--brand-dim)" : "transparent",
                    }}
                  >
                    <td className="num" style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-lo)" }}>
                      {formatRank(row.rank, row.tied)}
                    </td>
                    <td className="num" style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-hi)", opacity: muted }}>
                      {displayNameFor(row)}
                    </td>
                    <td className="num" style={{ padding: "8px 10px", fontSize: 12, textAlign: "right", fontWeight: 600, color: "var(--text-hi)", opacity: muted }}>
                      {formatScore(scoringMethod, row.score)}
                    </td>
                    <td className="num" style={{ padding: "8px 10px", fontSize: 11, textAlign: "right", opacity: muted, color: row.percent_return >= 0 ? "var(--call)" : "var(--put)" }}>
                      {formatPercentReturn(row.percent_return)}
                    </td>
                    <td className="num" style={{ padding: "8px 10px", fontSize: 11, textAlign: "right", opacity: muted, color: row.pnl >= 0 ? "var(--call)" : "var(--put)" }}>
                      {formatSignedUsd(row.pnl)}
                    </td>
                    <td className="num" style={{ padding: "8px 10px", fontSize: 11, textAlign: "right", color: "var(--text-mid)", opacity: muted }}>
                      ${formatUsd(row.volume)}
                    </td>
                    <td className="num" style={{ padding: "8px 10px", fontSize: 11, textAlign: "right", color: "var(--text-mid)", opacity: muted }}>
                      {row.trades}
                    </td>
                    <td style={{ padding: "8px 10px", fontSize: 11, textAlign: "right", color: disqualified ? "var(--put)" : "var(--text-lo)" }}>
                      {entryStatusLabel(row.status)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
            style={pagerStyle(page <= 1)}
          >
            Prev
          </button>
          <span className="num" style={{ fontSize: 11, color: "var(--text-mid)" }}>
            Page {page} / {pages}
          </span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pages}
            aria-label="Next page"
            style={pagerStyle(page >= pages)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function pagerStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "5px 10px",
    background: "none",
    border: "1px solid var(--border-default)",
    color: disabled ? "var(--text-lo)" : "var(--text-hi)",
    fontSize: 11,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
