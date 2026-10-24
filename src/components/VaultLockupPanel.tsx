"use client";

/**
 * VaultLockupPanel (#246)
 *
 * Depositor-facing panel showing:
 *  - Current vesting progress per locked position (progress bar).
 *  - Shares unlocked vs still locked.
 *  - Estimated early-exit penalty if the depositor were to withdraw now.
 *  - Full-unlock epoch countdown.
 *
 * Does NOT submit any transaction — redemption still goes through the
 * standard withdrawal queue flow in DepositWithdrawModal / vault page.
 * This panel is informational, wired up alongside that flow.
 */

import React, { useState } from "react";
import {
  buildLockupSummary,
  earlyExitPenalty,
  type LockupSchedule,
  type LockedPosition,
  type LockupSummary,
} from "../lib/vault/shareLockup";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCALE = 10n ** 7n; // 7-decimal display precision (stroops)

function fmtShares(n: bigint): string {
  const s = n.toString().padStart(8, "0");
  const int = s.slice(0, s.length - 7) || "0";
  const frac = s.slice(s.length - 7).replace(/0+$/, "") || "0";
  return `${int}.${frac}`;
}

function pctBar(pct: number, color: string) {
  return (
    <div
      style={{ height: 6, background: "var(--bg-overlay)", position: "relative", flex: 1 }}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${pct}% vested`}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: `${Math.min(100, pct)}%`,
          background: color,
          transition: "width 0.4s",
        }}
      />
    </div>
  );
}

function vestingModelLabel(model: LockupSchedule["vestingModel"]): string {
  switch (model) {
    case "cliff": return "Cliff";
    case "linear": return "Linear";
    case "graded": return "Graded";
  }
}

// ---------------------------------------------------------------------------
// Position card
// ---------------------------------------------------------------------------

interface PositionCardProps {
  summary: LockupSummary;
  position: LockedPosition;
  schedule: LockupSchedule;
  currentEpoch: number;
}

function PositionCard({ summary, position, schedule, currentEpoch }: PositionCardProps) {
  const [showPenalty, setShowPenalty] = useState(false);

  const fullyVested = summary.lockedShares === 0n;
  const barColor = fullyVested
    ? "var(--call)"
    : summary.vestingPct >= 50
    ? "var(--brand)"
    : "var(--atm)";

  let penaltyCalc: ReturnType<typeof earlyExitPenalty> | null = null;
  if (!fullyVested && showPenalty) {
    try {
      penaltyCalc = earlyExitPenalty(position, schedule, currentEpoch, position.remainingShares);
    } catch {
      penaltyCalc = null;
    }
  }

  const epochsToUnlock = summary.fullUnlockEpoch !== null
    ? Math.max(0, summary.fullUnlockEpoch - currentEpoch)
    : null;

  return (
    <div
      style={{
        border: "1px solid var(--border-default)",
        background: "var(--bg-overlay)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Title row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-hi)" }}>
          Deposit #{position.positionId.split(":").pop()}
          <span
            style={{
              marginLeft: 8,
              fontSize: 10,
              fontWeight: 400,
              color: "var(--text-lo)",
            }}
          >
            Epoch {position.depositEpoch}
          </span>
        </span>
        <span
          style={{
            fontSize: 10,
            padding: "2px 7px",
            border: `1px solid ${fullyVested ? "var(--call)" : "var(--atm)"}`,
            color: fullyVested ? "var(--call)" : "var(--atm)",
            letterSpacing: "0.05em",
          }}
        >
          {fullyVested ? "UNLOCKED" : `${summary.vestingPct}% VESTED`}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {pctBar(summary.vestingPct, barColor)}
        <span style={{ fontSize: 10, color: "var(--text-lo)", whiteSpace: "nowrap" }}>
          {vestingModelLabel(schedule.vestingModel)}
        </span>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Stat
          label="Total Shares"
          value={fmtShares(summary.totalShares)}
        />
        <Stat
          label="Unlocked"
          value={fmtShares(summary.unlockedShares)}
          valueColor="var(--call)"
        />
        {summary.lockedShares > 0n && (
          <Stat
            label="Locked"
            value={fmtShares(summary.lockedShares)}
            valueColor="var(--put)"
          />
        )}
        {epochsToUnlock !== null && epochsToUnlock > 0 && (
          <Stat
            label="Full Unlock In"
            value={`${epochsToUnlock} epoch${epochsToUnlock !== 1 ? "s" : ""}`}
          />
        )}
      </div>

      {/* Early-exit disclosure */}
      {!fullyVested && (
        <div>
          <button
            onClick={() => setShowPenalty(v => !v)}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              color: "var(--brand)",
              padding: 0,
            }}
            aria-expanded={showPenalty}
          >
            {showPenalty ? "▲ Hide" : "▼ Show"} early-exit penalty estimate
          </button>

          {showPenalty && penaltyCalc && (
            <div
              style={{
                marginTop: 8,
                padding: "10px 12px",
                background: "var(--bg-raised)",
                border: "1px solid var(--put)",
                fontSize: 11,
                color: "var(--text-mid)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
              role="note"
              aria-label="Early-exit penalty estimate"
            >
              <div style={{ color: "var(--put)", fontWeight: 700, marginBottom: 2 }}>
                Early-Exit Penalty Estimate (full withdrawal)
              </div>
              <div>
                Locked shares redeemed:{" "}
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {fmtShares(penaltyCalc.lockedConsumed)}
                </span>
              </div>
              <div>
                Penalty ({schedule.earlyExitPenaltyBps / 100}%):{" "}
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--put)" }}>
                  −{fmtShares(penaltyCalc.penaltyShares)} shares
                </span>
              </div>
              <div>
                Shares queued after penalty:{" "}
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--call)" }}>
                  {fmtShares(penaltyCalc.netShares)}
                </span>
              </div>
              <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-lo)" }}>
                Penalty shares are burned, raising NAV per share for remaining depositors.
                Wait {epochsToUnlock !== null ? `${epochsToUnlock} more epoch${epochsToUnlock !== 1 ? "s" : ""}` : "until full vesting"} to avoid this fee.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

interface VaultLockupPanelProps {
  positions: LockedPosition[];
  schedule: LockupSchedule | null;
  currentEpoch: number;
  loading?: boolean;
}

export function VaultLockupPanel({
  positions,
  schedule,
  currentEpoch,
  loading = false,
}: VaultLockupPanelProps) {
  if (!schedule || !schedule.active) {
    return null; // No lockup configured for this vault — nothing to show
  }

  const summaries: Array<{ summary: LockupSummary; position: LockedPosition }> = positions.map(
    p => ({ summary: buildLockupSummary(p, schedule, currentEpoch), position: p })
  );

  return (
    <section
      style={{
        border: "1px solid var(--border-default)",
        background: "var(--bg-raised)",
      }}
      aria-label="Share lockup and vesting schedule"
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13 }}>Share Lockup &amp; Vesting</span>
        <span style={{ fontSize: 11, color: "var(--text-lo)" }}>
          {vestingModelLabel(schedule.vestingModel)} · Penalty {schedule.earlyExitPenaltyBps / 100}% early exit
        </span>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {loading && (
          <div style={{ fontSize: 12, color: "var(--text-lo)", textAlign: "center", padding: 16 }}>
            Loading positions…
          </div>
        )}

        {!loading && positions.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-lo)", textAlign: "center", padding: 16 }}>
            No locked positions for your address in this vault.
          </div>
        )}

        {!loading &&
          summaries.map(({ summary, position }) => (
            <PositionCard
              key={position.positionId}
              summary={summary}
              position={position}
              schedule={schedule}
              currentEpoch={currentEpoch}
            />
          ))}
      </div>

      {/* Schedule info footer */}
      <div
        style={{
          padding: "8px 16px",
          borderTop: "1px solid var(--border-default)",
          fontSize: 10,
          color: "var(--text-lo)",
        }}
      >
        Lockup effective from epoch {schedule.effectiveFromEpoch}.
        Deposits made before that epoch are fully liquid.
        {schedule.vestingModel === "cliff" &&
          ` Cliff at epoch ${schedule.cliffEpoch} — 100% unlocks instantly.`}
        {schedule.vestingModel === "linear" &&
          ` Linear vesting over ${schedule.durationEpochs} epochs from epoch ${schedule.cliffEpoch}.`}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tiny stat cell (shared helper)
// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  valueColor = "var(--text-hi)",
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em" }}
      >
        {label}
      </span>
      <span
        style={{ fontSize: 13, fontWeight: 700, color: valueColor, fontFamily: "var(--font-mono)" }}
      >
        {value}
      </span>
    </div>
  );
}
