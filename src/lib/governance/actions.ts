/**
 * actions.ts — Issue #89: the proposal action builder's schema layer.
 *
 * A proposal action is a single governable contract call.  Rather than asking
 * the user to hand-encode a contract invocation, the wizard renders a typed form
 * generated from this catalog, encodes the inputs, and shows a human-readable
 * summary of exactly what the call will do.
 *
 * The catalog mirrors the shapes in `src/lib/soroban/contracts/index.ts` (the
 * hand-maintained bindings) and adds the governance surface the wizard needs:
 * parameter setters on Market / Vault / Oracle, plus the Governor and Timelock.
 *
 * Design notes
 * ------------
 * - Every parameter declares its own `readMethod`, `unit` and `display` so the
 *   simulation step can produce a "110% → 120%" diff without a second
 *   hand-maintained map.
 * - `encodeAction` is total: it never throws, it returns per-field errors so
 *   the form can render them inline.
 * - All integer parsing goes through BigInt so `i128`/`u128` values survive
 *   intact — a JS `number` cannot represent the top of the range.
 */

import { isValidAccountAddress, isValidContractAddress } from "./strkey";

// ---------------------------------------------------------------------------
// Param types
// ---------------------------------------------------------------------------

/**
 * Soroban value types a governable function can take.  These map 1:1 onto the
 * `nativeToScVal` type hints used by the bindings.
 */
export type ActionParamType =
  | "u32"
  | "u64"
  | "u128"
  | "i128"
  | "bool"
  | "address"
  | "contract"
  | "symbol"
  | "string"
  | "vec<address>";

/** How a value should be rendered in the simulation diff. */
export type ParamDisplay =
  | "plain"
  | "percent"
  | "bps"
  | "seconds"
  | "days"
  | "xlm"
  | "address"
  | "contract"
  | "symbol"
  | "bool"
  | "text";

export interface ActionParamSpec {
  /** On-chain argument name (snake_case). */
  name: string;
  /** Human label for the form field. */
  label: string;
  type: ActionParamType;
  /** Optional for the form generator to render an empty input. */
  optional?: boolean;
  /** Suggested value, pre-filled in the form. */
  placeholder?: string;
  /** Longer help text shown under the field. */
  help?: string;
  /** Value to seed the field with (current on-chain value, when known). */
  suggested?: string;
  /** Getter used by the simulation step to read the current value. */
  readMethod?: string;
  /** Unit suffix for the diff, e.g. "%", "bps", "XLM". */
  unit?: string;
  /** Decimal places to render in the diff. */
  decimals?: number;
  /** Display strategy for the diff. */
  display?: ParamDisplay;
  /** Render a textarea instead of a single-line input. */
  multiline?: boolean;
  /**
   * When true the change is irreversible or can strand user funds; the wizard
   * must surface an extra warning banner.
   */
  dangerous?: boolean;
}

export interface GovernableFunction {
  /** On-chain method name passed to `Contract#call`. */
  name: string;
  label: string;
  /** One-line explanation of the effect. */
  summary: string;
  params: ActionParamSpec[];
  /** Whole-function danger flag (e.g. contract upgrades). */
  dangerous?: boolean;
  /** Warning copy shown above the form when `dangerous`. */
  dangerNote?: string;
}

