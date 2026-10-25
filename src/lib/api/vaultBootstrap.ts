/**
 * @module vaultBootstrap
 *
 * Treasury bootstrap, genesis epoch funding, and minimum-liquidity policy
 * for new option-writing vaults (issue #253).
 *
 * Problem statement
 * -----------------
 * A vault with zero or dust TVL cannot write a meaningful position:
 *   - It cannot cover assignment.
 *   - Its NAV-per-share math is dominated by rounding error.
 *   - The first depositor carries outsized vault-creation risk.
 *
 * Without an explicit bootstrap policy, operators improvise funding, which
 * blurs the line between treasury capital and depositor capital and makes
 * fee/NAV accounting ambiguous from epoch one.
 *
 * Design
 * ------
 * Bootstrap has three distinct phases:
 *
 *   PHASE 1 — TREASURY_SEEDING
 *     The treasury seeds the vault with initial capital. This capital is
 *     tracked separately from depositor capital via `TreasuryContribution`
 *     records so it can be excluded from depositor fee calculations and
 *     unwound cleanly at any point.
 *
 *   PHASE 2 — GENESIS_EPOCH
 *     Epoch zero runs with no strategy execution. It exists purely to:
 *       a) Allow public deposits to reach the minimum funding threshold.
 *       b) Establish the initial NAV-per-share baseline (1.000).
 *       c) Give the operator time to configure strategy parameters before
 *          real capital is at risk.
 *     `advance_epoch` is blocked until `minFundingThresholdUsd` is met.
 *
 *   PHASE 3 — LIVE
 *     The vault begins writing options. Treasury seed is either:
 *       a) Withdrawn (if it was temporary "priming" capital).
 *       b) Retained as a permanent buffer (operator decision).
 *
 * All state is stored per-vault and mutable only via the timelocked operator
 * path. No bootstrap parameters are hardcoded.
 *
 * This module is frontend-only: it defines the types the BFF exposes and
 * the functions that call those endpoints. On-chain enforcement lives in
 * the `zenith-options-vault` contract.
 */

// ---------------------------------------------------------------------------
// Bootstrap phases
// ---------------------------------------------------------------------------

/**
 * Lifecycle phase of a vault's bootstrap process.
 *
 *   treasury_seeding  — vault created; treasury is depositing seed capital.
 *                       Public deposits are accepted but strategy is locked.
 *   genesis_epoch     — seed committed; epoch zero running with no strategy.
 *                       Deposits open; waiting for minFundingThreshold.
 *   threshold_met     — minFundingThreshold reached; operator may advance epoch.
 *   live              — first strategy epoch started; bootstrap complete.
 */
export type BootstrapPhase =
  | "treasury_seeding"
  | "genesis_epoch"
  | "threshold_met"
  | "live";

// ---------------------------------------------------------------------------
// Treasury contribution
// ---------------------------------------------------------------------------

/**
 * One treasury seed deposit into a vault.
 *
 * Treasury contributions are accounted separately from depositor deposits so
 * that:
 *   - Performance fees are not charged on treasury capital.
 *   - NAV-per-share dilution caused by the seed is clearly attributable.
 *   - The seed can be unwound without affecting depositor accounting.
 */
export interface TreasuryContribution {
  /** Client-generated idempotency key. */
  idempotencyKey: string;
  /** Vault this contribution belongs to. */
  vaultId: string;
  /** Stellar address of the treasury account (G…). */
  treasuryAddress: string;
  /** Amount in USD (decimal string, e.g. "50000.00"). */
  amountUsd: string;
  /** Collateral asset code, e.g. "USDC". */
  assetCode: string;
  /** ISO timestamp of the on-chain deposit. */
  depositedAt: string;
  /** Stellar transaction hash. */
  txHash: string;
  /**
   * Withdrawal intent: null while the seed is retained.
   * Set when the operator schedules a seed withdrawal.
   */
  scheduledWithdrawalAt: string | null;
  /** Whether the treasury seed has been fully withdrawn. */
  withdrawn: boolean;
}

