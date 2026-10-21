# Ledger Hardware Wallet Support

Zenith supports connecting a **Ledger hardware wallet** as an alternative to
the Freighter browser extension. Ledger gives high-value users and treasuries
a hardware-backed signing path with no seed phrase in the browser.

## Supported Browsers

- **Chrome / Edge / Brave (Chromium)** — WebHID is preferred; WebUSB is the
  fallback when WebHID is unavailable.
- **Firefox** — no WebHID support. Ledger connections are not available in
  Firefox; the UI shows a clear error rather than a silent hang.
- **Safari** — not supported (no WebHID/WebUSB on desktop Safari).

## Connecting

1. Open the **Stellar app** on your Ledger device.
2. Open Zenith, open the wallet menu, and choose **Connect Ledger**.
3. When prompted, enter the **BIP44 account index** (default `0`). The
   derivation path used is `44'/148'/<index>'`.
4. Zenith requests the device public key; the address is shown on-screen for
   on-device verification (the Ledger screen displays the same address —
   compare it before confirming).
5. The backend sign-in message is then signed by the device. The signature
   is a base64-encoded 64-byte ed25519 signature of the SHA-256 hash of the
   challenge message.

## Signing Transactions

- **Stellar (Payment/ManageData) transactions**: signed via the Ledger
  Stellar app's `signTransaction` API, with the full transaction XDR.
- **Soroban transactions**: the Ledger app supports hash-signing. Soroban
  auth entries that require a hash signature are signed with `signHash`.
  If the simulation indicates a Soroban auth entry the device cannot sign
  directly, the UI explains the hash-signing requirement before prompting.

## Error Handling

| Situation | Message |
| --- | --- |
| Device locked / Stellar app not open | "Ledger did not return an address; ensure the Stellar app is open on the device" |
| User rejected on-device | "User rejected the operation on the Ledger device" |
| Browser unsupported (Firefox) | "No Ledger transport available: WebHID transport not available; WebUSB transport not available" |
| Backend sign-in failed | "Backend sign-in failed" (token left null; the wallet stays connected) |

## Manual Test Report

| Field | Value |
| --- | --- |
| Device model | Ledger Nano S Plus / Nano X |
| Firmware | 2.x (Stellar app 6.x) |
| Browser | Chrome 124+ |
| Transport used | WebHID (fallback to WebUSB) |
| Derivation path | `44'/148'/0'` |
| Sign-in flow | Backend nonce → SHA-256 → `signHash` → base64 → `/auth/verify` |
| Soroban hash-signing | Verified with a Soroban auth entry requiring hash signing |

## Notes

- The transport is kept open until the user disconnects. Disconnecting the
  wallet store does not close the transport; reload the page to release the
  USB handle.
- Ledger support is **lazy-loaded**: the `@ledgerhq/*` packages are only
  fetched when the user chooses "Connect Ledger", keeping the main bundle
  small.
- Soroban auth entries that require hash signing are documented here because
  the device cannot display arbitrary Soroban contract details. Always
  review the transaction hash on the Ledger screen before confirming.

---

# Epoch Share-Balance Snapshots & Merkle Commitments

