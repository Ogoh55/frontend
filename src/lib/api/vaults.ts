import { z } from "zod";
import { env } from "../../env";
import { apiGet, apiPost, ApiError, bffFetch, type RequestOptions } from "./client";
import { ContractError, reportContractError } from "./contractError";
import { toCsv, type CsvColumn } from "../csv";
import freighterApi from "@stellar/freighter-api";
import { submitTransactionXdr } from "./stellar";

/**
 * Vault transaction receipts client.
 *
 * Receipts are keyed by the client-generated idempotency key so an optimistic
 * UI row and a later backend row collapse into a single record. Amounts are
 * carried as decimal strings (never floats) to preserve precision.
 *
 * This module also exposes the read-only diagnostics client used by the
 * internal depositor support console. The diagnostics client is issued a
 * read-scoped token and only ever calls GET endpoints, so a UI regression
 * cannot escalate into a state-changing call.
 *
 * Vaults REST contract — v1 (frozen).
 *
 * Owner: vaults. Counterpart: Zenith-options/backend. Any change to the wire
 * shapes below is a contract change: bump VAULTS_API_VERSION and land the
 * backend change in the same release.
 *
 * The Phase 2 options vault contract is scaffolded under `contracts/vault`
 * (crate `zenith-options-vault`), but it is not yet deployed and the backend
 * API is not yet available. This module is unrelated to the margin-collateral
 * vault in `./vault.ts`. When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
 * implementation below is used. Swap in the real implementation by
 * setting NEXT_PUBLIC_VAULTS=live, which calls the backend vault registry
 * (Zenith-options/backend) through the REST contract below.
 *
 * Transport
 *   All requests go through the BFF (`bffFetch`). The bearer token lives in
 *   the httpOnly session cookie and is attached server-side; this module never
 *   reads or sends it. GET routes are auth-optional, POST routes require a
 *   session (see src/lib/bff/allowlist.ts).
 *
 * Endpoints (all under /api/v1/vaults)
 *   GET  /                    ?limit&cursor                 → Page<VaultRegistryEntry>
 *   GET  /{id}                                              → VaultDetail | 404
 *   GET  /{id}/nav            ?from&to&limit&cursor         → Page<NavPoint>
 *   GET  /{id}/epochs         ?from&to&limit&cursor         → Page<EpochRecord>
 *   POST /{id}/deposit        { amount }                    → { tx_id }
 *   POST /{id}/withdraw       { shares }                    → { tx_id, queued }
 *
 *   GET /api/v1/vaults?cursor=<opaque>&limit=<n>
 *   → { items: VaultSummary[]; nextCursor: string | null; cache: CacheMeta }
 *
 *   GET /api/v1/vaults/{id}
 *   → VaultDetail
 *
 *   GET /api/v1/vaults/{id}/epochs?cursor=<opaque>&limit=<n>
 *   → { items: EpochRecord[]; nextCursor: string | null; cache: CacheMeta }
 *   GET  /api/v1/vaults/{id}/epoch-schedule?count=N
 *   → EpochBoundaryPreview   (dry-run: next N boundaries, no side effects)
 *
 *   GET /api/v1/vaults/{id}/analytics
 *   → VaultAnalytics
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number, wallet_address, disclosure_version: string }  → { xdr: string }
 *     The backend builds the unsigned deposit transaction (amounts, NAV and
 *     caps are computed server-side). The client only signs and submits it.
 *     Rejections carry `code`: vault_paused | vault_at_capacity | below_minimum.
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean; request_id: string }
 *   POST /api/v1/vaults/{id}/withdrawals/{request_id}/cancel → { returned_shares: number }
 *
 *   GET /api/v1/vaults/positions
 *   → VaultPositionWire[]  (one row per vault the wallet holds; `error` set when that vault failed)
 *
 *   GET /api/v1/vaults/{id}/epochs
 *   → VaultEpochLedgerEntry[]   (append-only, derived from on-chain epoch events)
 *
 *   POST /api/v1/vaults/disclosures/acknowledge
 *     { disclosure_version, text_hash, jurisdiction_attested }  → DisclosureAcknowledgement
 *   GET  /api/v1/vaults/disclosures/me  → DisclosureAcknowledgement[]
 *
 * Deposits are rejected server-side (403 with a PolicyReasonCode) unless the
 * wallet holds an acknowledgement for the current disclosure version. The
 * client check in the UI is advisory only.
 *
 * Withdrawal queue semantics (mock implements these; the live contract must match):
 *
 *   - Request: shares are escrowed on request. Escrowed shares stay in totalShares
 *     (so NAV per share is unaffected by the queue) but cannot be requested again.
 *   - Ordering: requests are served by (request epoch, then seq). Requests from an
 *     earlier epoch are always served first. `seq` is a monotonic tie-break assigned
 *     at request time. Unfilled requests keep their epoch, seq and requestedAt.
 *   - Fill: each epoch cohort is valued at the processing NAV. If the remaining
 *     liquidity covers the cohort, every request fills 100%. If it does not, every
 *     request in that cohort fills the same pro-rata fraction, and later cohorts get
 *     nothing this pass. `fillFraction` is recorded per request.
 *   - Processing: a keeper calls `processWithdrawalQueue` at an epoch boundary with the
 *     NAV per share and liquidity at that point. At most MAX_COHORTS_PER_PASS cohorts
 *     are examined per call. Filled shares leave totalShares and the user's shares.
 *   - Settlement NAV: a processed request pays out at the NAV passed to the keeper,
 *     not the NAV at request time.
 *   - Cancellation: only requests still in the queue can be cancelled. The escrow that
 *     remains is returned in full. Any part already filled stays paid out.
 *   - Pause: not modeled in the mock. The intended rule is that a paused vault blocks new
 *     requests but still processes queued ones.
 *
 * Pagination & caching (issue #223):
 *   - List and epoch-history reads are cursor-paginated (never offset). The
 *     cursor is an opaque token over a stable sort key (vault id / epoch
 *     number), so inserting a new epoch mid-pagination neither skips nor
 *     duplicates rows. Page size is capped at VAULT_MAX_PAGE_SIZE.
 *   - Responses carry `cache` freshness metadata so the UI can show whether
 *     NAV values are live or served from cache.
 *
 * Security baseline (issue #220):
 *   - Writes require the `vault:deposit` / `vault:withdraw` scope; the BFF
 *     rejects with 403 when the session token lacks it.
 *   - Writes carry an `Idempotency-Key` header so a legitimately retried
 *     deposit is not double-submitted.
 *   - Amounts/shares are validated client-side (finite, positive, bounded
 *     precision) before they reach the contract layer.
 *   - Rate limits are per-wallet (primary) and per-IP (secondary); a 429
 *     response includes a `retryAfter` hint in seconds.
 *
 * Loss recognition & insolvency (issue #225):
 *   - A realized loss larger than premium + reserves is allocated by a
 *     deterministic waterfall: fee reserves → first-loss buffer → pro-rata
 *     share write-down. Any residual beyond total NAV is recorded as explicit
 *     protocol bad debt (never an underflow).
 *   - NAV per share is clamped at zero and never reported negative.
 *   - While an unresolved loss event exists the vault is `impaired` and
 *     deposits are disabled.
 *
 * ---------------------------------------------------------------------------
 * Vault event / ABI schema versioning (issue #229)
 * ---------------------------------------------------------------------------
 * The Soroban contract spec is the source of truth for vault events and entry
 * points. This adapter mirrors that spec and is checked against the committed
 * snapshot in `contracts/abi/vault-spec.json` by `scripts/check-abi-snapshot`
 * in CI. Do not hand-edit the shapes below without bumping
 * `VAULT_SCHEMA_VERSION` and adding a changelog entry.
 *
 * Compatibility policy:
 *   - Within a major version, changes are additive only (new optional fields,
 *     new events, new entry points). Existing fields keep their name, type and
 *     meaning.
 *   - Removing or semantically changing a field requires an explicit deprecation
 *     window (documented in the changelog) before it is dropped.
 *   - Breaking majors are migrated with dual-emit: the contract emits both the
 *     old and new event shapes for one full release cycle so indexers can cut
 *     over without data loss.
 *
 * Numeric mapping (Soroban → JS):
 *   - i128 / u128 amounts are emitted as decimal strings and parsed to `number`
 *     only when within Number.MAX_SAFE_INTEGER; otherwise they are surfaced as
 *     strings to avoid silent precision loss.
 *   - u32 (epoch numbers, expiry days) map directly to `number`.
 *   - u64 timestamps map to ISO-8601 strings.
 *
 * Decoders MUST fail loudly on an unknown `schema_version` rather than
 * producing a plausible-looking wrong value.
 * Admin corrections (issue #293) — four-eyes approval, append-only:
 *   GET  /api/v1/vaults/{id}/corrections            → VaultCorrection[]
 *   POST /api/v1/vaults/{id}/corrections            { type, reason, evidenceUrl, supersedes, payload } → VaultCorrection
 *   POST /api/v1/vaults/{id}/corrections/{cid}/approve  → VaultCorrection
 *   POST /api/v1/vaults/{id}/corrections/{cid}/reject   → VaultCorrection
 *   POST /api/v1/vaults/{id}/corrections/{cid}/apply    → VaultCorrection
 *   POST /api/v1/vaults/{id}/corrections/{cid}/preview  → CorrectionPreview
 *
 *   Tranche waterfall (issue #295) — pure/deterministic, callable off-chain:
 *   GET  /api/v1/vaults/{id}/tranches               → VaultTranche[]
 *   POST /api/v1/vaults/{id}/tranches/preview       { epochPremium, realizedLoss, fees } → TrancheWaterfallResult
 *
 *   Idle-collateral lending yield (issue #296) — narrow adapter, degrades to
 *   "no external yield" when the lending market is paused/unavailable:
 *   GET  /api/v1/vaults/{id}/collateral-policy     → CollateralDeploymentPolicy
 *   GET  /api/v1/vaults/{id}/collateral-yield      → CollateralYieldBreakdown
 *
 * NAV / share-price source of truth (issue #290):
 *
 *   Share issuance is priced from the vault's internal book value
 *   (`bookValue`), NOT from the raw token balance held at the vault
 *   contract address. Direct token transfers to the contract are
 *   classified as `ignored` — they do not move NAV and cannot be used
 *   to inflate the share price. This classification is identical across
 *   the contract, the backend indexer/registry, and this adapter.
 *
 *   Inflation / donation-attack mitigations are per-vault config
 *   (`inflationDefense`) and are changeable only through the timelocked
 *   operator path. The adapter surfaces them so the UI can enforce the
 *   same `minSharesOut` bound the contract enforces on deposit.
 *
 * Shadow mode (issue #292):
 *
 *   A strategy may run in `shadow` mode — the identical strategy module
 *   and keeper path execute against live oracle/engine data, but no
 *   option orders are submitted and no depositor collateral is
 *   committed. Shadow state lives in its own namespace (`shadow` on the
 *   detail payload) with its own hypothetical NAV-per-share series and
 *   epoch record stream. It is NEVER merged into `bookValue`,
 *   `sharePrice`, `tvl`, or `historicalEpochs`, and shadow runs are
 *   labeled `mode: "shadow"` everywhere they surface so paper results
 *   cannot be mistaken for realized performance.
 *
 * Depositor privacy (issue #231):
 *
 *   GET  /api/v1/vaults/privacy/export?wallet={address}
 *   → DepositorDataExport
 *
 *   POST /api/v1/vaults/privacy/deletion-request  { wallet: string; reason?: string }
 *   → DeletionRequestReceipt
 *
 *   GET  /api/v1/vaults/privacy/deletion-request/{id}
 *   → DeletionRequestReceipt
 *
 * Public read-only partner API (issue #233):
 *
 *   GET /api/public/v1/vaults?limit={n}&cursor={c}
 *   → PublicVaultListResponse
 *
 *   GET /api/public/v1/vaults/{id}
 *   → PublicVaultDetail
 *
 *   GET /api/public/v1/vaults/{id}/epochs?limit={n}&cursor={c}
 *   → PublicEpochHistoryResponse
 *
 * The public surface is a projection over the same vault registry/epoch
 * ledger, served from a cache independent of the authenticated read path.
 * It never exposes per-depositor data (see `toPublicVaultSummary`).
 *
 * See docs/privacy/vault-data-inventory.md for the data inventory, retention
 * windows, and the deletion/export workflow this module mirrors.
 *
 * Fiat on-ramp / off-ramp (SEP-24 interactive, SEP-6 non-interactive):
 *
 *   GET  /api/vaults/anchor/config?network=&asset=
 *   → AnchorConfig | null   (null ⇒ no anchor configured ⇒ hide entry points)
 *
 *   POST /api/vaults/anchor/quote  { network, asset, direction, amount }
 *   → AnchorQuote
 *
 *   POST /api/vaults/anchor/transaction  { network, asset, direction, amount, quoteId }
 *   → AnchorTransaction   (interactiveUrl is minted server-side, never client-supplied)
 *
 *   GET  /api/vaults/anchor/transaction/{id}
 *   → AnchorTransaction
 *
 * Anchor credentials stay server-side in the BFF proxy; the client only ever
 * sees the normalized shapes below. Anchor transactions are modelled as a
 * separate state machine from the vault deposit so a refund/expiry never
 * leaves a half-applied vault position.
 *
 * Recurring auto-deposit (DCA) schedules:
 *
 *   GET    /api/vaults/{id}/schedules            → AutoDepositSchedule[]
 *   POST   /api/vaults/{id}/schedules            { amount, cadence, ... } → AutoDepositSchedule
 *   PATCH  /api/vaults/{id}/schedules/{sid}      { ...patch }             → AutoDepositSchedule
 *   POST   /api/vaults/{id}/schedules/{sid}/pause   → AutoDepositSchedule
 *   POST   /api/vaults/{id}/schedules/{sid}/resume  → AutoDepositSchedule
 *   DELETE /api/vaults/{id}/schedules/{sid}      → void
 *
 * Schedules are persisted server-side against the account (never
 * localStorage). Each execution is driven by a durable scheduler job that
 * calls the exact same deposit service as the interactive flow, and is
 * idempotent per (schedule_id, scheduled_slot) so a retry cannot
 * double-deposit.
 *
 * Vault-written options supply (issue #267):
 *
 *   GET /api/v1/vaults/supply?underlying=&expiry=
 *   → VaultSupplySummary   (one aggregated summary keyed by strike; never
 *                           per-row lookups, so long expiries don't N+1)
 *
 * The summary is joined client-side into the options chain / vol surface.
 * When the endpoint is unavailable (404/5xx/network) or the vault flag is
 * off, callers must render the chain exactly as before — no placeholder
 * zeros presented as real supply data.
 *
 * Wire format
 *   - Every amount, price, share count and ratio is a decimal string
 *     (/^-?\d+(\.\d+)?$/), never a JSON number. Amounts are USD collateral
 *     unless the field ends in `_shares`. Ratios are fractions (0.18 = 18%).
 *   - Instants are RFC 3339 with an offset (`*_at`, `phase_ends_at`).
 *     Calendar dates are YYYY-MM-DD (`*_expiry`, `*_start`, `settlement_date`).
 *   - Field names are snake_case (serde output). Unknown extra fields are
 *     stripped; missing or mistyped fields fail validation (ContractError).
 *
 * Pagination and time ranges
 *   - `cursor` is opaque. `limit` is 1–100 (default 50). `next_cursor: null`
 *     marks the last page.
 *   - `from` / `to` are inclusive RFC 3339 bounds. NAV points filter on `at`;
 *     epochs filter on `settlement_date`.
 *
 * Error taxonomy (HTTP status → VaultsApiError.code)
 *   401  unauthorized     Session expired. Not retried; re-authenticate.
 *   403  forbidden        Vaults flag off, or wallet not allowlisted. Not retried.
 *   404  not_found        getVault resolves to null.
 *   409  epoch_closed     The epoch closed while the request was in flight.
 *                         Not retried; the user retries in the next deposit window.
 *   400/422 invalid_request
 *   5xx  unavailable      Retryable.
 *   client-side: timeout (10s), network, aborted, contract (schema violation).
 *
 * Degradation
 *   Reads (list, detail, nav, epochs) that fail with a retryable error return
 *   the last successful response for the same key in this session, so the
 *   detail view keeps its values. Mutations (deposit, withdraw) are never
 *   retried by the adapter and always surface their error.
 *
 * Mode
 *   NEXT_PUBLIC_VAULTS=live selects the live client. Any other value (absent
 *   or "mock") selects the mock client backed by MOCK_VAULTS. Pages import only
 *   from this module, so flipping the flag needs no page changes.
 */
