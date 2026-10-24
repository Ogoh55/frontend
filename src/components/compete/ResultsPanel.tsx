"use client";

import type { CompetitionResults } from "../../lib/api/types";
import {
  annotateTies,
  displayNameFor,
  formatInstant,
  formatRank,
  formatReward,
  formatScore,
} from "../../lib/competitions";

/**
 * Final standings with rewards (issue #93).
 *
 * Only rendered once the competition is finalized; the rewards shown are the
 * ones the backend recorded, never recomputed from the prize config — the
 * config is the announcement, the results payload is the payout.
 */
export function ResultsPanel({
  results,
  highlightAddress,
}: {
  results: CompetitionResults;
  highlightAddress?: string | null;
}) {
  const rows = annotateTies(results.entries);

  return (
    <div data-testid="competition-results">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>Final results</div>
        <div style={{ fontSize: 11, color: "var(--text-lo)" }}>Finalized {formatInstant(results.finalized_at)}</div>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: "40px 0", textAlign: "center", border: "1px solid var(--border-subtle)", background: "var(--bg-raised)", fontSize: 13, color: "var(--text-mid)" }}>
          No eligible entries.
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {["#", "Winner", "Score", "Reward"].map((h, i) => (
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
                return (
                  <tr
                    key={row.wallet_address}
                    data-testid="results-row"
                    data-mine={mine ? "true" : undefined}
                    style={{ borderBottom: "1px solid var(--border-subtle)", background: mine ? "var(--brand-dim)" : "transparent" }}
                  >
                    <td className="num" style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-lo)" }}>
                      {formatRank(row.rank, row.tied)}
                    </td>
                    <td className="num" style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-hi)" }}>
                      {displayNameFor(row)}
                    </td>
                    <td className="num" style={{ padding: "8px 10px", fontSize: 12, textAlign: "right", color: "var(--text-hi)" }}>
                      {formatScore(results.scoring_method, row.score)}
                    </td>
                    <td className="num" style={{ padding: "8px 10px", fontSize: 12, textAlign: "right", fontWeight: 600, color: row.reward > 0 ? "var(--call)" : "var(--text-lo)" }}>
                      {row.reward > 0 ? formatReward(row.reward) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
