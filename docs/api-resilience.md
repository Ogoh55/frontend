# API client resilience

`src/lib/api/client.ts` sends every backend request through a composable
middleware stack in `src/lib/api/resilience/`:

```
apiGet / apiPost / apiDelete
  └─ withDedup     collapse identical in-flight GETs (method + URL + Authorization)
     └─ withRetry  idempotent-only retries, jittered backoff, Retry-After, per-origin budget
        └─ withBreaker  per-origin circuit breaker + Retry-After gate
           └─ withTimeout  per-attempt AbortController timeout (default 10s), linked to caller signal
              └─ fetch
```

Each middleware is a `(next: Fetcher) => Fetcher` and can be tested or reused
alone. `createResilientFetch(options)` builds the standard stack;
`setApiTransport()` swaps it (tests).

## Retry policy

| Request | Automatic retry? | Notes |
|---|---|---|
| `GET` / `HEAD` / `OPTIONS` | Yes, up to 3 attempts | Network errors, timeouts, 408, 429, 500, 502, 503, 504 |
| `POST` / `PUT` / `PATCH` / `DELETE` | **Never** | Replaying a trade can double-fill. The user re-confirms. |
| Any request, caller aborted | Never | |
| Any request, circuit open / inside Retry-After | Never (fails fast) | |

- **Backoff:** full jitter, `random(0, min(5s, 300ms · 2^attempt))`.
- **Retry-After (429/503):** parsed as seconds or HTTP-date. Waits up to 10s
  (plus up to 300ms of jitter so tabs don't wake up together). Longer
  windows go back to the caller as `ApiError { status: 429, reason: "rate_limited", retryAfterMs }`.
- **Budget:** per-origin token bucket. Each request adds 0.2 tokens and each
  retry spends 1, with a starting balance of 3 and a cap of 10. Retries stay
  at about 20% of traffic, so a failing backend isn't hit with 3x the load.
- TanStack Query does **not** retry `ApiError`s (`src/lib/api/queryPolicy.ts`),
  and mutations never retry.

## Circuit breaker (per origin)

`closed → open` after 5 consecutive failures (network error, timeout, 5xx
except 501). 4xx, 429 and aborts don't count either way. While the breaker is
`open`, requests reject right away with `ApiError { status: 503, reason: "circuit_open" }`
and never reach the network. POSTs are rejected too, so a trade is never sent
into an outage. After the cooldown (15s at first) the breaker goes
`half-open` and lets exactly one probe through. If the probe succeeds, the
breaker closes. If it fails, the breaker opens again and the cooldown doubles,
up to a cap of 2 minutes.

## Degraded-mode UX

`apiHealth` (`resilience/health.ts`) publishes per-origin breaker state and
Retry-After windows. `useApiHealth()` reads them and `<ApiHealthBanner>`
(mounted under `AppHeader`) shows a countdown:

- *Rate limited — pausing requests for 12s.*
- *Zenith backend degraded — showing last known data. Retrying in 9s.*

Polling queries use `refetchInterval: pollInterval(4000)`. The interval slows
to ≥30s while the API is degraded.

## Timeouts and cancellation

Every attempt has its own timeout (10s by default). You can override it per
call with `{ timeoutMs }`. Pass `{ signal }` (for example, TanStack Query's
`queryFn: ({ signal }) => …`) so that unmounting cancels the request. A
timeout surfaces as `ApiError { status: 408, reason: "timeout" }`. A caller
abort rejects with the native `AbortError`.

Deduplicated GETs are reference-counted. If one caller aborts, only that
caller detaches. The shared fetch is aborted only when every caller has
aborted.

## Idempotency key contract

Effectful POSTs (open, close, roll) accept `{ idempotencyKey }`, which is
sent as the `Idempotency-Key` header:

- The value is a UUID v4, scoped to the authenticated wallet.
- The backend stores `(wallet, key) → first response` for at least 24h:
  - If a repeat has the same key and the same body, the backend returns the
    stored response and executes nothing new.
  - If a repeat has the same key and a different body, the backend returns `422`.
  - If the first request is still in flight, the backend returns `409`. The
    client shows this as an error and the user can resubmit.
- Backends without support ignore the header, so it is always safe to send.

Key lifecycle (`IntentKeyManager` / `useIdempotencyKey`): one key per user
*intent*. Clicking Confirm again with the same parameters, for example after
a timeout, reuses the key. Changing any parameter, or a successful submit,
mints a new key.

```ts
const { keyFor, complete } = useIdempotencyKey();
await openPosition(params, token, { idempotencyKey: keyFor(params) });
complete();
```

Margin-vault deposits and withdrawals (`src/lib/api/vault.ts`) follow the same
contract: the BFF forwards `Idempotency-Key` to `build-deposit` and
`build-withdraw`. A submit that times out or drops its response is not treated
as a failure. The client computes the transaction hash locally and checks the
ledger. If the ledger has not confirmed it, the call throws
`VaultSubmissionUnknownError` with the hash. The UI then shows "awaiting
confirmation" and blocks Confirm until the outcome is known. The key is kept
for the intent, and it is released only after the transaction is confirmed.

## Tests

- `src/lib/api/resilience/__tests__/*` — unit tests with fake timers for every policy branch.
- `src/lib/api/__tests__/client.resilience.msw.test.ts` — MSW scenarios:
  flaky GET, POST 503, long and short 429, dedup, outage → open circuit,
  timeout, cancellation, hostile error strings.

Run `npm run test:coverage -- src/lib/api` to check coverage. The target is 90%
for `src/lib/api/resilience/**` and is enforced in `jest.config.js`.
