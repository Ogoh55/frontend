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
  // Shared realtime feed endpoint (issue #271). The spot/vol feed and the vault
  // NAV/epoch/queue topics are published on this single WebSocket connection.
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  // Non-secret signer configuration (issue #269). These select *which* KMS/HSM
  // key a role uses and where the signing service lives — never key material.
  SIGNER_SERVICE_URL: process.env.SIGNER_SERVICE_URL,
  SIGNER_KMS_PROVIDER: process.env.SIGNER_KMS_PROVIDER,
  SIGNER_KMS_REGION: process.env.SIGNER_KMS_REGION,
  SIGNER_KEY_ADMIN: process.env.SIGNER_KEY_ADMIN,
  SIGNER_KEY_PARAMETER: process.env.SIGNER_KEY_PARAMETER,
  SIGNER_KEY_ORACLE: process.env.SIGNER_KEY_ORACLE,
  SIGNER_KEY_PAUSE: process.env.SIGNER_KEY_PAUSE,
  SIGNER_KEY_TREASURY: process.env.SIGNER_KEY_TREASURY,
  SIGNER_LOCAL_SOFTWARE_KEY: process.env.SIGNER_LOCAL_SOFTWARE_KEY,
});

export const env = {
  ...parsed,
  NEXT_PUBLIC_API_URL: parsed.NEXT_PUBLIC_API_URL ?? "http://localhost:8081",
  NEXT_PUBLIC_STELLAR_NETWORK: parsed.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet",
  NEXT_PUBLIC_APP_VERSION: parsed.NEXT_PUBLIC_APP_VERSION ?? "0.1.0",
  NEXT_PUBLIC_BUILD_SHA: parsed.NEXT_PUBLIC_BUILD_SHA ?? "local",
};

/**
 * WebSocket URL for the shared realtime feed (issue #271).
 *
 * Defaults to the API host with the `ws`/`wss` scheme so the spot/vol feed and
 * vault topics share one connection without extra configuration.
 */
export const wsUrl: string =
  parsed.NEXT_PUBLIC_WS_URL ??
  env.NEXT_PUBLIC_API_URL.replace(/^http/, "ws");

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
 * Privileged signing roles (issue #269). Each role maps to a distinct KMS/HSM
 * key so it can be rotated or revoked independently of the others.
 */
export type SignerRole = "admin" | "parameter" | "oracle" | "pause" | "treasury";

/**
 * Non-secret signer configuration for the KMS/HSM-backed signing service.
 *
 * Only key *identifiers* and service endpoints live here — never key material.
 * Privileged secrets must never be readable by application code, present in the
 * repository, CI variables, or container images. The signing service resolves
 * each role's key reference inside the managed KMS/HSM.
 */
export const signerConfig = {
  /** Base URL of the constrained signing service (BFF). */
  serviceUrl: parsed.SIGNER_SERVICE_URL ?? "http://localhost:8082",
  /** Managed key store backing the signer: "aws-kms" | "gcp-kms" | "hsm" | "local". */
  kmsProvider: parsed.SIGNER_KMS_PROVIDER ?? "local",
  /** Region of the primary key store, used for disaster-recovery routing. */
  kmsRegion: parsed.SIGNER_KMS_REGION,
  /**
   * Per-role key references. These are opaque identifiers (e.g. a KMS key ARN
   * or alias), not secrets. A role with no configured key cannot sign.
   */
  keyRefs: {
    admin: parsed.SIGNER_KEY_ADMIN,
    parameter: parsed.SIGNER_KEY_PARAMETER,
    oracle: parsed.SIGNER_KEY_ORACLE,
    pause: parsed.SIGNER_KEY_PAUSE,
    treasury: parsed.SIGNER_KEY_TREASURY,
  } as Record<SignerRole, string | undefined>,
  /**
   * Local development only: opt into the clearly-labeled software key path so
   * contributors are not blocked. Never enable outside local development.
   */
  localSoftwareKey: parsed.SIGNER_LOCAL_SOFTWARE_KEY === "true",
} as const;

/**
 * Whether the signer is running on the local software key path. Guarded so the
 * software path can never be selected in production.
 */
export const signerUsesLocalSoftwareKey =
  signerConfig.kmsProvider === "local" &&
  signerConfig.localSoftwareKey &&
  env.NODE_ENV !== "production";

/**
 * Resolve the non-secret key reference for a signing role, or `undefined` when
 * the role is unconfigured (and therefore cannot sign).
 */
export function signerKeyRefForRole(role: SignerRole): string | undefined {
  return signerConfig.keyRefs[role];
}