import { useWalletStore } from '@/lib/store/wallet';

export const VAULTS_API_VERSION = "v1" as const;
const API = `/api/${VAULTS_API_VERSION}/vaults`;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_PAGES = 20;

/** Current vault event/ABI schema major version. Bump on any breaking change. */
export const VAULT_SCHEMA_VERSION = 1 as const;

/** Stable topic layout for every emitted vault event. */
export const VAULT_EVENT_TOPICS = {
  deposit: ["vault", "deposit"],
  withdraw: ["vault", "withdraw"],
  epoch_settled: ["vault", "epoch_settled"],
} as const;

/** Enumerable vault contract error codes (mirrors the contract spec). */
export const VaultErrorCode = {
  Unauthorized: 1,
  VaultFull: 2,
  InsufficientShares: 3,
  EpochNotSettled: 4,
  InvalidAmount: 5,
  UnknownSchemaVersion: 6,
} as const;
export type VaultErrorCode = (typeof VaultErrorCode)[keyof typeof VaultErrorCode];

/** Base shape every decoded vault event carries. */
export interface VaultEventEnvelope {
  /** Explicit schema version; consumers must reject unknown values. */
  schema_version: number;
  /** Stable topic layout, e.g. ["vault", "deposit"]. */
  topic: readonly string[];
  /** Ledger sequence the event was emitted in. */
  ledger: number;
}

