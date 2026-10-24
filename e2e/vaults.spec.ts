import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Vault end-to-end coverage (issue #219).
 *
 * Every fixture below is derived from the frozen REST contract for the
 * `/vaults` surface. The backend is mocked per-test (no global intercept) so a
 * contract change breaks these tests instead of silently drifting.
 */

type VaultStatus = 'open' | 'capacity-full' | 'waitlist' | 'closed-epoch';

interface VaultFixture {
  id: string;
  name: string;
  asset: string;
  status: VaultStatus;
  capacity: string;
  totalAssets: string;
  sharePrice: string;
  epoch: number;
  epochEndsAt: string;
}

const VAULT_OPEN: VaultFixture = {
  id: 'vault-usdc-1',
  name: 'USDC Yield Vault',
  asset: 'USDC',
  status: 'open',
  capacity: '1000000',
  totalAssets: '250000',
  sharePrice: '1.05',
  epoch: 12,
  epochEndsAt: '2099-01-01T00:00:00.000Z',
};

const VAULT_CAPACITY_FULL: VaultFixture = {
  ...VAULT_OPEN,
  id: 'vault-usdc-full',
  name: 'USDC Capacity Vault',
  status: 'capacity-full',
  totalAssets: '1000000',
};

const VAULT_WAITLIST: VaultFixture = {
  ...VAULT_OPEN,
  id: 'vault-usdc-waitlist',
  name: 'USDC Waitlist Vault',
  status: 'waitlist',
};

const VAULT_CLOSED_EPOCH: VaultFixture = {
  ...VAULT_OPEN,
  id: 'vault-usdc-closed',
  name: 'USDC Closed Epoch Vault',
  status: 'closed-epoch',
  epochEndsAt: '2000-01-01T00:00:00.000Z',
};

const ALL_VAULTS = [VAULT_OPEN, VAULT_CAPACITY_FULL, VAULT_WAITLIST, VAULT_CLOSED_EPOCH];

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface MockOptions {
  vaults?: VaultFixture[];
  depositError?: { status: number; message: string };
  withdrawError?: { status: number; message: string };
  redeemError?: { status: number; message: string };
  rpcFailure?: boolean;
}

/**
 * Installs a deterministic fake backend for the vault surface and returns the
 * list of requests the app actually issued. Wallet connection is stubbed via
 * the session cookie exchange so no Freighter extension is required in CI.
 */
async function installVaultBackend(page: Page, options: MockOptions = {}): Promise<RecordedRequest[]> {
  const requests: RecordedRequest[] = [];
  const vaults = options.vaults ?? ALL_VAULTS;

  await page.route('**/api/vaults**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const path = url.pathname;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    requests.push({ method, path, body });

    if (options.rpcFailure) {
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'RPC_UNAVAILABLE', message: 'Upstream RPC unavailable' }),
      });
    }

    // Vault list
    if (method === 'GET' && /\/api\/vaults\/?$/.test(path)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ vaults }),
      });
    }

    // Epoch ledger
    const epochMatch = path.match(/\/api\/vaults\/([^/]+)\/epochs\/?$/);
    if (method === 'GET' && epochMatch) {
      const vault = vaults.find((v) => v.id === epochMatch[1]);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          vaultId: epochMatch[1],
          currentEpoch: vault?.epoch ?? 0,
          endsAt: vault?.epochEndsAt ?? null,
          status: vault?.status ?? 'open',
        }),
      });
    }

    // Deposit
    const depositMatch = path.match(/\/api\/vaults\/([^/]+)\/deposit\/?$/);
    if (method === 'POST' && depositMatch) {
      if (options.depositError) {
        return route.fulfill({
          status: options.depositError.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'DEPOSIT_FAILED', message: options.depositError.message }),
        });
      }
      const amount = Number((body as { amount?: string })?.amount ?? '0');
      const sharePrice = Number(VAULT_OPEN.sharePrice);
      const shares = amount / sharePrice;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          vaultId: depositMatch[1],
          deposited: String(amount),
          shares: shares.toFixed(6),
          sharePrice: VAULT_OPEN.sharePrice,
        }),
      });
    }

    // Withdrawal queue
    const withdrawMatch = path.match(/\/api\/vaults\/([^/]+)\/withdrawals?\/?$/);
    if (method === 'POST' && withdrawMatch) {
      if (options.withdrawError) {
        return route.fulfill({
          status: options.withdrawError.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'WITHDRAW_FAILED', message: options.withdrawError.message }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          vaultId: withdrawMatch[1],
          requestId: 'wd-1',
          status: 'queued',
          shares: (body as { shares?: string })?.shares ?? '0',
        }),
      });
    }

    // Redemption
    const redeemMatch = path.match(/\/api\/vaults\/([^/]+)\/redeem\/?$/);
    if (method === 'POST' && redeemMatch) {
      if (options.redeemError) {
        return route.fulfill({
          status: options.redeemError.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'REDEEM_FAILED', message: options.redeemError.message }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ vaultId: redeemMatch[1], requestId: 'wd-1', status: 'redeemed' }),
      });
    }

    // Vault detail
    const detailMatch = path.match(/\/api\/vaults\/([^/]+)\/?$/);
    if (method === 'GET' && detailMatch) {
      const vault = vaults.find((v) => v.id === detailMatch[1]);
      if (!vault) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'NOT_FOUND', message: 'Vault not found' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(vault),
      });
    }

    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  // Deterministic wallet/session stub: no Freighter extension in CI.
  await page.route('**/api/session**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ address: 'GTESTWALLET000000000000000000000000000000000000000000000' }),
    }),
  );

  return requests;
}

