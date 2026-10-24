"use client";

/**
 * VaultReferralPanel
 *
 * Depositor-facing referral and loyalty rewards panel for the vault detail
 * sidebar.  Displays:
 *   - Referral link with copy-to-clipboard
 *   - Current loyalty tier and consecutive epochs progress
 *   - Per-epoch accrual table with claim flow (merkle proof → on-chain claim)
 *   - Plain-language program rules summary
 *   - Attribution capture: reads ?ref= from URL on mount and registers it once
 *     the wallet is connected
 *
 * Props:
 *   walletAddress  — connected wallet; panel shows sign-in prompt if absent
 *   token          — bearer token for authed API calls
 *   vaultId        — the vault being viewed
 *   vaultName      — display name of the vault
 */

import { useEffect, useState, useCallback, useRef } from "react";
import {
  getVaultReferralStatus,
  getVaultMerkleProof,
  claimVaultReward,
  registerVaultAttribution,
  type VaultReferralStatus,
  type VaultLoyaltyAccrual,
} from "../lib/api/vaultReferral";
import {
  verifyMerkleProof,
  loyaltyTierColor,
  loyaltyTierLabel,
  EPOCHS_PER_TIER,
  LOYALTY_MULTIPLIERS,
} from "../lib/vaultReferral";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_STORAGE_KEY = "zenith_vault_ref_pending";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtReward(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Attribution capture (runs once on mount)
// ---------------------------------------------------------------------------

function captureVaultRefFromUrl(vaultId: string) {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("ref");
    if (!code || !/^[A-Za-z0-9]{8,32}$/.test(code)) return;
    if (localStorage.getItem("zenith_ref_opt_out") === "1") return;
    const key = `${REF_STORAGE_KEY}:${vaultId}`;
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, code);
    }
  } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TierBadge({ tier, label }: { tier: number; label: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: loyaltyTierColor(tier),
        border: `1px solid ${loyaltyTierColor(tier)}`,
        background: "var(--bg-overlay)",
      }}
    >
      {label}
    </span>
  );
}

function TierProgressBar({
  consecutiveEpochs,
  tier,
  epochsToNext,
}: {
  consecutiveEpochs: number;
  tier: number;
  epochsToNext: number;
}) {
  const maxTier = LOYALTY_MULTIPLIERS.length - 1;
  const pct = tier >= maxTier ? 100 : Math.round(((EPOCHS_PER_TIER - epochsToNext) / EPOCHS_PER_TIER) * 100);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 10, color: "var(--text-lo)" }}>
        <span>{consecutiveEpochs} qualifying epoch{consecutiveEpochs !== 1 ? "s" : ""}</span>
        <span style={{ color: loyaltyTierColor(tier) }}>
          {tier >= maxTier ? "Max tier" : `${epochsToNext} epoch${epochsToNext !== 1 ? "s" : ""} to ${loyaltyTierLabel(tier + 1)}`}
        </span>
      </div>
      <div style={{ height: 4, background: "var(--bg-overlay)", border: "1px solid var(--border-subtle)" }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: loyaltyTierColor(tier),
            transition: "width 0.4s ease",
          }}
        />
      </div>
    </div>
  );
}

