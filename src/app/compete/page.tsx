"use client";

import { useMemo } from "react";
import { AppHeader } from "../../components/AppHeader";
import { WalletConnect } from "../../components/WalletConnect";
import { CompetitionCard } from "../../components/compete/CompetitionCard";
import { useCompetitions } from "../../lib/hooks/useCompetitions";
import { useNow } from "../../lib/hooks/useTiming";
import { useWalletStore } from "../../lib/store/wallet";
import { useHydrated } from "../../lib/useHydrated";
import { phaseOf, validateCompetitionConfig } from "../../lib/competitions";
import type { CompetitionPhase, CompetitionSummary } from "../../lib/api/types";

const SECTIONS: Array<{ phase: CompetitionPhase; label: string }> = [
  { phase: "active", label: "Live now" },
  { phase: "upcoming", label: "Upcoming" },
  { phase: "ended", label: "Past competitions" },
];

/**
 * Competition listing (issue #93).
 *
 * Grouped by derived phase rather than by a stored status, so a competition
 * moves from Upcoming to Live to Past on its own as the clock passes its
 * configured instants — there is no status field to forget to update. Entries
 * whose config does not validate are skipped and counted, so one bad payload
 * cannot blank the whole listing.
 */
export default function CompetePage() {
  const hydrated = useHydrated();
  const token = useWalletStore((s) => s.token);
  const { competitions, loading, error } = useCompetitions(hydrated ? token : null);
  const now = useNow();

  const { groups, invalid } = useMemo(() => {
    const empty: Record<CompetitionPhase, CompetitionSummary[]> = { active: [], upcoming: [], ended: [] };
    if (now === null) return { groups: null, invalid: 0 };

    let invalidCount = 0;
    for (const competition of competitions) {
      const parsed = validateCompetitionConfig(competition);
      if (!parsed.ok) {
        invalidCount += 1;
        continue;
      }
      empty[phaseOf(parsed.value, now)].push(competition);
    }
    return { groups: empty, invalid: invalidCount };
  }, [competitions, now]);

  const total = competitions.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", overflow: "hidden", fontFamily: "var(--font-sans)" }}>
      <AppHeader>
        <div style={{ marginLeft: "auto" }}>
          <WalletConnect />
        </div>
      </AppHeader>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 24px 64px" }}>
          <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, fontWeight: 600, marginBottom: 4 }}>
            Trading Competitions
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-mid)", marginBottom: 28 }}>
            Opt in with a signed message and trade the eligible underlyings. Leaderboards rank by
            return, P&amp;L, or risk-adjusted score depending on the event.
          </p>

          {error && (
            <div role="alert" style={{ border: "1px solid var(--put)", color: "var(--put)", padding: "12px 14px", fontSize: 12, marginBottom: 20 }}>
              Could not load competitions: {error}
            </div>
          )}

          {groups === null && loading && (
            <div style={{ padding: "48px 0", textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
              Loading competitions…
            </div>
          )}

          {groups !== null && total === 0 && !loading && (
            <div style={{ padding: "64px 0", textAlign: "center", border: "1px solid var(--border-subtle)", background: "var(--bg-raised)", color: "var(--text-mid)", fontSize: 13 }}>
              No competitions are scheduled yet. Check back soon.
            </div>
          )}

          {groups !== null &&
            SECTIONS.map(({ phase, label }) => {
              const rows = groups[phase];
              if (rows.length === 0) return null;
              return (
                <section key={phase} style={{ marginBottom: 30 }}>
                  <h2 style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", fontWeight: 600, marginBottom: 10 }}>
                    {label}
                  </h2>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                    {rows.map((competition) => (
                      <CompetitionCard key={competition.id} competition={competition} phase={phase} />
                    ))}
                  </div>
                </section>
              );
            })}

          {invalid > 0 && (
            <p style={{ fontSize: 11, color: "var(--text-lo)" }}>
              {invalid} competition{invalid === 1 ? "" : "s"} could not be displayed because the configuration was invalid.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
