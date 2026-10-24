/**
 * Vault on-chain operations: deposit collateral into the Zenith vault
 * contract and withdraw free collateral back to the wallet.
 *
 * This is the margin-collateral vault (NEXT_PUBLIC_VAULT_CONTRACT_ID). It is
 * unrelated to the Phase 2 options vault scaffolded in `contracts/vault`
 * (wired later via `./vaults.ts`).
 *
 * Both flows use the same pattern:
 *   1. Ask the backend to build a Soroban transaction XDR.
 *   2. Ask Freighter to sign it.
 *   3. Submit to Horizon/Soroban RPC.
 *   4. Return the confirmed transaction hash.
 *
 * The contract address lives in NEXT_PUBLIC_VAULT_CONTRACT_ID; if not
 * set the helpers throw so the UI can surface a clear error rather than
 * sending garbage.
 *
 * History comes from Horizon contract-event filtering; we translate those
 * into a lightweight VaultEvent shape for the UI.
 *
 * Resilience (#282): the BFF owns the Soroban RPC provider pool, failover,
 * batching, and read-after-write confirmation. This module surfaces the
 * freshness/confirmation status the BFF returns so the UI can render
 * degraded states explicitly instead of showing stale balances.
 */

import { submitTransactionXdr } from "./stellar";
import freighterApi from "@stellar/freighter-api";
import { bffFetch } from "./client";

export const VAULT_CONTRACT_ID =
  process.env.NEXT_PUBLIC_VAULT_CONTRACT_ID ?? null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Freshness of the state returned by the BFF after a write.
 * - `confirmed`: ledger inclusion observed and state re-read.
 * - `pending`: submission accepted but confirmation timed out; the UI should
 *   show a "pending confirmation" state and poll rather than re-submit.
 */
export type VaultConfirmationStatus = "confirmed" | "pending";

export interface VaultOperationResult {
  txHash: string;
  amount: number;
  operation: "deposit" | "withdraw";
  /** Read-after-write confirmation status from the BFF. */
  status: VaultConfirmationStatus;
  /** Ledger the write was observed in, when confirmed. */
  ledger?: number;
  /** Re-read state after the write, when the BFF returned it. */
  state?: VaultStateSnapshot;
}

/** Post-write snapshot of the balances the UI renders. */
export interface VaultStateSnapshot {
  nav?: number;
  shareBalance?: number;
  tokenBalance?: number;
  ledger?: number;
}

export type VaultEventType = "deposit" | "withdraw";

export interface VaultEvent {
  type: VaultEventType;
  amount: number;
  txHash: string;
  timestamp: string; // ISO 8601
  ledger: number;
}

// ---------------------------------------------------------------------------
// Read-after-write confirmation
// ---------------------------------------------------------------------------

/**
 * Documented timeout (ms) the BFF waits for ledger inclusion before falling
 * back to the `pending` state. Kept in sync with the server-side client.
 */
export const VAULT_CONFIRMATION_TIMEOUT_MS = 30_000;

interface ConfirmationResponse {
  status?: VaultConfirmationStatus;
  ledger?: number;
  state?: VaultStateSnapshot;
}

/**
 * Asks the BFF to wait for ledger inclusion and re-read affected state.
 * Never re-submits the signed transaction: on timeout the BFF returns
 * `pending` and the caller surfaces a degraded state.
 */
async function confirmVaultWrite(
  txHash: string,
  operation: "deposit" | "withdraw"
): Promise<ConfirmationResponse> {
  try {
    const res = await bffFetch("/api/v1/onchain/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tx_hash: txHash,
        operation,
        timeout_ms: VAULT_CONFIRMATION_TIMEOUT_MS,
      }),
    });

    if (!res.ok) return { status: "pending" };
    return (await res.json()) as ConfirmationResponse;
  } catch {
    // Network/parse failure: treat as pending rather than claiming success.
    return { status: "pending" };
  }
}

// ---------------------------------------------------------------------------
// Backend-assisted transaction building
// ---------------------------------------------------------------------------

/**
 * Asks the backend to build an XDR for a vault deposit, has Freighter sign
 * it, submits to Horizon, and returns the tx hash.
 */
