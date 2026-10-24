import { apiGet, apiPost } from "./client";
import type {
  CompetitionRank,
  CompetitionRegistration,
  CompetitionRegistrationMessage,
  CompetitionResults,
  CompetitionSummary,
  LeaderboardResponse,
} from "./types";

// Typed client for the trading-competition endpoints (issue #93).
//
// The scoring service is out of scope for the frontend work, so this file is
// the contract the UI is written against. Every read here is safe to call with
// no token: competitions are public information, and the backend decides
// whether to enrich a response with the caller's own registration state.
//
// Opt-in is a two-step signed-message flow rather than a bearer-token POST,
// because the signature is what authorises *this wallet* to enter *this*
// competition — a stolen session token should not be enough to register an
// address the signer does not control. It mirrors the sign-in flow in
// `api/auth.ts`; `useCompetitionRegistration` wires the Freighter signing step.

function competitionPath(id: string): string {
  return `/api/v1/competitions/${encodeURIComponent(id)}`;
}

/** All competitions, newest first. Public — no token required. */
export function listCompetitions(token?: string | null): Promise<CompetitionSummary[]> {
  return apiGet("/api/v1/competitions", token);
}

export function getCompetition(
  id: string,
  token?: string | null
): Promise<CompetitionSummary> {
  return apiGet(competitionPath(id), token);
}

export interface LeaderboardQuery {
  page?: number;
  pageSize?: number;
  /** Free-text match against display name or address. */
  search?: string;
  token?: string | null;
}

/**
 * One page of the leaderboard. Pagination and search are server-side: a
 * competition can have far more entrants than is reasonable to ship to the
 * browser, and searching the current page only would be a lie.
 */
export function getLeaderboard(
  id: string,
  { page = 1, pageSize = 25, search, token }: LeaderboardQuery = {}
): Promise<LeaderboardResponse> {
  const params = new URLSearchParams({
    page: String(Math.max(1, Math.floor(page))),
    page_size: String(Math.max(1, Math.floor(pageSize))),
  });
  const trimmed = search?.trim();
  if (trimmed) params.set("search", trimmed);
  return apiGet(`${competitionPath(id)}/leaderboard?${params.toString()}`, token);
}

/**
 * The caller's own row. Requires a token; returns `null` when the caller has
 * never opted in, so the UI can distinguish "not registered" from "registered,
 * currently unranked".
 */
export function getMyRank(id: string, token: string): Promise<CompetitionRank | null> {
  return apiGet(`${competitionPath(id)}/me`, token);
}

/** Challenge text the wallet signs to opt in. */
export function requestRegistrationMessage(
  id: string,
  walletAddress: string
): Promise<CompetitionRegistrationMessage> {
  return apiPost(`${competitionPath(id)}/registration-message`, {
    wallet_address: walletAddress,
  });
}

export interface RegisterParams {
  competitionId: string;
  walletAddress: string;
  /** Exact challenge text that was signed — the backend re-derives it. */
  message: string;
  /** base64-encoded ed25519 signature, as returned by Freighter's `signBlob`. */
  signature: string;
  /** Opt-in pseudonym. Omit to stay address-only. */
  displayName?: string | null;
  token?: string | null;
}

export function registerForCompetition({
  competitionId,
  walletAddress,
  message,
  signature,
  displayName,
  token,
}: RegisterParams): Promise<CompetitionRegistration> {
  return apiPost(
    `${competitionPath(competitionId)}/register`,
    {
      wallet_address: walletAddress,
      message,
      signature,
      display_name: displayName?.trim() ? displayName.trim() : null,
    },
    token
  );
}

/**
 * Set or clear the opt-in display name after registering. Clearing it (empty
 * string) drops the entry back to a truncated address — a pseudonym is never
 * forced, and must remain reversible.
 */
export function setCompetitionDisplayName(
  id: string,
  displayName: string,
  token: string
): Promise<CompetitionRegistration> {
  return apiPost(
    `${competitionPath(id)}/display-name`,
    { display_name: displayName.trim() ? displayName.trim() : null },
    token
  );
}

/** Final standings with rewards. Only meaningful once `finalized_at` is set. */
export function getCompetitionResults(
  id: string,
  token?: string | null
): Promise<CompetitionResults> {
  return apiGet(`${competitionPath(id)}/results`, token);
}
