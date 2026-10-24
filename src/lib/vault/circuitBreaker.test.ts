/**
 * Tests for circuitBreaker.ts — #256 Automated Drawdown Circuit Breakers
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_BREAKER_CONFIG,
  evaluateBreakers,
  applyBreakerDecision,
  initiateRecovery,
  acknowledgeRecovery,
  manualHalt,
  initialBreakerState,
  canWritePositions,
  depositsBlocked,
  breakerStatusLabel,
  type VaultBreakerMetrics,
  type VaultBreakerState,
} from "./circuitBreaker";

const BASE_METRICS: VaultBreakerMetrics = {
  currentNav: 1.0,
  hwmNav: 1.0,
  epochStartNav: 1.0,
  epochRealizedPnl: 0,
  epochMtmPnl: 0,
};

// ---------------------------------------------------------------------------
// evaluateBreakers — healthy
// ---------------------------------------------------------------------------
describe("evaluateBreakers — healthy state", () => {
  it("returns ACTIVE when no threshold is breached", () => {
    const d = evaluateBreakers(BASE_METRICS, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    expect(d.newStatus).toBe("ACTIVE");
    expect(d.trigger).toBe("NONE");
  });
});

// ---------------------------------------------------------------------------
// evaluateBreakers — warn thresholds
// ---------------------------------------------------------------------------
describe("evaluateBreakers — warn thresholds", () => {
  it("warns on realized drawdown at warn threshold", () => {
    const metrics: VaultBreakerMetrics = {
      ...BASE_METRICS,
      epochRealizedPnl: -0.06, // 6% > 5% warn
    };
    const d = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    expect(d.newStatus).toBe("WARNED");
    expect(d.trigger).toBe("REALIZED_DRAWDOWN_WARN");
  });

  it("warns on MTM drawdown at warn threshold", () => {
    const metrics: VaultBreakerMetrics = {
      ...BASE_METRICS,
      epochMtmPnl: -0.08, // 8% > 7% warn
    };
    const d = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    expect(d.newStatus).toBe("WARNED");
    expect(d.trigger).toBe("MTM_DRAWDOWN_WARN");
  });

  it("warns on epoch loss at warn threshold", () => {
    const metrics: VaultBreakerMetrics = {
      ...BASE_METRICS,
      currentNav: 0.96, // 4% epoch loss > 3% warn
    };
    const d = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    expect(d.newStatus).toBe("WARNED");
    expect(d.trigger).toBe("EPOCH_LOSS_WARN");
  });
});

// ---------------------------------------------------------------------------
// evaluateBreakers — halt thresholds
// ---------------------------------------------------------------------------
describe("evaluateBreakers — halt thresholds", () => {
  it("halts on realized drawdown at halt threshold", () => {
    const metrics: VaultBreakerMetrics = {
      ...BASE_METRICS,
      epochRealizedPnl: -0.11, // 11% > 10% halt
    };
    const d = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    expect(d.newStatus).toBe("HALTED");
    expect(d.trigger).toBe("REALIZED_DRAWDOWN_HALT");
  });

  it("halts on MTM drawdown at halt threshold", () => {
    const metrics: VaultBreakerMetrics = {
      ...BASE_METRICS,
      epochMtmPnl: -0.16,
    };
    const d = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    expect(d.newStatus).toBe("HALTED");
    expect(d.trigger).toBe("MTM_DRAWDOWN_HALT");
  });

  it("halts on epoch loss at halt threshold", () => {
    const metrics: VaultBreakerMetrics = {
      ...BASE_METRICS,
      currentNav: 0.91, // 9% > 8% halt
    };
    const d = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    expect(d.newStatus).toBe("HALTED");
    expect(d.trigger).toBe("EPOCH_LOSS_HALT");
  });

  it("halt takes priority over warn when both breached", () => {
    const metrics: VaultBreakerMetrics = {
      ...BASE_METRICS,
      epochRealizedPnl: -0.11, // crosses both
    };
    const d = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    expect(d.newStatus).toBe("HALTED");
  });
});

// ---------------------------------------------------------------------------
// evaluateBreakers — locked states
// ---------------------------------------------------------------------------
describe("evaluateBreakers — locked states", () => {
  it("does not change status when already HALTED (metrics still bad)", () => {
    const metrics: VaultBreakerMetrics = { ...BASE_METRICS, epochRealizedPnl: -0.2 };
    const d = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "HALTED");
    expect(d.newStatus).toBe("HALTED");
  });

  it("does not auto-recover from RECOVERING even if metrics are healthy", () => {
    const d = evaluateBreakers(BASE_METRICS, DEFAULT_BREAKER_CONFIG, "RECOVERING");
    expect(d.newStatus).toBe("RECOVERING");
  });
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
describe("applyBreakerDecision", () => {
  it("returns same state when status unchanged", () => {
    const state = initialBreakerState();
    const decision = { newStatus: "ACTIVE" as const, trigger: "NONE" as const, description: "" };
    expect(applyBreakerDecision(state, decision, BASE_METRICS)).toBe(state);
  });

  it("transitions to WARNED and records metrics", () => {
    const state = initialBreakerState();
    const metrics: VaultBreakerMetrics = { ...BASE_METRICS, epochRealizedPnl: -0.06 };
    const decision = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    const next = applyBreakerDecision(state, decision, metrics);
    expect(next.status).toBe("WARNED");
    expect(next.triggeringMetrics).toEqual(metrics);
  });

  it("transitions ACTIVE → HALTED directly (no WARNED step required)", () => {
    const state = initialBreakerState();
    const metrics: VaultBreakerMetrics = { ...BASE_METRICS, epochRealizedPnl: -0.15 };
    const decision = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    const next = applyBreakerDecision(state, decision, metrics);
    expect(next.status).toBe("HALTED");
  });
});

describe("recovery path", () => {
  function haltedState(): VaultBreakerState {
    const s = initialBreakerState();
    const metrics: VaultBreakerMetrics = { ...BASE_METRICS, epochRealizedPnl: -0.15 };
    const d = evaluateBreakers(metrics, DEFAULT_BREAKER_CONFIG, "ACTIVE");
    return applyBreakerDecision(s, d, metrics);
  }

  it("HALTED → RECOVERING via initiateRecovery", () => {
    const next = initiateRecovery(haltedState());
    expect(next.status).toBe("RECOVERING");
  });

  it("RECOVERING → ACTIVE via acknowledgeRecovery", () => {
    const recovering = initiateRecovery(haltedState());
    const active = acknowledgeRecovery(recovering);
    expect(active.status).toBe("ACTIVE");
    expect(active.trigger).toBe("NONE");
    expect(active.triggeringMetrics).toBeNull();
  });

  it("throws initiateRecovery when not HALTED", () => {
    expect(() => initiateRecovery(initialBreakerState())).toThrow();
  });

  it("throws acknowledgeRecovery when not RECOVERING", () => {
    expect(() => acknowledgeRecovery(haltedState())).toThrow();
  });
});

describe("manualHalt", () => {
  it("halts an ACTIVE vault", () => {
    const s = manualHalt(initialBreakerState(), BASE_METRICS);
    expect(s.status).toBe("HALTED");
    expect(s.trigger).toBe("MANUAL_HALT");
  });

  it("halts a WARNED vault", () => {
    const warned: VaultBreakerState = { ...initialBreakerState(), status: "WARNED", trigger: "REALIZED_DRAWDOWN_WARN" };
    const s = manualHalt(warned, BASE_METRICS);
    expect(s.status).toBe("HALTED");
  });

  it("is a no-op when already HALTED", () => {
    const halted: VaultBreakerState = { ...initialBreakerState(), status: "HALTED", trigger: "MANUAL_HALT" };
    expect(manualHalt(halted, BASE_METRICS)).toBe(halted);
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
describe("guards", () => {
  it("canWritePositions is true only for ACTIVE", () => {
    expect(canWritePositions({ ...initialBreakerState(), status: "ACTIVE" })).toBe(true);
    expect(canWritePositions({ ...initialBreakerState(), status: "WARNED" })).toBe(false);
    expect(canWritePositions({ ...initialBreakerState(), status: "HALTED" })).toBe(false);
    expect(canWritePositions({ ...initialBreakerState(), status: "RECOVERING" })).toBe(false);
  });

  it("depositsBlocked only for HALTED and RECOVERING", () => {
    expect(depositsBlocked({ ...initialBreakerState(), status: "ACTIVE" })).toBe(false);
    expect(depositsBlocked({ ...initialBreakerState(), status: "WARNED" })).toBe(false);
    expect(depositsBlocked({ ...initialBreakerState(), status: "HALTED" })).toBe(true);
    expect(depositsBlocked({ ...initialBreakerState(), status: "RECOVERING" })).toBe(true);
  });

  it("breakerStatusLabel returns readable strings", () => {
    expect(breakerStatusLabel("ACTIVE")).toBe("Active");
    expect(breakerStatusLabel("WARNED")).toBe("Warning");
    expect(breakerStatusLabel("HALTED")).toBe("Halted");
    expect(breakerStatusLabel("RECOVERING")).toBe("Recovering");
  });
});
