/**
 * Vault Commitments — pure logic module
 *
 * Models the institutional commitment / capital-call lifecycle for vault LPs.
 * All functions are pure (no network, no DOM, injectable timestamps) for
 * deterministic unit testing.
 *
 * ─────────────────────────────────────────────────────────────────
 * COMMITMENT MODEL
 * ─────────────────────────────────────────────────────────────────
 *
 *  An LP subscribes with a committed amount (e.g. $1 000 000).
 *  The vault operator issues capital calls against that commitment.
 *  Each call has a grace period; the LP must fund it before the
 *  deadline or be transitioned to DEFAULTED.
 *
 *  Commitment states:
 *    PENDING_ACKNOWLEDGEMENT  — created, waiting for LP to sign/acknowledge
 *    ACTIVE                   — acknowledged; capital calls may be issued
 *    FULLY_CALLED             — remainingCallable === 0
 *    EXPIRED                  — passed expiry date before being fully called
 *    CANCELLED                — explicitly cancelled by operator or LP
 *
 *  Capital-call states:
 *    ISSUED        — call created, awaiting LP funding
 *    PARTIALLY_FUNDED — LP funded part of the call amount
 *    FUNDED        — LP funded the full call amount (or operator waived remainder)
 *    DEFAULTED     — grace period elapsed with insufficient funding
 *    WAIVED        — operator waived the unfunded remainder (no default)
 *    LATE_PAID     — funded after default was recorded (operator discretion)
 *
 * ─────────────────────────────────────────────────────────────────
 * ACCOUNTING RULES (NAV ISOLATION)
 * ─────────────────────────────────────────────────────────────────
 *
 *  1. Unfunded / uncalled commitments NEVER affect NAV or share price.
 *  2. A capital call in ISSUED or PARTIALLY_FUNDED state is a contingent
 *     liability but does NOT count as vault assets until funded.
 *  3. Funded capital mints shares at the NAV of the epoch in which the
 *     funding transaction lands (not at call-issuance time).
 *  4. A DEFAULT must be explicitly recorded. It does NOT reduce other
 *     LPs' share of NAV — the vault simply has less capacity than
 *     expected, which is reflected by updating the capacity reservation.
 *  5. Partial funding mints shares for the funded portion at the
 *     current NAV; the unfunded remainder stays as an open call.
 *
 * ─────────────────────────────────────────────────────────────────
 * CAPACITY RESERVATION
 * ─────────────────────────────────────────────────────────────────
 *
 *  Vaults may be configured to reserve capacity for callable commitments
 *  (RESERVE_CAPACITY_FOR_COMMITMENTS = true). In that mode:
 *    - remainingCallable counts against the vault's available capacity.
 *    - On default or cancellation, the reserved capacity is released.
 *  When false, commitments do not reserve capacity.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default grace period (ms) between call issuance and default deadline. */
export const DEFAULT_GRACE_PERIOD_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

/** Minimum call amount in USD. */
export const MIN_CALL_AMOUNT_USD = 1_000;

/** Tolerance for floating-point comparisons (USD). */
export const AMOUNT_EPSILON = 0.01;

// ---------------------------------------------------------------------------
// Enums / union types
// ---------------------------------------------------------------------------

export type CommitmentState =
  | "PENDING_ACKNOWLEDGEMENT"
  | "ACTIVE"
  | "FULLY_CALLED"
  | "EXPIRED"
  | "CANCELLED";

export type CapitalCallState =
  | "ISSUED"
  | "PARTIALLY_FUNDED"
  | "FUNDED"
  | "DEFAULTED"
  | "WAIVED"
  | "LATE_PAID";

// ---------------------------------------------------------------------------
// Core data types
// ---------------------------------------------------------------------------

