import { useEffect, useState } from "react";

/**
 * The current time, or `null` until the first mount.
 *
 * Phase-dependent UI cannot be rendered during server rendering: `Date.now()`
 * on the server and in the browser are different instants, so rendering "3d
 * left" server-side and something else client-side is a hydration mismatch. A
 * `null` first value lets callers render a stable placeholder instead, and the
 * returned clock ticks so a page left open crosses "upcoming → live" on its
 * own rather than on refresh.
 */
export function useNow(refreshMs = 60_000): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    if (refreshMs <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  return now;
}

/**
 * Debounce a value. Used so the leaderboard search is one request per pause
 * rather than one per keystroke — the search is a server round-trip.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
