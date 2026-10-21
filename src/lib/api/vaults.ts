/**
 * Typed data adapter interface for the Vaults feature.
 *
 * The vault smart contracts and backend API are not yet available.
 * When NEXT_PUBLIC_VAULTS=mock (or the env var is absent), the mock
 * implementation below is used. Swap in the real implementation by
 * setting NEXT_PUBLIC_VAULTS=live and implementing `fetchVaultsLive`.
 *
 * Backend contract (for when the real API lands):
 *
 *   GET /api/v1/vaults
 *   → VaultSummary[]
 *
 *   GET /api/v1/vaults/{id}
 *   → VaultDetail
 *
 *   POST /api/v1/vaults/{id}/deposit   { amount: number }  → { tx_id: string }
 *   POST /api/v1/vaults/{id}/withdraw  { shares: number }  → { tx_id: string; queued: boolean }
 *
 * Fiat on-ramp / off-ramp (SEP-24 interactive, SEP-6 non-interactive):
 *
 *   GET  /api/vaults/anchor/config?network=&asset=
 *   → AnchorConfig | null   (null ⇒ no anchor configured ⇒ hide entry points)
 *
 *   POST /api/vaults/anchor/quote  { network, asset, direction, amount }
 *   → AnchorQuote
 *
 *   POST /api/vaults/anchor/transaction  { network, asset, direction, amount, quoteId }
 *   → AnchorTransaction   (interactiveUrl is minted server-side, never client-supplied)
 *
 *   GET  /api/vaults/anchor/transaction/{id}
 *   → AnchorTransaction
 *
 * Anchor credentials stay server-side in the BFF proxy; the client only ever
 * sees the normalized shapes below. Anchor transactions are modelled as a
 * separate state machine from the vault deposit so a refund/expiry never
 * leaves a half-applied vault position.
 */

export type VaultStrategy = "covered_call" | "cash_secured_put" | "iron_condor" | "wheel";
export type RiskRating = "low" | "medium" | "high";
export type EpochPhase = "deposit" | "active" | "settlement";

/** Summary shown on the /vaults listing page. */
export interface VaultSummary {
  id: string;
  name: string;
  underlying: string;
  strategy: VaultStrategy;
  /** Trailing 12-month APY estimate (0–1, e.g. 0.18 = 18%). */
  apy: number;
  /** APY methodology note shown in tooltip. */
  apyMethodology: string;
  /** Total value locked in USD. */
  tvl: number;
  /** Maximum TVL before the vault is full. */
  capacity: number;
  currentStrike: number;
  currentExpiry: string; // ISO date
  riskRating: RiskRating;
  description: string;
}

/** One historical epoch record. */
export interface EpochRecord {
  epochNumber: number;
  depositStart: string; // ISO
  activeStart: string;
  settlementDate: string;
  strike: number;
  expiryDays: number;
  premiumCollected: number; // per share, in USD
  outcome: "expired_worthless" | "exercised" | "active";
  pnlPct: number; // epoch return, positive = profit for depositors
}

/** The user's position in a vault. */
export interface UserVaultPosition {
  shares: number;
  shareValue: number; // current USD value per share
  totalValue: number;
  accruedPremium: number;
  pendingWithdrawal: number; // shares queued for withdrawal at epoch end
}

/** Full detail for a single vault. */
export interface VaultDetail extends VaultSummary {
  currentEpoch: number;
  currentPhase: EpochPhase;
  phaseEndsAt: string; // ISO — when the current phase ends
  sharePrice: number; // current NAV per share in USD
  totalShares: number;
  feeStructure: { managementPct: number; performancePct: number };
  payoffExplanation: string;
  historicalEpochs: EpochRecord[];
  userPosition: UserVaultPosition | null;
}

// ---------------------------------------------------------------------------
// Fiat on-ramp / off-ramp (anchor) types
// ---------------------------------------------------------------------------

export type AnchorDirection = "deposit" | "withdraw";

/** SEP protocol the anchor exposes for a given network/asset. */
export type AnchorProtocol = "sep24" | "sep6";

/**
 * Anchor availability for a network/asset pair. Returned by the BFF proxy.
 * `null` from `fetchAnchorConfig` means no anchor is configured, in which
 * case the "Fund from bank" / "Cash out" entry points must be hidden.
 */
export interface AnchorConfig {
  anchorId: string;
  anchorName: string;
  network: string;
  asset: string;
  /** Protocols supported for this asset (SEP-24 interactive is required). */
  protocols: AnchorProtocol[];
  /** Minimum fiat amount the anchor will accept, in `fiatCurrency`. */
  minAmount: number;
  maxAmount: number;
  fiatCurrency: string;
}

