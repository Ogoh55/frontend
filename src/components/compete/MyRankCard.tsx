"use client";

import type {
  CompetitionPrizeTier,
  CompetitionRank,
  CompetitionScoringMethod,
} from "../../lib/api/types";
import {
  formatPercentReturn,
  formatScore,
  formatSignedUsd,
  formatUsd,
  prizeTierForRank,
} from "../../lib/competitions";

export interface MyRankCardProps {
  rank: CompetitionRank | null;
  scoringMethod: CompetitionScoringMethod;
  prizeTiers?: CompetitionPrizeTier[];
  /** True when there is no session at all — distinct from "not entered". */
  connected: boolean;
  loading?: boolean;
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-lo)", marginBottom: 3 }}>
        {label}
      </div>
      <div className="num" style={{ fontSize: 15, fontWeight: 600, color: color ?? "var(--text-hi)" }}>
        {value}
      </div>
    </div>
  );
}

/**
 * Personal rank card (issue #93).
 *
 * Deliberately distinguishes the states an entrant can be in — no session,
 * entered but unranked, ranked, disqualified — because "—" for all of them is
 * exactly the ambiguity that generates support questions. An entered-but-
 * unranked row shows *which* threshold is unmet rather than just a dash.
 */
export function MyRankCard({
  rank,
  scoringMethod,
  prizeTiers = [],
  connected,
  loading,
}: MyRankCardProps) {
  if (!connected) {
    return (
      <div data-testid="my-rank" data-state="disconnected" style={cardStyle}>
        <div style={titleStyle}>Your rank</div>
        <p style={{ fontSize: 12, color: "var(--text-mid)" }}>Connect your wallet to see your standing.</p>
      </div>
    );
  }

  if (loading && !rank) {
    return (
      <div data-testid="my-rank" data-state="loading" style={cardStyle}>
        <div style={titleStyle}>Your rank</div>
        <p style={{ fontSize: 12, color: "var(--text-lo)" }}>Loading…</p>
      </div>
    );
  }

  if (!rank || rank.status === "not_registered") {
    return (
      <div data-testid="my-rank" data-state="not-entered" style={cardStyle}>
        <div style={titleStyle}>Your rank</div>
        <p style={{ fontSize: 12, color: "var(--text-mid)" }}>
          You have not entered this competition. Enter above to appear on the leaderboard.
        </p>
      </div>
    );
  }

  if (rank.status === "disqualified") {
    return (
      <div data-testid="my-rank" data-state="disqualified" style={cardStyle}>
        <div style={titleStyle}>Your rank</div>
        <p style={{ fontSize: 12, color: "var(--put)" }}>
          This entry was disqualified and is not eligible for prizes.
        </p>
      </div>
    );
  }

  const unmet: string[] = [];
  if (!rank.min_trades_met) unmet.push(`minimum trades (${rank.trades})`);
  if (!rank.min_volume_met) unmet.push(`minimum volume ($${formatUsd(rank.volume)})`);
  const ranked = rank.rank !== null;
  const tier = ranked && rank.rank !== null ? prizeTierForRank(prizeTiers, rank.rank) : null;

  return (
    <div data-testid="my-rank" data-state={ranked ? "ranked" : "unranked"} style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <div style={titleStyle}>Your rank</div>
        <div className="num" style={{ fontSize: 20, fontWeight: 700, color: ranked ? "var(--brand)" : "var(--text-lo)" }}>
          {ranked && rank.rank !== null ? `#${rank.rank}` : "Unranked"}
          {ranked && rank.total_entries > 0 && (
            <span style={{ fontSize: 11, color: "var(--text-lo)", fontWeight: 400 }}> / {rank.total_entries}</span>
          )}
        </div>
      </div>

      {!ranked && unmet.length > 0 && (
        <p style={{ fontSize: 11, color: "var(--atm)", marginBottom: 12 }}>
          Below the ranking threshold: {unmet.join(", ")}.
        </p>
      )}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Metric label="Score" value={formatScore(scoringMethod, rank.score)} />
        <Metric label="% Return" value={formatPercentReturn(rank.percent_return)} color={(rank.percent_return ?? 0) >= 0 ? "var(--call)" : "var(--put)"} />
        <Metric label="P&L" value={formatSignedUsd(rank.pnl)} color={(rank.pnl ?? 0) >= 0 ? "var(--call)" : "var(--put)"} />
        <Metric label="Volume" value={`$${formatUsd(rank.volume)}`} />
        <Metric label="Trades" value={String(rank.trades)} />
      </div>

      {tier && (
        <p style={{ marginTop: 12, fontSize: 12, color: "var(--call)" }}>
          Currently in a prize position · {tier.label ?? `rank ${tier.rank_from}–${tier.rank_to}`}
        </p>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border-default)",
  background: "var(--bg-raised)",
  padding: 16,
};

const titleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-hi)",
};
