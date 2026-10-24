"use client";

/**
 * VaultAuditLog — Issue #243
 *
 * Renders the immutable administrative action trail for a vault.
 * Shows hash-chain integrity status, a filterable table of entries,
 * before/after diffs, actor address, justification, and on-chain tx links.
 */

import React, { useState } from "react";
import { useVaultAuditLog } from "../lib/hooks/useVaultAuditLog";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_SEVERITY,
  type AuditEntry,
  type AuditActionType,
} from "../lib/api/vaultAudit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day:   "numeric",
    year:  "numeric",
    hour:  "numeric",
    minute:"2-digit",
    hour12: true,
  });
}

function truncate(s: string, n = 8) {
  return s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-4)}` : s;
}

const SEVERITY_COLOR: Record<"info" | "warn" | "critical", string> = {
  info:     "var(--text-lo)",
  warn:     "var(--atm)",
  critical: "var(--put)",
};

const SEVERITY_BG: Record<"info" | "warn" | "critical", string> = {
  info:     "transparent",
  warn:     "var(--atm-dim)",
  critical: "var(--put-dim)",
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ChainBadge({ ok, verifying }: { ok: boolean | null; verifying: boolean }) {
  if (verifying) {
    return (
      <span style={{ fontSize: 11, color: "var(--text-lo)", display: "flex", alignItems: "center", gap: 4 }}>
        <span className="skeleton" style={{ width: 10, height: 10, borderRadius: "50%", display: "inline-block" }} />
        Verifying chain…
      </span>
    );
  }
  if (ok === null) return null;
  return (
    <span
      style={{
        fontSize: 11,
        color:      ok ? "var(--call)" : "var(--put)",
        background: ok ? "var(--call-dim)" : "var(--put-dim)",
        padding: "2px 8px",
        borderRadius: 3,
        display: "flex",
        alignItems: "center",
        gap: 5,
      }}
      title={ok ? "Hash chain verified — no tampering detected." : "Chain integrity check FAILED — entries may have been modified."}
    >
      <span>{ok ? "✓" : "✗"}</span>
      {ok ? "Chain intact" : "Chain BROKEN"}
    </span>
  );
}

function DiffRow({ diffs }: { diffs: AuditEntry["diffs"] }) {
  if (!diffs.length) return <span style={{ color: "var(--text-lo)", fontSize: 11 }}>—</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {diffs.map((d, i) => (
        <div key={i} style={{ fontSize: 11, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-lo)" }}>{d.field}</span>
          <span style={{ color: "var(--put)" }}>{d.before ?? "—"}{d.unit ? ` ${d.unit}` : ""}</span>
          <span style={{ color: "var(--text-lo)" }}>→</span>
          <span style={{ color: "var(--call)" }}>{d.after ?? "—"}{d.unit ? ` ${d.unit}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

