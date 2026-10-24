/**
 * Wallet store — the single persisted zustand store.
 *
 * Persists only the bearer token + expiry to localStorage so the session
 * survives a page refresh. Uses `skipHydration: true` + `StoreHydrator` to
 * avoid reading localStorage on the server or before mount (hydration safety).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface WalletState {
  /** Connected Stellar wallet address (null when not connected). */
  address: string | null;
  /** Bearer token from backend /auth/verify. Null when not signed in. */
  token: string | null;
  /** Unix timestamp (ms) when the token expires. */
  tokenExpiresAt: number | null;
  /** Set to true by the WS session-sync handler when the backend invalidates the session. */
  sessionExpired: boolean;

  // ── Actions ────────────────────────────────────────────────────────────────
  setAddress: (address: string | null) => void;
  setToken: (token: string | null, expiresAt: number | null) => void;
  clearSession: () => void;
  /** Trigger a re-authentication flow (sets sessionExpired to prompt the UI). */
  reauthenticate: () => void;
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set) => ({
      address: null,
      token: null,
      tokenExpiresAt: null,
      sessionExpired: false,

      setAddress: (address) => set({ address }),
      setToken: (token, tokenExpiresAt) =>
        set({ token, tokenExpiresAt, sessionExpired: false }),
      clearSession: () =>
        set({ token: null, tokenExpiresAt: null, sessionExpired: false }),
      reauthenticate: () => set({ sessionExpired: true }),
    }),
    {
      name: 'zenith.wallet.v1',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' ? localStorage : ({
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        } as Storage),
      ),
      // Only persist the token fields — address is re-read from Freighter on mount.
      partialize: (s) => ({
        token: s.token,
        tokenExpiresAt: s.tokenExpiresAt,
        address: s.address,
      }),
      // Manual hydration from StoreHydrator prevents reading localStorage
      // before the component tree has mounted (SSR safety).
      skipHydration: true,
    },
  ),
);

/**
 * Selector for the currently connected account address.
 *
 * Vault transaction history is scoped per-account; consumers should read the
 * address through this selector so the history surface re-renders when the
 * connected wallet changes (e.g. account switch or disconnect).
 */
export const selectAccountAddress = (s: WalletState): string | null => s.address;