/**
 * Normalized quote/preview shown before the user commits. Never route funds
 * without surfacing this to the user first.
 */
export interface AnchorQuote {
  quoteId: string;
  direction: AnchorDirection;
  /** Amount the user typed, in `fiatCurrency` for deposits or asset units for withdrawals. */
  amount: number;
  fiatCurrency: string;
  asset: string;
  /** Effective rate: fiat per 1 asset unit. */
  rate: number;
  /** Total fees in `fiatCurrency`. */
  feeTotal: number;
  /** Amount of `asset` the user will receive (deposit) or fiat they will receive (withdraw). */
  receiveAmount: number;
  /** Estimated arrival, ISO timestamp. */
  estimatedArrival: string;
  /** Quote expiry, ISO timestamp. After this the user must re-quote. */
  expiresAt: string;
}

/**
 * Normalized anchor transaction lifecycle. This is a separate state machine
 * from the vault deposit: a refund/expiry here must never mutate vault state.
 */
export type AnchorTransactionStatus =
  | "pending"
  | "incomplete"
  | "completed"
  | "refunded"
  | "expired"
  | "error";

export interface AnchorTransaction {
  id: string;
  direction: AnchorDirection;
  status: AnchorTransactionStatus;
  asset: string;
  amount: number;
  fiatCurrency: string;
  /** SEP-24 interactive URL minted server-side; used to open/resume the flow. */
  interactiveUrl: string | null;
  /** Human-readable status/refund message (no PII). */
  message: string | null;
  /** Stellar tx hash once the anchor settles on-chain, if available. */
  stellarTxHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fetch anchor availability for a network/asset. Returns `null` when no
 * anchor is configured — callers must treat this as "hide the entry point".
 */
export async function fetchAnchorConfig(
  network: string,
  asset: string,
): Promise<AnchorConfig | null> {
  const params = new URLSearchParams({ network, asset });
  const res = await fetch(`/api/vaults/anchor/config?${params.toString()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load anchor config (${res.status})`);
  return (await res.json()) as AnchorConfig | null;
}

/** Request a quote/preview. Must be shown to the user before committing. */
export async function fetchAnchorQuote(input: {
  network: string;
  asset: string;
  direction: AnchorDirection;
  amount: number;
}): Promise<AnchorQuote> {
  const res = await fetch("/api/vaults/anchor/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to fetch anchor quote (${res.status})`);
  return (await res.json()) as AnchorQuote;
}

/**
 * Start an anchor transaction. The interactive URL is minted by the BFF proxy
 * from server-side credentials — never pass a client-supplied redirect URL.
 */
export async function startAnchorTransaction(input: {
  network: string;
  asset: string;
  direction: AnchorDirection;
  amount: number;
  quoteId: string;
}): Promise<AnchorTransaction> {
  const res = await fetch("/api/vaults/anchor/transaction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to start anchor transaction (${res.status})`);
  return (await res.json()) as AnchorTransaction;
}

/** Poll an anchor transaction's status (low-frequency; used to resume sessions). */
export async function fetchAnchorTransaction(id: string): Promise<AnchorTransaction> {
  const res = await fetch(`/api/vaults/anchor/transaction/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to load anchor transaction (${res.status})`);
  return (await res.json()) as AnchorTransaction;
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_VAULTS: VaultDetail[] = [
  {
    id: "xlm-cc-v1",
    name: "XLM Covered Call",
    underlying: "XLM",
    strategy: "covered_call",
    apy: 0.22,
    apyMethodology: "Trailing 12-month annualized premium income ÷ average TVL. Does not include spot price change of the underlying.",
    tvl: 284000,
    capacity: 500000,
    currentStrike: 0.13,
    currentExpiry: "2026-10-03",
    riskRating: "medium",
    description: "Writes weekly out-of-the-money covered calls on XLM. Collects premium each epoch; the vault holds XLM as collateral.",
    currentEpoch: 47,
    currentPhase: "active",
    phaseEndsAt: "2026-10-03T16:00:00Z",
    sharePrice: 1.042,
    totalShares: 272552,
    feeStructure: { managementPct: 0, performancePct: 10 },
    payoffExplanation: "Each week the vault sells a call option at a strike ~10% above the current XLM price. If XLM stays below the strike, depositors keep the full premium. If XLM rallies above the strike, the position is exercised and depositors participate in the upside up to the strike, giving up gains beyond it.",
    historicalEpochs: [
      { epochNumber: 46, depositStart: "2026-09-19", activeStart: "2026-09-20", settlementDate: "2026-09-27", strike: 0.125, expiryDays: 7, premiumCollected: 0.0018, outcome: "expired_worthless", pnlPct: 0.021 },
      { epochNumber: 45, depositStart: "2026-09-12", activeStart: "2026-09-13", settlementDate: "2026-09-20", strike: 0.122, expiryDays: 7, premiumCollected: 0.0015, outcome: "expired_worthless", pnlPct: 0.018 },
      { epochNumber: 44, depositStart: "2026-09-05", activeStart: "2026-09-06", settlementDate: "2026-09-13", strike: 0.118, expiryDays: 7, premiumCollected: 0.0021, outcome: "exercised",         pnlPct: 0.009 },
      { epochNumber: 43, depositStart: "2026-08-29", activeStart: "2026-08-30", settlementDate: "2026-09-06", strike: 0.115, expiryDays: 7, premiumCollected: 0.0019, outcome: "expired_worthless", pnlPct: 0.022 },
      { epochNumber: 42, depositStart: "2026-08-22", activeStart: "2026-08-23", settlementDate: "2026-08-30", strike: 0.120, expiryDays: 7, premiumCollected: 0.0016, outcome: "expired_worthless", pnlPct: 0.019 },
    ],
    userPosition: { shares: 950, shareValue: 1.042, totalValue: 989.9, accruedPremium: 18.46, pendingWithdrawal: 0 },
  },
  {
    id: "btc-csp-v1",
    name: "BTC Cash-Secured Put",
    underlying: "BTC",
    strategy: "cash_secured_put",
    apy: 0.15,
    apyMethodology: "Trailing 12-month annualized premium income ÷ average USDC TVL. Excludes BTC spot risk — depositors are exposed to assignment at the strike price.",
    tvl: 1850000,
    capacity: 3000000,
    currentStrike: 60000,
    currentExpiry: "2026-10-17",
    riskRating: "high",
    description: "Writes monthly cash-secured puts on BTC. The vault holds USDC as collateral; assignment means acquiring BTC at the strike.",
    currentEpoch: 18,
    currentPhase: "active",
    phaseEndsAt: "2026-10-17T20:00:00Z",
    sharePrice: 1.088,
    totalShares: 1700368,
    feeStructure: { managementPct: 0.5, performancePct: 15 },
    payoffExplanation: "Each month the vault sells a put option at a strike ~10% below the current BTC price, backed by USDC. If BTC stays above the strike, depositors keep the premium. If BTC falls below the strike, the vault is assigned and acquires BTC at the strike — a risk equivalent to a limit buy order.",
    historicalEpochs: [
      { epochNumber: 17, depositStart: "2026-08-15", activeStart: "2026-08-19", settlementDate: "2026-09-20", strike: 59000, expiryDays: 30, premiumCollected: 420, outcome: "expired_worthless", pnlPct: 0.013 },
      { epochNumber: 16, depositStart: "2026-07-18", activeStart: "2026-07-22", settlementDate: "2026-08-16", strike: 55000, expiryDays: 30, premiumCollected: 380, outcome: "expired_worthless", pnlPct: 0.011 },
      { epochNumber: 15, depositStart: "2026-06-21", activeStart: "2026-06-24", settlementDate: "2026-07-19", strike: 57000, expiryDays: 30, premiumCollected: 440, outcome: "expired_worthless", pnlPct: 0.014 },
    ],
    userPosition: null,
  },
  {
    id: "eth-ic-v1",
    name: "ETH Iron Condor",
    underlying: "ETH",
    strategy: "iron_condor",
    apy: 0.18,
    apyMethodology: "Trailing 12-month net premium income (both spreads) ÷ average USDC collateral deployed.",
    tvl: 620000,
    capacity: 1000000,
    currentStrike: 3200,
    currentExpiry: "2026-10-10",
    riskRating: "low",
    description: "Sells 30-day iron condors on ETH, targeting a range-bound market. Limited loss profile; wins when ETH stays between the two breakevens.",
    currentEpoch: 11,
    currentPhase: "deposit",
    phaseEndsAt: "2026-09-28T12:00:00Z",
    sharePrice: 1.021,
    totalShares: 607247,
    feeStructure: { managementPct: 0, performancePct: 10 },
    payoffExplanation: "The vault simultaneously sells an out-of-the-money call spread and a put spread on ETH. Maximum profit is the combined net premium, achieved if ETH expires between the two short strikes. Maximum loss is limited to the spread width minus the premium.",
    historicalEpochs: [
      { epochNumber: 10, depositStart: "2026-08-25", activeStart: "2026-08-29", settlementDate: "2026-09-28", strike: 3100, expiryDays: 30, premiumCollected: 28, outcome: "expired_worthless", pnlPct: 0.012 },
    ],
    userPosition: null,
  },
];
