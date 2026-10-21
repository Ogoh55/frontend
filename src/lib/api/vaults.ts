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

/**
 * Start an anchor transaction. The interactive URL is minted by the BFF proxy
 * from server-side credentials — never pass a client-supplied redirect URL.
 */
export async function startAnchorTransaction(input: {
  network: string;
  asset: string;
  direction: AnchorDirection;
  amount: number;
  quoteId: string;
}): Promise<AnchorTransaction> {
  const res = await fetch("/api/vaults/anchor/transaction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to start anchor transaction (${res.status})`);
  return (await res.json()) as AnchorTransaction;
}

/** Poll an anchor transaction's status (low-frequency; used to resume sessions). */
export async function fetchAnchorTransaction(id: string): Promise<AnchorTransaction> {
  const res = await fetch(`/api/vaults/anchor/transaction/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch anchor transaction (${res.status})`);
  return (await res.json()) as AnchorTransaction;
}

// ---------------------------------------------------------------------------
// Recurring auto-deposit (DCA) schedule types
// ---------------------------------------------------------------------------

/** Cadence for a recurring deposit. Boundaries are computed in UTC. */
export type AutoDepositCadence = "daily" | "weekly" | "biweekly" | "monthly";

export type AutoDepositScheduleStatus = "active" | "paused" | "cancelled";

/**
 * Pre-authorization the depositor grants so executions don't require a
 * signature each run. Scope and expiry must be shown in plain language
 * before the user grants it.
 */
export interface AutoDepositAuthorization {
  /** Asset the allowance/trustline covers (e.g. "USDC"). */
  asset: string;
  /** Maximum total the allowance permits across all executions. */
  allowanceCap: number;
  /** Amount already consumed by prior executions. */
  allowanceUsed: number;
  /** ISO timestamp after which the allowance is no longer valid. */
  expiresAt: string;
  /** Whether the required trustline is established. */
  trustlineReady: boolean;
}

/** Why a scheduled execution did not land. Surfaced non-silently in the UI. */
export type AutoDepositFailureReason =
  | "epoch_closed"
  | "deposit_cap_reached"
  | "insufficient_balance"
  | "allowance_expired";

/** A single execution attempt (successful or failed) for a schedule. */
export interface AutoDepositExecution {
  /** Idempotency key: `${scheduleId}:${scheduledSlot}`. */
  idempotencyKey: string;
  /** ISO timestamp of the slot this execution was scheduled for. */
  scheduledSlot: string;
  status: "succeeded" | "failed" | "retrying";
  /** Vault deposit tx id when status === "succeeded". */
  txId: string | null;
  /** Failure reason when status !== "succeeded". */
  failureReason: AutoDepositFailureReason | null;
  /** Human-readable remediation hint shown next to the failure. */
  remediation: string | null;
  /** Number of retries already attempted for this slot. */
  attempts: number;
  executedAt: string | null;
}

/** A persisted recurring deposit plan for a vault. */
export interface AutoDepositSchedule {
  id: string;
  vaultId: string;
  /** Amount of `asset` deposited per execution. */
  amount: number;
  asset: string;
  cadence: AutoDepositCadence;
  status: AutoDepositScheduleStatus;
  /** ISO timestamp of the next scheduled execution. */
  nextRunAt: string;
  /** Optional ISO end date after which no further executions occur. */
  endDate: string | null;
  /** Optional maximum cumulative amount deposited across all executions. */
  maxTotal: number | null;
  /** Cumulative amount deposited so far. */
  totalDeposited: number;
  authorization: AutoDepositAuthorization;
  /** Most recent execution attempts, newest first. */
  recentExecutions: AutoDepositExecution[];
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a schedule. */
export interface CreateAutoDepositScheduleInput {
  amount: number;
  asset: string;
  cadence: AutoDepositCadence;
  endDate?: string | null;
  maxTotal?: number | null;
  /** ISO timestamp the pre-authorization expires at. */
  authorizationExpiresAt: string;
}

/** Patch for editing a schedule. Only mutable fields are accepted. */
export type UpdateAutoDepositScheduleInput = Partial<
  Pick<CreateAutoDepositScheduleInput, "amount" | "cadence" | "endDate" | "maxTotal">
>;

/**
 * Compute the next run timestamp for a cadence, anchored to `from` in UTC.
 * Monthly cadence clamps to the last day of shorter months so a schedule
 * created on the 31st does not skip February.
 */
export function computeNextRunAt(from: Date, cadence: AutoDepositCadence): Date {
  const next = new Date(from.getTime());
  switch (cadence) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case "biweekly":
      next.setUTCDate(next.getUTCDate() + 14);
      break;
    case "monthly": {
      const day = next.getUTCDate();
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + 1);
      const lastDay = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
      ).getUTCDate();
      next.setUTCDate(Math.min(day, lastDay));
      break;
    }
  }
  return next;
}

/** Build the idempotency key for a (schedule, slot) pair. */
export function autoDepositIdempotencyKey(scheduleId: string, scheduledSlot: string): string {
  return `${scheduleId}:${scheduledSlot}`;
}

/** List schedules for a vault, persisted server-side against the account. */
export async function fetchAutoDepositSchedules(vaultId: string): Promise<AutoDepositSchedule[]> {
  const res = await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/schedules`);
  if (!res.ok) throw new Error(`Failed to load schedules (${res.status})`);
  return (await res.json()) as AutoDepositSchedule[];
}

/** Create a recurring deposit schedule. */
export async function createAutoDepositSchedule(
  vaultId: string,
  input: CreateAutoDepositScheduleInput,
): Promise<AutoDepositSchedule> {
  const res = await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to create schedule (${res.status})`);
  return (await res.json()) as AutoDepositSchedule;
}

/** Edit a schedule's mutable fields. */
export async function updateAutoDepositSchedule(
  vaultId: string,
  scheduleId: string,
  input: UpdateAutoDepositScheduleInput,
): Promise<AutoDepositSchedule> {
  const res = await fetch(
    `/api/vaults/${encodeURIComponent(vaultId)}/schedules/${encodeURIComponent(scheduleId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`Failed to update schedule (${res.status})`);
  return (await res.json()) as AutoDepositSchedule;
}

/** Pause a schedule so no further executions occur until resumed. */
export async function pauseAutoDepositSchedule(
  vaultId: string,
  scheduleId: string,
): Promise<AutoDepositSchedule> {
  const res = await fetch(
    `/api/vaults/${encodeURIComponent(vaultId)}/schedules/${encodeURIComponent(scheduleId)}/pause`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Failed to pause schedule (${res.status})`);
  return (await res.json()) as AutoDepositSchedule;
}

/** Resume a paused schedule. */
export async function resumeAutoDepositSchedule(
  vaultId: string,
  scheduleId: string,
): Promise<AutoDepositSchedule> {
  const res = await fetch(
    `/api/vaults/${encodeURIComponent(vaultId)}/schedules/${encodeURIComponent(scheduleId)}/resume`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Failed to resume schedule (${res.status})`);
  return (await res.json()) as AutoDepositSchedule;
}

/** Cancel (delete) a schedule permanently. */
export async function cancelAutoDepositSchedule(
  vaultId: string,
  scheduleId: string,
): Promise<void> {
  const res = await fetch(
    `/api/vaults/${encodeURIComponent(vaultId)}/schedules/${encodeURIComponent(scheduleId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Failed to cancel schedule (${res.status})`);
}
