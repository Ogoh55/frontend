# Realtime Protocol

This document describes the shared WebSocket connection used by the app for live
market and vault data. The connection is owned by a single context
(`src/lib/context/SpotFeedContext.tsx`); components never touch the raw socket
and instead consume typed hooks/selectors.

## Connection

The socket URL is provided by runtime config (`src/env.ts`). The client opens a
single connection and multiplexes all topics over it. Subscriptions are lazy
(created on first consumer, released on unmount) and messages are batched at a
sane cadence so there is no per-block rendering storm.

## Message envelope

All messages share one envelope, versioned with the vault event schema version
(do not invent a second scheme):

```jsonc
{
  "v": 1,                 // schema version, aligned with vault event schema
  "type": "vault.tick",   // message type
  "topic": "vault:0xabc",// subscription topic key
  "ts": 1717171717000,   // server timestamp (ms since epoch, authoritative)
  "data": { /* type-specific payload */ }
}
```

### `vault.tick` payload

Keyed by vault id (`vault:<id>`):

```jsonc
{
  "vaultId": "0xabc",
  "navPerShare": "1.0421",   // decimal string, NAV per share
  "epoch": 42,               // current epoch number
  "secondsToEpochClose": 3600, // seconds until epoch close (authoritative)
  "queueDepth": "125000.00", // redemption queue depth (decimal string)
  "updatedAt": 1717171717000  // last-updated timestamp (ms)
}
```

The client derives the epoch countdown locally from `secondsToEpochClose` and
the envelope `ts` rather than trusting per-second server pushes. Clock skew is
handled by anchoring to the server timestamp.

## Subscription lifecycle

- Topics are subscribed lazily on first consumer and released on unmount.
- On socket drop the client marks data stale/offline and reconnects with
exponential backoff; on resume it re-subscribes to active topics.
- First paint uses server data (SSR/hydration safe), then hydrates to live
values without layout shift.

## Out of scope

Push notifications/alerts for epoch and redemption events, and the backend
indexer that produces the underlying data, are handled separately.