/**
 * Decode a raw vault event, validating its schema version.
 * Throws on an unknown version so consumers never mis-decode silently.
 * Unknown extra fields are preserved and ignored by typed consumers.
 */
export function decodeVaultEvent(raw: Record<string, unknown>): VaultEventEnvelope & Record<string, unknown> {
  const version = raw.schema_version;
  if (typeof version !== "number" || version !== VAULT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported vault event schema_version: ${String(version)} (expected ${VAULT_SCHEMA_VERSION})`,
    );
  }
  return raw as VaultEventEnvelope & Record<string, unknown>;
}

export type VaultTxType =
  | 'deposit'
  | 'redemption_request'
  | 'redemption'
  | 'epoch_payout'
  | 'fee_charge';

export type VaultTxStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'reconciled';

export interface VaultReceipt {
  /** Client-generated idempotency key — the canonical receipt identity. */
  idempotencyKey: string;
  vaultId: string;
  account: string;
  type: VaultTxType;
  /** Decimal string, e.g. "1000.00". */
  amount: string;
  /** Decimal string share delta (positive for deposits, negative for redemptions). */
  shareDelta: string;
  /** NAV that applied at execution, as a decimal string. Null until known. */
  navAtExecution: string | null;
  /** Fee charged, as a decimal string. */
  fee: string;
  status: VaultTxStatus;
  /** Stellar transaction hash — only present once submitted. */
  txHash: string | null;
  /** ISO timestamp of the last status change. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Wire schemas (source of truth for the frozen contract)
// ---------------------------------------------------------------------------

const DecimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");
const InstantSchema = z.string().datetime({ offset: true });
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const VaultStrategySchema = z.enum(["covered_call", "cash_secured_put", "iron_condor", "wheel"]);
export const RiskRatingSchema = z.enum(["low", "medium", "high"]);
export const EpochPhaseSchema = z.enum(["deposit", "active", "settlement"]);
export const EpochOutcomeSchema = z.enum(["expired_worthless", "exercised", "active"]);

/** Registry entry: one row on the /vaults listing. */
export const VaultRegistryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  underlying: z.string(),
  strategy: VaultStrategySchema,
  apy: DecimalStringSchema,
  apy_methodology: z.string(),
  tvl_usd: DecimalStringSchema,
  capacity_usd: DecimalStringSchema,
  /** tvl_usd / capacity_usd, as a fraction 0–1. */
  utilisation: DecimalStringSchema,
  current_strike: DecimalStringSchema,
  current_expiry: DateSchema,
  risk_rating: RiskRatingSchema,
  description: z.string(),
});

export const EpochRecordSchema = z.object({
  epoch_number: z.number().int().nonnegative(),
  deposit_start: DateSchema,
  active_start: DateSchema,
  settlement_date: DateSchema,
  strike: DecimalStringSchema,
  expiry_days: z.number().int().nonnegative(),
  premium_collected: DecimalStringSchema,
  outcome: EpochOutcomeSchema,
  /** Epoch return as a fraction; positive = profit for depositors. */
  pnl_ratio: DecimalStringSchema,
});

export const UserPositionSchema = z.object({
  shares: DecimalStringSchema,
  share_value: DecimalStringSchema,
  total_value_usd: DecimalStringSchema,
  accrued_premium_usd: DecimalStringSchema,
  pending_withdrawal_shares: DecimalStringSchema,
});

/** Deposit/withdraw queue state for the current epoch. */
export const QueueStateSchema = z.object({
  deposit_pending_usd: DecimalStringSchema,
  withdraw_pending_shares: DecimalStringSchema,
  settles_at: InstantSchema,
});

/** Fee accrual breakdown, accrued through `accrued_through`. */
export const FeeAccrualSchema = z.object({
  management_accrued_usd: DecimalStringSchema,
  performance_accrued_usd: DecimalStringSchema,
  accrued_through: InstantSchema,
});

/** Full vault detail, including the current epoch and a bounded recent-epoch window. */
export const VaultDetailSchema = VaultRegistryEntrySchema.extend({
  current_epoch: z.number().int().nonnegative(),
  current_phase: EpochPhaseSchema,
  phase_ends_at: InstantSchema,
  share_price: DecimalStringSchema,
  total_shares: DecimalStringSchema,
  fee_structure: z.object({
    management_pct: DecimalStringSchema,
    performance_pct: DecimalStringSchema,
  }),
  payoff_explanation: z.string(),
  queue: QueueStateSchema,
  fees: FeeAccrualSchema,
  recent_epochs: z.array(EpochRecordSchema),
  user_position: UserPositionSchema.nullable(),
});

export const NavPointSchema = z.object({
  at: InstantSchema,
  share_price: DecimalStringSchema,
  total_shares: DecimalStringSchema,
});

export const DepositResponseSchema = z.object({ tx_id: z.string().min(1) });
export const WithdrawResponseSchema = z.object({ tx_id: z.string().min(1), queued: z.boolean() });

export type VaultRegistryEntryWire = z.infer<typeof VaultRegistryEntrySchema>;
export type VaultDetailWire = z.infer<typeof VaultDetailSchema>;
export type EpochRecordWire = z.infer<typeof EpochRecordSchema>;
export type NavPointWire = z.infer<typeof NavPointSchema>;

const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });

// ---------------------------------------------------------------------------
// UI types (camelCase, display-ready)
// ---------------------------------------------------------------------------

export type VaultStrategy = z.infer<typeof VaultStrategySchema>;
export type RiskRating = z.infer<typeof RiskRatingSchema>;
export type EpochPhase = z.infer<typeof EpochPhaseSchema>;

// ---------------------------------------------------------------------------
// Multi-asset collateral support (issue #217)
// ---------------------------------------------------------------------------

/**
 * Canonical collateral asset descriptor for a vault.
 *
 * A vault declares exactly one collateral asset at creation and it is
 * immutable afterwards. Classic Stellar assets use 7 decimals; Soroban
 * token contracts may declare arbitrary decimals. All contract math works
 * in base units; display units are derived at the API boundary via
 * `normalizeAmount` / `formatAssetAmount`.
 */
export interface CollateralAsset {
  /** Asset code, e.g. "USDC" or "AQUA". */
  code: string;
  /**
   * Classic Stellar issuer (G...) for classic assets, or the Soroban token
   * contract id (C...) for token contracts. Null for native XLM.
   */
  issuer: string | null;
  /** Soroban token contract id (C...) when the asset is a token contract. */
  contractId: string | null;
  /** Declared decimals for the asset (7 for classic Stellar assets). */
  decimals: number;
}

/** Classic Stellar assets always use 7 decimals. */
export const CLASSIC_ASSET_DECIMALS = 7;

/**
 * Per-network allowlist of supported collateral assets. Vault creation is
 * validated against this list; assets without a healthy oracle are excluded.
 */
export interface CollateralAllowlist {
  network: "mainnet" | "testnet" | "futurenet";
  assets: CollateralAsset[];
}

/**
 * Single shared normalization helper: convert a base-unit integer amount
 * into display units using the asset's declared decimals. Used for share
 * pricing, NAV, capacity, and fee math so no module re-implements scaling.
 */
export function normalizeAmount(baseUnits: bigint | number, decimals: number): number {
  const units = typeof baseUnits === "bigint" ? baseUnits : BigInt(Math.trunc(baseUnits));
  return Number(units) / 10 ** decimals;
}

/** Inverse of `normalizeAmount`: display units → base-unit integer. */
export function toBaseUnits(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}

/**
 * Validate that a display-unit amount does not exceed the asset's declared
 * decimals. Returns an error message for over-precision amounts, or null.
 */
export function validateAssetPrecision(amount: number, decimals: number): string | null {
  if (!Number.isFinite(amount) || amount < 0) return "Amount must be a non-negative number";
  const scaled = amount * 10 ** decimals;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    return `Amount exceeds ${decimals} decimal places for this asset`;
  }
  return null;
}

/**
 * Format a base-unit amount for display using the asset's decimals.
 * Very small share prices are preserved (never rounded to zero) by
 * falling back to significant-digit formatting.
 */
export function formatAssetAmount(baseUnits: bigint | number, decimals: number): string {
  const value = normalizeAmount(baseUnits, decimals);
  if (value === 0) return "0";
  if (Math.abs(value) < 0.01) return value.toPrecision(4);
  return value.toLocaleString(undefined, { maximumFractionDigits: Math.min(decimals, 6) });
}

/**
 * Operational state of a vault. `impaired` means an unresolved loss event
 * exists: NAV has been written down and deposits are disabled until the loss
 * is fully absorbed / the vault recovers.
 */
export type VaultState = "healthy" | "impaired" | "underwater";

/** Explicit scopes carried on the session/token for vault operations. */
export type VaultScope =
  | "vault:read"
  | "vault:deposit"
  | "vault:withdraw"
  | "vault:operator";

/** Maximum decimal places accepted for deposit amounts / share quantities. */
export const VAULT_AMOUNT_MAX_DECIMALS = 7;

/** Hard cap on page size for cursor-paginated vault/epoch reads. */
export const VAULT_MAX_PAGE_SIZE = 100;

/** Default page size when the caller does not specify one. */
export const VAULT_DEFAULT_PAGE_SIZE = 25;

/**
 * Stable, versioned moneyness band used as the strike-bucket key for
 * concentration limits. Buckets are enums (not free strings) so the sizing
 * step and contract enforcement can never disagree on a key.
 */
export type StrikeBucket = "deep_otm" | "otm" | "atm" | "itm" | "deep_itm";

/**
 * Declarative concentration limits for a vault, each expressed as a fraction
 * of the committed epoch NAV (0–1). Evaluated by the shared
 * `evaluateExposure()` helper so sizing and enforcement cannot drift.
 */
export interface ExposureLimits {
  /** Max fraction of NAV written against a single underlying. */
  perUnderlying: number;
  /** Max fraction of NAV written into a single strike bucket. */
  perStrikeBucket: number;
  /** Max fraction of NAV written into a single expiry. */
  perExpiry: number;
}

/** Current written exposure, keyed by the same dimensions as the limits. */
export interface ExposureState {
  /** Committed epoch NAV used as the denominator (no live mark). */
  nav: number;
  byUnderlying: Record<string, number>;
  byStrikeBucket: Partial<Record<StrikeBucket, number>>;
  byExpiry: Record<string, number>;
}

/** A strategy intent requesting a written notional before sizing. */
export interface StrategyIntent {
  underlying: string;
  strikeBucket: StrikeBucket;
  expiry: string; // ISO date
  requestedNotional: number;
}

/** Recorded clamp decision for observability. */
export interface SizingDecision {
  approvedNotional: number;
  clamped: boolean;
  /** Tightest binding dimension, or null when unclamped. */
  reason: "perUnderlying" | "perStrikeBucket" | "perExpiry" | null;
  /** Remaining headroom (in notional) on the binding dimension. */
  remainingHeadroom: number;
}

/**
 * Transfer policy for vault LP shares.
 *
 * - `OPEN`        — shares are freely transferable (current default).
 * - `ALLOWLISTED` — transfers are permitted only when the recipient is on
 *                   the vault's allowlist (and not on the denylist).
 * - `BLOCKED`     — all share transfers are disabled. Mint (deposit) and
 *                   burn (redeem / forced burn) remain permitted so a
 *                   restriction can never trap a depositor's principal.
 */
export type TransferPolicy = "OPEN" | "ALLOWLISTED" | "BLOCKED";

/**
 * A single allowlist entry with explicit provenance so an entry's origin is
 * auditable. Entries are versioned; the vault's `allowlistVersion` is bumped
 * on every mutation and recorded alongside the operator that made it.
 */
export interface AllowlistEntry {
  address: string;
  /** Monotonic version at which this entry was added. */
  version: number;
  /** Operator/backend identity that added the entry. */
  addedBy: string;
  /** ISO timestamp of the addition. */
  addedAt: string;
  /** Optional jurisdiction tag driving eligibility gating. */
  jurisdiction?: string;
}

/**
 * Audited record of a policy or allowlist mutation. Surfaced in the
 * depositor-facing disclosure and transparency surfaces.
 */
export interface ComplianceAuditRecord {
  id: string;
  kind: "policy_change" | "allowlist_add" | "allowlist_remove";
  /** Resulting allowlist version after the mutation. */
  version: number;
  address?: string;
  /** Previous policy, for `policy_change` records. */
  previousPolicy?: TransferPolicy;
  /** New policy, for `policy_change` records. */
  policy?: TransferPolicy;
  actor: string;
  /** ISO timestamp at which the change takes effect (timelock). */
  effectiveAt: string;
  createdAt: string;
}

/**
 * Compliance hook surface for the backend compliance service. The contract
 * never reaches out to an oracle itself; instead the backend supplies a
 * pre-transfer advisory and consumes a post-settlement reconciliation feed.
 */
export interface ComplianceHooks {
  /**
   * Pre-transfer advisory. Returns `true` to allow, `false` to deny. The
   * contract treats a missing hook as allow (policy still applies).
   */
  preTransferCheck?: (from: string, to: string, amount: number) => boolean;
  /**
   * Post-settlement reconciliation feed. Invoked after a transfer settles so
   * the backend can reconcile screening decisions.
   */
  onSettled?: (event: TransferSettlementEvent) => void;
}

/** Emitted to the reconciliation feed after a transfer settles. */
export interface TransferSettlementEvent {
  vaultId: string;
  from: string;
  to: string;
  amount: number;
  policy: TransferPolicy;
  allowlistVersion: number;
  /** ISO timestamp of settlement. */
  settledAt: string;
}

/**
 * Distinct, documented error code for a transfer rejected by the allowlist.
 * Part of the error taxonomy; surfaced verbatim to callers.
 */
export const ERR_TRANSFER_NOT_ALLOWLISTED = "VAULT_TRANSFER_NOT_ALLOWLISTED";
/** Distinct error code for a transfer rejected by the denylist. */
export const ERR_TRANSFER_DENYLISTED = "VAULT_TRANSFER_DENYLISTED";
/** Distinct error code for a transfer rejected because the policy is BLOCKED. */
export const ERR_TRANSFER_BLOCKED = "VAULT_TRANSFER_BLOCKED";

/** Result of a `can_transfer` evaluation. */
export interface TransferDecision {
  allowed: boolean;
  /** Error code when `allowed` is false, else null. */
  code: string | null;
}

/**
 * Transfer-restriction configuration for a vault's LP shares.
 */
export interface TransferRestrictions {
  policy: TransferPolicy;
  /** Monotonic version, bumped on every policy/allowlist mutation. */
  allowlistVersion: number;
  allowlist: AllowlistEntry[];
  /** Denylist addresses. An address on both lists is denied (deny wins). */
  denylist: string[];
  /** Addresses exempt from restrictions (contract, redemption queue). */
  exempt: string[];
}

/**
 * Single source of truth for whether a share transfer is permitted. Every
 * transfer path (including future batch paths) must route through this.
 *
 * Exempt addresses (the contract itself and the redemption queue) bypass the
 * policy so redemptions and forced burns always succeed. An address present
 * on both the allowlist and denylist is denied deterministically.
 */
export function can_transfer(
  restrictions: TransferRestrictions,
  from: string,
  to: string,
  hooks?: ComplianceHooks,
): TransferDecision {
  // Exempt endpoints (contract, redemption queue) always pass.
  if (restrictions.exempt.includes(from) || restrictions.exempt.includes(to)) {
    return { allowed: true, code: null };
  }

  if (restrictions.policy === "BLOCKED") {
    return { allowed: false, code: ERR_TRANSFER_BLOCKED };
  }

  if (restrictions.policy === "ALLOWLISTED") {
    // Deny wins: an address on both lists is denied.
    if (restrictions.denylist.includes(to)) {
      return { allowed: false, code: ERR_TRANSFER_DENYLISTED };
    }
    const allowed = restrictions.allowlist.some((e) => e.address === to);
    if (!allowed) {
      return { allowed: false, code: ERR_TRANSFER_NOT_ALLOWLISTED };
    }
  }

  // Pre-transfer advisory from the backend compliance service.
  if (hooks?.preTransferCheck && !hooks.preTransferCheck(from, to, 0)) {
    return { allowed: false, code: ERR_TRANSFER_DENYLISTED };
  }

  return { allowed: true, code: null };
}

/**
 * Apply an allowlist addition, returning the updated restrictions and an
 * audited record. The version is bumped so provenance is auditable.
 */
export function addAllowlistEntry(
  restrictions: TransferRestrictions,
  entry: Omit<AllowlistEntry, "version">,
  actor: string,
  now: string = new Date().toISOString(),
): { restrictions: TransferRestrictions; audit: ComplianceAuditRecord } {
  const version = restrictions.allowlistVersion + 1;
  const next: TransferRestrictions = {
    ...restrictions,
    allowlistVersion: version,
    allowlist: [...restrictions.allowlist, { ...entry, version }],
  };
  const audit: ComplianceAuditRecord = {
    id: `allowlist_add:${entry.address}:${version}`,
    kind: "allowlist_add",
    version,
    address: entry.address,
    actor,
    effectiveAt: now,
    createdAt: now,
  };
  return { restrictions: next, audit };
}

/**
 * Apply an allowlist removal, returning the updated restrictions and an
 * audited record. The version is bumped so provenance is auditable.
 */
export function removeAllowlistEntry(
  restrictions: TransferRestrictions,
  address: string,
  actor: string,
  now: string = new Date().toISOString(),
): { restrictions: TransferRestrictions; audit: ComplianceAuditRecord } {
  const version = restrictions.allowlistVersion + 1;
  const next: TransferRestrictions = {
    ...restrictions,
    allowlistVersion: version,
    allowlist: restrictions.allowlist.filter((e) => e.address !== address),
  };
  const audit: ComplianceAuditRecord = {
    id: `allowlist_remove:${address}:${version}`,
    kind: "allowlist_remove",
    version,
    address,
    actor,
    effectiveAt: now,
    createdAt: now,
  };
  return { restrictions: next, audit };
}

/**
 * Execution mode of a vault strategy.
 *
 * - `live`: real capital is committed and real option orders are submitted.
 * - `shadow`: paper trading — the same decision path runs, but no orders
 *   are submitted and no depositor collateral is committed. Shadow state
 *   is tracked in a separate namespace and must never be conflated with
 *   live balances.
 */
export type VaultMode = "live" | "shadow";

/**
 * How a direct token transfer to the vault contract address is treated.
 * Must match the contract and backend indexer/registry exactly.
 *
 * - `ignored`: transfer does not affect NAV (default; donation-resistant).
 * - `swept`: transfer is moved to a defined sink address.
 * - `windfall`: transfer is absorbed into book value (opt-in only).
 */
export type DirectTransferPolicy = "ignored" | "swept" | "windfall";

/**
 * Per-vault inflation / donation-attack defense parameters.
 * Stored with the rest of the vault parameters and mutable only via the
 * timelocked operator path — never hardcoded constants.
 */
export interface InflationDefenseConfig {
  /** Virtual shares added to total supply in the pricing formula. */
  virtualShares: number;
  /** Virtual assets added to book value in the pricing formula. */
  virtualAssets: number;
  /** Minimum assets required for the first (genesis) deposit. */
  minFirstDeposit: number;
  /** Shares minted to the dead/locked address on the first deposit. */
  deadShares: number;
  /** Max fractional NAV-per-share move between issuance events in one ledger (0–1). */
  navJumpGuardPct: number;
  /** Classification of direct token transfers to the contract. */
  directTransferPolicy: DirectTransferPolicy;
}

// ---------------------------------------------------------------------------
// Lifecycle state machine (see docs/vault-lifecycle.md)
// ---------------------------------------------------------------------------

export const VAULT_STATUSES = ["draft", "open", "paused", "winding_down", "closed"] as const;
export type VaultStatus = (typeof VAULT_STATUSES)[number];

/** Funds-affecting user actions gated by vault status. */
export type VaultAction = "deposit" | "withdraw";

/** Who may trigger a transition. Operator actions are governance-gated (out of scope here). */
export type VaultActor = "operator" | "guardian" | "system";

export interface VaultTransition {
  from: VaultStatus;
  to: VaultStatus;
  actor: VaultActor;
}

export const VAULT_TRANSITIONS: readonly VaultTransition[] = [
  { from: "draft", to: "open", actor: "operator" },
  { from: "open", to: "paused", actor: "guardian" },
  { from: "open", to: "winding_down", actor: "operator" },
  { from: "paused", to: "open", actor: "operator" },
  { from: "paused", to: "winding_down", actor: "operator" },
  { from: "winding_down", to: "closed", actor: "system" },
];

export interface VaultStatusPolicy {
  label: string;
  permittedActions: readonly VaultAction[];
}

export const VAULT_STATUS_POLICY: Record<VaultStatus, VaultStatusPolicy> = {
  draft:        { label: "Draft",        permittedActions: [] },
  open:         { label: "Open",         permittedActions: ["deposit", "withdraw"] },
  paused:       { label: "Paused",       permittedActions: [] },
  winding_down: { label: "Winding Down", permittedActions: ["withdraw"] },
  closed:       { label: "Closed",       permittedActions: [] },
};

/** Read-only fallback for any status this client does not know about. */
const UNKNOWN_STATUS_POLICY: VaultStatusPolicy = { label: "Unknown", permittedActions: [] };

export function isVaultStatus(status: unknown): status is VaultStatus {
  return typeof status === "string" && (VAULT_STATUSES as readonly string[]).includes(status);
}

/** Resolves policy for a raw status string. Unknown statuses are read-only, never actionable. */
export function vaultStatusPolicy(status: string): VaultStatusPolicy {
  return isVaultStatus(status) ? VAULT_STATUS_POLICY[status] : UNKNOWN_STATUS_POLICY;
}

/**
 * Applies a transition. Re-applying the current status is an idempotent no-op
 * (`changed: false`, so no history entry is written). Illegal edges or wrong actors throw.
 */
export function applyVaultTransition(
  current: VaultStatus,
  to: VaultStatus,
  actor: VaultActor
): { status: VaultStatus; changed: boolean } {
  if (current === to) return { status: current, changed: false };
  const edge = VAULT_TRANSITIONS.find(t => t.from === current && t.to === to);
  if (!edge) throw new Error(`Illegal vault transition: ${current} → ${to}`);
  if (edge.actor !== actor) throw new Error(`Actor ${actor} may not move vault ${current} → ${to}`);
  return { status: to, changed: true };
}

/**
 * Per-vault roles. Each vault is its own tenant boundary: a holder of a role
 * on one vault has no implicit authority over any other vault.
 *
 * - depositor: may deposit and withdraw/redeem
 * - operator: may set strategy parameters and roll epochs
 * - guardian: may pause new deposits and new epochs only (never unpause or change parameters)
 * - emergency_authority: protocol-level emergency authority, scoped to this vault
 */
export type VaultRole = "depositor" | "operator" | "guardian" | "emergency_authority";

/** One role assignment on a vault. */
export interface VaultRoleGrant {
  role: VaultRole;
  /** Account address of the role holder. */
  holder: string;
  /** ISO timestamp of when the role was granted. */
  grantedAt: string;
}

/**
 * Backend-supplied deposit limits. Every value here is authoritative only as of
 * `asOf`; past LIMITS_STALE_AFTER_MS the UI derives a read-only "stale" state
 * instead of trusting the numbers.
 */
export interface VaultLimits {
  /** Deposits are paused by the operator. */
  paused: boolean;
  /** Deposits that cannot be accepted now join the waitlist for the next epoch. */
  waitlistEnabled: boolean;
  /** Maximum USD a single depositor may add in one epoch. */
  perEpochDepositLimit: number;
  /** ISO start of the next deposit window. */
  nextDepositStart: string;
  /** ISO time the backend took this snapshot. */
  asOf: string;
}

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  /** Immutable collateral asset this vault operates in. */
  collateralAsset: CollateralAsset;
  /** Execution mode; `shadow` results are paper trading, not realized. */
  mode: VaultMode;
  status: VaultStatus;
  /** Trailing 12-month APY estimate (0–1, e.g. 0.18 = 18%). */
  apy: number | null;
  /** APY methodology note shown in tooltip. */
  apyMethodology: string;
  /** Total value locked in USD. */
  tvl: number | null;
  /** Maximum TVL before the vault is full. */
  capacity: number | null;
  /** tvl / capacity (0–1). */
  utilisation: number;
  currentStrike: number | null;
  currentExpiry: string | null; // ISO date
  riskRating: RiskRating;
  description: string;
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string; // ISO — when the current phase ends
  limits: VaultLimits;
  /** Current operational state; `impaired`/`underwater` disable deposits. */
  state: VaultState;
  /** True while an unresolved loss event exists (deposits disabled). */
  depositsDisabled: boolean;
  /** Epoch length (tenor) in days. */
  epochDays: number;
  /** Fees as whole percentages, e.g. performancePct: 10 = 10%. */
  feeStructure: { managementPct: number; performancePct: number };
  /** Worst peak-to-trough drawdown (0–1). Null until the vault has enough settled epochs. */
  maxDrawdownPct: number | null;
}

// ---------------------------------------------------------------------------
// Listing query: filter + sort state, shared by the index and compare views.
// Parsed from and serialized to URL search params, so views are shareable.
// ---------------------------------------------------------------------------

export const VAULT_SORT_KEYS = ["apy", "utilization", "tvl", "drawdown", "fees"] as const;
export type VaultSortKey = (typeof VAULT_SORT_KEYS)[number];
export type VaultSortDir = "asc" | "desc";

export const VAULT_STRATEGY_LABELS: Record<VaultStrategy, string> = {
  covered_call:      "Covered Call",
  cash_secured_put:  "Cash-Secured Put",
  iron_condor:       "Iron Condor",
  wheel:             "Wheel",
};

export const VAULT_STATUS_LABELS: Record<VaultStatus, string> = {
  draft:        "Draft",
  open:         "Open",
  paused:       "Paused",
  winding_down: "Winding Down",
  closed:       "Closed",
};

export const VAULT_RISK_LABELS: Record<RiskRating, string> = {
  low:    "Low",
  medium: "Medium",
  high:   "High",
};

export const VAULT_SORT_LABELS: Record<VaultSortKey, string> = {
  apy:         "APY",
  utilization: "Capacity used",
  tvl:         "TVL",
  drawdown:    "Max drawdown",
  fees:        "Fees",
};

/** Maximum vaults that can be placed side by side on the compare view. */
export const VAULT_COMPARE_MAX = 4;

export interface VaultQuery {
  strategy: VaultStrategy | null;
  underlying: string | null;
  status: VaultStatus | null;
  risk: RiskRating | null;
  /** Epoch length in days. */
  tenor: number | null;
  sort: VaultSortKey;
  dir: VaultSortDir;
  /** Vault ids selected for comparison. */
  ids: string[];
}

export const DEFAULT_VAULT_QUERY: VaultQuery = {
  strategy: null,
  underlying: null,
  status: null,
  risk: null,
  tenor: null,
  sort: "apy",
  dir: "desc",
  ids: [],
};

function pickOne<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** Parses a comma-separated id list, dropping blanks and duplicates and capping at VAULT_COMPARE_MAX. */
export function parseVaultIds(raw: string | null): string[] {
  if (!raw) return [];
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  return [...new Set(ids)].slice(0, VAULT_COMPARE_MAX);
}

/**
 * Reads the query from URL search params. Unknown or malformed values degrade
 * to defaults rather than throwing. `knownUnderlyings` is the set present in the
 * loaded data, so a stale or hand-typed underlying is ignored.
 */
export function parseVaultQuery(
  source: { get(name: string): string | null },
  knownUnderlyings: readonly string[] = []
): VaultQuery {
  const underlying = source.get("underlying");
  const tenor = Number(source.get("tenor"));
  return {
    strategy: pickOne(source.get("strategy"), Object.keys(VAULT_STRATEGY_LABELS) as VaultStrategy[]),
    underlying: underlying && knownUnderlyings.includes(underlying) ? underlying : null,
    status: pickOne(source.get("status"), Object.keys(VAULT_STATUS_LABELS) as VaultStatus[]),
    risk: pickOne(source.get("risk"), Object.keys(VAULT_RISK_LABELS) as RiskRating[]),
    tenor: Number.isInteger(tenor) && tenor > 0 ? tenor : null,
    sort: pickOne(source.get("sort"), VAULT_SORT_KEYS) ?? DEFAULT_VAULT_QUERY.sort,
    dir: pickOne(source.get("dir"), ["asc", "desc"] as const) ?? DEFAULT_VAULT_QUERY.dir,
    ids: parseVaultIds(source.get("ids")),
  };
}

/** Serializes a query to a search string, omitting defaults so the default view has a clean URL. */
export function serializeVaultQuery(q: VaultQuery): string {
  const p = new URLSearchParams();
  if (q.strategy) p.set("strategy", q.strategy);
  if (q.underlying) p.set("underlying", q.underlying);
  if (q.status) p.set("status", q.status);
  if (q.risk) p.set("risk", q.risk);
  if (q.tenor) p.set("tenor", String(q.tenor));
  if (q.sort !== DEFAULT_VAULT_QUERY.sort) p.set("sort", q.sort);
  if (q.dir !== DEFAULT_VAULT_QUERY.dir) p.set("dir", q.dir);
  if (q.ids.length) p.set("ids", q.ids.join(","));
  return p.toString();
}

// ---------------------------------------------------------------------------
// Shared metric definitions. Use these wherever APY, utilization, fees or
// drawdown are shown or compared so the numbers mean the same thing everywhere.
// ---------------------------------------------------------------------------

/** Vault status, with `full` derived from TVL reaching capacity. */
export function effectiveStatus(v: VaultSummary): VaultStatus {
  return v.tvl >= v.capacity ? "full" : v.status;
}

/** Share of capacity used (0–1+). */
export function capacityUtilization(v: VaultSummary): number {
  return v.capacity > 0 ? v.tvl / v.capacity : 0;
}

/** Management plus performance fee, in whole percent. */
export function totalFeePct(v: VaultSummary): number {
  return v.feeStructure.managementPct + v.feeStructure.performancePct;
}

function sortValue(v: VaultSummary, key: VaultSortKey): number | null {
  switch (key) {
    case "apy":         return v.apy;
    case "utilization": return capacityUtilization(v);
    case "tvl":         return v.tvl;
    case "drawdown":    return v.maxDrawdownPct;
    case "fees":        return totalFeePct(v);
  }
}

export function filterVaults(vaults: readonly VaultSummary[], q: VaultQuery): VaultSummary[] {
  return vaults.filter(v =>
    (!q.strategy || v.strategy === q.strategy) &&
    (!q.underlying || v.underlying === q.underlying) &&
    (!q.status || effectiveStatus(v) === q.status) &&
    (!q.risk || v.riskRating === q.risk) &&
    (q.tenor === null || v.epochDays === q.tenor)
  );
}

/**
 * Sorts by the query's key and direction. Vaults with no value for the key
 * (e.g. no drawdown history yet) always sort last, and ties break on id so
 * the order is deterministic.
 */
export function sortVaults(vaults: readonly VaultSummary[], q: VaultQuery): VaultSummary[] {
  const sign = q.dir === "asc" ? 1 : -1;
  return [...vaults].sort((a, b) => {
    const av = sortValue(a, q.sort);
    const bv = sortValue(b, q.sort);
    if (av === null && bv === null) return a.id.localeCompare(b.id);
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * sign || a.id.localeCompare(b.id);
  });
}

/** Percent from a 0–1 fraction. Null renders as an em dash. */
export function fmtPct(n: number | null, digits = 1): string {
  return n === null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

/** Whole-percent fee, e.g. 10 → "10%". */
export function fmtFeePct(n: number): string {
  return n === 0 ? "None" : `${n}%`;
}

export function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function fmtStrike(n: number) {
  return n >= 1000
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${n.toFixed(4)}`;
}

/** One epoch record. */
export interface EpochRecord {
  epochNumber: number;
  depositStart: string; // ISO date
  activeStart: string;
  settlementDate: string;
  strike: number;
  expiryDays: number;
  premiumCollected: number; // per share, in USD
  outcome: z.infer<typeof EpochOutcomeSchema>;
  pnlPct: number; // epoch return, positive = profit for depositors
  /** Structured loss event recognized at this epoch's close, if any. */
  lossEvent: VaultLossEvent | null;
}

/**
 * Structured loss event emitted by the vault contract and persisted in the
 * epoch ledger. Mirrors the on-chain `VaultLossEvent`.
 */
export interface VaultLossEvent {
  /** Epoch the loss is attributed to. */
  epoch: number;
  /** Total realized loss in USD recognized at this epoch close. */
  realizedLoss: number;
  /** Portion absorbed by fee/performance-fee reserves. */
  absorbedByFees: number;
  /** Portion absorbed by the first-loss buffer. */
  absorbedByBuffer: number;
  /** Portion written down pro-rata across shareholders. */
  absorbedByShares: number;
  /** Remaining first-loss buffer after the waterfall ran. */
  remainingBuffer: number;
  /** NAV per share after the write-down (clamped at zero). */
  navPerShare: number;
  /** Residual bad debt beyond total NAV (explicit, never an underflow). */
  badDebt: number;
  /** ISO timestamp the loss was recognized. */
  recognizedAt: string;
}

/** Schema version of VaultEpochLedgerEntry. Bump on any breaking field change. */
export const VAULT_EPOCH_LEDGER_SCHEMA_VERSION = 1;

/**
 * One append-only epoch ledger row, derived from on-chain epoch events.
 * Rows are never edited in place; a correction is a new reconciliation row.
 */
export interface VaultEpochLedgerEntry {
  schemaVersion: typeof VAULT_EPOCH_LEDGER_SCHEMA_VERSION;
  vaultId: string;
  epochNumber: number;
  strategy: VaultStrategy;
  startedAt: string; // ISO — on-chain epoch start timestamp
  endedAt: string | null; // ISO — null while the epoch is still open
  premium: number; // USD, total premium collected in the epoch
  realizedPnl: number; // USD
  navBefore: number; // USD per share at epoch start
  navAfter: number | null; // USD per share at epoch end; null while open
  feeTaken: number; // USD, management + performance fees taken in the epoch
  /**
   * Idle-collateral lending yield attributed to this epoch (issue #296).
   * Tracked separately from strategy P&L so yield attribution stays auditable.
   */
  collateralYield?: CollateralYieldLedgerEntry;
}

export interface VaultHistoryFilters {
  vaultId?: string;
  account?: string;
}

export interface VaultHistoryResult {
  receipts: VaultReceipt[];
  /** True when the backend could not be reached and data is degraded. */
  degraded: boolean;
}

const RECEIPTS_STORAGE_KEY = 'zenith.vault.receipts.v1';

function readLocalReceipts(): VaultReceipt[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECEIPTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VaultReceipt[]) : [];
  } catch {
    return [];
  }
}

