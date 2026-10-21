import { parseEnv } from "./env-schema.cjs";

const parsed = parseEnv({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
  NEXT_PUBLIC_STELLAR_TESTNET_CONTRACT_ID: process.env.NEXT_PUBLIC_STELLAR_TESTNET_CONTRACT_ID,
  NEXT_PUBLIC_STELLAR_MAINNET_CONTRACT_ID: process.env.NEXT_PUBLIC_STELLAR_MAINNET_CONTRACT_ID,
  NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
  NEXT_PUBLIC_BUILD_SHA: process.env.NEXT_PUBLIC_BUILD_SHA,
  NEXT_PUBLIC_CONTRACT_GOVERNOR_TESTNET: process.env.NEXT_PUBLIC_CONTRACT_GOVERNOR_TESTNET,
  NEXT_PUBLIC_CONTRACT_GOVERNOR_MAINNET: process.env.NEXT_PUBLIC_CONTRACT_GOVERNOR_MAINNET,
  NEXT_PUBLIC_CONTRACT_MARKET_TESTNET: process.env.NEXT_PUBLIC_CONTRACT_MARKET_TESTNET,
  NEXT_PUBLIC_CONTRACT_MARKET_MAINNET: process.env.NEXT_PUBLIC_CONTRACT_MARKET_MAINNET,
  NEXT_PUBLIC_CONTRACT_VAULT_TESTNET: process.env.NEXT_PUBLIC_CONTRACT_VAULT_TESTNET,
  NEXT_PUBLIC_CONTRACT_VAULT_MAINNET: process.env.NEXT_PUBLIC_CONTRACT_VAULT_MAINNET,
  NEXT_PUBLIC_CONTRACT_ORACLE_TESTNET: process.env.NEXT_PUBLIC_CONTRACT_ORACLE_TESTNET,
  NEXT_PUBLIC_CONTRACT_ORACLE_MAINNET: process.env.NEXT_PUBLIC_CONTRACT_ORACLE_MAINNET,
  NEXT_PUBLIC_CONTRACT_TIMELOCK_TESTNET: process.env.NEXT_PUBLIC_CONTRACT_TIMELOCK_TESTNET,
  NEXT_PUBLIC_CONTRACT_TIMELOCK_MAINNET: process.env.NEXT_PUBLIC_CONTRACT_TIMELOCK_MAINNET,
  NEXT_PUBLIC_CONTRACT_DEPLOYER_TESTNET: process.env.NEXT_PUBLIC_CONTRACT_DEPLOYER_TESTNET,
  NEXT_PUBLIC_CONTRACT_DEPLOYER_MAINNET: process.env.NEXT_PUBLIC_CONTRACT_DEPLOYER_MAINNET,
});

export const env = {
  ...parsed,
  NEXT_PUBLIC_API_URL: parsed.NEXT_PUBLIC_API_URL ?? "http://localhost:8081",
  NEXT_PUBLIC_STELLAR_NETWORK: parsed.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet",
  NEXT_PUBLIC_APP_VERSION: parsed.NEXT_PUBLIC_APP_VERSION ?? "0.1.0",
  NEXT_PUBLIC_BUILD_SHA: parsed.NEXT_PUBLIC_BUILD_SHA ?? "local",
};

export const stellarNetworkConfig = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
    contractId: parsed.NEXT_PUBLIC_STELLAR_TESTNET_CONTRACT_ID,
  },
  mainnet: {
    rpcUrl: "https://soroban.stellar.org",
    passphrase: "Public Global Stellar Network ; September 2015",
    contractId: parsed.NEXT_PUBLIC_STELLAR_MAINNET_CONTRACT_ID,
  },
} as const;

export const activeStellarNetwork = stellarNetworkConfig[env.NEXT_PUBLIC_STELLAR_NETWORK];

/** Uppercase network suffix used to select a per-network contract ID. */
export const stellarNetworkSuffix = env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet" ? "MAINNET" : "TESTNET";

/** Contract key → configured contract ID, or undefined when not deployed. */
export type GovernableContractKey =
  | "governor"
  | "market"
  | "vault"
  | "oracle"
  | "timelock"
  | "deployer";

/**
 * Governable contract IDs for the active network (issue #89).
 *
 * Unset entries are `undefined` rather than empty strings: the proposal wizard
 * refuses to submit an action whose contract is unconfigured instead of
 * targeting a zero address.
 */
const governableIdByNetwork = {
  TESTNET: {
    governor: parsed.NEXT_PUBLIC_CONTRACT_GOVERNOR_TESTNET,
    market: parsed.NEXT_PUBLIC_CONTRACT_MARKET_TESTNET,
    vault: parsed.NEXT_PUBLIC_CONTRACT_VAULT_TESTNET,
    oracle: parsed.NEXT_PUBLIC_CONTRACT_ORACLE_TESTNET,
    timelock: parsed.NEXT_PUBLIC_CONTRACT_TIMELOCK_TESTNET,
    deployer: parsed.NEXT_PUBLIC_CONTRACT_DEPLOYER_TESTNET,
  },
  MAINNET: {
    governor: parsed.NEXT_PUBLIC_CONTRACT_GOVERNOR_MAINNET,
    market: parsed.NEXT_PUBLIC_CONTRACT_MARKET_MAINNET,
    vault: parsed.NEXT_PUBLIC_CONTRACT_VAULT_MAINNET,
    oracle: parsed.NEXT_PUBLIC_CONTRACT_ORACLE_MAINNET,
    timelock: parsed.NEXT_PUBLIC_CONTRACT_TIMELOCK_MAINNET,
    deployer: parsed.NEXT_PUBLIC_CONTRACT_DEPLOYER_MAINNET,
  },
} as const;

export const governableContractIds: Partial<Record<GovernableContractKey, string>> =
  governableIdByNetwork[stellarNetworkSuffix];

/** The governor that `submit_proposal` is sent to. */
export const governorContractId = governableContractIds.governor;

/** Env var a user would set to configure `key` on the active network. */
export function contractEnvVarName(key: string): string {
  return `NEXT_PUBLIC_CONTRACT_${key.toUpperCase()}_${stellarNetworkSuffix}`;
}

/**
 * Verified-build registry entry for a deployed contract (issue #264).
 *
 * Mirrors the versioned machine-readable registry consumed by the SDK and
 * docs. `verified` is false while a freshly deployed revision is pending
 * audit sign-off — such entries must be surfaced as unverified, never
 * silently trusted.
 */
export interface VerifiedContractEntry {
  /** Canonical on-chain contract ID (Strkey `C...`). */
  contractId: string;
  /** Hex-encoded SHA-256 of the reproducible WASM build. */
  wasmHash: string;
  /** Audited source revision (git SHA) the WASM was built from. */
  auditRevision: string;
  /** Whether the audit sign-off has been recorded for this revision. */
  verified: boolean;
}

/**
 * Registry lookup for the active network's vault contract.
 *
 * Returns `undefined` when no vault contract is configured. When a contract ID
 * is configured but has no matching verified registry entry, the returned
 * entry is marked `verified: false` so consumers can visibly flag it.
 */
export function getVaultRegistryEntry(
  registry: Partial<Record<"testnet" | "mainnet", VerifiedContractEntry[]>>,
): VerifiedContractEntry | undefined {
  const contractId = governableContractIds.vault;
  if (!contractId) return undefined;
  const network = env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const entries = registry[network] ?? [];
  const match = entries.find((entry) => entry.contractId === contractId);
  if (match) return match;
  return { contractId, wasmHash: "", auditRevision: "", verified: false };
}
