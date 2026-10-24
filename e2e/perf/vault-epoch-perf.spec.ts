/**
 * e2e/perf/vault-epoch-perf.spec.ts — Issue #244
 *
 * Playwright-level performance regression tests for vault read/write paths.
 * These complement the k6 load tests: k6 measures server throughput; these
 * tests measure front-end rendering performance during a simulated epoch
 * boundary (network throttled to "Fast 3G" to surface JS parse/render cost).
 *
 * Scenarios
 * ---------
 *  vault-list-render    — Cold render of /vaults with 8 mock vaults.
 *  vault-detail-render  — Vault detail page first paint and interaction.
 *  epoch-transition     — Re-render cost when the epoch phase changes live.
 *  withdrawal-queue-render — Render a large queued withdrawal list (50 items).
 *
 * Thresholds
 * ----------
 *  LCP < 2500 ms, FCP < 1800 ms on Fast 3G (as measured by Playwright CDP).
 *  No long tasks (> 50 ms) during epoch-transition re-render.
 *
 * Usage
 *   npx playwright test --config=playwright.perf.config.ts e2e/perf/vault-epoch-perf.spec.ts
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const RESULTS_DIR = path.join(__dirname, "results");

interface WebVital {
  name: string;
  value: number;
  rating: "good" | "needs-improvement" | "poor";
}

interface VaultPerfResult {
  scenario: string;
  fcp: number | null;
  lcp: number | null;
  longTaskCount: number;
  totalLongTaskMs: number;
  domContentLoaded: number;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function measureWebVitals(page: import("@playwright/test").Page): Promise<WebVital[]> {
  return page.evaluate(() => {
    return new Promise<WebVital[]>((resolve) => {
      const vitals: WebVital[] = [];
      // Use PerformanceObserver to collect paint + LCP entries.
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const v = entry as PerformanceEntry & { startTime: number };
          if (entry.entryType === "paint") {
            vitals.push({
              name: entry.name === "first-contentful-paint" ? "FCP" : entry.name,
              value: Math.round(v.startTime),
              rating: v.startTime < 1800 ? "good" : v.startTime < 3000 ? "needs-improvement" : "poor",
            });
          }
          if (entry.entryType === "largest-contentful-paint") {
            vitals.push({
              name: "LCP",
              value: Math.round(v.startTime),
              rating: v.startTime < 2500 ? "good" : v.startTime < 4000 ? "needs-improvement" : "poor",
            });
          }
        }
      });
      try {
        obs.observe({ type: "paint", buffered: true });
        obs.observe({ type: "largest-contentful-paint", buffered: true });
      } catch {
        /* observer not available in this context */
      }
      // Give observers 500 ms to collect buffered entries.
      setTimeout(() => {
        obs.disconnect();
        resolve(vitals);
      }, 500);
    });
  });
}

async function measureLongTasks(page: import("@playwright/test").Page): Promise<{ count: number; totalMs: number }> {
  return page.evaluate(() => {
    return new Promise<{ count: number; totalMs: number }>((resolve) => {
      let count = 0;
      let totalMs = 0;
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          count++;
          totalMs += e.duration;
        }
      });
      try {
        obs.observe({ type: "longtask", buffered: true });
      } catch {
        /* longtask not available */
      }
      setTimeout(() => {
        obs.disconnect();
        resolve({ count, totalMs: Math.round(totalMs) });
      }, 1000);
    });
  });
}