function AuditRow({ entry, expanded, onToggle }: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const severity = AUDIT_ACTION_SEVERITY[entry.actionType];
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: "pointer",
          background: expanded ? "var(--surface-raised)" : "transparent",
          borderBottom: "1px solid var(--border-default)",
          transition: "background 0.1s",
        }}
      >
        <td style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-lo)", whiteSpace: "nowrap" }}>
          {fmtDate(entry.timestamp)}
        </td>
        <td style={{ padding: "10px 12px" }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: SEVERITY_COLOR[severity],
              background: SEVERITY_BG[severity],
              padding: "2px 6px",
              borderRadius: 3,
            }}
          >
            {AUDIT_ACTION_LABELS[entry.actionType]}
          </span>
        </td>
        <td style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-mid)", fontFamily: "var(--font-mono)" }}>
          {truncate(entry.actor, 10)}
        </td>
        <td style={{ padding: "10px 12px" }}>
          <DiffRow diffs={entry.diffs} />
        </td>
        <td style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-lo)" }}>
          {entry.txHash ? (
            <a
              href={`https://stellar.expert/explorer/public/tx/${entry.txHash}`}
              target="_blank"
              rel="noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ color: "var(--brand)", textDecoration: "none" }}
            >
              {truncate(entry.txHash, 8)}
            </a>
          ) : "—"}
        </td>
        <td style={{ padding: "10px 12px", textAlign: "center", fontSize: 12, color: "var(--text-lo)" }}>
          {expanded ? "▲" : "▼"}
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: "var(--surface-raised)" }}>
          <td colSpan={6} style={{ padding: "12px 16px 16px", borderBottom: "1px solid var(--border-default)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Justification */}
              <div>
                <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                  Justification
                </div>
                <div style={{ fontSize: 12, color: "var(--text-hi)", lineHeight: 1.5 }}>
                  {entry.justification || <span style={{ color: "var(--text-lo)" }}>No justification recorded.</span>}
                </div>
              </div>
              {/* Chain info */}
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
                    Entry ID
                  </div>
                  <code style={{ fontSize: 11, color: "var(--text-mid)" }}>{entry.id}</code>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
                    Ledger
                  </div>
                  <code style={{ fontSize: 11, color: "var(--text-mid)" }}>{entry.ledger || "—"}</code>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
                    Chain Hash
                  </div>
                  <code style={{ fontSize: 11, color: "var(--text-mid)" }}>{entry.chainHash.slice(0, 32)}…</code>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
                    Previous Hash
                  </div>
                  <code style={{ fontSize: 11, color: "var(--text-mid)" }}>{entry.previousHash.slice(0, 32)}…</code>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const ALL_TYPES = Object.keys(AUDIT_ACTION_LABELS) as AuditActionType[];

export interface VaultAuditLogProps {
  vaultId: string;
}

export function VaultAuditLog({ vaultId }: VaultAuditLogProps) {
  const { entries, loading, error, tamperResult, verifying, refetch } =
    useVaultAuditLog(vaultId, 30_000);

  const [expandedId, setExpandedId]               = useState<string | null>(null);
  const [filter, setFilter]                       = useState<AuditActionType | "all">("all");
  const [actorSearch, setActorSearch]             = useState("");

  const visible = entries
    .filter(e => filter === "all" || e.actionType === filter)
    .filter(e => !actorSearch || e.actor.toLowerCase().includes(actorSearch.toLowerCase()))
    .slice()
    .reverse(); // most-recent first

  return (
    <section aria-label="Vault audit log" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Audit Log</h2>
          <ChainBadge ok={tamperResult?.ok ?? null} verifying={verifying} />
        </div>
        <button
          onClick={refetch}
          style={{ fontSize: 11, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select
          value={filter}
          onChange={e => setFilter(e.target.value as AuditActionType | "all")}
          style={{
            fontSize: 11,
            padding: "4px 8px",
            background: "var(--surface)",
            border: "1px solid var(--border-default)",
            color: "var(--text-mid)",
            borderRadius: 3,
          }}
          aria-label="Filter by action type"
        >
          <option value="all">All actions</option>
          {ALL_TYPES.map(t => (
            <option key={t} value={t}>{AUDIT_ACTION_LABELS[t]}</option>
          ))}
        </select>
        <input
          value={actorSearch}
          onChange={e => setActorSearch(e.target.value)}
          placeholder="Filter by actor address…"
          style={{
            fontSize: 11,
            padding: "4px 8px",
            background: "var(--surface)",
            border: "1px solid var(--border-default)",
            color: "var(--text-mid)",
            borderRadius: 3,
            width: 220,
          }}
          aria-label="Filter by actor address"
        />
        <span style={{ fontSize: 11, color: "var(--text-lo)", marginLeft: "auto" }}>
          {visible.length} of {entries.length} entries
        </span>
      </div>

      {/* Tamper warning */}
      {tamperResult && !tamperResult.ok && (
        <div
          role="alert"
          style={{
            padding: "10px 14px",
            background: "var(--put-dim)",
            border: "1px solid var(--put)",
            color: "var(--put)",
            fontSize: 12,
            borderRadius: 4,
          }}
        >
          ⚠ {tamperResult.message}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: "10px 14px", background: "var(--put-dim)", border: "1px solid var(--put)", color: "var(--put)", fontSize: 12, borderRadius: 4 }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !entries.length && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="skeleton" style={{ height: 44, width: "100%" }} />
          ))}
        </div>
      )}

      {/* Table */}
      {!loading && !error && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
            aria-label={`Vault ${vaultId} audit log`}
          >
            <thead>
              <tr style={{ background: "var(--surface-raised)" }}>
                {["Timestamp", "Action", "Actor", "Changes", "Tx Hash", ""].map(h => (
                  <th
                    key={h}
                    style={{
                      padding: "8px 12px",
                      textAlign: "left",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--text-lo)",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      borderBottom: "1px solid var(--border-default)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: "24px 12px", textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
                    No audit entries match the current filters.
                  </td>
                </tr>
              ) : (
                visible.map(entry => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    expanded={expandedId === entry.id}
                    onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
