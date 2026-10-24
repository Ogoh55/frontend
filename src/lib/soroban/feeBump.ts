/**
 * Fee-Bump and Sponsored-Transaction Support for Vault Deposits and
 * Redemptions (#247)
 *
 * Enables users to deposit into or redeem from vaults without holding XLM
 * for Stellar network fees. The backend sponsor wraps the user-signed inner
 * transaction in a Stellar fee-bump envelope, so the sponsor pays the
 * inclusion fee while the vault call's authorization remains tied to the
 * user's key.
 *
 * Security model
 * --------------
 *  - The user ALWAYS signs the inner transaction, which contains the vault
 *    call's `InvokerContractAuthEntry`. The sponsor's fee-bump wrapper only
 *    pays fees; it cannot alter the inner transaction's operations or auth.
 *  - The backend validates the inner transaction before wrapping it:
 *      • Operation must be a Soroban `invoke_host_function` against the
 *        expected vault contract.
 *      • The inner fee must be zero (we set it to the minimum so the user
 *        never over-pays; the sponsor's fee pays for inclusion).
 *      • The user's auth scope must match the requested entry point (reuses
 *        `validateAuthEnvelope` from vaultAuth.ts).
 *  - The sponsor's address is server-configured; the client only holds the
 *    inner XDR and the wrapped fee-bump XDR returned by the BFF.
 *
 * Flow
 * ----
 *  1. Client calls `buildSponsoredVaultTx` → BFF returns `inner_xdr`.
 *  2. User signs `inner_xdr` with Freighter (`signTransaction`).
 *  3. Client calls `submitSponsoredVaultTx` with the signed inner XDR.
 *  4. BFF wraps it in a fee-bump, signs the outer envelope, submits to Soroban.
 *  5. BFF waits for confirmation and returns the tx hash + status.
 *
 * This module owns:
 *  - The typed request/response shapes for steps 1 and 3.
 *  - `buildSponsoredVaultTx` and `submitSponsoredVaultTx` BFF calls.
 *  - `SponsoredVaultFlow` — a high-level orchestrator that runs the full
 *    flow and handles the Freighter sign step, returning a `FillResult`.
 *  - Eligibility check: `checkSponsorshipEligibility` — lets the UI show
 *    the XLM-free badge only when sponsorship is available.
 *  - Fallback: if the BFF is unavailable the caller can opt into the
 *    standard (non-sponsored) path via `depositToVault` / `withdrawFromVault`.
 */

import freighterApi from "@stellar/freighter-api";
import { bffFetch } from "../api/client";
import { submitTransactionXdr } from "../api/stellar";
import type { VaultEntryPoint } from "./vaultAuth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Vault entry points that support fee-bump sponsorship. */
export type SponsorableEntryPoint = Extract<VaultEntryPoint, "deposit" | "redeem_request">;

/**
 * Request body sent to `POST /api/v1/vaults/{id}/sponsored/build`.
 */
export interface SponsoredBuildRequest {
  vaultId: string;
  entryPoint: SponsorableEntryPoint;
  /** User's G-address. The inner transaction will require this account's signature. */
  userAddress: string;
  /**
   * Entry-point-specific parameters.
   * deposit: { amount: string (base units) }
   * redeem_request: { shares: string (base units) }
   */
  params: SponsoredDepositParams | SponsoredRedeemParams;
}

export interface SponsoredDepositParams {
  entryPoint: "deposit";
  /** Amount to deposit, in base units (7 decimal places). */
  amount: string;
}

export interface SponsoredRedeemParams {
  entryPoint: "redeem_request";
  /** Shares to queue for redemption, in base units. */
  shares: string;
}

/**
 * Response from `POST /api/v1/vaults/{id}/sponsored/build`.
 *
 * The BFF builds the inner Soroban transaction with `fee = 0` (the fee-bump
 * will supply the real inclusion fee). The user only signs `innerXdr`.
 */
export interface SponsoredBuildResponse {
  /** Base64-encoded XDR of the inner `TransactionEnvelope` to be signed. */
  innerXdr: string;
  /**
   * Ledger sequence number by which the inner transaction must be submitted.
   * Freighter uses this as the `timeBounds.maxTime` equivalent for Soroban.
   * The client should warn the user if signing is taking too long.
   */
  validUntilLedger: number;
  /** Human-readable estimate of the resource fee the sponsor will cover. */
  estimatedSponsorFeeXlm: string;
  /** The auth nonce embedded in the inner transaction for replay protection. */
  nonce: number;
}