export async function depositToVault(
  address: string,
  amount: number,
  _session: string
): Promise<VaultOperationResult> {
  if (!VAULT_CONTRACT_ID) {
    throw new Error(
      "NEXT_PUBLIC_VAULT_CONTRACT_ID is not configured. Vault operations are unavailable."
    );
  }

  // Authenticated by the BFF session cookie (#118).
  const buildRes = await bffFetch("/api/v1/onchain/build-deposit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet_address: address,
      amount: amount.toString(),
    }),
  });

  if (!buildRes.ok) {
    const body = await buildRes.json().catch(() => null);
    throw new Error(
      body?.error ?? `Backend build-deposit failed (${buildRes.status})`
    );
  }

  const { xdr } = (await buildRes.json()) as { xdr: string };
  const signed = await freighterApi.signTransaction(xdr, {
    accountToSign: address,
  });
  const { hash } = await submitTransactionXdr(signed);

  // Read-after-write: wait for inclusion and re-read state before returning.
  const confirmation = await confirmVaultWrite(hash, "deposit");

  return {
    txHash: hash,
    amount,
    operation: "deposit",
    status: confirmation.status ?? "pending",
    ledger: confirmation.ledger,
    state: confirmation.state,
  };
}

/**
 * Withdraw free (unlocked) collateral from the vault back to the wallet.
 * Validates against the backend's free-collateral figure before building the
 * transaction so the user gets an early rejection rather than an on-chain
 * failure.
 */
export async function withdrawFromVault(
  address: string,
  amount: number,
  _session: string,
  freeCollateral: number
): Promise<VaultOperationResult> {
  if (!VAULT_CONTRACT_ID) {
    throw new Error(
      "NEXT_PUBLIC_VAULT_CONTRACT_ID is not configured. Vault operations are unavailable."
    );
  }

  if (amount > freeCollateral) {
    throw new Error(
      `Withdrawal amount (${amount}) exceeds free collateral (${freeCollateral.toFixed(2)}). ` +
        "Close or reduce positions to unlock collateral first."
    );
  }

  // Authenticated by the BFF session cookie (#118).
  const buildRes = await bffFetch("/api/v1/onchain/build-withdraw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet_address: address,
      amount: amount.toString(),
    }),
  });

  if (!buildRes.ok) {
    const body = await buildRes.json().catch(() => null);
    throw new Error(
      body?.error ?? `Backend build-withdraw failed (${buildRes.status})`
    );
  }

  const { xdr } = (await buildRes.json()) as { xdr: string };
  const signed = await freighterApi.signTransaction(xdr, {
    accountToSign: address,
  });
  const { hash } = await submitTransactionXdr(signed);

  // Read-after-write: wait for inclusion and re-read state before returning.
  const confirmation = await confirmVaultWrite(hash, "withdraw");

  return {
    txHash: hash,
    amount,
    operation: "withdraw",
    status: confirmation.status ?? "pending",
    ledger: confirmation.ledger,
    state: confirmation.state,
  };
}

// ---------------------------------------------------------------------------
// Vault event history (from Horizon contract events)
// ---------------------------------------------------------------------------

const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

/**
 * Fetches deposit/withdraw events for `address` from Horizon's
 * contract-events endpoint.  Returns an empty array when the contract ID
 * is not configured or when Horizon returns no events.
 */
export async function fetchVaultHistory(
  address: string
): Promise<VaultEvent[]> {
  if (!VAULT_CONTRACT_ID) return [];

  // Horizon contract-events endpoint filters by contract and topic.
  // We fetch both deposit and withdraw events and merge them.
  const url = new URL(`${HORIZON_URL}/contract_events`);
  url.searchParams.set("contract_id", VAULT_CONTRACT_ID);
  url.searchParams.set("order", "desc");
  url.searchParams.set("limit", "50");

  const res = await fetch(url.toString());
  if (!res.ok) return []; // Treat any error as "no history" for resilience.

  const data = await res.json();
  const records: Array<Record<string, unknown>> =
    (data as { _embedded?: { records?: Array<Record<string, unknown>> } })
      ._embedded?.records ?? [];

  return records
    .filter((r) => {
      // Each event record has a `topics` array; the first topic is the
      // event name, second is the wallet address.
      const topics = (r.topic as string[] | undefined) ?? [];
      return (
        topics.length >= 2 &&
        (topics[0] === "deposit" || topics[0] === "withdraw") &&
        topics[1] === address
      );
    })
    .map((r) => {
      const topics = r.topic as string[];
      const amountRaw =
        typeof r.value === "string"
          ? parseFloat(r.value)
          : 0;
      return {
        type: topics[0] as VaultEventType,
        amount: amountRaw,
        txHash: (r.transaction_hash as string) ?? "",
        timestamp: (r.created_at as string) ?? new Date().toISOString(),
        ledger: typeof r.ledger === "number" ? r.ledger : 0,
      };
    });
}
