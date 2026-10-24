import { parseEnv } from "./env-schema.cjs";

const parsed = parseEnv({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
  NEXT_PUBLIC_STELLAR_TESTNET_CONTRACT_ID: process.env.NEXT_PUBLIC_STELLAR_TESTNET_CONTRACT_ID,
  NEXT_PUBLIC_STELLAR_MAINNET_CONTRACT_ID: process.env.NEXT_PUBLIC_STELLAR_MAINNET_CONTRACT_ID,
  NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
  NEXT_PUBLIC_BUILD_SHA: process.env.NEXT_PUBLIC_BUILD_SHA,
  NEXT_PUBLIC_VAULTS: process.env.NEXT_PUBLIC_VAULTS,
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
  VAULT_RATE_LIMIT_READ_PER_WALLET: process.env.VAULT_RATE_LIMIT_READ_PER_WALLET,
  VAULT_RATE_LIMIT_READ_PER_IP: process.env.VAULT_RATE_LIMIT_READ_PER_IP,
  VAULT_RATE_LIMIT_WRITE_PER_WALLET: process.env.VAULT_RATE_LIMIT_WRITE_PER_WALLET,
  VAULT_RATE_LIMIT_WRITE_PER_IP: process.env.VAULT_RATE_LIMIT_WRITE_PER_IP,
  VAULT_RATE_LIMIT_WINDOW_SECONDS: process.env.VAULT_RATE_LIMIT_WINDOW_SECONDS,
  NEXT_PUBLIC_ANCHOR_TESTNET_URL: process.env.NEXT_PUBLIC_ANCHOR_TESTNET_URL,
  NEXT_PUBLIC_ANCHOR_MAINNET_URL: process.env.NEXT_PUBLIC_ANCHOR_MAINNET_URL,
  NEXT_PUBLIC_ANCHOR_TESTNET_ASSETS: process.env.NEXT_PUBLIC_ANCHOR_TESTNET_ASSETS,
  NEXT_PUBLIC_ANCHOR_MAINNET_ASSETS: process.env.NEXT_PUBLIC_ANCHOR_MAINNET_ASSETS,
  NEXT_PUBLIC_STATUS_PAGE_URL: process.env.NEXT_PUBLIC_STATUS_PAGE_URL,
  NEXT_PUBLIC_INCIDENT_FEED_URL: process.env.NEXT_PUBLIC_INCIDENT_FEED_URL,
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
  OTEL_TRACES_SAMPLER: process.env.OTEL_TRACES_SAMPLER,
  OTEL_TRACES_SAMPLER_ARG: process.env.OTEL_TRACES_SAMPLER_ARG,
  SOROBAN_RPC_URLS: process.env.SOROBAN_RPC_URLS,
  SOROBAN_RPC_MAX_CONCURRENCY: process.env.SOROBAN_RPC_MAX_CONCURRENCY,
  SOROBAN_RPC_MAX_ATTEMPTS: process.env.SOROBAN_RPC_MAX_ATTEMPTS,
  SOROBAN_RPC_BASE_BACKOFF_MS: process.env.SOROBAN_RPC_BASE_BACKOFF_MS,
  SOROBAN_RPC_CONFIRMATION_TIMEOUT_MS: process.env.SOROBAN_RPC_CONFIRMATION_TIMEOUT_MS,
});

