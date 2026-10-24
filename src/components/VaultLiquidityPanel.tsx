"use client";

/**
 * VaultLiquidityPanel — Issue #241
 *
 * Operator-facing panel for redemption liquidity management.
 * Shows the current cash buffer vs. target, queued redemption demand,
 * the computed JIT unwind plan (if needed), and controls to adjust the
 * cash buffer configuration or approve/execute individual unwind steps.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  fetchCashBufferConfig,
  fetchLiquidityStatus,
  saveCashBufferConfig,
  executeUnwindStep,
  type CashBufferConfig,
  type LiquidityNeedsResult,
  type UnwindStep,
  type UnwindPriority,
} from "../lib/api/vaultLiquidity";
import { useWalletStore } from "../lib/store/wallet";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number) {
  return `${(n * 100).toFixed(2)}%`;
}

const STATUS_COLOR: Record<LiquidityNeedsResult["status"], string> = {
  healthy:      "var(--call)",
  buffer_draw:  "var(--atm)",
  jit_needed:   "var(--put)",
  insufficient: "var(--put)",
  alert:        "var(--put)",
};

const STATUS_BG: Record<LiquidityNeedsResult["status"], string> = {
  healthy:      "var(--call-dim)",
  buffer_draw:  "var(--atm-dim)",
  jit_needed:   "var(--put-dim)",
  insufficient: "var(--put-dim)",
  alert:        "var(--put-dim)",
};

const STATUS_LABEL: Record<LiquidityNeedsResult["status"], string> = {
  healthy:      "Healthy",
  buffer_draw:  "Buffer Draw",
  jit_needed:   "JIT Unwind Needed",
  insufficient: "Insufficient Liquidity",
  alert:        "⚠ Alert — Deposits Paused",
};

// ---------------------------------------------------------------------------
// Buffer configuration form
// ---------------------------------------------------------------------------

interface ConfigFormProps {
  initial: CashBufferConfig;
  onSave: (c: CashBufferConfig) => Promise<void>;
}

function ConfigForm({ initial, onSave }: ConfigFormProps) {
  const [cfg, setCfg]       = useState<CashBufferConfig>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [err, setErr]       = useState<string | null>(null);

  const update = <K extends keyof CashBufferConfig>(key: K, val: CashBufferConfig[K]) =>
    setCfg(c => ({ ...c, [key]: val }));

  const handleSave = async () => {
    if (cfg.minBufferPct >= cfg.targetBufferPct) {
      setErr("Minimum buffer must be less than target buffer.");
      return;
    }
    setSaving(true); setErr(null);
    try {
      await onSave(cfg);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, el: React.ReactNode) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</label>
      {el}
    </div>
  );

  const numInput = (val: number, setter: (v: number) => void, step = 0.01) => (
    <input
      type="number"
      step={step}
      min={0}
      max={1}
      value={val}
      onChange={e => setter(parseFloat(e.target.value) || 0)}
      style={{ padding: "6px 8px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontSize: 12, fontFamily: "var(--font-mono)", width: "100%" }}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {field("Target buffer (% of TVL)", numInput(cfg.targetBufferPct, v => update("targetBufferPct", v)))}
        {field("Min buffer (% of TVL)",    numInput(cfg.minBufferPct, v => update("minBufferPct", v)))}
        {field("Max slippage (%)",          numInput(cfg.maxSlippagePct, v => update("maxSlippagePct", v)))}
        {field("Unwind priority", (
          <select
            value={cfg.unwindPriority}
            onChange={e => update("unwindPriority", e.target.value as UnwindPriority)}
            style={{ padding: "6px 8px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontSize: 12 }}
          >
            <option value="least_loss">Least Loss</option>
            <option value="nearest_expiry">Nearest Expiry</option>
            <option value="largest_notional">Largest Notional</option>
          </select>
        ))}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-mid)", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={cfg.requireOperatorApproval}
          onChange={e => update("requireOperatorApproval", e.target.checked)}
        />
        Require operator approval before any unwind executes
      </label>
      {err && <div style={{ fontSize: 11, color: "var(--put)" }}>{err}</div>}
      <button
        onClick={handleSave}
        disabled={saving}
        style={{ padding: "8px 16px", background: "var(--brand)", color: "var(--bg)", border: "none", fontSize: 12, fontWeight: 700, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1, alignSelf: "flex-start" }}
      >
        {saving ? "Saving…" : saved ? "✓ Saved" : "Save Config"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unwind plan table
// ---------------------------------------------------------------------------

interface UnwindPlanTableProps {
  steps: UnwindStep[];
  requiresApproval: boolean;
  vaultId: string;
}

function UnwindPlanTable({ steps, requiresApproval, vaultId }: UnwindPlanTableProps) {
  const token = useWalletStore(s => s.token);
  const [executing, setExecuting] = useState<string | null>(null);
  const [results, setResults]     = useState<Record<string, string>>({});

  const handleExecute = async (step: UnwindStep) => {
    if (!token) return;
    setExecuting(step.candidate.positionId);
    try {
      const r = await executeUnwindStep(vaultId, step.candidate.positionId, token);
      setResults(prev => ({ ...prev, [step.candidate.positionId]: r.tx_id }));
    } catch (e) {
      setResults(prev => ({ ...prev, [step.candidate.positionId]: `Error: ${e instanceof Error ? e.message : "Failed"}` }));
    } finally {
      setExecuting(null);
    }
  };

  if (!steps.length) return (
    <div style={{ fontSize: 12, color: "var(--text-lo)", padding: "12px 0" }}>
      No unwind steps needed — buffer covers all queued redemptions.
    </div>
  );

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ background: "var(--surface-raised)" }}>
            {["#", "Position", "Underlying", "Strike", "DTE", "Proceeds", "Est. Loss", "Slippage", "Cumulative", ""].map(h => (
              <th key={h} style={{ padding: "7px 10px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-lo)", textAlign: "right", borderBottom: "1px solid var(--border-default)", whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {steps.map(step => {
            const c = step.candidate;
            const txId = results[c.positionId];
            const isExec = executing === c.positionId;
            return (
              <tr key={c.positionId} style={{
                borderBottom: "1px solid var(--border-subtle)",
                background: step.sufficientAtThisStep ? "var(--call-dim)" : "transparent",
              }}>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--text-lo)" }}>{step.rank}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--text-mid)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {c.positionType.replace(/_/g, " ")}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{c.underlying}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {c.strike >= 1000 ? `$${c.strike.toLocaleString()}` : `$${c.strike.toFixed(4)}`}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: c.daysToExpiry <= 7 ? "var(--put)" : "var(--text-mid)" }}>
                  {c.daysToExpiry}d
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--call)" }}>{fmtUsd(c.proceedsUsd)}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: c.realisedPnlUsd < 0 ? "var(--put)" : "var(--call)" }}>
                  {c.realisedPnlUsd < 0 ? "-" : "+"}{fmtUsd(Math.abs(c.realisedPnlUsd))}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: c.estimatedSlippage > 0.015 ? "var(--atm)" : "var(--text-mid)" }}>
                  {fmtPct(c.estimatedSlippage)}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>
                  {fmtUsd(step.cumulativeProceedsUsd)}
                  {step.sufficientAtThisStep && (
                    <span style={{ marginLeft: 4, fontSize: 9, color: "var(--call)", background: "var(--call-dim)", padding: "1px 4px" }}>✓ covers</span>
                  )}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>
                  {txId ? (
                    <span style={{ fontSize: 10, color: txId.startsWith("Error") ? "var(--put)" : "var(--call)" }}>
                      {txId.startsWith("Error") ? txId : `✓ ${txId.slice(0, 12)}…`}
                    </span>
                  ) : (
                    <button
                      onClick={() => handleExecute(step)}
                      disabled={isExec || requiresApproval || !token}
                      title={requiresApproval ? "Operator approval required — coordinate off-chain before executing" : !token ? "Connect wallet to execute" : "Execute this unwind step"}
                      style={{
                        fontSize: 11, padding: "4px 10px",
                        background: requiresApproval ? "var(--bg-overlay)" : "var(--put-dim)",
                        color: requiresApproval ? "var(--text-lo)" : "var(--put)",
                        border: `1px solid ${requiresApproval ? "var(--border-default)" : "var(--put)"}`,
                        cursor: isExec || requiresApproval || !token ? "default" : "pointer",
                        opacity: isExec ? 0.6 : 1,
                      }}
                    >
                      {isExec ? "…" : requiresApproval ? "Pending Approval" : "Execute"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export interface VaultLiquidityPanelProps {
  vaultId: string;
  tvlUsd: number;
  /** Current idle cash in the vault (USD). Pass 0 if unknown; mock fills it in. */
  bufferUsd?: number;
  /** Current queued redemption demand in USD. */
  queuedRedemptionUsd?: number;
}

