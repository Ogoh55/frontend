"use client";

/**
 * VaultEligibilityGate
 *
 * UI components for anti-sybil deposit eligibility and reward-farming detection.
 *
 * Components
 * ──────────
 * EligibilityBadge        — compact inline badge showing eligible/review/ineligible
 * FarmingWarning          — banner shown when a farming-risk pattern is detected
 * EligibilityScorePanel   — full breakdown panel with signal scores (collapsible)
 * VaultEligibilityGate    — orchestrating component used in the deposit flow
 */

import React, { useState } from "react";
import type { EligibilityResult, FarmingRiskLevel, SignalResult } from "../lib/vaultEligibility";
import {
  eligibilityStatusLabel,
  eligibilityStatusColor,
  farmingRiskColor,
  canReceiveIncentives,
  ELIGIBLE_THRESHOLD,
  REVIEW_THRESHOLD,
} from "../lib/vaultEligibility";

// ---------------------------------------------------------------------------
// EligibilityBadge
// ---------------------------------------------------------------------------

interface EligibilityBadgeProps {
  result: EligibilityResult;
  /** If true, shows a compact one-liner without expanding controls. */
  compact?: boolean;
}

/**
 * Compact badge for vault listings and deposit buttons.
 * Accessible: uses aria-label with the full summary.
 */
export function EligibilityBadge({ result, compact = false }: EligibilityBadgeProps) {
  const label = eligibilityStatusLabel(result);
  const color = eligibilityStatusColor(result);

  return (
    <span
      aria-label={`Incentive eligibility: ${label}. ${result.summary}`}
      title={result.summary}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: compact ? "1px 6px" : "2px 8px",
        fontSize: compact ? 9 : 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        border: `1px solid ${color}`,
        color,
        background: "transparent",
        whiteSpace: "nowrap",
      }}
    >
      {/* Coloured dot */}
      <span
        style={{
          width: compact ? 5 : 6,
          height: compact ? 5 : 6,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      {label}
      {!compact && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 400,
            color: "var(--text-lo)",
            fontSize: 9,
          }}
        >
          {result.compositeScore}/100
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// FarmingWarning
// ---------------------------------------------------------------------------

interface FarmingWarningProps {
  result: EligibilityResult;
}

/**
 * Full-width warning banner displayed when reward-farming risk is detected.
 * Only renders if farmingRisk is not "none".
 */
export function FarmingWarning({ result }: FarmingWarningProps) {
  const [dismissed, setDismissed] = useState(false);

  if (result.farmingRisk === "none" || dismissed) return null;

  const risk = result.farmingRisk;
  const color = farmingRiskColor(risk);

  const riskTitles: Record<FarmingRiskLevel, string> = {
    none:   "",
    low:    "Potential reward-farming pattern detected",
    medium: "Reward-farming pattern detected",
    high:   "High-risk reward-farming activity flagged",
  };

  const riskDescriptions: Record<Exclude<FarmingRiskLevel, "none">, string> = {
    low:    "A pattern in your recent vault activity may indicate reward farming. Incentives are applied normally, but your activity is logged for review.",
    medium: "Multiple patterns in your vault activity match known reward-farming heuristics. Incentives will be held pending review.",
    high:   "Your vault activity strongly matches reward-farming patterns. Incentives are suspended pending a manual review of your account.",
  };

  if (risk === "none") return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        display: "flex",
        gap: 10,
        padding: "10px 14px",
        border: `1px solid ${color}`,
        background: "var(--bg-overlay)",
        borderLeft: `3px solid ${color}`,
        fontSize: 11,
      }}
    >
      <span
        style={{ fontSize: 14, flexShrink: 0, color }}
        aria-hidden="true"
      >
        {risk === "high" ? "⚠" : "⚑"}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, color, marginBottom: 3 }}>
          {riskTitles[risk]}
        </div>
        <div style={{ color: "var(--text-mid)", lineHeight: 1.5 }}>
          {riskDescriptions[risk]}
        </div>
        {/* Signal-specific reasons */}
        {result.signals.filter(s => s.flagged).length > 0 && (
          <ul
            style={{
              margin: "6px 0 0",
              paddingLeft: 16,
              color: "var(--text-lo)",
              lineHeight: 1.6,
            }}
          >
            {result.signals
              .filter(s => s.flagged)
              .map(s => (
                <li key={s.name} style={{ fontSize: 10 }}>
                  {s.name}: {s.reason}
                </li>
              ))}
          </ul>
        )}
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss farming warning"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-lo)",
          fontSize: 12,
          padding: "0 2px",
          alignSelf: "flex-start",
          flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SignalRow (internal)