/** An LP's commitment to a vault. */
export interface VaultCommitment {
  id: string;
  vaultId: string;
  lpWalletAddress: string;
  /** Total amount committed (USD). */
  committedAmount: number;
  /** Sum of all call amounts issued against this commitment. */
  calledAmount: number;
  /** committedAmount − calledAmount; never negative. */
  remainingCallable: number;
  state: CommitmentState;
  /** ISO-8601 timestamp when the commitment was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the LP acknowledged and signed. Null if pending. */
  acknowledgedAt: string | null;
  /** ISO-8601 date after which uncalled balance expires. */
  expiresAt: string;
  /** Whether this commitment reserves vault capacity. */
  reservesCapacity: boolean;
  /** Notes from the operator (displayed to LP). */
  notes: string;
}

/** A single capital call issued against a commitment. */
export interface CapitalCall {
  id: string;
  commitmentId: string;
  vaultId: string;
  lpWalletAddress: string;
  /** Amount requested in this call (USD). */
  callAmount: number;
  /** Amount funded so far (USD). */
  fundedAmount: number;
  state: CapitalCallState;
  /** ISO-8601 timestamp when the call was issued. */
  issuedAt: string;
  /** ISO-8601 deadline for funding before default. */
  fundingDeadline: string;
  /** ISO-8601 timestamp when fully funded (or waived). Null otherwise. */
  settledAt: string | null;
  /** Epoch number in which funding landed (for share minting). Null if unfunded. */
  fundingEpoch: number | null;
  /** Share price at time of funding (for share calculation). Null if unfunded. */
  sharePrice: number | null;
  /** Shares minted as a result of funding. Null if unfunded. */
  sharesMinted: number | null;
  /** Operator note (reason for call, waiver, etc.). */
  note: string;
}

/** Immutable event log entry for audit trail. */
export interface CommitmentEvent {
  id: string;
  commitmentId: string;
  capitalCallId: string | null;
  /** Event type for filtering/display. */
  type:
    | "COMMITMENT_CREATED"
    | "COMMITMENT_ACKNOWLEDGED"
    | "CALL_ISSUED"
    | "CALL_FUNDED"
    | "CALL_PARTIALLY_FUNDED"
    | "CALL_DEFAULTED"
    | "CALL_WAIVED"
    | "CALL_LATE_PAID"
    | "COMMITMENT_EXPIRED"
    | "COMMITMENT_CANCELLED"
    | "COMMITMENT_FULLY_CALLED";
  occurredAt: string; // ISO-8601
  actorAddress: string;
  metadata: Record<string, string | number | boolean | null>;
}

/** Summary of a commitment with its open calls. */
export interface CommitmentSummary {
  commitment: VaultCommitment;
  openCalls: CapitalCall[];
  recentEvents: CommitmentEvent[];
}

// ---------------------------------------------------------------------------
// Remaining-callable math
// ---------------------------------------------------------------------------

/**
 * Compute remaining callable amount from a commitment's current state.
 *
 * Remaining = committedAmount − calledAmount, clamped to [0, committedAmount].
 * We never allow it to go negative due to floating-point drift.
 */
export function computeRemainingCallable(
  committedAmount: number,
  calledAmount: number,
): number {
  return Math.max(0, committedAmount - calledAmount);
}

/**
 * Validate that a proposed call amount does not exceed the remaining callable.
 * Returns an error string or null if valid.
 */
export function validateCallAmount(
  callAmount: number,
  remainingCallable: number,
  commitmentState: CommitmentState,
): string | null {
  if (commitmentState !== "ACTIVE") {
    return `Cannot issue a call on a commitment in state ${commitmentState}. Commitment must be ACTIVE.`;
  }
  if (callAmount < MIN_CALL_AMOUNT_USD) {
    return `Call amount must be at least $${MIN_CALL_AMOUNT_USD.toLocaleString("en-US")}.`;
  }
  if (callAmount > remainingCallable + AMOUNT_EPSILON) {
    return `Call amount ($${callAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}) exceeds remaining callable ($${remainingCallable.toLocaleString("en-US", { minimumFractionDigits: 2 })}).`;
  }
  return null;
}

/**
 * Validate that a funding amount is valid for an open call.
 */
