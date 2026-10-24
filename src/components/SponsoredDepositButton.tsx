"use client";

/**
 * SponsoredDepositButton (#247)
 *
 * Drop-in replacement for a standard deposit/redeem call button that
 * attempts the fee-bump sponsorship path first, then falls back to the
 * standard flow if the BFF sponsor is unavailable.
 *
 * Shows:
 *  - "No XLM required" badge when sponsorship is available.
 *  - A four-step progress indicator during the flow
 *    (Building → Signing → Submitting → Confirming).
 *  - A "Sponsored by Zenith" attribution line with the estimated XLM saved.
 *  - A transparent fallback message if sponsorship fails and the standard
 *    path is used instead.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  checkSponsorshipEligibility,
  runSponsoredVaultFlow,
  runStandardVaultFlow,
  SponsorshipError,
  type SponsorableEntryPoint,
  type SponsoredDepositParams,
  type SponsoredRedeemParams,
  type SponsoredFlowStep,
} from "../lib/soroban/feeBump";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SponsoredDepositButtonProps {
  vaultId: string;
  entryPoint: SponsorableEntryPoint;
  userAddress: string;
  params: SponsoredDepositParams | SponsoredRedeemParams;
  sessionToken?: string;
  disabled?: boolean;
  /** Called on successful completion with the transaction hash. */
  onSuccess: (txHash: string, sponsored: boolean) => void;
  /** Called on any terminal failure. */
  onError: (message: string) => void;
  label?: string;
}

// ---------------------------------------------------------------------------
// Step labels
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<SponsoredFlowStep, string> = {
  building:   "Building transaction…",
  signing:    "Sign in Freighter…",
  submitting: "Submitting to network…",
  confirming: "Awaiting confirmation…",
};