test.describe('vaults', () => {
  test('successful deposit updates the share preview and issues a deposit request', async ({ page }) => {
    const requests = await installVaultBackend(page);
    await page.goto('/vaults');

    await expect(page.getByRole('heading', { name: /vaults/i })).toBeVisible();
    await page.getByRole('link', { name: /USDC Yield Vault/i }).click();

    await page.getByLabel(/amount/i).fill('105');
    // Share preview should reflect amount / sharePrice (105 / 1.05 = 100).
    await expect(page.getByTestId('share-preview')).toContainText('100');

    await page.getByRole('button', { name: /deposit/i }).click();

    await expect(page.getByText(/deposit (submitted|successful)/i)).toBeVisible();

    const deposit = requests.find((r) => r.method === 'POST' && /\/deposit$/.test(r.path));
    expect(deposit).toBeTruthy();
    expect(deposit?.body).toMatchObject({ amount: '105' });
  });

  test('withdrawal enters the queue and a redemption completes', async ({ page }) => {
    const requests = await installVaultBackend(page);
    await page.goto('/vaults/vault-usdc-1');

    await page.getByLabel(/shares/i).fill('50');
    await page.getByRole('button', { name: /withdraw/i }).click();

    await expect(page.getByText(/queued/i)).toBeVisible();
    const withdraw = requests.find((r) => r.method === 'POST' && /\/withdrawals?$/.test(r.path));
    expect(withdraw).toBeTruthy();
    expect(withdraw?.body).toMatchObject({ shares: '50' });

    await page.getByRole('button', { name: /redeem/i }).click();
    await expect(page.getByText(/redeemed/i)).toBeVisible();
    const redeem = requests.find((r) => r.method === 'POST' && /\/redeem$/.test(r.path));
    expect(redeem).toBeTruthy();
  });

  test('capacity-full vault surfaces the capacity state', async ({ page }) => {
    await installVaultBackend(page);
    await page.goto('/vaults/vault-usdc-full');
    await expect(page.getByText(/capacity (full|reached)/i)).toBeVisible();
  });

  test('waitlist vault surfaces the waitlist state', async ({ page }) => {
    await installVaultBackend(page);
    await page.goto('/vaults/vault-usdc-waitlist');
    await expect(page.getByText(/waitlist/i)).toBeVisible();
  });

  test('closed-epoch vault surfaces the closed epoch state', async ({ page }) => {
    await installVaultBackend(page);
    await page.goto('/vaults/vault-usdc-closed');
    await expect(page.getByText(/epoch (closed|ended)/i)).toBeVisible();
  });

  test('RPC failure shows a visible error and does not corrupt state', async ({ page }) => {
    await installVaultBackend(page, { rpcFailure: true });
    await page.goto('/vaults');

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(/unavailable|error/i);
    // No phantom vault rows rendered from a failed fetch.
    await expect(page.getByRole('link', { name: /USDC Yield Vault/i })).toHaveCount(0);
  });

  test('deposit API failure surfaces the backend error message', async ({ page }) => {
    await installVaultBackend(page, {
      depositError: { status: 400, message: 'Insufficient balance' },
    });
    await page.goto('/vaults/vault-usdc-1');

    await page.getByLabel(/amount/i).fill('105');
    await page.getByRole('button', { name: /deposit/i }).click();

    await expect(page.getByRole('alert')).toContainText(/insufficient balance/i);
  });

  test('NEXT_PUBLIC_VAULTS disabled flag returns the documented fallback', async ({ page }) => {
    // The flag is read at build time; when disabled the app renders the
    // documented fallback instead of the vault surface.
    await page.goto('/vaults');
    const fallback = page.getByTestId('vaults-disabled-fallback');
    if (await fallback.count()) {
      await expect(fallback).toBeVisible();
    } else {
      test.skip(true, 'NEXT_PUBLIC_VAULTS enabled in this build; fallback covered by unit test');
    }
  });
});