function AccrualRow({
  accrual,
  onClaim,
  claiming,
}: {
  accrual: VaultLoyaltyAccrual;
  onClaim: (accrual: VaultLoyaltyAccrual) => void;
  claiming: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "44px 56px 1fr 72px",
        alignItems: "center",
        gap: 0,
        padding: "7px 10px",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: 11,
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-lo)" }}>
        #{accrual.epochNumber}
      </span>
      <TierBadge tier={accrual.loyaltyTier} label={accrual.loyaltyTierLabel} />
      <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-hi)", textAlign: "right", paddingRight: 10 }}>
        {fmtReward(accrual.totalReward)}
      </span>
      {accrual.claimed ? (
        <span style={{ fontSize: 9, color: "var(--text-lo)", textAlign: "right" }}>Claimed</span>
      ) : accrual.claimable ? (
        <button
          onClick={() => onClaim(accrual)}
          disabled={claiming}
          style={{
            padding: "4px 8px",
            fontSize: 10,
            fontWeight: 700,
            background: "var(--brand)",
            color: "var(--bg)",
            border: "none",
            cursor: claiming ? "not-allowed" : "pointer",
            opacity: claiming ? 0.6 : 1,
          }}
          aria-label={`Claim reward for epoch ${accrual.epochNumber}`}
        >
          {claiming ? "…" : "Claim"}
        </button>
      ) : (
        <span style={{ fontSize: 9, color: "var(--text-lo)", textAlign: "right" }}>Pending</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface VaultReferralPanelProps {
  walletAddress: string | null | undefined;
  token: string | null | undefined;
  vaultId: string;
  vaultName: string;
}

export function VaultReferralPanel({
  walletAddress,
  token,
  vaultId,
  vaultName,
}: VaultReferralPanelProps) {
  const [status, setStatus] = useState<VaultReferralStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);
  const [claimingEpoch, setClaimingEpoch] = useState<number | null>(null);
  const [claimResult, setClaimResult] = useState<{ epoch: number; txHash: string } | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const [rulesOpen, setRulesOpen] = useState(false);

  // Track attribution registration to avoid duplicate calls
  const attributionRegistered = useRef(false);

  // ── Attribution capture ───────────────────────────────────────────────────
  useEffect(() => {
    captureVaultRefFromUrl(vaultId);
  }, [vaultId]);

  // ── Register pending attribution once wallet connects ─────────────────────
  useEffect(() => {
    if (!token || !walletAddress || attributionRegistered.current) return;
    const key = `${REF_STORAGE_KEY}:${vaultId}`;
    try {
      const pending = sessionStorage.getItem(key);
      if (!pending || !/^[A-Za-z0-9]{8,32}$/.test(pending)) return;
      attributionRegistered.current = true;
      registerVaultAttribution(pending, vaultId, token)
        .then(() => sessionStorage.removeItem(key))
        .catch(() => { /* non-critical */ });
    } catch { /* storage unavailable */ }
  }, [token, walletAddress, vaultId]);

  // ── Load status ───────────────────────────────────────────────────────────
  const loadStatus = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      const s = await getVaultReferralStatus(walletAddress, token);
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load referral status.");
    } finally {
      setLoading(false);
    }
  }, [walletAddress, token]);

  useEffect(() => {
    if (walletAddress) loadStatus();
  }, [walletAddress, loadStatus]);

  // ── Copy referral link ─────────────────────────────────────────────────────
  const copyLink = () => {
    if (!status?.referralCode.link) return;
    navigator.clipboard.writeText(status.referralCode.link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // ── Claim ─────────────────────────────────────────────────────────────────
  const handleClaim = useCallback(
    async (accrual: VaultLoyaltyAccrual) => {
      if (!walletAddress || !token) return;
      setClaimingEpoch(accrual.epochNumber);
      setClaimError(null);
      setClaimResult(null);
      try {
        const { proof, alreadyClaimed } = await getVaultMerkleProof(
          walletAddress,
          accrual.vaultId,
          accrual.epochNumber,
          token,
        );

        if (alreadyClaimed) {
          setClaimError(`Epoch ${accrual.epochNumber} rewards were already claimed.`);
          return;
        }

        // Verify proof client-side before submitting
        if (!verifyMerkleProof(proof)) {
          setClaimError("Merkle proof verification failed. Please try again or contact support.");
          return;
        }

        const result = await claimVaultReward(
          walletAddress,
          accrual.vaultId,
          accrual.epochNumber,
          proof.proof,
          proof.leaf.amount,
          token,
        );

        setClaimResult({ epoch: result.epochNumber, txHash: result.txHash });
        await loadStatus();
      } catch (e) {
        setClaimError(e instanceof Error ? e.message : "Claim failed.");
      } finally {
        setClaimingEpoch(null);
      }
    },
    [walletAddress, token, loadStatus],
  );

  // ── Find loyalty state for this vault ────────────────────────────────────
  const loyaltyForThisVault = status?.vaultLoyalty.find(v => v.vaultId === vaultId);

  // ── Accruals for this vault ───────────────────────────────────────────────
  const vaultAccruals: VaultLoyaltyAccrual[] = status?.recentAccruals.filter(
    a => a.vaultId === vaultId,
  ) ?? [];

  // ── Not connected ─────────────────────────────────────────────────────────
  if (!walletAddress) {
    return (
      <section
        aria-label="Referral & Loyalty Rewards"
        style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)", padding: "16px 18px" }}
      >
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 10 }}>
          Referral &amp; Loyalty
        </div>
        <div style={{ fontSize: 12, color: "var(--text-lo)" }}>
          Connect your wallet to access referral rewards and loyalty accruals for {vaultName}.
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Referral & Loyalty Rewards"
      style={{ border: "1px solid var(--border-default)", background: "var(--bg-raised)" }}
    >
      {/* Header */}
      <div style={{ padding: "14px 18px 10px", borderBottom: "1px solid var(--border-subtle)" }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-lo)", marginBottom: 2 }}>
          Referral &amp; Loyalty Rewards
        </div>
        <div style={{ fontSize: 11, color: "var(--text-mid)" }}>{vaultName}</div>
      </div>

      {loading && !status && (
        <div style={{ padding: "20px 18px", textAlign: "center" }}>
          <div className="skeleton" style={{ height: 12, width: "60%", margin: "0 auto" }} />
        </div>
      )}

      {error && (
        <div style={{ padding: "10px 18px", fontSize: 11, color: "var(--put)" }}>{error}</div>
      )}

      {status && (
        <>
          {/* ── Summary stats ──────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border-subtle)" }}>
            {[
              {
                label: "Claimable",
                value: fmtReward(status.claimableReward),
                color: status.claimableReward > 0 ? "var(--call)" : "var(--text-lo)",
              },
              {
                label: "Total Earned",
                value: fmtReward(status.totalAccruedReward),
                color: "var(--text-hi)",
              },
              {
                label: "Referees",
                value: String(status.referralCode.totalReferees),
                color: "var(--text-hi)",
              },
            ].map((s, i) => (
              <div
                key={s.label}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderLeft: i > 0 ? "1px solid var(--border-subtle)" : "none",
                }}
              >
                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", marginBottom: 3 }}>
                  {s.label}
                </div>
                <div className="num" style={{ fontSize: 13, fontWeight: 600, color: s.color }}>
                  {s.value}
                </div>
              </div>
            ))}
          </div>

          {/* ── Loyalty tier (for this vault) ──────────────────────────── */}
          {loyaltyForThisVault && (
            <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border-subtle)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  Loyalty
                </span>
                <TierBadge tier={loyaltyForThisVault.tier} label={loyaltyForThisVault.tierLabel} />
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-lo)" }}>
                  {fmtPct(loyaltyForThisVault.currentMultiplier - 1)} bonus
                </span>
              </div>
              <TierProgressBar
                consecutiveEpochs={loyaltyForThisVault.consecutiveEpochs}
                tier={loyaltyForThisVault.tier}
                epochsToNext={loyaltyForThisVault.epochsToNextTier}
              />
            </div>
          )}

          {/* ── Referral link ──────────────────────────────────────────── */}
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", marginBottom: 6 }}>
              Your Referral Link
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
              <div
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--text-hi)",
                  background: "var(--bg-overlay)",
                  border: "1px solid var(--border-default)",
                  padding: "6px 8px",
                  wordBreak: "break-all",
                }}
              >
                {status.referralCode.link}
              </div>
              <button
                onClick={copyLink}
                aria-label="Copy referral link"
                style={{
                  padding: "6px 12px",
                  fontSize: 10,
                  fontWeight: 700,
                  background: copied ? "var(--call-dim)" : "var(--brand)",
                  color: copied ? "var(--call)" : "var(--bg)",
                  border: "none",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 16 }}>
              <div>
                <span style={{ fontSize: 9, color: "var(--text-lo)" }}>Code: </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--brand)", letterSpacing: "0.1em" }}>
                  {status.referralCode.code}
                </span>
              </div>
              <div>
                <span style={{ fontSize: 9, color: "var(--text-lo)" }}>Vol: </span>
                <span className="num" style={{ fontSize: 11, color: "var(--text-mid)" }}>
                  ${status.referralCode.totalReferredVolumeUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              </div>
            </div>
          </div>

          {/* ── Claim result / error ───────────────────────────────────── */}
          {claimResult && (
            <div
              role="status"
              style={{ padding: "8px 18px", background: "var(--call-dim)", borderBottom: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--call)" }}
            >
              Epoch #{claimResult.epoch} rewards claimed.{" "}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>{claimResult.txHash.slice(0, 20)}…</span>
            </div>
          )}
          {claimError && (
            <div
              role="alert"
              style={{ padding: "8px 18px", background: "var(--put-dim)", borderBottom: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--put)" }}
            >
              {claimError}
            </div>
          )}

          {/* ── Accrual history for this vault ─────────────────────────── */}
          {vaultAccruals.length > 0 && (
            <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              {/* Table header */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "44px 56px 1fr 72px",
                  padding: "6px 10px",
                  borderBottom: "1px solid var(--border-subtle)",
                  background: "var(--bg-overlay)",
                }}
              >
                {["Epoch", "Tier", "Reward", ""].map((h, i) => (
                  <span
                    key={h + i}
                    style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-lo)", textAlign: i === 2 ? "right" : "left", paddingRight: i === 2 ? 10 : 0 }}
                  >
                    {h}
                  </span>
                ))}
              </div>
              {vaultAccruals.map(a => (
                <AccrualRow
                  key={a.epochNumber}
                  accrual={a}
                  onClaim={handleClaim}
                  claiming={claimingEpoch === a.epochNumber}
                />
              ))}
            </div>
          )}

          {/* ── Rules summary (collapsible) ────────────────────────────── */}
          <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
            <button
              onClick={() => setRulesOpen(o => !o)}
              aria-expanded={rulesOpen}
              style={{
                width: "100%",
                padding: "10px 18px",
                background: "none",
                border: "none",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                fontSize: 11,
                color: "var(--text-mid)",
              }}
            >
              <span>Program Rules</span>
              <span style={{ fontSize: 10, color: "var(--text-lo)" }}>{rulesOpen ? "▲" : "▼"}</span>
            </button>
            {rulesOpen && (
              <div style={{ padding: "0 18px 14px", fontSize: 11, color: "var(--text-mid)", lineHeight: 1.7 }}>
                <ul style={{ margin: 0, paddingLeft: 16, color: "var(--text-mid)" }}>
                  <li>
                    <strong style={{ color: "var(--text-hi)" }}>Attribution:</strong> First-touch only. The first valid referral code on your first funded deposit is recorded. Subsequent codes are ignored.
                  </li>
                  <li>
                    <strong style={{ color: "var(--text-hi)" }}>Eligibility:</strong> Rewards accrue only on genuinely funded deposits. Uncalled commitments, secondary LP-share transfers, and deposits withdrawn before the minimum hold period do not earn rewards.
                  </li>
                  <li>
                    <strong style={{ color: "var(--text-hi)" }}>Loyalty tiers:</strong> Bronze → Silver → Gold → Platinum, advancing every {EPOCHS_PER_TIER} consecutive qualifying epochs. Dropping below the minimum balance resets your streak.
                  </li>
                  <li>
                    <strong style={{ color: "var(--text-hi)" }}>Referral commission:</strong> Referrers earn {(100 * 0.10).toFixed(0)}% of the base reward for each funded referee epoch, up to the per-epoch volume cap.
                  </li>
                  <li>
                    <strong style={{ color: "var(--text-hi)" }}>Anti-abuse:</strong> Self-referral, circular referral rings, and wallets below the minimum eligibility score cannot earn referral commissions.
                  </li>
                  <li>
                    <strong style={{ color: "var(--text-hi)" }}>Claims:</strong> Rewards are published each epoch as a merkle root. Claim them here using the verified proof.
                  </li>
                  <li>
                    <strong style={{ color: "var(--text-hi)" }}>Privacy:</strong> Referral linkage is depositor data. Opt out at any time by clearing your referral code in Settings.
                  </li>
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