This section specifies the **epoch share-balance commitment** used for
provable redemptions (issue #278). At each committed epoch the vault stores a
Merkle root over that epoch's share balances, alongside the already-committed
NAV per share and epoch number. Any depositor can prove their balance at a
given epoch, and any third party can verify a historical redemption claim
without trusting the backend database.

## Commitment Versioning

The commitment is versioned so a future change to the tree construction is
detectable. The current version is **`v1`**. The version is committed on-chain
together with the root; a verifier MUST reject a proof whose version does not
match the stored commitment version.

## Canonical Leaf Encoding

Each leaf commits to a single `(account, balance)` pair for the epoch:

```
leaf_preimage = "zenith:epoch-share:v1" || 0x00
             || epoch_u64_be
             || account_32_bytes
             || balance_i128_be
leaf_hash     = SHA-256(leaf_preimage)
```

- `epoch_u64_be` — the epoch number as an 8-byte big-endian unsigned integer.
- `account_32_bytes` — the raw 32-byte Stellar account (ed25519 public key),
  not the `G...` StrKey form.
- `balance_i128_be` — the share balance as a 16-byte big-endian two's
  complement signed integer (i128). Balances are non-negative in practice but
  the encoding is signed to match the on-chain type.
- The domain-separation prefix `"zenith:epoch-share:v1" || 0x00` prevents a
  leaf hash from colliding with an internal-node hash.

## Ordering Rule

Leaves are sorted by **account bytes in ascending lexicographic order**
(byte-wise comparison of the 32-byte account, equivalent to comparing the
unsigned big-endian integer). The ordering is total and unambiguous because
accounts are unique within an epoch. Implementations MUST NOT rely on map
iteration order; they MUST sort explicitly.

## Tree Construction

1. Compute the leaf hash for every `(account, balance)` entry with a
   non-zero balance. Zero-balance accounts are omitted (they contribute
   nothing to redemption claims).
2. Sort leaves by the ordering rule above.
3. Build a binary Merkle tree bottom-up. Internal nodes hash their two
   children concatenated:

   ```
   node_hash = SHA-256(0x01 || left || right)
   ```

   The `0x01` prefix domain-separates internal nodes from leaves.
4. **Odd node count at any level**: the last node is promoted unchanged to
   the next level (it is *not* duplicated). This avoids the CVE-2012-2459
   duplicate-node ambiguity.
5. **Empty epoch**: the root is the all-zero 32-byte value (`0x00…00`).
6. **Single holder**: the root is that holder's leaf hash (no internal
   nodes).

## Proof Format

A Merkle proof is an ordered list of sibling hashes from leaf to root, each
with a direction bit indicating whether the sibling is on the left or right:

```
proof = [ { sibling: 32 bytes, side: "left" | "right" }, ... ]
```

Verification recomputes the leaf hash from `(account, balance, epoch)`, then
folds each step: `side == "left"` → `node = SHA-256(0x01 || sibling || node)`,
`side == "right"` → `node = SHA-256(0x01 || node || sibling)`. The proof is
valid iff the folded value equals the stored root for that epoch.

## Verifier Entry Point

The vault contract exposes a verifier that checks a claimed
`(account, balance, epoch, proof)` against the stored root:

```
verify_share_balance(epoch, account, balance, proof) -> bool
```

It returns `true` only when the recomputed root matches the committed root
for `epoch` and the commitment version matches. A documented library
(`src/lib/merkle.ts`) implements the identical construction in TypeScript so
the frontend can verify independently; the Rust indexer and the TypeScript
library MUST hash identically (cross-implementation test vectors are checked
in CI).

## Redemption & Distribution Validation

Redemption and distribution claims for an epoch are validated against the
committed root before being accepted. If a claim's `(account, balance)` does
not verify against the epoch root, the mismatch is **surfaced as an error**
(not silently accepted), and the claim is rejected. This gives the
break-glass and distribution paths a deterministic balance source they can
point at.

## Backend Indexer

The indexer builds trees from indexed contract events (not by re-reading
contract state), stores the per-epoch root and the leaf set, and serves
proofs through the API. The `/vaults` detail surface exposes the committed
root per epoch so a determined depositor can verify independently.

## Resource Budget & Fallback

The maximum committed holder set per epoch is **4096 leaves** (a tree of
height 12), which stays within Soroban resource budgets for a single
commitment. If an epoch exceeds this size, the indexer commits a **sharded**
commitment: the holder set is partitioned by the first byte of the account
into up to 256 shards, each shard committed as its own root, and the epoch
commitment stores the ordered list of shard roots. Proofs then reference the
shard root plus the shard index. The sharded form is versioned separately
(`v1-sharded`) so verifiers can distinguish it from the single-root form.
