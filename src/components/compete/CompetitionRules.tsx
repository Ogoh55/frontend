"use client";

import type { CompetitionConfig, CompetitionPhase } from "../../lib/api/types";
import {
  antiGamingRules,
  eligibleUnderlyingsLabel,
  formatInstant,
  formatUsd,
  scoringMethodDescription,
  scoringMethodLabel,
} from "../../lib/competitions";
import { CompetitionStatusBadge } from "./CompetitionStatusBadge";
import { PrizeTiers } from "./PrizeTiers";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", fontWeight: 600, marginBottom: 8 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
      {rows.map((row, i) => (
        <div
          key={row.label}
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            padding: "9px 14px",
            borderTop: i === 0 ? "none" : "1px solid var(--border-subtle)",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--text-lo)" }}>{row.label}</span>
          <span className="num" style={{ fontSize: 12, color: "var(--text-hi)", textAlign: "right" }}>
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The rules page, rendered entirely from the competition config.
 *
 * Nothing here is hard-coded to a particular event: the dates, eligible
 * underlyings, scoring method, thresholds, and prize bands all come from the
 * payload, which is what lets the community team schedule the next competition
 * without a frontend change. Times are shown in the viewer's timezone with an
 * abbreviation rather than assuming UTC.
 */
export function CompetitionRules({
  competition,
  phase,
}: {
  competition: CompetitionConfig;
  phase?: CompetitionPhase;
}) {
  const requirements = antiGamingRules(competition);

  return (
    <div data-testid="competition-rules">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 24, fontWeight: 600 }}>{competition.name}</h1>
        {phase && <CompetitionStatusBadge phase={phase} />}
      </div>
      <p style={{ fontSize: 13, color: "var(--text-mid)", marginBottom: 24, maxWidth: 640 }}>
        {competition.description}
      </p>

      <Section title="Schedule">
        <Rows
          rows={[
            { label: "Starts", value: formatInstant(competition.starts_at) },
            { label: "Ends", value: formatInstant(competition.ends_at) },
            {
              label: "Registration closes",
              value:
                competition.registration_closes_at === null
                  ? "When the competition ends"
                  : formatInstant(competition.registration_closes_at ?? competition.starts_at),
            },
          ]}
        />
        <p style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 6 }}>
          Times are shown in your local timezone.
        </p>
      </Section>

      <Section title="Scoring">
        <Rows
          rows={[
            { label: "Ranked by", value: scoringMethodLabel(competition.scoring_method) },
            { label: "Ties", value: "Shared rank; the prize band for that rank applies to every tied entrant" },
          ]}
        />
        <p style={{ fontSize: 12, color: "var(--text-mid)", marginTop: 8 }}>
          {scoringMethodDescription(competition.scoring_method)}
        </p>
      </Section>

      <Section title="Eligibility">
        <Rows
          rows={[
            { label: "Eligible underlyings", value: eligibleUnderlyingsLabel(competition) },
            { label: "Entry", value: "Free — opt in with a signed message from your wallet" },
          ]}
        />
      </Section>

      <Section title="Requirements & anti-gaming">
        <Rows
          rows={[
            { label: "Minimum trades", value: String(competition.min_trades) },
            {
              label: "Minimum traded notional",
              value: competition.min_volume > 0 ? `$${formatUsd(competition.min_volume)}` : "None",
            },
            {
              label: "Maximum trades / day",
              value: competition.max_daily_trades === null ? "Unlimited" : String(competition.max_daily_trades),
            },
          ]}
        />
        <ul style={{ marginTop: 10, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
          {requirements.map((rule) => (
            <li key={rule} style={{ fontSize: 12, color: "var(--text-mid)" }}>
              {rule}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Prizes">
        <PrizeTiers tiers={competition.prize_tiers} />
      </Section>

      {competition.rules.length > 0 && (
        <Section title="Additional rules">
          <ul style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            {competition.rules.map((rule) => (
              <li key={rule} style={{ fontSize: 12, color: "var(--text-mid)" }}>
                {rule}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
