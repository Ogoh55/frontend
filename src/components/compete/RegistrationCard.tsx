"use client";

import { useState } from "react";
import type {
  CompetitionPhase,
  CompetitionRegistrationStatus,
} from "../../lib/api/types";
import type { CompetitionRegistrationWindow } from "../../lib/competitions";
import { truncateAddress } from "../../lib/competitions";

export interface RegistrationCardProps {
  phase: CompetitionPhase;
  window: CompetitionRegistrationWindow;
  address: string | null;
  /** Server-confirmed participation state. `not_registered` is the default. */
  status: CompetitionRegistrationStatus;
  /** Current opted-in pseudonym, if any. */
  displayName: string | null;
  submitting: boolean;
  error: string | null;
  onRegister: (displayName?: string | null) => void;
  onUpdateDisplayName?: (displayName: string) => void;
}

/**
 * Opt-in panel (issue #93).
 *
 * Three states, each decided by server data rather than local optimism:
 *  - not connected: prompt to connect, explained rather than a dead button;
 *  - not registered + window open: optional pseudonym, then "Enter";
 *  - registered: participation status, plus the ability to change or clear the
 *    display name — a pseudonym is opt-in, so removing it must be possible.
 *
 * When the window is closed the button is replaced by the reason ("registration
 * closed when the competition started"), because a disabled control with no
 * explanation is the failure mode this panel exists to avoid.
 */
export function RegistrationCard({
  phase,
  window: registrationWindow,
  address,
  status,
  displayName,
  submitting,
  error,
  onRegister,
  onUpdateDisplayName,
}: RegistrationCardProps) {
  const [name, setName] = useState(displayName ?? "");
  const registered = status === "registered" || status === "disqualified";
  const disqualified = status === "disqualified";

  return (
    <div
      data-testid="registration-card"
      data-status={status}
      style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: 16 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>Your entry</div>
        <span
          data-testid="participation-status"
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            padding: "2px 7px",
            background: disqualified ? "var(--put-dim)" : registered ? "var(--call-dim)" : "var(--bg-overlay)",
            color: disqualified ? "var(--put)" : registered ? "var(--call)" : "var(--text-lo)",
          }}
        >
          {disqualified ? "Disqualified" : registered ? "Registered" : "Not entered"}
        </span>
      </div>

      {!address ? (
        <p style={{ fontSize: 12, color: "var(--text-mid)" }}>
          Connect your wallet to enter. Entry is a signed message — no transaction, no fee.
        </p>
      ) : disqualified ? (
        <p style={{ fontSize: 12, color: "var(--put)" }}>
          This entry was disqualified and is not eligible for prizes. See the rules above for the
          volume and trade requirements.
        </p>
      ) : registered ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 12, color: "var(--text-mid)" }}>
            You are entered as <span className="num" style={{ color: "var(--text-hi)" }}>{truncateAddress(address)}</span>.
          </p>
          {onUpdateDisplayName && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                aria-label="Display name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Optional display name"
                maxLength={32}
                style={{
                  flex: 1, padding: "7px 9px", background: "var(--bg)", border: "1px solid var(--border-default)",
                  color: "var(--text-hi)", fontSize: 12, fontFamily: "var(--font-sans)",
                }}
              />
              <button
                onClick={() => onUpdateDisplayName(name)}
                disabled={submitting}
                style={{
                  padding: "7px 12px", background: "none", border: "1px solid var(--border-strong)",
                  color: "var(--text-hi)", fontSize: 12, cursor: submitting ? "default" : "pointer",
                }}
              >
                Save
              </button>
            </div>
          )}
          <p style={{ fontSize: 11, color: "var(--text-lo)" }}>
            Display names are optional and can be cleared at any time; clearing shows your truncated address instead.
          </p>
        </div>
      ) : registrationWindow === "open" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              aria-label="Display name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional display name"
              maxLength={32}
              style={{
                flex: 1, padding: "7px 9px", background: "var(--bg)", border: "1px solid var(--border-default)",
                color: "var(--text-hi)", fontSize: 12, fontFamily: "var(--font-sans)",
              }}
            />
            <button
              onClick={() => onRegister(name)}
              disabled={submitting}
              aria-label="Enter competition"
              style={{
                padding: "8px 14px", background: "var(--brand)", border: "none", color: "var(--bg)",
                fontSize: 12, fontWeight: 700, cursor: submitting ? "default" : "pointer",
                opacity: submitting ? 0.6 : 1, whiteSpace: "nowrap",
              }}
            >
              {submitting ? "Signing…" : "Enter competition"}
            </button>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-lo)" }}>
            Optional — leave blank to appear as your truncated wallet address. You will be asked to
            sign a message, not to send a transaction.
          </p>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--text-mid)" }}>
          {registrationWindow === "ended"
            ? "This competition has ended, so entry is closed."
            : "Registration closed when the competition started. The leaderboard below is live."}
        </p>
      )}

      {error && (
        <p role="alert" data-testid="registration-error" style={{ marginTop: 10, fontSize: 11, color: "var(--put)" }}>
          {error}
        </p>
      )}
      {phase === "active" && !registered && (
        <p style={{ marginTop: 10, fontSize: 11, color: "var(--text-lo)" }}>
          The competition is live. Scores update as trades settle.
        </p>
      )}
    </div>
  );
}
