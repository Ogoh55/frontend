import type { Page, Request } from "@playwright/test";
import { API_URLS } from "./urls";

type Mode = keyof typeof API_URLS;

export interface MockOptions {
  /** Seed a signed-in session for these modes (token = "<mode>-token"). */
  signedIn?: Mode[];
  /** Make every backend call fail with 500. */
  fail?: boolean;
  /** Delay every response (ms) — for observing loading states. */
  delayMs?: number;
  positions?: unknown[];
  /** Vault-written supply summary keyed by (underlying, expiry, strike). */
  vaultSupply?: unknown;
  /** Make the vault supply endpoint fail with 500 (source unavailable). */
  vaultSupplyUnavailable?: boolean;
}

export interface MockBackend {
  requests: { mode: Mode; method: string; path: string; auth: string | null }[];
  opened: unknown[];
}

const SPOT: Record<string, number> = { XLM: 0.1182, BTC: 67420.5, ETH: 3512.8, SOL: 182.45 };

function normCdf(x: number) {
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = k * (0.31938153 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  return x >= 0 ? 1 - pdf * p : pdf * p;
}

function price(S: number, K: number, t: number, call: boolean) {
  const vol = 0.8, st = Math.sqrt(t);
  const d1 = (Math.log(S / K) + (0.05 + 0.5 * vol * vol) * t) / (vol * st);
  const d2 = d1 - vol * st;
  const premium = call ? S * normCdf(d1) - K * Math.exp(-0.05 * t) * normCdf(d2) : K * Math.exp(-0.05 * t) * normCdf(-d2) - S * normCdf(-d1);
  const delta = call ? normCdf(d1) : normCdf(d1) - 1;
  return { premium: Math.max(0, premium), delta, gamma: 0.01, theta: -0.001, vega: 0.02, rho: 0, d1, d2, intrinsic: 0, time_value: 0, iv: vol };
}

function chain(sym: string, days: number) {
  const S = SPOT[sym] ?? 1;
  return Array.from({ length: 21 }, (_, i) => {
    const K = Math.round(S * (1 + (i - 10) * 0.04) * 10000) / 10000;
    return { strike: K, expiry_days: days, call: price(S, K, days / 365, true), put: price(S, K, days / 365, false), is_itm_call: S > K, is_itm_put: S < K };
  });
}

/**
 * Deterministic vault supply summary for the mocked chain: a handful of strikes
 * near the money carry vault-written OI so the annotation/filter/overlay have
 * something real to render. Shape mirrors the aggregated supply endpoint.
 */
function vaultSupply(sym: string, days: number) {
  const S = SPOT[sym] ?? 1;
  const rows = [
    { offset: -2, option_type: "call", vault_oi: 120, total_oi: 400 },
    { offset: 0, option_type: "call", vault_oi: 85, total_oi: 250 },
    { offset: 1, option_type: "put", vault_oi: 60, total_oi: 300 },
    { offset: 3, option_type: "put", vault_oi: 40, total_oi: 160 },
  ];
  return {
    underlying: sym,
    expiry_days: days,
    contracts: rows.map(r => {
      const strike = Math.round(S * (1 + r.offset * 0.04) * 10000) / 10000;
      return {
        strike,
        expiry_days: days,
        option_type: r.option_type,
        vault_oi: r.vault_oi,
        total_oi: r.total_oi,
        vault_share: r.total_oi > 0 ? r.vault_oi / r.total_oi : 0,
      };
    }),
  };
}

export const samplePosition = {
  id: "pos-1", wallet_address: "GTEST", underlying: "XLM", strike: 0.1229, expiry_days: 30, option_type: "call",
  position_type: "long", contracts: 2, entry_premium: 0.0092, entry_spot: 0.1182, collateral: 0, status: "open",
  close_premium: null, close_spot: null, realized_pnl: null, opened_at: "2026-09-01T10:00:00Z", closed_at: null, strategy_id: null,
};

/** Installs a fake Zenith backend for all three modes and (optionally) a signed-in session. */
export async function mockBackend(page: Page, opts: MockOptions = {}): Promise<MockBackend> {
  const state: MockBackend = { requests: [], opened: [] };
  const positions: unknown[] = [...(opts.positions ?? [])];

  for (const mode of opts.signedIn ?? []) {
    await page.addInitScript(([m]) => {
      if (!localStorage.getItem(`zenith:${m}:wallet`)) {
        localStorage.setItem(`zenith:${m}:wallet`, JSON.stringify({ state: { address: "GTEST", token: `${m}-token` }, version: 0 }));
      }
    }, [mode]);
  }

  for (const mode of Object.keys(API_URLS) as Mode[]) {
    await page.routeWebSocket(`${API_URLS[mode].replace("http", "ws")}/api/v1/ws/spot`, ws => {
      ws.send(JSON.stringify({ prices: SPOT, vols: { XLM: 0.82, BTC: 0.65, ETH: 0.72, SOL: 0.91 } }));
    });

    await page.route(`${API_URLS[mode]}/**`, async route => {
      const req: Request = route.request();
      const url = new URL(req.url());
      const auth = req.headers()["authorization"] ?? null;
      state.requests.push({ mode, method: req.method(), path: url.pathname, auth });
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

      if (req.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: {
          "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,DELETE",
        } });
      }
      if (opts.fail) return json({ error: "backend exploded" }, 500);

      const p = url.pathname.replace("/api/v1", "");
      if (p === "/chain") return json(chain(url.searchParams.get("underlying") ?? "XLM", Number(url.searchParams.get("expiry_days") ?? 30)));
      if (p.startsWith("/expiries/")) return json({ underlying: "XLM", spot: 0.1182, vol: 0.82, expiries: [7, 14, 30, 60, 90, 180].map(d => ({ days_to_expiry: d, label: `${d}D`, timestamp: 0 })) });
      if (p === "/spot") return json({ prices: SPOT, vols: {} });
      if (p === "/vaults/supply") {
        if (opts.vaultSupplyUnavailable) return json({ error: "vault supply unavailable" }, 503);
        if (opts.vaultSupply !== undefined) return json(opts.vaultSupply);
        return json(vaultSupply(url.searchParams.get("underlying") ?? "XLM", Number(url.searchParams.get("expiry_days") ?? 30)));
      }

      // Everything below is authed — tokens are per mode.
      if (auth !== `Bearer ${mode}-token`) return json({ error: "unauthorized" }, 401);
      if (p === "/auth/me") return json({ wallet_address: "GTEST" });
      if (p === "/account") return json({ wallet_address: "GTEST", balance: 10000, collateral_locked: 0, created_at: "2026-09-01T00:00:00Z" });
      if (p === "/positions" && req.method() === "GET") return json(positions);
      if (p === "/positions/open") {
        const body = req.postDataJSON();
        state.opened.push(body);
        const pos = { ...samplePosition, id: `pos-${positions.length + 2}`, underlying: body.underlying, strike: body.strike, option_type: body.option_type, position_type: body.position_type, contracts: body.contracts };
        positions.push(pos);
        return json(pos, 201);
      }
      if (p === "/portfolio/greeks") return json({ delta: 0.5, gamma: 0.01, theta: -0.002, vega: 0.03 });
      if (p === "/watchlist") return json([]);
      if (p === "/alerts") return json([]);
      if (p === "/history") return json({ trades: [], stats: { trade_count: 0, win_count: 0, loss_count: 0, total_realized_pnl: 0 } });
      return json({ error: `unmocked ${p}` }, 404);
    });
  }
  return state;
}

/** Skip the first-run tour prompt so it doesn't cover what a test is looking at. */
export async function skipOnboarding(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("zenith:onboarding")) {
      localStorage.setItem("zenith:onboarding", JSON.stringify({ state: { tourStatus: "skipped", tourStep: 0, practice: false }, version: 0 }));
    }
  });
}

/** Navigate and wait until React has hydrated, so interactions aren't lost. */
export async function goto(page: Page, path: string) {
  await page.goto(path);
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
}
