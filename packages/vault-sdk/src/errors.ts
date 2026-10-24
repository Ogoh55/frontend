/**
 * Error taxonomy for the vault SDK.
 *
 * - `validation`     bad input from the caller, or a response that does not match the contract
 * - `capacity`       the vault or the account hit a limit (HTTP 402)
 * - `queue_conflict` the request conflicts with the epoch queue state (HTTP 409)
 * - `http`           any other non-2xx response
 * - `transport`      the request never produced an HTTP response (network failure, abort)
 *
 * Messages never include the request body, response body, or auth headers.
 */

export type VaultErrorKind = "validation" | "capacity" | "queue_conflict" | "http" | "transport";

export interface VaultErrorOptions {
  status?: number;
  /** Machine-readable `code` from the backend error body, when present. */
  code?: string;
  cause?: unknown;
}

export class VaultSdkError extends Error {
  readonly kind: VaultErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly cause?: unknown;

  constructor(kind: VaultErrorKind, message: string, options: VaultErrorOptions = {}) {
    super(message);
    this.name = "VaultSdkError";
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
    this.cause = options.cause;
  }
}

/** Maps a non-2xx HTTP status to the SDK error taxonomy. */
export function httpError(status: number, code?: string): VaultSdkError {
  const options = { status, code };
  if (status === 402) return new VaultSdkError("capacity", `Vault capacity or limit rejected the request (HTTP ${status})`, options);
  if (status === 409) return new VaultSdkError("queue_conflict", `Vault queue state conflicts with the request (HTTP ${status})`, options);
  if (status === 400 || status === 422) return new VaultSdkError("validation", `Vault API rejected the request (HTTP ${status})`, options);
  return new VaultSdkError("http", `Vault API request failed (HTTP ${status})`, options);
}
