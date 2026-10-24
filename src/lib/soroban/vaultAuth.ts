/**
 * Vault Authorization Scoping and Replay Protection (#255)
 *
 * Defines the explicit authorization envelope that must accompany every
 * state-changing vault entry point: deposit, redeem_request, withdraw,
 * epoch_rollover, and update_params.
 *
 * Design goals:
 *  - Each entry point has a narrow, named scope — a signature collected for
 *    one call cannot be replayed against another.
 *  - Nonces are per-(caller, vault, entry-point) so a signature cannot be
 *    moved to a different vault or a different operation on the same vault.
 *  - Ledger-window binding (valid_before_ledger) bounds the replay window to
 *    a short ledger range; a stale signature is rejected on-chain.
 *  - All verification is pure (no I/O) and independently unit-tested.
 */

// ---------------------------------------------------------------------------
// Entry-point scope identifiers
// ---------------------------------------------------------------------------

/** Every state-changing vault entry point that requires authorization. */
export type VaultEntryPoint =
  | "deposit"
  | "redeem_request"
  | "withdraw"
  | "epoch_rollover"
  | "update_params";

/** Scope tag embedded in the authorization envelope.
 *  Intentionally verbose — a signature for "vault:deposit" cannot be
 *  replayed as "vault:withdraw" even if the rest of the payload matches. */
export type VaultAuthScope = `vault:${VaultEntryPoint}`;

export function entryPointScope(ep: VaultEntryPoint): VaultAuthScope {
  return `vault:${ep}`;
}

// ---------------------------------------------------------------------------
// Authorization envelope
// ---------------------------------------------------------------------------

/**
 * The data that is hashed and signed to authorize one vault operation.
 *
 * Field semantics:
 *   scope            — which entry point is being authorized
 *   vault_id         — the specific vault contract; prevents cross-vault replay
 *   caller           — the G-address of the authorizing account
 *   nonce            — monotonically increasing counter per (caller, vault, scope)
 *   valid_before_ledger — inclusive upper ledger bound; the backend rejects
 *                         envelopes past this ledger (maps to Soroban's
 *                         `InvokerContractAuthEntry.last_ledger`)
 *   payload          — entry-point-specific parameters (see below)
 */
export interface VaultAuthEnvelope {
  scope: VaultAuthScope;
  vault_id: string;
  caller: string;
  nonce: number;
  valid_before_ledger: number;
  payload: VaultAuthPayload;
}

// ---------------------------------------------------------------------------
// Per-entry-point typed payloads
// ---------------------------------------------------------------------------

export type VaultAuthPayload =
  | DepositPayload
  | RedeemRequestPayload
  | WithdrawPayload
  | EpochRolloverPayload
  | UpdateParamsPayload;

export interface DepositPayload {
  entry_point: "deposit";
  /** Amount in base units (stroop-equivalent, 7 decimals). */
  amount: bigint;
}

export interface RedeemRequestPayload {
  entry_point: "redeem_request";
  /** LP shares to queue for redemption. */
  shares: bigint;
}

export interface WithdrawPayload {
  entry_point: "withdraw";
  /** Must match the previously queued redemption amount. */
  shares: bigint;
}

export interface EpochRolloverPayload {
  entry_point: "epoch_rollover";
  current_epoch: number;
  next_epoch: number;
}

