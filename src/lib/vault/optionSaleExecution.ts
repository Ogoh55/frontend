/**
 * Option-Sale Execution Mechanism for Vault Strategies (#245)
 *
 * Defines and enforces the auditable path through which a vault turns
 * an `Intent` (the *what*) into booked premium (the *how*). Three
 * execution venues are supported:
 *
 *   auction  — sealed-bid RFQ broadcast to registered market-makers;
 *               best bid wins after a configurable window.
 *   rfq      — single-counterparty request-for-quote; used when the
 *               vault has a designated liquidity partner.
 *   amm      — on-chain AMM route; fill price is the AMM's spot quote
 *               minus a configured max-slippage guard.
 *
 * Architecture
 * ------------
 *  - `SaleOrder` is the internal representation of one Intent leg that
 *    is ready to be sold.
 *  - `SaleQuote` is a bid received from any venue, normalised to a
 *    common type so the fill logic can compare across venues.
 *  - `FillResult` records the auditable outcome: fill price, premium
 *    collected, epoch, venue, and the raw venue payload for later
 *    dispute / reconciliation.
 *  - `ExecutionPolicy` governs minimum acceptable bid, max slippage,
 *    and which venues are active.
 *  - All functions are pure (no I/O). The caller (keeper / epoch engine)
 *    is responsible for I/O and for committing `FillResult` to the
 *    vault's premium ledger.
 *
 * Security notes
 * --------------
 *  - `assertFillAcceptable` MUST be called before a fill is committed.
 *    It enforces the minimum bid and slippage bounds, preventing a
 *    rogue or MEV-ed execution from draining depositor collateral via a
 *    manipulated fill price.
 *  - The `referencePrice` in `ExecutionPolicy` must be sourced from the
 *    hardened oracle module (issue #248), not directly from any single
 *    price feed.
 *  - Every `FillResult` must be persisted and indexed by the vault
 *    indexer so premium provenance is auditable on a per-epoch basis.
 */

import { type ListedOption, type OptionKind } from "./strategyTypes";

// ---------------------------------------------------------------------------
// Venue types
// ---------------------------------------------------------------------------

/** Execution venue used to sell the option leg. */
export type ExecutionVenue = "auction" | "rfq" | "amm";

// ---------------------------------------------------------------------------
// Sale order
// ---------------------------------------------------------------------------

/**
 * One leg to be sold, derived from an `OpenGroup` in the strategy
 * `Intent`. A `SaleOrder` represents the vault's *ask* side; the venue
 * responds with one or more `SaleQuote` objects.
 */
export interface SaleOrder {
  /** Stable epoch-scoped identifier (vaultId + epoch + leg index). */
  orderId: string;
  vaultId: string;
  epoch: number;
  option: ListedOption;
  /** Always true — vaults only write short positions. */
  short: true;
  quantity: bigint;
  /** The collateral asset locked behind this order. */
  collateralAsset: string;
  collateralLocked: bigint;
  /** ISO timestamp when the order was created. */
  createdAt: string;
  /** ISO timestamp after which the order must not be filled. */
  expiresAt: string;
}

/**
 * Build a `SaleOrder` from the strategy intent fields.
 * `collateralLocked` is the total collateral backing the short position
 * (not a per-unit cost), so the per-unit collateral is
 * `collateralLocked / quantity`.
 */
