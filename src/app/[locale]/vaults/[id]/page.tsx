{txStatus === "pending" ? "Confirming…" : "Deposit"}
                        </button>
                      </div>
                    )}

                    {activeFlow === "withdraw" && permittedActions.includes("withdraw") && (
                      <div style={{ padding: 16 }}>
                        <div style={{ fontSize: 11, color: "var(--text-mid)", marginBottom: 12 }}>
                          Withdrawal requests are queued and processed at the end of the current epoch.
                          Shares are redeemed at the final NAV after settlement.
                        </div>
                        <div style={{ marginBottom: 12 }}>
                          <label style={{ fontSize: 10, color: "var(--text-lo)", display: "block", marginBottom: 4 }}>Shares to Withdraw</label>
                          <input
                            type="number"
                            min={0}
                            value={withdrawShares}
                            onChange={e => setWithdrawShares(e.target.value)}
                            placeholder="0.0000"
                            style={{
                              width: "100%", padding: "8px 10px",
                              background: "var(--bg-overlay)", border: "1px solid var(--border-default)",
                              color: "var(--text-hi)", fontFamily: "var(--font-mono)", fontSize: 13,
                            }}
                          />
                          {withdrawShares && !isNaN(parseFloat(withdrawShares)) && parseFloat(withdrawShares) > 0 && (
                            <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
                              ≈ ${(parseFloat(withdrawShares) * vault.sharePrice).toFixed(2)} USDC at current NAV
                            </div>
                          )}
                        </div>
                        <button
                          onClick={handleWithdraw}
                          disabled={txStatus === "pending" || !withdrawShares || isNaN(parseFloat(withdrawShares)) || parseFloat(withdrawShares) <= 0}
                          style={{
                            width: "100%", padding: "10px 0", background: "var(--brand)",
                            color: "var(--bg)", border: "none", fontSize: 13, fontWeight: 700,
                            cursor: txStatus === "pending" ? "default" : "pointer",
                            opacity: txStatus === "pending" ? 0.6 : 1,
                          }}
                        >
                          {txStatus === "pending" ? "Confirming…" : "Withdraw"}
                        </button>
                      </div>
                    )}

                    {txStatus && txStatus !== "pending" && (
                      <div style={{
                        padding: "8px 16px", fontSize: 11,
                        color: txStatus === "success" ? "var(--call)" : "var(--put)",
                        borderTop: "1px solid var(--border-default)",
                      }}>
                        {txMessage}
                      </div>
                    )}
                  </div>
                )}

                <VaultAuditLog vaultId={vault.id} />
                <VaultGovernancePanel vaultId={vault.id} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
