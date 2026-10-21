/**
 * Typed data adapter interface for the Vaults feature.
 *
 * The vault smart contracts and backend API are not yet available.
 * When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
 * implementation below is used. Swap in the real implementation by
 * setting NEXT_PUBLIC_VAULTS=live and implementing `fetchVaultsLive`.
 *
 * Backend contract (for when the real API lands):
 *
 *   GET /api/v1/vaults
 *   → VaultSummary[]
 *
 *   GET /api/v1/vaults/{id}
 *   → VaultDetail
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
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
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  /** Trailing 12-month APY estimate (0–1, e.g. 0.18 = 18%). */
  apy: number;
  /** APY methodology note shown in tooltip. */
  apyMethodology: string;
  /** Total value locked in USD. */
  tvl: number;
  /** Maximum TVL before the vault is full. */
  capacity: number;
  currentStrike: number;
  currentExpiry: string; // ISO date
  riskRating: RiskRating;
  description: string;
}

/** One historical epoch record. */
export interface EpochRecord {
  epochNumber: number;
  depositStart: string; // ISO
  activeStart: string;
  settlementDate: string;
  strike: number;
  expiryDays: number;
  premiumCollected: number; // per share, in USD
  outcome: "expired_worthless" | "exercised" | "active";
  pnlPct: number; // epoch return, positive = profit for depositors
}

/** The user's position in a vault. */
export interface UserVaultPosition {
  shares: number;
  shareValue: number; // current USD value per share
  totalValue: number;
  accruedPremium: number;
  pendingWithdrawal: number; // shares queued for withdrawal at epoch end
}

/** Full detail for a single vault. */
export interface VaultDetail extends VaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string; // ISO — when the current phase ends
  sharePrice: number; // current NAV per share in USD
  totalShares: number;
  feeStructure: { managementPct: number; performancePct: number };
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
}

// ---------------------------------------------------------------------------
// Vault-written options supply (issue #267)
// ---------------------------------------------------------------------------

/**
 * Per-contract vault supply for one strike within an expiry. `vaultOi` is the
 * open interest written by vault strategies; `totalOi` is the full book OI
 * (exchange + vault). `shareOfOi` is `vaultOi / totalOi` in [0, 1].
 */
export interface VaultStrikeSupply {
  strike: number;
  /** "call" | "put" — vault strategies write both. */
  optionType: "call" | "put";
  vaultOi: number;
  totalOi: number;
  /** Fraction of total OI supplied by vaults (0–1). */
  shareOfOi: number;
}

/**
 * Aggregated vault supply summary for one (underlying, expiry). Returned by
 * the backend in a single request so the chain can join it client-side
 * without a per-row N+1 fetch.
 */
export interface VaultSupplySummary {
  underlying: string;
  expiry: string; // ISO date
  /** Per-strike breakdown; may be empty when no vault supply exists. */
  strikes: VaultStrikeSupply[];
  /** Total vault OI across all strikes for this expiry. */
  totalVaultOi: number;
  /** Total book OI across all strikes for this expiry. */
  totalOi: number;
  /** Fraction of the displayed book that is vault-supplied (0–1). */
  shareOfOi: number;
  /** ISO timestamp the summary was computed at. */
  asOf: string;
}

/**
 * Fetch the aggregated vault supply summary for an (underlying, expiry).
 *
 * Returns `null` when the supply source is unavailable (404/5xx/network
 * error) so callers can degrade gracefully and render the chain exactly as
 * before — never fabricate zeros. A successful response with an empty
 * `strikes` array means "no vault supply", which is distinct from `null`.
 */
