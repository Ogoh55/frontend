/**
 * Runtime checks for backend responses. Each parser throws a
 * `validation` VaultSdkError naming the failing field path; it never echoes
 * the offending value.
 */

import { VaultSdkError } from "./errors";
import type {
  DepositResult,
  EpochRecord,
  FeeStructure,
  UserVaultPosition,
  VaultDetail,
  VaultSummary,
  WithdrawResult,
} from "./types";

type Check<T> = (value: unknown, path: string) => T;

function fail(path: string, expected: string): VaultSdkError {
  return new VaultSdkError("validation", `Invalid vault response: ${path} must be ${expected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str: Check<string> = (v, p) => {
  if (typeof v === "string") return v;
  throw fail(p, "a string");
};

const num: Check<number> = (v, p) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw fail(p, "a finite number");
};

const bool: Check<boolean> = (v, p) => {
  if (typeof v === "boolean") return v;
  throw fail(p, "a boolean");
};

function arr<T>(item: Check<T>): Check<T[]> {
  return (v, p) => {
    if (!Array.isArray(v)) throw fail(p, "an array");
    return v.map((entry, i) => item(entry, `${p}[${i}]`));
  };
}

function nullable<T>(inner: Check<T>): Check<T | null> {
  return (v, p) => (v === null ? null : inner(v, p));
}

function obj<T extends object>(shape: { [K in keyof T]-?: Check<T[K]> }): Check<T> {
  return (v, p) => {
    if (!isRecord(v)) throw fail(p, "an object");
    const out = {} as T;
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      out[key] = shape[key](v[key], `${p}.${key}`);
    }
    return out;
  };
}

const parseVaultSummaryShape = {
  id: str,
  name: str,
  underlying: str,
  strategy: str,
  apy: num,
  apyMethodology: str,
  tvl: num,
  capacity: num,
  currentStrike: num,
  currentExpiry: str,
  riskRating: str,
  description: str,
};

export const parseVaultSummary = obj<VaultSummary>(parseVaultSummaryShape);

const parseEpochRecord = obj<EpochRecord>({
  epochNumber: num,
  depositStart: str,
  activeStart: str,
  settlementDate: str,
  strike: num,
  expiryDays: num,
  premiumCollected: num,
  outcome: str,
  pnlPct: num,
});

const parseUserVaultPosition: Check<UserVaultPosition> = obj<UserVaultPosition>({
  shares: num,
  shareValue: num,
  totalValue: num,
  accruedPremium: num,
  pendingWithdrawal: num,
});

export const parseVaultDetail = obj<VaultDetail>({
  ...parseVaultSummaryShape,
  currentEpoch: num,
  currentPhase: str,
  phaseEndsAt: str,
  sharePrice: num,
  totalShares: num,
  feeStructure: obj<FeeStructure>({ managementPct: num, performancePct: num }),
  payoffExplanation: str,
  historicalEpochs: arr(parseEpochRecord),
  userPosition: nullable(parseUserVaultPosition),
});

export const parseVaultSummaries = arr(parseVaultSummary);

export const parseDepositResult = obj<DepositResult>({ tx_id: str });

export const parseWithdrawResult = obj<WithdrawResult>({ tx_id: str, queued: bool });
