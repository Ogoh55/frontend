// Mirrors the JSON shapes returned by backend/src/lib.rs and its domain
// modules. Field names match the Rust structs' serde output exactly
// (snake_case) rather than being camelCased on the way in, so a diff
// against the backend types stays easy to eyeball.

export interface BSResult {
  premium: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  d1: number;
  d2: number;
  intrinsic: number;
  time_value: number;
  iv: number;
}

export interface SpotResponse {
  prices: Record<string, number>;
  vols: Record<string, number>;
}

export interface OptionChainEntry {
  strike: number;
  expiry_days: number;
  call: BSResult;
  put: BSResult;
  is_itm_call: boolean;
  is_itm_put: boolean;
}

export interface ExpiryInfo {
  days_to_expiry: number;
  label: string;
  timestamp: number;
}

export interface ExpiryCalendar {
  underlying: string;
  spot: number;
  vol: number;
  expiries: ExpiryInfo[];
}

export interface IvResult {
  implied_vol: number;
}

export type OptionType = "call" | "put";
export type PositionType = "long" | "short";
export type PositionStatus = "open" | "closed" | "rolled";

export interface Account {
  wallet_address: string;
  balance: number;
  collateral_locked: number;
  created_at: string;
}

export interface Position {
  id: string;
  wallet_address: string;
  underlying: string;
  strike: number;
  expiry_days: number;
  option_type: OptionType;
  position_type: PositionType;
  contracts: number;
  entry_premium: number;
  entry_spot: number;
  collateral: number;
  status: PositionStatus;
  close_premium: number | null;
  close_spot: number | null;
  realized_pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  strategy_id: string | null;
}

export interface HistoryStats {
  trade_count: number;
  win_count: number;
  loss_count: number;
  total_realized_pnl: number;
}

export interface HistoryResponse {
  trades: Position[];
  stats: HistoryStats;
}

export interface AggregateGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface WatchlistItem {
  wallet_address: string;
  underlying: string;
  added_at: string;
}

export type AlertCondition = "above" | "below";

export interface Alert {
  id: string;
  wallet_address: string;
  underlying: string;
  condition: AlertCondition;
  target_price: number;
  triggered: boolean;
  created_at: string;
  triggered_at: string | null;
}

// ─── Trading competitions (issue #93) ────────────────────────────────────────
//
// The scoring service and prize-distribution contracts are explicitly out of
// scope for the frontend issue, so these shapes are the *contract* the UI is
// built against, not a mirror of an existing backend module (unlike the types
// above). `src/lib/competitions.ts` validates them at runtime so a malformed
// or half-migrated payload degrades to an error state instead of rendering
// `undefined` into the rules page.

/** How the leaderboard is ranked. Kept as a closed set so the UI can pick a label/formatter. */
export type CompetitionScoringMethod = "percent_return" | "pnl" | "risk_adjusted";

export type CompetitionPhase = "upcoming" | "active" | "ended";

export type CompetitionRegistrationStatus =
  | "not_registered"
  | "registered"
  | "disqualified";

export type CompetitionEntryStatus = "active" | "disqualified";

/** One prize band. Ranks are 1-based and inclusive on both ends. */
export interface CompetitionPrizeTier {
  rank_from: number;
  rank_to: number;
  reward: number;
  label: string | null;
}

/**
 * The competition config the community team can set without a code change.
 * Rendered directly into the rules page (`CompetitionRules`).
 */
export interface CompetitionConfig {
  id: string;
  name: string;
  description: string;
  /** ISO-8601 instant. Parsed as an absolute time, so scheduling is DST-safe. */
  starts_at: string;
  /** ISO-8601 instant. */
  ends_at: string;
  /**
   * When opt-in closes. Three distinct cases, deliberately not collapsed:
   * omitted means "closes when the competition starts" (the conservative
   * default), `null` means "stays open until it ends", and a value is that
   * instant.
   */
  registration_closes_at?: string | null;
  eligible_underlyings: string[];
  scoring_method: CompetitionScoringMethod;
  /** Minimum trades before an entry is ranked at all (anti-gaming). */
  min_trades: number;
  /** Minimum traded notional before an entry is ranked at all (anti-gaming). */
  min_volume: number;
  /** Optional cap on trades/day; `null` disables the check. */
  max_daily_trades: number | null;
  prize_tiers: CompetitionPrizeTier[];
  /** Free-form extra bullet points shown verbatim on the rules page. */
  rules: string[];
}

/** A config plus the derived/aggregate fields the listing needs. */
export interface CompetitionSummary extends CompetitionConfig {
  entrants: number;
  finalized_at: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  wallet_address: string;
  /** Opt-in pseudonym. `null` means "show a truncated address instead". */
  display_name: string | null;
  /** The ranking value under the competition's `scoring_method`. */
  score: number;
  percent_return: number;
  pnl: number;
  volume: number;
  trades: number;
  status: CompetitionEntryStatus;
  updated_at: string;
}

export interface LeaderboardResponse {
  competition_id: string;
  scoring_method: CompetitionScoringMethod;
  entries: LeaderboardEntry[];
  total: number;
  page: number;
  page_size: number;
  as_of: string;
}

export interface CompetitionRank {
  competition_id: string;
  wallet_address: string;
  display_name: string | null;
  status: CompetitionRegistrationStatus;
  rank: number | null;
  total_entries: number;
  score: number | null;
  percent_return: number | null;
  pnl: number | null;
  volume: number;
  trades: number;
  min_trades_met: boolean;
  min_volume_met: boolean;
}

/** Signed-message challenge for competition opt-in, mirroring the auth nonce flow. */
export interface CompetitionRegistrationMessage {
  message: string;
  expires_at: string;
}

export interface CompetitionRegistration {
  competition_id: string;
  wallet_address: string;
  display_name: string | null;
  registered_at: string;
}

export interface CompetitionResultEntry extends LeaderboardEntry {
  reward: number;
}

export interface CompetitionResults {
  competition_id: string;
  scoring_method: CompetitionScoringMethod;
  finalized_at: string;
  entries: CompetitionResultEntry[];
}