// ---------------------------------------------------------------------------
// Bootstrap configuration
// ---------------------------------------------------------------------------

/**
 * Per-vault bootstrap policy. Stored at vault creation and mutable only via
 * the timelocked operator path (`submitParameterChange`).
 *
 * None of these values are hardcoded. Operators set them at vault
 * initialization; the frontend surfaces them so depositors can see the
 * bootstrap terms before committing capital.
 */
export interface VaultBootstrapConfig {
  /**
   * Minimum total TVL (USD) required before the genesis epoch can end
   * and the vault can begin writing options.
   *
   * The BFF's `advance_epoch` route checks this before building the rollover
   * transaction and returns `below_minimum_funding` if unmet.
   */
  minFundingThresholdUsd: number;

  /**
   * Amount of treasury seed capital committed to this vault (USD).
   * Included in TVL but tracked separately for fee/NAV accounting.
   */
  treasurySeedUsd: number;

  /**
   * Whether the treasury seed is temporary (withdrawn after `minFundingThresholdUsd`
   * is met by public deposits) or permanent (retained as an operator buffer).
   */
  seedRetentionPolicy: "temporary" | "permanent";

  /**
   * ISO timestamp after which the genesis epoch is force-closed even if
   * `minFundingThresholdUsd` has not been met, and the vault moves to
   * `winding_down`. Prevents indefinite limbo.
   */
  genesisEpochDeadline: string;

  /**
   * Number of ledgers the BFF waits before retrying a failed genesis epoch
   * rollover (e.g. when the Soroban RPC is congested).
   */
  rolloverRetryWindowLedgers: number;

  /**
   * Initial share price at vault creation (USD). Almost always 1.000000.
   * Stored here so the UI can show depositors what they are buying into
   * before any NAV movement occurs.
   */
  genesisSharePrice: number;
}

// ---------------------------------------------------------------------------
// Bootstrap status (live read from BFF)
// ---------------------------------------------------------------------------

/**
 * Current bootstrap status for a vault. Returned by
 * `GET /api/v1/vaults/{id}/bootstrap`.
 */
