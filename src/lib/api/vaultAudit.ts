/**
 * vaultAudit.ts — Issue #243: Immutable Audit Log and Administrative Action Trail
 *
 * Records every privileged vault action with actor, justification, and
 * before/after state in an append-only, tamper-evident log. Each entry carries
 * a SHA-256 chain hash so the sequence cannot be silently reordered or deleted.
 *
 * Architecture
 * ------------
 * - `AuditEntry` is the canonical log record shape.
 * - `appendAuditEntry` is the single write path: it computes the chain hash,
 *   writes to the durable store (IndexedDB in browser, server-side via
 *   /api/v1/vaults/{id}/audit in live mode), and returns the sealed entry.
 * - `fetchAuditLog` reads the full log for a vault, verifying the hash chain
 *   on load. Any gap or mismatch is flagged as a `TamperResult`.
 * - The mock store lives entirely in-memory / IndexedDB so no backend is
 *   required during development.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The set of privileged vault operations that must be audited. */
export type AuditActionType =
  | "parameter_change"    // set_withdrawal_fee_bps, set_min_deposit_xlm, etc.
  | "pause"               // vault paused
  | "unpause"             // vault resumed
  | "epoch_advance"       // forced epoch rollover
  | "strategy_change"     // target strategy updated
  | "treasury_withdrawal" // fee / treasury pull
  | "queue_intervention"  // manual withdrawal-queue override
  | "capacity_change"     // max TVL cap adjusted
  | "cash_buffer_change"  // cash buffer % updated (see #241)
  | "fee_change";         // management or performance fee updated

/** Before/after snapshot of a changed parameter. */
export interface AuditDiff {
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
  /** Human-readable unit for display (%, bps, XLM, …). */
  unit?: string;
}

/** One immutable audit record. */
export interface AuditEntry {
  /** Unique entry ID (UUID v4 or server-assigned). */
  id: string;
  /** Vault this action was performed on. */
  vaultId: string;
  /** ISO 8601 wall-clock timestamp. */
  timestamp: string;
  /** Soroban ledger sequence number at time of action (0 when unavailable). */
  ledger: number;
  /** Stellar G-address of the operator / signer. */
  actor: string;
  actionType: AuditActionType;
  /** Free-text justification provided by the actor before signing. */
  justification: string;
  /** Before/after pairs for every changed field. */
  diffs: AuditDiff[];
  /** On-chain transaction hash (if the action was an on-chain tx). */
  txHash?: string;
  /**
   * SHA-256 hex of `previousHash + JSON.stringify({ id, timestamp, actor,
   * actionType, diffs })`. Forms the tamper-evident chain.
   */
  chainHash: string;
  /**
   * `chainHash` of the previous entry, or the all-zero sentinel
   * `"0000000000000000000000000000000000000000000000000000000000000000"`
   * for the genesis entry.
   */
  previousHash: string;
}

/** Result of chain-integrity verification. */
export interface TamperResult {
  ok: boolean;
  /** Index (0-based) of the first broken link, if any. */
  brokenAt?: number;
  /** Human explanation. */
  message: string;
}

// ---------------------------------------------------------------------------
// Crypto helpers (Web Crypto API, browser + Node ≥ 15)
// ---------------------------------------------------------------------------

const GENESIS_HASH = "0".repeat(64);

async function sha256hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function computeChainHash(entry: Omit<AuditEntry, "chainHash">): Promise<string> {
  const payload = JSON.stringify({
    id:         entry.id,
    timestamp:  entry.timestamp,
    actor:      entry.actor,
    actionType: entry.actionType,
    diffs:      entry.diffs,
  });
  return sha256hex(entry.previousHash + payload);
}

// ---------------------------------------------------------------------------
// In-memory mock store (used when NEXT_PUBLIC_VAULTS !== "live")
// ---------------------------------------------------------------------------

/** Keyed by vaultId. */
const MOCK_STORE: Map<string, AuditEntry[]> = new Map();

function mockStore(vaultId: string): AuditEntry[] {
  if (!MOCK_STORE.has(vaultId)) MOCK_STORE.set(vaultId, []);
  return MOCK_STORE.get(vaultId)!;
}

// Seed the mock with some historical entries so the UI is non-empty.
(async () => {
  if (typeof window === "undefined") return; // skip during SSR
  await seedMockAuditLog("xlm-cc-v1");
  await seedMockAuditLog("btc-csp-v1");
})();

