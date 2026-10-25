/**
 * @module vaultWalletAdapter
 *
 * Multi-wallet signing adapter for vault transactions (issue #252).
 *
 * Abstracts the wallet signing path behind a single `VaultWalletAdapter`
 * interface so vault flows (both the margin-collateral vault in `vault.ts`
 * and the Phase 2 options vaults in `vaults.ts`) can work with any connected
 * wallet without caring about the underlying SDK.
 *
 * Supported wallets:
 *   • Freighter  — browser extension; signs via `@stellar/freighter-api`
 *   • xBull      — browser extension; signs via `@creit.tech/stellar-wallets-kit`
 *   • WalletConnect — mobile / remote; signs via `@creit.tech/stellar-wallets-kit`
 *   • Ledger     — hardware; signs via `@creit.tech/stellar-wallets-kit`
 *
 * Usage:
 *   const adapter = createFreighterAdapter(address, networkPassphrase);
 *   const signedXdr = await adapter.signTransaction(unsignedXdr);
 *
 * The `WalletSigner` interface from `src/lib/soroban/types.ts` is the
 * canonical extension point for the governance pipeline. `VaultWalletAdapter`
 * is a narrower, vault-specific surface that maps onto it.
 *
 * Ledger note: Ledger signing is synchronous from the app's perspective
 * (the kit handles the device handshake internally), but it can be slow.
 * The vault UI should surface a "Confirm on device" banner while awaiting.
 */

import type { WalletSigner } from "../soroban/types";

// ---------------------------------------------------------------------------
// Wallet type enum
// ---------------------------------------------------------------------------

export type VaultWalletType = "freighter" | "xbull" | "walletconnect" | "ledger";

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * Minimal signing surface consumed by the vault transaction builders.
 *
 * This is intentionally narrower than `WalletSigner`: vault flows only need
 * `signTransaction` and the signer's address; message signing is handled by
 * the sign-in layer, not the vault layer.
 */