export async function fetchVaultSupplySummary(
  underlying: string,
  expiry: string,
): Promise<VaultSupplySummary | null> {
  const params = new URLSearchParams({ underlying, expiry });
  try {
    const res = await fetch(`/api/v1/vaults/supply?${params.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as VaultSupplySummary;
  } catch {
    return null;
  }
}

/**
 * Join a supply summary into a chain row keyed by (strike, optionType).
 * Tolerant of missing rows: returns `null` when the summary is absent or the
 * contract has no vault supply, so callers never render placeholder zeros.
 */
export function joinVaultSupply(
  summary: VaultSupplySummary | null,
  strike: number,
  optionType: "call" | "put",
): VaultStrikeSupply | null {
  if (!summary) return null;
  const match = summary.strikes.find(
    (s) => s.strike === strike && s.optionType === optionType,
  );
  if (!match || match.vaultOi <= 0) return null;
  return match;
}

// ---------------------------------------------------------------------------
// Fiat on-ramp / off-ramp (anchor) types
// ---------------------------------------------------------------------------

export type AnchorDirection = "deposit" | "withdraw";

/** SEP protocol the anchor exposes for a given network/asset. */
export type AnchorProtocol = "sep24" | "sep6";

/**
 * Anchor availability for a network/asset pair. Returned by the BFF proxy.
 * `null` from `fetchAnchorConfig` means no anchor is configured, in which
 * case the "Fund from bank" / "Cash out" entry points must be hidden.
 */
export interface AnchorConfig {
  anchorId: string;
  anchorName: string;
  network: string;
  asset: string;
  /** Protocols supported for this asset (SEP-24 interactive is required). */
  protocols: AnchorProtocol[];
  /** Minimum fiat amount the anchor will accept, in `fiatCurrency`. */
  minAmount: number;
  maxAmount: number;
  fiatCurrency: string;
}

/**
 * Normalized quote/preview shown before the user commits. Never route funds
 * without surfacing this to the user first.
 */
export interface AnchorQuote {
  quoteId: string;
  direction: AnchorDirection;
  /** Amount the user typed, in `fiatCurrency` for deposits or asset units for withdrawals. */
  amount: number;
  fiatCurrency: string;
  asset: string;
  /** Effective rate: fiat per 1 asset unit. */
  rate: number;
  /** Total fees in `fiatCurrency`. */
  feeTotal: number;
  /** Amount of `asset` the user will receive (deposit) or fiat they will receive (withdraw). */
  receiveAmount: number;
  /** Estimated arrival, ISO timestamp. */
  estimatedArrival: string;
  /** Quote expiry, ISO timestamp. After this the user must re-quote. */
  expiresAt: string;
}

/**
 * Normalized anchor transaction lifecycle. This is a separate state machine
 * from the vault deposit: a refund/expiry here must never mutate vault state.
 */
export type AnchorTransactionStatus =
  | "pending"
  | "incomplete"
  | "completed"
  | "refunded"
  | "expired"
  | "error";

export interface AnchorTransaction {
  id: string;
  direction: AnchorDirection;
  status: AnchorTransactionStatus;
  asset: string;
  amount: number;
  fiatCurrency: string;
  /** SEP-24 interactive URL minted server-side; used to open/resume the flow. */
  interactiveUrl: string | null;
  /** Human-readable status/refund message (no PII). */
  message: string | null;
  /** Stellar tx hash once the anchor settles on-chain, if available. */
  stellarTxHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fetch anchor availability for a network/asset. Returns `null` when no
 * anchor is configured — callers must treat this as "hide the entry point".
 */
export async function fetchAnchorConfig(
  network: string,
  asset: string,
): Promise<AnchorConfig | null> {
  const params = new URLSearchParams({ network, asset });
  const res = await fetch(`/api/vaults/anchor/config?${params.toString()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load anchor config (${res.status})`);
  return (await res.json()) as AnchorConfig | null;
}

/** Request a quote/preview. Must be shown to the user before committing. */
export async function fetchAnchorQuote(input: {
  network: string;
  asset: string;
  direction: AnchorDirection;
  amount: number;
}): Promise<AnchorQuote> {
  const res = await fetch("/api/vaults/anchor/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to fetch anchor quote (${res.status})`);
  return (await res.json()) as AnchorQuote;
}
