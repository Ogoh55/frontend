// Global motion preference. The OS `prefers-reduced-motion` setting is the
// default; the user can override it in-app. The resolved value is mirrored to
// `data-motion` on <html> (see src/components/a11y/A11yRoot.tsx), and
// globals.css keys every animation and transition off that attribute.
import { useSyncExternalStore } from "react";

export type MotionOverride = "system" | "reduce" | "full";
export type MotionPreference = "reduce" | "full";

export const MOTION_STORAGE_KEY = "zenith:motion";
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

const listeners = new Set<() => void>();

function readOverride(): MotionOverride {
  try {
    const v = window.localStorage.getItem(MOTION_STORAGE_KEY);
    return v === "reduce" || v === "full" ? v : "system";
  } catch {
    return "system";
  }
}

function systemPrefersReduced(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(REDUCED_QUERY).matches;
}

export function getMotionOverride(): MotionOverride {
  return typeof window === "undefined" ? "system" : readOverride();
}

export function getMotionPreference(): MotionPreference {
  const override = getMotionOverride();
  if (override !== "system") return override;
  return systemPrefersReduced() ? "reduce" : "full";
}

export function setMotionOverride(override: MotionOverride): void {
  try {
    window.localStorage.setItem(MOTION_STORAGE_KEY, override);
  } catch {
    // Storage can be blocked (private mode); the override then lasts for this page only.
  }
  listeners.forEach((l) => l());
}

export function subscribeMotion(l: () => void): () => void {
  listeners.add(l);
  if (typeof window === "undefined") return () => listeners.delete(l);
  const mql = window.matchMedia?.(REDUCED_QUERY);
  const onStorage = (e: StorageEvent) => {
    if (e.key === MOTION_STORAGE_KEY) l();
  };
  // Safari < 14 only has the deprecated addListener — feature-detect both.
  if (mql?.addEventListener) mql.addEventListener("change", l);
  else mql?.addListener(l);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    if (mql?.removeEventListener) mql.removeEventListener("change", l);
    else mql?.removeListener(l);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Resolved motion preference for React components. Server and hydration
 * render as "full"; the real value lands right after hydration. Components
 * that drive JS animation (rAF loops, auto-rotate timers) should branch on
 * this; CSS-only animations are handled by the `data-motion` attribute.
 */
export function useMotionPreference(): MotionPreference {
  return useSyncExternalStore(subscribeMotion, getMotionPreference, () => "full" as const);
}
