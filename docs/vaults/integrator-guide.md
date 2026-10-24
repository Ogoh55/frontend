# Vault Integrator Guide

This guide is for teams consuming the Zenith vault stack from outside the
repository: the REST API, the vault SDK, and the on-chain events emitted by the
Soroban contract suite. It is versioned with releases and reviewed in any PR
that changes the interface.

> **Status:** Phase 2. Some vaults are flag-gated and not yet enabled on
> mainnet. Where a capability is not shipped, it is called out explicitly below
> so you are not misled. See [`docs/vaults/architecture.md`](./architecture.md)
> for the component overview and trust boundaries, and
> [`docs/vaults/contract-reference.md`](./contract-reference.md) for the
> authoritative contract interface.

## Contents

- [Authentication](#authentication)
- [Rate limits](#rate-limits)
- [Pagination](#pagination)
- [Error taxonomy](#error-taxonomy)
- [Event decoding](#event-decoding)
- [SDK usage](#sdk-usage)
- [Versioning and deprecation](#versioning-and-deprecation)

## Authentication

Read-only endpoints (vault list, vault detail, epoch history, position lookup)
are public and require no credentials. Write endpoints (deposit intents,
withdrawal requests, operator actions) require a signed request:

- Authenticate with a bearer token issued by the backend. Tokens are scoped to
  a single account and expire; refresh before expiry rather than retrying a
  rejected request.
- Operator endpoints additionally require the operator role on the account.
  Role assignment is out of band; see the operator guide.
- Never embed tokens in client-side bundles. Proxy through your own backend.

## Rate limits

- Public read endpoints are rate limited per IP.
- Authenticated endpoints are rate limited per account.
- When throttled the API returns `429` with a `Retry-After` header in seconds.
  Honor it; do not busy-retry.
- Batch reads where possible (list endpoints accept filters) instead of polling
  per-item.

## Pagination

List endpoints are cursor-paginated:

- Pass `limit` (server-capped) and the opaque `cursor` returned in the previous
  response.
- Responses include `next_cursor`; a `null` value means the last page.
- Cursors are opaque — do not parse or construct them.
- Ordering is stable for a given query; do not assume insertion order across
  pages when new items arrive.

## Error taxonomy

Errors share a common envelope with a machine-readable `code` and a
human-readable `message`. Branch on `code`, never on `message`.

| Category | Meaning | Typical handling |
| --- | --- | --- |
| `validation_error` | Malformed request or argument | Fix the request; do not retry |
| `unauthorized` | Missing/invalid credentials | Refresh token, then retry once |
| `forbidden` | Authenticated but lacking role | Do not retry; escalate |
| `not_found` | Unknown vault/epoch/position | Treat as absent |
| `conflict` | State changed under you (e.g. epoch already closed) | Re-read state, then decide |
| `rate_limited` | Throttled | Honor `Retry-After` |
| `internal_error` | Server fault | Retry with backoff; report if persistent |

Contract-level failures surface as their own error codes; see the contract
reference for the authoritative list. Do not map contract error codes onto the
HTTP taxonomy — surface them to the caller unchanged.

## Event decoding

The contract emits events for deposits, epoch open/close, settlement, and
withdrawals. Decode them from the transaction's contract events:

- Match on the event topic (the contract's event name) and the emitting
  contract ID; ignore events from other contracts.
- Treat the event payload as the source of truth for state transitions; do not
  infer settlement from balances alone.
- Events are ordered within a transaction but not guaranteed across
  transactions; use ledger sequence plus transaction order for global ordering.
- The exact topic names, payload shapes, and storage entries are defined in the
  contract reference and generated from the checked-in contract spec. If a
  payload does not match the reference, treat it as a version mismatch and stop
  rather than guessing.

## SDK usage

The vault SDK wraps the REST API and event decoding with typed helpers. The
following sample is exercised in CI against the current interface; if it stops
compiling or running, the interface changed and this guide is stale.

```ts
import { VaultClient } from "@zenith/vault-sdk";

const client = new VaultClient({ baseUrl: process.env.VAULT_API_URL! });

// List vaults (cursor-paginated).
const page = await client.vaults.list({ limit: 20 });
for (const vault of page.items) {
  console.log(vault.id, vault.status);
}

// Fetch a single vault and its latest epoch.
const vault = await client.vaults.get(page.items[0].id);
const epoch = await client.vaults.latestEpoch(vault.id);
console.log(epoch?.status);
```

Guidelines:

- Construct one client per process and reuse it.
- Handle the error taxonomy above; the SDK throws typed errors carrying `code`.
- Do not cache mutable vault state indefinitely; epochs and settlements change
  it. Cache immutable metadata only.

## Versioning and deprecation

- The API and SDK are versioned together with releases. Breaking changes bump
  the major version.
- Additive changes (new fields, new endpoints) are non-breaking and may ship in
  a minor release. Clients must ignore unknown fields.
- Deprecations are announced in release notes and kept working for at least one
  minor release before removal.
- The contract reference is generated from the checked-in contract spec, so it
  cannot drift from the deployed interface. Narrative sections here are
  hand-written and reviewed alongside interface changes.

## Not yet shipped

- Flag-gated vaults are not enabled for all integrators; check the vault
  `status` before assuming availability.
- Any capability described in the contract reference but marked experimental is
  subject to change without a major version bump until it is promoted.
