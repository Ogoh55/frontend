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
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

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
  /** Declarative concentration limits (fractions of NAV). */
  exposureLimits: ExposureLimits;
  /** Current written exposure used by the sizing step. */
  exposure: ExposureState;
  /** Transfer-restriction configuration for LP shares. */
  transferRestrictions: TransferRestrictions;
}

// ---------------------------------------------------------------------------
// Shared exposure evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the tightest applicable remaining limit for an intent and clamp
 * the requested notional to it. Both the sizing step and the contract
 * enforcement boundary call this so they can never drift.
 *
 * A vault already over a (newly-tightened) limit yields zero headroom on
 * that dimension, so new writes are blocked while existing positions roll
 * off — no revert of unrelated operations.
 */
export function evaluateExposure(
  limits: ExposureLimits,
  state: ExposureState,
  intent: StrategyIntent,
): SizingDecision {
  const nav = state.nav;
  const headroom = (limit: number, used: number): number =>
    Math.max(0, limit * nav - used);

  const candidates: Array<{
    reason: NonNullable<SizingDecision["reason"]>;
    remaining: number;
  }> = [
    {
      reason: "perUnderlying",
      remaining: headroom(limits.perUnderlying, state.byUnderlying[intent.underlying] ?? 0),
    },
    {
      reason: "perStrikeBucket",
      remaining: headroom(limits.perStrikeBucket, state.byStrikeBucket[intent.strikeBucket] ?? 0),
    },
    {
      reason: "perExpiry",
      remaining: headroom(limits.perExpiry, state.byExpiry[intent.expiry] ?? 0),
    },
  ];

  const tightest = candidates.reduce((a, b) => (b.remaining < a.remaining ? b : a));
  const approvedNotional = Math.max(0, Math.min(intent.requestedNotional, tightest.remaining));
  const clamped = approvedNotional < intent.requestedNotional;

  return {
    approvedNotional,
    clamped,
    reason: clamped ? tightest.reason : null,
    remainingHeadroom: tightest.remaining,
  };
}

/**
 * Validate that a limit set is not jointly unsatisfiable (each dimension must
 * be a positive fraction of NAV). Called on config write.
 */
export function validateExposureLimits(limits: ExposureLimits): string[] {
  const errors: string[] = [];
  (["perUnderlying", "perStrikeBucket", "perExpiry"] as const).forEach((key) => {
    const v = limits[key];
    if (!(v > 0 && v <= 1)) {
      errors.push(`${key} must be a fraction of NAV in (0, 1]`);
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_VAULTS: VaultDetail[] = [
  {
    id: "xlm-cc-v1",
    name: "XLM Covered Call",
    underlying: "XLM",
    strategy: "covered_call",
    apy: 0.22,
    apyMethodology: "Trailing 12-month annualized premium income ÷ average TVL. Does not include spot price change of the underlying.",
    tvl: 284000,
    capacity: 500000,
    currentStrike: 0.13,
    currentExpiry: "2026-10-03",
    riskRating: "medium",
    description: "Writes weekly out-of-the-money covered calls on XLM. Collects premium each epoch; the vault holds XLM as collateral.",
    currentEpoch: 47,
    currentPhase: "active",
    phaseEndsAt: "2026-10-03T16:00:00Z",
    sharePrice: 1.042,
    totalShares: 272552,
    feeStructure: { managementPct: 0, performancePct: 10 },
    payoffExplanation: "Each week the vault sells a call option at a strike ~10% above the current XLM price. If XLM stays below the strike, depositors keep the full premium. If XLM rallies above the strike, the position is exercised and depositors participate in the upside up to the strike, giving up gains beyond it.",
    historicalEpochs: [
      { epochNumber: 46, deposi

/* … truncated 4940 chars — edit only what you need near the top … */
