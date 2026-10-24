import type { EpochRecord } from "./api/vaults";

export interface VaultReturnProjection {
  projectedValue: number;
  returnPct: number;
  completedEpochs: number;
  coveredDays: number;
  availableDays: number;
}

function epochDurationDays(epoch: EpochRecord): number {
  const start = Date.parse(epoch.depositStart);
  const end = Date.parse(epoch.settlementDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`Epoch ${epoch.epochNumber} has invalid dates`);
  }
  return (end - start) / 86_400_000;
}

export function getVaultHistoryDays(historicalEpochs: EpochRecord[]): number {
  return historicalEpochs.reduce(
    (total, epoch) => total + epochDurationDays(epoch),
    0
  );
}

export function projectVaultReturns(
  depositAmount: number,
  holdingDays: number,
  historicalEpochs: EpochRecord[]
): VaultReturnProjection {
  if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
    throw new Error("Deposit amount must be a positive finite number");
  }
  if (!Number.isFinite(holdingDays) || holdingDays <= 0) {
    throw new Error("Holding period must be a positive finite number");
  }

  const epochs = [...historicalEpochs].sort(
    (a, b) => a.epochNumber - b.epochNumber
  );
  for (const epoch of epochs) {
    if (!Number.isFinite(epoch.pnlPct) || epoch.pnlPct < -1) {
      throw new Error(`Epoch ${epoch.epochNumber} has an invalid return`);
    }
  }
  const availableDays = getVaultHistoryDays(epochs);

  let elapsedDays = 0;
  let projectedValue = depositAmount;
  let completedEpochs = 0;

  for (const epoch of epochs) {
    const durationDays = epochDurationDays(epoch);
    if (elapsedDays + durationDays > holdingDays) break;
    projectedValue *= 1 + epoch.pnlPct;
    elapsedDays += durationDays;
    completedEpochs += 1;
  }

  return {
    projectedValue,
    returnPct: projectedValue / depositAmount - 1,
    completedEpochs,
    coveredDays: elapsedDays,
    availableDays,
  };
}
