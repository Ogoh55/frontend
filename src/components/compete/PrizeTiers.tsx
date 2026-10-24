"use client";

import type { CompetitionPrizeTier } from "../../lib/api/types";
import { formatReward, rankRangeLabel, totalPrizePool } from "../../lib/competitions";

/**
 * Prize breakdown. `highlightRank` marks the band the viewer currently sits
 * in, so a personal rank card and the rules page agree without duplicating the
 * tier lookup.
 */
export function PrizeTiers({
  tiers,
  highlightRank,
}: {
  tiers: CompetitionPrizeTier[];
  highlightRank?: number | null;
}) {
  if (tiers.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-lo)" }}>
        No prizes configured for this competition.
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <caption style={{ captionSide: "top", textAlign: "left", padding: "10px 14px 6px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-lo)" }}>
          Prize pool · {formatReward(totalPrizePool(tiers))}
        </caption>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
            {["Rank", "Reward", "Title"].map((h, i) => (
              <th
                key={h}
                scope="col"
                style={{
                  padding: "7px 14px",
                  fontSize: 10,
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-lo)",
                  textAlign: i === 1 ? "right" : "left",
                  background: "var(--bg-overlay)",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tiers.map((tier) => {
            const highlighted =
              highlightRank !== null &&
              highlightRank !== undefined &&
              highlightRank >= tier.rank_from &&
              highlightRank <= tier.rank_to;
            return (
              <tr
                key={`${tier.rank_from}-${tier.rank_to}`}
                data-testid="prize-tier"
                data-highlighted={highlighted ? "true" : undefined}
                style={{
                  borderBottom: "1px solid var(--border-subtle)",
                  background: highlighted ? "var(--brand-dim)" : "transparent",
                }}
              >
                <td className="num" style={{ padding: "7px 14px", fontSize: 12, color: "var(--text-hi)" }}>
                  {rankRangeLabel(tier)}
                </td>
                <td className="num" style={{ padding: "7px 14px", fontSize: 12, textAlign: "right", fontWeight: 600, color: "var(--call)" }}>
                  {formatReward(tier.reward)}
                </td>
                <td style={{ padding: "7px 14px", fontSize: 12, color: "var(--text-mid)" }}>
                  {tier.label ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
