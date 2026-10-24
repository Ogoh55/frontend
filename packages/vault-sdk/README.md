# @zenith-options/vault-sdk

Typed TypeScript client for the Zenith Options Phase 2 vault REST contract:
vault listings, vault detail with epoch history, deposits, and withdrawals.

It is a thin layer over `fetch`. It has no runtime dependencies, stores no
credentials, and takes its transport as an option so tests and mock backends
can replace the network.

## Install

```sh
npm install @zenith-options/vault-sdk
```

Requires Node.js 20 or later, or a browser with `fetch`.

## Usage

```ts
import { createVaultClient, VaultSdkError } from "@zenith-options/vault-sdk";

const vaults = createVaultClient({
  baseUrl: "https://api.zenith.example",
  getToken: () => myWallet.bearerToken, // optional; supplied by the caller
});

const listing = await vaults.listVaults();

const detail = await vaults.getVault("xlm-cc-v1"); // null if the vault does not exist

const { tx_id } = await vaults.deposit("xlm-cc-v1", 250);
const { tx_id: withdrawTx, queued } = await vaults.withdraw("xlm-cc-v1", 100);
```

Behind the frontend BFF, omit `getToken` and set `baseUrl` to the BFF prefix.
The httpOnly session cookie is sent with `credentials: "same-origin"`.

### Custom transport

```ts
import { createVaultClient, type VaultTransport } from "@zenith-options/vault-sdk";

const transport: VaultTransport = async ({ method, url, headers, body }) => {
  const res = await fakeBackend.handle(method, url, body);
  return { status: res.status, body: res.json };
};

const vaults = createVaultClient({ baseUrl: "http://mock", transport });
```

## Methods

| Method | Endpoint | Resolves to |
| --- | --- | --- |
| `listVaults()` | `GET /api/v1/vaults` | `VaultSummary[]` |
| `getVault(id)` | `GET /api/v1/vaults/{id}` | `VaultDetail \| null` (`null` on 404) |
| `deposit(id, amount)` | `POST /api/v1/vaults/{id}/deposit` | `{ tx_id }` |
| `withdraw(id, shares)` | `POST /api/v1/vaults/{id}/withdraw` | `{ tx_id, queued }` |

`amount` and `shares` must be positive finite numbers. Anything else throws a
`validation` error before a request is sent.

## Errors

Every failure is a `VaultSdkError` with a `kind`:

| `kind` | Cause |
| --- | --- |
| `validation` | Bad input from the caller, HTTP 400/422, or a response that does not match the contract |
| `capacity` | HTTP 402: vault capacity or an account limit rejected the request |
| `queue_conflict` | HTTP 409: the request conflicts with the epoch queue state |
| `http` | Any other non-2xx response |
| `transport` | No HTTP response: network failure or aborted request |

`status` and the backend's string `code` (when the error body has one) are
also set. Messages never include request or response bodies or auth headers.

```ts
try {
  await vaults.withdraw("xlm-cc-v1", 100);
} catch (err) {
  if (err instanceof VaultSdkError && err.kind === "queue_conflict") {
    // show "withdrawal window closed" UI
  }
}
```

## Forward compatibility

Enum-like fields (`strategy`, `riskRating`, `currentPhase`, `outcome`) are typed
as `KnownOrUnknown<...>`. A newer backend can send a value this version does not
list, and the SDK passes it through unchanged. Required fields are still checked.

## Versioning

This package follows [Semantic Versioning](https://semver.org/).

- **Patch:** bug fixes and validation corrections that match the frozen contract.
- **Minor:** new endpoints, new optional fields, or new exports.
- **Major:** removed or renamed fields or methods, changed response shapes, or
  changed error `kind` mapping.

Versions are cut by release-please from Conventional Commit titles that touch
`packages/vault-sdk/`. Breaking changes use `feat!:` or a `BREAKING CHANGE:`
footer. Release notes are written to `packages/vault-sdk/CHANGELOG.md`. See
[RELEASING.md](../../RELEASING.md).

## Build

```sh
npm run build --prefix packages/vault-sdk
```

Output goes to `dist/`, which is not committed.
