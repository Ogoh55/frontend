//! Shared strategy interface for the vault suite.
//!
//! Strategy modules are pure: they read `EpochInputs` and the listed option set
//! and return an `Intent`. The epoch engine executes the intent. The vault core
//! resolves modules by `Strategy::id()` and never branches on strategy name.
//! All amounts are integers in the vault's own units; strategies never re-derive
//! collateral units or share decimals.

/// Which asset a strategy posts as collateral.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Collateral {
    /// The optionable (underlying) asset.
    Underlying,
    /// The vault's settlement asset.
    Settlement,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionKind {
    Call,
    Put,
}

/// How the short strike is targeted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrikeTarget {
    /// Target absolute delta in basis points (2000 = 0.20).
    DeltaBps(u32),
    /// Target out-of-the-money distance from spot in basis points.
    OtmBps(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RollPolicy {
    /// Close and re-open every epoch.
    Always,
    /// Close only if the next epoch has an acceptable strike; otherwise hold.
    OnlyIfAcceptable,
    /// Never roll; positions run to expiry.
    HoldToExpiry,
}

/// Operator-settable, per-vault parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StrategyParams {
    pub target: StrikeTarget,
    pub min_tenor_days: u32,
    pub max_tenor_days: u32,
    pub max_positions: u32,
    pub roll_policy: RollPolicy,
    /// Iron condor long-wing distance beyond the short strikes, in bps of spot.
    pub wing_width_bps: u32,
}

/// A strike/expiry listed by the options engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListedOption {
    pub kind: OptionKind,
    pub strike: i128,
    pub expiry_days: u32,
    /// Absolute delta in basis points.
    pub delta_bps: u32,
    pub liquid: bool,
}

/// A position held by the vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub id: u64,
    pub option: ListedOption,
    pub short: bool,
    pub quantity: i128,
}

/// Inputs for one epoch decision, supplied by the epoch engine.
#[derive(Clone, Debug)]
pub struct EpochInputs<'a> {
    pub spot: i128,
    /// Free collateral per asset.
    pub underlying_available: i128,
    pub settlement_available: i128,
    /// Remaining vault capacity, in the units of the collateral being posted.
    pub capacity_remaining: i128,
    /// Underlying units locked by one covered-call contract.
    pub underlying_per_contract: i128,
    /// Settlement units locked per contract per 1 unit of strike (put notional / spread width).
    pub settlement_per_strike_unit: i128,
    pub open_positions: &'a [Position],
    pub listed: &'a [ListedOption],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    pub option: ListedOption,
    pub short: bool,
    pub quantity: i128,
}

/// Orders opened together and backed by a single collateral lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenGroup {
    pub orders: Vec<Order>,
    pub collateral: Collateral,
    pub collateral_required: i128,
}

/// What the epoch engine should execute. An empty intent is a valid no-op.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Intent {
    pub close: Vec<u64>,
    pub open: Vec<OpenGroup>,
}

impl Intent {
    pub fn is_noop(&self) -> bool {
        self.close.is_empty() && self.open.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentError {
    WrongCollateral,
    InsufficientCollateral,
    ExceedsCapacity,
    NotListed,
    TooManyPositions,
}

/// The common interface implemented by every strategy module.
pub trait Strategy {
    /// Stable registry id.
    fn id(&self) -> &'static str;
    /// Collateral type the module posts; the risk module validates this before any open.
    fn collateral(&self, inputs: &EpochInputs) -> Collateral;
    /// Preview next epoch's selection (opens only) without side effects.
    fn preview(&self, inputs: &EpochInputs, params: &StrategyParams) -> Intent;
    /// Open fresh positions, closing nothing.
    fn open(&self, inputs: &EpochInputs, params: &StrategyParams) -> Intent {
        self.preview(inputs, params)
    }
    /// Roll at an epoch boundary according to `params.roll_policy`.
    fn roll(&self, inputs: &EpochInputs, params: &StrategyParams) -> Intent;
    /// React to an in-the-money expiry (assignment / exercise) of `position`.
    /// `inputs` must already reflect the post-assignment balances.
    fn handle_assignment(
        &self,
        inputs: &EpochInputs,
        params: &StrategyParams,
        position: &Position,
    ) -> Intent;
    /// Close everything.
    fn wind_down(&self, inputs: &EpochInputs) -> Intent {
        Intent {
            close: inputs.open_positions.iter().map(|p| p.id).collect(),
            open: Vec::new(),
        }
    }
}

/// Pick the listed, liquid option of `kind` inside the tenor window closest to the target.
/// Ties break toward the lower strike, then the shorter expiry, so selection is deterministic.
pub fn select_strike(
    inputs: &EpochInputs,
    params: &StrategyParams,
    kind: OptionKind,
) -> Option<ListedOption> {
    let spot = inputs.spot.max(1);
    let distance = |o: &ListedOption| -> i128 {
        match params.target {
            StrikeTarget::DeltaBps(d) => (o.delta_bps as i128 - d as i128).abs(),
            StrikeTarget::OtmBps(b) => {
                let otm = match kind {
                    OptionKind::Call => (o.strike - inputs.spot) * 10_000 / spot,
                    OptionKind::Put => (inputs.spot - o.strike) * 10_000 / spot,
                };
                (otm - b as i128).abs()
            }
        }
    };
    inputs
        .listed
        .iter()
        .filter(|o| {
            o.kind == kind
                && o.liquid
                && o.expiry_days >= params.min_tenor_days
                && o.expiry_days <= params.max_tenor_days
                && match kind {
                    OptionKind::Call => o.strike > inputs.spot,
                    OptionKind::Put => o.strike < inputs.spot,
                }
        })
        .min_by_key(|o| (distance(o), o.strike, o.expiry_days))
        .copied()
}

/// Contracts affordable under both the collateral and capacity limits.
pub fn max_contracts(available: i128, capacity: i128, per_contract: i128) -> i128 {
    if per_contract <= 0 {
        return 0;
    }
    available.min(capacity).max(0) / per_contract
}

/// Number of new positions the vault may still open after `closing` are closed.
pub fn position_slots(inputs: &EpochInputs, params: &StrategyParams, closing: usize) -> usize {
    let held = inputs.open_positions.len().saturating_sub(closing);
    (params.max_positions as usize).saturating_sub(held)
}

/// Risk-module check: an intent is executable only if it is listed, within
/// position limits, uses the declared collateral, is fully collateralised and
/// fits the vault's remaining capacity.
pub fn validate_intent(
    intent: &Intent,
    declared: Collateral,
    inputs: &EpochInputs,
    params: &StrategyParams,
) -> Result<(), IntentError> {
    if position_slots(inputs, params, intent.close.len()) < intent.open.len() {
        return Err(IntentError::TooManyPositions);
    }
    let (mut used_u, mut used_s) = (0i128, 0i128);
    for g in &intent.open {
        if g.collateral != declared {
            return Err(IntentError::WrongCollateral);
        }
        if g.orders.iter().any(|o| !inputs.listed.contains(&o.option)) {
            return Err(IntentError::NotListed);
        }
        match g.collateral {
            Collateral::Underlying => used_u += g.collateral_required,
            Collateral::Settlement => used_s += g.collateral_required,
        }
    }
    if used_u > inputs.underlying_available || used_s > inputs.settlement_available {
        return Err(IntentError::InsufficientCollateral);
    }
    if used_u + used_s > inputs.capacity_remaining.max(0) {
        return Err(IntentError::ExceedsCapacity);
    }
    Ok(())
}
