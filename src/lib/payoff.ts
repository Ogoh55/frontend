import { blackScholes, type Greeks, type OptionType } from './pricing';

export type WrittenPosition = {
  id: string;
  strategy: string;
  optionType: OptionType;
  strike: number;
  spot: number;
  impliedVol: number;
  timeToExpiry: number;
  notional: number;
  contracts: number;
};

export type RiskInputs = {
  spot?: number;
  impliedVol?: number;
  timeToExpiry?: number;
  strike?: number;
  stale?: boolean;
};

export type PositionRisk = {
  id: string;
  strategy: string;
  available: boolean;
  unavailableReason?: string;
  assignmentProbability?: number;
  maxLoss?: number;
  breakeven?: number;
  greeks?: Greeks;
  model?: string;
  inputs?: RiskInputs;
};

export type AggregateRisk = {
  available: boolean;
  unavailableReason?: string;
  positionCount: number;
  notionalByStrategy: Record<string, number>;
  countByStrategy: Record<string, number>;
  greeks?: Greeks;
  maxLoss?: number;
  breakevens: number[];
};

const MIN_TIME_TO_EXPIRY = 1 / (365 * 24 * 60);
const MODEL_LABEL = 'Black-Scholes (local estimate)';

function clampTimeToExpiry(t: number): number {
  if (!Number.isFinite(t) || t <= 0) return MIN_TIME_TO_EXPIRY;
  return Math.max(t, MIN_TIME_TO_EXPIRY);
}

function normalCdf(x: number): number {
  // Abramowitz & Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function assignmentProbability(
  optionType: OptionType,
  spot: number,
  strike: number,
  impliedVol: number,
  timeToExpiry: number,
): number {
  const t = clampTimeToExpiry(timeToExpiry);
  const vol = Math.max(impliedVol, 1e-6);
  const d2 =
    (Math.log(spot / strike) + (-0.5 * vol * vol) * t) / (vol * Math.sqrt(t));
  // Probability the option finishes in the money (i.e. assigned at expiry).
  return optionType === 'call' ? normalCdf(d2) : normalCdf(-d2);
}

function maxLossPerContract(
  optionType: OptionType,
  strike: number,
  premium: number,
): number {
  // Written (short) option: max loss is unbounded for calls, strike - premium for puts.
  if (optionType === 'call') return Number.POSITIVE_INFINITY;
  return Math.max(strike - premium, 0);
}

export function computePositionRisk(position: WrittenPosition): PositionRisk {
  const { spot, impliedVol, timeToExpiry, strike } = position;
  const inputs: RiskInputs = { spot, impliedVol, timeToExpiry, strike };

  if (
    !Number.isFinite(spot) ||
    spot <= 0 ||
    !Number.isFinite(impliedVol) ||
    impliedVol <= 0 ||
    !Number.isFinite(timeToExpiry) ||
    timeToExpiry <= 0 ||
    !Number.isFinite(strike) ||
    strike <= 0
  ) {
    return {
      id: position.id,
      strategy: position.strategy,
      available: false,
      unavailableReason: 'Missing or stale pricing inputs',
      model: MODEL_LABEL,
      inputs,
    };
  }

  const t = clampTimeToExpiry(timeToExpiry);
  const greeks = blackScholes({
    type: position.optionType,
    spot,
    strike,
    timeToExpiry: t,
    volatility: impliedVol,
  });

  const premium = greeks.price;
  const perContractLoss = maxLossPerContract(position.optionType, strike, premium);
  const maxLoss = Number.isFinite(perContractLoss)
    ? perContractLoss * position.contracts
    : Number.POSITIVE_INFINITY;

  const breakeven =
    position.optionType === 'call' ? strike + premium : strike - premium;

  return {
    id: position.id,
    strategy: position.strategy,
    available: true,
    assignmentProbability: assignmentProbability(
      position.optionType,
      spot,
      strike,
      impliedVol,
      t,
    ),
    maxLoss,
    breakeven,
    greeks,
    model: MODEL_LABEL,
    inputs,
  };
}

export function aggregateRisk(positions: WrittenPosition[]): AggregateRisk {
  const notionalByStrategy: Record<string, number> = {};
  const countByStrategy: Record<string, number> = {};
  const breakevens: number[] = [];
  let delta = 0;
  let gamma = 0;
  let vega = 0;
  let theta = 0;
  let maxLoss = 0;
  let anyAvailable = false;
  let anyUnavailable = false;

  for (const position of positions) {
    notionalByStrategy[position.strategy] =
      (notionalByStrategy[position.strategy] ?? 0) + position.notional;
    countByStrategy[position.strategy] =
      (countByStrategy[position.strategy] ?? 0) + 1;

    const risk = computePositionRisk(position);
    if (!risk.available || !risk.greeks) {
      anyUnavailable = true;
      continue;
    }
    anyAvailable = true;
    delta += risk.greeks.delta * position.contracts;
    gamma += risk.greeks.gamma * position.contracts;
    vega += risk.greeks.vega * position.contracts;
    theta += risk.greeks.theta * position.contracts;
    if (risk.maxLoss !== undefined) {
      maxLoss = Number.isFinite(risk.maxLoss)
        ? maxLoss + risk.maxLoss
        : Number.POSITIVE_INFINITY;
    }
    if (risk.breakeven !== undefined) breakevens.push(risk.breakeven);
  }

  if (!anyAvailable) {
    return {
      available: false,
      unavailableReason:
        positions.length === 0
          ? 'No open written positions'
          : 'Pricing inputs unavailable for all positions',
      positionCount: positions.length,
      notionalByStrategy,
      countByStrategy,
      breakevens,
    };
  }

  return {
    available: true,
    unavailableReason: anyUnavailable
      ? 'Some positions excluded due to missing inputs'
      : undefined,
    positionCount: positions.length,
    notionalByStrategy,
    countByStrategy,
    greeks: { delta, gamma, vega, theta },
    maxLoss,
    breakevens,
  };
}
