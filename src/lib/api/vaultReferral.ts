/**
 * Vault Referral & Loyalty Rewards — typed API client
 *
 * Backend contract (for when the real API lands):
 *
 *   POST /api/v1/vaults/referral/code
 *     body: { vault_id?: string }          ← optional vault-scoped code
 *     → VaultReferralCode
 *
 *   GET  /api/v1/vaults/referral/status
 *     → VaultReferralStatus
 *
 *   POST /api/v1/vaults/referral/attribution
 *     body: { referral_code: string; vault_id: string }
 *     → { registered: boolean; message: string }
 *
 *   GET  /api/v1/vaults/referral/accruals?vault_id=&epoch=
 *     → VaultLoyaltyAccrual[]
 *
 *   GET  /api/v1/vaults/referral/merkle-proof?vault_id=&epoch=&wallet=
 *     → VaultMerkleProofResponse
 *
 *   POST /api/v1/vaults/referral/claim
 *     body: { vault_id: string; epoch: number; proof: string[]; amount: string }
 *     → VaultClaimResult
 *
 * Until the backend ships these endpoints, a mock implementation is used
 * when NEXT_PUBLIC_VAULTS !== "live".
 */

import {
  generateReferralCode,
  buildReferralLink,
  loyaltyMultiplier,
  TIER_LABELS,
  EPOCHS_PER_TIER,
  BASE_REWARD_RATE,
  REFERRAL_COMMISSION_RATE,
  buildMerkleTree,
  generateMerkleProof,
  type MerkleLeaf,
  type MerkleProof,
} from "../vaultReferral";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** A vault-program referral code record. */
export interface VaultReferralCode {
  code: string;
  walletAddress: string;
  createdAt: string;   // ISO-8601
  link: string;
  /** Total referees who have funded deposits attributed to this code. */
  totalReferees: number;
  /** Total USD volume of funded referred deposits. */
  totalReferredVolumeUsd: number;
}

/** Per-epoch accrual entry for the connected wallet. */
export interface VaultLoyaltyAccrual {
  vaultId: string;
  epochNumber: number;
  sharesHeld: number;
  loyaltyTier: number;
  loyaltyTierLabel: string;
  loyaltyMultiplier: number;
  baseReward: number;
  referralCommission: number;
  totalReward: number;
  claimable: boolean;
  claimed: boolean;
  claimedAt: string | null;
  claimTxHash: string | null;
}

/** Aggregated referral & loyalty status for the connected wallet. */
export interface VaultReferralStatus {
  referralCode: VaultReferralCode;
  /** Total rewards accrued (claimed + unclaimed). */
  totalAccruedReward: number;
  /** Rewards not yet claimed. */
  claimableReward: number;
  /** Rewards already claimed. */
  claimedReward: number;
  /** Per-vault loyalty state. */
  vaultLoyalty: VaultLoyaltyState[];
  /** Epoch-by-epoch accrual history (most recent first). */
  recentAccruals: VaultLoyaltyAccrual[];
}

/** Loyalty state for a single vault. */
export interface VaultLoyaltyState {
  vaultId: string;
  vaultName: string;
  consecutiveEpochs: number;
  tier: number;
  tierLabel: string;
  epochsToNextTier: number;
  currentMultiplier: number;
}

/** Merkle proof response for a single claimable epoch. */
export interface VaultMerkleProofResponse {
  proof: MerkleProof;
  alreadyClaimed: boolean;
}

/** Result of a successful claim. */
export interface VaultClaimResult {
  txHash: string;
  amount: string;
  claimedAt: string;
  epochNumber: number;
  vaultId: string;
}

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

