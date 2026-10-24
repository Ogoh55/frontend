# Public Read-Only Vault API & Embeddable Widget

This document is the partner-facing reference for the public, unauthenticated,
read-only vault surface. It is a **projection** over the same vault registry and
epoch ledger used by the app, served from a cache that is independent of the
authenticated API read path so partner traffic spikes cannot degrade the app.

> **Stability promise.** The endpoints, response shapes, and the embed snippet
> documented here are a frozen public contract. We will not make breaking
> changes without a deprecation window of at least 90 days and a new versioned
> path (e.g. `/api/public/v2/...`). Additive fields may appear at any time;
> clients must ignore unknown fields.

## Gating

The public surface is only live when the `NEXT_PUBLIC_VAULTS` flag is enabled.
When the flag is off, every public endpoint returns `404` and the embed renders
nothing, so an unlaunched surface can never leak through an embed.

## Endpoints

All endpoints are `GET`, unauthenticated, and return JSON.

| Endpoint | Description |
| --- | --- |
| `GET /api/public/vaults` | Paginated list of public vaults |
| `GET /api/public/vaults/{id}` | Detail for a single vault |
| `GET /api/public/vaults/{id}/history` | NAV / epoch history for a vault |

### `GET /api/public/vaults`

Query parameters:

- `limit` — page size, `1`–`100` (default `20`).
- `cursor` — opaque pagination cursor from a previous response.

Response:

```json
{
  "data": [
    {
      "id": "zenith-usdc",
      "name": "Zenith USDC Vault",
      "symbol": "zUSDC",
      "asset": "USDC",
      "status": "active",
      "navPerShare": "1.0421",
      "apy": "0.0812",
      "tvl": "1250000.00",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

### `GET /api/public/vaults/{id}`

Returns a single vault object (same shape as a list item). `404` if the vault
does not exist or is not public.

### `GET /api/public/vaults/{id}/history`

Query parameters: `limit` (`1`–`365`, default `90`), `cursor`.

```json
{
  "data": [
    { "epoch": 42, "navPerShare": "1.0421", "timestamp": "2025-01-01T00:00:00.000Z" }
  ],
  "nextCursor": null
}
```

A vault with no epoch history yet returns `{ "data": [], "nextCursor": null }`.

## What is never exposed

The public projection deliberately excludes all per-depositor and
account-scoped data. The following fields are **never** present in any public
response and are asserted absent by contract tests:

- depositor / holder addresses or balances
- per-user positions, shares, or claim history
- internal IDs, operator notes, or admin metadata
- any field that requires authentication to compute

## Caching headers

Every public response sets:

```
Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=300
ETag: "<hash>"
```

Clients should honor `ETag` with `If-None-Match` to receive `304 Not Modified`.
The public cache TTLs are independent of the authenticated read path.

## CORS policy

Public endpoints send permissive read-only CORS headers so partners can call
them from the browser:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: If-None-Match
```

`OPTIONS` preflight returns `204`. No credentials or cookies are used, so there
are no third-party-cookie assumptions.

## Rate limits

- Anonymous (by IP): `60` requests / minute.
- Higher tiers (by API key, issued out of band): `600` requests / minute.

Exceeding a limit returns `429` with a `Retry-After` header. Rate-limit state
is tracked separately from the authenticated API.

## Embeddable widget

The widget is a dependency-free, self-contained web component that loads data
from the public API (never the authenticated endpoints). It renders vault cards
or a table, respects light/dark theming, is keyboard navigable, and is labelled
for screen readers. It degrades gracefully when a vault is paused, in wind-down,
or has no epoch history yet.

### Installation

```html
<script type="module" src="https://cdn.zenith.example/vault-widget.js"></script>

<zenith-vaults
  api-base="https://app.zenith.example"
  vault-id="zenith-usdc"
  theme="auto"
  attribution="partner-wallet"
></zenith-vaults>
```

Attributes:

- `api-base` — origin of the public API.
- `vault-id` — optional; render a single vault instead of the list.
- `theme` — `light`, `dark`, or `auto` (default).
- `attribution` — partner identifier preserved through the deposit deep link.

### Deep link into the deposit flow

Each card links to the app's deposit flow with attribution preserved:

```
https://app.zenith.example/vaults/{id}/deposit?utm_source=embed&utm_medium=widget&ref={attribution}
```

## Example request

```bash
curl -s https://app.zenith.example/api/public/vaults?limit=10 \
  -H 'Accept: application/json'
```

## Out of scope

Authenticated partner integrations, revenue-share or billing logic, and
white-label theming beyond light/dark are not part of this surface.
