/**
 * TypeScript mirror of the core Rust strategy types defined in
 * `contracts/vault/core/src/lib.rs`.
 *
 * These are used by the TS-side vault modules (option sale execution,
 * oracle aggregation, share-lockup display) and must stay in sync with
 * the Rust definitions.  Amounts are `bigint` (integer base units) to
 * match the on-chain representation.
 */

export type OptionKind = "Call" | "Put";

export type Collateral = "Underlying" | "Settlement";

export type StrikeTarget =
  | { type: "DeltaBps"; value: number }
  | { type: "OtmBps"; value: number };

export type RollPolicy = "Always" | "OnlyIfAcceptable" | "HoldToExpiry";

/** A strike/expiry listed by the options engine — mirrors `ListedOption` in Rust. */
export interface ListedOption {
  kind: OptionKind;
  /** Strike price in settlement-asset base units. */
  strike: bigint;
  expiryDays: number;
  /** Absolute delta in basis points (e.g. 2000 = 0.20 Δ). */
  deltaBps: number;
  liquid: boolean;
}

/** A position held by the vault — mirrors `Position` in Rust. */
export interface VaultPosition {
  id: bigint;
  option: ListedOption;
  short: boolean;
  quantity: bigint;
}

/** Operator-settable, per-vault strategy parameters — mirrors `StrategyParams` in Rust. */
export interface StrategyParams {
  target: StrikeTarget;
  minTenorDays: number;
  maxTenorDays: number;
  maxPositions: number;
  rollPolicy: RollPolicy;
  /** Iron condor long-wing distance beyond the short strikes, in bps of spot. */
  wingWidthBps: number;
}