function makeMockAccruals(
  walletAddress: string,
  vaultId: string,
  epochCount = 4,
): VaultLoyaltyAccrual[] {
  const accruals: VaultLoyaltyAccrual[] = [];
  for (let i = epochCount; i >= 1; i--) {
    const epochNumber = 47 - (epochCount - i);
    const consecutiveEpochs = i;
    const tier = Math.min(3, Math.floor(consecutiveEpochs / EPOCHS_PER_TIER));
    const multiplier = loyaltyMultiplier(consecutiveEpochs);
    const sharesHeld = 950;
    const baseReward = parseFloat((sharesHeld * BASE_REWARD_RATE * multiplier).toFixed(6));
    const referralCommission = i === epochCount ? parseFloat((baseReward * 0.5 * REFERRAL_COMMISSION_RATE).toFixed(6)) : 0;
    const totalReward = baseReward + referralCommission;
    const claimed = i < epochCount;
    accruals.push({
      vaultId,
      epochNumber,
      sharesHeld,
      loyaltyTier: tier,
      loyaltyTierLabel: TIER_LABELS[tier] ?? "Bronze",
      loyaltyMultiplier: multiplier,
      baseReward,
      referralCommission,
      totalReward,
      claimable: !claimed,
      claimed,
      claimedAt: claimed ? new Date(Date.now() - (epochCount - i) * 7 * 86400_000).toISOString() : null,
      claimTxHash: claimed ? `mock-claim-tx-${walletAddress.slice(0, 6)}-${epochNumber}` : null,
    });
  }
  return accruals;
}

function makeMockVaultLoyalty(vaultId: string, vaultName: string, consecutiveEpochs: number): VaultLoyaltyState {
  const tier = Math.min(3, Math.floor(consecutiveEpochs / EPOCHS_PER_TIER));
  const epochsToNextTier =
    tier >= 3 ? 0 : EPOCHS_PER_TIER - (consecutiveEpochs % EPOCHS_PER_TIER);
  return {
    vaultId,
    vaultName,
    consecutiveEpochs,
    tier,
    tierLabel: TIER_LABELS[tier] ?? "Bronze",
    epochsToNextTier,
    currentMultiplier: loyaltyMultiplier(consecutiveEpochs),
  };
}

// Simulate already-claimed leaves for the mock merkle tree
function makeMockLeaves(walletAddress: string, vaultId: string): MerkleLeaf[] {
  return [
    { walletAddress, vaultId, epochNumber: 44, amount: "4750000" },
    { walletAddress, vaultId, epochNumber: 45, amount: "4987500" },
    { walletAddress: "GBXXXXMOCKOTHER1", vaultId, epochNumber: 44, amount: "2100000" },
    { walletAddress: "GBXXXXMOCKOTHER2", vaultId, epochNumber: 45, amount: "1800000" },
  ];
}

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

async function mockGetVaultReferralCode(walletAddress: string): Promise<VaultReferralCode> {
  await new Promise(r => setTimeout(r, 300));
  const code = generateReferralCode(walletAddress);
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  return {
    code,
    walletAddress,
    createdAt: new Date(Date.now() - 14 * 86400_000).toISOString(),
    link: buildReferralLink(origin, code),
    totalReferees: 3,
    totalReferredVolumeUsd: 12_450,
  };
}

async function mockGetVaultReferralStatus(walletAddress: string): Promise<VaultReferralStatus> {
  await new Promise(r => setTimeout(r, 400));
  const referralCode = await mockGetVaultReferralCode(walletAddress);
  const accruals = makeMockAccruals(walletAddress, "xlm-cc-v1", 4);
  const totalAccruedReward = accruals.reduce((s, a) => s + a.totalReward, 0);
  const claimableReward = accruals.filter(a => a.claimable).reduce((s, a) => s + a.totalReward, 0);
  const claimedReward   = accruals.filter(a => a.claimed).reduce((s, a) => s + a.totalReward, 0);
  return {
    referralCode,
    totalAccruedReward: parseFloat(totalAccruedReward.toFixed(6)),
    claimableReward: parseFloat(claimableReward.toFixed(6)),
    claimedReward: parseFloat(claimedReward.toFixed(6)),
    vaultLoyalty: [
      makeMockVaultLoyalty("xlm-cc-v1",  "XLM Covered Call",     4),
      makeMockVaultLoyalty("btc-csp-v1", "BTC Cash-Secured Put",  1),
    ],
    recentAccruals: accruals,
  };
}

