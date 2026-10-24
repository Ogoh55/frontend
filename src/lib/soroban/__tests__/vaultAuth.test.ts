/**
 * Tests for vaultAuth.ts — #255 Soroban Authorization Scoping and Replay Protection
 */

import { describe, it, expect } from "vitest";
import {
  buildAuthEnvelope,
  buildAuthHeaders,
  entryPointScope,
  nonceKey,
  validateAuthEnvelope,
  type DepositPayload,
  type RedeemRequestPayload,
  type WithdrawPayload,
  type EpochRolloverPayload,
  type UpdateParamsPayload,
} from "../vaultAuth";

const VAULT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CALLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const CURRENT_LEDGER = 1_000_000;

// ---------------------------------------------------------------------------
// entryPointScope
// ---------------------------------------------------------------------------
describe("entryPointScope", () => {
  it("prefixes every entry point with 'vault:'", () => {
    expect(entryPointScope("deposit")).toBe("vault:deposit");
    expect(entryPointScope("redeem_request")).toBe("vault:redeem_request");
    expect(entryPointScope("withdraw")).toBe("vault:withdraw");
    expect(entryPointScope("epoch_rollover")).toBe("vault:epoch_rollover");
    expect(entryPointScope("update_params")).toBe("vault:update_params");
  });
});

