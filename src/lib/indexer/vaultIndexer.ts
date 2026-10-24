/**
 * Vault event indexer: Soroban `getEvents` poller → decoder → domain events →
 * idempotent projection into the read model served by
 * `GET /api/v1/vaults` and `GET /api/v1/vaults/{id}` (see `src/lib/api/vaults.ts`).
 *
 * The event log is the source of truth; projections are a pure fold over it and
 * can be rebuilt at any time with `rebuildProjections`. See docs/vault-indexer.md.
 */

export type VaultEventType =
  | "deposit"
  | "redeem_request"
  | "redeem_claim"
  | "epoch_start"
  | "epoch_rollover"
  | "premium_collected"
  | "fee_accrual"
  | "nav_update"
  | "pause"
  | "unpause"
  | "param_change";

/** Raw event as returned by Soroban RPC `getEvents` (topics/value already scVal→JS decoded). */
export interface RawContractEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  /** Position of the event within the transaction. */
  eventIndex: number;
  /** Paging token returned by RPC (`id`). */
  pagingToken: string;
  topics: unknown[];
  value: Record<string, unknown>;
}

interface Base {
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
}

export type DomainEvent = Base &
  (
    | { type: "deposit"; account: string; amount: bigint; shares: bigint }
    | { type: "redeem_request"; account: string; shares: bigint }
    | { type: "redeem_claim"; account: string; shares: bigint; amount: bigint }
    | { type: "epoch_start"; epoch: number }
    | { type: "epoch_rollover"; epoch: number }
    | { type: "premium_collected"; amount: bigint }
    | { type: "fee_accrual"; amount: bigint }
    | { type: "nav_update"; navPerShare: bigint }
    | { type: "pause" }
    | { type: "unpause" }
    | { type: "param_change"; key: string; value: string }
  );

/** Idempotency key: (contract_id, ledger, tx_hash, event_index). */
export const eventKey = (e: Base) => `${e.contractId}:${e.ledger}:${e.txHash}:${e.eventIndex}`;

const TOPIC_TO_TYPE: Record<string, VaultEventType> = {
  deposit: "deposit",
  redeem_req: "redeem_request",
  redeem_clm: "redeem_claim",
  epoch_start: "epoch_start",
  epoch_roll: "epoch_rollover",
  premium: "premium_collected",
  fee: "fee_accrual",
  nav: "nav_update",
  pause: "pause",
  unpause: "unpause",
  param: "param_change",
};

const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new Error(`invalid integer: ${String(v)}`);
};
const str = (v: unknown): string => {
  if (typeof v === "string" && v) return v;
  throw new Error(`invalid string: ${String(v)}`);
};
const num = (v: unknown): number => Number(big(v));

/**
 * Decode a raw event. Returns `null` for unknown topics (forward compatible with
 * contract upgrades that add events); throws for known topics with malformed payloads.
 * Payload field aliases cover older event schemas.
 */
export function decodeEvent(raw: RawContractEvent): DomainEvent | null {
  const topic = raw.topics[0];
  const type = typeof topic === "string" ? TOPIC_TO_TYPE[topic] : undefined;
  if (!type) return null;
  const v = raw.value ?? {};
  const base: Base = { contractId: raw.contractId, ledger: raw.ledger, txHash: raw.txHash, eventIndex: raw.eventIndex };
  switch (type) {
    case "deposit":
      return { ...base, type, account: str(v.account ?? v.user), amount: big(v.amount), shares: big(v.shares) };
    case "redeem_request":
      return { ...base, type, account: str(v.account ?? v.user), shares: big(v.shares) };
    case "redeem_claim":
      return { ...base, type, account: str(v.account ?? v.user), shares: big(v.shares), amount: big(v.amount) };
    case "epoch_start":
    case "epoch_rollover":
      return { ...base, type, epoch: num(v.epoch ?? v.epoch_id) };
    case "premium_collected":
      return { ...base, type, amount: big(v.amount ?? v.premium) };
    case "fee_accrual":
      return { ...base, type, amount: big(v.amount ?? v.fee) };
    case "nav_update":
      return { ...base, type, navPerShare: big(v.nav_per_share ?? v.nav) };
    case "pause":
    case "unpause":
      return { ...base, type };
    case "param_change":
      return { ...base, type, key: str(v.key), value: String(v.value) };
  }
}

