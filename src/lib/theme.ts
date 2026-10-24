// Theme selection for the token system in src/app/globals.css.
//
// The choice is stored in localStorage under THEME_STORAGE_KEY. "system"
// (or no stored choice) resolves from prefers-contrast and
// prefers-color-scheme. THEME_INIT_SCRIPT is inlined in the root layout so
// <html data-theme> is set before first paint.

export const THEME_STORAGE_KEY = "zn-theme";

export const THEME_CHOICES = ["system", "dark", "light", "high-contrast", "colorblind"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type ResolvedTheme = Exclude<ThemeChoice, "system">;

const RESOLVED_THEMES: ResolvedTheme[] = ["dark", "light", "high-contrast", "colorblind"];

export function resolveTheme(choice: string | null): ResolvedTheme {
  if (choice && (RESOLVED_THEMES as string[]).includes(choice)) return choice as ResolvedTheme;
  if (typeof window === "undefined") return "dark";
  if (window.matchMedia("(prefers-contrast: more)").matches) return "high-contrast";
  if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}

export function applyTheme(theme: ResolvedTheme) {
  document.documentElement.dataset.theme = theme;
}

// Mirrors resolveTheme(). Keep the two in sync: this runs before any module
// loads, so it cannot import from this file. Plain ES5 so it works on old
// browsers and is safe to inline.
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var ok=${JSON.stringify(RESOLVED_THEMES)};if(ok.indexOf(t)<0){t=matchMedia("(prefers-contrast: more)").matches?"high-contrast":matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="dark";}})();`;
