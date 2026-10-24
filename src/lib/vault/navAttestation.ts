/**
 * Multi-Signer Attested NAV Submission With Dispute Window (#257)
 *
 * Defines how a vault's NAV per share reaches the chain:
 *  - Multiple independent submitters each sign a NAV attestation.
 *  - The accepted NAV is the median of a quorum of attestations.
 *  - A dispute window (measured in seconds) opens after the first
 *    attestation lands; the window closes once quorum is reached.
 *  - If attestations disagree beyond the configured tolerance, the
 *    submission is disputed and a fallback procedure applies.
 *
 * All logic is pure (no I/O). Covered by navAttestation.test.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single signed NAV attestation from one submitter. */
export interface NavAttestation {
  /** Submitter G-address. */
  submitter: string;
  /** The vault contract ID this attestation is for. */
  vaultId: string;
  /** Epoch number the NAV corresponds to. */
  epoch: number;
  /** NAV per share in USD, 8 decimal precision (stored as string to avoid float drift). */
  navPerShare: string;
  /** ISO timestamp when the attestation was signed. */
  submittedAt: string;
  /** Ed25519 signature over the canonical attestation bytes (hex, provided by Freighter). */
  signature: string;
}

/** Status of a NAV submission round. */
export type NavSubmissionStatus =
  | "PENDING"    // collecting attestations, quorum not yet reached
  | "ACCEPTED"   // quorum reached, median within tolerance → accepted value
  | "DISPUTED"   // quorum reached but spread exceeds tolerance → fallback
  | "EXPIRED";   // dispute window closed without reaching quorum

export interface NavSubmissionRound {
  vaultId: string;
  epoch: number;
  attestations: NavAttestation[];
  status: NavSubmissionStatus;
  /** The accepted median NAV per share (set when status = ACCEPTED). */
  acceptedNav: string | null;
  /** ISO timestamp when the round was opened (first attestation). */
  openedAt: string | null;
  /** ISO timestamp when the round was closed (accepted/disputed/expired). */
  closedAt: string | null;
}

export interface NavRoundConfig {
  /** Minimum number of attestations required to accept or dispute a round. */
  quorum: number;
  /** Maximum allowed spread between any two attestations as a fraction of the median.
   *  e.g. 0.005 = 0.5%. Exceeding this triggers DISPUTED. */
  maxSpreadFraction: number;
  /** How long the round stays open waiting for quorum, in seconds. */
  windowSeconds: number;
}

export const DEFAULT_NAV_ROUND_CONFIG: NavRoundConfig = {
  quorum: 3,
  maxSpreadFraction: 0.005, // 0.5%
  windowSeconds: 300,       // 5 minutes
};

// ---------------------------------------------------------------------------
// Canonical attestation bytes (for signature verification)
// ---------------------------------------------------------------------------

/**
 * Returns the canonical UTF-8 string that a submitter must sign.
 * Format: `zenith:nav:{vaultId}:{epoch}:{navPerShare}:{submittedAt}`
 *
 * This is the string that gets hashed and signed by the submitter's key.
 * Keeping it deterministic and human-readable aids auditability.
 */
export function canonicalAttestationMessage(a: NavAttestation): string {
  return `zenith:nav:${a.vaultId}:${a.epoch}:${a.navPerShare}:${a.submittedAt}`;
}

// ---------------------------------------------------------------------------
// Median computation
// ---------------------------------------------------------------------------

/**
 * Computes the median of a sorted numeric array.
 * Returns null for an empty array.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Computes the relative spread: (max - min) / median.
 * Returns 0 for a single-value array; null if median is zero.
 */