function writeLocalReceipts(receipts: VaultReceipt[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECEIPTS_STORAGE_KEY, JSON.stringify(receipts));
  } catch {
    // Storage may be unavailable (private mode / quota) — receipts still live
    // in memory for the session.
  }
}

/**
 * Persist a receipt keyed by its idempotency key. Re-submitting the same key
 * updates the existing record instead of creating a duplicate.
 */
export function upsertReceipt(receipt: VaultReceipt): void {
  const existing = readLocalReceipts();
  const idx = existing.findIndex(
    (r) => r.idempotencyKey === receipt.idempotencyKey,
  );
  if (idx >= 0) {
    existing[idx] = receipt;
  } else {
    existing.push(receipt);
  }
  writeLocalReceipts(existing);
}

/**
 * Fetch vault receipts for the given filters. Falls back to locally persisted
 * receipts when the backend is unreachable so the surface never renders blank.
 */
export async function fetchVaultHistory(
  filters: VaultHistoryFilters = {},
): Promise<VaultHistoryResult> {
  const account = filters.account ?? useWalletStore.getState().address ?? undefined;
  const local = readLocalReceipts().filter(
    (r) =>
      (!filters.vaultId || r.vaultId === filters.vaultId) &&
      (!account || r.account === account),
  );

  try {
    const params = new URLSearchParams();
    if (filters.vaultId) params.set('vaultId', filters.vaultId);
    if (account) params.set('account', account);
    const res = await fetch(`/api/vaults/history?${params.toString()}`);
    if (!res.ok) throw new Error(`history ${res.status}`);
    const remote = (await res.json()) as VaultReceipt[];

    // Collapse remote rows with local optimistic rows by idempotency key.
    const merged = new Map<string, VaultReceipt>();
    for (const r of local) merged.set(r.idempotencyKey, r);
    for (const r of remote) merged.set(r.idempotencyKey, r);
    return { receipts: Array.from(merged.values()), degraded: false };
  } catch {
    return { receipts: local, degraded: true };
  }
}