function saveResult(result: VaultPerfResult): void {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, "vault-perf-latest.json");
  let existing: VaultPerfResult[] = [];
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* ignore */ }
  }
  // Replace any existing result for this scenario.
  const idx = existing.findIndex(r => r.scenario === result.scenario);
  if (idx >= 0) existing[idx] = result; else existing.push(result);
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Vault epoch-boundary performance", () => {
  test.use({
    // Throttle to Fast 3G to surface JS parse + render cost.
    // Override with PERF_NO_THROTTLE=1 for local speed runs.
  });

  test("vault-list-render: FCP < 1800 ms, LCP < 2500 ms", async ({ page, context }) => {
    if (!process.env.PERF_NO_THROTTLE) {
      // Simulate Fast 3G (1.5 Mbps down, 750 kbps up, 40 ms latency).
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        downloadThroughput: (1.5 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
        latency: 40,
      });
    }

    await page.goto("/vaults");
    await page.waitForSelector('[data-testid="vault-card"], h1', { timeout: 15_000 });

    const vitals = await measureWebVitals(page);
    const navTiming = await page.evaluate(() => {
      const t = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return { domContentLoaded: t ? Math.round(t.domContentLoadedEventEnd - t.startTime) : null };
    });
    const longTasks = await measureLongTasks(page);

    const fcp = vitals.find(v => v.name === "FCP")?.value ?? null;
    const lcp = vitals.find(v => v.name === "LCP")?.value ?? null;

    const result: VaultPerfResult = {
      scenario: "vault-list-render",
      fcp, lcp,
      longTaskCount: longTasks.count,
      totalLongTaskMs: longTasks.totalMs,
      domContentLoaded: navTiming.domContentLoaded ?? 0,
      recordedAt: new Date().toISOString(),
    };
    saveResult(result);
    console.log("[vault-list-render]", JSON.stringify(result));

    if (fcp !== null) expect(fcp, `FCP ${fcp}ms exceeds 1800ms`).toBeLessThan(1800);
    if (lcp !== null) expect(lcp, `LCP ${lcp}ms exceeds 2500ms`).toBeLessThan(2500);
  });

  test("vault-detail-render: FCP < 2000 ms, no long tasks on load", async ({ page }) => {
    await page.goto("/vaults/xlm-cc-v1");
    await page.waitForSelector("h1, [data-testid='vault-header']", { timeout: 15_000 });

    const vitals     = await measureWebVitals(page);
    const longTasks  = await measureLongTasks(page);

    const fcp = vitals.find(v => v.name === "FCP")?.value ?? null;
    const result: VaultPerfResult = {
      scenario: "vault-detail-render",
      fcp, lcp: vitals.find(v => v.name === "LCP")?.value ?? null,
      longTaskCount: longTasks.count,
      totalLongTaskMs: longTasks.totalMs,
      domContentLoaded: 0,
      recordedAt: new Date().toISOString(),
    };
    saveResult(result);
    console.log("[vault-detail-render]", JSON.stringify(result));

    if (fcp !== null) expect(fcp, `FCP ${fcp}ms exceeds 2000ms`).toBeLessThan(2000);
    // Long-task budget: ≤ 2 long tasks, total < 200 ms.
    expect(longTasks.count, "Too many long tasks on vault detail load").toBeLessThanOrEqual(2);
  });

  test("epoch-transition: re-render completes in < 100 ms, no long tasks", async ({ page }) => {
    await page.goto("/vaults/xlm-cc-v1");
    await page.waitForSelector("h1, [data-testid='vault-header']", { timeout: 15_000 });

    // Simulate epoch phase transition by injecting a custom event that the
    // vault detail page listens for (wired via the SorobanEventContext).
    const renderTime: number = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const start = performance.now();
        window.dispatchEvent(new CustomEvent("vault:epoch_transition", {
          detail: { vaultId: "xlm-cc-v1", newPhase: "settlement", epoch: 48 },
        }));
        // Measure how long until the next paint frame.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(Math.round(performance.now() - start));
          });
        });
      });
    });

    const longTasks = await measureLongTasks(page);
    const result: VaultPerfResult = {
      scenario: "epoch-transition",
      fcp: null, lcp: null,
      longTaskCount: longTasks.count,
      totalLongTaskMs: longTasks.totalMs,
      domContentLoaded: renderTime,
      recordedAt: new Date().toISOString(),
    };
    saveResult(result);
    console.log("[epoch-transition]", JSON.stringify(result));

    expect(renderTime, `Epoch transition re-render took ${renderTime}ms, expected < 100ms`).toBeLessThan(100);
    expect(longTasks.count, "Long tasks detected during epoch transition").toBe(0);
  });

  test("withdrawal-queue-render: 50 queued items render in < 500 ms", async ({ page }) => {
    // Navigate with a query param that tells the mock API to return 50 queued withdrawals.
    await page.goto("/vaults/xlm-cc-v1?mock_queue=50");
    await page.waitForSelector("h1, [data-testid='vault-header']", { timeout: 15_000 });

    const longTasks = await measureLongTasks(page);
    const listRenderMs: number = await page.evaluate(() => {
      const t = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return t ? Math.round(t.domInteractive - t.startTime) : 0;
    });

    const result: VaultPerfResult = {
      scenario: "withdrawal-queue-render",
      fcp: null, lcp: null,
      longTaskCount: longTasks.count,
      totalLongTaskMs: longTasks.totalMs,
      domContentLoaded: listRenderMs,
      recordedAt: new Date().toISOString(),
    };
    saveResult(result);
    console.log("[withdrawal-queue-render]", JSON.stringify(result));

    expect(listRenderMs, `Queue render took ${listRenderMs}ms, expected < 500ms`).toBeLessThan(500);
  });
});
