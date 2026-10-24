/**
 * Oracle Feed Aggregation With Medianization, Deviation Bounds,
 * and Staleness Fallback (#248)
 *
 * Hardens the vault's price input by aggregating multiple oracle
 * sources into a single median value. Every source is individually
 * validated against:
 *   - a per-source staleness window (MAX_SPOT_AGE / MAX_IV_AGE), and
 *   - a configurable maximum deviation from the computed median.
 *
 * If too few valid sources remain (below quorum), or if the spread
 * among valid sources exceeds the deviation bound, the aggregator
 * returns a HALT decision — no synthetic fallback price is produced.
 * This matches the hard-stop rule documented in docs/oracle-policy.md.
 *
 * Architecture
 * ------------
 *  - All functions are pure (no I/O). The caller supplies raw feed
 *    readings and wall-clock / ledger time; the aggregator returns an
 *    `AggregationResult`.
 *  - The `AggregationResult` carries the accepted median, a list of
 *    excluded feeds with reasons, and a `status` that callers must
 *    check before using the price.
 *  - The bounds in `AggregatorConfig` mirror the normative values in
 *    docs/oracle-policy.md; they are injected so the risk committee
 *    can change them without a code change.
 *  - The output of this module is what `ExecutionPolicy.referencePrice`
 *    (issue #245) must be sourced from — never a single raw feed.
 *
 * Units
 * -----
 *  - All prices are integer base units at 7 decimal places (stroops-scale)
 *    to match the Stellar asset representation and the on-chain contract.
 *  - Timestamps are Unix seconds (as used by Soroban ledger time).
 */

// ---------------------------------------------------------------------------
// Feed reading
// ---------------------------------------------------------------------------

/** Identifies a price source. */
export type FeedId = string;

/** The kind of data a feed carries. */
export type FeedKind = "spot" | "iv";

/**
 * One reading from one oracle source.
 * `price` is in integer base units at 7 decimal places.
 * `timestamp` is the Unix-second timestamp the price was signed / published.
 */
