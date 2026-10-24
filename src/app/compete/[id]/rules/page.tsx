"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AppHeader } from "../../../../components/AppHeader";
import { WalletConnect } from "../../../../components/WalletConnect";
import { CompetitionRules } from "../../../../components/compete/CompetitionRules";
import { useCompetition } from "../../../../lib/hooks/useCompetitions";
import { useNow } from "../../../../lib/hooks/useTiming";
import { useWalletStore } from "../../../../lib/store/wallet";
import { useHydrated } from "../../../../lib/useHydrated";
import { phaseOf, validateCompetitionConfig } from "../../../../lib/competitions";

/**
 * Rules page (issue #93).
 *
 * Everything on it is rendered from the competition config, so this is the
 * page to link when someone asks what a competition does — it cannot drift
 * from the event that is actually running, because there is nowhere else for
 * the rules to live.
 */
export default function CompetitionRulesPage({ params }: { params: { id: string } }) {
  const competitionId = params.id;
  const hydrated = useHydrated();
  const token = useWalletStore((s) => s.token);
  const { competition, loading, error } = useCompetition(competitionId, hydrated ? token : null);
  const now = useNow();

  const validation = useMemo(
    () => (competition ? validateCompetitionConfig(competition) : null),
    [competition]
  );
  const config = validation?.value ?? null;
  const configErrors = validation && validation.errors.length > 0 ? validation.errors : null;

  const phase = config && now !== null ? phaseOf(config, now) : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", overflow: "hidden", fontFamily: "var(--font-sans)" }}>
      <AppHeader>
        <div style={{ marginLeft: "auto" }}>
          <WalletConnect />
        </div>
      </AppHeader>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 24px 64px" }}>
          <Link
            href={`/compete/${encodeURIComponent(competitionId)}`}
            style={{ display: "inline-block", marginBottom: 14, fontSize: 12, color: "var(--text-lo)", textDecoration: "none" }}
          >
            ← Back to competition
          </Link>

          {loading && !competition && <div style={{ color: "var(--text-lo)", fontSize: 13 }}>Loading rules…</div>}

          {error && !competition && (
            <div role="alert" style={{ border: "1px solid var(--put)", color: "var(--put)", padding: 14, fontSize: 12 }}>
              Could not load the rules: {error}
            </div>
          )}

          {competition && configErrors && (
            <div role="alert" data-testid="config-error" style={{ border: "1px solid var(--put)", color: "var(--put)", padding: 14, fontSize: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>This competition has an invalid configuration</div>
              <ul style={{ paddingLeft: 18 }}>
                {configErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {config && <CompetitionRules competition={config} phase={phase} />}
        </div>
      </div>
    </div>
  );
}
