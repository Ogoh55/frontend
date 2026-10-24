"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getAnnouncements, subscribeAnnouncements, type AnnouncerState } from "../../lib/a11y/announcer";
import { useMotionPreference } from "../../lib/a11y/motion";

const EMPTY: AnnouncerState = { polite: "", assertive: "" };

/**
 * App-wide a11y root, mounted once in the locale layout. Renders the single
 * pair of live regions that `announce()` writes to, and keeps
 * `<html data-motion>` in sync with the resolved motion preference.
 */
export function A11yRoot() {
  const { polite, assertive } = useSyncExternalStore(subscribeAnnouncements, getAnnouncements, () => EMPTY);
  const motion = useMotionPreference();

  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </div>
    </>
  );
}
