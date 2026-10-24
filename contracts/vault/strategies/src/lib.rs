//! Pluggable vault strategy modules: covered call, cash-secured put, iron condor, wheel.
//!
//! Every module implements `vault_core::Strategy`, is pure with respect to the vault's
//! accounting state, and returns an `Intent` for the epoch engine to execute. When no
//! eligible listed strike exists the module returns a no-op intent rather than panicking.

use vault_core::*;

pub const COVERED_CALL: &str = "covered_call";
pub const CASH_SECURED_PUT: &str = "cash_secured_put";
pub const IRON_CONDOR: &str = "iron_condor";
pub const WHEEL: &str = "wheel";

/// Resolve a strategy module by registry id so the vault core never branches on name.
pub fn strategy_by_id(id: &str) -> Option<&'static dyn Strategy> {
    match id {
        COVERED_CALL => Some(&CoveredCall),
        CASH_SECURED_PUT => Some(&CashSecuredPut),
        IRON_CONDOR => Some(&IronCondor),
        WHEEL => Some(&Wheel),
        _ => None,
    }
}

/// Sell one batch of single-leg options, sized by collateral, capacity and position slots.
fn short_single(
    inputs: &EpochInputs,
    params: &StrategyParams,
    kind: OptionKind,
    closing: usize,
) -> Intent {
    if position_slots(inputs, params, closing) == 0 {
        return Intent::default();
    }
    let Some(option) = select_strike(inputs, params, kind) else {
        return Intent::default();
    };
    let (collateral, available, per_contract) = match kind {
        OptionKind::Call => (
            Collateral::Underlying,
            inputs.underlying_available,
            inputs.underlying_per_contract,
        ),
        OptionKind::Put => (
            Collateral::Settlement,
            inputs.settlement_available,
            option.strike * inputs.settlement_per_strike_unit,
        ),
    };
    let quantity = max_contracts(available, inputs.capacity_remaining, per_contract);
    if quantity == 0 {
        return Intent::default();
    }
    Intent {
        close: Vec::new(),
        open: vec![OpenGroup {
            orders: vec![Order { option, short: true, quantity }],
            collateral,
            collateral_required: quantity * per_contract,
        }],
    }
}

/// Apply the roll policy around a module-specific `build` of the next epoch's opens.
fn roll_with(
    inputs: &EpochInputs,
    params: &StrategyParams,
    build: impl Fn(usize) -> Intent,
) -> Intent {
    let all: Vec<u64> = inputs.open_positions.iter().map(|p| p.id).collect();
    match params.roll_policy {
        RollPolicy::HoldToExpiry => Intent::default(),
        RollPolicy::Always => Intent { close: all.clone(), ..build(all.len()) },
        RollPolicy::OnlyIfAcceptable => {
            let next = build(all.len());
            if next.open.is_empty() {
                Intent::default()
            } else {
                Intent { close: all, ..next }
            }
        }
    }
}

pub struct CoveredCall;

impl Strategy for CoveredCall {
    fn id(&self) -> &'static str {
        COVERED_CALL
    }
    fn collateral(&self, _: &EpochInputs) -> Collateral {
        Collateral::Underlying
    }
    fn preview(&self, i: &EpochInputs, p: &StrategyParams) -> Intent {
        short_single(i, p, OptionKind::Call, 0)
    }
    fn roll(&self, i: &EpochInputs, p: &StrategyParams) -> Intent {
        roll_with(i, p, |c| short_single(i, p, OptionKind::Call, c))
    }
    /// Called away: the vault is flat until the next epoch's open.
    fn handle_assignment(&self, _: &EpochInputs, _: &StrategyParams, _: &Position) -> Intent {
        Intent::default()
    }
}

pub struct CashSecuredPut;

impl Strategy for CashSecuredPut {
    fn id(&self) -> &'static str {
        CASH_SECURED_PUT
    }
    fn collateral(&self, _: &EpochInputs) -> Collateral {
        Collateral::Settlement
    }
    fn preview(&self, i: &EpochInputs, p: &StrategyParams) -> Intent {
        short_single(i, p, OptionKind::Put, 0)
    }
    fn roll(&self, i: &EpochInputs, p: &StrategyParams) -> Intent {
        roll_with(i, p, |c| short_single(i, p, OptionKind::Put, c))
    }
    /// Assigned underlying is handed to settlement; nothing further to open.
    fn handle_assignment(&self, _: &EpochInputs, _: &StrategyParams, _: &Position) -> Intent {
        Intent::default()
    }
}

pub struct IronCondor;