/**
 * Request body for `POST /api/v1/vaults/{id}/sponsored/submit`.
 */
export interface SponsoredSubmitRequest {
  vaultId: string;
  entryPoint: SponsorableEntryPoint;
  /** The signed inner XDR returned by Freighter. */
  signedInnerXdr: string;
  /**
   * The nonce from `SponsoredBuildResponse`, echoed back so the BFF can
   * validate that the inner transaction the user signed matches the one
   * the BFF built (replay guard).
   */
  nonce: number;
}

/**
 * Response from `POST /api/v1/vaults/{id}/sponsored/submit`.
 */
export interface SponsoredSubmitResponse {
  txHash: string;
  /** Fee-bump transaction hash (outer envelope). */
  feeBumpTxHash: string;
  /** Ledger inclusion status from the BFF's confirmation wait. */
  status: "confirmed" | "pending";
  ledger?: number;
}

// ---------------------------------------------------------------------------
// BFF calls
// ---------------------------------------------------------------------------

/**
 * Step 1: ask the BFF to build the inner (unsigned) Soroban transaction.
 * The returned `innerXdr` must be passed to Freighter for signing.
 */
export async function buildSponsoredVaultTx(
  req: SponsoredBuildRequest,
  sessionToken?: string
): Promise<SponsoredBuildResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionToken) headers["authorization"] = `Bearer ${sessionToken}`;

  const res = await bffFetch(`/api/v1/vaults/${encodeURIComponent(req.vaultId)}/sponsored/build`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new SponsorshipError(
      body?.error ?? `Sponsorship build failed (HTTP ${res.status})`,
      "BUILD_FAILED",
      res.status
    );
  }

  return (await res.json()) as SponsoredBuildResponse;
}

/**
 * Step 3: submit the user-signed inner transaction for fee-bump wrapping
 * and on-chain submission by the BFF sponsor.
 */
export async function submitSponsoredVaultTx(
  req: SponsoredSubmitRequest,
  sessionToken?: string
): Promise<SponsoredSubmitResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionToken) headers["authorization"] = `Bearer ${sessionToken}`;

  const res = await bffFetch(`/api/v1/vaults/${encodeURIComponent(req.vaultId)}/sponsored/submit`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new SponsorshipError(
      body?.error ?? `Sponsorship submit failed (HTTP ${res.status})`,
      "SUBMIT_FAILED",
      res.status
    );
  }

  return (await res.json()) as SponsoredSubmitResponse;
}

// ---------------------------------------------------------------------------
// Eligibility check
// ---------------------------------------------------------------------------

export interface SponsorshipEligibility {
  available: boolean;
  /** Why sponsorship is not available (if `available` is false). */
  reason?: string;
  /**
   * Estimated XLM fee the sponsor covers, for display in the UI.
   * Provided when `available` is true.
   */
  estimatedSponsorFeeXlm?: string;
}

/**
 * Check whether the BFF sponsor can cover fees for this vault + entry point.
 * The UI should call this before rendering the "no XLM required" badge.
 *
 * Returns `{ available: false }` on any network error so the UI falls back
 * gracefully to the standard (non-sponsored) flow.
 */
