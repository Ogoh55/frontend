# Zenith Frontend

Next.js 14 (App Router) options trading terminal for Zenith, a decentralized
options protocol on Stellar Soroban. Options chain, portfolio, trade history,
multi-leg strategy builder, and a vol surface — all in a dense,
Bloomberg-style dark UI.

## Status: wired up to the real backend

Account, positions, trade history, watchlist, and alerts all come from the
real backend API now (`src/lib/api/*.ts`), not `localStorage` — the local
zustand stores for those were removed once the backend versions replaced
them; `src/lib/store/` now holds only `wallet.ts`. A shared WebSocket
connection (`src/lib/context/SpotFeedContext.tsx`) feeds live spot/vol
ticks into the options chain and portfolio pages. Wallet sign-in is a real
end-to-end flow: connect via Freighter → request a nonce → sign it with
`freighterApi.signBlob` → exchange it at `POST /api/bff/session`, which
verifies with the backend and keeps the bearer token in an encrypted
httpOnly cookie. The BFF attaches it server-side to every authed request
(see "Session & hydration" below). That said, the signature encoding
hasn't been manually confirmed against a live Freighter extension (no
extension available in this environment) — the flow is logically complete,
not hardware-tested.

Client-side Black-Scholes pricing (`src/lib/pricing.ts`) hasn't gone away —
it's now a fallback and preview layer rather than the primary source: the
options chain falls back to it if the backend fetch fails, per-row live
Greeks in the positions table are computed locally rather than
round-tripped, and multi-leg strategy *preview* pricing (before execution)
is local-only. The backend's `/api/v1/portfolio/payoff` endpoint has a
typed client (`src/lib/api/payoff.ts`) but nothing in the app calls it yet —
the payoff diagram still uses local math (`src/lib/payoff.ts`).

## Getting started

```bash
npm install
cp .env.local.example .env.local   # see "Environment" below
npm run dev
# http://localhost:3000
```

Configuration is validated in `src/env.ts`. Local development defaults to the
backend at `http://localhost:8081`; production builds require an API URL,
selected Stellar network, and a valid contract ID for that network. The
runtime `/api/runtime-config` endpoint lets the same tagged image use separate
staging and production settings. See [RELEASING.md](RELEASING.md) for release,
deployment, and rollback setup.