/** Read model row for one vault. Amounts are integer base units. */
export interface VaultProjection {
  contractId: string;
  sharesOutstanding: bigint;
  navPerShare: bigint;
  currentEpoch: number;
  /** Shares queued for redemption, per account. */
  queuedRedemptions: Record<string, bigint>;
  accruedPremium: bigint;
  accruedFees: bigint;
  paused: boolean;
  params: Record<string, string>;
  lastLedger: number;
}

export const emptyProjection = (contractId: string): VaultProjection => ({
  contractId,
  sharesOutstanding: 0n,
  navPerShare: 0n,
  currentEpoch: 0,
  queuedRedemptions: {},
  accruedPremium: 0n,
  accruedFees: 0n,
  paused: false,
  params: {},
  lastLedger: 0,
});

/** Pure reducer: applies one domain event to a projection (returns a new object). */
export function project(p: VaultProjection, e: DomainEvent): VaultProjection {
  const next: VaultProjection = { ...p, lastLedger: Math.max(p.lastLedger, e.ledger) };
  switch (e.type) {
    case "deposit":
      next.sharesOutstanding = p.sharesOutstanding + e.shares;
      break;
    case "redeem_request":
      next.queuedRedemptions = { ...p.queuedRedemptions, [e.account]: (p.queuedRedemptions[e.account] ?? 0n) + e.shares };
      break;
    case "redeem_claim": {
      const q = { ...p.queuedRedemptions };
      const left = (q[e.account] ?? 0n) - e.shares;
      if (left > 0n) q[e.account] = left;
      else delete q[e.account];
      next.queuedRedemptions = q;
      next.sharesOutstanding = p.sharesOutstanding - e.shares;
      break;
    }
    case "epoch_start":
    case "epoch_rollover":
      next.currentEpoch = e.epoch;
      break;
    case "premium_collected":
      next.accruedPremium = p.accruedPremium + e.amount;
      break;
    case "fee_accrual":
      next.accruedFees = p.accruedFees + e.amount;
      break;
    case "nav_update":
      next.navPerShare = e.navPerShare;
      break;
    case "pause":
      next.paused = true;
      break;
    case "unpause":
      next.paused = false;
      break;
    case "param_change":
      next.params = { ...p.params, [e.key]: e.value };
      break;
  }
  return next;
}

export const compareEvents = (a: Base, b: Base) =>
  a.ledger - b.ledger || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0) || a.eventIndex - b.eventIndex;

/** Persistence port. A Postgres adapter should make `applyEvent` a single transaction. */
export interface IndexerStore {
  getCursor(contractId: string): Promise<string | null>;
  setCursor(contractId: string, cursor: string): Promise<void>;
  clearCursor(contractId: string): Promise<void>;
  /**
   * Atomically: insert the event into the log (no-op if the key exists), fold it into
   * the projection, and advance the cursor. Returns false if it was a duplicate.
   */
  applyEvent(event: DomainEvent, cursor: string): Promise<boolean>;
  getProjection(contractId: string): Promise<VaultProjection | null>;
  /** Replace the projection for a contract (used by rebuild). */
  putProjection(p: VaultProjection): Promise<void>;
  listEvents(contractId: string): Promise<DomainEvent[]>;
}

/** Reference in-memory store. */
export class MemoryIndexerStore implements IndexerStore {
  private cursors = new Map<string, string>();
  private events = new Map<string, Map<string, DomainEvent>>();
  private projections = new Map<string, VaultProjection>();

  async getCursor(id: string) {
    return this.cursors.get(id) ?? null;
  }
  async setCursor(id: string, cursor: string) {
    this.cursors.set(id, cursor);
  }
  async clearCursor(id: string) {
    this.cursors.delete(id);
  }
  async applyEvent(event: DomainEvent, cursor: string) {
    const log = this.events.get(event.contractId) ?? new Map<string, DomainEvent>();
    this.events.set(event.contractId, log);
    const key = eventKey(event);
    const isNew = !log.has(key);
    if (isNew) {
      log.set(key, event);
      const cur = this.projections.get(event.contractId) ?? emptyProjection(event.contractId);
      this.projections.set(event.contractId, project(cur, event));
    }
    this.cursors.set(event.contractId, cursor);
    return isNew;
  }
  async getProjection(id: string) {
    return this.projections.get(id) ?? null;
  }
  async putProjection(p: VaultProjection) {
    this.projections.set(p.contractId, p);
  }
  async listEvents(id: string) {
    return [...(this.events.get(id)?.values() ?? [])].sort(compareEvents);
  }
}