export interface VaultBootstrapStatus {
  vaultId: string;
  phase: BootstrapPhase;
  config: VaultBootstrapConfig;
  /** Current TVL including treasury seed (USD). */
  currentTvlUsd: number;
  /** Public (non-treasury) TVL (USD). */
  publicTvlUsd: number;
  /**
   * Funding progress as a fraction 0–1.
   * `currentTvlUsd / config.minFundingThresholdUsd`, capped at 1.
   */
  fundingProgress: number;
  /**
   * Whether the vault can currently advance to the first strategy epoch.
   * True only when phase === "threshold_met" and no blocking conditions exist.
   */
  canAdvanceEpoch: boolean;
  /**
   * Human-readable reason why `canAdvanceEpoch` is false, or null when it
   * is true. Surfaced directly in the operator console.
   */
  blockingReason: string | null;
  /** Treasury contributions recorded for this vault. */
  treasuryContributions: TreasuryContribution[];
  /** ISO timestamp of the last status read. */
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Blocking condition codes (machine-readable)
// ---------------------------------------------------------------------------

/**
 * Structured reason codes returned when `advance_epoch` is blocked during
 * the bootstrap phase.
 *
 *   below_minimum_funding  — TVL has not yet reached minFundingThresholdUsd.
 *   genesis_epoch_active   — The genesis epoch is still running and has not
 *                            been manually advanced by the operator.
 *   treasury_seed_pending  — Treasury seed transaction is still pending
 *                            on-chain confirmation.
 *   vault_paused           — Vault is paused; unpausing requires guardian auth.
 *   deadline_exceeded      — genesisEpochDeadline has passed; vault must be
 *                            wound down rather than promoted.
 */
export type BootstrapBlockingCode =
  | "below_minimum_funding"
  | "genesis_epoch_active"
  | "treasury_seed_pending"
  | "vault_paused"
  | "deadline_exceeded";

export interface BootstrapBlockingCondition {
  code: BootstrapBlockingCode;
  message: string;
  /** For `below_minimum_funding`: how much more is needed in USD. */
  shortfallUsd?: number;
  /** For `deadline_exceeded`: how long ago the deadline passed. */
  deadlineExceededBy?: string;
}

// ---------------------------------------------------------------------------
// API request / response shapes
// ---------------------------------------------------------------------------

/**
 * Request body for `POST /api/v1/vaults/{id}/treasury-seed`.
 *
 * Initiates a treasury seed deposit. The BFF builds a Soroban XDR for
 * the deposit; the treasury signer signs and submits it through the
 * standard vault signing flow (see `vault.ts` / `vaultWalletAdapter.ts`).
 */
export interface TreasurySeedRequest {
  /** Client-generated idempotency key. */
  idempotencyKey: string;
  /** Amount in USD to seed. */
  amountUsd: number;
  /** Collateral asset code (must match the vault's declared collateral). */
  assetCode: string;
  /** Treasury wallet address — must be authorized in `SIGNER_KEY_TREASURY`. */
  treasuryAddress: string;
}

export interface TreasurySeedResponse {
  /** XDR to be signed by the treasury wallet. */
  xdr: string;
  /** Idempotency key echoed back. */
  idempotencyKey: string;
  /** Projected TVL after this seed (USD). */
  projectedTvlUsd: number;
  /** Whether this seed alone meets the minimum funding threshold. */
  meetsThreshold: boolean;
}

/**
 * Request body for `POST /api/v1/vaults/{id}/advance-genesis`.
 *
 * Advances the vault from genesis epoch to the first live epoch.
 * Blocked if any `BootstrapBlockingCondition` is active.
 */
export interface AdvanceGenesisRequest {
  /** Operator idempotency key. */
  idempotencyKey: string;
  /**
   * Explicit operator acknowledgement that public deposits will be at risk
   * from the next epoch onward.
   */
  operatorAck: true;
}

export interface AdvanceGenesisResponse {
  /** New epoch number (always 1 for the first live epoch). */
  epochNumber: number;
  /** XDR to be signed by the operator key. */
  xdr: string;
  /** Projected share price at epoch start (should equal genesisSharePrice). */
  sharePrice: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Computes the funding progress fraction for display.
 *
 * Always returns a value in [0, 1]; caps at 1 even when TVL exceeds the
 * threshold (over-funding is allowed and not shown as > 100%).
 */
export function computeFundingProgress(
  currentTvlUsd: number,
  minFundingThresholdUsd: number
): number {
  if (minFundingThresholdUsd <= 0) return 1;
  return Math.min(1, currentTvlUsd / minFundingThresholdUsd);
}

/**
 * Returns true when the genesis deadline has passed.
 *
 * @param deadline  ISO string from `VaultBootstrapConfig.genesisEpochDeadline`
 * @param now       Optional override for the current time (defaults to `Date.now()`).
 *                  Inject in tests to keep them deterministic.
 */
export function isGenesisDeadlineExceeded(
  deadline: string,
  now: number = Date.now()
): boolean {
  const ts = Date.parse(deadline);
  if (Number.isNaN(ts)) return false; // malformed date — do not block
  return now > ts;
}

/**
 * Derives the blocking conditions that apply to the current bootstrap status.
 *
 * Used by the operator console to explain why "Advance to Live" is greyed out,
 * and by the BFF adapter layer to translate wire-format `blockingReason`
 * strings into structured codes.
 */
export function deriveBlockingConditions(
  status: Pick<
    VaultBootstrapStatus,
    "phase" | "currentTvlUsd" | "config"
  >
): BootstrapBlockingCondition[] {
  const conditions: BootstrapBlockingCondition[] = [];
  const { phase, currentTvlUsd, config } = status;

  if (phase === "treasury_seeding") {
    conditions.push({
      code: "treasury_seed_pending",
      message: "Waiting for treasury seed transaction to confirm on-chain.",
    });
  }

  if (phase === "genesis_epoch" || phase === "treasury_seeding") {
    conditions.push({
      code: "genesis_epoch_active",
      message:
        "Genesis epoch is active. Advance the epoch once minimum funding is reached.",
    });
  }

  if (currentTvlUsd < config.minFundingThresholdUsd) {
    const shortfallUsd = config.minFundingThresholdUsd - currentTvlUsd;
    conditions.push({
      code: "below_minimum_funding",
      message: `TVL is $${currentTvlUsd.toLocaleString()} — need $${config.minFundingThresholdUsd.toLocaleString()} to advance (shortfall: $${shortfallUsd.toLocaleString()}).`,
      shortfallUsd,
    });
  }

  if (isGenesisDeadlineExceeded(config.genesisEpochDeadline)) {
    conditions.push({
      code: "deadline_exceeded",
      message: `Genesis epoch deadline (${config.genesisEpochDeadline}) has passed. The vault must be wound down.`,
      deadlineExceededBy: new Date().toISOString(),
    });
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// BFF adapter functions
// ---------------------------------------------------------------------------

/**
 * Fetches the current bootstrap status for a vault.
 *
 * Returns `null` when the vault has already passed the bootstrap phase
 * (`phase === "live"`) and the bootstrap endpoint is no longer available.
 */
export async function fetchBootstrapStatus(
  vaultId: string
): Promise<VaultBootstrapStatus | null> {
  const res = await fetch(`/api/v1/vaults/${encodeURIComponent(vaultId)}/bootstrap`);
  if (res.status === 404) return null; // vault is live; no bootstrap state
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      (body as { error?: string } | null)?.error ??
        `fetchBootstrapStatus failed (${res.status})`
    );
  }
  return res.json() as Promise<VaultBootstrapStatus>;
}

/**
 * Initiates a treasury seed deposit for a vault.
 *
 * Returns the unsigned XDR that the treasury wallet must sign and submit
 * through the standard vault signing flow (`depositToVault` in `vault.ts`
 * or the equivalent in `vaults.ts`).
 */
export async function buildTreasurySeed(
  vaultId: string,
  request: TreasurySeedRequest
): Promise<TreasurySeedResponse> {
  const res = await fetch(
    `/api/v1/vaults/${encodeURIComponent(vaultId)}/treasury-seed`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      (body as { error?: string } | null)?.error ??
        `buildTreasurySeed failed (${res.status})`
    );
  }
  return res.json() as Promise<TreasurySeedResponse>;
}

/**
 * Builds the genesis epoch rollover transaction.
 *
 * The BFF validates all blocking conditions before building. If any condition
 * is active it throws with the `blockingReason` from the response.
 */
export async function buildAdvanceGenesis(
  vaultId: string,
  request: AdvanceGenesisRequest
): Promise<AdvanceGenesisResponse> {
  const res = await fetch(
    `/api/v1/vaults/${encodeURIComponent(vaultId)}/advance-genesis`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      (body as { error?: string } | null)?.error ??
        `buildAdvanceGenesis failed (${res.status})`
    );
  }
  return res.json() as Promise<AdvanceGenesisResponse>;
}

// ---------------------------------------------------------------------------
// Default bootstrap config (used by the vault creation wizard)
// ---------------------------------------------------------------------------

/**
 * Sensible defaults for a new vault's bootstrap config.
 *
 * These are starting points for the operator wizard UI — all values must be
 * explicitly confirmed before the vault is created. Nothing is hardcoded in
 * contract storage; these defaults are frontend-only convenience values.
 */
export const DEFAULT_BOOTSTRAP_CONFIG: Omit<
  VaultBootstrapConfig,
  "genesisEpochDeadline"
> = {
  /** $10,000 minimum — enough to write a meaningful position on most underlyings. */
  minFundingThresholdUsd: 10_000,
  /** $5,000 seed — half the minimum, so public deposits can meet the other half. */
  treasurySeedUsd: 5_000,
  /** Temporary: withdraw seed once public deposits exceed the threshold. */
  seedRetentionPolicy: "temporary",
  /** Initial share price of exactly $1.00. */
  genesisSharePrice: 1.0,
  /** 10 ledgers (~50 seconds) retry window for rollover congestion. */
  rolloverRetryWindowLedgers: 10,
};
