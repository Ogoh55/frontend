"use client";

import { useState } from "react";
import {
  STRATEGY_TEMPLATES, isMultiExpiryTemplate,
  type StrategyOutlook, type StrategyRisk, type StrategyTemplate, type StrategyVolView,
} from "../lib/strategies";

interface Props {
  selectedId: string | null;
  onSelect: (template: StrategyTemplate) => void;
}

const OUTLOOK_COLOR: Record<StrategyOutlook, string> = {
  bullish: "var(--call)",
  bearish: "var(--put)",
  neutral: "var(--text-mid)",
  volatile: "var(--atm)",
};

const VOL_LABEL = { long: "Long vol", short: "Short vol", neutral: "Vol neutral" } as const;

export function Badge({ children, color, bg }: { children: React.ReactNode; color: string; bg?: string }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 600, padding: "2px 6px", textTransform: "uppercase", letterSpacing: "0.06em",
      color, background: bg ?? "var(--bg-overlay)", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

interface BadgeProps {
  outlook?: StrategyOutlook;
  volView?: StrategyVolView;
  risk: StrategyRisk;
  multiExpiry?: boolean;
}

export function StrategyBadges({ outlook, volView, risk, multiExpiry }: BadgeProps) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {outlook && <Badge color={OUTLOOK_COLOR[outlook]}>{outlook}</Badge>}
      {volView && <Badge color="var(--brand)">{VOL_LABEL[volView]}</Badge>}
      {risk === "defined"
        ? <Badge color="var(--call)" bg="var(--call-dim)">Defined risk</Badge>
        : <Badge color="var(--put)" bg="var(--put-dim)">⚠ Undefined risk</Badge>}
      {multiExpiry && <Badge color="var(--text-mid)">Multi-expiry</Badge>}
    </div>
  );
}

const FILTERS: Array<StrategyOutlook | "all"> = ["all", "bullish", "bearish", "neutral", "volatile"];

export function StrategyPicker({ selectedId, onSelect }: Props) {
  const [filter, setFilter] = useState<StrategyOutlook | "all">("all");
  const templates = filter === "all" ? STRATEGY_TEMPLATES : STRATEGY_TEMPLATES.filter(t => t.outlook === filter);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <div role="group" aria-label="Filter strategies by outlook" style={{ display: "flex", gap: 2, marginBottom: 8, flexWrap: "wrap" }}>
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f} style={{
            padding: "3px 8px", border: "none", cursor: "pointer", fontSize: 10, textTransform: "capitalize",
            background: filter === f ? "var(--atm-dim)" : "transparent",
            color: filter === f ? "var(--atm)" : "var(--text-lo)",
          }}>{f}</button>
        ))}
      </div>
      {templates.map(t => (
        <button key={t.id} onClick={() => onSelect(t)} aria-pressed={selectedId === t.id} style={{
          textAlign: "left", padding: "12px 14px", border: "1px solid var(--border-default)",
          background: selectedId === t.id ? "var(--bg-overlay)" : "var(--bg-raised)",
          cursor: "pointer",
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)", marginBottom: 6 }}>{t.name}</div>
          <StrategyBadges outlook={t.outlook} volView={t.volView} risk={t.risk} multiExpiry={isMultiExpiryTemplate(t)} />
          <div style={{ fontSize: 11, color: "var(--text-mid)", lineHeight: 1.5, marginTop: 6 }}>{t.description}</div>
          <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 6 }}>
            {t.legs.length} legs{t.legs.some(l => (l.ratio ?? 1) > 1) ? " · ratio" : ""}
          </div>
        </button>
      ))}
    </div>
  );
}