export function buildSaleOrder(
  vaultId: string,
  epoch: number,
  legIndex: number,
  option: ListedOption,
  quantity: bigint,
  collateralAsset: string,
  collateralLocked: bigint,
  now: string,
  ttlSeconds = 300
): SaleOrder {
  if (quantity <= 0n) throw new Error("SaleOrder quantity must be positive");
  if (collateralLocked < 0n) throw new Error("collateralLocked cannot be negative");

  const expires = new Date(new Date(now).getTime() + ttlSeconds * 1000).toISOString();
  return {
    orderId: `${vaultId}:${epoch}:${legIndex}`,
    vaultId,
    epoch,
    option,
    short: true,
    quantity,
    collateralAsset,
    collateralLocked,
    createdAt: now,
    expiresAt: expires,
  };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

/**
 * A bid received from any venue, normalised to a common type.
 * `premiumPerContract` is in the settlement asset, integer base units.
 */
export interface SaleQuote {
  quoteId: string;
  orderId: string;
  venue: ExecutionVenue;
  /** G-address or contract ID of the quoting market-maker or AMM. */
  quoter: string;
  /** Premium offered per short contract, in settlement-asset base units. */
  premiumPerContract: bigint;
  /** Total premium = premiumPerContract × quantity. */
  totalPremium: bigint;
  /** ISO timestamp when the quote was received. */
  receivedAt: string;
  /** ISO timestamp after which this quote is invalid. */
  validUntil: string;
  /** Opaque venue-specific payload for audit log storage. */
  venuePayload: Record<string, unknown>;
}

/**
 * Validate that a quote's internal arithmetic is consistent and that it
 * has not expired. Throws on any inconsistency.
 */
export function validateQuote(quote: SaleQuote, order: SaleOrder, now: string): void {
  if (quote.orderId !== order.orderId) {
    throw new Error(`Quote ${quote.quoteId} is for order ${quote.orderId}, not ${order.orderId}`);
  }
  if (new Date(quote.validUntil) <= new Date(now)) {
    throw new Error(`Quote ${quote.quoteId} expired at ${quote.validUntil}`);
  }
  if (new Date(quote.receivedAt) > new Date(order.expiresAt)) {
    throw new Error(`Quote received after order expiry`);
  }
  const expected = quote.premiumPerContract * order.quantity;
  if (quote.totalPremium !== expected) {
    throw new Error(
      `Quote totalPremium ${quote.totalPremium} ≠ premiumPerContract ${quote.premiumPerContract} × quantity ${order.quantity}`
    );
  }
  if (quote.premiumPerContract < 0n) {
    throw new Error("premiumPerContract must be non-negative");
  }
}

// ---------------------------------------------------------------------------
// Execution policy
// ---------------------------------------------------------------------------

/**
 * Per-vault, per-venue execution policy.
 *
 * `minPremiumBps` is expressed as basis points of the Black-Scholes
 * mid-price derived from the hardened oracle. A quote below this floor
 * is rejected — the vault takes no position rather than sell at a loss.
 *
 * `maxSlippageBps` is relevant for the AMM venue where the fill price
 * is determined at execution time, not at quote time.
 */
export interface ExecutionPolicy {
  /** Venues that are enabled for this vault. At least one must be active. */
  enabledVenues: ExecutionVenue[];
  /** Minimum total premium as a fraction (bps) of the theoretical mid-price. */
  minPremiumBps: number;
  /** Maximum allowed price slippage from quote to fill (AMM venue only), bps. */
  maxSlippageBps: number;
  /**
   * Theoretical option premium (per contract, in settlement-asset base units)
   * derived from the hardened oracle.  This MUST come from the oracle
   * aggregation module (issue #248) — never a single raw feed.
   */
  referencePrice: bigint;
  /** Auction quote window in seconds. */
  auctionWindowSeconds: number;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  enabledVenues: ["auction", "rfq", "amm"],
  minPremiumBps: 7500,     // must receive at least 75% of the mid-price
  maxSlippageBps: 50,      // max 0.5% slippage on AMM fills
  referencePrice: 0n,      // caller must set from the oracle module
  auctionWindowSeconds: 60,
};

// ---------------------------------------------------------------------------
// Fill acceptability check
// ---------------------------------------------------------------------------

export interface FillAcceptabilityResult {
  acceptable: boolean;
  reason: string | null;
}

/**
 * Gate that MUST be called before any fill is committed to the ledger.
 *
 * Checks:
 *  1. Venue is enabled.
 *  2. Total premium meets the minimum bps floor (skip when referencePrice = 0).
 *  3. For AMM venue: slippage from `expectedPremium` to `quote.premiumPerContract` is within bounds.
 */
export function assertFillAcceptable(
  quote: SaleQuote,
  order: SaleOrder,
  policy: ExecutionPolicy,
  expectedPremiumPerContract?: bigint
): FillAcceptabilityResult {
  if (!policy.enabledVenues.includes(quote.venue)) {
    return { acceptable: false, reason: `Venue "${quote.venue}" is not enabled for this vault` };
  }

  if (policy.referencePrice > 0n) {
    const minPremium = (policy.referencePrice * BigInt(policy.minPremiumBps) * order.quantity) / 10_000n;
    if (quote.totalPremium < minPremium) {
      return {
        acceptable: false,
        reason: `Total premium ${quote.totalPremium} is below minimum ${minPremium} (${policy.minPremiumBps} bps of reference)`,
      };
    }
  }

  if (quote.venue === "amm" && expectedPremiumPerContract !== undefined && expectedPremiumPerContract > 0n) {
    const slippage = expectedPremiumPerContract - quote.premiumPerContract;
    const slippageBps = (slippage * 10_000n) / expectedPremiumPerContract;
    if (slippageBps > BigInt(policy.maxSlippageBps)) {
      return {
        acceptable: false,
        reason: `AMM slippage ${slippageBps} bps exceeds max ${policy.maxSlippageBps} bps`,
      };
    }
  }

  return { acceptable: true, reason: null };
}

// ---------------------------------------------------------------------------
// Best-bid selection
// ---------------------------------------------------------------------------

/**
 * Select the best quote from a set of competing bids.
 * Returns `null` when the list is empty or all quotes fail acceptability.
 * Ties are broken by `receivedAt` (earlier quote wins — first-come).
 */
export function selectBestQuote(
  quotes: SaleQuote[],
  order: SaleOrder,
  policy: ExecutionPolicy,
  now: string
): SaleQuote | null {
  const valid = quotes.filter(q => {
    try {
      validateQuote(q, order, now);
      return assertFillAcceptable(q, order, policy).acceptable;
    } catch {
      return false;
    }
  });

  if (valid.length === 0) return null;

  return valid.reduce((best, q) =>
    q.totalPremium > best.totalPremium ||
    (q.totalPremium === best.totalPremium && q.receivedAt < best.receivedAt)
      ? q
      : best
  );
}

// ---------------------------------------------------------------------------
// Fill result
// ---------------------------------------------------------------------------

/**
 * The auditable record of a completed sale execution.
 * Every field is immutable after creation; the vault's premium ledger
 * records one `FillResult` per epoch per strategy leg.
 */
export interface FillResult {
  fillId: string;
  orderId: string;
  quoteId: string;
  vaultId: string;
  epoch: number;
  venue: ExecutionVenue;
  /** G-address or contract ID of the counterparty. */
  filledBy: string;
  option: ListedOption;
  quantity: bigint;
  premiumPerContract: bigint;
  /** Total premium collected in settlement-asset base units. */
  totalPremiumCollected: bigint;
  collateralAsset: string;
  collateralLocked: bigint;
  filledAt: string;
  /** The reference price used for the acceptability check — auditable proof that the fill was within policy. */
  referencePriceUsed: bigint;
  /** Raw venue payload stored for later reconciliation / dispute. */
  venuePayload: Record<string, unknown>;
}

/**
 * Create a `FillResult` from an accepted quote.
 * The caller should pass the `policy.referencePrice` as `referencePriceUsed`
 * so the fill record carries proof of the oracle price at the time of execution.
 */
export function createFillResult(
  order: SaleOrder,
  quote: SaleQuote,
  referencePriceUsed: bigint,
  now: string
): FillResult {
  return {
    fillId: `${order.orderId}:${quote.quoteId}`,
    orderId: order.orderId,
    quoteId: quote.quoteId,
    vaultId: order.vaultId,
    epoch: order.epoch,
    venue: quote.venue,
    filledBy: quote.quoter,
    option: order.option,
    quantity: order.quantity,
    premiumPerContract: quote.premiumPerContract,
    totalPremiumCollected: quote.totalPremium,
    collateralAsset: order.collateralAsset,
    collateralLocked: order.collateralLocked,
    filledAt: now,
    referencePriceUsed,
    venuePayload: quote.venuePayload,
  };
}

// ---------------------------------------------------------------------------
// Epoch execution summary
// ---------------------------------------------------------------------------

/**
 * Aggregate summary of all fills for one epoch.  This is what the vault
 * indexer stores as the `premium_collected` record and what the NAV
 * attestation module uses as its premium input.
 */
export interface EpochExecutionSummary {
  vaultId: string;
  epoch: number;
  fills: FillResult[];
  /** Sum of all fills' `totalPremiumCollected`. */
  totalPremiumCollected: bigint;
  /** Number of legs where no acceptable quote was received. */
  unfilledLegs: number;
  /** ISO timestamp of the last fill in the epoch. */
  lastFillAt: string | null;
}

/**
 * Aggregate a list of `FillResult` records into an epoch summary.
 * `unfilledLegs` must be supplied by the caller (count of legs in the
 * original intent that did not produce an acceptable quote).
 */
export function buildEpochExecutionSummary(
  vaultId: string,
  epoch: number,
  fills: FillResult[],
  unfilledLegs: number
): EpochExecutionSummary {
  const totalPremiumCollected = fills.reduce(
    (sum, f) => sum + f.totalPremiumCollected,
    0n
  );
  const lastFillAt = fills.length > 0
    ? fills.reduce((latest, f) => f.filledAt > latest ? f.filledAt : latest, fills[0].filledAt)
    : null;

  return { vaultId, epoch, fills, totalPremiumCollected, unfilledLegs, lastFillAt };
}

// ---------------------------------------------------------------------------
// Auction state machine
// ---------------------------------------------------------------------------

export type AuctionStatus = "open" | "closed" | "cancelled";

/**
 * State of an RFQ auction round. Quotes are collected until `windowClosesAt`;
 * the keeper then selects the best quote via `selectBestQuote`.
 */
export interface AuctionRound {
  orderId: string;
  status: AuctionStatus;
  quotes: SaleQuote[];
  windowOpensAt: string;
  windowClosesAt: string;
  winningQuote: SaleQuote | null;
}

export function openAuctionRound(
  orderId: string,
  now: string,
  windowSeconds: number
): AuctionRound {
  const closes = new Date(new Date(now).getTime() + windowSeconds * 1000).toISOString();
  return {
    orderId,
    status: "open",
    quotes: [],
    windowOpensAt: now,
    windowClosesAt: closes,
    winningQuote: null,
  };
}

export function addAuctionQuote(round: AuctionRound, quote: SaleQuote): AuctionRound {
  if (round.status !== "open") {
    throw new Error(`Cannot add quote to auction in state "${round.status}"`);
  }
  if (round.quotes.some(q => q.quoter === quote.quoter)) {
    throw new Error(`Market-maker "${quote.quoter}" has already submitted a quote`);
  }
  return { ...round, quotes: [...round.quotes, quote] };
}

export function closeAuctionRound(
  round: AuctionRound,
  order: SaleOrder,
  policy: ExecutionPolicy,
  now: string
): AuctionRound {
  if (round.status !== "open") return round;
  if (new Date(now) < new Date(round.windowClosesAt)) {
    throw new Error("Auction window has not yet closed");
  }
  const winner = selectBestQuote(round.quotes, order, policy, now);
  return { ...round, status: "closed", winningQuote: winner };
}

export function cancelAuctionRound(round: AuctionRound): AuctionRound {
  if (round.status !== "open") return round;
  return { ...round, status: "cancelled", winningQuote: null };
}