export function relativeSpread(values: number[]): number | null {
  if (values.length === 0) return null;
  const m = median(values);
  if (m === null || m === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (max - min) / m;
}

// ---------------------------------------------------------------------------
// Round management
// ---------------------------------------------------------------------------

export function openNavRound(vaultId: string, epoch: number): NavSubmissionRound {
  return {
    vaultId,
    epoch,
    attestations: [],
    status: "PENDING",
    acceptedNav: null,
    openedAt: null,
    closedAt: null,
  };
}

/**
 * Add an attestation to a PENDING round, then re-evaluate the round status.
 * Returns a new round object (immutable update pattern).
 *
 * Validation:
 *  - Duplicate submitters are rejected.
 *  - Attestations for a different vault or epoch are rejected.
 *  - Attestations added to a non-PENDING round are rejected.
 */
export function addAttestation(
  round: NavSubmissionRound,
  attestation: NavAttestation,
  now = new Date().toISOString()
): NavSubmissionRound {
  if (round.status !== "PENDING") {
    throw new Error(`Cannot add attestation to a round with status "${round.status}".`);
  }
  if (attestation.vaultId !== round.vaultId) {
    throw new Error(`Attestation vault_id "${attestation.vaultId}" does not match round vault_id "${round.vaultId}".`);
  }
  if (attestation.epoch !== round.epoch) {
    throw new Error(`Attestation epoch ${attestation.epoch} does not match round epoch ${round.epoch}.`);
  }
  if (round.attestations.some(a => a.submitter === attestation.submitter)) {
    throw new Error(`Submitter "${attestation.submitter}" has already attested to this round.`);
  }

  const updatedAttestations = [...round.attestations, attestation];
  const openedAt = round.openedAt ?? now;

  return { ...round, attestations: updatedAttestations, openedAt };
}

/**
 * Evaluate a PENDING round and return an updated round with the correct status.
 *
 * Rules:
 *  1. If quorum is reached:
 *     a. Compute spread of attested values.
 *     b. If spread ≤ maxSpreadFraction → ACCEPTED (acceptedNav = median).
 *     c. If spread > maxSpreadFraction → DISPUTED.
 *  2. If the window has expired without quorum → EXPIRED.
 *  3. Otherwise, remain PENDING.
 */
export function evaluateRound(
  round: NavSubmissionRound,
  config: NavRoundConfig,
  now = new Date().toISOString()
): NavSubmissionRound {
  if (round.status !== "PENDING") return round;

  const navValues = round.attestations.map(a => parseFloat(a.navPerShare));

  // Quorum reached?
  if (round.attestations.length >= config.quorum) {
    const spread = relativeSpread(navValues) ?? 0;
    const m = median(navValues);
    if (m === null) return round;

    if (spread <= config.maxSpreadFraction) {
      return {
        ...round,
        status: "ACCEPTED",
        acceptedNav: m.toFixed(8),
        closedAt: now,
      };
    } else {
      return {
        ...round,
        status: "DISPUTED",
        acceptedNav: null,
        closedAt: now,
      };
    }
  }

  // Window expired without quorum?
  if (round.openedAt) {
    const openedMs = new Date(round.openedAt).getTime();
    const nowMs = new Date(now).getTime();
    if (nowMs - openedMs > config.windowSeconds * 1000) {
      return { ...round, status: "EXPIRED", closedAt: now };
    }
  }

  return round;
}

// ---------------------------------------------------------------------------
// Fallback procedure
// ---------------------------------------------------------------------------

export type NavFallbackReason = "DISPUTED" | "EXPIRED";

export interface NavFallbackResult {
  reason: NavFallbackReason;
  /** The last accepted NAV (from the previous round) to use until resolution. */
  fallbackNav: string;
  /** Description for the audit log. */
  description: string;
}

/**
 * Returns the fallback NAV when a round could not be accepted.
 * The caller must supply the last-known good NAV; this module does not
 * store state.
 */
export function navFallback(
  round: NavSubmissionRound,
  lastAcceptedNav: string
): NavFallbackResult {
  if (round.status !== "DISPUTED" && round.status !== "EXPIRED") {
    throw new Error(
      `navFallback called on round with status "${round.status}"; expected DISPUTED or EXPIRED.`
    );
  }
  const reason = round.status as NavFallbackReason;
  const description =
    reason === "DISPUTED"
      ? `NAV round for epoch ${round.epoch} was disputed (spread exceeded tolerance). ` +
        `Retaining last accepted NAV ${lastAcceptedNav} until a new quorum is reached.`
      : `NAV round for epoch ${round.epoch} expired without quorum (` +
        `${round.attestations.length} of ${DEFAULT_NAV_ROUND_CONFIG.quorum} required). ` +
        `Retaining last accepted NAV ${lastAcceptedNav}.`;

  return { reason, fallbackNav: lastAcceptedNav, description };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function navSubmissionStatusLabel(status: NavSubmissionStatus): string {
  switch (status) {
    case "PENDING": return "Collecting attestations";
    case "ACCEPTED": return "Accepted";
    case "DISPUTED": return "Disputed";
    case "EXPIRED": return "Expired";
  }
}

/** Returns the number of missing attestations before quorum. */
export function attestationsNeeded(round: NavSubmissionRound, config: NavRoundConfig): number {
  return Math.max(0, config.quorum - round.attestations.length);
}
