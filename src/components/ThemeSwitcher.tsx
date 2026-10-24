"use client";

import { useEffect, useState } from "react";
import {
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  applyTheme,
  resolveTheme,
  type ThemeChoice,
} from "../lib/theme";

const LABELS: Record<ThemeChoice, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
  "high-contrast": "High contrast",
  colorblind: "Colorblind-safe",
};

export function ThemeSwitcher() {
  // Read storage after mount so the server render and first client render match.
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    setChoice(THEME_CHOICES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : "system");
  }, []);

  // Follow OS changes while the choice is "system".
  useEffect(() => {
    if (choice !== "system") return;
    const queries = ["(prefers-color-scheme: light)", "(prefers-contrast: more)"].map(q => window.matchMedia(q));
    const onChange = () => applyTheme(resolveTheme(null));
    queries.forEach(q => q.addEventListener("change", onChange));
    return () => queries.forEach(q => q.removeEventListener("change", onChange));
  }, [choice]);

  const onChange = (next: ThemeChoice) => {
    setChoice(next);
    if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(resolveTheme(next === "system" ? null : next));
  };

  return (
    <select
      aria-label="Colour theme"
      value={choice}
      onChange={e => onChange(e.target.value as ThemeChoice)}
      style={{
        background: "var(--bg-elevated)", color: "var(--text-hi)",
        border: "1px solid var(--border-default)", borderRadius: 4,
        fontSize: 11, padding: "2px 4px",
      }}
    >
      {THEME_CHOICES.map(c => (
        <option key={c} value={c}>{LABELS[c]}</option>
      ))}
    </select>
  );
}
