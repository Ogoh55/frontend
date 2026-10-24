import { z } from "zod";
import { env } from "../../env";
import { bffFetch } from "./client";
import { ContractError, reportContractError } from "./contractError";
import { toCsv, type CsvColumn } from "../csv";
import freighterApi from "@stellar/freighter-api";
import { apiPost, type RequestOptions } from "./client";
import { submitTransactionXdr } from "./stellar";

/**
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
 *   GET /api/v1/vaults/privacy/deletion-request/{id}
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

export const VAULTS_API_VERSION = "v1" as const;
const API = `/api/${VAULTS_API_VERSION}/vaults`;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_PAGES = 20;

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

/**
 * On-chain NAV / share-price feed entry (issue #277).
 *
 * The feed contract is a thin, append-only reader of committed values — the
 * vault remains the single source of truth. Consumers should read this shape
 * rather than deriving a price themselves.
 *
 * Consumer contract:
 * - `navPerShare` is the committed NAV per share for `epoch`, denominated in
 *   `denomination` (explicitly stated; multi-asset vaults report the quote
 *   asset, e.g. "USD").
 * - `decimals` is the number of decimals consumers must assume for
 *   `navPerShare` (and `shareSupply`). Do not infer precision from the value.
 * - `schemaVersion` lets consumers detect a breaking change to this shape.
 * - `updatedAt` is the ledger time of the update. A value is STALE when
 *   `now - updatedAt > stalenessThresholdSecs`; a stale value means the vault
 *   skipped or delayed an epoch and the price must NOT be trusted as current.
 *   Stale values are reported, never silently refreshed.
 * - Rounding: `navPerShare` is truncated (not rounded up) to `decimals`; very
 *   small share supplies may therefore lose precision — consumers must treat
 *   the value as a lower bound, not an exact quote.
 */
export interface NavFeedEntry {
  /** Feed schema version; bump on any breaking change to this shape. */
  schemaVersion: number;
  /** Vault the value belongs to. */
  vaultId: string;
  /** Committed NAV per share, scaled by 10^decimals. */
  navPerShare: number;
  /** Decimals consumers must assume for navPerShare / shareSupply. */
  decimals: number;
  /** Denomination of navPerShare (explicit for multi-asset vaults). */
  denomination: string;
  /** Epoch number the committed value came from. */
  epoch: number;
  /** Ledger time (ISO) the feed entry was last updated. */
  updatedAt: string;
  /** Total share supply at commit time, scaled by 10^decimals. */
  shareSupply: number;
  /** Age (seconds) beyond which the value is considered stale. */
  stalenessThresholdSecs: number;
}

/**
 * On-chain share-balance Merkle commitment for one epoch (issue #278).
 *
 * Tree construction spec (canonical, versioned via `commitmentVersion`):
 * - Leaf encoding: `sha256(0x00 || account_utf8 || 0x00 || balance_u128_be)`.
 *   `account` is the canonical Stellar account string (G.../C...); `balance`
 *   is the share balance scaled by 10^decimals, encoded as a 16-byte
 *   big-endian unsigned integer. The 0x00 domain prefix separates leaves
 *   from internal nodes.
 * - Ordering rule: leaves are sorted ascending by the raw 32-byte leaf hash
 *   (byte-wise lexicographic). Ordering is therefore independent of input
 *   order and stable across implementations.
 * - Internal nodes: `sha256(0x01 || left || right)`.
 * - Odd node at any level is promoted unchanged to the next level (no
 *   duplication). An empty epoch commits the all-zero root; a single-holder
 *   epoch commits that holder's leaf hash as the root.
 * - Max committed size: 4096 leaves per epoch (Soroban resource budget).
 *   Epochs exceeding this commit a `chunked` commitment: the root is the
 *   root over per-chunk roots, and `chunkCount` is published so verifiers can
 *   reconstruct the same tree.
 */
