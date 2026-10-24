"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "../../../components/AppHeader";
import { WalletConnect } from "../../../components/WalletConnect";
import { CompetitionStatusBadge } from "../../../components/compete/CompetitionStatusBadge";
import { LeaderboardTable } from "../../../components/compete/LeaderboardTable";
import { MyRankCard } from "../../../components/compete/MyRankCard";
import { PrizeTiers } from "../../../components/compete/PrizeTiers";
import { RegistrationCard } from "../../../components/compete/RegistrationCard";
import { ResultsPanel } from "../../../components/compete/ResultsPanel";
import {
  useCompetition,
  useCompetitionResults,
  useLeaderboard,
  useMyRank,
} from "../../../lib/hooks/useCompetitions";
import { useCompetitionRegistration } from "../../../lib/hooks/useCompetitionRegistration";
import { useDebouncedValue, useNow } from "../../../lib/hooks/useTiming";
import { useWalletStore } from "../../../lib/store/wallet";
import { useHydrated } from "../../../lib/useHydrated";
import {
  DEFAULT_LEADERBOARD_PAGE_SIZE,
  LEADERBOARD_REFRESH_OPTIONS,
  eligibleUnderlyingsLabel,
  formatInstant,
  phaseOf,
  registrationWindowOf,
  scoringMethodLabel,
  totalPrizePool,
  formatUsd,
  validateCompetitionConfig,
} from "../../../lib/competitions";

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--border-default)",
  background: "var(--bg-raised)",
  padding: 16,
};

/**
 * Competition detail (issue #93): opt-in, live leaderboard, personal rank, and
 * final results. The rules page is separate (`/compete/[id]/rules`) because it
 * is the page somebody links to when explaining the event; this page is the
 * one people keep open while it runs.
 *
 * Phase is derived from the config and the clock, never stored, and the
 * leaderboard's polling only runs while the competition is live.
 */
