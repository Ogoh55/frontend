"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { AppHeader } from "../../../../components/AppHeader";
import { WalletConnect } from "../../../../components/WalletConnect";
import { useWalletStore } from "../../../../lib/store/wallet";
import {
  INDEXER_LAG_LIMIT_SECONDS,
  OperatorApiError,
  fetchOperatorAuditLog,
  fetchOperatorStatus,
  fetchVaultDetail,
  fetchVaults,
  pauseVault,
  resolveStuckAlert,
  resumeVault,
  submitParameterChange,
  triggerRollover,
  type OperatorAuditEntry,
  type ParameterChangeRequest,
  type VaultDetail,
  type VaultOperatorStatus,
  type VaultParameterKey,
  type VaultSummary,
} from "../../../../lib/api/vaults";

const PARAMETER_LABELS: Record<VaultParameterKey, string> = {
  managementPct: "Management fee (%)",
  performancePct: "Performance fee (%)",
  capacity: "Capacity (USD)",
};

type PendingAction =
  | { kind: "rollover" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "resolve"; alertId: string }
  | { kind: "parameter"; change: ParameterChangeRequest; before: number };

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

function describeAction(action: PendingAction, vault: string, epoch: number): { title: string; body: string; label: string } {
  switch (action.kind) {
    case "rollover":
      return {
        title: "Trigger epoch rollover",
        body: `Acting on epoch ${epoch}. If the vault has already advanced, the backend rejects the request with 409 and nothing changes.`,
        label: "Trigger rollover",
      };
    case "pause":
      return { title: "Pause vault", body: "Deposits and withdrawals stop until the vault is resumed.", label: "Pause vault" };
    case "resume":
      return { title: "Resume vault", body: "Deposits and withdrawals reopen for this vault.", label: "Resume vault" };
    case "resolve":
      return { title: "Resolve stuck-queue alert", body: `Marks alert ${action.alertId} acknowledged and resolved on ${vault}.`, label: "Resolve alert" };
    case "parameter":
      return {
        title: "Submit parameter change for approval",
        body: `Opens a governance proposal: ${PARAMETER_LABELS[action.change.key]} ${action.before} → ${action.change.value}. The vault is not changed until the proposal passes.`,
        label: "Submit proposal",
      };
  }
}