export function validateFundingAmount(
  fundingAmount: number,
  call: CapitalCall,
): string | null {
  if (call.state !== "ISSUED" && call.state !== "PARTIALLY_FUNDED") {
    return `Cannot fund a call in state ${call.state}.`;
  }
  if (fundingAmount <= 0) {
    return "Funding amount must be greater than zero.";
  }
  const unfunded = call.callAmount - call.fundedAmount;
  if (fundingAmount > unfunded + AMOUNT_EPSILON) {
    return `Funding amount ($${fundingAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}) exceeds unfunded remainder ($${unfunded.toLocaleString("en-US", { minimumFractionDigits: 2 })}).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// State transition validators
// ---------------------------------------------------------------------------

/**
 * Returns whether a commitment can transition from its current state to `next`.
 */
export function isValidCommitmentTransition(
  current: CommitmentState,
  next: CommitmentState,
): boolean {
  const allowed: Record<CommitmentState, CommitmentState[]> = {
    PENDING_ACKNOWLEDGEMENT: ["ACTIVE", "CANCELLED"],
    ACTIVE:                  ["FULLY_CALLED", "EXPIRED", "CANCELLED"],
    FULLY_CALLED:            [],
    EXPIRED:                 [],
    CANCELLED:               [],
  };
  return (allowed[current] ?? []).includes(next);
}

/**
 * Returns whether a capital call can transition from its current state to `next`.
 */
export function isValidCallTransition(
  current: CapitalCallState,
  next: CapitalCallState,
): boolean {
  const allowed: Record<CapitalCallState, CapitalCallState[]> = {
    ISSUED:           ["PARTIALLY_FUNDED", "FUNDED", "DEFAULTED", "WAIVED"],
    PARTIALLY_FUNDED: ["FUNDED", "DEFAULTED", "WAIVED"],
    FUNDED:           [],
    DEFAULTED:        ["LATE_PAID", "WAIVED"],
    WAIVED:           [],
    LATE_PAID:        [],
  };
  return (allowed[current] ?? []).includes(next);
}

// ---------------------------------------------------------------------------
// Default detection
// ---------------------------------------------------------------------------

/**
 * Returns true if a call is past its funding deadline and not yet settled.
 */
export function isCallPastDeadline(call: CapitalCall, nowMs: number): boolean {
  if (call.state === "FUNDED" || call.state === "WAIVED" || call.state === "LATE_PAID") {
    return false;
  }
  return nowMs > new Date(call.fundingDeadline).getTime();
}

/**
 * Returns calls that should be transitioned to DEFAULTED.
 * A call is defaultable if: past deadline AND state is ISSUED or PARTIALLY_FUNDED.
 */
export function findDefaultableCalls(
  calls: CapitalCall[],
  nowMs: number,
): CapitalCall[] {
  return calls.filter(
    c =>
      (c.state === "ISSUED" || c.state === "PARTIALLY_FUNDED") &&
      isCallPastDeadline(c, nowMs),
  );
}

// ---------------------------------------------------------------------------
// Commitment expiry
// ---------------------------------------------------------------------------

/**
 * Returns true if a commitment has passed its expiry date.
 */
export function isCommitmentExpired(
  commitment: VaultCommitment,
  nowMs: number,
): boolean {
  if (commitment.state !== "ACTIVE") return false;
  return nowMs > new Date(commitment.expiresAt).getTime();
}

// ---------------------------------------------------------------------------
// NAV impact helpers
// ---------------------------------------------------------------------------

/**
 * Compute the total funded (NAV-affecting) capital across all calls.
 *
 * Only FUNDED, LATE_PAID, and partially-funded amounts count.
 * ISSUED / DEFAULTED / WAIVED unfunded portions do NOT count.
 */
export function totalFundedCapital(calls: CapitalCall[]): number {
  return calls.reduce((sum, c) => sum + c.fundedAmount, 0);
}

/**
 * Compute the total contingent liability (called but not yet funded).
 * This is informational only — it NEVER enters NAV.
 */
export function totalContingentLiability(calls: CapitalCall[]): number {
  return calls
    .filter(c => c.state === "ISSUED" || c.state === "PARTIALLY_FUNDED")
    .reduce((sum, c) => sum + (c.callAmount - c.fundedAmount), 0);
}

/**
 * Compute shares to mint for a funding event at a given share price.
 *
 * shares = fundingAmount / sharePrice
 * Returns 0 if sharePrice ≤ 0 (guarded against division by zero).
 */
export function computeSharesFromFunding(
  fundingAmount: number,
  sharePrice: number,
): number {
  if (sharePrice <= 0) return 0;
  return fundingAmount / sharePrice;
}

// ---------------------------------------------------------------------------
// Capacity reservation
// ---------------------------------------------------------------------------

/**
 * Returns the capacity reserved by active commitments (if they reserve capacity).
 *
 * Only ACTIVE commitments with reservesCapacity=true contribute.
 * FULLY_CALLED, EXPIRED, CANCELLED contribute zero.
 */
export function totalReservedCapacity(commitments: VaultCommitment[]): number {
  return commitments
    .filter(c => c.state === "ACTIVE" && c.reservesCapacity)
    .reduce((sum, c) => sum + c.remainingCallable, 0);
}

/**
 * Returns available vault capacity accounting for reservations.
 *
 * available = vaultCapacity − currentTVL − reservedByCommitments
 */
export function availableCapacity(
  vaultCapacity: number,
  currentTvl: number,
  commitments: VaultCommitment[],
): number {
  const reserved = totalReservedCapacity(commitments);
  return Math.max(0, vaultCapacity - currentTvl - reserved);
}

// ---------------------------------------------------------------------------
// Lifecycle constructors (pure — produce plain objects, no side effects)
// ---------------------------------------------------------------------------

/**
 * Build a new commitment object (does not persist — caller sends to API).
 */
export function buildCommitment(params: {
  id: string;
  vaultId: string;
  lpWalletAddress: string;
  committedAmount: number;
  expiresAt: string;
  reservesCapacity: boolean;
  notes?: string;
  nowIso: string;
}): VaultCommitment {
  return {
    id: params.id,
    vaultId: params.vaultId,
    lpWalletAddress: params.lpWalletAddress,
    committedAmount: params.committedAmount,
    calledAmount: 0,
    remainingCallable: params.committedAmount,
    state: "PENDING_ACKNOWLEDGEMENT",
    createdAt: params.nowIso,
    acknowledgedAt: null,
    expiresAt: params.expiresAt,
    reservesCapacity: params.reservesCapacity,
    notes: params.notes ?? "",
  };
}

/**
 * Build a new capital call object.
 */
export function buildCapitalCall(params: {
  id: string;
  commitmentId: string;
  vaultId: string;
  lpWalletAddress: string;
  callAmount: number;
  gracePeriodMs?: number;
  note?: string;
  nowIso: string;
}): CapitalCall {
  const issuedMs = new Date(params.nowIso).getTime();
  const gracePeriodMs = params.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const deadlineIso = new Date(issuedMs + gracePeriodMs).toISOString();
  return {
    id: params.id,
    commitmentId: params.commitmentId,
    vaultId: params.vaultId,
    lpWalletAddress: params.lpWalletAddress,
    callAmount: params.callAmount,
    fundedAmount: 0,
    state: "ISSUED",
    issuedAt: params.nowIso,
    fundingDeadline: deadlineIso,
    settledAt: null,
    fundingEpoch: null,
    sharePrice: null,
    sharesMinted: null,
    note: params.note ?? "",
  };
}

/**
 * Apply a funding event to a call and return updated call + commitment.
 *
 * This function encodes the accounting rules:
 *   - fundedAmount is incremented.
 *   - If fully funded, call transitions to FUNDED; settledAt is set.
 *   - sharesMinted = fundingAmount / sharePrice.
 *   - calledAmount on commitment is NOT changed (it was set at call issuance).
 *   - remainingCallable on commitment is NOT changed (it was set at call issuance).
 *   - commitment transitions to FULLY_CALLED if remainingCallable becomes 0.
 *
 * Returns { updatedCall, updatedCommitment }.
 */
export function applyFunding(params: {
  call: CapitalCall;
  commitment: VaultCommitment;
  fundingAmount: number;
  sharePrice: number;
  fundingEpoch: number;
  nowIso: string;
}): { updatedCall: CapitalCall; updatedCommitment: VaultCommitment } {
  const { call, commitment, fundingAmount, sharePrice, fundingEpoch, nowIso } = params;

  const newFundedAmount = call.fundedAmount + fundingAmount;
  const fullyFunded = newFundedAmount >= call.callAmount - AMOUNT_EPSILON;
  const newShares = computeSharesFromFunding(fundingAmount, sharePrice);

  const updatedCall: CapitalCall = {
    ...call,
    fundedAmount: newFundedAmount,
    state: fullyFunded ? "FUNDED" : "PARTIALLY_FUNDED",
    settledAt: fullyFunded ? nowIso : null,
    fundingEpoch,
    sharePrice,
    sharesMinted: (call.sharesMinted ?? 0) + newShares,
  };

  // Commitment transitions to FULLY_CALLED if nothing more can be called
  const newRemainingCallable = computeRemainingCallable(
    commitment.committedAmount,
    commitment.calledAmount,
  );
  const commitmentFullyCalled = newRemainingCallable <= AMOUNT_EPSILON;

  const updatedCommitment: VaultCommitment = {
    ...commitment,
    state: commitmentFullyCalled && fullyFunded ? "FULLY_CALLED" : commitment.state,
  };

  return { updatedCall, updatedCommitment };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function commitmentStateLabel(state: CommitmentState): string {
  switch (state) {
    case "PENDING_ACKNOWLEDGEMENT": return "Pending Acknowledgement";
    case "ACTIVE":                  return "Active";
    case "FULLY_CALLED":            return "Fully Called";
    case "EXPIRED":                 return "Expired";
    case "CANCELLED":               return "Cancelled";
  }
}

export function commitmentStateColor(state: CommitmentState): string {
  switch (state) {
    case "PENDING_ACKNOWLEDGEMENT": return "var(--atm)";
    case "ACTIVE":                  return "var(--call)";
    case "FULLY_CALLED":            return "var(--brand)";
    case "EXPIRED":                 return "var(--text-lo)";
    case "CANCELLED":               return "var(--put)";
  }
}

export function callStateLabel(state: CapitalCallState): string {
  switch (state) {
    case "ISSUED":           return "Awaiting Funding";
    case "PARTIALLY_FUNDED": return "Partially Funded";
    case "FUNDED":           return "Funded";
    case "DEFAULTED":        return "Defaulted";
    case "WAIVED":           return "Waived";
    case "LATE_PAID":        return "Late Paid";
  }
}

export function callStateColor(state: CapitalCallState): string {
  switch (state) {
    case "ISSUED":           return "var(--atm)";
    case "PARTIALLY_FUNDED": return "var(--atm)";
    case "FUNDED":           return "var(--call)";
    case "DEFAULTED":        return "var(--put)";
    case "WAIVED":           return "var(--text-lo)";
    case "LATE_PAID":        return "var(--brand)";
  }
}

/**
 * Returns true if a call requires LP action (funding).
 */
export function callRequiresAction(call: CapitalCall): boolean {
  return call.state === "ISSUED" || call.state === "PARTIALLY_FUNDED";
}

/**
 * Milliseconds remaining until the funding deadline (may be negative).
 */
export function msUntilDeadline(call: CapitalCall, nowMs: number): number {
  return new Date(call.fundingDeadline).getTime() - nowMs;
}

/**
 * Format a duration in ms to a human-readable string (e.g. "3d 4h").
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "overdue";
  const days  = Math.floor(ms / (24 * 3600 * 1000));
  const hours = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((ms % (3600 * 1000)) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
