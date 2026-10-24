/**
 * Embeddable Vault Widget (issue #233)
 *
 * A self-contained, dependency-free custom element that renders vault
 * cards/table from the public read-only vault API and deep-links into the
 * app's deposit flow with attribution parameters preserved.
 *
 * Usage:
 *   <script type="module" src="https://cdn.zenith.app/embed/vault-widget.js"></script>
 *   <zenith-vault-widget
 *     api-base="https://api.zenith.app"
 *     app-base="https://app.zenith.app"
 *     partner-id="acme-wallet"
 *     theme="auto"
 *   ></zenith-vault-widget>
 *
 * The widget only ever talks to the public, unauthenticated API surface and
 * never sends credentials or cookies (fetch uses `credentials: 'omit'`).
 */

export interface PublicVaultSummary {
  id: string;
  name: string;
  symbol: string;
  status: 'active' | 'paused' | 'wind-down' | 'unlaunched';
  navPerShare: string | null;
  apy: string | null;
  tvl: string | null;
  updatedAt: string | null;
}

export interface PublicVaultListResponse {
  data: PublicVaultSummary[];
  nextCursor: string | null;
}

const DEFAULT_API_BASE = 'https://api.zenith.app';
const DEFAULT_APP_BASE = 'https://app.zenith.app';
const PAGE_LIMIT = 20;

const STATUS_LABELS: Record<PublicVaultSummary['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  'wind-down': 'Wind-down',
  unlaunched: 'Coming soon',
};