export interface VaultWalletAdapter {
  /** Which wallet this adapter wraps. */
  readonly walletType: VaultWalletType;
  /** Stellar public key (G…) of the connected account. */
  readonly address: string;
  /** Network passphrase (needed by some wallets to scope the signature). */
  readonly networkPassphrase: string;
  /**
   * Sign a Soroban transaction XDR. Returns the signed XDR.
   *
   * Implementations MUST:
   *   - Return the signed XDR with exactly one new signature appended.
   *   - NOT modify the transaction structure in any other way.
   *   - Throw a `WalletSigningError` on user rejection or device failure.
   */
  signTransaction(xdr: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when the user rejects a signing request or the wallet/device
 * returns an error. `walletType` lets callers show a wallet-specific message.
 */
export class WalletSigningError extends Error {
  readonly walletType: VaultWalletType;
  readonly cause: unknown;

  constructor(walletType: VaultWalletType, message: string, cause?: unknown) {
    super(message);
    this.name = "WalletSigningError";
    this.walletType = walletType;
    this.cause = cause;
  }
}

/**
 * Thrown when `createAdapterFromSigner` receives a `WalletSigner` whose
 * wallet type cannot be determined. In practice this means the signer was
 * constructed outside the factory and lacks the `__walletType` tag.
 */
export class UnknownWalletTypeError extends Error {
  constructor() {
    super(
      "Cannot determine wallet type from WalletSigner. Use a factory function " +
        "(createFreighterAdapter, createXBullAdapter, etc.) to build adapters."
    );
    this.name = "UnknownWalletTypeError";
  }
}

// ---------------------------------------------------------------------------
// Freighter adapter
// ---------------------------------------------------------------------------

/**
 * Creates a VaultWalletAdapter backed by Freighter (`@stellar/freighter-api`).
 *
 * Freighter must be installed and the user must have already granted permission
 * to this origin. The adapter throws a `WalletSigningError` when the user
 * rejects the signing request or when Freighter is not available.
 */
export function createFreighterAdapter(
  address: string,
  networkPassphrase: string
): VaultWalletAdapter {
  return {
    walletType: "freighter",
    address,
    networkPassphrase,
    async signTransaction(xdr: string): Promise<string> {
      // Dynamic import keeps the Freighter SDK out of bundles that never use it.
      const freighterApi = await import("@stellar/freighter-api").then(
        (m) => m.default ?? m
      );
      try {
        const signed = await freighterApi.signTransaction(xdr, {
          accountToSign: address,
        });
        // freighterApi.signTransaction returns the signed XDR string directly.
        if (typeof signed !== "string" || !signed) {
          throw new WalletSigningError(
            "freighter",
            "Freighter returned an empty or invalid signed XDR."
          );
        }
        return signed;
      } catch (err) {
        if (err instanceof WalletSigningError) throw err;
        const msg =
          err instanceof Error ? err.message : "Freighter signing failed.";
        // Freighter rejection messages include "User declined" — surface that
        // so the UI can show a friendly "You rejected the request" message.
        throw new WalletSigningError("freighter", msg, err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// StellarWalletsKit-backed adapters (xBull, WalletConnect, Ledger)
// ---------------------------------------------------------------------------

/**
 * Internal factory: creates a VaultWalletAdapter using `@creit.tech/stellar-wallets-kit`
 * with the specified wallet module ID already set.
 *
 * The kit must already have been initialised with the correct wallet module
 * (`kit.setWallet(walletId)`) before transactions can be signed. The factory
 * calls `setWallet` internally so callers do not need to manage that step.
 */
async function createKitAdapter(
  walletType: VaultWalletType,
  kitWalletId: string,
  address: string,
  networkPassphrase: string
): Promise<VaultWalletAdapter> {
  // Dynamic import: stellar-wallets-kit is only loaded when actually needed.
  const kit = await import("@creit.tech/stellar-wallets-kit").then(
    (m) => m.StellarWalletsKit ?? m.default?.StellarWalletsKit
  );

  if (!kit) {
    throw new WalletSigningError(
      walletType,
      "@creit.tech/stellar-wallets-kit is not available. Make sure it is installed."
    );
  }

  // Activate the correct wallet module in the kit instance.
  // `setWallet` is synchronous in the kit; it only changes the active slot.
  if (typeof kit.setWallet === "function") {
    kit.setWallet(kitWalletId);
  }

  return {
    walletType,
    address,
    networkPassphrase,
    async signTransaction(xdr: string): Promise<string> {
      try {
        const result = await kit.signTransaction(xdr, {
          address,
          networkPassphrase,
        });
        // Kit returns { signedTxXdr: string } or the XDR string directly.
        const signed =
          typeof result === "string"
            ? result
            : (result as { signedTxXdr?: string }).signedTxXdr;

        if (typeof signed !== "string" || !signed) {
          throw new WalletSigningError(
            walletType,
            `${walletType} returned an empty or invalid signed XDR.`
          );
        }
        return signed;
      } catch (err) {
        if (err instanceof WalletSigningError) throw err;
        const msg =
          err instanceof Error
            ? err.message
            : `${walletType} signing failed.`;
        throw new WalletSigningError(walletType, msg, err);
      }
    },
  };
}

/**
 * Creates a VaultWalletAdapter backed by xBull.
 *
 * xBull must be installed as a browser extension. The kit's `xBullModule`
 * handles the cross-origin signing handshake.
 */
export async function createXBullAdapter(
  address: string,
  networkPassphrase: string
): Promise<VaultWalletAdapter> {
  const { XBULL_ID } = await import("@creit.tech/stellar-wallets-kit");
  return createKitAdapter("xbull", XBULL_ID, address, networkPassphrase);
}

/**
 * Creates a VaultWalletAdapter backed by WalletConnect.
 *
 * WalletConnect requires a prior `connect()` call to establish the session.
 * This factory assumes the session is already established and a wallet address
 * has been resolved.
 */
export async function createWalletConnectAdapter(
  address: string,
  networkPassphrase: string
): Promise<VaultWalletAdapter> {
  // WalletConnect uses the generic kit interface; the kit's WalletConnect
  // module handles the session lifecycle. The wallet ID varies by kit version —
  // use the string literal "wallet_connect" as the canonical slot identifier.
  return createKitAdapter(
    "walletconnect",
    "wallet_connect",
    address,
    networkPassphrase
  );
}

/**
 * Creates a VaultWalletAdapter backed by a Ledger hardware wallet.
 *
 * The kit's Ledger module communicates with the device over WebUSB/WebHID.
 * The device must be unlocked, have the Stellar app open, and be connected
 * before `signTransaction` is called.
 *
 * Because device interactions can be slow (user must confirm on the device),
 * the UI should display a "Confirm on your Ledger" prompt before awaiting
 * this adapter's `signTransaction` call.
 */
export async function createLedgerAdapter(
  address: string,
  networkPassphrase: string
): Promise<VaultWalletAdapter> {
  // Ledger uses the generic kit interface; the kit's Ledger module handles
  // the WebUSB/WebHID transport and the Stellar app protocol.
  return createKitAdapter(
    "ledger",
    "ledger",
    address,
    networkPassphrase
  );
}

// ---------------------------------------------------------------------------
// Bridge: WalletSigner → VaultWalletAdapter
// ---------------------------------------------------------------------------

/**
 * Wraps an existing `WalletSigner` (from the Soroban governance pipeline) in
 * a `VaultWalletAdapter`. This lets vault flows reuse a signer that was
 * already constructed for governance transactions without re-prompting the
 * user to connect.
 *
 * The `walletType` falls back to `"freighter"` when the signer was not built
 * by one of the kit factories — this is safe because Freighter is the only
 * wallet currently wired into the governance pipeline.
 */
export function createAdapterFromSigner(
  signer: WalletSigner
): VaultWalletAdapter {
  // Tag injected by the kit factories; absent for hand-constructed signers.
  const walletType: VaultWalletType =
    (signer as { __walletType?: VaultWalletType }).__walletType ?? "freighter";

  return {
    walletType,
    address: signer.address,
    networkPassphrase: signer.networkPassphrase,
    signTransaction: (xdr: string) => signer.signTransaction(xdr),
  };
}

// ---------------------------------------------------------------------------
// Human-readable wallet labels (for UI display)
// ---------------------------------------------------------------------------

export const WALLET_LABELS: Record<VaultWalletType, string> = {
  freighter: "Freighter",
  xbull: "xBull",
  walletconnect: "WalletConnect",
  ledger: "Ledger",
};

/**
 * Returns true when the connected wallet requires the user to confirm on a
 * physical device (i.e. Ledger). The vault UI uses this to show a "Confirm on
 * device" banner while awaiting the signature.
 */
export function requiresDeviceConfirmation(
  walletType: VaultWalletType
): boolean {
  return walletType === "ledger";
}
