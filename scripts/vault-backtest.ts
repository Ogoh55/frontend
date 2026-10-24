// `npm run backtest:vault` — offline replay of the vault covered-call epoch loop
// over a versioned historical dataset. Output is a historical simulation, not a
// forecast. The run is pure: no wall clock and no RNG, so the same dataset and
// flags produce identical JSON (`--seed` is therefore not needed).
//
// Dataset file (JSON), one snapshot per `stepDays` at the epoch-open instant:
//   { "revision": "<dataset id>", "underlying": "XLM", "stepDays": 1,
//     "snapshots": [{ "ts": "2025-01-01T00:00:00Z", "spot": 0.1, "vol": 0.8,
//                     "strikes": [0.09, 0.1, 0.11] }, ...] }
//
// Epoch loop (strike rule per docs/oracle-policy.md §4):
//   1. Under the "rebuy" policy, re-buy underlying with idle cash at open.
//   2. Select the call strike with selectStrike(); if none, halt the epoch
//      (no new call is sold, the position is held and marked at close).
//   3. Sell one call per held unit at its Black-Scholes premium; the fee is
//      taken from that premium.
//   4. At close: if spot > strike the units are called away at the strike
//      (assignment). Otherwise the call expires worthless.
// Shares are fixed at the initial capacity (1 share per quote unit), since the
// simulation has no deposits or withdrawals.

import { readFileSync, writeFileSync } from "node:fs";
import { bs, selectStrike } from "../src/lib/pricing";

export interface Snapshot {
  ts: string;
  spot: number;
  vol: number;
  strikes: number[];
}

export interface Dataset {
  revision: string;
  underlying: string;
  stepDays: number;
  snapshots: Snapshot[];
}

export interface BacktestConfig {
  targetDelta: number;
  epochSteps: number;
  capacity: number;
  feeBps: number;
  assignment: "rebuy" | "hold-cash";
}

export interface NavPoint {
  ts: string;
  nav: number;
  navPerShare: number;
}

export interface BacktestResult {
  mode: "historical-simulation";
  dataset: { revision: string; underlying: string; stepDays: number };
  config: BacktestConfig & { tenorDays: number };
  epochs: number;
  halts: number;
  assignments: number;
  rollovers: number;
  navSeries: NavPoint[];
  apy: number;
  maxDrawdown: number;
  premiumGross: number;
  feesPaid: number;
  attribution: { premiumNet: number; underlyingAndAssignment: number };
  finalNav: number;
}

export function runCoveredCall(dataset: Dataset, config: BacktestConfig): BacktestResult {
  const { snapshots, stepDays } = dataset;
  if (snapshots.length === 0) throw new Error("dataset has no snapshots");
  if (!(config.epochSteps >= 1 && Number.isInteger(config.epochSteps))) throw new Error("epochSteps must be a positive integer");
  if (!(config.capacity > 0)) throw new Error("capacity must be > 0");
  if (!(config.feeBps >= 0 && config.feeBps < 10000)) throw new Error("feeBps must be in [0, 10000)");

  const tenorDays = config.epochSteps * stepDays;
  const t = tenorDays / 365;
  const shares = config.capacity;
  let units = config.capacity / snapshots[0].spot;
  let cash = 0;
  let premiumGross = 0;
  let feesPaid = 0;
  let assignments = 0;
  let rollovers = 0;
  let halts = 0;
  let epochs = 0;
  let sold = false;
  const navSeries: NavPoint[] = [{ ts: snapshots[0].ts, nav: config.capacity, navPerShare: 1 }];

  for (let i = 0; i + config.epochSteps < snapshots.length; i += config.epochSteps) {
    const open = snapshots[i];
    const close = snapshots[i + config.epochSteps];
    epochs++;

    if (config.assignment === "rebuy" && units === 0 && cash > 0) {
      units = cash / open.spot;
      cash = 0;
    }

    const strikes = [...open.strikes].sort((a, b) => a - b);
    const strike = selectStrike(open.spot, open.vol, tenorDays, config.targetDelta, strikes);
    if (strike === null) {
      halts++;
    } else if (units > 0) {
      const gross = bs(open.spot, strike, open.vol, t, true).premium * units;
      const fee = (gross * config.feeBps) / 10000;
      cash += gross - fee;
      premiumGross += gross;
      feesPaid += fee;
      if (sold) rollovers++;
      sold = true;
      if (close.spot > strike) {
        cash += strike * units;
        units = 0;
        assignments++;
      }
    }

    const nav = cash + units * close.spot;
    navSeries.push({ ts: close.ts, nav, navPerShare: nav / shares });
  }

  const finalNav = navSeries[navSeries.length - 1].nav;
  const years = ((navSeries.length - 1) * config.epochSteps * stepDays) / 365;
  const apy = years > 0 && finalNav > 0 ? Math.pow(finalNav / config.capacity, 1 / years) - 1 : -1;
  let peak = config.capacity;
  let maxDrawdown = 0;
  for (const p of navSeries) {
    peak = Math.max(peak, p.nav);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - p.nav) / peak);
  }
  const premiumNet = premiumGross - feesPaid;

  return {
    mode: "historical-simulation",
    dataset: { revision: dataset.revision, underlying: dataset.underlying, stepDays },
    config: { ...config, tenorDays },
    epochs,
    halts,
    assignments,
    rollovers,
    navSeries,
    apy,
    maxDrawdown,
    premiumGross,
    feesPaid,
    attribution: { premiumNet, underlyingAndAssignment: finalNav - config.capacity - premiumNet },
    finalNav,
  };
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`);
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

if (require.main === module) {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.dataset) throw new Error("usage: vault-backtest --dataset <file> [--delta 0.25] [--epoch-steps 7] [--capacity 1000] [--fee-bps 1000] [--assignment rebuy|hold-cash] [--out <file>]");
  const dataset = JSON.parse(readFileSync(flags.dataset, "utf8")) as Dataset;
  const assignment = (flags.assignment ?? "rebuy") as BacktestConfig["assignment"];
  if (assignment !== "rebuy" && assignment !== "hold-cash") throw new Error(`unknown assignment policy: ${assignment}`);
  const result = runCoveredCall(dataset, {
    targetDelta: Number(flags.delta ?? 0.25),
    epochSteps: Number(flags["epoch-steps"] ?? 7),
    capacity: Number(flags.capacity ?? 1000),
    feeBps: Number(flags["fee-bps"] ?? 1000),
    assignment,
  });
  const json = JSON.stringify(result, null, 2) + "\n";
  if (flags.out) writeFileSync(flags.out, json);
  else process.stdout.write(json);
}
