"use client";

import Link from "next/link";
import type { CompetitionPhase, CompetitionSummary } from "../../lib/api/types";
import {
  eligibleUnderlyingsLabel,
  formatInstant,
  formatUsd,
  scoringMethodLabel,
  totalPrizePool,
} from "../../lib/competitions";
import { CompetitionStatusBadge } from "./CompetitionStatusBadge";

/** One row of the competition listing. Links to the detail page. */
export function CompetitionCard({
  competition,
  phase,
}: {
  competition: CompetitionSummary;
  phase: CompetitionPhase;
}) {
  return (
    <Link
      href={`/compete/${encodeURIComponent(competition.id)}`}
      data-testid="competition-card"
      data-phase={phase}
      style={{
        display: "block", textDecoration: "none", border: "1px solid var(--border-default)",
        background: "var(--bg-raised)", padding: 16,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-hi)", fontFamily: "var(--font-serif)" }}>
          {competition.name}
        </div>
        <CompetitionStatusBadge phase={phase} />
      </div>
      <p style={{ fontSize: 12, color: "var(--text-mid)", marginBottom: 12 }}>{competition.description}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px" }}>
        {[
          { label: "Prize pool", value: `$${formatUsd(totalPrizePool(competition.prize_tiers))}` },
          { label: "Entrants", value: String(competition.entrants) },
          { label: "Ranked by", value: scoringMethodLabel(competition.scoring_method) },
          { label: "Underlyings", value: eligibleUnderlyingsLabel(competition) },
          { label: "Ends", value: formatInstant(competition.ends_at) },
        ].map((item) => (
          <div key={item.label}>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-lo)" }}>
              {item.label}
            </div>
            <div className="num" style={{ fontSize: 11, color: "var(--text-hi)" }}>{item.value}</div>
          </div>
        ))}
      </div>
    </Link>
  );
}
