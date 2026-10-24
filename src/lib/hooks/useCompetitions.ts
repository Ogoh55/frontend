import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCompetition,
  getCompetitionResults,
  getLeaderboard,
  getMyRank,
  listCompetitions,
} from "../api/competitions";
import type {
  CompetitionRank,
  CompetitionResults,
  CompetitionSummary,
  LeaderboardResponse,
} from "../api/types";
import { DEFAULT_LEADERBOARD_REFRESH_MS } from "../competitions";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

/** All competitions. Public data, so no token is required to read the list. */
export function useCompetitions(token: string | null) {
  const [competitions, setCompetitions] = useState<CompetitionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return listCompetitions(token)
      .then((rows) => {
        setCompetitions(rows);
        setError(null);
      })
      .catch((err) => {
        setCompetitions([]);
        setError(messageOf(err));
      })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { competitions, loading, error, refresh };
}

export function useCompetition(id: string, token: string | null) {
  const [competition, setCompetition] = useState<CompetitionSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return getCompetition(id, token)
      .then((row) => {
        setCompetition(row);
        setError(null);
      })
      .catch((err) => {
        setCompetition(null);
        setError(messageOf(err));
      })
      .finally(() => setLoading(false));
  }, [id, token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { competition, loading, error, refresh };
}

export interface UseLeaderboardOptions {
  token?: string | null;
  page?: number;
  pageSize?: number;
  search?: string;
  /** Re-poll cadence in ms. `0` disables polling (used for an ended event). */
  refreshMs?: number;
  /** Skip fetching entirely (e.g. the config has not validated yet). */
  enabled?: boolean;
}

/**
 * One page of the leaderboard, kept fresh on a cadence.
 *
 * Polling stops while the tab is hidden and immediately refetches when it
 * comes back, so a backgrounded tab is not a source of load and a returning
 * one is not showing stale standings. Pagination and search are server-side —
 * a competition can have more entrants than it is reasonable to ship to the
 * browser, and searching only the current page would be misleading.
 */
export function useLeaderboard(
  id: string,
  {
    token = null,
    page = 1,
    pageSize,
    search = "",
    refreshMs = DEFAULT_LEADERBOARD_REFRESH_MS,
    enabled = true,
  }: UseLeaderboardOptions = {}
) {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return Promise.resolve();
    setLoading(true);
    return getLeaderboard(id, { page, pageSize, search, token })
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => {
        // Keep the last good page on a transient polling failure rather than
        // blanking a board that was working a second ago.
        setError(messageOf(err));
      })
      .finally(() => setLoading(false));
  }, [enabled, id, page, pageSize, search, token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled || refreshMs <= 0) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(() => refreshRef.current(), refreshMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshRef.current();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refreshMs]);

  return { data, entries: data?.entries ?? [], loading, error, refresh };
}

/**
 * Final standings. Only fetched once the competition is over — asking for
 * results during the event is a guaranteed empty response, so the caller gates
 * this on the derived phase rather than the hook guessing.
 */
export function useCompetitionResults(id: string, enabled: boolean, token: string | null) {
  const [results, setResults] = useState<CompetitionResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) {
      setResults(null);
      return Promise.resolve();
    }
    setLoading(true);
    return getCompetitionResults(id, token)
      .then((res) => {
        setResults(res);
        setError(null);
      })
      .catch((err) => {
        setResults(null);
        setError(messageOf(err));
      })
      .finally(() => setLoading(false));
  }, [enabled, id, token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { results, loading, error, refresh };
}

/** The caller's own row, or `null` when they have never opted in. */
export function useMyRank(id: string, token: string | null) {
  const [rank, setRank] = useState<CompetitionRank | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!token) {
      setRank(null);
      setError(null);
      return Promise.resolve();
    }
    setLoading(true);
    return getMyRank(id, token)
      .then((row) => {
        setRank(row);
        setError(null);
      })
      .catch((err) => {
        setRank(null);
        setError(messageOf(err));
      })
      .finally(() => setLoading(false));
  }, [id, token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { rank, loading, error, refresh };
}
