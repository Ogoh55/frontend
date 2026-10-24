import type {
  CompetitionConfig,
  CompetitionEntryStatus,
  CompetitionPhase,
  CompetitionPrizeTier,
  CompetitionScoringMethod,
  LeaderboardEntry,
} from "./api/types";

// Pure helpers for the trading-competition module (issue #93).
//
// Everything here is deliberately data-in/data-out so the rules that matter —
// phase boundaries, tie handling, anti-gaming thresholds, display-name
// privacy — can be unit-tested without rendering anything, and so the pages
// stay thin. The competition *config* is data (fetched from the API), never a
// source file: the whole point of the module is that the community team can
// run an event without an engineering change, which a checked-in config file
// would not give them.

export const SCORING_METHODS: readonly CompetitionScoringMethod[] = [
  "percent_return",
  "pnl",
  "risk_adjusted",
];

export const DEFAULT_LEADERBOARD_PAGE_SIZE = 25;

/** How often the leaderboard re-polls while the tab is visible. */
export const DEFAULT_LEADERBOARD_REFRESH_MS = 15_000;

/** Selectable cadences for the "live" leaderboard. */
export const LEADERBOARD_REFRESH_OPTIONS = [
  { label: "5s", ms: 5_000 },
  { label: "15s", ms: 15_000 },
  { label: "60s", ms: 60_000 },
] as const;

// ─── Phase / registration window ─────────────────────────────────────────────

/**
 * Parse an ISO-8601 instant to epoch milliseconds, or `null` when unusable.
 *
 * Instant-based rather than wall-clock-based on purpose: the boundary math is
 * timezone- and DST-agnostic because both sides are absolute instants, so a
 * competition that runs across a DST jump has exactly one start and one end.
 */
export function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Where a competition sits in its lifecycle.
 *
 * Boundaries are half-open: `starts_at` is already active, `ends_at` is
 * already ended. A competition that starts and ends at the same instant is
 * treated as ended rather than active.
 */
export function phaseOf(
  config: Pick<CompetitionConfig, "starts_at" | "ends_at">,
  now: number = Date.now()
): CompetitionPhase {
  const start = parseInstant(config.starts_at);
  const end = parseInstant(config.ends_at);
  if (start === null || end === null) {
    throw new RangeError(
      "competition has an invalid starts_at/ends_at; validate the config before computing its phase"
    );
  }
  if (now < start) return "upcoming";
  if (now >= end) return "ended";
  return "active";
}

export type CompetitionRegistrationWindow = "open" | "closed" | "ended";

/**
 * Whether opt-in is still possible.
 *
 * `registration_closes_at` is optional: when absent, registration closes when
 * the competition starts (the conservative default — an event should not
 * accept a new entrant once the scores are already being earned). `null`
 * explicitly means "stays open until the competition ends".
 */
export function registrationWindowOf(
  config: Pick<CompetitionConfig, "starts_at" | "ends_at" | "registration_closes_at">,
  now: number = Date.now()
): CompetitionRegistrationWindow {
  const end = parseInstant(config.ends_at);
  const start = parseInstant(config.starts_at);
  if (end === null || start === null) {
    throw new RangeError("competition has an invalid starts_at/ends_at");
  }
  if (now >= end) return "ended";

  const closesAt =
    config.registration_closes_at === null ? end : (parseInstant(config.registration_closes_at) ?? start);
  return now < closesAt ? "open" : "closed";
}

export function canRegister(
  config: Pick<CompetitionConfig, "starts_at" | "ends_at" | "registration_closes_at">,
  now: number = Date.now()
): boolean {
  return registrationWindowOf(config, now) === "open";
}

/**
 * Human-readable instant, rendered in the viewer's timezone with its
 * abbreviation so "23:59" never reads as local when it means UTC.
 */
