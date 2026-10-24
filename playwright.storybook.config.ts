import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Storybook visual regression tests.
 *
 * Tests run against a locally built & served Storybook (port 6006).
 * In CI the `storybook:build` step runs first, then `storybook:serve` starts
 * a static server before Playwright is invoked.
 *
 * Run locally:
 *   npx storybook build          # build to storybook-static/
 *   npx storybook dev            # or: serve storybook-static/ on port 6006
 *   npx playwright test --config playwright.storybook.config.ts
 *
 * Update snapshots:
 *   npx playwright test --config playwright.storybook.config.ts --update-snapshots
 */

const STORYBOOK_URL = process.env.STORYBOOK_URL ?? 'http://localhost:6006';

export default defineConfig({
  testDir: './e2e/storybook',
  testMatch: '**/*.vrt.ts',

  // Visual tests are inherently slow — generous timeout
  timeout: 60_000,
  expect: {
    // Allow up to 0.2% pixel diff (anti-aliasing, sub-pixel rendering)
    toHaveScreenshot: { maxDiffPixelRatio: 0.002 },
    toMatchSnapshot:  { maxDiffPixelRatio: 0.002 },
  },

  // No parallelism for visual tests — keeps screenshots deterministic
  workers: 1,
  retries: process.env.CI ? 1 : 0,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/storybook-vrt', open: 'never' }],
  ],

  use: {
    baseURL: STORYBOOK_URL,
    // Chromium-only for snapshots (cross-browser pixel diffs would always fail)
    ...devices['Desktop Chrome'],
    // Disable GPU for consistent headless rendering
    launchOptions: {
      args: ['--disable-gpu', '--no-sandbox'],
    },
    // Animated content: wait for fonts + CSS transitions to settle
    // (transitions are killed in preview.ts but belt-and-suspenders)
    actionTimeout: 5_000,
    // Capture screenshot on every test failure for debugging
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Dark colour scheme — matches the app theme
    colorScheme: 'dark',
  },

  // Snapshot directory — committed to git, updated via --update-snapshots.
  // Follows the existing `e2e/*-snapshots/` convention so baselines live
  // alongside the other Playwright snapshots.
  snapshotDir: './e2e/storybook-snapshots',

  // Devices without a committed baseline skip rather than fail. Playwright
  // writes a `-snapshots` folder per project; when a project's baseline is
  // absent the comparison is skipped instead of erroring.
  ignoreSnapshots: false,

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  // When running locally, start Storybook dev server automatically.
  // In CI the server is started externally so this block is skipped.
  ...(!process.env.CI && {
    webServer: {
      command: 'npx storybook dev --port 6006 --no-open',
      url: STORYBOOK_URL,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  }),
});