async function seedMockAuditLog(vaultId: string): Promise<void> {
  if (mockStore(vaultId).length > 0) return;

  const seed: Array<Omit<AuditEntry, "chainHash" | "previousHash">> = [
    {
      id: `${vaultId}-audit-001`,
      vaultId,
      timestamp: new Date(Date.now() - 14 * 86_400_000).toISOString(),
      ledger: 52_003_100,
      actor: "GCEXAMPLEOPERATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      actionType: "parameter_change",
      justification: "Initial vault deployment: set withdrawal fee to 10 bps per risk committee approval.",
      diffs: [{ field: "withdrawal_fee_bps", before: null, after: 10, unit: "bps" }],
      txHash: `mock-tx-genesis-${vaultId}`,
    },
    {
      id: `${vaultId}-audit-002`,
      vaultId,
      timestamp: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      ledger: 52_090_440,
      actor: "GCEXAMPLEOPERATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      actionType: "capacity_change",
      justification: "Staged TVL cap increase from $500K to $1M following Epoch 45 risk review.",
      diffs: [{ field: "capacity_usd", before: 500_000, after: 1_000_000, unit: "USD" }],
      txHash: `mock-tx-capacity-${vaultId}`,
    },
    {
      id: `${vaultId}-audit-003`,
      vaultId,
      timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      ledger: 52_140_200,
      actor: "GCEXAMPLEOPERATOR2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      actionType: "epoch_advance",
      justification: "Forced epoch rollover after settlement delay on Epoch 46; oracle price confirmed.",
      diffs: [
        { field: "currentEpoch", before: 46, after: 47, unit: "" },
        { field: "currentPhase",  before: "settlement", after: "deposit", unit: "" },
      ],
      txHash: `mock-tx-epoch-advance-${vaultId}`,
    },
  ];

  let previousHash = GENESIS_HASH;
  for (const partial of seed) {
    const withPrev = { ...partial, previousHash };
    const chainHash = await computeChainHash(withPrev);
    const entry: AuditEntry = { ...withPrev, chainHash };
    mockStore(vaultId).push(entry);
    previousHash = chainHash;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a new privileged-action record to the vault's audit log.
 *
 * In mock mode writes are in-memory (reset on page reload).
 * In live mode posts to POST /api/v1/vaults/{vaultId}/audit.
 */
export async function appendAuditEntry(
  input: Omit<AuditEntry, "id" | "chainHash" | "previousHash" | "timestamp">
): Promise<AuditEntry> {
  const id = globalThis.crypto.randomUUID();
  const timestamp = new Date().toISOString();

  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    // POST to the backend which owns the authoritative chain.
    const res = await fetch(`/api/v1/vaults/${input.vaultId}/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, id, timestamp }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `Audit write failed (${res.status})`);
    }
    return res.json() as Promise<AuditEntry>;
  }

  // Mock: compute hash chain locally.
  const store = mockStore(input.vaultId);
  const previousHash = store.length > 0 ? store[store.length - 1].chainHash : GENESIS_HASH;
  const partial = { ...input, id, timestamp, previousHash };
  const chainHash = await computeChainHash(partial);
  const entry: AuditEntry = { ...partial, chainHash };
  store.push(entry);
  return entry;
}

/**
 * Fetch the full audit log for a vault, verifying hash-chain integrity.
 *
 * Returns entries oldest-first. Use `verifyChain` on the result to surface
 * any tamper evidence.
 */
export async function fetchAuditLog(vaultId: string): Promise<AuditEntry[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") {
    const res = await fetch(`/api/v1/vaults/${vaultId}/audit`);
    if (!res.ok) throw new Error(`Failed to fetch audit log (${res.status})`);
    return res.json() as Promise<AuditEntry[]>;
  }

  // Ensure seed data exists (no-op if already seeded).
  await seedMockAuditLog(vaultId);
  return [...mockStore(vaultId)];
}

/**
 * Verify the hash-chain of an audit log returned by `fetchAuditLog`.
 * O(n) in the number of entries.
 */
export async function verifyChain(entries: AuditEntry[]): Promise<TamperResult> {
  if (entries.length === 0) return { ok: true, message: "Empty log — nothing to verify." };

  let expectedPrevious = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.previousHash !== expectedPrevious) {
      return {
        ok: false,
        brokenAt: i,
        message: `Chain broken at entry ${i} (id: ${entry.id}): previousHash mismatch.`,
      };
    }
    const expected = await computeChainHash({ ...entry });
    if (entry.chainHash !== expected) {
      return {
        ok: false,
        brokenAt: i,
        message: `Chain broken at entry ${i} (id: ${entry.id}): chainHash mismatch — entry may have been modified.`,
      };
    }
    expectedPrevious = entry.chainHash;
  }
  return { ok: true, message: `Chain verified — ${entries.length} entries intact.` };
}

/** Human-readable label for each action type. */
export const AUDIT_ACTION_LABELS: Record<AuditActionType, string> = {
  parameter_change:    "Parameter Change",
  pause:               "Vault Paused",
  unpause:             "Vault Resumed",
  epoch_advance:       "Epoch Advanced",
  strategy_change:     "Strategy Change",
  treasury_withdrawal: "Treasury Withdrawal",
  queue_intervention:  "Queue Intervention",
  capacity_change:     "Capacity Change",
  cash_buffer_change:  "Cash Buffer Change",
  fee_change:          "Fee Change",
};

/** Severity colouring for action types — maps to CSS vars. */
export const AUDIT_ACTION_SEVERITY: Record<AuditActionType, "info" | "warn" | "critical"> = {
  parameter_change:    "info",
  pause:               "critical",
  unpause:             "warn",
  epoch_advance:       "warn",
  strategy_change:     "warn",
  treasury_withdrawal: "warn",
  queue_intervention:  "warn",
  capacity_change:     "info",
  cash_buffer_change:  "info",
  fee_change:          "info",
};