export function VaultLiquidityPanel({
  vaultId,
  tvlUsd,
  bufferUsd: initialBuffer,
  queuedRedemptionUsd: initialQueue,
}: VaultLiquidityPanelProps) {
  // In mock mode derive plausible defaults from TVL.
  const bufferUsd         = initialBuffer       ?? tvlUsd * 0.048;
  const queuedRedemption  = initialQueue         ?? tvlUsd * 0.03;

  const [status, setStatus]         = useState<LiquidityNeedsResult | null>(null);
  const [config, setConfig]         = useState<CashBufferConfig | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [liq, cfg] = await Promise.all([
        fetchLiquidityStatus(vaultId, tvlUsd, bufferUsd, queuedRedemption),
        fetchCashBufferConfig(vaultId),
      ]);
      setStatus(liq);
      setConfig(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load liquidity data");
    } finally {
      setLoading(false);
    }
  }, [vaultId, tvlUsd, bufferUsd, queuedRedemption]);

  useEffect(() => { load(); }, [load]);

  const handleSaveConfig = async (cfg: CashBufferConfig) => {
    await saveCashBufferConfig(cfg);
    setConfig(cfg);
    await load();
  };

  return (
    <section aria-label="Vault liquidity management" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Redemption Liquidity</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowConfig(v => !v)}
            style={{ fontSize: 11, padding: "4px 10px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)", color: "var(--text-mid)", cursor: "pointer" }}
          >
            {showConfig ? "Hide Config" : "⚙ Buffer Config"}
          </button>
          <button
            onClick={load}
            style={{ fontSize: 11, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Config form */}
      {showConfig && config && (
        <div style={{ border: "1px solid var(--border-default)", padding: 16, background: "var(--bg-raised)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12 }}>Cash Buffer Configuration</div>
          <ConfigForm initial={config} onSave={handleSaveConfig} />
        </div>
      )}

      {loading && !status && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2].map(i => <div key={i} className="skeleton" style={{ height: 44, width: "100%" }} />)}
        </div>
      )}

      {error && (
        <div style={{ padding: "10px 14px", background: "var(--put-dim)", border: "1px solid var(--put)", color: "var(--put)", fontSize: 12 }}>
          {error}
        </div>
      )}

      {status && (
        <>
          {/* Status summary cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 1, border: "1px solid var(--border-default)", background: "var(--border-default)" }}>
            {[
              { label: "Status", value: (
                <span style={{ fontSize: 11, fontWeight: 700, color: STATUS_COLOR[status.status], background: STATUS_BG[status.status], padding: "2px 6px" }}>
                  {STATUS_LABEL[status.status]}
                </span>
              )},
              { label: "Cash Buffer", value: `${fmtUsd(status.bufferUsd)} (${fmtPct(status.bufferPct)})` },
              { label: "Queue Demand", value: fmtUsd(status.queuedRedemptionUsd) },
              { label: "Shortfall", value: status.shortfallUsd > 0 ? fmtUsd(status.shortfallUsd) : "None" },
            ].map(card => (
              <div key={card.label} style={{ padding: "12px 14px", background: "var(--bg-raised)" }}>
                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-lo)", marginBottom: 5 }}>{card.label}</div>
                {typeof card.value === "string"
                  ? <div className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{card.value}</div>
                  : card.value}
              </div>
            ))}
          </div>

          {/* Message */}
          <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.5 }}>
            {status.message}
          </div>

          {/* Buffer bar */}
          {config && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-lo)", marginBottom: 4 }}>
                <span>Cash buffer: {fmtPct(status.bufferPct)}</span>
                <span>Target: {fmtPct(config.targetBufferPct)} | Min: {fmtPct(config.minBufferPct)}</span>
              </div>
              <div style={{ height: 6, background: "var(--bg-overlay)", position: "relative" }}>
                {/* min line */}
                <div style={{ position: "absolute", left: `${config.minBufferPct * 100}%`, top: 0, bottom: 0, width: 1, background: "var(--put)", opacity: 0.6 }} />
                {/* target line */}
                <div style={{ position: "absolute", left: `${config.targetBufferPct * 100}%`, top: 0, bottom: 0, width: 1, background: "var(--atm)", opacity: 0.8 }} />
                {/* fill */}
                <div style={{
                  height: "100%",
                  width: `${Math.min(100, status.bufferPct * 100)}%`,
                  background: STATUS_COLOR[status.status],
                  transition: "width 0.3s",
                }} />
              </div>
            </div>
          )}

          {/* JIT unwind plan */}
          {status.plan && (
            <div style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-default)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  JIT Unwind Plan — {status.plan.steps.length} step{status.plan.steps.length !== 1 ? "s" : ""}
                </span>
                <div style={{ fontSize: 11, display: "flex", gap: 16 }}>
                  <span style={{ color: "var(--text-lo)" }}>
                    Est. loss: <span style={{ color: status.plan.totalRealisedLossUsd < 0 ? "var(--put)" : "var(--text-hi)" }}>
                      {fmtUsd(Math.abs(status.plan.totalRealisedLossUsd))}
                    </span>
                  </span>
                  <span style={{ color: "var(--text-lo)" }}>
                    Max slippage: <span style={{ color: "var(--atm)" }}>{fmtPct(status.plan.maxStepSlippage)}</span>
                  </span>
                  {status.plan.requiresApproval && (
                    <span style={{ color: "var(--atm)", background: "var(--atm-dim)", padding: "1px 6px", fontSize: 10 }}>
                      Approval Required
                    </span>
                  )}
                </div>
              </div>
              <div style={{ padding: 14 }}>
                <UnwindPlanTable
                  steps={status.plan.steps}
                  requiresApproval={status.plan.requiresApproval}
                  vaultId={vaultId}
                />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
