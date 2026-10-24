"use client";

import { useState } from "react";
import { useBackendData } from "../lib/context/BackendDataContext";
import { useWalletStore } from "../lib/store/wallet";

interface Props {
  sym: string;
}

/**
 * Watchlist (favorites) toggle. A labelled toggle button: the label stays
 * constant and `aria-pressed` carries the state, per the APG toggle button
 * pattern. Disabled (40% opacity) without a connected wallet and while a
 * change is in flight.
 */
export function StarButton({ sym }: Props) {
  const address = useWalletStore(s => s.address);
  const { watchlist, addToWatchlist, removeFromWatchlist } = useBackendData();
  const [pending, setPending] = useState(false);

  const starred = watchlist.some(w => w.underlying === sym);
  const disabled = !address || pending;

  const toggle = async () => {
    setPending(true);
    try {
      if (starred) await removeFromWatchlist(sym);
      else await addToWatchlist(sym);
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      aria-label={`Watch ${sym}`}
      aria-pressed={starred}
      style={{
        padding: "4px 6px 4px 2px", border: "none", background: "none", cursor: disabled ? "default" : "pointer",
        fontSize: 12, lineHeight: 1, opacity: disabled ? 0.4 : 1,
        color: starred ? "var(--atm)" : "var(--text-lo)",
      }}
    >
      <span aria-hidden="true">{starred ? "★" : "☆"}</span>
    </button>
  );
}