export interface GovernableContract {
  /** Stable key, matches the key in `ZenithContracts`. */
  key: string;
  /** Contract name as written in Rust. */
  name: string;
  label: string;
  description: string;
  functions: GovernableFunction[];
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

const ADDRESS_PARAM = (
  name: string,
  label: string,
  help: string
): ActionParamSpec => ({
  name,
  label,
  type: "address",
  help,
  readMethod: name.replace(/^set_/, "get_"),
  display: "address",
  placeholder: "G…",
  dangerous: true,
});

export const GOVERNABLE_CONTRACTS: GovernableContract[] = [
  {
    key: "market",
    name: "ZenithMarket",
    label: "Market",
    description: "Option market risk parameters.",
    functions: [
      {
        name: "set_collateral_ratio",
        label: "Put collateral ratio",
        summary: "Sets the minimum collateral posted per contract for short puts.",
        params: [
          {
            name: "ratio_bps",
            label: "Collateral ratio",
            type: "u32",
            placeholder: "11000",
            help: "Basis points. 11000 = 110%.",
            readMethod: "collateral_ratio",
            unit: "%",
            decimals: 0,
            display: "bps",
            suggested: "11000",
          },
        ],
      },
      {
        name: "set_fee_bps",
        label: "Protocol fee",
        summary: "Sets the taker fee charged on every premium.",
        params: [
          {
            name: "fee_bps",
            label: "Fee",
            type: "u32",
            placeholder: "50",
            help: "Basis points. 50 = 0.50%.",
            readMethod: "fee_bps",
            unit: "%",
            decimals: 2,
            display: "bps",
            suggested: "50",
          },
        ],
      },
      {
        name: "set_max_position_contracts",
        label: "Max position size",
        summary: "Caps the number of contracts in a single position.",
        params: [
          {
            name: "max_contracts",
            label: "Max contracts",
            type: "u128",
            placeholder: "1000000",
            readMethod: "max_position_contracts",
            display: "plain",
            suggested: "1000000",
          },
        ],
      },
      {
        name: "set_paused",
        label: "Pause market",
        summary: "Halts all position opens and closes on the market.",
        params: [
          {
            name: "paused",
            label: "Paused",
            type: "bool",
            readMethod: "paused",
            display: "bool",
            suggested: "false",
          },
        ],
        dangerous: true,
        dangerNote:
          "Pausing the market blocks new positions and closes. Existing positions can still be settled.",
      },
      {
        name: "set_collateral_address",
        label: "Collateral asset address",
        summary: "Repoints the market at a different collateral contract.",
        params: [ADDRESS_PARAM("collateral", "Collateral contract", "Contract (C…) holding user collateral.")],
        dangerous: true,
        dangerNote:
          "Re-pointing collateral can strand funds held under the previous collateral contract.",
      },
    ],
  },
  {
    key: "vault",
    name: "ZenithVault",
    label: "Vault",
    description: "Vault collateral and withdrawal controls.",
    functions: [
      {
        name: "set_withdrawal_fee_bps",
        label: "Withdrawal fee",
        summary: "Sets the fee charged on vault withdrawals.",
        params: [
          {
            name: "fee_bps",
            label: "Withdrawal fee",
            type: "u32",
            placeholder: "10",
            help: "Basis points. 10 = 0.10%.",
            readMethod: "withdrawal_fee_bps",
            unit: "%",
            decimals: 2,
            display: "bps",
            suggested: "10",
          },
        ],
      },
      {
        name: "set_min_deposit_xlm",
        label: "Minimum deposit",
        summary: "Sets the smallest accepted vault deposit.",
        params: [
          {
            name: "min_deposit",
            label: "Minimum deposit",
            type: "i128",
            placeholder: "10000000000",
            help: "Amount in stroops (1 XLM = 10,000,000 stroops).",
            readMethod: "min_deposit",
            unit: "XLM",
            decimals: 7,
            display: "xlm",
            suggested: "10000000000",
          },
        ],
      },
      {
        name: "set_paused",
        label: "Pause vault",
        summary: "Halts vault deposits and withdrawals.",
        params: [
          {
            name: "paused",
            label: "Paused",
            type: "bool",
            readMethod: "paused",
            display: "bool",
            suggested: "false",
          },
        ],
        dangerous: true,
        dangerNote: "Pausing the vault locks deposits and withdrawals until it is unpaused.",
      },
      // ── Issue #243: audit-logged parameter changes ────────────────────────
      {
        name: "set_epoch_advance",
        label: "Force epoch advance",
        summary: "Rolls the vault into the next epoch immediately, bypassing the scheduled boundary.",
        params: [
          {
            name: "justification",
            label: "Justification",
            type: "string",
            help: "Required: explain why a forced advance is necessary (e.g. oracle failure, settlement delay).",
            display: "text",
            multiline: true,
            placeholder: "Forced due to …",
          },
        ],
        dangerous: true,
        dangerNote: "Forcing an epoch advance can strand in-flight deposits and withdrawals. This action is immutably recorded in the vault audit log.",
      },
      {
        name: "set_strategy",
        label: "Change strategy",
        summary: "Updates the vault's option-writing strategy (covered_call, cash_secured_put, iron_condor, wheel).",
        params: [
          {
            name: "strategy",
            label: "New strategy",
            type: "symbol",
            placeholder: "covered_call",
            readMethod: "strategy",
            display: "symbol",
          },
          {
            name: "justification",
            label: "Justification",
            type: "string",
            help: "Required: document the risk-committee rationale.",
            display: "text",
            multiline: true,
            placeholder: "Changing strategy because …",
          },
        ],
        dangerous: true,
        dangerNote: "Strategy changes affect depositor risk profile. The change is immutably recorded in the vault audit log.",
      },
      {
        name: "withdraw_treasury",
        label: "Treasury withdrawal",
        summary: "Pulls accrued performance fees or treasury funds to the fee recipient address.",
        params: [
          {
            name: "amount",
            label: "Amount",
            type: "i128",
            placeholder: "10000000000",
            help: "Amount in stroops (1 XLM = 10,000,000 stroops).",
            display: "xlm",
            unit: "XLM",
            decimals: 7,
          },
          {
            name: "recipient",
            label: "Recipient",
            type: "address",
            placeholder: "G…",
            help: "Stellar address to receive the funds.",
            display: "address",
            dangerous: true,
          },
          {
            name: "justification",
            label: "Justification",
            type: "string",
            help: "Required: describe the purpose of this withdrawal.",
            display: "text",
            multiline: true,
            placeholder: "Treasury withdrawal for …",
          },
        ],
        dangerous: true,
        dangerNote: "Treasury withdrawals move depositor-adjacent funds. This action is immutably recorded in the vault audit log.",
      },
      // ── Issue #242: share-weighted depositor governance controls ──────────
      {
        name: "set_quorum_bps",
        label: "Governance quorum",
        summary: "Sets the minimum depositor participation required for a proposal to pass.",
        params: [
          {
            name: "quorum_bps",
            label: "Quorum",
            type: "u32",
            placeholder: "1000",
            help: "Basis points of total shares that must participate. 1000 = 10%.",
            readMethod: "governance_quorum_bps",
            unit: "%",
            decimals: 2,
            display: "bps",
            suggested: "1000",
          },
        ],
      },
      {
        name: "set_voting_period",
        label: "Voting period",
        summary: "Sets the duration of the depositor voting window in seconds.",
        params: [
          {
            name: "period_seconds",
            label: "Voting period",
            type: "u32",
            placeholder: "259200",
            help: "Seconds. 259200 = 3 days.",
            readMethod: "governance_voting_period",
            unit: "s",
            display: "seconds",
            suggested: "259200",
          },
        ],
      },
      {
        name: "set_governance_timelock",
        label: "Governance timelock",
        summary: "Sets the delay between a successful depositor vote and on-chain execution.",
        params: [
          {
            name: "delay_seconds",
            label: "Timelock delay",
            type: "u32",
            placeholder: "172800",
            help: "Seconds. 172800 = 2 days.",
            readMethod: "governance_timelock_delay",
            unit: "s",
            display: "seconds",
            suggested: "172800",
          },
        ],
      },
      {
        name: "set_proposal_threshold",
        label: "Proposal threshold",
        summary: "Minimum share balance a depositor must hold to create a governance proposal.",
        params: [
          {
            name: "threshold_shares",
            label: "Threshold (shares)",
            type: "u128",
            placeholder: "1000",
            help: "Raw share units. Prevents spam proposals from dust holders.",
            readMethod: "governance_proposal_threshold",
            display: "plain",
            suggested: "1000",
          },
        ],
      },
      {
        name: "set_strike_band_bps",
        label: "Strike selection band",
        summary: "Sets the maximum OTM distance for strike selection as basis points of spot.",
        params: [
          {
            name: "band_bps",
            label: "Strike band",
            type: "u32",
            placeholder: "1000",
            help: "Basis points. 1000 = 10% OTM maximum.",
            readMethod: "strike_band_bps",
            unit: "bps",
            decimals: 2,
            display: "bps",
            suggested: "1000",
          },
        ],
      },
    ],
  },
  {
    key: "oracle",
    name: "ZenithOracle",
    label: "Oracle",
    description: "Price feed configuration.",
    functions: [
      {
        name: "set_max_staleness",
        label: "Max price staleness",
        summary: "Prices older than this are rejected by the oracle.",
        params: [
          {
            name: "max_staleness",
            label: "Max staleness",
            type: "u32",
            placeholder: "300",
            help: "Seconds.",
            readMethod: "max_staleness",
            unit: "s",
            display: "seconds",
            suggested: "300",
          },
        ],
      },
      {
        name: "set_fallback_price",
        label: "Fallback price",
        summary: "Sets the price used when the primary feed is unavailable.",
        params: [
          {
            name: "asset",
            label: "Asset",
            type: "symbol",
            placeholder: "XLM",
            readMethod: "fallback_price_asset",
            display: "symbol",
            suggested: "XLM",
          },
          {
            name: "price",
            label: "Price",
            type: "i128",
            placeholder: "10000000",
            help: "Price in stroops with 7 decimals.",
            readMethod: "fallback_price",
            decimals: 7,
            display: "plain",
            suggested: "10000000",
          },
        ],
      },
      {
        name: "set_feeds",
        label: "Price feed operators",
        summary: "Replaces the set of accounts permitted to push prices.",
        params: [
          {
            name: "operators",
            label: "Operators",
            type: "vec<address>",
            placeholder: "G…, G…",
            help: "One account address (G…) per line, or separated by commas.",
            readMethod: "feed_operators",
            display: "text",
            multiline: true,
          },
        ],
        dangerous: true,
        dangerNote:
          "Replacing the operator set can stall the oracle, which pauses new positions when prices go stale.",
      },
    ],
  },
  {
    key: "governor",
    name: "ZenithGovernor",
    label: "Governor",
    description: "Voting period, quorum and proposal thresholds.",
    functions: [
      {
        name: "set_voting_delay",
        label: "Voting delay",
        summary: "Delay between proposal creation and the vote opening.",
        params: [
          {
            name: "delay_ledgers",
            label: "Delay",
            type: "u32",
            placeholder: "17280",
            help: "Approximately 24 hours at 5s per ledger.",
            readMethod: "voting_delay",
            unit: "ledgers",
            display: "plain",
            suggested: "17280",
          },
        ],
      },
      {
        name: "set_voting_period",
        label: "Voting period",
        summary: "How long a proposal stays open for votes.",
        params: [
          {
            name: "period_ledgers",
            label: "Period",
            type: "u32",
            placeholder: "604800",
            help: "Approximately 7 days at 5s per ledger.",
            readMethod: "voting_period",
            unit: "ledgers",
            display: "plain",
            suggested: "604800",
          },
        ],
      },
      {
        name: "set_quorum_bps",
        label: "Quorum",
        summary: "Share of total supply that must vote for a proposal to pass.",
        params: [
          {
            name: "quorum_bps",
            label: "Quorum",
            type: "u32",
            placeholder: "2000",
            help: "Basis points. 2000 = 20%.",
            readMethod: "quorum_bps",
            unit: "%",
            decimals: 2,
            display: "bps",
            suggested: "2000",
          },
        ],
      },
      {
        name: "set_proposal_threshold",
        label: "Proposal threshold",
        summary: "Minimum voting power required to open a proposal.",
        params: [
          {
            name: "threshold",
            label: "Threshold",
            type: "u128",
            placeholder: "10000000000",
            readMethod: "proposal_threshold",
            display: "plain",
            suggested: "10000000000",
          },
        ],
      },
    ],
  },
  {
    key: "timelock",
    name: "ZenithTimelock",
    label: "Timelock",
    description: "Execution delay for queued actions and the guardian role.",
    functions: [
      {
        name: "set_delay",
        label: "Timelock delay",
        summary: "How long an approved action waits before it can execute.",
        params: [
          {
            name: "delay_seconds",
            label: "Delay",
            type: "u64",
            placeholder: "172800",
            help: "Seconds. 172800 = 48 hours.",
            readMethod: "delay_seconds",
            unit: "s",
            display: "seconds",
            suggested: "172800",
          },
        ],
      },
      {
        name: "set_admin",
        label: "Set admin",
        summary: "Transfers administrator rights to a new address.",
        params: [ADDRESS_PARAM("admin", "New admin", "Account (G…) that will control the timelock.")],
        dangerous: true,
        dangerNote:
          "Transferring admin is immediate and irreversible from the proposer's side. The previous admin loses all control.",
      },
    ],
  },
  {
    key: "deployer",
    name: "ZenithDeployer",
    label: "Deployer",
    description: "Contract upgrades and implementation swaps.",
    functions: [
      {
        name: "upgrade_contract",
        label: "Upgrade contract",
        summary: "Points a contract at a new WASM implementation.",
        params: [
          {
            name: "contract",
            label: "Contract",
            type: "contract",
            placeholder: "C…",
            help: "Contract (C…) to replace.",
            readMethod: "implementation",
            display: "contract",
          },
          {
            name: "wasm_hash",
            label: "WASM hash",
            type: "string",
            placeholder: "0x…",
            help: "64-character hex SHA-256 of the new implementation.",
            readMethod: "implementation_hash",
            display: "text",
          },
        ],
        dangerous: true,
        dangerNote:
          "This replaces live contract code. Funds already deposited under the old implementation are governed by whatever the new code allows.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Catalog lookups
// ---------------------------------------------------------------------------

export function findContract(key: string): GovernableContract | undefined {
  return GOVERNABLE_CONTRACTS.find((c) => c.key === key);
}

export function findFunction(
  contractKey: string,
  functionName: string
): GovernableFunction | undefined {
  return findContract(contractKey)?.functions.find((f) => f.name === functionName);
}

export function findParamSpec(
  contractKey: string,
  functionName: string,
  paramName: string
): ActionParamSpec | undefined {
  return findFunction(contractKey, functionName)?.params.find((p) => p.name === paramName);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export type ParamError =
  | "required"
  | "not_a_number"
  | "out_of_range"
  | "not_integer"
  | "invalid_address"
  | "invalid_contract"
  | "invalid_symbol"
  | "too_long"
  | "invalid_bool"
  | "empty_list";

export type EncodeResult =
  | { ok: true; value: unknown }
  | { ok: false; error: ParamError };

const MAX_SYMBOL_LENGTH = 32;
const MAX_STRING_LENGTH = 100;
const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;
const U128_MAX = 2n ** 128n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const U32_MAX = 2n ** 32n - 1n;

/** Accepts "1_000", "1 000" and "1,000" so big numbers stay readable. */
function stripGrouping(raw: string): string {
  return raw.trim().replace(/[_,\s]/g, "");
}

function parseUnsignedInteger(raw: string): EncodeResult {
  const cleaned = stripGrouping(raw);
  // Only an optional leading "+" — a leading "-" is a sign error, not a number.
  if (!/^\+?\d+$/.test(cleaned)) return { ok: false, error: "not_a_number" };

  let value: bigint;
  try {
    value = BigInt(cleaned);
  } catch {
    return { ok: false, error: "not_a_number" };
  }
  if (value < 0n) return { ok: false, error: "out_of_range" };
  return { ok: true, value };
}

function parseSignedInteger(raw: string): EncodeResult {
  const cleaned = stripGrouping(raw);
  if (!/^[+-]?\d+$/.test(cleaned)) return { ok: false, error: "not_a_number" };

  let value: bigint;
  try {
    value = BigInt(cleaned);
  } catch {
    return { ok: false, error: "not_a_number" };
  }
  if (value < I128_MIN) return { ok: false, error: "out_of_range" };
  return { ok: true, value };
}

/** Validate + coerce a single raw form value against its spec. */
export function encodeParam(spec: ActionParamSpec, raw: string): EncodeResult {
  const value = (raw ?? "").trim();

  if (value === "") {
    return spec.optional ? { ok: true, value: undefined } : { ok: false, error: "required" };
  }

  switch (spec.type) {
    case "u32": {
      const parsed = parseUnsignedInteger(value);
      if (!parsed.ok) return parsed;
      if ((parsed.value as bigint) > U32_MAX) return { ok: false, error: "out_of_range" };
      return parsed;
    }
    case "u64": {
      const parsed = parseUnsignedInteger(value);
      if (!parsed.ok) return parsed;
      if ((parsed.value as bigint) > U64_MAX) return { ok: false, error: "out_of_range" };
      return parsed;
    }
    case "u128": {
      const parsed = parseUnsignedInteger(value);
      if (!parsed.ok) return parsed;
      if ((parsed.value as bigint) > U128_MAX) return { ok: false, error: "out_of_range" };
      return parsed;
    }
    case "i128": {
      const parsed = parseSignedInteger(value);
      if (!parsed.ok) return parsed;
      if ((parsed.value as bigint) < I128_MIN || (parsed.value as bigint) > I128_MAX) {
        return { ok: false, error: "out_of_range" };
      }
      return parsed;
    }
    case "bool": {
      const lowered = value.toLowerCase();
      if (lowered !== "true" && lowered !== "false") return { ok: false, error: "invalid_bool" };
      return { ok: true, value: lowered === "true" };
    }
    case "address": {
      if (isValidAccountAddress(value) || isValidContractAddress(value)) return { ok: true, value };
      return { ok: false, error: "invalid_address" };
    }
    case "contract": {
      if (!isValidContractAddress(value)) return { ok: false, error: "invalid_contract" };
      return { ok: true, value };
    }
    case "symbol": {
      if (value.length > MAX_SYMBOL_LENGTH) return { ok: false, error: "too_long" };
      if (/\s/.test(value)) return { ok: false, error: "invalid_symbol" };
      return { ok: true, value };
    }
    case "string": {
      if (value.length > MAX_STRING_LENGTH) return { ok: false, error: "too_long" };
      return { ok: true, value };
    }
    case "vec<address>": {
      const items = value
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (items.length === 0) return { ok: false, error: "empty_list" };
      for (const item of items) {
        if (!isValidAccountAddress(item)) return { ok: false, error: "invalid_address" };
      }
      return { ok: true, value: items };
    }
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** A user-authored action: a contract, a function, and raw form values. */
export interface ProposalAction {
  /** Stable client-side id (not the on-chain order). */
  id: string;
  contractKey: string;
  functionName: string;
  /** Raw string values keyed by param name. */
  values: Record<string, string>;
}

export interface ActionEncodeError {
  paramName: string;
  error: ParamError;
}

export interface EncodedAction {
  contractKey: string;
  contractName: string;
  functionName: string;
  /** Values in declaration order, ready for `nativeToScVal`. */
  args: unknown[];
  errors: ActionEncodeError[];
}

/** Encode a whole action, collecting per-field errors instead of throwing. */
export function encodeAction(action: ProposalAction): EncodedAction | null {
  const contract = findContract(action.contractKey);
  const fn = contract?.functions.find((f) => f.name === action.functionName);
  if (!contract || !fn) return null;

  const args: unknown[] = [];
  const errors: ActionEncodeError[] = [];

  for (const param of fn.params) {
    const result = encodeParam(param, action.values[param.name] ?? "");
    // `in` narrowing rather than `result.ok`: the project's tsconfig sets
    // `strict: false`, under which boolean-literal discriminants do not narrow.
    if ("error" in result) {
      errors.push({ paramName: param.name, error: result.error });
      args.push(undefined);
    } else {
      args.push(result.value);
    }
  }

  return {
    contractKey: contract.key,
    contractName: contract.name,
    functionName: fn.name,
    args,
    errors,
  };
}

export function isActionValid(action: ProposalAction): boolean {
  const encoded = encodeAction(action);
  return encoded !== null && encoded.errors.length === 0;
}

// ---------------------------------------------------------------------------
// Human-readable summaries
// ---------------------------------------------------------------------------

/** Coerce an integer-ish value to BigInt without losing i128 precision. */
function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Format a fixed-point amount without exponent notation.
 *
 * `(1.7e31).toFixed(7)` yields "1.7014118346046922e+31", which is useless for
 * an i128 money value — so the split is done in BigInt space, which also keeps
 * every digit of the amount instead of rounding through a double.
 */
export function formatFixedPoint(value: unknown, decimals: number): string | null {
  const amount = toBigInt(value);
  if (amount === null) return null;

  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole.toString()}${decimals > 0 ? `.${frac}` : ""}`;
}

/** Render an encoded value for display, honouring the spec's unit and scale. */
export function formatParamValue(spec: ActionParamSpec, value: unknown): string {
  if (value === undefined || value === null) return "—";

  switch (spec.display) {
    case "bps":
      // 11000 bps → "110%"
      if (typeof value === "bigint" || typeof value === "number") {
        return `${(Number(value) / 100).toFixed(spec.decimals ?? 0)}%`;
      }
      return String(value);
    case "percent":
      if (typeof value === "bigint" || typeof value === "number") {
        return `${Number(value).toFixed(spec.decimals ?? 0)}%`;
      }
      return String(value);
    case "xlm": {
      const fixed = formatFixedPoint(value, spec.decimals ?? 7);
      return fixed === null ? String(value) : `${fixed} XLM`;
    }
    case "seconds":
      if (typeof value === "bigint" || typeof value === "number") {
        return `${value}${spec.unit ?? "s"}`;
      }
      return String(value);
    case "days":
      if (typeof value === "bigint" || typeof value === "number") {
        return `${(Number(value) / 86_400).toFixed(spec.decimals ?? 1)}d`;
      }
      return String(value);
    case "bool":
      return value ? "true" : "false";
    case "address":
    case "contract":
      return shortenAddress(String(value));
    default:
      return String(value);
  }
}

export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * One-line summary of what an action does, e.g.
 * "Set Put collateral ratio to 120%".
 */
export function describeAction(action: ProposalAction): string {
  const contract = findContract(action.contractKey);
  const fn = contract?.functions.find((f) => f.name === action.functionName);
  if (!contract || !fn) return "Unknown action";

  if (fn.params.length === 0) return fn.summary;

  const rendered = fn.params
    .map((param) => {
      const result = encodeParam(param, action.values[param.name] ?? "");
      if ("error" in result) return `${param.label}: ${result.error.replace(/_/g, " ")}`;
      return `${param.label} ${formatParamValue(param, result.value)}`;
    })
    .join(" · ");

  return `${fn.label} → ${rendered}`;
}

/** Why an action is flagged dangerous, or null when it is safe. */
export function dangerNote(action: ProposalAction): string | null {
  const contract = findContract(action.contractKey);
  const fn = contract?.functions.find((f) => f.name === action.functionName);
  if (!fn) return null;
  if (fn.dangerous) return fn.dangerNote ?? "This action can affect all protocol funds.";
  const dangerousParam = fn.params.find((p) => p.dangerous);
  return dangerousParam ? `“${dangerousParam.label}” cannot be changed back safely.` : null;
}

export function isDangerous(action: ProposalAction): boolean {
  return dangerNote(action) !== null;
}

// ---------------------------------------------------------------------------
// Form generator
// ---------------------------------------------------------------------------

/** A single rendered form field, produced from an `ActionParamSpec`. */
export interface FormField {
  /** DOM id — stable across renders so labels stay associated. */
  id: string;
  name: string;
  label: string;
  type: ActionParamType;
  value: string;
  placeholder: string;
  help?: string;
  multiline: boolean;
  /** Render as a select (enumerations) rather than a text input. */
  options?: { value: string; label: string }[];
  /** Controlled-component callback target. */
  inputMode?: "text" | "numeric";
}

const BOOL_OPTIONS = [
  { value: "false", label: "false" },
  { value: "true", label: "true" },
];

/**
 * Generate the form model for a governable function.  This is the
 * schema-driven form generator the wizard renders — no per-parameter JSX.
 */
export function buildFormFields(
  action: Pick<ProposalAction, "contractKey" | "functionName" | "values">,
  idPrefix = "action"
): FormField[] {
  const fn = findFunction(action.contractKey, action.functionName);
  if (!fn) return [];

  return fn.params.map((param) => {
    const field: FormField = {
      id: `${idPrefix}-${param.name}`,
      name: param.name,
      label: param.label,
      type: param.type,
      value: action.values[param.name] ?? param.suggested ?? defaultForParam(param),
      placeholder: param.placeholder ?? "",
      help: param.help,
      multiline: param.multiline === true || param.type === "vec<address>",
    };

    if (param.type === "bool") field.options = BOOL_OPTIONS;
    if (param.type === "u32" || param.type === "u64" || param.type === "u128" || param.type === "i128") {
      field.inputMode = "numeric";
    }

    return field;
  });
}

/**
 * Fallback value when a param has neither a stored value nor a suggestion.
 *
 * A bool must resolve to "false" rather than "": a <select> of true/false has