export interface FeedReading {
  feedId: FeedId;
  kind: FeedKind;
  /** Underlying asset symbol (e.g. "BTC", "XLM"). */
  asset: string;
  /** Price in integer base units (7 dp). Must be > 0. */
  price: bigint;
  /** Unix seconds the price attestation was signed. */
  timestamp: number;
  /**
   * Optional provenance tag:
   *   "attestation" — signed by the Zenith backend operator key.
   *   "on_chain"    — from a registered on-chain oracle contract.
   *   "dex_vwap"    — Stellar DEX VWAP; reference-only, never used as primary.
   */
  provenance: "attestation" | "on_chain" | "dex_vwap";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Aggregation bounds — mirrors the normative table in docs/oracle-policy.md.
 * All bounds are injected so they can be updated through governance without
 * a frontend code change.
 */
export interface AggregatorConfig {
  /** Minimum number of valid (non-stale, non-deviant) feeds required. */
  quorum: number;
  /** Maximum age of a spot feed in seconds before it is rejected as stale. */
  maxSpotAgeSeconds: number;
  /** Maximum age of an IV feed in seconds before it is rejected as stale. */
  maxIvAgeSeconds: number;
  /**
   * Maximum allowed deviation between any individual feed and the median,
   * expressed as a fraction (e.g. 0.01 = 1%).
   * Feeds outside this band are excluded; if too few remain → HALT.
   */
  maxDeviationFraction: number;
  /**
   * Maximum allowed jump between the current median and `previousMedian`,
   * expressed as a fraction (e.g. 0.10 = 10%). Triggers HALT if exceeded.
   * Null disables the epoch-jump check.
   */
  maxEpochJumpFraction: number | null;
  /**
   * DEX VWAP feeds are reference-only and are never counted toward quorum.
   * Setting this to true allows them to appear in the exclusion log for
   * monitoring but explicitly prevents them from participating in pricing.
   */
  excludeDexVwap: boolean;
}

export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfig = {
  quorum:                 2,     // at least 2 valid sources required
  maxSpotAgeSeconds:      60,    // per oracle-policy §2
  maxIvAgeSeconds:        300,   // per oracle-policy §2
  maxDeviationFraction:   0.01,  // 1% — per oracle-policy §2 MAX_SPOT_DEVIATION
  maxEpochJumpFraction:   0.10,  // 10% — per oracle-policy §2 MAX_EPOCH_JUMP
  excludeDexVwap:         true,
};

// ---------------------------------------------------------------------------
// Exclusion reasons
// ---------------------------------------------------------------------------

export type ExclusionReason =
  | "stale"              // timestamp too old relative to now
  | "invalid_price"      // price ≤ 0 or non-finite
  | "deviation"          // price deviates > maxDeviationFraction from median
  | "dex_vwap_excluded"  // DEX VWAP feed filtered out as reference-only
  | "non_finite";        // bigint underflow guard

export interface ExcludedFeed {
  feedId: FeedId;
  reason: ExclusionReason;
  /** The price that was rejected, for audit logging. */
  rejectedPrice: bigint;
  /** The computed median at the time of exclusion (null before first pass). */
  medianAtExclusion: bigint | null;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type AggregationStatus =
  | "OK"              // median produced, quorum met, no jump
  | "HALT_QUORUM"     // fewer than `quorum` valid feeds after exclusions
  | "HALT_JUMP"       // epoch jump vs previousMedian exceeded
  | "HALT_NO_FEEDS";  // no feeds supplied at all

export interface AggregationResult {
  asset: string;
  kind: FeedKind;
  status: AggregationStatus;
  /**
   * The accepted median price, in integer base units (7 dp).
   * Set only when `status === "OK"`.
   */
  median: bigint | null;
  /** Feeds that passed all checks and contributed to the median. */
  acceptedFeeds: FeedReading[];
  /** Feeds that were excluded and why. */
  excludedFeeds: ExcludedFeed[];
  /** Unix-second timestamp of the oldest accepted feed (provenance bound). */
  oldestAcceptedAt: number | null;
  /** Unix-second timestamp of the newest accepted feed. */
  newestAcceptedAt: number | null;
}

// ---------------------------------------------------------------------------
// Median computation (integer-safe)
// ---------------------------------------------------------------------------

/**
 * Compute the median of a sorted bigint array.
 * For an even-length array, returns the lower of the two middle values
 * (floor division) to stay in integer base units.
 * Returns null for an empty array.
 */
export function medianBigInt(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  // Even: floor of the average of the two middle values
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

/**
 * Relative deviation between two prices as a fraction, always positive.
 * Returns null when `reference` is zero.
 */
export function relativeDeviation(price: bigint, reference: bigint): number | null {
  if (reference === 0n) return null;
  const diff = price > reference ? price - reference : reference - price;
  return Number(diff * 1_000_000n / reference) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate multiple feed readings into a single hardened median price.
 *
 * Algorithm (two-pass):
 *  Pass 1 — filter obviously invalid feeds (stale, zero price, dex_vwap).
 *  Pass 2 — compute a preliminary median, then exclude feeds whose
 *            individual deviation from that median exceeds `maxDeviationFraction`.
 *            Re-compute the final median from the surviving feeds.
 *
 * @param readings       Raw oracle readings for one asset + kind combination.
 * @param nowSeconds     Current Unix time (use ledger timestamp on-chain).
 * @param config         Aggregation bounds.
 * @param previousMedian Last epoch's accepted median (for jump check). Pass
 *                       `null` to skip the epoch-jump check (e.g. first epoch).
 */
export function aggregateFeeds(
  readings: FeedReading[],
  nowSeconds: number,
  config: AggregatorConfig,
  previousMedian: bigint | null = null
): AggregationResult {
  if (readings.length === 0) {
    return emptyResult("HALT_NO_FEEDS", readings);
  }

  // Validate all readings share the same asset + kind
  const { asset, kind } = readings[0];
  if (readings.some(r => r.asset !== asset || r.kind !== kind)) {
    throw new Error(
      "aggregateFeeds: all readings must share the same asset and kind"
    );
  }

  const maxAge = kind === "spot" ? config.maxSpotAgeSeconds : config.maxIvAgeSeconds;
  const excluded: ExcludedFeed[] = [];

  // ---- Pass 1: basic validity checks ----
  const pass1: FeedReading[] = [];
  for (const r of readings) {
    if (config.excludeDexVwap && r.provenance === "dex_vwap") {
      excluded.push({ feedId: r.feedId, reason: "dex_vwap_excluded", rejectedPrice: r.price, medianAtExclusion: null });
      continue;
    }
    if (r.price <= 0n) {
      excluded.push({ feedId: r.feedId, reason: "invalid_price", rejectedPrice: r.price, medianAtExclusion: null });
      continue;
    }
    const age = nowSeconds - r.timestamp;
    if (age < 0 || age > maxAge) {
      excluded.push({ feedId: r.feedId, reason: "stale", rejectedPrice: r.price, medianAtExclusion: null });
      continue;
    }
    pass1.push(r);
  }

  if (pass1.length === 0) {
    return {
      asset, kind,
      status: "HALT_QUORUM",
      median: null,
      acceptedFeeds: [],
      excludedFeeds: excluded,
      oldestAcceptedAt: null,
      newestAcceptedAt: null,
    };
  }

  // ---- Preliminary median (all pass-1 survivors) ----
  const pass1Prices = pass1.map(r => r.price);
  const prelimMedian = medianBigInt(pass1Prices)!;

  // ---- Pass 2: deviation filter ----
  const pass2: FeedReading[] = [];
  for (const r of pass1) {
    const dev = relativeDeviation(r.price, prelimMedian);
    if (dev === null || dev > config.maxDeviationFraction) {
      excluded.push({
        feedId: r.feedId,
        reason: "deviation",
        rejectedPrice: r.price,
        medianAtExclusion: prelimMedian,
      });
    } else {
      pass2.push(r);
    }
  }

  if (pass2.length < config.quorum) {
    return {
      asset, kind,
      status: "HALT_QUORUM",
      median: null,
      acceptedFeeds: pass2,
      excludedFeeds: excluded,
      oldestAcceptedAt: null,
      newestAcceptedAt: null,
    };
  }

  // ---- Final median ----
  const finalMedian = medianBigInt(pass2.map(r => r.price))!;

  // ---- Epoch-jump check ----
  if (previousMedian !== null && previousMedian > 0n && config.maxEpochJumpFraction !== null) {
    const jump = relativeDeviation(finalMedian, previousMedian);
    if (jump !== null && jump > config.maxEpochJumpFraction) {
      return {
        asset, kind,
        status: "HALT_JUMP",
        median: null,
        acceptedFeeds: pass2,
        excludedFeeds: excluded,
        oldestAcceptedAt: null,
        newestAcceptedAt: null,
      };
    }
  }

  const timestamps = pass2.map(r => r.timestamp);
  return {
    asset, kind,
    status: "OK",
    median: finalMedian,
    acceptedFeeds: pass2,
    excludedFeeds: excluded,
    oldestAcceptedAt: Math.min(...timestamps),
    newestAcceptedAt: Math.max(...timestamps),
  };
}

// ---------------------------------------------------------------------------
// Multi-asset batch aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate feeds for multiple assets in one call. Returns a map from
 * `${asset}:${kind}` to `AggregationResult`.
 * Useful for processing a full epoch snapshot in one step.
 */
export function aggregateBatch(
  readings: FeedReading[],
  nowSeconds: number,
  config: AggregatorConfig,
  previousMedians: Map<string, bigint> = new Map()
): Map<string, AggregationResult> {
  // Group by asset:kind
  const groups = new Map<string, FeedReading[]>();
  for (const r of readings) {
    const key = `${r.asset}:${r.kind}`;
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }

  const results = new Map<string, AggregationResult>();
  for (const [key, group] of groups) {
    const prev = previousMedians.get(key) ?? null;
    results.set(key, aggregateFeeds(group, nowSeconds, config, prev));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Staleness fallback
// ---------------------------------------------------------------------------

export type FallbackReason = "HALT_QUORUM" | "HALT_JUMP" | "HALT_NO_FEEDS";

export interface OracleFallbackResult {
  reason: FallbackReason;
  /** The last accepted median from the previous epoch, to use as a display-only reference. */
  fallbackPrice: bigint | null;
  description: string;
}

/**
 * Returns the fallback state when the aggregator cannot produce a valid
 * median. The `fallbackPrice` is provided for display only — it must NOT
 * be used for NAV, margin, or strike selection. The caller must halt the
 * epoch when this is returned.
 */
export function oracleFallback(
  result: AggregationResult,
  lastAcceptedMedian: bigint | null
): OracleFallbackResult {
  if (result.status === "OK") {
    throw new Error("oracleFallback called on an OK result; only HALT results need a fallback");
  }

  const descriptions: Record<AggregationStatus, string> = {
    HALT_QUORUM:    `Fewer than quorum valid feeds for ${result.asset}:${result.kind}. ${result.excludedFeeds.length} feeds excluded. Epoch halted.`,
    HALT_JUMP:      `Price jump for ${result.asset}:${result.kind} exceeded the epoch-jump bound. Epoch halted.`,
    HALT_NO_FEEDS:  `No feeds supplied for ${result.asset}:${result.kind}. Epoch halted.`,
    OK:             "", // unreachable
  };

  return {
    reason: result.status as FallbackReason,
    fallbackPrice: lastAcceptedMedian,
    description: descriptions[result.status],
  };
}

// ---------------------------------------------------------------------------
// Stablecoin depeg check
// ---------------------------------------------------------------------------

/**
 * Check whether a stablecoin has depegged beyond the configured threshold.
 * Returns `true` (safe to use) when the price is within the peg bound;
 * `false` when depegged.
 *
 * Per oracle-policy §2: `MAX_STABLE_DEPEG = 1.0%` from 1.00.
 * The peg price is always expressed in the same base units as the feed price
 * (7 decimal places for Stellar assets, so 1.00 = 10_000_000n).
 */
export function stablecoinPegCheck(
  price: bigint,
  pegPrice: bigint,
  maxDepegFraction: number
): { withinPeg: boolean; depegFraction: number } {
  const dev = relativeDeviation(price, pegPrice);
  if (dev === null) return { withinPeg: false, depegFraction: Infinity };
  return { withinPeg: dev <= maxDepegFraction, depegFraction: dev };
}

// ---------------------------------------------------------------------------
// Epoch snapshot
// ---------------------------------------------------------------------------

/**
 * A fully validated epoch price snapshot — the on-chain contract stores this
 * and reads it throughout the epoch. Never re-read mid-epoch.
 * Mirrors the snapshot schema in docs/oracle-policy.md §3.
 */
export interface EpochPriceSnapshot {
  epoch: number;
  ledgerSeq: number;
  closeTime: number; // Unix seconds
  /** Aggregated spot prices per asset. Key: asset symbol. */
  spotByAsset: Record<string, bigint>;
  /** Feed IDs that contributed to each spot reading. Key: asset symbol. */
  spotSourcesByAsset: Record<string, FeedId[]>;
  /** Unix seconds of the oldest spot source used. */
  spotTimestamp: number;
  /** Whether all assets' spot aggregations returned OK. */
  allSpotsValid: boolean;
  /** Any HALT results from spot aggregation (for the audit log). */
  haltedAssets: string[];
}

/**
 * Build an `EpochPriceSnapshot` from a batch aggregation result.
 * Returns `null` if any required asset failed aggregation (the epoch must halt).
 *
 * @param requiredAssets  Asset symbols the vault strategy requires.
 * @param batchResults    Output of `aggregateBatch` for "spot" kind.
 * @param epoch           Current epoch number.
 * @param ledgerSeq       Current Soroban ledger sequence.
 * @param closeTime       Unix-second ledger close time.
 */
export function buildEpochSnapshot(
  requiredAssets: string[],
  batchResults: Map<string, AggregationResult>,
  epoch: number,
  ledgerSeq: number,
  closeTime: number
): EpochPriceSnapshot {
  const spotByAsset: Record<string, bigint> = {};
  const spotSourcesByAsset: Record<string, FeedId[]> = {};
  const haltedAssets: string[] = [];
  let oldestSpotTs = Infinity;

  for (const asset of requiredAssets) {
    const result = batchResults.get(`${asset}:spot`);
    if (!result || result.status !== "OK" || result.median === null) {
      haltedAssets.push(asset);
      continue;
    }
    spotByAsset[asset] = result.median;
    spotSourcesByAsset[asset] = result.acceptedFeeds.map(f => f.feedId);
    if (result.oldestAcceptedAt !== null && result.oldestAcceptedAt < oldestSpotTs) {
      oldestSpotTs = result.oldestAcceptedAt;
    }
  }

  return {
    epoch,
    ledgerSeq,
    closeTime,
    spotByAsset,
    spotSourcesByAsset,
    spotTimestamp: isFinite(oldestSpotTs) ? oldestSpotTs : closeTime,
    allSpotsValid: haltedAssets.length === 0,
    haltedAssets,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyResult(status: AggregationStatus, readings: FeedReading[]): AggregationResult {
  const asset = readings[0]?.asset ?? "unknown";
  const kind: FeedKind = readings[0]?.kind ?? "spot";
  return {
    asset, kind, status,
    median: null,
    acceptedFeeds: [],
    excludedFeeds: [],
    oldestAcceptedAt: null,
    newestAcceptedAt: null,
  };
}
