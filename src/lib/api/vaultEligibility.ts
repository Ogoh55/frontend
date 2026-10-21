/**
 * Vault Eligibility API Client
 *
 * Fetches on-chain activity and vault event history needed to run the
 * anti-sybil / reward-farming eligibility check in src/lib/vaultEligibility.ts.
 *
 * Backend contract (for when the real API lands):
 *
 *   GET /api/v1/eligibility/wallet/{address}
 *   → { activity: WalletActivity; vaultEvents: VaultEvent[] }
 *
 *   GET /api/v1/eligibility/vaults/{vaultId}/check?wallet={address}
 *   → EligibilityResult (server-computed, used when NEXT_PUBLIC_VAULTS=live)
 *
 * When NEXT_PUBLIC_VAULTS !== "live" (default) the module uses a deterministic
 * mock derived from the wallet address so tests and development always work.
 */

import type { WalletActivity, VaultEvent, EligibilityResult, EligibilityInput } from "../vaultEligibility";
import { scoreEligibility } from "../vaultEligibility";

// ---------------------------------------------------------------------------
// Types exported by the API layer
// ---------------------------------------------------------------------------

export interface WalletEligibilityData {
  activity: WalletActivity;
  vaultEvents: VaultEvent[];
}

// ---------------------------------------------------------------------------
// Mock data generator
// ---------------------------------------------------------------------------

/**
 * Deterministic mock that produces different profiles based on the wallet address
 * to exercise the full range of eligibility outcomes in development.
 *
 * Profile selection is based on the last hex digit of the address (if Stellar
 * strkeys don't have hex, we use string length % 8).
 */
function mockProfileIndex(walletAddress: string): number {
  // Use last char code mod 8 for stable determinism
  const lastChar = walletAddress.slice(-1);
  return lastChar.charCodeAt(0) % 8;
}

