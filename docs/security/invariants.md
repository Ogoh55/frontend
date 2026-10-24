# Security Invariants

This document records the security invariants the vault stack must uphold, the trust
boundaries between our own services, and the network surfaces each component exposes.
It is reviewed with the security preparation workstream. Client-facing rate limiting and
abuse protection, and on-chain admin key custody/KMS signing, are covered elsewhere.

## Trust boundaries and network surfaces

| Service | Externally routable | Accepts internal calls from | Outbound egress allowlist |
| --- | --- | --- | --- |
| BFF / API (`src/app/api/`) | Yes (only external entry point) | Browser clients (authenticated) | Stellar RPC, Horizon, price feeds, notification providers |
| Indexer | No | BFF/API, scheduler | Stellar RPC, Horizon |
| Scheduler | No | BFF/API | Stellar RPC, Horizon |
| Keeper | No | BFF/API, scheduler | Stellar RPC, Horizon |

- Only the BFF/API layer accepts external traffic. Indexer, scheduler, and keeper
  endpoints are not publicly routable (enforced by network policy / private networking).
- Local topology in `docker-compose.yml` mirrors these trust boundaries so development
  exercises the same isolation as production.

## Service-to-service authentication

- Every internal call is authenticated with mTLS or a short-lived signed service token
  that carries a service identity and a narrow scope claim. Handlers verify the identity
  and scope explicitly; they never trust a bare network position.
- Tokens rotate on a short interval. No shared static bearer secrets are checked into
  config; secrets are sourced from a managed store and referenced (not inlined) in
  `.env.local.example`.
- Token validation tolerates bounded clock skew, and long-running indexer/backfill jobs
  refresh tokens before expiry rather than relying on a single long-lived credential.
- Local development may run without mTLS via a documented dev bypass. The bypass cannot
  be enabled in production; production fails to boot with a missing or placeholder
  service credential.

## Least-privilege credentials per service

- The indexer cannot submit transactions.
- The keeper cannot read depositor PII it does not need.
- Each service holds only the scopes required for its role; scope claims are checked at
  the handler, not inferred from the caller's network location.

## Egress controls

- Outbound traffic is restricted to an explicit allowlist (Stellar RPC, Horizon, price
  feeds, notification providers).
- Denied-outbound calls are logged and alerted so a compromise in one service cannot
  pivot freely.

## Frontend-visible configuration

- The frontend-visible subset of secrets/config is validated in `src/env.ts`; values are
  referenced from the managed store, never inlined.

## Verification

- Negative tests prove an unauthenticated or out-of-scope internal call is rejected, an
  egress-denied call is blocked and alerted, and an expired token is refused.
- A configuration test asserts production fails to boot with a missing or placeholder
  service credential.
- Auth failures are surfaced through `sentry.server.config.ts`.