// ---------------------------------------------------------------------------

interface SignalRowProps {
  signal: SignalResult;
}

function SignalRow({ signal }: SignalRowProps) {
  const barColor =
    signal.score >= 70
      ? "var(--call)"
      : signal.score >= 45
      ? "var(--atm)"
      : "var(--put)";

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 3,
        }}
      >
        <span
          title={signal.reason}
          style={{
            fontSize: 10,
            color: signal.flagged ? "var(--put)" : "var(--text-lo)",
            cursor: "help",
            borderBottom: "1px dotted var(--border-default)",
          }}
        >
          {signal.name}
          {signal.flagged && (
            <span aria-label="flagged" style={{ marginLeft: 4, fontSize: 9 }}>
              ⚑
            </span>
          )}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 600,
            color: barColor,
          }}
        >
          {signal.score}
          <span style={{ color: "var(--text-lo)", fontWeight: 400 }}>/100</span>
          <span style={{ color: "var(--text-lo)", fontWeight: 400, marginLeft: 4 }}>
            ×{Math.round(signal.weight * 100)}%
          </span>
        </span>
      </div>
      <div
        style={{
          height: 3,
          background: "var(--bg-overlay)",
          borderRadius: 1,
          overflow: "hidden",
          marginBottom: 2,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${signal.score}%`,
            background: barColor,
            transition: "width 400ms ease",
          }}
        />
      </div>
      <div style={{ fontSize: 9, color: "var(--text-lo)", lineHeight: 1.4, marginBottom: 6 }}>
        {signal.reason}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EligibilityScorePanel
// ---------------------------------------------------------------------------

interface EligibilityScorePanelProps {
  result: EligibilityResult;
}

/**
 * Full breakdown panel (collapsible) showing composite score + per-signal bars.
 */
export function EligibilityScorePanel({ result }: EligibilityScorePanelProps) {
  const [expanded, setExpanded] = useState(false);

  const statusColor = eligibilityStatusColor(result);

  return (
    <div
      style={{
        border: `1px solid ${statusColor}`,
        background: "var(--bg-raised)",
      }}
      aria-label={`Vault incentive eligibility panel. Score: ${result.compositeScore}/100`}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          background: "var(--bg-overlay)",
          borderBottom: `1px solid ${statusColor}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            color: statusColor,
          }}
        >
          Incentive Eligibility
        </span>
        <EligibilityBadge result={result} />
      </div>

      {/* Composite bar */}
      <div style={{ padding: "10px 14px 8px" }}>
        <div
          style={{
            height: 5,
            background: "var(--bg-overlay)",
            borderRadius: 1,
            overflow: "hidden",
            marginBottom: 6,
            position: "relative",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${result.compositeScore}%`,
              background: statusColor,
              transition: "width 500ms ease",
            }}
          />
          {/* Threshold markers */}
          {[REVIEW_THRESHOLD, ELIGIBLE_THRESHOLD].map(t => (
            <div
              key={t}
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 0,
                left: `${t}%`,
                width: 1,
                height: "100%",
                background: "var(--border-strong)",
              }}
            />
          ))}
        </div>

        <p
          style={{
            fontSize: 11,
            color: "var(--text-mid)",
            lineHeight: 1.5,
            margin: "0 0 8px",
          }}
        >
          {result.summary}
        </p>

        {/* Expand/collapse signal breakdown */}
        <button
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-lo)",
            fontSize: 10,
            padding: 0,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span
            style={{
              fontSize: 9,
              transform: expanded ? "rotate(90deg)" : "none",
              display: "inline-block",
              transition: "transform 200ms",
            }}
          >
            ▶
          </span>
          {expanded ? "Hide score breakdown" : "Show score breakdown"}
        </button>
      </div>

      {/* Signal breakdown */}
      {expanded && (
        <div
          style={{
            borderTop: "1px solid var(--border-subtle)",
            padding: "10px 14px",
          }}
        >
          {result.signals.map(s => (
            <SignalRow key={s.name} signal={s} />
          ))}
          <p
            style={{
              marginTop: 8,
              fontSize: 9,
              color: "var(--text-lo)",
              lineHeight: 1.5,
              fontStyle: "italic",
            }}
          >
            Score based on account age, on-chain activity, hold duration, vault
            diversification, and recycling rate. Eligibility does not affect your
            ability to deposit — only whether protocol incentives are applied.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// VaultEligibilityGate
// ---------------------------------------------------------------------------

export type EligibilityStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; result: EligibilityResult }
  | { state: "error"; message: string };

interface VaultEligibilityGateProps {
  status: EligibilityStatus;
  /**
   * If true, a banner saying "connect wallet to check eligibility" is shown
   * instead of the score panel.
   */
  walletConnected: boolean;
  /**
   * If provided and the wallet is ineligible but deposit should still be
   * allowed, this overrides blocking behaviour.
   */
  allowDepositWhenIneligible?: boolean;
}

/**
 * Orchestrating component.
 *
 * Renders:
 *  - Nothing when idle
 *  - A skeleton while loading
 *  - FarmingWarning + EligibilityScorePanel when a result is available
 *  - An error state on fetch failure
 *  - A "connect wallet" prompt when not connected
 *
 * Does NOT block deposit submission — blocking vs allowing is left to the
 * parent page. This component only renders informational UI.
 */
export function VaultEligibilityGate({
  status,
  walletConnected,
  allowDepositWhenIneligible = true,
}: VaultEligibilityGateProps) {
  if (!walletConnected) {
    return (
      <div
        style={{
          padding: "10px 14px",
          border: "1px solid var(--border-default)",
          background: "var(--bg-raised)",
          fontSize: 11,
          color: "var(--text-lo)",
        }}
      >
        Connect your wallet to check incentive eligibility.
      </div>
    );
  }

  if (status.state === "idle") return null;

  if (status.state === "loading") {
    return (
      <div
        role="status"
        aria-label="Checking eligibility…"
        style={{ display: "flex", flexDirection: "column", gap: 4 }}
      >
        <div
          className="skeleton"
          style={{ height: 36, width: "100%", opacity: 0.5 }}
        />
        <div
          className="skeleton"
          style={{ height: 12, width: "70%", opacity: 0.4 }}
        />
      </div>
    );
  }

  if (status.state === "error") {
    return (
      <div
        role="alert"
        style={{
          padding: "8px 12px",
          border: "1px solid var(--put)",
          background: "var(--put-dim)",
          fontSize: 11,
          color: "var(--put)",
        }}
      >
        Could not check eligibility: {status.message}
      </div>
    );
  }

  // state === "done"
  const { result } = status;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <FarmingWarning result={result} />
      <EligibilityScorePanel result={result} />
      {!canReceiveIncentives(result) && allowDepositWhenIneligible && (
        <div
          style={{
            fontSize: 10,
            color: "var(--text-lo)",
            padding: "6px 10px",
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-raised)",
            lineHeight: 1.5,
          }}
        >
          You can still deposit, but you will not receive incentive rewards until
          your eligibility score improves.
        </div>
      )}
    </div>
  );
}