export const env = {
  ...parsed,
  NEXT_PUBLIC_API_URL: parsed.NEXT_PUBLIC_API_URL ?? "http://localhost:8081",
  NEXT_PUBLIC_STELLAR_NETWORK: parsed.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet",
  NEXT_PUBLIC_APP_VERSION: parsed.NEXT_PUBLIC_APP_VERSION ?? "0.1.0",
  NEXT_PUBLIC_BUILD_SHA: parsed.NEXT_PUBLIC_BUILD_SHA ?? "local",
  NEXT_PUBLIC_VAULTS: parsed.NEXT_PUBLIC_VAULTS ?? "mock",
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
 * Vault API abuse-protection limits (issue #220).
 *
 * Per-environment configurable so staging can be relaxed while production
 * stays strict. Limits are enforced per-wallet first (primary identity) with
 * IP as a secondary dimension so shared NAT egress does not lock out
 * legitimate users. Window is the sliding window length in seconds.
 */
export type VaultRateLimitConfig = {
  /** Max read requests per wallet per window. */
  readPerWallet: number;
  /** Max read requests per IP per window (secondary dimension). */
  readPerIp: number;
  /** Max state-changing requests per wallet per window. */
  writePerWallet: number;
  /** Max state-changing requests per IP per window (secondary dimension). */
  writePerIp: number;
  /** Sliding window length in seconds. */
  windowSeconds: number;
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const isProduction = env.NODE_ENV === "production";

/**
 * Documented vault rate limits. Defaults are strict in production and relaxed
 * elsewhere; every value can be overridden per environment via env vars.
 */
export const vaultRateLimits: VaultRateLimitConfig = {
  readPerWallet: positiveInt(parsed.VAULT_RATE_LIMIT_READ_PER_WALLET, isProduction ? 60 : 600),
  readPerIp: positiveInt(parsed.VAULT_RATE_LIMIT_READ_PER_IP, isProduction ? 120 : 1200),
  writePerWallet: positiveInt(parsed.VAULT_RATE_LIMIT_WRITE_PER_WALLET, isProduction ? 10 : 100),
  writePerIp: positiveInt(parsed.VAULT_RATE_LIMIT_WRITE_PER_IP, isProduction ? 30 : 300),
  windowSeconds: positiveInt(parsed.VAULT_RATE_LIMIT_WINDOW_SECONDS, 60),
};

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

/**
 * Per-network anchor configuration for fiat on-ramp/off-ramp (issue #265).
 *
 * The anchor base URL is public (the interactive URL is minted server-side by
 * the BFF proxy), but anchor credentials stay server-side. `assets` is a
 * comma-separated list of asset codes the anchor supports for SEP-24; when
 * empty the "Fund from bank" / "Cash out" entry points are hidden.
 */
const anchorConfigByNetwork = {
  TESTNET: {
    baseUrl: parsed.NEXT_PUBLIC_ANCHOR_TESTNET_URL,
    assets: parsed.NEXT_PUBLIC_ANCHOR_TESTNET_ASSETS,
  },
  MAINNET: {
    baseUrl: parsed.NEXT_PUBLIC_ANCHOR_MAINNET_URL,
    assets: parsed.NEXT_PUBLIC_ANCHOR_MAINNET_ASSETS,
  },
} as const;

export interface AnchorConfig {
  /** Anchor base URL, or undefined when no anchor is configured. */
  baseUrl?: string;
  /** Asset codes the anchor supports for SEP-24 deposit/withdraw. */
  assets: string[];
}

function parseAnchorAssets(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);
}

const activeAnchor = anchorConfigByNetwork[stellarNetworkSuffix];

/** Anchor config for the active network; `baseUrl` is undefined when unset. */
export const anchorConfig: AnchorConfig = {
  baseUrl: activeAnchor.baseUrl?.trim() || undefined,
  assets: parseAnchorAssets(activeAnchor.assets),
};

/**
 * Whether an anchor is configured for `assetCode` on the active network.
 * Used to progressively enhance the deposit/redemption flows.
 */
export function isAnchorSupported(assetCode: string | undefined): boolean {
  if (!anchorConfig.baseUrl || !assetCode) return false;
  return anchorConfig.assets.includes(assetCode.trim().toUpperCase());
}

/**
 * Public status page + incident feed configuration (issue #268).
 *
 * The status page is hosted separately from the trading app so a bad frontend
 * deploy cannot take down the page that reports the outage. The incident feed
 * is a public, read-only JSON endpoint consumed by the in-app banner; both are
 * optional so the app degrades gracefully when they are not configured.
 */
export interface StatusPageConfig {
  /** Public status page URL, or undefined when not configured. */
  statusPageUrl?: string;
  /** Public incident feed URL, or undefined when not configured. */
  incidentFeedUrl?: string;
}

export const statusPageConfig: StatusPageConfig = {
  statusPageUrl: parsed.NEXT_PUBLIC_STATUS_PAGE_URL?.trim() || undefined,
  incidentFeedUrl: parsed.NEXT_PUBLIC_INCIDENT_FEED_URL?.trim() || undefined,
};

/** Whether a public status page is configured for the active deployment. */
export function isStatusPageConfigured(): boolean {
  return Boolean(statusPageConfig.statusPageUrl);
}


/**
 * Distributed tracing configuration (issue #299).
 *
 * Traces are exported to the existing observability backend via OTLP. The
 * sampler is parent-based with a ratio so that error traces are never dropped:
 * the tail-sampling guarantee is enforced by the collector, while the head
 * sampler here keeps the hot read path cheap. `OTEL_TRACES_SAMPLER_ARG` is the
 * ratio for non-error spans; error spans are always recorded.
 */
export const tracingConfig = {
  /** OTLP collector endpoint; unset disables export (spans still created locally). */
  exporterEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
  /** Service name reported to the trace backend. */
  serviceName: parsed.OTEL_SERVICE_NAME ?? "vault-frontend",
  /** Head sampler strategy; defaults to parent-based ratio sampling. */
  sampler: parsed.OTEL_TRACES_SAMPLER ?? "parentbased_traceidratio",
  /** Ratio for non-error spans (0–1). Error traces are always sampled. */
  samplerArg: Number.parseFloat(parsed.OTEL_TRACES_SAMPLER_ARG ?? "0.1"),
  /** Header carrying the correlation ID across BFF → backend → indexer hops. */
  correlationHeader: "x-correlation-id",
  /** Maximum accepted length of an inbound correlation ID (bytes). */
  maxCorrelationIdLength: 128,
} as const;

/**
 * Soroban RPC resilience configuration (issue #282).
 *
 * `SOROBAN_RPC_URLS` is a comma-separated list of RPC endpoints used by the
 * server-side provider pool. When unset, the active network's default RPC URL
 * is used as a single-provider pool. Production builds fail fast when the list
 * is missing so a misconfigured deploy never silently degrades to one provider.
 */
export type SorobanRpcConfig = {
  /** Ordered list of RPC endpoints; the first healthy provider is preferred. */
  urls: string[];
  /** Bounded concurrency for batched/parallel reads. */
  maxConcurrency: number;
  /** Bounded retry attempts per read (never applied to signed submissions). */
  maxAttempts: number;
  /** Base delay for exponential backoff with jitter, in milliseconds. */
  baseBackoffMs: number;
  /** How long to wait for ledger inclusion before returning `pending`. */
  confirmationTimeoutMs: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, received "${raw}"`);
  }
  return value;
}

function parseRpcUrls(raw: string | undefined, fallback: string): string[] {
  const source = raw === undefined || raw.trim() === "" ? fallback : raw;
  const urls = source
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  if (urls.length === 0) {
    throw new Error("SOROBAN_RPC_URLS must contain at least one RPC endpoint");
  }
  for (const url of urls) {
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      throw new Error(`Invalid SOROBAN_RPC_URLS entry: "${url}" is not a valid URL`);
    }
  }
  return urls;
}

if (isProduction && (parsed.SOROBAN_RPC_URLS === undefined || parsed.SOROBAN_RPC_URLS.trim() === "")) {
  throw new Error(
    "SOROBAN_RPC_URLS is required in production: configure a comma-separated list of Soroban RPC endpoints",
  );
}

export const sorobanRpcConfig: SorobanRpcConfig = {
  urls: parseRpcUrls(parsed.SOROBAN_RPC_URLS, activeStellarNetwork.rpcUrl),
  maxConcurrency: parsePositiveInt(parsed.SOROBAN_RPC_MAX_CONCURRENCY, 4, "SOROBAN_RPC_MAX_CONCURRENCY"),
  maxAttempts: parsePositiveInt(parsed.SOROBAN_RPC_MAX_ATTEMPTS, 3, "SOROBAN_RPC_MAX_ATTEMPTS"),
  baseBackoffMs: parsePositiveInt(parsed.SOROBAN_RPC_BASE_BACKOFF_MS, 200, "SOROBAN_RPC_BASE_BACKOFF_MS"),
  confirmationTimeoutMs: parsePositiveInt(
    parsed.SOROBAN_RPC_CONFIRMATION_TIMEOUT_MS,
    15_000,
    "SOROBAN_RPC_CONFIRMATION_TIMEOUT_MS",
  ),
};

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