/** Second confirmation: the operator must type the vault id before the action runs. */
function TypedConfirm({
  vaultId,
  title,
  body,
  label,
  busy,
  onCancel,
  onConfirm,
}: {
  vaultId: string;
  title: string;
  body: string;
  label: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = typed === vaultId && !busy;

  return (
    <div style={{ border: "1px solid var(--atm)", background: "var(--bg-overlay)", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-hi)" }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.5 }}>{body}</div>
      <label style={{ fontSize: 11, color: "var(--text-lo)" }}>
        Type <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-hi)" }}>{vaultId}</span> to confirm
        <input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          disabled={busy}
          autoComplete="off"
          style={{ display: "block", marginTop: 6, width: "100%", padding: "6px 8px", background: "var(--bg)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontFamily: "var(--font-mono)", fontSize: 12 }}
        />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onConfirm} disabled={!ready} style={{ ...buttonStyle, borderColor: "var(--atm)", color: "var(--atm)", opacity: ready ? 1 : 0.4, cursor: ready ? "pointer" : "not-allowed" }}>
          {busy ? "Working…" : label}
        </button>
        <button onClick={onCancel} disabled={busy} style={buttonStyle}>Cancel</button>
      </div>
    </div>
  );
}

const buttonStyle: CSSProperties = {
  background: "none", border: "1px solid var(--border-default)", color: "var(--text-mid)",
  padding: "6px 12px", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-sans)",
};

export default function VaultOperatorPage() {
  const token = useWalletStore(s => s.token);

  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [status, setStatus] = useState<VaultOperatorStatus | null>(null);
  const [detail, setDetail] = useState<VaultDetail | null>(null);
  const [audit, setAudit] = useState<OperatorAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [paramKey, setParamKey] = useState<VaultParameterKey>("performancePct");
  const [paramValue, setParamValue] = useState("");
  const [paramReview, setParamReview] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetchVaults()
      .then(v => { setVaults(v); setVaultId(prev => prev ?? v[0]?.id ?? null); })
      .catch(e => setError(e.message));
  }, [token]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!vaultId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, d, a] = await Promise.all([
        fetchOperatorStatus(vaultId),
        fetchVaultDetail(vaultId),
        fetchOperatorAuditLog(vaultId),
      ]);
      setStatus(s);
      setDetail(d);
      setAudit(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load vault status");
    } finally {
      setLoading(false);
    }
  }, [vaultId]);

  useEffect(() => {
    setPending(null);
    setNotice(null);
    setParamReview(false);
    setParamValue("");
    load();
  }, [load]);

  if (!token) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", fontFamily: "var(--font-sans)" }}>
        <AppHeader>
          <div style={{ marginLeft: "auto" }}><WalletConnect /></div>
        </AppHeader>
        <div style={{ maxWidth: 680, margin: "64px auto", padding: "0 24px", fontSize: 13, color: "var(--text-mid)" }}>
          Vault operator console. Sign in with an operator wallet to continue.
        </div>
      </div>
    );
  }

  const ageSeconds = status ? Math.max(0, Math.floor((now - Date.parse(status.indexerUpdatedAt)) / 1000)) : 0;
  const indexerStale = ageSeconds > INDEXER_LAG_LIMIT_SECONDS;
  const actionsEnabled = !!status && !busy && !loading && !indexerStale;

  const runAction = async (action: PendingAction) => {
    if (busy || !vaultId || !status) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      switch (action.kind) {
        case "rollover":
          setStatus(await triggerRollover(vaultId, status.currentEpoch));
          break;
        case "pause":
          setStatus(await pauseVault(vaultId));
          break;
        case "resume":
          setStatus(await resumeVault(vaultId));
          break;
        case "resolve":
          setStatus(await resolveStuckAlert(vaultId, action.alertId));
          break;
        case "parameter": {
          const result = await submitParameterChange(vaultId, action.change, action.before);
          setNotice(`Proposal ${result.proposal_id} submitted for governance approval.`);
          setParamReview(false);
          setParamValue("");
          break;
        }
      }
      setPending(null);
      setAudit(await fetchOperatorAuditLog(vaultId));
    } catch (e) {
      if (e instanceof OperatorApiError && e.status === 409) {
        setError(`${e.message}. Nothing was changed. Reload the status before retrying.`);
      } else {
        setError(e instanceof Error ? e.message : "Action failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const currentParam = detail
    ? paramKey === "capacity" ? detail.capacity
      : paramKey === "managementPct" ? detail.feeStructure.managementPct
      : detail.feeStructure.performancePct
    : null;
  const parsedParam = Number(paramValue);
  const paramValid = paramValue !== "" && Number.isFinite(parsedParam) && parsedParam >= 0 && parsedParam !== currentParam;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", overflow: "hidden", fontFamily: "var(--font-sans)" }}>
      <AppHeader>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <Link href="/vaults" style={{ fontSize: 11, color: "var(--text-lo)" }}>← Vaults</Link>
          <div style={{ width: 1, height: 16, background: "var(--border-default)", margin: "0 8px" }} />
          <WalletConnect />
        </div>
      </AppHeader>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 24px 64px", display: "flex", flexDirection: "column", gap: 24 }}>

          <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, fontWeight: 600, marginBottom: 6 }}>Vault Operator Console</h1>
              <p style={{ fontSize: 13, color: "var(--text-mid)" }}>
                Internal. Epoch operations, parameter proposals, and emergency pause. Every action is audited.
              </p>
            </div>
            <label style={{ fontSize: 11, color: "var(--text-lo)" }}>
              Vault
              <select
                value={vaultId ?? ""}
                onChange={e => setVaultId(e.target.value)}
                disabled={busy}
                style={{ display: "block", marginTop: 4, padding: "6px 8px", background: "var(--bg-raised)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontSize: 12 }}
              >
                {vaults.map(v => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
              </select>
            </label>
          </div>

          {error && (
            <div role="alert" style={{ padding: "12px 16px", border: "1px solid var(--put)", background: "var(--put-dim)", color: "var(--put)", fontSize: 12 }}>
              {error}
            </div>
          )}
          {notice && (
            <div role="status" style={{ padding: "12px 16px", border: "1px solid var(--call)", background: "var(--call-dim)", color: "var(--call)", fontSize: 12 }}>
              {notice}
            </div>
          )}
          {indexerStale && status && (
            <div role="alert" style={{ padding: "12px 16px", border: "1px solid var(--atm)", background: "var(--atm-dim)", color: "var(--atm)", fontSize: 12 }}>
              Indexer is lagging: state is {ageSeconds}s old (limit {INDEXER_LAG_LIMIT_SECONDS}s). Actions are disabled until it catches up.
              <button onClick={load} disabled={loading} style={{ ...buttonStyle, marginLeft: 12 }}>Refresh</button>
            </div>
          )}

          {/* Dashboard */}
          {status && (
            <section style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)" }}>Dashboard</div>
                <div style={{ fontSize: 11, color: indexerStale ? "var(--atm)" : "var(--text-lo)" }}>
                  State age {ageSeconds}s · {loading ? "refreshing…" : <button onClick={load} disabled={busy} style={{ ...buttonStyle, padding: "2px 8px" }}>Refresh</button>}
                </div>
              </div>
              <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, margin: 0, fontSize: 12 }}>
                <div><dt style={{ color: "var(--text-lo)" }}>Epoch</dt><dd style={{ margin: 0, color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>{status.currentEpoch}</dd></div>
                <div><dt style={{ color: "var(--text-lo)" }}>Epoch state</dt><dd style={{ margin: 0, color: "var(--text-hi)" }}>{status.epochState}</dd></div>
                <div><dt style={{ color: "var(--text-lo)" }}>Last rollover</dt><dd style={{ margin: 0, color: "var(--text-hi)" }}>{fmtTime(status.lastRolloverAt)}</dd></div>
                <div><dt style={{ color: "var(--text-lo)" }}>Pending redemptions</dt><dd style={{ margin: 0, color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>{status.pendingRedemptions}</dd></div>
                <div><dt style={{ color: "var(--text-lo)" }}>Capacity utilisation</dt><dd style={{ margin: 0, color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>{(status.capacityUtilisation * 100).toFixed(1)}%</dd></div>
                <div><dt style={{ color: "var(--text-lo)" }}>Pause status</dt><dd style={{ margin: 0, color: status.paused ? "var(--put)" : "var(--call)", fontWeight: 700 }}>{status.paused ? "PAUSED" : "Active"}</dd></div>
              </dl>
            </section>
          )}

          {/* Epoch and pause actions */}
          {status && (
            <section style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)" }}>Actions</div>
              {pending && pending.kind !== "parameter" && vaultId && (() => {
                const d = describeAction(pending, vaultId, status.currentEpoch);
                return (
                  <TypedConfirm
                    vaultId={vaultId}
                    title={d.title}
                    body={d.body}
                    label={d.label}
                    busy={busy}
                    onCancel={() => setPending(null)}
                    onConfirm={() => runAction(pending)}
                  />
                );
              })()}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => setPending({ kind: "rollover" })} disabled={!actionsEnabled} style={buttonStyle}>
                  {status.epochState === "deposit" ? "Retry rollover" : "Trigger rollover"}
                </button>
                <button onClick={() => setPending({ kind: "pause" })} disabled={!actionsEnabled || status.paused} style={{ ...buttonStyle, color: "var(--put)", borderColor: "var(--put)" }}>
                  Pause vault
                </button>
                <button onClick={() => setPending({ kind: "resume" })} disabled={!actionsEnabled || !status.paused} style={{ ...buttonStyle, color: "var(--call)", borderColor: "var(--call)" }}>
                  Resume vault
                </button>
              </div>

              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)" }}>Stuck-queue alerts</div>
              {status.stuckQueueAlerts.length === 0 && <div style={{ fontSize: 12, color: "var(--text-mid)" }}>No open alerts.</div>}
              {status.stuckQueueAlerts.map(alert => (
                <div key={alert.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 12, color: "var(--text-mid)" }}>
                  <span>Epoch {alert.epoch} · {alert.unfulfilledTickets} unfulfilled tickets · opened {fmtTime(alert.openedAt)}</span>
                  <button onClick={() => setPending({ kind: "resolve", alertId: alert.id })} disabled={!actionsEnabled} style={buttonStyle}>Resolve</button>
                </div>
              ))}
            </section>
          )}

          {/* Parameter changes: diff, then second confirmation, then governed path */}
          {status && detail && (
            <section style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)" }}>Parameter change (governed)</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ fontSize: 11, color: "var(--text-lo)" }}>
                  Parameter
                  <select
                    value={paramKey}
                    onChange={e => { setParamKey(e.target.value as VaultParameterKey); setParamReview(false); setParamValue(""); }}
                    disabled={busy}
                    style={{ display: "block", marginTop: 4, padding: "6px 8px", background: "var(--bg)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontSize: 12 }}
                  >
                    {(Object.keys(PARAMETER_LABELS) as VaultParameterKey[]).map(k => <option key={k} value={k}>{PARAMETER_LABELS[k]}</option>)}
                  </select>
                </label>
                <label style={{ fontSize: 11, color: "var(--text-lo)" }}>
                  New value
                  <input
                    value={paramValue}
                    onChange={e => { setParamValue(e.target.value); setParamReview(false); }}
                    disabled={busy}
                    inputMode="decimal"
                    style={{ display: "block", marginTop: 4, width: 160, padding: "6px 8px", background: "var(--bg)", border: "1px solid var(--border-default)", color: "var(--text-hi)", fontFamily: "var(--font-mono)", fontSize: 12 }}
                  />
                </label>
                <button onClick={() => setParamReview(true)} disabled={!actionsEnabled || !paramValid} style={buttonStyle}>Review diff</button>
              </div>

              {paramReview && paramValid && currentParam !== null && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-hi)" }}>
                    <span style={{ color: "var(--put)" }}>- {PARAMETER_LABELS[paramKey]}: {currentParam}</span>
                    <br />
                    <span style={{ color: "var(--call)" }}>+ {PARAMETER_LABELS[paramKey]}: {parsedParam}</span>
                  </div>
                  <TypedConfirm
                    vaultId={vaultId ?? ""}
                    title="Submit parameter change for approval"
                    body="This opens a governance proposal. The vault is not changed until the proposal passes the approval path."
                    label="Submit proposal"
                    busy={busy}
                    onCancel={() => setParamReview(false)}
                    onConfirm={() => runAction({ kind: "parameter", change: { key: paramKey, value: parsedParam }, before: currentParam })}
                  />
                </div>
              )}
            </section>
          )}

          {/* Audit log */}
          <section style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 20 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 12 }}>Audit log</div>
            {audit.length === 0 && <div style={{ fontSize: 12, color: "var(--text-mid)" }}>No operator actions recorded for this vault.</div>}
            {audit.length > 0 && (
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "var(--text-lo)", textAlign: "left" }}>
                    <th style={{ padding: "6px 8px" }}>Time</th>
                    <th style={{ padding: "6px 8px" }}>Actor</th>
                    <th style={{ padding: "6px 8px" }}>Vault</th>
                    <th style={{ padding: "6px 8px" }}>Action</th>
                    <th style={{ padding: "6px 8px" }}>Before</th>
                    <th style={{ padding: "6px 8px" }}>After</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map(e => (
                    <tr key={e.id} style={{ borderTop: "1px solid var(--border-default)", color: "var(--text-mid)" }}>
                      <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtTime(e.timestamp)}</td>
                      <td style={{ padding: "6px 8px", fontFamily: "var(--font-mono)" }}>{e.actor}</td>
                      <td style={{ padding: "6px 8px", fontFamily: "var(--font-mono)" }}>{e.vaultId}</td>
                      <td style={{ padding: "6px 8px" }}>{e.action}</td>
                      <td style={{ padding: "6px 8px" }}>{e.before}</td>
                      <td style={{ padding: "6px 8px" }}>{e.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

        </div>
      </div>
    </div>
  );
}
