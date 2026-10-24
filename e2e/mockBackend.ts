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
  /** Vault fixtures — override the defaults for capacity/waitlist/epoch states. */
  vaults?: unknown[];
  vaultDetail?: Record<string, unknown>;
  epochLedger?: unknown[];
  /** Force a specific vault route to fail with the given status/body. */
  vaultErrors?: Record<string, { status: number; body: unknown }>;
}

export interface MockBackend {
  requests: { mode: Mode; method: string; path: string; auth: string | null }[];
  opened: unknown[];
  deposits: unknown[];
  withdrawals: unknown[];
  redemptions: unknown[];
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

export const samplePosition = {
  id: "pos-1", wallet_address: "GTEST", underlying: "XLM", strike: 0.1229, expiry_days: 30, option_type: "call",
  position_type: "long", contracts: 2, entry_premium: 0.0092, entry_spot: 0.1182, collateral: 0, status: "open",
  close_premium: null, close_spot: null, realized_pnl: null, opened_at: "2026-09-01T10:00:00Z", closed_at: null, strategy_id: null,
};

/** Default vault list fixture — derived from the frozen REST contract. */
export const sampleVaults = [
  { id: "vault-xlm-1", name: "XLM Covered Call", asset: "XLM", status: "open", capacity: 100000, total_deposits: 42000, apy: 0.124, share_price: 1.042, epoch: 12, epoch_ends_at: "2026-10-01T00:00:00Z" },
  { id: "vault-btc-1", name: "BTC Put Seller", asset: "BTC", status: "waitlist", capacity: 50000, total_deposits: 50000, apy: 0.081, share_price: 1.011, epoch: 4, epoch_ends_at: "2026-10-02T00:00:00Z" },
  { id: "vault-eth-1", name: "ETH Straddle", asset: "ETH", status: "closed", capacity: 80000, total_deposits: 12000, apy: 0.153, share_price: 0.998, epoch: 7, epoch_ends_at: "2026-09-28T00:00:00Z" },
];

export const sampleVaultDetail = {
  ...sampleVaults[0],
  description: "Sells covered calls on XLM to earn premium.",
  min_deposit: 10,
  lockup_days: 7,
  share_price: 1.042,
  pending_withdrawals: 0,
};

export const sampleEpochLedger = [
  { epoch: 12, started_at: "2026-09-24T00:00:00Z", ended_at: null, deposits: 42000, withdrawals: 0, share_price: 1.042, status: "active" },
  { epoch: 11, started_at: "2026-09-17T00:00:00Z", ended_at: "2026-09-24T00:00:00Z", deposits: 38000, withdrawals: 2000, share_price: 1.031, status: "settled" },
];

/** Installs a fake Zenith backend for all three modes and (optionally) a signed-in session. */
export async function mockBackend(page: Page, opts: MockOptions = {}): Promise<MockBackend> {
  const state: MockBackend = { requests: [], opened: [], deposits: [], withdrawals: [], redemptions: [] };
  const positions: unknown[] = [...(opts.positions ?? [])];
  const vaults: unknown[] = [...(opts.vaults ?? sampleVaults)];
  const epochLedger: unknown[] = [...(opts.epochLedger ?? sampleEpochLedger)];

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

      // Vault routes — derived from the frozen REST contract.
      const vaultErr = opts.vaultErrors?.[p];
      if (vaultErr) return json(vaultErr.body, vaultErr.status);
      if (p === "/vaults" && req.method() === "GET") return json(vaults);
      if (p === "/vaults/deposit" && req.method() === "POST") {
        const body = req.postDataJSON();
        state.deposits.push(body);
        const shares = Number(body.amount) / 1.042;
        return json({ id: `dep-${state.deposits.length}`, vault_id: body.vault_id, amount: body.amount, shares, share_price: 1.042, status: "confirmed" }, 201);
      }
      if (p === "/vaults/withdraw" && req.method() === "POST") {
        const body = req.postDataJSON();
        state.withdrawals.push(body);
        return json({ id: `wd-${state.withdrawals.length}`, vault_id: body.vault_id, shares: body.shares, status: "queued", epoch: 12, queued_at: "2026-09-25T00:00:00Z" }, 202);
      }
      if (p === "/vaults/redeem" && req.method() === "POST") {
        const body = req.postDataJSON();
        state.redemptions.push(body);
        return json({ id: `rd-${state.redemptions.length}`, vault_id: body.vault_id, shares: body.shares, amount: Number(body.shares) * 1.042, status: "redeemed" }, 200);
      }
      if (p === "/vaults/epochs" && req.method() === "GET") return json(epochLedger);
      const detailMatch = p.match(/^\/vaults\/([^/]+)$/);
      if (detailMatch && req.method() === "GET") {
        const id = decodeURIComponent(detailMatch[1]);
        const found = (vaults as { id: string }[]).find(v => v.id === id);
        if (!found) return json({ error: "vault not found" }, 404);
        return json(opts.vaultDetail ?? { ...sampleVaultDetail, ...found });
      }
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