export default function CompetitionDetailPage({ params }: { params: { id: string } }) {
  const competitionId = params.id;
  const hydrated = useHydrated();
  const token = useWalletStore((s) => s.token);
  const address = useWalletStore((s) => s.address);
  const now = useNow();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [refreshMs, setRefreshMs] = useState<number>(LEADERBOARD_REFRESH_OPTIONS[1].ms);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { competition, loading, error } = useCompetition(competitionId, hydrated ? token : null);

  const validation = useMemo(
    () => (competition ? validateCompetitionConfig(competition) : null),
    [competition]
  );
  const config = validation?.value ?? null;
  const configErrors = validation && validation.errors.length > 0 ? validation.errors : null;

  const phase = config && now !== null ? phaseOf(config, now) : null;
  const window = config && now !== null ? registrationWindowOf(config, now) : null;
  const boardEnabled = phase === "active" || phase === "ended";

  const leaderboard = useLeaderboard(competitionId, {
    token: hydrated ? token : null,
    page,
    pageSize: DEFAULT_LEADERBOARD_PAGE_SIZE,
    search: debouncedSearch,
    refreshMs: phase === "active" ? refreshMs : 0,
    enabled: boardEnabled,
  });

  const myRank = useMyRank(competitionId, hydrated ? token : null);
  const results = useCompetitionResults(competitionId, phase === "ended", hydrated ? token : null);

  // A new query restarts pagination; staying on page 4 of a filtered list that
  // only has one page is a blank board with no explanation.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const registration = useCompetitionRegistration({
    competitionId,
    address: hydrated ? address : null,
    token: hydrated ? token : null,
    onRegistered: () => {
      myRank.refresh();
      leaderboard.refresh();
    },
  });

  const status = registration.registration ? "registered" : (myRank.rank?.status ?? "not_registered");
  const displayName = registration.registration?.display_name ?? myRank.rank?.display_name ?? null;

  if (loading && !competition) {
    return (
      <Shell>
        <div style={{ padding: "64px 0", textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
          Loading competition…
        </div>
      </Shell>
    );
  }

  if (error || !competition) {
    return (
      <Shell>
        <div role="alert" style={{ border: "1px solid var(--put)", color: "var(--put)", padding: "14px", fontSize: 12 }}>
          {error ? `Could not load this competition: ${error}` : "Competition not found."}
        </div>
        <Link href="/compete" style={{ display: "inline-block", marginTop: 14, fontSize: 12, color: "var(--brand)", textDecoration: "none" }}>
          ← All competitions
        </Link>
      </Shell>
    );
  }

  if (!config) {
    return (
      <Shell>
        <div role="alert" data-testid="config-error" style={{ border: "1px solid var(--put)", color: "var(--put)", padding: "14px", fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>This competition has an invalid configuration</div>
          <ul style={{ paddingLeft: 18 }}>
            {(configErrors ?? ["Unknown configuration error"]).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
        <Link href="/compete" style={{ display: "inline-block", marginTop: 14, fontSize: 12, color: "var(--brand)", textDecoration: "none" }}>
          ← All competitions
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Link href="/compete" style={{ fontSize: 12, color: "var(--text-lo)", textDecoration: "none" }}>
          ← Competitions
        </Link>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, fontWeight: 600 }}>{config.name}</h1>
        {phase && <CompetitionStatusBadge phase={phase} />}
      </div>
      <p style={{ fontSize: 13, color: "var(--text-mid)", marginBottom: 24, maxWidth: 680 }}>{config.description}</p>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 20, alignItems: "start", marginBottom: 26 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {window && (
            <RegistrationCard
              phase={phase ?? "upcoming"}
              window={window}
              address={hydrated ? address : null}
              status={status}
              displayName={displayName}
              submitting={registration.submitting}
              error={registration.error}
              onRegister={(name) => registration.register(name)}
              onUpdateDisplayName={(name) => {
                registration.updateDisplayName(name).then((updated) => {
                  if (updated) myRank.refresh();
                });
              }}
            />
          )}
          <MyRankCard
            rank={myRank.rank}
            scoringMethod={config.scoring_method}
            prizeTiers={config.prize_tiers}
            connected={Boolean(hydrated && token)}
            loading={myRank.loading}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={panelStyle}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-lo)", marginBottom: 10 }}>
              At a glance
            </div>
            {[
              { label: "Ranked by", value: scoringMethodLabel(config.scoring_method) },
              { label: "Underlyings", value: eligibleUnderlyingsLabel(config) },
              { label: "Prize pool", value: `$${formatUsd(totalPrizePool(config.prize_tiers))}` },
              { label: "Starts", value: formatInstant(config.starts_at) },
              { label: "Ends", value: formatInstant(config.ends_at) },
              { label: "Entrants", value: String(competition.entrants) },
            ].map((row) => (
              <div key={row.label} style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{row.label}</span>
                <span className="num" style={{ fontSize: 11, color: "var(--text-hi)", textAlign: "right" }}>{row.value}</span>
              </div>
            ))}
            <Link
              href={`/compete/${encodeURIComponent(competition.id)}/rules`}
              style={{ display: "inline-block", marginTop: 8, fontSize: 12, color: "var(--brand)", textDecoration: "none" }}
            >
              Full rules →
            </Link>
          </div>
          <PrizeTiers tiers={config.prize_tiers} highlightRank={myRank.rank?.rank ?? null} />
        </div>
      </div>

      {phase === "ended" && results.results ? (
        <ResultsPanel results={results.results} highlightAddress={hydrated ? address : null} />
      ) : boardEnabled ? (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>Leaderboard</div>
            {phase === "active" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, color: "var(--text-lo)" }}>Refresh</span>
                {LEADERBOARD_REFRESH_OPTIONS.map((option) => (
                  <button
                    key={option.ms}
                    onClick={() => setRefreshMs(option.ms)}
                    aria-label={`Refresh every ${option.label}`}
                    aria-pressed={refreshMs === option.ms}
                    style={{
                      padding: "3px 8px", border: "1px solid var(--border-default)", background: refreshMs === option.ms ? "var(--atm-dim)" : "none",
                      color: refreshMs === option.ms ? "var(--atm)" : "var(--text-lo)", fontSize: 10, cursor: "pointer",
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <LeaderboardTable
            entries={leaderboard.entries}
            scoringMethod={config.scoring_method}
            total={leaderboard.data?.total ?? 0}
            page={page}
            pageSize={DEFAULT_LEADERBOARD_PAGE_SIZE}
            search={search}
            loading={leaderboard.loading}
            highlightAddress={hydrated ? address : null}
            onSearchChange={setSearch}
            onPageChange={setPage}
            emptyLabel={
              debouncedSearch
                ? `No entrants match “${debouncedSearch}”.`
                : phase === "ended"
                  ? "No ranked entries for this competition."
                  : "No entries yet — be the first to opt in."
            }
          />
          {leaderboard.error && (
            <p role="alert" style={{ marginTop: 8, fontSize: 11, color: "var(--put)" }}>
              {leaderboard.error}
            </p>
          )}
        </div>
      ) : (
        <div
          data-testid="leaderboard-locked"
          style={{ border: "1px solid var(--border-subtle)", background: "var(--bg-raised)", padding: "48px 0", textAlign: "center", fontSize: 13, color: "var(--text-mid)" }}
        >
          The leaderboard opens when the competition starts on {formatInstant(config.starts_at)}.
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", overflow: "hidden", fontFamily: "var(--font-sans)" }}>
      <AppHeader>
        <div style={{ marginLeft: "auto" }}>
          <WalletConnect />
        </div>
      </AppHeader>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 24px 64px" }}>{children}</div>
      </div>
    </div>
  );
}