export async function checkSponsorshipEligibility(
  vaultId: string,
  entryPoint: SponsorableEntryPoint
): Promise<SponsorshipEligibility> {
  try {
    const res = await bffFetch(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/sponsored/eligibility?entry_point=${entryPoint}`,
      { method: "GET" }
    );
    if (!res.ok) return { available: false, reason: `HTTP ${res.status}` };
    return (await res.json()) as SponsorshipEligibility;
  } catch {
    return { available: false, reason: "Eligibility check unavailable" };
  }
}

// ---------------------------------------------------------------------------
// High-level flow orchestrator
// ---------------------------------------------------------------------------

export interface SponsoredFlowOptions {
  vaultId: string;
  entryPoint: SponsorableEntryPoint;
  userAddress: string;
  params: SponsoredDepositParams | SponsoredRedeemParams;
  sessionToken?: string;
  /**
   * Called with a progress update so the UI can render step indicators.
   * Steps: "building" | "signing" | "submitting" | "confirming"
   */
  onProgress?: (step: SponsoredFlowStep) => void;
}

export type SponsoredFlowStep = "building" | "signing" | "submitting" | "confirming";

export interface SponsoredFlowResult {
  txHash: string;
  feeBumpTxHash: string;
  status: "confirmed" | "pending";
  ledger?: number;
  /** The BFF-estimated XLM fee that was sponsored. */
  sponsoredFeeXlm: string;
}

/**
 * Full fee-bump sponsorship flow. Orchestrates build → Freighter sign →
 * BFF submit → confirmation.
 *
 * Throws `SponsorshipError` on any failure. The caller should catch and
 * offer a fallback to the standard (non-sponsored) deposit/redeem path.
 */
export async function runSponsoredVaultFlow(
  options: SponsoredFlowOptions
): Promise<SponsoredFlowResult> {
  const { vaultId, entryPoint, userAddress, params, sessionToken, onProgress } = options;

  // Step 1: build inner XDR
  onProgress?.("building");
  const buildRes = await buildSponsoredVaultTx(
    { vaultId, entryPoint, userAddress, params },
    sessionToken
  );

  // Step 2: user signs with Freighter
  onProgress?.("signing");
  let signedInnerXdr: string;
  try {
    signedInnerXdr = await freighterApi.signTransaction(buildRes.innerXdr, {
      accountToSign: userAddress,
    });
  } catch (e) {
    throw new SponsorshipError(
      e instanceof Error ? e.message : "User rejected or Freighter unavailable",
      "SIGN_REJECTED",
      undefined
    );
  }

  // Step 3: submit signed inner XDR to BFF for fee-bump + submission
  onProgress?.("submitting");
  const submitRes = await submitSponsoredVaultTx(
    { vaultId, entryPoint, signedInnerXdr, nonce: buildRes.nonce },
    sessionToken
  );

  onProgress?.("confirming");
  return {
    txHash: submitRes.txHash,
    feeBumpTxHash: submitRes.feeBumpTxHash,
    status: submitRes.status,
    ledger: submitRes.ledger,
    sponsoredFeeXlm: buildRes.estimatedSponsorFeeXlm,
  };
}

// ---------------------------------------------------------------------------
// Fallback: standard non-sponsored path
// ---------------------------------------------------------------------------

/**
 * Thin wrapper that runs the standard (non-fee-bump) deposit flow for cases
 * where the sponsor is unavailable. Uses the same BFF build → Freighter sign
 * → submit pattern as the existing `depositToVault` in `vault.ts`, but works
 * against the Phase 2 vault API.
 *
 * This function exists here so the UI can call a single entry point that
 * automatically downgrades from sponsored → standard when needed.
 */
export interface StandardFallbackOptions {
  vaultId: string;
  entryPoint: SponsorableEntryPoint;
  userAddress: string;
  params: SponsoredDepositParams | SponsoredRedeemParams;
  sessionToken?: string;
}

export async function runStandardVaultFlow(
  options: StandardFallbackOptions
): Promise<{ txHash: string; status: "confirmed" | "pending" }> {
  const { vaultId, entryPoint, userAddress, params, sessionToken } = options;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionToken) headers["authorization"] = `Bearer ${sessionToken}`;

  // Build unsigned transaction (standard fee, no sponsorship)
  const buildRes = await bffFetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}/${entryPoint.replace("_", "-")}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      wallet_address: userAddress,
      ...params,
    }),
  });

  if (!buildRes.ok) {
    const body = await buildRes.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Standard vault ${entryPoint} failed (HTTP ${buildRes.status})`);
  }

  const { xdr } = (await buildRes.json()) as { xdr: string };
  const signed = await freighterApi.signTransaction(xdr, { accountToSign: userAddress });
  const { hash } = await submitTransactionXdr(signed);
  return { txHash: hash, status: "pending" };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SponsorshipErrorCode =
  | "BUILD_FAILED"
  | "SIGN_REJECTED"
  | "SUBMIT_FAILED"
  | "ELIGIBILITY_UNKNOWN";

export class SponsorshipError extends Error {
  readonly code: SponsorshipErrorCode;
  readonly httpStatus: number | undefined;

  constructor(message: string, code: SponsorshipErrorCode, httpStatus?: number) {
    super(message);
    this.name = "SponsorshipError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
