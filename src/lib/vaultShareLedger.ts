/**
 * Share ledger for a vault: depositors hold shares priced at NAV-per-share,
 * premium income and realized losses move NAV, and management/performance
 * fees accrue against the same NAV used for pricing.
 *
 * This is the reference model for the vault contract's accounting core. The
 * client-side Black-Scholes preview in pricing.ts is NOT a source of truth for
 * NAV and must never feed into these functions.
 *
 * Units: assets are integer base units (e.g. 7-decimal stroops). NAV-per-share
 * is fixed-point scaled by SCALE. Fee rates are basis points.
 *
 * Rounding, always in the vault's favour:
 *   - mint: shares = floor(assets * totalShares / nav)
 *   - burn: assets = floor(shares * nav / totalShares)
 *   - fees: floor, so the fee recipient never receives more than the rate allows
 *
 * Empty vault: with no shares outstanding the price is 1.0 (SCALE) and deposits
 * mint 1:1. NAV can only change through the functions below, and premium can
 * only be booked while shares exist, so balances sent in directly cannot
 * inflate the first depositor's price.
 *
 * Every function is pure: it takes the current state and returns the next one.
 */

export const SCALE = 10n ** 18n;
export const BPS = 10_000n;
const SECONDS_PER_YEAR = 31_536_000n;

export interface VaultShareState {
  totalShares: bigint;
  /** Assets backing shares, net of fees already taken. */
  nav: bigint;
  /** Highest NAV-per-share (SCALE) the performance fee has been charged up to. Never decreases except on a full reset to SCALE. */
  highWaterMark: bigint;
  managementFeeBps: bigint;
  performanceFeeBps: bigint;
  feeRecipient: string;
  /** Assets taken out of NAV as fees, claimable by feeRecipient. */
  feesOwed: bigint;
  /** Unix seconds of the last fee accrual. */
  lastAccrual: bigint;
}

export interface VaultShareConfig {
  managementFeeBps: bigint;
  performanceFeeBps: bigint;
  feeRecipient: string;
  now: bigint;
}

export function initVaultShares(config: VaultShareConfig): VaultShareState {
  assertBps(config.managementFeeBps, "Management fee");
  assertBps(config.performanceFeeBps, "Performance fee");
  return {
    totalShares: 0n,
    nav: 0n,
    highWaterMark: SCALE,
    managementFeeBps: config.managementFeeBps,
    performanceFeeBps: config.performanceFeeBps,
    feeRecipient: config.feeRecipient,
    feesOwed: 0n,
    lastAccrual: config.now,
  };
}

export function setFeeRecipient(state: VaultShareState, feeRecipient: string): VaultShareState {
  return { ...state, feeRecipient };
}

/** NAV-per-share in SCALE units. An empty vault prices at 1.0. */
export function sharePrice(state: VaultShareState): bigint {
  if (state.totalShares === 0n) return SCALE;
  return (state.nav * SCALE) / state.totalShares;
}

export function mintShares(
  state: VaultShareState,
  assets: bigint,
  now: bigint,
): { state: VaultShareState; shares: bigint } {
  if (assets <= 0n) throw new Error("Deposit must be a positive amount");
  const accrued = accrueFees(state, now);
  const shares = assetsToShares(accrued, assets);
  if (shares === 0n) throw new Error("Deposit mints zero shares");
  return {
    state: { ...creditNav(accrued, assets), totalShares: accrued.totalShares + shares },
    shares,
  };
}

export function burnShares(
  state: VaultShareState,
  shares: bigint,
  now: bigint,
): { state: VaultShareState; assets: bigint } {
  if (shares <= 0n) throw new Error("Withdrawal must burn a positive number of shares");
  const accrued = accrueFees(state, now);
  if (shares > accrued.totalShares) throw new Error("Withdrawal exceeds shares outstanding");
  const assets = sharesToAssets(accrued, shares);
  if (assets === 0n) throw new Error("Withdrawal returns zero assets");
  const totalShares = accrued.totalShares - shares;
  return {
    state: {
      ...debitNav(accrued, assets),
      totalShares,
      // A fully emptied vault re-prices from 1.0, so the high-water mark restarts with it.
      highWaterMark: totalShares === 0n ? SCALE : accrued.highWaterMark,
    },
    assets,
  };
}

export function recordPremium(state: VaultShareState, amount: bigint, now: bigint): VaultShareState {
  if (amount <= 0n) throw new Error("Premium must be a positive amount");
  if (state.totalShares === 0n) throw new Error("Cannot book premium into a vault with no shares");
  return creditNav(accrueFees(state, now), amount);
}

/** Realized losses from assignment or exercise. NAV floors at zero. */
export function recordRealizedLoss(state: VaultShareState, amount: bigint, now: bigint): VaultShareState {
  if (amount < 0n) throw new Error("Realized loss cannot be negative");
  return debitNav(accrueFees(state, now), amount);
}

/**
 * Accrues management fees pro rata over elapsed time, then the performance fee
 * on any NAV-per-share above the high-water mark. Both are taken out of NAV
 * into feesOwed. The high-water mark is raised to the post-fee price, so a
 * gain is charged once and a drawdown is not charged again on recovery.
 */
export function accrueFees(state: VaultShareState, now: bigint): VaultShareState {
  if (now < state.lastAccrual) throw new Error("Fee accrual time went backwards");

  let next = state;
  const elapsed = now - state.lastAccrual;
  if (elapsed > 0n && next.nav > 0n) {
    const managementFee = (next.nav * next.managementFeeBps * elapsed) / (BPS * SECONDS_PER_YEAR);
    next = takeFee(next, managementFee);
  }
  next = { ...next, lastAccrual: now };

  if (next.totalShares > 0n) {
    const price = sharePrice(next);
    if (price > next.highWaterMark) {
      const gain = ((price - next.highWaterMark) * next.totalShares) / SCALE;
      const performanceFee = (gain * next.performanceFeeBps) / BPS;
      next = takeFee(next, performanceFee);
      const postFeePrice = sharePrice(next);
      next = { ...next, highWaterMark: postFeePrice > next.highWaterMark ? postFeePrice : next.highWaterMark };
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Internal helpers. The only places NAV and share totals are changed.
// ---------------------------------------------------------------------------

function assetsToShares(state: VaultShareState, assets: bigint): bigint {
  if (state.totalShares === 0n) return assets;
  if (state.nav === 0n) throw new Error("Vault NAV is zero while shares are outstanding");
  return (assets * state.totalShares) / state.nav;
}

function sharesToAssets(state: VaultShareState, shares: bigint): bigint {
  return (shares * state.nav) / state.totalShares;
}

function creditNav(state: VaultShareState, amount: bigint): VaultShareState {
  return { ...state, nav: state.nav + amount };
}

function debitNav(state: VaultShareState, amount: bigint): VaultShareState {
  return { ...state, nav: amount >= state.nav ? 0n : state.nav - amount };
}

function takeFee(state: VaultShareState, fee: bigint): VaultShareState {
  if (fee <= 0n) return state;
  const taken = fee > state.nav ? state.nav : fee;
  return { ...debitNav(state, taken), feesOwed: state.feesOwed + taken };
}

function assertBps(value: bigint, label: string): void {
  if (value < 0n || value > BPS) throw new Error(`${label} must be between 0 and ${BPS} basis points`);
}
