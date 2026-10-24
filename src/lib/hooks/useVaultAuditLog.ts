/**
 * useVaultAuditLog — Issue #243
 *
 * React hook that loads and live-refreshes the vault audit log, verifies
 * the hash chain, and exposes helpers for appending new privileged entries.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAuditLog,
  appendAuditEntry,
  verifyChain,
  type AuditEntry,
  type AuditActionType,
  type AuditDiff,
  type TamperResult,
} from "../api/vaultAudit";

export interface UseVaultAuditLogState {
  entries: AuditEntry[];
  loading: boolean;
  error: string | null;
  /** Result of the most-recent hash-chain verification. */
  tamperResult: TamperResult | null;
  /** True while a chain verification is running asynchronously. */
  verifying: boolean;
  /** Reload the log from the server / mock store. */
  refetch: () => void;
  /**
   * Append a new privileged-action entry, requiring the actor to supply
   * a non-empty justification. Returns the sealed entry on success.
   */
  recordAction: (
    input: Omit<AuditEntry, "id" | "chainHash" | "previousHash" | "timestamp">
  ) => Promise<AuditEntry>;
}

/**
 * @param vaultId  The vault to load the audit log for. Passing `null` disables
 *                 the query (status "idle").
 * @param pollMs   Optional polling interval in ms (default: no poll).
 */
export function useVaultAuditLog(
  vaultId: string | null,
  pollMs?: number
): UseVaultAuditLogState {
  const [entries, setEntries]           = useState<AuditEntry[]>([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [tamperResult, setTamperResult] = useState<TamperResult | null>(null);
  const [verifying, setVerifying]       = useState(false);

  const vaultIdRef = useRef(vaultId);
  vaultIdRef.current = vaultId;

  const load = useCallback(async () => {
    if (!vaultIdRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAuditLog(vaultIdRef.current);
      setEntries(data);
      // Verify integrity asynchronously so the UI isn't blocked.
      setVerifying(true);
      verifyChain(data)
        .then(result => {
          setTamperResult(result);
          setVerifying(false);
        })
        .catch(() => setVerifying(false));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!vaultId) return;
    load();
    if (!pollMs) return;
    const timer = setInterval(load, pollMs);
    return () => clearInterval(timer);
  }, [vaultId, load, pollMs]);

  const recordAction = useCallback(
    async (
      input: Omit<AuditEntry, "id" | "chainHash" | "previousHash" | "timestamp">
    ): Promise<AuditEntry> => {
      if (!input.justification.trim()) {
        throw new Error("A justification is required for every privileged vault action.");
      }
      const entry = await appendAuditEntry(input);
      // Optimistically append to the local list and re-verify.
      setEntries(prev => {
        const updated = [...prev, entry];
        verifyChain(updated)
          .then(setTamperResult)
          .catch(() => {});
        return updated;
      });
      return entry;
    },
    []
  );

  return {
    entries,
    loading,
    error,
    tamperResult,
    verifying,
    refetch: load,
    recordAction,
  };
}