/// Nearest listed, liquid long wing in the same expiry at least `wing_width_bps` beyond the short strike.
fn wing(i: &EpochInputs, p: &StrategyParams, short: &ListedOption) -> Option<ListedOption> {
    let gap = i.spot * p.wing_width_bps as i128 / 10_000;
    let cands = i.listed.iter().filter(|o| {
        o.kind == short.kind
            && o.liquid
            && o.expiry_days == short.expiry_days
            && match short.kind {
                OptionKind::Call => o.strike >= short.strike + gap.max(1),
                OptionKind::Put => o.strike <= short.strike - gap.max(1),
            }
    });
    match short.kind {
        OptionKind::Call => cands.min_by_key(|o| o.strike).copied(),
        OptionKind::Put => cands.max_by_key(|o| o.strike).copied(),
    }
}

fn condor(i: &EpochInputs, p: &StrategyParams, closing: usize) -> Intent {
    if position_slots(i, p, closing) < 4 {
        return Intent::default();
    }
    let (Some(sp), Some(sc)) = (
        select_strike(i, p, OptionKind::Put),
        select_strike(i, p, OptionKind::Call),
    ) else {
        return Intent::default();
    };
    if sp.expiry_days != sc.expiry_days {
        return Intent::default();
    }
    let (Some(lp), Some(lc)) = (wing(i, p, &sp), wing(i, p, &sc)) else {
        return Intent::default();
    };
    // Max loss per condor is the wider wing, since only one side can finish in the money.
    let width = (sp.strike - lp.strike).max(lc.strike - sc.strike);
    let per_contract = width * i.settlement_per_strike_unit;
    let quantity = max_contracts(i.settlement_available, i.capacity_remaining, per_contract);
    if quantity == 0 {
        return Intent::default();
    }
    let leg = |option, short| Order { option, short, quantity };
    Intent {
        close: Vec::new(),
        open: vec![OpenGroup {
            orders: vec![leg(sp, true), leg(lp, false), leg(sc, true), leg(lc, false)],
            collateral: Collateral::Settlement,
            collateral_required: quantity * per_contract,
        }],
    }
}

impl Strategy for IronCondor {
    fn id(&self) -> &'static str {
        IRON_CONDOR
    }
    fn collateral(&self, _: &EpochInputs) -> Collateral {
        Collateral::Settlement
    }
    fn preview(&self, i: &EpochInputs, p: &StrategyParams) -> Intent {
        condor(i, p, 0)
    }
    fn roll(&self, i: &EpochInputs, p: &StrategyParams) -> Intent {
        roll_with(i, p, |c| condor(i, p, c))
    }
    /// Max loss is capped by the wings and settles with the position; nothing to chain.
    fn handle_assignment(&self, _: &EpochInputs, _: &StrategyParams, _: &Position) -> Intent {
        Intent::default()
    }
}

pub struct Wheel;

/// Which leg the wheel runs, derived from balances so a wheel caught mid-assignment
/// across an epoch boundary resumes correctly with no operator intervention.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WheelStage {
    Puts,
    Calls,
}

impl Wheel {
    pub fn stage(i: &EpochInputs) -> WheelStage {
        let holds_underlying = i.underlying_per_contract > 0
            && i.underlying_available >= i.underlying_per_contract;
        let short_call_open = i
            .open_positions
            .iter()
            .any(|p| p.short && p.option.kind == OptionKind::Call);
        if holds_underlying || short_call_open {
            WheelStage::Calls
        } else {
            WheelStage::Puts
        }
    }

    fn build(i: &EpochInputs, p: &StrategyParams, closing: usize) -> Intent {
        let kind = match Self::stage(i) {
            WheelStage::Calls => OptionKind::Call,
            WheelStage::Puts => OptionKind::Put,
        };
        short_single(i, p, kind, closing)
    }
}

impl Strategy for Wheel {
    fn id(&self) -> &'static str {
        WHEEL
    }
    fn collateral(&self, i: &EpochInputs) -> Collateral {
        match Self::stage(i) {
            WheelStage::Calls => Collateral::Underlying,
            WheelStage::Puts => Collateral::Settlement,
        }
    }
    fn preview(&self, i: &EpochInputs, p: &StrategyParams) -> Intent {
        Self::build(i, p, 0)
    }
    fn roll(&self, i: &EpochInputs, p: &StrategyParams) -> Intent {
        roll_with(i, p, |c| Self::build(i, p, c))
    }
    /// Put assigned -> `inputs` now holds the underlying -> next leg is a covered call.
    /// Call exercised -> underlying is gone -> next leg is a put. Either way the wheel
    /// ends in a covered call, a put, or flat (no eligible strike); it never stalls.
    fn handle_assignment(&self, i: &EpochInputs, p: &StrategyParams, _: &Position) -> Intent {
        Self::build(i, p, 0)
    }
}
