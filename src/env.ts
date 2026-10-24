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

/**
 * Live/mock flag for the vault data layer (issue #276).
 *
 * When `false` (the default) the vault adapter serves mock data and the cache
 * never revalidates against the backend. When `true` the adapter performs real
 * reads and the cache applies the staleness/revalidation policy. Kept as a
 * single derived flag so the read-path cache and the mock→live migration share
 * one source of truth.
 */
export const vaultLiveDataEnabled = parsed.NEXT_PUBLIC_VAULT_LIVE_DATA === "true";

/**
 * Staleness window (ms) for cached NAV reads before a background revalidation
 * is triggered. Configurable so degraded-mode rollouts can widen it without a
 * code change.
 */
export const vaultNavStaleMs = Number(parsed.NEXT_PUBLIC_VAULT_NAV_STALE_MS ?? 30_000);

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
 * Internal service identities that participate in service-to-service auth
 * (issue #289). Each service authenticates with its own short-lived signed
 * token; there are no shared static bearer secrets.
 */
export type InternalServiceName = "bff" | "api" | "indexer" | "scheduler" | "keeper";

/**
 * Narrow scope claims a service token may carry. Handlers verify these
 * explicitly so a compromised service cannot exceed its least-privilege role
 * (e.g. the indexer cannot submit transactions, the keeper cannot read PII).
 */
export type ServiceScope =
  | "tx:submit"
  | "epoch:mutate"
  | "index:read"
  | "pii:read"
  | "notify:send";

/**
 * Frontend-visible subset of the service-auth configuration (issue #289).
 *
 * Only non-secret values are surfaced here. Signing keys and managed-store
 * references are read server-side from the managed secret store and are never
 * inlined into this module or checked into config.
 */
export const serviceAuthConfig = {
  /** Whether mTLS is required for internal calls (disabled only in local dev). */
  requireMtls: env.NODE_ENV === "production",
  /**
   * Dev bypass for mTLS. Hard-disabled in production so it can never be
   * enabled there, even if the env var is set.
   */
  allowDevBypass: env.NODE_ENV !== "production",
  /** Clock-skew tolerance (seconds) applied when validating token expiry. */
  clockSkewSeconds: 60,
  /** Maximum lifetime (seconds) of a short-lived service token. */
  maxTokenTtlSeconds: 300,
} as const;

/**
 * Least-privilege scope grants per internal service (issue #289).
 *
 * The indexer is read-only and cannot submit transactions; the keeper can
 * mutate epoch state but cannot read depositor PII it does not need.
 */
export const serviceScopeGrants: Record<InternalServiceName, readonly ServiceScope[]> = {
  bff: ["index:read", "notify:send"],
  api: ["index:read", "tx:submit", "pii:read"],
  indexer: ["index:read"],
  scheduler: ["epoch:mutate"],
  keeper: ["epoch:mutate"],
};

/**
 * Egress allowlist (issue #289): the only outbound destinations internal
 * services may reach. Denied outbound calls are logged and alerted.
 */
export const egressAllowlist: readonly string[] = [
  "soroban-testnet.stellar.org",
  "soroban.stellar.org",
  "horizon-testnet.stellar.org",
  "horizon.stellar.org",
] as const;

/**
 * Validate the frontend-visible service-auth subset (issue #289).
 *
 * Production must fail to boot when a required service credential reference
 * is missing or still a placeholder. Returns the list of problems so callers
 * can surface them via Sentry and abort startup.
 */
export function validateServiceAuthConfig(
  source: Record<string, string | undefined> = process.env,
): string[] {
  const problems: string[] = [];
  if (env.NODE_ENV !== "production") return problems;

  const services: InternalServiceName[] = ["bff", "api", "indexer", "scheduler", "keeper"];
  for (const service of services) {
    const ref = source[`SERVICE_CREDENTIAL_REF_${service.toUpperCase()}`];
    if (!ref) {
      problems.push(`Missing managed-store reference for service credential: ${service}`);
    } else if (/placeholder|changeme|example/i.test(ref)) {
      problems.push(`Placeholder service credential reference rejected: ${service}`);
    }
  }
  return problems;
}