export interface UpdateParamsPayload {
  entry_point: "update_params";
  /** Key-value pairs of the parameters being updated. */
  params: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Nonce storage key
// ---------------------------------------------------------------------------

/**
 * Canonical key for looking up the expected nonce for a (caller, vault, scope)
 * triple from the backend or the local nonce cache.
 */
export function nonceKey(
  caller: string,
  vaultId: string,
  scope: VaultAuthScope
): string {
  return `${caller}:${vaultId}:${scope}`;
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

/**
 * Builds a signed authorization envelope. The `nonce` and
 * `valid_before_ledger` must be fetched from the backend (or the chain) just
 * before calling this — do not cache them across sessions.
 *
 * @param ep              - Entry point being authorized
 * @param vault_id        - Vault contract address
 * @param caller          - Authorizing G-address
 * @param nonce           - Fresh nonce from `GET /api/v1/vaults/{id}/auth-nonce`
 * @param currentLedger   - Current ledger sequence (from RPC)
 * @param windowLedgers   - Replay window size; default 60 ledgers (~5 min)
 * @param payload         - Entry-point-specific parameters
 */
export function buildAuthEnvelope(
  ep: VaultEntryPoint,
  vault_id: string,
  caller: string,
  nonce: number,
  currentLedger: number,
  payload: VaultAuthPayload,
  windowLedgers = 60
): VaultAuthEnvelope {
  if (payload.entry_point !== ep) {
    throw new Error(
      `Payload entry_point "${payload.entry_point}" does not match requested entry_point "${ep}"`
    );
  }
  return {
    scope: entryPointScope(ep),
    vault_id,
    caller,
    nonce,
    valid_before_ledger: currentLedger + windowLedgers,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Envelope validation (client-side pre-flight)
// ---------------------------------------------------------------------------

export interface EnvelopeValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Client-side pre-flight validation before the envelope is sent to the
 * backend for signing.  This is NOT a substitute for on-chain authorization —
 * it surfaces obvious mistakes early.
 *
 * @param envelope         - Envelope to validate
 * @param currentLedger    - Current ledger sequence (from RPC)
 * @param knownNonce       - The nonce the backend currently expects for this
 *                           (caller, vault, scope). Pass `null` to skip.
 */
export function validateAuthEnvelope(
  envelope: VaultAuthEnvelope,
  currentLedger: number,
  knownNonce: number | null
): EnvelopeValidationResult {
  const errors: string[] = [];

  // Scope must match payload
  const expectedScope = entryPointScope(envelope.payload.entry_point);
  if (envelope.scope !== expectedScope) {
    errors.push(
      `scope mismatch: envelope says "${envelope.scope}" but payload entry_point is "${envelope.payload.entry_point}"`
    );
  }

  // Ledger window must be in the future (with at least 5 ledgers of slack)
  if (envelope.valid_before_ledger <= currentLedger + 5) {
    errors.push(
      `valid_before_ledger (${envelope.valid_before_ledger}) is too close to or before current ledger (${currentLedger})`
    );
  }

  // Ledger window must not be too far out (≤ 1 000 ledgers, ~83 min)
  if (envelope.valid_before_ledger > currentLedger + 1000) {
    errors.push(
      `valid_before_ledger window is too large (${envelope.valid_before_ledger - currentLedger} ledgers; max 1000)`
    );
  }

  // Nonce check
  if (knownNonce !== null && envelope.nonce !== knownNonce) {
    errors.push(
      `nonce mismatch: expected ${knownNonce}, got ${envelope.nonce}`
    );
  }

  // Caller must look like a Stellar G-address
  if (!envelope.caller.startsWith("G") || envelope.caller.length !== 56) {
    errors.push(`caller "${envelope.caller}" does not look like a valid G-address`);
  }

  // Vault ID must be set
  if (!envelope.vault_id || envelope.vault_id.trim() === "") {
    errors.push("vault_id must not be empty");
  }

  // Entry-point-specific amount bounds
  if (
    envelope.payload.entry_point === "deposit" &&
    envelope.payload.amount <= 0n
  ) {
    errors.push("deposit amount must be positive");
  }
  if (
    (envelope.payload.entry_point === "redeem_request" ||
      envelope.payload.entry_point === "withdraw") &&
    envelope.payload.shares <= 0n
  ) {
    errors.push(`${envelope.payload.entry_point} shares must be positive`);
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Replay-protection header builder (BFF request attachment)
// ---------------------------------------------------------------------------

/**
 * Returns the HTTP headers that the BFF's vault proxy routes expect.
 * The backend uses these to verify the envelope before forwarding to Soroban.
 *
 * Header layout:
 *   x-vault-scope          — VaultAuthScope
 *   x-vault-nonce          — nonce (stringified)
 *   x-vault-valid-before   — valid_before_ledger (stringified)
 *   x-vault-vault-id       — vault_id
 */
export function buildAuthHeaders(
  envelope: VaultAuthEnvelope
): Record<string, string> {
  return {
    "x-vault-scope": envelope.scope,
    "x-vault-nonce": String(envelope.nonce),
    "x-vault-valid-before": String(envelope.valid_before_ledger),
    "x-vault-vault-id": envelope.vault_id,
  };
}
