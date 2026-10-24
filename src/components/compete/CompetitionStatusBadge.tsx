"use client";

import type { CompetitionPhase } from "../../lib/api/types";
import { phaseLabel } from "../../lib/competitions";

const TONE: Record<CompetitionPhase, { bg: string; color: string; dot: string }> = {
  upcoming: { bg: "var(--atm-dim)", color: "var(--atm)", dot: "var(--atm)" },
  active: { bg: "var(--call-dim)", color: "var(--call)", dot: "var(--call)" },
  ended: { bg: "var(--bg-overlay)", color: "var(--text-lo)", dot: "var(--text-lo)" },
};

/** Upcoming / Live / Ended pill. The phase is always derived, never stored. */
export function CompetitionStatusBadge({ phase }: { phase: CompetitionPhase }) {
  const tone = TONE[phase];
  return (
    <span
      data-testid="competition-status"
      data-phase={phase}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 7px",
        background: tone.bg,
        color: tone.color,
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: tone.dot }} />
      {phaseLabel(phase)}
    </span>
  );
}
