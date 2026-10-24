import type {
  CompetitionConfig,
  CompetitionRank,
  CompetitionResults,
  CompetitionSummary,
  LeaderboardEntry,
} from "../lib/api/types";

// Shared fixtures for the competition tests. Not imported by application code,
// so nothing here ships in the bundle.

export function makeConfig(overrides: Partial<CompetitionConfig> = {}): CompetitionConfig {
  return {
    id: "comp-1",
    name: "Autumn XLM Sprint",
    description: "Trade XLM and BTC options for two weeks.",
    starts_at: "2026-10-01T00:00:00Z",
    ends_at: "2026-10-15T00:00:00Z",
    registration_closes_at: "2026-10-01T00:00:00Z",
    eligible_underlyings: ["XLM", "BTC"],
    scoring_method: "percent_return",
    min_trades: 3,
    min_volume: 1_000,
    max_daily_trades: 20,
    prize_tiers: [
      { rank_from: 1, rank_to: 1, reward: 500, label: "Champion" },
      { rank_from: 2, rank_to: 3, reward: 200, label: null },
    ],
    rules: ["No wash trades.", "The judges' decision is final."],
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<CompetitionSummary> = {}): CompetitionSummary {
  return { ...makeConfig(), entrants: 42, finalized_at: null, ...overrides };
}

export function makeEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    rank: 1,
    wallet_address: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV",
    display_name: null,
    score: 12.5,
    percent_return: 12.5,
    pnl: 250,
    volume: 5_000,
    trades: 6,
    status: "active",
    updated_at: "2026-10-05T00:00:00Z",
    ...overrides,
  };
}

export function makeRank(overrides: Partial<CompetitionRank> = {}): CompetitionRank {
  return {
    competition_id: "comp-1",
    wallet_address: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV",
    display_name: null,
    status: "registered",
    rank: 3,
    total_entries: 100,
    score: 12.5,
    percent_return: 12.5,
    pnl: 250,
    volume: 5_000,
    trades: 6,
    min_trades_met: true,
    min_volume_met: true,
    ...overrides,
  };
}

export function makeResults(overrides: Partial<CompetitionResults> = {}): CompetitionResults {
  return {
    competition_id: "comp-1",
    scoring_method: "percent_return",
    finalized_at: "2026-10-15T00:00:00Z",
    entries: [
      { ...makeEntry({ rank: 1, display_name: "aurora" }), reward: 500 },
      { ...makeEntry({ rank: 2, wallet_address: "GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" }), reward: 200 },
    ],
    ...overrides,
  };
}
