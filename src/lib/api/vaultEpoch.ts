/**
 * Epoch lifecycle for a single vault instance.
 *
 * An epoch moves through an explicit state machine:
 *
 *   idle ──open──▶ open ──requestSettlement──▶ awaiting_settlement
 *                   │                               │
 *                   │ (deadline passed)             ├──settle──▶ settled
 *                   └──────forceClose──────────┐    │
 *                                              ▼    ▼
 *                                        force_closed  ──roll──▶ open (epoch + 1)
 *                                                      settled ──roll──▶ open (epoch + 1)
 *
 * Rules
 * -----
 * - Every keeper operation is idempotent: repeating an operation that is
 *   already satisfied by the current state returns `changed: false` instead
 *   of throwing.
 * - Operations that are not allowed from the current state throw
 *   `EpochTransitionError` with a typed `code`.
 * - `forceClose` is only allowed once `now >= deadline`, so a stalled epoch
 *   cannot trap depositor funds while a keeper is offline. Any caller may
 *   force-close after the deadline.
 * - Net epoch P&L is `premium - realizedLoss`, applied to NAV in one step.
 *   Premium is never partially credited.
 * - Time is unix seconds supplied by the caller. On-chain, this must be the
 *   Soroban ledger timestamp (`env.ledger().timestamp()`), not wall-clock
 *   time, so the same deadline is enforced by every node.
 *
 * Isolation: an `EpochState` belongs to exactly one vault. Functions here take
 * a state value and return a new one; they never share mutable state between
 * vaults.
 */

export type EpochPhase =
  | "idle"
  | "open"
  | "awaiting_settlement"
  | "settled"
  | "force_closed";

export interface EpochState {
  vaultId: string;
  /** Current epoch number. Starts at 0 for a vault with no epochs yet. */
  epoch: number;
  phase: EpochPhase;
  /** Unix seconds after which any caller may force-close the epoch. */
  deadline: number | null;
}

export type EpochOp = "open" | "requestSettlement" | "settle" | "roll" | "forceClose";

export type EpochTransitionErrorCode =
  | "INVALID_TRANSITION"
  | "DEADLINE_NOT_REACHED"
  | "INVALID_DEADLINE";

export class EpochTransitionError extends Error {
  readonly code: EpochTransitionErrorCode;
  readonly from: EpochPhase;
  readonly op: EpochOp;

  constructor(code: EpochTransitionErrorCode, from: EpochPhase, op: EpochOp, message: string) {
    super(message);
    this.name = "EpochTransitionError";
    this.code = code;
    this.from = from;
    this.op = op;
  }
}

/** Per-epoch record emitted on every transition, for later indexing. */
export interface EpochEvent {
  vaultId: string;
  epoch: number;
  op: EpochOp;
  from: EpochPhase;
  to: EpochPhase;
  at: number;
}

export interface EpochResult {
  state: EpochState;
  event: EpochEvent | null;
  /** False when the call was a no-op because the state already matched. */
  changed: boolean;
}

export function createEpochState(vaultId: string): EpochState {
  return { vaultId, epoch: 0, phase: "idle", deadline: null };
}

function transition(
  state: EpochState,
  op: EpochOp,
  to: EpochPhase,
  at: number,
  patch: Partial<Pick<EpochState, "epoch" | "deadline">> = {},
): EpochResult {
  const next: EpochState = { ...state, ...patch, phase: to };
  return {
    state: next,
    event: { vaultId: state.vaultId, epoch: next.epoch, op, from: state.phase, to, at },
    changed: true,
  };
}

function noop(state: EpochState): EpochResult {
  return { state, event: null, changed: false };
}

function invalid(state: EpochState, op: EpochOp): never {
  throw new EpochTransitionError(
    "INVALID_TRANSITION",
    state.phase,
    op,
    `Cannot ${op} epoch ${state.epoch} of ${state.vaultId} from phase "${state.phase}"`,
  );
}