export interface EpochCommitment {
  /** Commitment schema version; bump on any breaking change to the spec. */
  commitmentVersion: number;
  /** Vault the commitment belongs to. */
  vaultId: string;
  /** Epoch number the snapshot was taken at. */
  epoch: number;
  /** Merkle root over the epoch's share balances (hex, 0x-prefixed). */
  merkleRoot: string;
  /** Number of leaves committed in the epoch. */
  leafCount: number;
  /** Number of chunks when the epoch exceeded the max committed size. */
  chunkCount: number;
  /** NAV per share committed alongside the root, scaled by 10^decimals. */
  navPerShare: number;
  /** Decimals for navPerShare / balances. */
  decimals: number;
  /** Ledger time (ISO) the commitment was written on-chain. */
  committedAt: string;
}

/** Merkle proof for a single depositor's share balance at an epoch. */
export interface ShareBalanceProof {
  /** Vault the proof belongs to. */
  vaultId: string;
  /** Epoch the proof is against. */
  epoch: number;
  /** Account the balance belongs to. */
  account: string;
  /** Share balance, scaled by 10^decimals. */
  balance: number;
  /** Sibling hashes from leaf to root (hex, 0x-prefixed). */
  proof: string[];
  /** Root the proof should verify against. */
  merkleRoot: string;
}

/**
 * Option leg type for a written position (issue #279).
 * `call`/`put` are single-leg; `iron_condor` positions carry two legs and
 * are represented as two `WrittenPosition` rows sharing a `groupId`.
 */
export type OptionType = "call" | "put";

/**
 * One open written option position held by a vault (issue #279).
 *
 * These are the inputs the risk panel needs to compute assignment
 * probability, max loss, breakeven, and aggregate Greeks. All fields are
 * sourced from the same places used elsewhere in the app (spot from the
 * vault's underlying price feed, IV from the pricing layer, strike/expiry
 * from the vault contract).
 *
 * Consumers must treat any `null` input as "unavailable" and degrade the
 * panel rather than substituting a default — a missing IV or stale spot feed
 * must never render a modelled number.
 */
export interface WrittenPosition {
  /** Stable id for the position (used as React key / memo key). */
  id: string;
  /** Vault that wrote the position. */
  vaultId: string;
  /** Epoch the position was written in. */
  epoch: number;
  /** Strategy bucket the position belongs to. */
  strategy: VaultStrategy;
  /** Leg type. */
  type: OptionType;
  /** Strike price in the underlying's quote currency. */
  strike: number;
  /** Expiry as an ISO date. */
  expiry: string;
  /** Number of contracts written (1 contract = 100 shares). */
  contracts: number;
  /** Notional in USD (contracts * 100 * spot at write time). */
  notional: number;
  /** Premium collected per contract, in USD. */
  premiumPerContract: number;
  /** Implied volatility used for pricing (annualised, e.g. 0.65 = 65%). */
  impliedVol: number | null;
  /** Spot price of the underlying at the time of the snapshot. */
  spot: number | null;
  /** Ledger time (ISO) the spot/IV inputs were captured. */
  inputsAsOf: string | null;
  /** Optional backend-provided Greeks; override local estimates when set. */
  greeks?: Partial<PositionGreeks> | null;
  /** Optional backend-provided assignment probability (0–1). */
  assignmentProbability?: number | null;
  /** Groups legs of a multi-leg strategy (e.g. iron condor). */
  groupId?: string | null;
}

/** Per-position Greeks (issue #279). */
export interface PositionGreeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
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

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  /** Execution mode; `shadow` results are paper trading, not realized. */
  mode: VaultMode;
  status: VaultStatus;
  /** Trailing 12-month APY estimate (0–1, e.g. 0.18 = 18%). */
  apy: number;
  /** APY methodology note shown in tooltip. */
  apyMethodology: string;
  /** Total value locked in USD. */
  tvl: number;
  /** Maximum TVL before the vault is full. */
  capacity: number;
  /** tvl / capacity (0–1). */
  utilisation: number;
  currentStrike: number;
  currentExpiry: string; // ISO date
  riskRating: RiskRating;
  description: string;
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
  return vaults.filter
