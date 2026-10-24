'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useVaults } from '@/lib/api/vaults';

type VaultTab = 'all' | 'active' | 'closed';
type VaultSort = 'tvl' | 'apy' | 'name';
type VaultOrder = 'asc' | 'desc';

const TABS: readonly VaultTab[] = ['all', 'active', 'closed'];
const SORTS: readonly VaultSort[] = ['tvl', 'apy', 'name'];
const ORDERS: readonly VaultOrder[] = ['asc', 'desc'];
const MAX_SEARCH_LENGTH = 64;

interface VaultListState {
  tab: VaultTab;
  sort: VaultSort;
  order: VaultOrder;
  search: string;
  cursor: string | null;
}

const DEFAULT_STATE: VaultListState = {
  tab: 'all',
  sort: 'tvl',
  order: 'desc',
  search: '',
  cursor: null,
};

function parseEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  if (value && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

function parseSearch(value: string | null): string {
  if (!value) return '';
  return value.slice(0, MAX_SEARCH_LENGTH);
}

function parseCursor(value: string | null): string | null {
  if (!value) return null;
  return value.slice(0, 128);
}

function parseListState(params: URLSearchParams): VaultListState {
  return {
    tab: parseEnum(params.get('tab'), TABS, DEFAULT_STATE.tab),
    sort: parseEnum(params.get('sort'), SORTS, DEFAULT_STATE.sort),
    order: parseEnum(params.get('order'), ORDERS, DEFAULT_STATE.order),
    search: parseSearch(params.get('q')),
    cursor: parseCursor(params.get('cursor')),
  };
}

function serializeListState(state: VaultListState): string {
  const params = new URLSearchParams();
  if (state.tab !== DEFAULT_STATE.tab) params.set('tab', state.tab);
  if (state.sort !== DEFAULT_STATE.sort) params.set('sort', state.sort);
  if (state.order !== DEFAULT_STATE.order) params.set('order', state.order);
  if (state.search) params.set('q', state.search);
  if (state.cursor) params.set('cursor', state.cursor);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function isLegacyQuery(params: URLSearchParams): boolean {
  return (
    params.has('filter') ||
    params.has('sortBy') ||
    params.has('direction') ||
    params.has('search') ||
    params.has('page')
  );
}

function migrateLegacyQuery(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  const filter = next.get('filter');
  if (filter) {
    next.set('tab', filter);
    next.delete('filter');
  }
  const sortBy = next.get('sortBy');
  if (sortBy) {
    next.set('sort', sortBy);
    next.delete('sortBy');
  }
  const direction = next.get('direction');
  if (direction) {
    next.set('order', direction);
    next.delete('direction');
  }
  const search = next.get('search');
  if (search) {
    next.set('q', search);
    next.delete('search');
  }
  next.delete('page');
  return next;
}

export default function VaultsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const state = useMemo(() => parseListState(new URLSearchParams(searchParams.toString())), [searchParams]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (!isLegacyQuery(params)) return;
    const migrated = migrateLegacyQuery(params);
    const query = migrated.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [pathname]);

  const updateState = useCallback(
    (patch: Partial<VaultListState>) => {
      const next: VaultListState = { ...state, ...patch };
      if (patch.tab !== undefined || patch.sort !== undefined || patch.order !== undefined || patch.search !== undefined) {
        next.cursor = null;
      }
      router.replace(`${pathname}${serializeListState(next)}`, { scroll: false });
    },
    [pathname, router, state],
  );

  const { data: vaults, isLoading, isError } = useVaults({
    tab: state.tab,
    sort: state.sort,
    order: state.order,
    search: state.search,
    cursor: state.cursor,
  });

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold outline-none">
        Vaults
      </h1>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Vault status" className="flex gap-1">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={state.tab === tab}
              onClick={() => updateState({ tab })}
              className={`rounded px-3 py-1 text-sm ${state.tab === tab ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-700'}`}
            >
              {tab}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Search vaults</span>
          <input
            type="search"
            value={state.search}
            maxLength={MAX_SEARCH_LENGTH}
            placeholder="Search vaults"
            onChange={(event) => updateState({ search: event.target.value.slice(0, MAX_SEARCH_LENGTH) })}
            className="rounded border border-neutral-300 px-2 py-1"
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <span>Sort</span>
          <select
            value={state.sort}
            onChange={(event) => updateState({ sort: event.target.value as VaultSort })}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            {SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {sort}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => updateState({ order: state.order === 'asc' ? 'desc' : 'asc' })}
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
          aria-label={`Sort ${state.order === 'asc' ? 'descending' : 'ascending'}`}
        >
          {state.order === 'asc' ? 'Asc' : 'Desc'}
        </button>
      </div>

      <section aria-live="polite" className="mt-6">
        {isLoading ? (
          <p className="text-sm text-neutral-500">Loading vaults…</p>
        ) : isError ? (
          <p className="text-sm text-red-600">Unable to load vaults.</p>
        ) : !vaults || vaults.length === 0 ? (
          <p className="text-sm text-neutral-500">No vaults match the current filters.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {vaults.map((vault) => (
              <li key={vault.id}>
                <Link
                  href={`/vaults/${encodeURIComponent(vault.id)}`}
                  prefetch
                  className="block rounded border border-neutral-200 p-4 hover:border-neutral-400"
                >
                  <span className="block font-medium">{vault.name}</span>
                  <span className="block text-sm text-neutral-500">{vault.id}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