Run the [backend](https://github.com/Zenith-options/backend) alongside it
(`cargo run`, default port 8081) for account/positions/history/watchlist/
alerts/live spot to actually load — without it, only the home page's local
preview chain and the options chain's client-side BS fallback will render.

```bash
npm run build   # production build
npm run lint     # next lint
npm test         # vitest — contract verification unit tests
npm run build      # production build
npm run lint       # next lint
npm run typecheck  # tsc --noEmit
npm test           # unit + React Testing Library tests (Vitest, jsdom)
npm run test:e2e   # Playwright: desktop Chrome, iPhone 13 (WebKit), Pixel 7
```

The Playwright suite builds and starts the app itself and fakes the backend
per test (`e2e/mockBackend.ts`), so no backend needs to be running. WebKit
needs system libraries: `npx playwright install --with-deps chromium webkit`.
Visual baselines live in `e2e/*-snapshots/`, one per device and platform; a
device with no committed baseline skips its visual test. Generate one with
`npx playwright test --project=<device> --update-snapshots`.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests and build;
the Playwright suite with a video of every test (uploaded as the
`playwright-report` artifact); and Lighthouse CI on a 375px mobile profile
(`lighthouserc.json`), which fails if CLS exceeds 0.05 or the mobile
performance score drops below 0.85 on any page.

A render performance harness (dev-only) lives at `http://localhost:3000/__perf` — drives four scripted tick sequences through real components and exports JSON metrics. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for the full guide, hotspot fixes, and CI setup.

## Environment modes: Paper, Testnet, Mainnet

The terminal always runs in exactly one mode, chosen in the header
(`src/components/env/EnvironmentSelector.tsx`). Every per-network setting
(API URL, Soroban RPC, network passphrase, contract IDs, colors) lives in one
typed registry, `src/lib/env/networks.ts`, configured through the env vars
in `.env.local.example`.

- **Impossible to miss:** a full-width banner and a page frame on every page
  (dashed slate for paper, amber for testnet, red for mainnet), a
  `[PAPER]`/`[TESTNET]`/`[MAINNET]` title prefix, a mode-colored favicon, and
  a mode stamp at the top of every confirm dialog. An inline `<head>` script
  applies the persisted mode before first paint, so mainnet never flashes
  as paper.
- **Impossible to mix:** persisted state is namespaced per mode
  (`zenith:<mode>:wallet` and so on, in `src/lib/env/storage.ts`). The API
  client resolves its base URL from the active mode on every call, and
  refuses to fall back when a mode has no backend configured. All in-memory
  data providers are keyed by mode (`src/components/AppProviders.tsx`), so a
  switch discards every cache rather than showing the old mode's data.
- **Guarded:** switching to mainnet always needs an explicit
  acknowledgement, and is refused while a connected Freighter wallet is on
  another network. If Freighter changes network mid-session (it's polled every
  3s), trading is blocked until it matches. A `?mode=testnet` or `?mode=paper`
  link switches directly; `?mode=mainnet` only ever raises a prompt.

## Loading, empty, error and signed-out states

Every data surface (chain, positions, portfolio, history, watchlist, alerts,
account chip, risk panel) renders exactly one of: a layout-matching
skeleton, a signed-out prompt with a connect CTA, a recoverable error with
retry, an empty state with a next step, or the data. The pieces are:

- `src/lib/query.ts`: `useAsyncQuery`, an explicit `idle | loading |
  success | error` status per query. It discards responses for a stale key and
  keeps the last good data (flagged) when a background refresh fails. A 401
  clears the session, so surfaces fall back to signed-out.
- `src/components/states/`: `Skeleton`, `EmptyState`, `ErrorState`,
  `AuthGate`, and `DataBoundary`, which picks the right one from a query and
  the auth status. Pre-hydration, auth is "unknown" and renders the
  skeleton, which is what SSR rendered too.
- Balances are `null` until loaded and never render as `$0.00`. Skeleton
  shimmer is off under `prefers-reduced-motion`.

## Phones and tablets

- ≤1024px: the market sidebar becomes a **Market** tab, tabs scroll and
  respond to swipes, and the order ticket opens as a focus-trapped **bottom
  sheet** (`src/components/BottomSheet.tsx`) that can be dragged down to
  dismiss and lifts above the on-screen keyboard.
- ≤640px chain container (a container query): one side at a time behind a
  Calls/Puts toggle, with a sticky strike column.
- Portfolio, history and positions tables become expandable cards (container
  queries, `src/components/ExpandableCard.tsx`).
- Payoff charts size to their container and support a touch or mouse
  crosshair, pinch/ctrl-wheel zoom, and keyboard control
  (`src/lib/hooks/useChartGestures.ts`).
- Tap targets are ≥44×44 on touch and narrow layouts. Full-height pages use
  `dvh` and respect the safe-area insets.

## Onboarding and education (`src/features/onboarding/`)

- **Tour:** chain → ticket → confirm → portfolio. It's skippable, pausable
  (Esc) and resumable from the header's **?** menu, and its progress
  persists. Steps anchor to `data-tour` attributes, not CSS classes, and
  re-measure on resize, scroll and DOM changes. When an anchor isn't on
  screen, the step explains how to get there.
- **Glossary:** `<Term id="theta">` gives any term an accessible definition
  that works on hover, focus and tap, meeting WCAG 1.4.13 (dismissible,
  hoverable, persistent). Used for every Greek and trading term in the
  terminal, portfolio and history.
- **Plain-language summaries:** every trade confirmation is described by the
  pure `describeTrade(legs, context)`. It computes exact breakevens, max
  loss and max profit from the piecewise-linear payoff, for example: "You're
  selling 2 BTC 70k calls expiring in 30 days. You collect $3,000.00 now. If
  BTC is above $71,500.00 at expiry you lose money; losses are unlimited
  above that."
- **Practice mode:** confirmations simulate the trade locally and send
  nothing, with no wallet needed.
- All copy lives in `content/<locale>/*.json` (glossary, tour, trade
  templates), ready for i18n.

### Environment

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | client + server | Backend base URL (default `http://localhost:8081`) |
| `NEXT_PUBLIC_SITE_URL` | client + server | Public origin of this frontend, for absolute share-link and OG image URLs (default `http://localhost:3000`) |
| `SHARE_SIGNING_SECRET` | **server only** | ≥ 32-char HMAC key that signs share-card links. Never give it a `NEXT_PUBLIC_` prefix. Generate with `openssl rand -base64 48`. Without it, sharing returns 503 and everything else works. Rotating it invalidates every existing share link. |

## Pages

| Route | What's there |
|---|---|
| `/` | Marketing/landing page, live preview chain, watchlist |
| `/options` | The terminal: chain, positions, strategy builder, vol surface |
| `/portfolio` | Open positions marked-to-market, roll, close, CSV export, portfolio-wide risk panel |
| `/history` | Full trade ledger (opens + closes) with realized P&L stats |
| `/contracts` | Contract registry — every contract per network, with a live deployed-WASM-hash check |
| `/contracts.json` | The same registry, machine-readable (`schema: zenith.contract-registry/1`) |
| `/options` | The terminal: chain, positions, strategy builder, vol surface, customizable workspace (≥1024px) |
| `/portfolio` | Open positions marked-to-market, partial/batch/strategy close, roll, CSV export, collateral & margin dashboard, portfolio-wide risk panel with probability analytics, P&L attribution |
| `/history` | Full trade ledger (opens + closes) with realized P&L stats, performance analytics (equity curve, drawdown, breakdowns), period statements (CSV/PDF), per-trade share cards |
| `/calendar` | Expiry calendar (month/list), settlement center, `.ics` download |
| `/docs` | MDX protocol documentation hub with interactive calculators (BS pricer, collateral, payoff playground) |
| `/share/[id]` | Public page for a signed share card, with Open Graph / Twitter previews |
| `/notifications` | Full notification history with filters, and per-category browser notification preferences |
| `/compete` | Competition listing, grouped by phase (live / upcoming / past) |
| `/compete/[id]` | Opt-in, live leaderboard, personal rank card, and final results |
| `/compete/[id]/rules` | The config-rendered rules page for one competition |

Every page's header also has a **watchlist** menu and a **notification
bell** (see below).

The `/options` page is tabbed below 1024px (and via the Tabs toggle):

- **Chain** — configurable columns, strike windows (±N / delta), ATM jump, optional dual-expiry compare. Click an ask to buy, a bid to write.
- **Positions** — quick view of open positions for the selected symbol;
  "Manage →" links to `/portfolio` for the actual close/roll actions.
- **Strategies** — 15 templated multi-leg structures (straddle, strangles,
  verticals, butterflies, iron condor/butterfly, collar, ratio spreads,
  call calendar/diagonal, jade lizard), each tagged with outlook, vol view
  and defined/undefined risk. Picking one resolves it onto the chain's
  listed strikes in an editable builder (flip legs, step strikes, per-leg
  expiry, add/remove legs) with a combined payoff diagram; legs execute
  atomically. Undefined-risk positions show a warning and need an explicit
  acknowledgement to execute. Calendars/diagonals chart P&L at the nearest
  expiry with the longer-dated leg marked to model. Previews can be shared as a card.
- **Finder** — state an outlook, a target price (drag the marker on the
  chart) and date, a max loss and a budget; it ranks candidate strategies
  from the library across listed strikes/expiries by probability of
  profit, P&L at target and return on risk, in a Web Worker. "Load →"
  opens a candidate in the builder.
- **Surface** — an IV heatmap across strikes and expiries, with a simple
  term-structure model (skew dampens for longer-dated options).

On wide viewports, **Workspace** mode (react-grid-layout) lets you drag/resize
panels (chain, ticket, payoff, spot, smile, positions, alerts, surface,
strategies), apply Trader / Vol / Writer presets, and save/export/import
layouts per wallet.

Pages live under `src/app/[locale]/`. English is served unprefixed and
Spanish and Portuguese at `/es/…` and `/pt/…`. See [docs/i18n.md](docs/i18n.md).
Security headers and CSP: [docs/security-headers.md](docs/security-headers.md).
Clear-signing: [docs/clear-signing.md](docs/clear-signing.md).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘/Ctrl+K` or `/` | Command palette (fuzzy search; recent commands) |
| `?` | Shortcut help overlay |
| `1`–`4` | Chain / Positions / Strategies / Surface tabs |
| `[` / `]` | Previous / next expiry |
| `B` / `S` | Open buy / write ticket on focused strike (confirm still required) |
| `A` | Jump to ATM |
| `⇧P` / `⇧H` / `⇧O` | Portfolio / History / Options |

Hotkeys are disabled inside text inputs. Bindings persist in
`localStorage` (`zenith.hotkeys.v1`). Palette commands like "BTC 30D",
"buy call", "go portfolio", "toggle surface" are registered via
`src/components/command/registry.ts`.
## Trading competitions

`/compete` lists every competition, `/compete/[id]` is the running event
(opt-in, live leaderboard, personal rank, final results), and
`/compete/[id]/rules` is the shareable rules page. The module is
**config-driven**: a competition is data, and everything the UI shows — dates,
eligible underlyings, scoring method, minimum trades/volume, prize tiers, extra
rules — comes from that payload rather than a source file, so the community
team can schedule the next event without a frontend change.

- **Config schema & validation** — `src/lib/competitions.ts`. Payloads are
  validated before render (`validateCompetitionConfig`), so a malformed
  competition degrades to a readable error instead of `undefined` / `Invalid
  Date` in the rules page.
- **Phase is derived, never stored** — `phaseOf()` compares absolute instants,
  so a competition crosses Upcoming → Live → Ended on its own and scheduling is
  DST-safe. Boundaries are half-open: `starts_at` is already live, `ends_at` is
  already ended. `registration_closes_at` may be omitted (closes at the start,
  the conservative default) or `null` (stays open to the end).
- **Opt-in is a signed message** — `useCompetitionRegistration` requests a
  backend challenge, signs it with Freighter, and posts the signature. A bearer
  token alone must not be able to enter an address the signer does not control.
- **Live leaderboard** — server-side pagination and search (searching only the
  loaded page would be a lie), a selectable refresh cadence that pauses while
  the tab is hidden, shared ranks for ties (`=3`), and disqualification shown on
  the row rather than hidden.
- **Privacy** — a display name is opt-in and reversible; without one, a
  truncated address is shown (`displayNameFor`). It is never inferred.
- **Anti-gaming is displayed** — the minimum trades/volume and any daily cap are
  rendered on the rules page and in the entrant's own rank card, so an entry
  that cannot qualify learns that before trading, not at payout.

### Competitions API contract

The scoring service and prize-distribution contracts are out of scope for the
frontend issue, so `src/lib/api/competitions.ts` is the contract the UI is
written against:

| Method | Path |
|---|---|
| `GET` | `/api/v1/competitions` |
| `GET` | `/api/v1/competitions/:id` |
| `GET` | `/api/v1/competitions/:id/leaderboard?page&page_size&search` |
| `GET` | `/api/v1/competitions/:id/me` |
| `POST` | `/api/v1/competitions/:id/registration-message` |
| `POST` | `/api/v1/competitions/:id/register` |
| `POST` | `/api/v1/competitions/:id/display-name` |
| `GET` | `/api/v1/competitions/:id/results` |

Until the backend implements them, the pages show their honest empty/error
states — no seeded or mock data is rendered as if it were real.

## Architecture

Options module map (`src/app/options/_components/`): `MarketHeader` (symbol
tabs, spot, expiries), `MarketSidebar`, `ViewTabs`, `ChainTable` +
`useOptionChain` (fetch, 4s polling, Black-Scholes fallback), `TradeTicket` +
`useTradeTicket` (validation, collateral, funds), `PositionsTab`,
`StrategiesTab` + `useStrategyPreview`, `SurfaceTab`, `PortfolioBar`,
`StatusBar`. `page.tsx` only composes them.

```
src/
├── app/                  # Next.js App Router pages
│   ├── layout.tsx        # SpotFeed + BackendData + CommandLayer
│   ├── page.tsx          # Home
│   ├── options/          # Chain / Positions / Strategies / Surface
│   ├── portfolio/        # Open positions, roll, close
│   ├── history/          # Trade ledger
│   ├── contracts/        # Contract registry + live hash verification
│   └── contracts.json/   # Registry as JSON (route handler)
│   ├── options/          # Chain / Positions / Strategies / Surface / Workspace
│   ├── portfolio/        # Open positions, roll, close, attribution, partial/batch/strategy close
│   ├── history/          # Trade ledger + performance analytics
│   ├── calendar/         # Expiry calendar + settlement center
│   ├── share/[id]/       # Public share-card page (OG/Twitter meta)
│   ├── docs/             # MDX protocol documentation pages
│   └── api/
│       ├── share/        # POST: build + sign a share card from trusted data
│       └── og/trade/     # GET: edge-rendered card PNG (next/og) + bundled fonts
├── features/
│   └── finder/           # Strategy finder: engine.ts (generate/prune/score),
│                         # finder.worker.ts, useStrategyFinder, UI
├── components/           # UI components (charts, dialogs, header, etc.)
│   ├── env/              # Environment banner, selector, mode stamp, mainnet switch dialog
│   ├── states/           # Skeleton / EmptyState / ErrorState / AuthGate / DataBoundary
│   └── docs/             # Docs components (calculators, search, toc, sidebar)
├── features/
│   ├── options/          # Terminal pieces: chain, order ticket, positions, strategies, sidebar
│   ├── onboarding/       # Tour, <Term> glossary, describeTrade(), content/<locale>/*.json
│   └── command/          # Command palette, hotkeys, help overlay
│   ├── compete/          # Competition listing, detail ([id]), rules ([id]/rules)
│   └── history/          # Trade ledger
├── components/           # UI components (charts, dialogs, header, etc.)
│   └── compete/          # Competition cards, rules, opt-in, leaderboard, rank, results
└── lib/
    ├── api/              # Typed backend client: one file per domain
    │   ├── client.ts     # fetchJson + wsUrl(), NEXT_PUBLIC_API_URL, bearer auth header
    │   ├── market.ts, positions.ts, watchlist.ts, alerts.ts, history.ts,
    │   │   strategies.ts, auth.ts, ws.ts, payoff.ts (client exists, unused),
    │   │   competitions.ts (contract; backend not implemented yet)
    │   └── types.ts      # Response shapes mirroring the backend's
    ├── hooks/             # useBackend{Account,Positions,Watchlist,Alerts,History},
    │                      # useSpotFeed (WS reconnect w/ backoff),
    │                      # useContractVerification (live contract hash check)
    │                      # useCompetitions/useLeaderboard/useMyRank,
    │                      # useCompetitionRegistration, useTiming (now + debounce),
    │                      # useSpotFeed (WS reconnect w/ backoff)
    ├── env/               # Mode registry, per-mode storage namespaces, favicon/title
    ├── query.ts           # useAsyncQuery: idle/loading/success/error per data surface
    ├── context/
    │   ├── EnvironmentContext.tsx  # active mode, guarded switching, wallet-network checks
    │   ├── BackendDataContext.tsx  # one shared account/positions/watchlist/alerts instance
    │   └── SpotFeedContext.tsx     # one shared WebSocket connection app-wide
    ├── soroban/
    │   ├── networks.ts    # Network passphrases, RPC endpoints (env-overridable), explorer links
    │   ├── registry.ts    # The contract registry: per-contract, per-network ID + WASM hash
    │   └── verify.ts      # getLedgerEntries on the instance key → hash comparison
    ├── store/             # zustand + persist — now just wallet.ts (connect,
    │                      # sign-in-with-backend, bearer token)
    ├── store/             # zustand + persist — wallet.ts (connect, sign-in,
    │                      # bearer token; persisted per mode) and
    │                      # collateralSettings.ts (warning thresholds)
    ├── pricing.ts        # Black-Scholes, vol smile — fallback/preview layer, see above
    ├── attribution.ts    # Taylor Greek P&L attribution (local baselines)
    ├── analytics.ts      # Equity curve, drawdown, trade statistics
    ├── expiry.ts         # Expiry derivation, grouping, .ics, settlement helpers
    ├── alertRules.ts     # Client-side alert rule evaluator (hysteresis/cooldown)
    ├── collateral.ts     # Collateral requirements (100% calls, 110% puts) +
    │                     # dashboard selectors: utilization, reconciliation, what-if
    ├── probability.ts    # Lognormal PoP / P(ITM) / EV / expected move
    ├── statements.ts     # Period ledger, summaries, statement CSV + PDF
    ├── share/            # Signed share-card payloads, card builder, card artwork
    ├── payoff.ts          # Multi-leg combined payoff math (local; backend equivalent unused)
    ├── risk.ts             # Whole-portfolio risk: groups all open positions per
    │                       # underlying into one payoff curve, stress-tests the
    │                       # account across a spot-shock grid; mark-to-model scenarioGrid
    ├── heatScale.ts       # Colorblind-safe chain heat scales + contrast checks
    ├── candles.ts         # Tick→OHLC aggregation, SMA/EMA, realized vol
    ├── volSurface.ts      # Term-structure-aware IV surface grid + WebGL mesh
    ├── strategies.ts      # Strategy templates + metadata, dev-time validation,
    │                      # strike resolution onto listed strikes
    ├── notifications/     # Event bus, per-wallet IndexedDB store, producers,
    │                      # browser-notification prefs, server WS contract
    ├── watchlists/        # Multi-list watchlists: provider (server or local
    │                      # mode, optimistic updates) and pure list ops
    ├── csv.ts / notify.ts # CSV export (injection-safe), browser + in-app notifications
    │                       # account across a spot-shock grid
    ├── competitions.ts     # Competition config schema/validation, phases,
    │                       # scoring + prize formatting, tie + anti-gaming rules
    ├── volSurface.ts      # Term-structure-aware IV surface grid
    ├── strategies.ts      # Multi-leg strategy templates
    ├── csv.ts / notify.ts # CSV export, browser Notification wrapper
    ├── useHydrated.ts     # SSR-hydration-safety hook (see below) — still relevant for wallet.ts
    ├── useCandleHistory.ts # Candle history (API or limited WS seed)
    └── usePriceHistory.ts # Legacy in-memory spot sparkline buffer
```

See also [docs/VISUALIZATIONS.md](docs/VISUALIZATIONS.md) for the chain heat map,
3D surface, candlestick chart, and scenario analysis features (#40–#43).

### Session & hydration (BFF, #118)

The backend bearer token is **never** stored in `localStorage` or exposed to
JavaScript. Authed calls go through a backend-for-frontend:

```
browser ──fetch /api/bff/<backend path>──▶ Next.js route handler ──Bearer <token>──▶ zenith-backend
          (httpOnly session cookie)        src/app/api/bff/[...path]/route.ts
```

- **Sign-in:** the wallet signs the nonce, then `POST /api/bff/session` sends
  the signature. The BFF calls `/api/v1/auth/verify` and seals the token with
  AES-256-GCM (key from `BFF_SESSION_SECRET`) into an `HttpOnly; Secure;
  SameSite=Strict` cookie. The cookie is named `__Host-zenith_session` in
  production and `zenith_session` on http://localhost. The response carries
  only `{ authenticated, wallet_address, expires_at }`.
- **Proxy:** only allowlisted paths and methods are forwarded
  (`src/lib/bff/allowlist.ts`). Everything else returns 404 or 405, so this
  is not an open proxy. Bodies are streamed in both directions. Browser
  cookies never reach the backend, and backend `Set-Cookie` headers never
  reach the browser.
- **CSRF:** mutating routes need a same-origin `Origin` header (or
  `Sec-Fetch-Site: same-origin`) and an `x-zenith-csrf` header matching the
  JS-readable `zenith_csrf` cookie. `GET /api/bff/session` mints that cookie.
- **Logout:** `DELETE /api/bff/session` clears the cookie, which is shared
  by all tabs. `src/lib/tabs/session.ts` broadcasts the change so other tabs
  update immediately.
- **WebSockets:** the spot and chain feeds are public, so they connect
  directly and need no ticket. An authed feed would need a short-lived
  ticket route in the BFF.
- **Latency:** every proxied response carries
  `Server-Timing: upstream;dur=…, bff;dur=…`. Deploy the frontend in the same
  region as the backend. Self-hosting and Docker need no extra service, since
  the BFF is part of `next start`.

Server-only env vars: `BFF_SESSION_SECRET` (required in production,
≥32 chars, e.g. `openssl rand -base64 48`), `BFF_UPSTREAM_URL` (backend
origin as the server sees it, defaults to `NEXT_PUBLIC_API_URL`),
`BFF_ALLOWED_ORIGINS` (extra origins for mutating calls, comma-separated),
and `BFF_INSECURE_COOKIES=1` (plain-HTTP self-hosting only).

**Hydration.** `wallet.ts` is still persisted with `skipHydration: true`, and
`StoreHydrator` rehydrates it after mount. It now persists only the public
`address`. Store version 2's `migrate`, plus `purgeLegacyWalletToken()`, strip
any token left by older builds. Whether a session exists is asked of the BFF
(`checkConnection()` → `GET /api/bff/session`) after mount, so the server
HTML and the first client render still match. The store's `session` field is
a non-secret marker (`"bff-session"`), not a credential. Components that
gate fetching on it still wait for `useHydrated()` before fetching. Workspace
layouts also render the Trader preset on SSR and hydrate from localStorage
after mount.

## Close API contract (frontend)

Until the backend ships support, the client probes `GET /api/v1/features`
and falls back:

- `POST /api/v1/positions/{id}/close` with optional `{ contracts }` for partial close
- `POST /api/v1/strategies/{id}/close` for atomic strategy unwind
- Sequential per-leg closes with progress + stop/continue when unsupported
  (non-atomic leg risk is warned in the confirm dialog)

```bash
npm test          # node:test unit suite (attribution, analytics, expiry, alertRules)
```

## Contract registry (`/contracts`)

`/contracts` lists every Zenith contract per network with its contract ID,
expected WASM hash, deployed version, source commit, audit link, explorer
link, and upgrade history — and, for each one, **live-checks that the code
running at that address is the release the registry claims**.

The check is one `getLedgerEntries` call per network (the method takes up
to 200 keys, so all contracts are batched into a single round trip). A
Soroban contract's instance lives in a `CONTRACT_DATA` ledger entry whose
key is the `ScVal` `LedgerKeyContractInstance` — not a user-chosen symbol —
with persistent durability. Reading it yields a `ContractDataEntry` whose
`val.instance.executable` is either a WASM hash or, for built-in Stellar
Asset contracts, a `STELLAR_ASSET` variant with no hash at all. That hash is
compared against the registry.

| Status | Meaning | Blocks on-chain actions |
|---|---|---|
| `verified` | Deployed executable hash equals the expected release | no |
| `mismatch` | Hash differs, the ID is not a contract, or it is a built-in SAC | **yes** |
| `unverified` | RPC unreachable/timed out/unparseable | **yes** |
| `not-deployed` | No contract ID or expected hash recorded for this network | no |

The gating is **fail-closed** on purpose: `unverified` is an absence of
evidence, not evidence of safety, and treating an RPC outage as a green
light is exactly how a supply-chain swap gets through during an incident.
It never blocks *reading* — the page renders in every state. `blocksActions()`
in `verify.ts` is the single place that policy lives.

**Deployments are currently empty.** Zenith has no public deployment yet
(the backend is still a paper-trading API), so `registry.ts` ships with
`deployments: {}` rather than plausible-looking placeholder IDs — for a page
whose entire job is "is this the genuine contract?", invented IDs would be
actively harmful. The mechanism is live and exercised; it just has nothing
to compare against. Record a real deployment by filling in the `deployments`
block for the network in `src/lib/soroban/registry.ts`; an integrator
pointing at their own deployment can override the same shape via
`NEXT_PUBLIC_ZENITH_DEPLOYMENTS`.

What this does **not** cover, deliberately: it verifies that the code at an
address is the expected release, and nothing else. It says nothing about a
contract's storage, its admin, or its source — all of which an authorized
call can change without touching this hash — and reproducible-build
verification is out of scope.

### Tests

`npm test` runs the verification unit tests (`src/lib/soroban/verify.test.ts`),
which run against fixture ledger entries in
`src/lib/soroban/__fixtures__/ledgerEntries.ts`. Those fixtures are real XDR
produced by encoding the same structures the RPC returns, so a change in the
protocol's encoding surfaces as a failing test rather than a silently-passing
one. They cover the matching/mismatch paths, the built-in-SAC case, an
undecodable entry, out-of-order RPC responses, and RPC failure.


### A note on hydration safety

`wallet.ts` is the one remaining persisted store, using `skipHydration: true`
plus `StoreHydrator` (mounted once in the root layout) to pull the real
`localStorage` token in after mount instead of at module-eval time. That
alone isn't sufficient for anything that reads the wallet's bearer token to
fetch backend data: passing a token before this component's own mount
effect has fired risks fetching (and rendering) data the server-rendered
HTML didn't have. `BackendDataProvider` (`src/lib/context/BackendDataContext.tsx`)
gates on `useHydrated()` and only passes the real token down to
`useBackendAccount`/`useBackendPositions`/etc. once hydrated — everything
else in `src/app/options/page.tsx` and `src/app/history/page.tsx` that
reads wallet-gated state follows the same pattern. If you add a new
component that reads the wallet token to fetch or render backend data, it
needs the same guard.

## Known gaps

- No test suite for anything except the contract-verification module — that
  one has unit tests against fixture ledger entries; the rest of `src/lib`
  (pricing, risk, payoff, vol surface) is untested.
## Probability analytics

`src/lib/probability.ts` puts odds on the payoff curves: probability of
profit, probability ITM (single legs), expected value, and ±1σ/±2σ
expected-move ranges. They're shown in the order ticket, the strategy
preview and the portfolio risk panel, and every payoff diagram has a
**Prob.** toggle that overlays the density and the σ bands.

Assumptions (also in the in-app ⓘ tooltip):

- Risk-neutral lognormal spot at expiry, drift r = 5% (the rate the chain
  is priced with): market-implied odds, not a forecast.
- Flat IV by default. **Smile** mode uses the strike-specific smile vol for
  the P(ITM)/PoP edges; EV, the density and the σ bands always use flat IV.
- PoP sums the probability mass of every interval between breakevens
  where the payoff is positive, so condors and straddles work. The
  breakevens come from `riskProfile`.
- EV is E[payoff] − premium, undiscounted, integrated with Simpson's rule
  in log-space and truncated at ±6σ, so unbounded payoffs stay finite.
- In the portfolio panel, positions with different expiries are measured
  at the nearest one. Account-wide EV is summed across underlyings,
  because EV is additive. PoP isn't, so it's shown per underlying only.

## Collateral & margin

The **Collateral & Margin** panel on `/portfolio` shows balance, locked
collateral, free capital and utilization as a threshold-colored gauge. It
also has a sortable per-position table (collateral, share of total,
premium yield, return on collateral, days held, buying power freed on
close), a what-if for a new write or a close, and a reconciliation check.

- **Account semantics** (from the backend): `balance` is total cash and
  *includes* locked collateral. Free capital is `balance −
  collateral_locked` (the backend's buying-power check), and utilization is
  `collateral_locked / balance`.
- **Per-position collateral** is the amount the backend locked **at entry**
  (calls: contracts × entry spot; puts: 110% × strike). It isn't re-marked
  as spot moves. Hovering the amount shows what the same write would lock
  at today's spot.
- **Reconciliation** compares Σ per-position collateral (compensated
  summation) with the account's `collateral_locked`, within a half-cent
  tolerance. `/positions` is now paged through fully, since the default
  50-row page would otherwise truncate larger books.
- **Warnings**: warning and critical thresholds (default 80% / 95%) are set
  per browser. At or above a threshold, a badge appears in the header.
  Escalating to a higher level fires one browser notification, and it
  re-arms once utilization drops back.

## Statements

On `/history`, **Statements** exports a period ledger for accounting:
month, quarter, year or a custom range, optionally for one underlying, as
CSV or a client-side PDF (summary page plus paginated detail). `pdf-lib`
loads lazily, only on the first PDF export.

- **Scope**: realized lots only (`closed` and `rolled` rows), assigned to
  the period their **close** falls in. Periods are UTC midnights, with an
  exclusive end.
- **Rolls are two ledger events.** The rolled lot closes with its own
  realized P&L (`Event = roll`). The replacement is a separate lot whose
  holding period starts at the roll, not at the original open. The two are
  cross-referenced in **Linked Position**, matched by same contract terms
  and strategy, opened within 5 s of the roll.
- **Determinism**: the same inputs produce byte-identical CSV and PDF,
  independent of the machine's time zone.
- **CSV injection**: text cells starting with `=` `+` `-` `@`, tab or CR
  are prefixed with `'` (OWASP). Plain numbers are left alone.
- Not tax advice. There are no jurisdiction-specific rules, and the
  disclaimer is on the panel and in every PDF. See
  [docs/samples/statement-2026Q1.pdf](docs/samples/statement-2026Q1.pdf).

Statement CSV columns:

| Column | Meaning |
|---|---|
| Position ID | Backend position id (one lot) |
| Event | `close`, or `roll` for a lot closed by a roll |
| Opened (UTC) / Closed (UTC) | ISO-8601, second precision, `Z` |
| Underlying, Type, Side | e.g. `BTC`, `short`, `put` |
| Strike, Contracts | As traded |
| Premium Paid | Long: entry premium × contracts. Short: buy-back cost at close |
| Premium Received | Long: close premium × contracts. Short: premium collected at open |
| Fees | Always `0.00`; the backend charges none today |
| Cost Basis | Premium Paid + Fees |
| Proceeds | Premium Received |
| Realized P&L | Proceeds − Cost Basis (matches the backend's `realized_pnl`) |
| Holding Days | Whole days elapsed, open → close |
| Term | `long-term` if closed more than one calendar year after opening, else `short-term` |
| Linked Position | The other lot of a roll, if any |

Amounts use up to 8 decimals with trailing zeros trimmed (minimum 2).

## Share cards

History rows and strategy previews have a **Share** button. It creates a
link to `/share/[id]` with rich Open Graph/Twitter previews, plus a
downloadable 1200×630 card image. Samples:
[trade](docs/samples/share-card-trade.png),
[strategy](docs/samples/share-card-strategy.png).

- **Stateless and signed**: `id = base64url(payload).base64url(HMAC-SHA256)`,
  verified in constant time on every render. A tampered id returns 400 or
  404.
- **Card contents come from trusted data only.** `POST /api/share` looks
  the trade up in the sharer's own ledger via the backend, using their
  bearer token, or reprices a strategy template at the backend's spot.
  Numbers sent by the client are never signed.
- **Privacy**: dollar P&L and contract size are hidden by default. The
  wallet is off by default and only ever appears truncated (`GABC…WXYZ`).
  A full address is rejected at parse time. Hidden fields are omitted from
  the signed payload itself, and the sparkline is pre-normalized, so no
  premiums or sizes travel in the URL.
- The OG image renders on the edge runtime with local OFL fonts
  (`src/app/api/og/trade/fonts`). It is cached for a day in browsers and a
  week at the CDN, so rotating the secret retires old cards in bounded time.

### Notifications

Producers publish to an event bus (`src/lib/notifications/bus.ts`) and
`NotificationsProvider` persists each event in IndexedDB per wallet (last
500), deduplicated by `dedupeKey` so several tabs observing the same alert
record it once; other tabs are synced over `BroadcastChannel`. Producers:
fills/closes/rolls (from `BackendDataContext`), triggered alerts, expiry
reminders (24h and 1h), session expiry/sign-out, and spot-feed outages.
Server-pushed notifications aren't implemented; the intended
`/api/v1/ws/notifications` frame format is in `serverContract.ts`.

### Watchlists

Favorites (the backend's existing single-set `/api/v1/watchlist`) still
drive `StarButton` and market-tab ordering, and appear as the first list.
Additional named lists use a multi-list API documented in
`src/lib/api/watchlists.ts`, which the backend doesn't serve yet. Until it
does (`GET /api/v1/watchlists` 404s), lists are saved in `localStorage`
per wallet and are uploaded automatically the first time the server
answers with no lists. Each row shows live spot, change since the session
started (there's no server-side 24h change), ATM IV and a sparkline from
the WebSocket feed's session buffer.

## Testing

Vitest with jsdom, React Testing Library, MSW for network tests and
`fake-indexeddb`. Tests live next to the code as `*.test.ts(x)`. Strategy
payoffs and finder rankings are snapshot-tested; `vitest run -u` updates
snapshots after an intentional change.

## Known gaps

- No rate limiting on `POST /api/share`. Trade shares require a valid
  backend session; strategy shares don't.
- The iPhone 13 (WebKit) Playwright project needs WebKit's system libraries,
  so it runs in CI. Its visual baseline has to be generated there (or on a
  machine with them) before its visual test stops being skipped.
- The mobile Lighthouse performance score for `/options` measured
  0.86–0.89 locally against the 0.85 gate. There isn't much headroom, and
  a slow CI runner may need a re-run.
- Testnet/mainnet modes are UI- and data-isolation-complete, but there's no
  Soroban transaction path yet: with no testnet/mainnet backend configured,
  those modes show market data from the local model and refuse trades.
- Unit tests cover heat scales, candles, vol-surface mesh, and scenario grid
  (`npm test`). General Playwright e2e suite not yet in CI (keyboard/drag flows).
- No RTL / component test suite yet (pure lib modules are covered).
- PWA: hand-written `public/sw.js` (no Serwist/Workbox dependency), production-only registration, SVG icons only (no PNG set), no Playwright offline tests and no Lighthouse run yet. Only last-known public spot prices are snapshotted (IndexedDB, wiped on disconnect); positions/account are not cached.
- Playwright e2e keyboard/drag flows are not in CI yet; unit coverage is via vitest.
- Tests cover the competition module only (`npm test`) — the rest of the app
  still has no suite. There is no CI workflow in this repository.
- The competitions API is a frontend-side contract: `src/lib/api/competitions.ts`
  defines the endpoints the UI calls, but the backend does not implement them
  yet, so `/compete` renders its empty/error states against a real backend. The
  scoring service and prize distribution are out of scope for the frontend
  issue.
- The leaderboard renders a plain table rather than the reusable DataGrid being
  added in #148, which is not on `main` yet. Rows are shaped so the swap is a
  presentation change (`LeaderboardEntry` in, one row out) when it lands.
- No on-chain/Soroban integration — the backend is a paper-trading API, not
  a wallet transaction signer against the contracts.
- Wallet sign-in (`signBlob` → verify → bearer token) hasn't been manually
  confirmed against a live Freighter extension — no extension available in
  this environment. The flow is logically complete, not hardware-tested.
- The home page's preview chain still runs its own local random-walk spot
  simulation rather than the shared WebSocket feed — only its watchlist i
- No on-chain/Soroban integration — the backend is a paper-trading API, not
  a wallet transaction signer against the contracts. The `/contracts` page
  *reads* on-chain state (contract instance hashes via `getLedgerEntries`)
  but nothing in the app signs or submits a transaction, so the
  `blocksActions` policy in `verify.ts` has no on-chain call site to gate yet.
- The contract registry ships with no deployments recorded — see
  [Contract registry](#contract-registry-contracts) above.
- Wallet sign-in (`signBlob` → verify → bearer token) hasn't been manually
  confirmed against a live Freighter extension — no extension available in
  this environment. The flow is logically complete, not hardware-tested.
- The home page's preview chain still runs its own local random-walk spot
  simulation rather than the shared WebSocket feed — only its watchlist is
  backend-real.
- The backend's `/api/v1/portfolio/payoff` endpoint has a typed client
  (`src/lib/api/payoff.ts`) but nothing calls it — the payoff diagram still
  computes locally (`src/lib/payoff.ts`). Multi-leg strategy *preview*
  pricing (before execution) is also local-only, not backend-priced.
- `src/app/options/page.tsx` is now a composition shell; feature modules live
  in `src/app/options/_components/` (see Options module map above).
- The home page's preview chain still runs its own local random-walk spot
  simulation rather than the shared WebSocket feed — only its watchlist is
  backend-real.
- Accessibility is minimal — several controls (star toggle, alert form,
  contracts stepper) have no `aria-label`.

## License

MIT © Zenith Protocol Contributors

## API contracts

`src/lib/api/schemas.ts` holds a Zod schema per backend response; types in
`types.ts` are `z.infer`-derived. `request()` validates each response and throws
a `ContractError` (with per-field paths) on drift: shown in a dev overlay, sent
to `NEXT_PUBLIC_MONITOR_URL` in production. Extra backend fields are stripped;
numeric strings are coerced. `npm run api:check` validates the fixtures in
`contracts/fixtures/` (named after schema exports) and flags key drift.

## Handsoff notes

<!-- handsoff-issue-280 -->
- #280: Implement a Shared NAV/Share-Price Math Library With Differential Conformance Tests