function formatPercent(value: string | null): string {
  if (value === null || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '—';
}

function formatAmount(value: string | null): string {
  if (value === null || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
}

function buildDepositUrl(appBase: string, vaultId: string, partnerId: string | null): string {
  const url = new URL(`/vaults/${encodeURIComponent(vaultId)}/deposit`, appBase);
  url.searchParams.set('utm_source', 'embed');
  url.searchParams.set('utm_medium', 'widget');
  if (partnerId) url.searchParams.set('utm_campaign', partnerId);
  if (partnerId) url.searchParams.set('ref', partnerId);
  return url.toString();
}

const STYLES = `
  :host {
    --zvw-bg: #ffffff;
    --zvw-fg: #111827;
    --zvw-muted: #6b7280;
    --zvw-border: #e5e7eb;
    --zvw-accent: #2563eb;
    --zvw-card: #f9fafb;
    display: block;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    color: var(--zvw-fg);
    background: var(--zvw-bg);
  }
  :host([data-theme='dark']) {
    --zvw-bg: #0b0f19;
    --zvw-fg: #f3f4f6;
    --zvw-muted: #9ca3af;
    --zvw-border: #1f2937;
    --zvw-accent: #60a5fa;
    --zvw-card: #111827;
  }
  .grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  .card { border: 1px solid var(--zvw-border); border-radius: 0.75rem; padding: 0.875rem; background: var(--zvw-card); }
  .card h3 { margin: 0 0 0.25rem; font-size: 1rem; }
  .symbol { color: var(--zvw-muted); font-size: 0.8125rem; }
  .row { display: flex; justify-content: space-between; font-size: 0.8125rem; margin-top: 0.375rem; }
  .row span:first-child { color: var(--zvw-muted); }
  .status { display: inline-block; font-size: 0.6875rem; padding: 0.125rem 0.5rem; border-radius: 999px; border: 1px solid var(--zvw-border); margin-top: 0.5rem; }
  .status[data-status='paused'], .status[data-status='wind-down'] { color: #b45309; border-color: #f59e0b; }
  .status[data-status='unlaunched'] { color: var(--zvw-muted); }
  a.deposit { display: inline-block; margin-top: 0.625rem; font-size: 0.8125rem; color: var(--zvw-accent); text-decoration: none; }
  a.deposit:hover, a.deposit:focus-visible { text-decoration: underline; }
  a.deposit:focus-visible { outline: 2px solid var(--zvw-accent); outline-offset: 2px; border-radius: 0.25rem; }
  .empty, .error { color: var(--zvw-muted); font-size: 0.875rem; padding: 0.5rem 0; }
  .error { color: #b91c1c; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
`;

export class ZenithVaultWidget extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['api-base', 'app-base', 'partner-id', 'theme'];
  }

  private root: ShadowRoot;
  private vaults: PublicVaultSummary[] = [];
  private loading = false;
  private error: string | null = null;
  private mediaQuery: MediaQueryList | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.applyTheme();
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaQuery.addEventListener('change', this.onThemeChange);
    void this.load();
  }

  disconnectedCallback(): void {
    this.mediaQuery?.removeEventListener('change', this.onThemeChange);
  }

  attributeChangedCallback(): void {
    if (!this.isConnected) return;
    this.applyTheme();
    void this.load();
  }

  private onThemeChange = (): void => {
    this.applyTheme();
  };

  private get apiBase(): string {
    return (this.getAttribute('api-base') || DEFAULT_API_BASE).replace(/\/$/, '');
  }

  private get appBase(): string {
    return (this.getAttribute('app-base') || DEFAULT_APP_BASE).replace(/\/$/, '');
  }

  private get partnerId(): string | null {
    return this.getAttribute('partner-id');
  }

  private applyTheme(): void {
    const theme = this.getAttribute('theme') || 'auto';
    const prefersDark = this.mediaQuery?.matches ?? false;
    const resolved = theme === 'auto' ? (prefersDark ? 'dark' : 'light') : theme;
    this.setAttribute('data-theme', resolved === 'dark' ? 'dark' : 'light');
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const url = new URL(`${this.apiBase}/public/v1/vaults`);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      const res = await fetch(url.toString(), {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PublicVaultListResponse;
      this.vaults = Array.isArray(body.data) ? body.data : [];
    } catch {
      this.error = 'Unable to load vaults right now.';
      this.vaults = [];
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const style = document.createElement('style');
    style.textContent = STYLES;

    const container = document.createElement('div');
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Zenith vaults');

    const heading = document.createElement('h2');
    heading.className = 'sr-only';
    heading.textContent = 'Zenith vaults';
    container.appendChild(heading);

    if (this.loading) {
      const loading = document.createElement('p');
      loading.className = 'empty';
      loading.setAttribute('role', 'status');
      loading.textContent = 'Loading vaults…';
      container.appendChild(loading);
    } else if (this.error) {
      const err = document.createElement('p');
      err.className = 'error';
      err.setAttribute('role', 'alert');
      err.textContent = this.error;
      container.appendChild(err);
    } else if (this.vaults.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No vaults available.';
      container.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'grid';
      for (const vault of this.vaults) {
        grid.appendChild(this.renderCard(vault));
      }
      container.appendChild(grid);
    }

    this.root.replaceChildren(style, container);
  }

  private renderCard(vault: PublicVaultSummary): HTMLElement {
    const card = document.createElement('article');
    card.className = 'card';
    card.setAttribute('aria-label', `${vault.name} (${vault.symbol})`);

    const title = document.createElement('h3');
    title.textContent = vault.name;
    card.appendChild(title);

    const symbol = document.createElement('div');
    symbol.className = 'symbol';
    symbol.textContent = vault.symbol;
    card.appendChild(symbol);

    const apyRow = document.createElement('div');
    apyRow.className = 'row';
    apyRow.innerHTML = '<span>APY</span>';
    const apyValue = document.createElement('span');
    apyValue.textContent = formatPercent(vault.apy);
    apyRow.appendChild(apyValue);
    card.appendChild(apyRow);

    const tvlRow = document.createElement('div');
    tvlRow.className = 'row';
    tvlRow.innerHTML = '<span>TVL</span>';
    const tvlValue = document.createElement('span');
    tvlValue.textContent = formatAmount(vault.tvl);
    tvlRow.appendChild(tvlValue);
    card.appendChild(tvlRow);

    const status = document.createElement('span');
    status.className = 'status';
    status.dataset.status = vault.status;
    status.textContent = STATUS_LABELS[vault.status] ?? vault.status;
    card.appendChild(status);

    if (vault.status === 'active') {
      const link = document.createElement('a');
      link.className = 'deposit';
      link.href = buildDepositUrl(this.appBase, vault.id, this.partnerId);
      link.textContent = 'Deposit →';
      link.setAttribute('aria-label', `Deposit into ${vault.name}`);
      card.appendChild(link);
    }

    return card;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('zenith-vault-widget')) {
  customElements.define('zenith-vault-widget', ZenithVaultWidget);
}

export default ZenithVaultWidget;