export function formatInstant(value: string | null | undefined): string {
  const ms = parseInstant(value);
  if (ms === null) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function phaseLabel(phase: CompetitionPhase): string {
  switch (phase) {
    case "upcoming":
      return "Upcoming";
    case "active":
      return "Live";
    default:
      return "Ended";
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export function scoringMethodLabel(method: CompetitionScoringMethod): string {
  switch (method) {
    case "percent_return":
      return "% Return";
    case "pnl":
      return "P&L";
    default:
      return "Risk-Adjusted Score";
  }
}

export function scoringMethodDescription(method: CompetitionScoringMethod): string {
  switch (method) {
    case "percent_return":
      return "Ranked by percentage return on starting capital, so account size does not decide the winner.";
    case "pnl":
      return "Ranked by realized + unrealized P&L in USD. Larger accounts can win by size alone.";
    default:
      return "Ranked by return per unit of risk taken (Sharpe-like), to reward consistency over one lucky trade.";
  }
}

/** Format the ranking value according to the competition's scoring method. */
export function formatScore(
  method: CompetitionScoringMethod,
  value: number | null | undefined
): string {
  if (value === null || value === undefined) return "—";
  if (method === "percent_return") return formatPercentReturn(value);
  if (method === "pnl") return formatSignedUsd(value);
  return value.toFixed(2);
}

export function formatPercentReturn(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

export function formatSignedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${formatUsd(Math.abs(value))}`;
}

export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatReward(value: number): string {
  return `$${formatUsd(value)}`;
}

// ─── Eligibility / anti-gaming ───────────────────────────────────────────────

export function isEligibleUnderlying(config: CompetitionConfig, underlying: string): boolean {
  return config.eligible_underlyings.includes(underlying);
}

export function eligibleUnderlyingsLabel(config: CompetitionConfig): string {
  return config.eligible_underlyings.length > 0
    ? config.eligible_underlyings.join(", ")
    : "Any listed underlying";
}

/**
 * The anti-gaming thresholds, phrased for display on the rules page.
 *
 * These are *display* rules, not enforcement: the backend decides what
 * actually disqualifies an entry (see `CompetitionEntryStatus`). Showing them
 * up front is the point — an entrant who cannot qualify should learn that
 * before trading, not when the results post.
 */
export function antiGamingRules(config: CompetitionConfig): string[] {
  const rules = [
    `Minimum ${config.min_trades} trade${config.min_trades === 1 ? "" : "s"} to be ranked.`,
  ];
  if (config.min_volume > 0) {
    rules.push(`Minimum $${formatUsd(config.min_volume)} traded notional to be ranked.`);
  }
  if (config.max_daily_trades !== null) {
    rules.push(`No more than ${config.max_daily_trades} trade${config.max_daily_trades === 1 ? "" : "s"} per day.`);
  }
  rules.push("Entries below the minimums stay visible but are not ranked; entries that breach the limits are marked disqualified.");
  return rules;
}

export function entryStatusLabel(status: CompetitionEntryStatus): string {
  return status === "disqualified" ? "Disqualified" : "Active";
}

// ─── Privacy / display names ─────────────────────────────────────────────────

/** `GABCD…WXYZ` — short enough for a table, unambiguous enough to identify. */
export function truncateAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * What to show for an entrant: the opted-in pseudonym if there is one,
 * otherwise a truncated address. A display name is always opt-in and always
 * reversible, so this never invents one.
 */
export function displayNameFor(entry: Pick<LeaderboardEntry, "display_name" | "wallet_address">): string {
  const name = entry.display_name?.trim();
  return name ? name : truncateAddress(entry.wallet_address);
}

export function hasDisplayName(entry: Pick<LeaderboardEntry, "display_name">): boolean {
  return Boolean(entry.display_name?.trim());
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Mark rows whose score is shared with another row.
 *
 * Ties are a real edge case for a prize board: two entrants on the same score
 * must not be shown as 3rd and 4th when neither is ahead. The backend's `rank`
 * is authoritative once a competition is finalized; this drives the "="
 * prefix so adjacent equal scores read as a tie rather than an ordering.
 */
export function annotateTies<T extends LeaderboardEntry>(
  entries: T[]
): Array<T & { tied: boolean }> {
  const counts = new Map<number, number>();
  for (const entry of entries) {
    counts.set(entry.score, (counts.get(entry.score) ?? 0) + 1);
  }
  return entries.map((entry) => ({ ...entry, tied: (counts.get(entry.score) ?? 0) > 1 }));
}

/** Rank prefix: `=3` when tied, `3` otherwise. */
export function formatRank(rank: number, tied = false): string {
  return tied ? `=${rank}` : String(rank);
}

// ─── Prizes ──────────────────────────────────────────────────────────────────

export function rankRangeLabel(tier: CompetitionPrizeTier): string {
  return tier.rank_from === tier.rank_to ? `#${tier.rank_from}` : `#${tier.rank_from}–#${tier.rank_to}`;
}

/** The prize tier a rank falls into, or `null` when it is outside every tier. */
export function prizeTierForRank(
  tiers: CompetitionPrizeTier[],
  rank: number
): CompetitionPrizeTier | null {
  return (
    tiers.find((tier) => rank >= tier.rank_from && rank <= tier.rank_to) ?? null
  );
}

/** Sum of every tier's reward — the advertised prize pool. */
export function totalPrizePool(tiers: CompetitionPrizeTier[]): number {
  return tiers.reduce((sum, tier) => sum + tier.reward, 0);
}

// ─── Config validation ───────────────────────────────────────────────────────

export interface ValidationResult<T> {
  ok: boolean;
  /** The parsed config when `ok`; `null` otherwise. */
  value: T | null;
  /** Human-readable problems; always empty when `ok`. */
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(errors: string[], field: string, value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} must be a non-empty string`);
    return null;
  }
  return value;
}

/**
 * Validate a config payload before any of it is rendered.
 *
 * The rules page writes almost every field straight onto the screen, so an
 * unvalidated malformed payload shows up as `undefined`/`Invalid Date` in the
 * UI instead of an honest error. Validating at the boundary keeps the failure
 * legible and keeps `phaseOf` from having to guess.
 */
export function validateCompetitionConfig(raw: unknown): ValidationResult<CompetitionConfig> {
  if (!isRecord(raw)) return { ok: false, value: null, errors: ["config must be an object"] };

  const errors: string[] = [];
  const id = asString(errors, "id", raw.id);
  const name = asString(errors, "name", raw.name);
  const description = asString(errors, "description", raw.description);
  const startsAt = asString(errors, "starts_at", raw.starts_at);
  const endsAt = asString(errors, "ends_at", raw.ends_at);

  const startMs = parseInstant(startsAt);
  const endMs = parseInstant(endsAt);
  if (startsAt !== null && startMs === null) errors.push("starts_at must be an ISO-8601 instant");
  if (endsAt !== null && endMs === null) errors.push("ends_at must be an ISO-8601 instant");
  if (startMs !== null && endMs !== null && endMs <= startMs) {
    errors.push("ends_at must be after starts_at");
  }

  // Absent stays absent (`undefined`) so `registrationWindowOf` applies its
  // "closes at start" default; only an explicit `null` means "open to the end".
  let registrationClosesAt: string | null | undefined = undefined;
  if (raw.registration_closes_at !== undefined) {
    if (raw.registration_closes_at === null) {
      registrationClosesAt = null;
    } else if (typeof raw.registration_closes_at !== "string" || parseInstant(raw.registration_closes_at) === null) {
      errors.push("registration_closes_at must be null or an ISO-8601 instant");
    } else {
      registrationClosesAt = raw.registration_closes_at;
    }
  }

  const underlyings = Array.isArray(raw.eligible_underlyings)
    ? raw.eligible_underlyings.filter((u): u is string => typeof u === "string" && u.trim() !== "")
    : [];
  if (underlyings.length === 0) {
    errors.push("eligible_underlyings must list at least one underlying");
  }

  const method = raw.scoring_method;
  if (typeof method !== "string" || !SCORING_METHODS.includes(method as CompetitionScoringMethod)) {
    errors.push(`scoring_method must be one of ${SCORING_METHODS.join(", ")}`);
  }

  const minTrades = Number(raw.min_trades);
  if (!Number.isInteger(minTrades) || minTrades < 1) {
    errors.push("min_trades must be an integer >= 1");
  }

  const minVolume = Number(raw.min_volume);
  if (!Number.isFinite(minVolume) || minVolume < 0) {
    errors.push("min_volume must be a number >= 0");
  }

  let maxDailyTrades: number | null = null;
  if (raw.max_daily_trades !== undefined && raw.max_daily_trades !== null) {
    const parsed = Number(raw.max_daily_trades);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push("max_daily_trades must be null or an integer >= 1");
    } else {
      maxDailyTrades = parsed;
    }
  }

  const prizeTiers: CompetitionPrizeTier[] = [];
  if (!Array.isArray(raw.prize_tiers)) {
    errors.push("prize_tiers must be an array");
  } else {
    raw.prize_tiers.forEach((tier, index) => {
      if (!isRecord(tier)) {
        errors.push(`prize_tiers[${index}] must be an object`);
        return;
      }
      const from = Number(tier.rank_from);
      const to = Number(tier.rank_to);
      const reward = Number(tier.reward);
      if (!Number.isInteger(from) || from < 1) errors.push(`prize_tiers[${index}].rank_from must be an integer >= 1`);
      if (!Number.isInteger(to) || to < from) errors.push(`prize_tiers[${index}].rank_to must be an integer >= rank_from`);
      if (!Number.isFinite(reward) || reward < 0) errors.push(`prize_tiers[${index}].reward must be a number >= 0`);
      prizeTiers.push({
        rank_from: from,
        rank_to: to,
        reward,
        label: typeof tier.label === "string" && tier.label.trim() ? tier.label : null,
      });
    });

    // Overlapping bands make `prizeTierForRank` order-dependent, which is the
    // kind of ambiguity that ends up as a support ticket during finals week.
    const sorted = [...prizeTiers].sort((a, b) => a.rank_from - b.rank_from);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.rank_from <= sorted[i - 1]!.rank_to) {
        errors.push("prize_tiers must not overlap");
        break;
      }
    }
  }

  const rules = Array.isArray(raw.rules)
    ? raw.rules.filter((r): r is string => typeof r === "string" && r.trim() !== "")
    : [];

  if (errors.length > 0) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: [],
    value: {
      id: id!,
      name: name!,
      description: description!,
      starts_at: startsAt!,
      ends_at: endsAt!,
      registration_closes_at: registrationClosesAt,
      eligible_underlyings: underlyings,
      scoring_method: method as CompetitionScoringMethod,
      min_trades: minTrades,
      min_volume: minVolume,
      max_daily_trades: maxDailyTrades,
      prize_tiers: prizeTiers.sort((a, b) => a.rank_from - b.rank_from),
      rules,
    },
  };
}