const STEP_ORDER: SponsoredFlowStep[] = ["building", "signing", "submitting", "confirming"];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SponsoredDepositButton({
  vaultId,
  entryPoint,
  userAddress,
  params,
  sessionToken,
  disabled = false,
  onSuccess,
  onError,
  label,
}: SponsoredDepositButtonProps) {
  const [sponsorshipAvailable, setSponsorshipAvailable] = useState<boolean | null>(null);
  const [estimatedSponsorFee, setEstimatedSponsorFee] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<SponsoredFlowStep | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);
  const [sponsoredFeeXlm, setSponsoredFeeXlm] = useState<string | null>(null);

  // Check eligibility on mount / when vaultId or entryPoint changes
  useEffect(() => {
    let cancelled = false;
    setSponsorshipAvailable(null);
    setEstimatedSponsorFee(null);
    checkSponsorshipEligibility(vaultId, entryPoint).then(result => {
      if (cancelled) return;
      setSponsorshipAvailable(result.available);
      setEstimatedSponsorFee(result.estimatedSponsorFeeXlm ?? null);
    });
    return () => { cancelled = true; };
  }, [vaultId, entryPoint]);

  const isRunning = activeStep !== null;

  const handleClick = useCallback(async () => {
    if (isRunning || disabled) return;
    setUsedFallback(false);
    setSponsoredFeeXlm(null);

    try {
      if (sponsorshipAvailable) {
        // Sponsored path
        const result = await runSponsoredVaultFlow({
          vaultId,
          entryPoint,
          userAddress,
          params,
          sessionToken,
          onProgress: step => setActiveStep(step),
        });
        setSponsoredFeeXlm(result.sponsoredFeeXlm);
        setActiveStep(null);
        onSuccess(result.txHash, true);
      } else {
        // Standard path (sponsor unavailable or check inconclusive)
        setActiveStep("building");
        const result = await runStandardVaultFlow({
          vaultId,
          entryPoint,
          userAddress,
          params,
          sessionToken,
        });
        setActiveStep(null);
        onSuccess(result.txHash, false);
      }
    } catch (e) {
      setActiveStep(null);
      // If the sponsored path failed, attempt the standard fallback
      if (e instanceof SponsorshipError && e.code !== "SIGN_REJECTED") {
        setUsedFallback(true);
        try {
          setActiveStep("building");
          const result = await runStandardVaultFlow({
            vaultId,
            entryPoint,
            userAddress,
            params,
            sessionToken,
          });
          setActiveStep(null);
          onSuccess(result.txHash, false);
        } catch (fallbackError) {
          setActiveStep(null);
          onError(fallbackError instanceof Error ? fallbackError.message : "Transaction failed");
        }
      } else {
        onError(e instanceof Error ? e.message : "Transaction failed");
      }
    }
  }, [
    isRunning, disabled, sponsorshipAvailable, vaultId, entryPoint,
    userAddress, params, sessionToken, onSuccess, onError,
  ]);

  // Determine button label
  const buttonLabel = isRunning
    ? STEP_LABELS[activeStep!]
    : (label ?? (entryPoint === "deposit" ? "Deposit" : "Request Redemption"));

  const currentStepIndex = activeStep ? STEP_ORDER.indexOf(activeStep) : -1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* No-XLM badge */}
      {sponsorshipAvailable && !isRunning && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 10,
            color: "var(--call)",
            border: "1px solid var(--call)",
            padding: "2px 8px",
            alignSelf: "flex-start",
          }}
          role="status"
          aria-label="No XLM required"
        >
          <span style={{ fontSize: 12 }}>✦</span>
          No XLM required · Fees sponsored
          {estimatedSponsorFee && (
            <span style={{ color: "var(--text-lo)", marginLeft: 4 }}>
              (~{estimatedSponsorFee} XLM)
            </span>
          )}
        </div>
      )}

      {/* Main action button */}
      <button
        onClick={handleClick}
        disabled={disabled || isRunning}
        style={{
          padding: "11px 20px",
          fontSize: 13,
          fontWeight: 700,
          background: isRunning ? "var(--bg-overlay)" : "var(--brand)",
          color: isRunning ? "var(--text-lo)" : "var(--bg-base)",
          border: "none",
          cursor: disabled || isRunning ? "default" : "pointer",
          transition: "background 0.15s, color 0.15s",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
        aria-busy={isRunning}
        aria-label={buttonLabel}
      >
        {buttonLabel}
      </button>

      {/* Step progress indicator */}
      {isRunning && (
        <div
          style={{ display: "flex", gap: 4, alignItems: "center" }}
          role="progressbar"
          aria-label="Transaction progress"
          aria-valuenow={currentStepIndex + 1}
          aria-valuemin={1}
          aria-valuemax={STEP_ORDER.length}
        >
          {STEP_ORDER.map((step, i) => (
            <React.Fragment key={step}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    i < currentStepIndex
                      ? "var(--call)"
                      : i === currentStepIndex
                      ? "var(--brand)"
                      : "var(--bg-overlay)",
                  transition: "background 0.3s",
                }}
                aria-label={`Step ${i + 1}: ${step}`}
              />
              {i < STEP_ORDER.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: 1,
                    background: i < currentStepIndex ? "var(--call)" : "var(--bg-overlay)",
                    transition: "background 0.3s",
                  }}
                />
              )}
            </React.Fragment>
          ))}
          <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-lo)" }}>
            {currentStepIndex + 1} / {STEP_ORDER.length}
          </span>
        </div>
      )}

      {/* Post-success attribution */}
      {sponsoredFeeXlm && !isRunning && (
        <div
          style={{ fontSize: 10, color: "var(--call)" }}
          role="status"
          aria-live="polite"
        >
          ✓ Sponsored by Zenith — {sponsoredFeeXlm} XLM fee covered
        </div>
      )}

      {/* Fallback notice */}
      {usedFallback && !isRunning && !sponsoredFeeXlm && (
        <div
          style={{ fontSize: 10, color: "var(--atm)" }}
          role="status"
          aria-live="polite"
        >
          ℹ Sponsorship temporarily unavailable — standard transaction submitted.
          XLM fee applied from your account.
        </div>
      )}
    </div>
  );
}