function buildMockData(
  walletAddress: string,
  nowMs: number,
): WalletEligibilityData {
  const profileIndex = mockProfileIndex(walletAddress);

  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;

  // Profile 0: Ideal user — old wallet, lots of activity, long holds
  if (profileIndex === 0) {
    return {
      activity: {
        walletCreatedAtMs: nowMs - 180 * day,
        totalTransactions: 142,
        distinctContractInteractions: 8,
      },
      vaultEvents: [
        { vaultId: "xlm-cc-v1", type: "deposit",  timestampMs: nowMs - 60 * day, amount: 5000 },
        { vaultId: "eth-ic-v1", type: "deposit",  timestampMs: nowMs - 30 * day, amount: 2500 },
        { vaultId: "eth-ic-v1", type: "withdraw", timestampMs: nowMs - 5  * day, amount: 2500 },
        { vaultId: "btc-csp-v1", type: "deposit", timestampMs: nowMs - 14 * day, amount: 10000 },
      ],
    };
  }

  // Profile 1: New user — created 5 days ago, minimal activity
  if (profileIndex === 1) {
    return {
      activity: {
        walletCreatedAtMs: nowMs - 5 * day,
        totalTransactions: 3,
        distinctContractInteractions: 1,
      },
      vaultEvents: [],
    };
  }

  // Profile 2: Flash depositor — deposit then immediate withdrawal
  if (profileIndex === 2) {
    return {
      activity: {
        walletCreatedAtMs: nowMs - 45 * day,
        totalTransactions: 22,
        distinctContractInteractions: 3,
      },
      vaultEvents: [
        { vaultId: "xlm-cc-v1", type: "deposit",  timestampMs: nowMs - 2 * hour, amount: 3000 },
        { vaultId: "xlm-cc-v1", type: "withdraw", timestampMs: nowMs - 1 * hour, amount: 3000 },
      ],
    };
  }

  // Profile 3: Vault hopper — multiple vaults in short window
  if (profileIndex === 3) {
    return {
      activity: {
        walletCreatedAtMs: nowMs - 90 * day,
        totalTransactions: 55,
        distinctContractInteractions: 5,
      },
      vaultEvents: [
        { vaultId: "xlm-cc-v1",  type: "deposit", timestampMs: nowMs - 3 * hour, amount: 1000 },
        { vaultId: "btc-csp-v1", type: "deposit", timestampMs: nowMs - 2 * hour, amount: 1000 },
        { vaultId: "eth-ic-v1",  type: "deposit", timestampMs: nowMs - 1 * hour, amount: 1000 },
        { vaultId: "sol-wheel-v1", type: "deposit", timestampMs: nowMs - 30 * 60 * 1000, amount: 1000 },
      ],
    };
  }

  // Profile 4: Recycler — many round-trips in last 7 days
  if (profileIndex === 4) {
    return {
      activity: {
        walletCreatedAtMs: nowMs - 120 * day,
        totalTransactions: 80,
        distinctContractInteractions: 4,
      },
      vaultEvents: [
        { vaultId: "xlm-cc-v1", type: "deposit",  timestampMs: nowMs - 6 * day,  amount: 500 },
        { vaultId: "xlm-cc-v1", type: "withdraw", timestampMs: nowMs - 5 * day,  amount: 500 },
        { vaultId: "btc-csp-v1", type: "deposit", timestampMs: nowMs - 4 * day,  amount: 500 },
        { vaultId: "btc-csp-v1", type: "withdraw", timestampMs: nowMs - 3 * day, amount: 500 },
        { vaultId: "eth-ic-v1", type: "deposit",  timestampMs: nowMs - 2 * day,  amount: 500 },
        { vaultId: "eth-ic-v1", type: "withdraw", timestampMs: nowMs - 1 * day,  amount: 500 },
      ],
    };
  }

  // Profile 5: Under review — moderate score
  if (profileIndex === 5) {
    return {
      activity: {
        walletCreatedAtMs: nowMs - 12 * day,
        totalTransactions: 8,
        distinctContractInteractions: 2,
      },
      vaultEvents: [
        { vaultId: "xlm-cc-v1", type: "deposit",  timestampMs: nowMs - 2 * day, amount: 1200 },
      ],
    };
  }

  // Profile 6: Long-term holder, single vault (diversification penalty)
  if (profileIndex === 6) {
    return {
      activity: {
        walletCreatedAtMs: nowMs - 200 * day,
        totalTransactions: 95,
        distinctContractInteractions: 2,
      },
      vaultEvents: [
        { vaultId: "xlm-cc-v1", type: "deposit", timestampMs: nowMs - 90 * day, amount: 8000 },
        { vaultId: "xlm-cc-v1", type: "deposit", timestampMs: nowMs - 60 * day, amount: 4000 },
        { vaultId: "xlm-cc-v1", type: "deposit", timestampMs: nowMs - 30 * day, amount: 2000 },
        { vaultId: "xlm-cc-v1", type: "deposit", timestampMs: nowMs - 7  * day, amount: 1000 },
      ],
    };
  }

  // Profile 7 (default): average user
  return {
    activity: {
      walletCreatedAtMs: nowMs - 60 * day,
      totalTransactions: 18,
      distinctContractInteractions: 3,
    },
    vaultEvents: [
      { vaultId: "xlm-cc-v1", type: "deposit", timestampMs: nowMs - 14 * day, amount: 2000 },
      { vaultId: "btc-csp-v1", type: "deposit", timestampMs: nowMs - 7 * day, amount: 1500 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the raw wallet eligibility data (activity + event history).
 * Uses mock data unless NEXT_PUBLIC_VAULTS=live.
 */
export async function fetchWalletEligibilityData(
  walletAddress: string,
  _token?: string | null,
): Promise<WalletEligibilityData> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: replace with real API call once backend ships
    // return apiGet<WalletEligibilityData>(
    //   `/api/v1/eligibility/wallet/${walletAddress}`,
    //   token,
    // );
    throw new Error("Live vaults eligibility API not yet implemented");
  }

  // Simulate network latency in mock mode
  await new Promise(r => setTimeout(r, 150));
  return buildMockData(walletAddress, Date.now());
}

/**
 * Compute the full eligibility result for a wallet + target vault.
 *
 * In live mode: delegates to the server so the score can't be gamed
 * by a modified client.
 *
 * In mock mode: runs the local scorer (useful for testing and demos).
 */
export async function checkVaultEligibility(
  walletAddress: string,
  targetVaultId: string,
  token?: string | null,
): Promise<EligibilityResult> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // TODO: replace with real API call
    // return apiGet<EligibilityResult>(
    //   `/api/v1/eligibility/vaults/${targetVaultId}/check?wallet=${walletAddress}`,
    //   token,
    // );
    throw new Error("Live vaults eligibility API not yet implemented");
  }

  const nowMs = Date.now();
  const data = await fetchWalletEligibilityData(walletAddress, token);

  const input: EligibilityInput = {
    walletAddress,
    activity: data.activity,
    vaultEvents: data.vaultEvents,
    targetVaultId,
    nowMs,
  };

  return scoreEligibility(input);
}