// ---------------------------------------------------------------------------
// nonceKey
// ---------------------------------------------------------------------------
describe("nonceKey", () => {
  it("produces a deterministic composite key", () => {
    expect(nonceKey(CALLER, VAULT_ID, "vault:deposit")).toBe(
      `${CALLER}:${VAULT_ID}:vault:deposit`
    );
  });

  it("differs for different scopes", () => {
    const k1 = nonceKey(CALLER, VAULT_ID, "vault:deposit");
    const k2 = nonceKey(CALLER, VAULT_ID, "vault:withdraw");
    expect(k1).not.toBe(k2);
  });

  it("differs for different vaults", () => {
    const VAULT2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const k1 = nonceKey(CALLER, VAULT_ID, "vault:deposit");
    const k2 = nonceKey(CALLER, VAULT2, "vault:deposit");
    expect(k1).not.toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// buildAuthEnvelope
// ---------------------------------------------------------------------------
describe("buildAuthEnvelope", () => {
  const depositPayload: DepositPayload = { entry_point: "deposit", amount: 1_000_000n };

  it("sets scope from entry point", () => {
    const env = buildAuthEnvelope("deposit", VAULT_ID, CALLER, 42, CURRENT_LEDGER, depositPayload);
    expect(env.scope).toBe("vault:deposit");
  });

  it("sets valid_before_ledger = currentLedger + windowLedgers (default 60)", () => {
    const env = buildAuthEnvelope("deposit", VAULT_ID, CALLER, 42, CURRENT_LEDGER, depositPayload);
    expect(env.valid_before_ledger).toBe(CURRENT_LEDGER + 60);
  });

  it("respects custom window", () => {
    const env = buildAuthEnvelope("deposit", VAULT_ID, CALLER, 42, CURRENT_LEDGER, depositPayload, 120);
    expect(env.valid_before_ledger).toBe(CURRENT_LEDGER + 120);
  });

  it("throws when payload entry_point mismatches requested entry_point", () => {
    const wrongPayload: RedeemRequestPayload = { entry_point: "redeem_request", shares: 100n };
    expect(() =>
      buildAuthEnvelope("deposit", VAULT_ID, CALLER, 1, CURRENT_LEDGER, wrongPayload)
    ).toThrow(/does not match/);
  });

  it("two envelopes with different entry points have different scopes", () => {
    const withdrawPayload: WithdrawPayload = { entry_point: "withdraw", shares: 50n };
    const env1 = buildAuthEnvelope("deposit", VAULT_ID, CALLER, 1, CURRENT_LEDGER, depositPayload);
    const env2 = buildAuthEnvelope("withdraw", VAULT_ID, CALLER, 2, CURRENT_LEDGER, withdrawPayload);
    expect(env1.scope).not.toBe(env2.scope);
  });

  it("two envelopes for different vaults have different vault_id", () => {
    const VAULT2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const env1 = buildAuthEnvelope("deposit", VAULT_ID, CALLER, 1, CURRENT_LEDGER, depositPayload);
    const env2 = buildAuthEnvelope("deposit", VAULT2, CALLER, 1, CURRENT_LEDGER, depositPayload);
    expect(env1.vault_id).not.toBe(env2.vault_id);
  });
});

// ---------------------------------------------------------------------------
// validateAuthEnvelope
// ---------------------------------------------------------------------------
describe("validateAuthEnvelope", () => {
  function makeEnv(overrides: Partial<Parameters<typeof buildAuthEnvelope>[5] extends never ? object : object> = {}) {
    const payload: DepositPayload = { entry_point: "deposit", amount: 1_000_000n };
    const env = buildAuthEnvelope("deposit", VAULT_ID, CALLER, 7, CURRENT_LEDGER, payload);
    return { ...env, ...overrides };
  }

  it("returns valid for a well-formed envelope", () => {
    const env = makeEnv();
    const result = validateAuthEnvelope(env, CURRENT_LEDGER, 7);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when scope mismatches payload entry_point", () => {
    const env = makeEnv();
    // Tamper scope without changing payload
    const tampered = { ...env, scope: "vault:withdraw" as const };
    const result = validateAuthEnvelope(tampered, CURRENT_LEDGER, 7);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("scope mismatch"))).toBe(true);
  });

  it("fails when valid_before_ledger is in the past", () => {
    const env = makeEnv();
    const stale = { ...env, valid_before_ledger: CURRENT_LEDGER - 1 };
    const result = validateAuthEnvelope(stale, CURRENT_LEDGER, null);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("valid_before_ledger"))).toBe(true);
  });

  it("fails when valid_before_ledger window is too large", () => {
    const env = makeEnv();
    const tooLong = { ...env, valid_before_ledger: CURRENT_LEDGER + 9999 };
    const result = validateAuthEnvelope(tooLong, CURRENT_LEDGER, null);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("too large"))).toBe(true);
  });

  it("fails when nonce is wrong", () => {
    const env = makeEnv();
    const result = validateAuthEnvelope(env, CURRENT_LEDGER, 99);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("nonce mismatch"))).toBe(true);
  });

  it("passes nonce check when knownNonce is null", () => {
    const env = makeEnv();
    const result = validateAuthEnvelope(env, CURRENT_LEDGER, null);
    expect(result.valid).toBe(true);
  });

  it("fails for invalid caller format", () => {
    const env = makeEnv();
    const bad = { ...env, caller: "not-a-stellar-address" };
    const result = validateAuthEnvelope(bad, CURRENT_LEDGER, 7);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("G-address"))).toBe(true);
  });

  it("fails for empty vault_id", () => {
    const env = makeEnv();
    const bad = { ...env, vault_id: "" };
    const result = validateAuthEnvelope(bad, CURRENT_LEDGER, 7);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("vault_id"))).toBe(true);
  });

  it("fails for zero deposit amount", () => {
    const payload: DepositPayload = { entry_point: "deposit", amount: 0n };
    const env = buildAuthEnvelope("deposit", VAULT_ID, CALLER, 7, CURRENT_LEDGER, payload);
    const result = validateAuthEnvelope(env, CURRENT_LEDGER, 7);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("deposit amount"))).toBe(true);
  });

  it("fails for zero redeem_request shares", () => {
    const payload: RedeemRequestPayload = { entry_point: "redeem_request", shares: 0n };
    const env = buildAuthEnvelope("redeem_request", VAULT_ID, CALLER, 7, CURRENT_LEDGER, payload);
    const result = validateAuthEnvelope(env, CURRENT_LEDGER, 7);
    expect(result.valid).toBe(false);
  });

  it("collects multiple errors", () => {
    const payload: DepositPayload = { entry_point: "deposit", amount: 0n };
    const env = buildAuthEnvelope("deposit", VAULT_ID, CALLER, 7, CURRENT_LEDGER, payload);
    const bad = { ...env, caller: "bad", vault_id: "" };
    const result = validateAuthEnvelope(bad, CURRENT_LEDGER, 7);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// buildAuthHeaders
// ---------------------------------------------------------------------------
describe("buildAuthHeaders", () => {
  it("returns all four required headers", () => {
    const payload: EpochRolloverPayload = { entry_point: "epoch_rollover", current_epoch: 5, next_epoch: 6 };
    const env = buildAuthEnvelope("epoch_rollover", VAULT_ID, CALLER, 1, CURRENT_LEDGER, payload);
    const headers = buildAuthHeaders(env);
    expect(headers["x-vault-scope"]).toBe("vault:epoch_rollover");
    expect(headers["x-vault-nonce"]).toBe("1");
    expect(headers["x-vault-valid-before"]).toBe(String(CURRENT_LEDGER + 60));
    expect(headers["x-vault-vault-id"]).toBe(VAULT_ID);
  });

  it("update_params scope header is correct", () => {
    const payload: UpdateParamsPayload = { entry_point: "update_params", params: { max_tvl: 1000000 } };
    const env = buildAuthEnvelope("update_params", VAULT_ID, CALLER, 3, CURRENT_LEDGER, payload);
    const headers = buildAuthHeaders(env);
    expect(headers["x-vault-scope"]).toBe("vault:update_params");
  });
});