/**
 * Opens a new epoch with its settlement deadline. Allowed from `idle`.
 * Repeating `open` while the epoch is already open is a no-op.
 */
export function openEpoch(state: EpochState, deadline: number, at: number): EpochResult {
  if (state.phase === "open") return noop(state);
  if (state.phase !== "idle") invalid(state, "open");
  if (!Number.isFinite(deadline) || deadline <= at) {
    throw new EpochTransitionError(
      "INVALID_DEADLINE",
      state.phase,
      "open",
      "Epoch deadline must be after the open time",
    );
  }
  return transition(state, "open", "open", at, { epoch: state.epoch + 1, deadline });
}

/** Moves an open epoch to `awaiting_settlement` once the option has expired. */
export function requestSettlement(state: EpochState, at: number): EpochResult {
  if (state.phase === "awaiting_settlement") return noop(state);
  if (state.phase !== "open") invalid(state, "requestSettlement");
  return transition(state, "requestSettlement", "awaiting_settlement", at);
}

/**
 * Settles an epoch and folds net P&L into NAV.
 *
 * `premium` and `realizedLoss` are in the vault's quote asset, both non-negative.
 * Returns the net amount applied, so the caller can update share accounting
 * in the same step.
 */
export function settleEpoch(
  state: EpochState,
  premium: number,
  realizedLoss: number,
  at: number,
): EpochResult & { netPnl: number } {
  if (state.phase === "settled") return { ...noop(state), netPnl: 0 };
  if (state.phase !== "awaiting_settlement") invalid(state, "settle");
  if (premium < 0 || realizedLoss < 0 || !Number.isFinite(premium) || !Number.isFinite(realizedLoss)) {
    throw new RangeError("premium and realizedLoss must be finite and non-negative");
  }
  const result = transition(state, "settle", "settled", at);
  return { ...result, netPnl: premium - realizedLoss };
}

/**
 * Force-closes a stalled epoch after its deadline. Any caller may do this.
 * Capital is returned to idle accounting; no premium is credited.
 */
export function forceClose(state: EpochState, at: number): EpochResult {
  if (state.phase === "force_closed") return noop(state);
  if (state.phase !== "open" && state.phase !== "awaiting_settlement") {
    invalid(state, "forceClose");
  }
  if (state.deadline === null || at < state.deadline) {
    throw new EpochTransitionError(
      "DEADLINE_NOT_REACHED",
      state.phase,
      "forceClose",
      `Epoch ${state.epoch} of ${state.vaultId} cannot be force-closed before ${state.deadline}`,
    );
  }
  return transition(state, "forceClose", "force_closed", at, { deadline: null });
}

/**
 * Rolls capital into the next epoch. Allowed from `settled` or `force_closed`.
 * Rolling while already `open` is a no-op, so a keeper retry after a
 * successful roll does nothing; the epoch number only advances on a real roll.
 */
export function rollEpoch(state: EpochState, deadline: number, at: number): EpochResult {
  if (state.phase === "open") return noop(state);
  if (state.phase !== "settled" && state.phase !== "force_closed") invalid(state, "roll");
  if (!Number.isFinite(deadline) || deadline <= at) {
    throw new EpochTransitionError(
      "INVALID_DEADLINE",
      state.phase,
      "roll",
      "Epoch deadline must be after the roll time",
    );
  }
  return transition(state, "roll", "open", at, { epoch: state.epoch + 1, deadline });
}

/**
 * Applies net epoch P&L to NAV and returns the new NAV and share price.
 * `totalShares` must be positive; share price is NAV divided by shares.
 */
export function applyEpochPnl(
  nav: number,
  totalShares: number,
  netPnl: number,
): { nav: number; sharePrice: number } {
  if (totalShares <= 0) {
    throw new RangeError("totalShares must be positive");
  }
  const nextNav = nav + netPnl;
  return { nav: nextNav, sharePrice: nextNav / totalShares };
}
