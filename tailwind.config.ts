import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Each colour points at a semantic CSS variable (src/app/globals.css),
      // so every theme gets the right value without a Tailwind rebuild.
      colors: {
        "zn-bg":      "var(--color-surface-base)",
        "zn-raised":  "var(--color-surface-raised)",
        "zn-surface": "var(--color-surface-elevated)",
        "zn-overlay": "var(--color-surface-overlay)",
        "zn-call":    "var(--color-option-call)",
        "zn-put":     "var(--color-option-put)",
        "zn-atm":     "var(--color-option-atm)",
        "zn-brand":   "var(--color-brand)",
        "zn-warning": "var(--color-warning)",
        "zn-pnl-pos": "var(--color-pnl-positive)",
        "zn-pnl-neg": "var(--color-pnl-negative)",
        "zn-hi":      "var(--color-text-primary)",
        "zn-mid":     "var(--color-text-secondary)",
        "zn-lo":      "var(--color-text-tertiary)",
        "zn-heat-lo": "var(--color-heat-seq-lo)",
        "zn-heat-hi": "var(--color-heat-seq-hi)",
        "zn-heat-neg":"var(--color-heat-div-lo)",
        "zn-heat-pos":"var(--color-heat-div-hi)",
      },
      fontFamily: {
        serif: ["Fraunces", "Georgia", "serif"],
        sans: ["IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
