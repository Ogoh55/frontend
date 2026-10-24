"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { useBackendData } from "../lib/context/BackendDataContext";
import { fmtN } from "../lib/pricing";

const TABS = [
  { label: "Chain", href: "/options" },
  { label: "Portfolio", href: "/portfolio" },
  { label: "History", href: "/history" },
  { label: "Contracts", href: "/contracts" },
];

export function AppHeader({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();
  // BackendDataProvider already handles the hydration-safety gating
  // (null token pre-hydration) — this just reads its shared result.
  const { account } = useBackendData();
  const balance = account?.balance ?? 0;
  const collateralLocked = account?.collateral_locked ?? 0;

  return (
    <header style={{
      height: 44, flexShrink: 0, display: "flex", alignItems: "center",
      borderBottom: "1px solid var(--border-default)", padding: "0 16px", gap: 16,
      background: "var(--bg-raised)",
    }}>
      <Link href="/" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}>
        <Logo size={16} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-hi)", fontFamily: "var(--font-serif)" }}>Zenith</span>
      </Link>
      <div style={{ width: 1, height: 20, background: "var(--border-default)" }} />
      <div style={{ display: "flex", gap: 2 }}>
        {TABS.map(tab => (
          <Link key={tab.href} href={tab.href} style={{
            padding: "4px 10px", border: "none", cursor: "pointer",
            fontSize: 12, fontWeight: 600, textDecoration: "none",
            color: pathname?.startsWith(tab.href) ? "var(--text-hi)" : "var(--text-mid)",
            borderBottom: pathname?.startsWith(tab.href) ? "2px solid var(--brand)" : "2px solid transparent",
          }}>
            {tab.label}
          </Link>
        ))}
      </div>
      <div style={{ width: 1, height: 20, background: "var(--border-default)" }} />

      <Link href="/portfolio" title="Go to portfolio" style={{
        display: "flex", alignItems: "center", gap: 6, textDecoration: "none",
      }}>
        <span style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Balance</span>
        <span className="num" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>${fmtN(balance,2)}</span>
        {collateralLocked > 0 && (
          <span className="num" style={{ fontSize: 10, color: "var(--atm)" }}>(${fmtN(collateralLocked,2)} locked)</span>
        )}
      </Link>
      <div style={{ width: 1, height: 20, background: "var(--border-default)" }} />

      <ThemeSwitcher />

      {children}
    </header>
  );
}