/** Rebuild a contract's projection purely from its stored event log. */
export async function rebuildProjections(store: IndexerStore, contractId: string): Promise<VaultProjection> {
  const events = await store.listEvents(contractId);
  const rebuilt = events.reduce(project, emptyProjection(contractId));
  await store.putProjection(rebuilt);
  return rebuilt;
}

export interface EventPage {
  events: RawContractEvent[];
  /** Cursor for the next call. */
  cursor?: string | null;
  latestLedger: number;
}

/** Thin port over Soroban RPC `getEvents`. */
export interface EventSource {
  getEvents(args: { contractId: string; cursor?: string; startLedger?: number; limit: number }): Promise<EventPage>;
}

export interface VaultRegistryEntry {
  contractId: string;
  deploymentLedger: number;
}

export interface VaultIndexerStatus {
  lastIngestedLedger: number;
  latestLedger: number;
  lagLedgers: number;
  vaults: Record<string, { lastLedger: number; error: string | null; skippedEvents: number }>;
}

export interface VaultIndexerOptions {
  source: EventSource;
  store: IndexerStore;
  registry: () => Promise<VaultRegistryEntry[]>;
  pageSize?: number;
  onError?: (contractId: string, err: unknown) => void;
}

export class VaultIndexer {
  private readonly pageSize: number;
  private latestLedger = 0;
  private readonly vaultStatus: VaultIndexerStatus["vaults"] = {};

  constructor(private readonly opts: VaultIndexerOptions) {
    this.pageSize = opts.pageSize ?? 200;
  }

  /** One poll over every registered vault; vaults are isolated from each other's failures. */
  async pollOnce(): Promise<void> {
    const vaults = await this.opts.registry();
    await Promise.all(vaults.map((v) => this.syncVault(v)));
  }

  /** Ingest everything after the stored cursor (or from the deployment ledger if none). */
  async syncVault(v: VaultRegistryEntry): Promise<void> {
    const st = (this.vaultStatus[v.contractId] ??= { lastLedger: 0, error: null, skippedEvents: 0 });
    try {
      let cursor = (await this.opts.store.getCursor(v.contractId)) ?? undefined;
      for (;;) {
        const page = await this.opts.source.getEvents({
          contractId: v.contractId,
          cursor,
          startLedger: cursor ? undefined : v.deploymentLedger,
          limit: this.pageSize,
        });
        this.latestLedger = Math.max(this.latestLedger, page.latestLedger);
        for (const raw of page.events) {
          let ev: DomainEvent | null = null;
          try {
            ev = decodeEvent(raw);
          } catch (err) {
            // Malformed payload: skip this event, keep the vault moving.
            st.skippedEvents++;
            this.opts.onError?.(v.contractId, err);
          }
          if (ev) await this.opts.store.applyEvent(ev, raw.pagingToken);
          else await this.opts.store.setCursor(v.contractId, raw.pagingToken);
          st.lastLedger = Math.max(st.lastLedger, raw.ledger);
        }
        if (page.events.length < this.pageSize || !page.cursor) break;
        cursor = page.cursor;
      }
      st.error = null;
    } catch (err) {
      st.error = err instanceof Error ? err.message : String(err);
      this.opts.onError?.(v.contractId, err);
    }
  }

  /** Full-history backfill: drop the cursor and re-page from the deployment ledger. Idempotent. */
  async backfill(v: VaultRegistryEntry): Promise<void> {
    await this.opts.store.clearCursor(v.contractId);
    await this.syncVault(v);
  }

  /** Health payload for the indexer status endpoint. */
  status(): VaultIndexerStatus {
    const last = Math.max(0, ...Object.values(this.vaultStatus).map((s) => s.lastLedger));
    return {
      lastIngestedLedger: last,
      latestLedger: this.latestLedger,
      lagLedgers: Math.max(0, this.latestLedger - last),
      vaults: { ...this.vaultStatus },
    };
  }
}
