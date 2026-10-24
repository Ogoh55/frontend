// Framework-agnostic live-region announcer. Non-React code (the realtime
// client, stores) calls `announce`; React subscribes via
// `subscribeAnnouncements`/`getAnnouncements` and renders the two regions
// (see src/components/a11y/A11yRoot.tsx).
//
// Queue behaviour: assertive items jump ahead of polite ones, items are
// spoken one at a time with a short gap so screen readers don't drop them,
// and a message is dropped while an identical dedupeKey is still queued or
// was spoken within its throttleMs window.

export type AnnouncePriority = "polite" | "assertive";

export interface AnnounceOptions {
  priority?: AnnouncePriority;
  /** Identical keys are dropped while queued. Defaults to the message text. */
  dedupeKey?: string;
  /** Minimum ms between announcements that share a dedupeKey. */
  throttleMs?: number;
}

export interface AnnouncerState {
  polite: string;
  assertive: string;
}

interface QueuedAnnouncement {
  message: string;
  priority: AnnouncePriority;
  key: string;
}

const GAP_MS = 150;
const EMPTY_STATE: AnnouncerState = { polite: "", assertive: "" };

const queue: QueuedAnnouncement[] = [];
const queuedKeys = new Set<string>();
const lastSpokenAt = new Map<string, number>();
const listeners = new Set<() => void>();
let state: AnnouncerState = EMPTY_STATE;
let timer: ReturnType<typeof setTimeout> | null = null;

const emit = () => listeners.forEach((l) => l());

/** Only the visible tab speaks; background tabs drop their announcements. */
const isSilent = () => typeof document !== "undefined" && document.hidden;

export const subscribeAnnouncements = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const getAnnouncements = () => state;

function schedule() {
  timer = setTimeout(flush, GAP_MS);
}

function flush() {
  timer = null;
  const assertiveIdx = queue.findIndex((q) => q.priority === "assertive");
  const item = queue.splice(assertiveIdx === -1 ? 0 : assertiveIdx, 1)[0];
  if (!item) return;
  queuedKeys.delete(item.key);
  if (!isSilent()) {
    lastSpokenAt.set(item.key, Date.now());
    // Re-announcing identical text is ignored by most screen readers, so
    // append a no-break space to change the node's contents.
    const current = state[item.priority];
    const text = current === item.message ? `${item.message} ` : item.message;
    state = { ...state, [item.priority]: text };
    emit();
  }
  if (queue.length) schedule();
}

export function announce(message: string, opts: AnnounceOptions = {}): void {
  if (!message || isSilent()) return;
  const { priority = "polite", throttleMs = 0 } = opts;
  const key = opts.dedupeKey ?? message;
  if (queuedKeys.has(key)) return;
  const last = lastSpokenAt.get(key);
  if (throttleMs > 0 && last !== undefined && Date.now() - last < throttleMs) return;
  queue.push({ message, priority, key });
  queuedKeys.add(key);
  if (timer === null) schedule();
}
