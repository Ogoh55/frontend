export { createVaultClient } from "./client";
export type { VaultClient, VaultClientOptions, VaultTransport, VaultTransportRequest, VaultTransportResponse } from "./client";
export { VaultSdkError } from "./errors";
export type { VaultErrorKind, VaultErrorOptions } from "./errors";
export type {
  DepositResult,
  EpochOutcome,
  EpochPhase,
  EpochRecord,
  FeeStructure,
  KnownOrUnknown,
  RiskRating,
  UserVaultPosition,
  VaultDetail,
  VaultStrategy,
  VaultSummary,
  WithdrawResult,
} from "./types";
