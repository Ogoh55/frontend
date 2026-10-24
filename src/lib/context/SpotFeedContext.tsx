'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// Message envelope (shared with backend realtime handler)
// ---------------------------------------------------------------------------
// All frames on the shared socket use the same versioned envelope:
//   { v: 1, topic: string, type: string, ts: number, data: unknown }
// Vault topics are keyed by vault id: `vault:<vaultId>`.
// Vault tick payload (type: 'vault.tick'):
//   { navPerShare: string, epoch: number, epochCloseAt: number, queueDepth: number }
// `ts` is the authoritative server timestamp (ms) used for skew correction.
// Versioning aligns with the vault event schema version (`v`).

export const SPOT_FEED_ENVELOPE_VERSION = 1;

export interface SpotFeedEnvelope<T = unknown> {
  v: number;
  topic: string;
  type: string;
  ts: number;
  data: T;
}

export interface VaultTickPayload {
  navPerShare: string;
  epoch: number;
  epochCloseAt: number;
  queueDepth: number;
}

export interface VaultTick extends VaultTickPayload {
  /** Server timestamp of the last authoritative update (ms). */
  updatedAt: number;
  /** Local clock offset (server - client) in ms, for skew-corrected countdowns. */
  clockSkewMs: number;
}

export type SpotFeedStatus = 'connecting' | 'open' | 'stale' | 'closed';

export interface SpotFeedContextValue {
  status: SpotFeedStatus;
  /** Subscribe to a topic; returns an unsubscribe fn. Lazy: opens socket on first sub. */
  subscribe: (topic: string, handler: (env: SpotFeedEnvelope) => void) => () => void;
  /** Latest vault tick for a vault id, or null if none received yet. */
  getVaultTick: (vaultId: string) => VaultTick | null;
}

const SpotFeedContext = createContext<SpotFeedContextValue | null>(null);

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const STALE_AFTER_MS = 20_000;

function resolveWsUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_SPOT_FEED_WS_URL;
  return url && url.length > 0 ? url : null;
}

interface SpotFeedProviderProps {
  children: ReactNode;
  /** Injectable for tests; defaults to the runtime WS URL. */
  url?: string | null;
}

export function SpotFeedProvider({ children, url }: SpotFeedProviderProps) {
  const [status, setStatus] = useState<SpotFeedStatus>('closed');
  const socketRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<(env: SpotFeedEnvelope) => void>>>(new Map());
  const vaultTicksRef = useRef<Map<string, VaultTick>>(new Map());
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current);
      staleTimerRef.current = null;
    }
  }, []);

  const armStaleTimer = useCallback(() => {
    if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
    staleTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setStatus('stale');
    }, STALE_AFTER_MS);
  }, []);

  const dispatch = useCallback((env: SpotFeedEnvelope) => {
    if (env.type === 'vault.tick') {
      const vaultId = env.topic.startsWith('vault:') ? env.topic.slice('vault:'.length) : null;
      if (vaultId) {
        const payload = env.data as VaultTickPayload;
        vaultTicksRef.current.set(vaultId, {
          ...payload,
          updatedAt: env.ts,
          clockSkewMs: env.ts - Date.now(),
        });
      }
    }
    const set = handlersRef.current.get(env.topic);
    if (set) {
      for (const handler of set) handler(env);
    }
  }, []);

  const connect = useCallback(() => {
    const wsUrl = url === undefined ? resolveWsUrl() : url;
    if (!wsUrl || !mountedRef.current) return;

    setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      setStatus('closed');
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      if (!mountedRef.current) return;
      reconnectAttemptRef.current = 0;
      setStatus('open');
      armStaleTimer();
      // Re-subscribe all active topics on (re)connect.
      for (const topic of handlersRef.current.keys()) {
        socket.send(JSON.stringify({ v: SPOT_FEED_ENVELOPE_VERSION, op: 'subscribe', topic }));
      }
    };

    socket.onmessage = (event) => {
      if (!mountedRef.current) return;
      armStaleTimer();
      if (status !== 'open') setStatus('open');
      try {
        const env = JSON.parse(event.data as string) as SpotFeedEnvelope;
        if (env && env.v === SPOT_FEED_ENVELOPE_VERSION) dispatch(env);
      } catch {
        // Ignore malformed frames.
      }
    };

    socket.onclose = () => {
      if (!mountedRef.current) return;
      socketRef.current = null;
      setStatus('closed');
      if (handlersRef.current.size === 0) return;
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    socket.onerror = () => {
      socket.close();
    };
  }, [url, dispatch, armStaleTimer, status]);

  const subscribe = useCallback(
    (topic: string, handler: (env: SpotFeedEnvelope) => void) => {
      let set = handlersRef.current.get(topic);
      if (!set) {
        set = new Set();
        handlersRef.current.set(topic, set);
        const socket = socketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ v: SPOT_FEED_ENVELOPE_VERSION, op: 'subscribe', topic }));
        } else if (!socket) {
          connect();
        }
      }
      set.add(handler);

      return () => {
        const current = handlersRef.current.get(topic);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          handlersRef.current.delete(topic);
          const socket = socketRef.current;
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ v: SPOT_FEED_ENVELOPE_VERSION, op: 'unsubscribe', topic }));
          }
        }
      };
    },
    [connect],
  );

  const getVaultTick = useCallback((vaultId: string) => {
    return vaultTicksRef.current.get(vaultId) ?? null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) socket.close();
    };
  }, [clearTimers]);

  const value = useMemo<SpotFeedContextValue>(
    () => ({ status, subscribe, getVaultTick }),
    [status, subscribe, getVaultTick],
  );

  return <SpotFeedContext.Provider value={value}>{children}</SpotFeedContext.Provider>;
}

export function useSpotFeed(): SpotFeedContextValue {
  const ctx = useContext(SpotFeedContext);
  if (!ctx) throw new Error('useSpotFeed must be used within a SpotFeedProvider');
  return ctx;
}

/**
 * Subscribe to live ticks for a single vault. Components never touch the raw
 * socket; the context owns the connection and fans out by topic.
 */
export function useVaultTicks(vaultId: string | null | undefined): {
  tick: VaultTick | null;
  status: SpotFeedStatus;
} {
  const { subscribe, getVaultTick, status } = useSpotFeed();
  const [tick, setTick] = useState<VaultTick | null>(() =>
    vaultId ? getVaultTick(vaultId) : null,
  );

  useEffect(() => {
    if (!vaultId) {
      setTick(null);
      return;
    }
    setTick(getVaultTick(vaultId));
    const topic = `vault:${vaultId}`;
    const unsubscribe = subscribe(topic, (env) => {
      if (env.type !== 'vault.tick') return;
      const payload = env.data as VaultTickPayload;
      setTick({
        ...payload,
        updatedAt: env.ts,
        clockSkewMs: env.ts - Date.now(),
      });
    });
    return unsubscribe;
  }, [vaultId, subscribe, getVaultTick]);

  return { tick, status };
}

/**
 * Derive seconds-to-epoch-close locally from the last authoritative timestamp
 * (skew-corrected) rather than trusting per-second server pushes.
 */
export function useEpochCountdown(tick: VaultTick | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!tick) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tick]);

  if (!tick) return null;
  const serverNow = now + tick.clockSkewMs;
  return Math.max(0, Math.floor((tick.epochCloseAt - serverNow) / 1000));
}
