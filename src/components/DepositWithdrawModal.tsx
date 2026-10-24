"use client";

import { useState, useEffect, useCallback } from "react";
import { useWalletStore } from "../lib/store/wallet";
import { useAccountReadiness } from "../lib/hooks/useAccountReadiness";
import { useNetworkReady } from "../lib/hooks/useNetworkReady";
import { depositToVault, withdrawFromVault, fetchVaultHistory, VAULT_CONTRACT_ID, VaultSubmissionUnknownError, type VaultEvent, type VaultConfirmationStatus } from "../lib/api/vault";
import { COLLATERAL_ASSET_CODE, explorerTxUrl } from "../lib/api/stellar";
import { IntentKeyManager } from "../lib/api/resilience/idempotency";
import { useBackendData } from "../lib/context/BackendDataContext";

type Mode = "deposit" | "withdraw";

// Module-level so a closed and reopened modal keeps the key for an unresolved
// intent. A resubmit of the same deposit then reuses the backend's stored build.
const vaultIntentKeys = new IntentKeyManager();

interface DepositWithdrawModalProps {
  initialMode?: Mode;
  onClose: () => void;
  onSuccess?: () => void;
}

const NETWORK_LABEL = process.env.NEXT_PUBLIC_NETWORK_LABEL ?? "Testnet";

// Base tx fee in XLM (100 stroops)
const TX_FEE_XLM = 0.00001;
// Soroban resource fee rough estimate in XLM
const SOROBAN_FEE_XLM = 0.001;
const TOTAL_FEE_XLM = TX_FEE_XLM + SOROBAN_FEE_XLM;

function fmtAmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function DepositWithdrawModal({
  initialMode = "deposit",
  onClose,
  onSuccess,
}: DepositWithdrawModalProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [amountStr, setAmountStr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // `confirmed` clears the intent. Anything else means the outcome is unresolved.
  const [txStatus, setTxStatus] = useState<VaultConfirmationStatus | "unknown" | null>(null);
  const [history, setHistory] = useState<VaultEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const { address, session: token } = useWalletStore();
  const { account: backendAccount, refreshAccount } = useBackendData();
  const { readiness, refresh: refreshReadiness } = useAccountReadiness();
  const networkReady = useNetworkReady();

  // Backend values
  const backendBalance = backendAccount?.balance ?? 0;
  const collateralLocked = backendAccount?.collateral_locked ?? 0;
  const freeCollateral = Math.max(0, backendBalance - collateralLocked);

  // On-chain values from readiness check
  const onChainCollateral = readiness.collateralBalance;
  const xlmBalance = readiness.xlmBalance;

  const amount = parseFloat(amountStr) || 0;

  // Max amounts
  const maxDeposit = onChainCollateral;
  const maxWithdraw = freeCollateral;

  // Balance preview
  const afterOnChainCollateral =
    mode === "deposit"
      ? onChainCollateral - amount
      : onChainCollateral + amount;
  const afterBackendBalance =
    mode === "deposit"
      ? backendBalance + amount
      : backendBalance - amount;

  // Validation
  function validate(): string | null {
    if (!address || !token) return "Wallet not connected.";
    if (!networkReady) return "Network mismatch — check the banner above.";
    if (!readiness.isReady) return "Account not ready. Complete the readiness checklist first.";
    if (!VAULT_CONTRACT_ID) return "Vault contract not configured (NEXT_PUBLIC_VAULT_CONTRACT_ID missing).";
    if (amount <= 0) return "Enter an amount greater than 0.";
    if (mode === "deposit") {
      if (amount > onChainCollateral)
        return `Amount exceeds on-chain ${COLLATERAL_ASSET_CODE} balance (${fmtAmt(onChainCollateral)}).`;
    } else {
      if (amount > freeCollateral)
        return `Amount exceeds free collateral (${fmtAmt(freeCollateral)} ${COLLATERAL_ASSET_CODE}).`;
    }
    return null;
  }

  const validationError = validate();

  // Load history
  const loadHistory = useCallback(() => {
    if (!address) return;
    setHistoryLoading(true);
    fetchVaultHistory(address)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [address]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Handle submit
  async function handleSubmit() {
    if (!address || !token || validationError) return;
    const idempotencyKey = vaultIntentKeys.keyFor({ mode, address, amount });
    setSubmitting(true);
    setTxError(null);
    setTxHash(null);
    setTxStatus(null);
    try {
      const result =
        mode === "deposit"
          ? await depositToVault(address, amount, token, idempotencyKey)
          : await withdrawFromVault(address, amount, token, freeCollateral, idempotencyKey);

      setTxHash(result.txHash);
      setTxStatus(result.status);
      if (result.status === "confirmed") vaultIntentKeys.complete();
      // Refresh balances after success
      refreshAccount();
      refreshReadiness();
      loadHistory();
      onSuccess?.();
    } catch (err) {
      if (err instanceof VaultSubmissionUnknownError) {
        // The transaction may already be on the ledger. Show the hash and keep
        // the key so Confirm can't create a second, different transaction.
        setTxHash(err.txHash);
        setTxStatus("unknown");
      } else {
        // Nothing was submitted, so the same intent can be retried with the same key.
        setTxError(err instanceof Error ? err.message : "Transaction failed");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        zIndex: 300,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          width: 420,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
        role="dialog"
        aria-modal="true"
        aria-label={`${mode === "deposit" ? "Deposit" : "Withdraw"} collateral`}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 0 }}>
            {(["deposit", "withdraw"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setAmountStr(""); setTxError(null); setTxHash(null); setTxStatus(null); }}
                aria-pressed={mode === m}
                style={{
                  padding: "4px 14px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  background: mode === m ? "var(--brand)" : "var(--bg-overlay)",
                  color: mode === m ? "var(--bg)" : "var(--text-mid)",
                  border: "1px solid var(--border-default)",
                  borderRight: m === "deposit" ? "none" : undefined,
                  textTransform: "capitalize",
                }}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "var(--text-lo)" }}
          >
            ✕
          </button>
        </div>

        {/* Network / readiness warnings */}
        {!networkReady && (
          <div style={{ fontSize: 11, color: "var(--put)", padding: "6px 8px", background: "var(--put-dim)", border: "1px solid var(--put)" }}>
            ⚠ Network mismatch detected. Fix it before transacting.
          </div>
        )}
        {!readiness.isReady && networkReady && (
          <div style={{ fontSize: 11, color: "var(--atm)", padding: "6px 8px", background: "var(--atm-dim)", border: "1px solid var(--atm)" }}>
            ⚠ Account readiness checks not complete. Finish setup before transacting.
          </div>
        )}

        {/* Amount input */}
        <div>
          <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            Amount ({COLLATERAL_ASSET_CODE})
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="number"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              min="0"
              step="0.01"
              placeholder="0.00"
              aria-label={`Amount in ${COLLATERAL_ASSET_CODE}`}
              style={{
                flex: 1,
                background: "var(--bg-overlay)",
                border: "1px solid var(--border-strong)",
                color: "var(--text-hi)",
                fontSize: 15,
                fontFamily: "var(--font-mono)",
                padding: "6px 10px",
                outline: "none",
              }}
            />
            <button
              onClick={() =>
                setAmountStr(
                  mode === "deposit" ? String(maxDeposit) : String(maxWithdraw)
                )
              }
              aria-label="Set max amount"
              style={{
                padding: "6px 10px",
                fontSize: 11,
                fontWeight: 700,
                background: "var(--bg-overlay)",
                border: "1px solid var(--border-default)",
                color: "var(--brand)",
                cursor: "pointer",
              }}
            >
              MAX
            </button>
          </div>
          <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
            {mode === "deposit"
              ? `Available on-chain: ${fmtAmt(maxDeposit)} ${COLLATERAL_ASSET_CODE}`
              : `Free collateral: ${fmtAmt(maxWithdraw)} ${COLLATERAL_ASSET_CODE}`}
          </div>
        </div>

        {/* Balance preview */}
        {amount > 0 && (
          <div
            style={{
              background: "var(--bg-overlay)",
              border: "1px solid var(--border-subtle)",
              padding: "10px 12px",
              fontSize: 11,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ fontWeight: 600, color: "var(--text-hi)", marginBottom: 2 }}>Balance preview</div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-mid)" }}>
              <span>On-chain {COLLATERAL_ASSET_CODE}</span>
              <span className="num">{fmtAmt(onChainCollateral)} → <strong style={{ color: afterOnChainCollateral < 0 ? "var(--put)" : "var(--text-hi)" }}>{fmtAmt(Math.max(0, afterOnChainCollateral))}</strong></span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-mid)" }}>
              <span>Protocol balance</span>
              <span className="num">{fmtAmt(backendBalance)} → <strong style={{ color: "var(--text-hi)" }}>{fmtAmt(Math.max(0, afterBackendBalance))}</strong></span>
            </div>
          </div>
        )}

        {/* Fee breakdown */}
        <div
          style={{
            fontSize: 11,
            color: "var(--text-lo)",
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: 8,
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--text-mid)", marginBottom: 4 }}>Fee breakdown</div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Base tx fee</span>
            <span className="num">{TX_FEE_XLM.toFixed(5)} XLM</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Soroban resource fee (est.)</span>
            <span className="num">~{SOROBAN_FEE_XLM.toFixed(3)} XLM</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, color: "var(--text-mid)", marginTop: 2 }}>
            <span>Total fees (est.)</span>
            <span className="num">~{TOTAL_FEE_XLM.toFixed(4)} XLM</span>
          </div>
          <div style={{ marginTop: 3 }}>XLM available: <span className="num">{xlmBalance.toFixed(4)}</span></div>
        </div>

        {/* Error / success */}
        {txError && (
          <div style={{ fontSize: 11, color: "var(--put)", padding: "6px 8px", background: "var(--put-dim)", border: "1px solid var(--put)" }}>
            {txError}
          </div>
        )}
        {txHash && txStatus === "confirmed" && (
          <div style={{ fontSize: 11, color: "var(--call)", padding: "6px 8px", background: "var(--call-dim)", border: "1px solid var(--call)" }}>
            ✓ Transaction confirmed —{" "}
            <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer" style={{ color: "var(--call)" }}>
              view on explorer ↗
            </a>
          </div>
        )}
        {txHash && txStatus && txStatus !== "confirmed" && (
          <div style={{ fontSize: 11, color: "var(--text-mid)", padding: "6px 8px", background: "var(--bg-overlay)", border: "1px solid var(--border-default)" }}>
            Submitted, awaiting confirmation. Do not retry; the {mode} may already have settled.{" "}
            <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer" style={{ color: "var(--text-hi)" }}>
              check on explorer ↗
            </a>
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!!validationError || submitting || !!txHash}
          aria-label={`Confirm ${mode}`}
          style={{
            padding: "9px 0",
            background: validationError || submitting || txHash ? "var(--bg-overlay)" : "var(--brand)",
            color: validationError || submitting || txHash ? "var(--text-lo)" : "var(--bg)",
            border: "none",
            fontSize: 13,
            fontWeight: 700,
            cursor: validationError || submitting || txHash ? "default" : "pointer",
            textTransform: "capitalize",
          }}
        >
          {submitting
            ? "Signing & submitting…"
            : txStatus && txStatus !== "confirmed"
              ? "Awaiting confirmation"
              : txHash ? "Done" : `Confirm ${mode}`}
        </button>

        {validationError && !txHash && (
          <div style={{ fontSize: 11, color: "var(--text-lo)", textAlign: "center" }}>
            {validationError}
          </div>
        )}

        {/* History */}
        <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Vault history {historyLoading && <span style={{ color: "var(--text-lo)" }}>(loading…)</span>}
          </div>
          {!VAULT_CONTRACT_ID && (
            <div style={{ fontSize: 11, color: "var(--text-lo)" }}>
              Contract not configured — history unavailable.
            </div>
          )}
          {VAULT_CONTRACT_ID && !historyLoading && history.length === 0 && (
            <div style={{ fontSize: 11, color: "var(--text-lo)" }}>No deposits or withdrawals yet.</div>
          )}
          {history.map((ev, i) => (
            <div
              key={`${ev.txHash}-${i}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "5px 0",
                borderBottom: "1px solid var(--border-subtle)",
                fontSize: 11,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: ev.type === "deposit" ? "var(--call)" : "var(--put)", fontWeight: 600, textTransform: "capitalize" }}>
                  {ev.type}
                </span>
                <span className="num" style={{ color: "var(--text-hi)" }}>
                  {fmtAmt(ev.amount)} {COLLATERAL_ASSET_CODE}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, color: "var(--text-lo)" }}>
                <span>{formatDate(ev.timestamp)}</span>
                {ev.txHash && (
                  <a href={explorerTxUrl(ev.txHash)} target="_blank" rel="noreferrer" style={{ color: "var(--text-lo)" }}>
                    ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