async function mockRegisterVaultAttribution(
  referralCode: string,
  vaultId: string,
  _token: string,
): Promise<{ registered: boolean; message: string }> {
  await new Promise(r => setTimeout(r, 200));
  // Mock: always succeed unless code looks invalid
  if (!/^[A-Z0-9]{8,32}$/.test(referralCode)) {
    return { registered: false, message: "Invalid referral code format." };
  }
  return { registered: true, message: "Attribution registered." };
}

async function mockGetVaultMerkleProof(
  walletAddress: string,
  vaultId: string,
  epochNumber: number,
): Promise<VaultMerkleProofResponse> {
  await new Promise(r => setTimeout(r, 250));
  const allLeaves = makeMockLeaves(walletAddress, vaultId);
  const targetLeaf = allLeaves.find(
    l => l.walletAddress === walletAddress && l.epochNumber === epochNumber,
  );
  if (!targetLeaf) {
    throw new Error(`No claimable reward found for epoch ${epochNumber} in vault ${vaultId}.`);
  }
  const proof = generateMerkleProof(targetLeaf, allLeaves);
  if (!proof) {
    throw new Error("Failed to generate merkle proof.");
  }
  return { proof, alreadyClaimed: epochNumber < 46 };
}

async function mockClaimVaultReward(
  walletAddress: string,
  vaultId: string,
  epochNumber: number,
  _proof: string[],
  amount: string,
  _token: string,
): Promise<VaultClaimResult> {
  await new Promise(r => setTimeout(r, 600));
  return {
    txHash: `mock-vault-claim-${walletAddress.slice(0, 8)}-${vaultId}-${epochNumber}-${Date.now()}`,
    amount,
    claimedAt: new Date().toISOString(),
    epochNumber,
    vaultId,
  };
}

// ---------------------------------------------------------------------------
// Public adapter — swaps mock ↔ live based on NEXT_PUBLIC_VAULTS
// ---------------------------------------------------------------------------

/**
 * Fetch or lazily create the vault referral code for the authenticated wallet.
 */
export async function getVaultReferralCode(
  walletAddress: string,
  _token?: string | null,
): Promise<VaultReferralCode> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    throw new Error("Live vault referral API not yet implemented.");
  }
  return mockGetVaultReferralCode(walletAddress);
}

/**
 * Fetch the full vault referral & loyalty status for the connected wallet.
 */
export async function getVaultReferralStatus(
  walletAddress: string,
  _token?: string | null,
): Promise<VaultReferralStatus> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    throw new Error("Live vault referral API not yet implemented.");
  }
  return mockGetVaultReferralStatus(walletAddress);
}

/**
 * Register a first-touch vault referral attribution.
 * Called once when a `?ref=` param is present on the vault deposit page.
 * The backend is idempotent and ignores self-referral.
 */
export async function registerVaultAttribution(
  referralCode: string,
  vaultId: string,
  token: string,
): Promise<{ registered: boolean; message: string }> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    throw new Error("Live vault referral API not yet implemented.");
  }
  return mockRegisterVaultAttribution(referralCode, vaultId, token);
}

/**
 * Fetch the merkle proof for a claimable epoch reward.
 */
export async function getVaultMerkleProof(
  walletAddress: string,
  vaultId: string,
  epochNumber: number,
  _token?: string | null,
): Promise<VaultMerkleProofResponse> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    throw new Error("Live vault referral API not yet implemented.");
  }
  return mockGetVaultMerkleProof(walletAddress, vaultId, epochNumber);
}

/**
 * Submit a merkle proof to claim vault rewards on-chain.
 */
export async function claimVaultReward(
  walletAddress: string,
  vaultId: string,
  epochNumber: number,
  proof: string[],
  amount: string,
  token: string,
): Promise<VaultClaimResult> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    throw new Error("Live vault referral API not yet implemented.");
  }
  return mockClaimVaultReward(walletAddress, vaultId, epochNumber, proof, amount, token);
}

/**
 * Fetch per-epoch accrual records for a specific vault and wallet.
 */
export async function getVaultAccruals(
  walletAddress: string,
  vaultId: string,
  _token?: string | null,
): Promise<VaultLoyaltyAccrual[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    throw new Error("Live vault referral API not yet implemented.");
  }
  await new Promise(r => setTimeout(r, 200));
  return makeMockAccruals(walletAddress, vaultId, 4);
}