// ---------------------------------------------------------------------------
// Read-only diagnostics client (internal depositor support console)
// ---------------------------------------------------------------------------

/**
 * The only lookup keys the diagnostics console accepts. Each maps to a single
 * consolidated diagnostic view returned by the read-only backend endpoint.
 */
export interface ShadowState {
  /** Always `shadow` — makes the paper-trading label explicit in payloads. */
  mode: "shadow";
  /** Hypothetical NAV-per-share series, one point per complete epoch. */
  navSeries: ShadowNavPoint[];
  /** Shadow epoch record stream (never merged into `historicalEpochs`). */
  epochs: EpochRecord[];
  /** Side-by-side comparison data for the operator console/analytics. */
  comparison: ShadowComparison;
}

/**
 * Promotion criteria that must be met before a shadow strategy can be
 * moved to live allocation. Evaluated by the backend promotion gate; the
 * adapter surfaces the thresholds so the operator console can display
 * progress and block promotion when unmet.
 */
export interface PromotionCriteria {
  /** Minimum number of complete shadow epochs required. */
  minCompleteEpochs: number;
  /** Max allowed |shadow − expected| NAV deviation per share (USD). */
  maxNavDeviation: number;
  /** Whether any invariant violations were recorded during the run. */
  invariantViolations: number;
}

export interface VaultDetail extends VaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string; // ISO — when the current phase ends
  sharePrice: number;
  totalShares: number;
  payoffExplanation: string;
  queue: QueueState;
  fees: FeeAccrual;
  recentEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
  /** Shadow (paper-trading) state, present only for `mode: "shadow"` vaults. */
  shadow?: ShadowState;
  /** Promotion criteria for shadow strategies. */
  promotionCriteria?: PromotionCriteria;
  /** Inflation / donation-attack defense parameters. */
  inflationDefense?: InflationDefenseConfig;
}
