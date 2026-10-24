"use client";

import { useState } from "react";
import type { EpochRecord } from "../lib/api/vaults";
import {
  getVaultHistoryDays,
  projectVaultReturns,
} from "../lib/vaultProjection";

interface VaultReturnProjectionProps {
  historicalEpochs: EpochRecord[];
}

function formatUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function VaultReturnProjection({
  historicalEpochs,
}: VaultReturnProjectionProps) {
  const availableDays = getVaultHistoryDays(historicalEpochs);
  const maxDays = Math.max(1, Math.floor(availableDays));
  const [depositAmount, setDepositAmount] = useState("1000");
  const [holdingDays, setHoldingDays] = useState(String(Math.min(30, maxDays)));
  const amount = Number(depositAmount);
  const days = Number(holdingDays);
  const validInputs =
    Number.isFinite(amount) &&
    amount > 0 &&
    Number.isFinite(days) &&
    days > 0;
  const projection = validInputs
    ? projectVaultReturns(amount, days, historicalEpochs)
    : null;

  return (
    <section
      aria-label="Historical returns projection"
      style={{
        border: "1px solid var(--border-default)",
        background: "var(--bg-raised)",
        padding: 16,
      }}
    >
      <h2
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-hi)",
          marginBottom: 8,
        }}
      >
        Historical Returns Projection
      </h2>
      <p
        style={{
          fontSize: 11,
          color: "var(--text-mid)",
          lineHeight: 1.6,
          marginBottom: 12,
        }}
      >
        See how a deposit would have changed using this vault&apos;s completed
        historical epoch returns. This is not a forecast; returns beyond the
        available history are not extrapolated.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label
          style={{
            flex: "1 1 140px",
            fontSize: 10,
            color: "var(--text-lo)",
          }}
        >
          Deposit amount (USDC)
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={depositAmount}
            onChange={(event) => setDepositAmount(event.target.value)}
            aria-label="Projection deposit amount in USDC"
            style={{
              display: "block",
              boxSizing: "border-box",
              width: "100%",
              marginTop: 4,
              padding: "8px 10px",
              background: "var(--bg-overlay)",
              border: "1px solid var(--border-default)",
              color: "var(--text-hi)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          />
        </label>
        <label
          style={{
            flex: "1 1 140px",
            fontSize: 10,
            color: "var(--text-lo)",
          }}
        >
          Holding period (days)
          <input
            type="number"
            min="1"
            max={maxDays}
            step="1"
            value={holdingDays}
            onChange={(event) => setHoldingDays(event.target.value)}
            aria-label="Projection holding period in days"
            style={{
              display: "block",
              boxSizing: "border-box",
              width: "100%",
              marginTop: 4,
              padding: "8px 10px",
              background: "var(--bg-overlay)",
              border: "1px solid var(--border-default)",
              color: "var(--text-hi)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          />
        </label>
      </div>
      {projection && (
        <div
          aria-live="polite"
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "var(--bg-elevated)",
            borderLeft: "3px solid var(--brand)",
          }}
        >
          <div style={{ fontSize: 10, color: "var(--text-lo)" }}>
            Historical illustration after {projection.completedEpochs}{" "}
            completed {projection.completedEpochs === 1 ? "epoch" : "epochs"}
            {projection.completedEpochs > 0 &&
              ` (${projection.coveredDays.toFixed(0)} days of returns)`}
          </div>
          {projection.completedEpochs > 0 ? (
            <div
              className="num"
              style={{
                marginTop: 4,
                fontSize: 18,
                fontWeight: 700,
                color:
                  projection.returnPct >= 0 ? "var(--call)" : "var(--put)",
              }}
            >
              {formatUsd(projection.projectedValue)}{" "}
              <span style={{ fontSize: 12 }}>
                ({projection.returnPct >= 0 ? "+" : ""}
                {(projection.returnPct * 100).toFixed(2)}%)
              </span>
            </div>
          ) : (
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-mid)" }}>
              No full historical epoch fits this holding period.
            </div>
          )}
        </div>
      )}
      {!validInputs && (
        <div role="alert" style={{ marginTop: 8, fontSize: 11, color: "var(--put)" }}>
          Enter a positive deposit amount and holding period.
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 9, color: "var(--text-lo)" }}>
        Based on {historicalEpochs.length} historical epochs (
        {availableDays.toFixed(0)} days of recorded history). Past performance
        does not guarantee future results.
      </div>
    </section>
  );
}
