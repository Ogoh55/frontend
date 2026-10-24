import { NextRequest, NextResponse } from 'next/server';
import { getVaults } from '@/lib/api/vaults';

/**
 * Public, unauthenticated, read-only vault list endpoint for partner integrations.
 *
 * Served from a cache independent of the authenticated API read path so partner
 * traffic spikes cannot degrade the app's own read path.
 *
 * Contract:
 *  - GET /api/public/vaults?limit=&cursor=
 *  - Returns only non-sensitive, public projection fields (no per-depositor data).
 *  - Caching: `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`
 *  - CORS: `Access-Control-Allow-Origin: *` (read-only, no credentials)
 *  - Pagination: `limit` (1-100, default 20) + opaque `cursor`; `nextCursor` in body.
 *  - Rate limits: per-IP (60 req/min) and per-API-key (600 req/min) for higher tiers.
 */

export const runtime = 'edge';
export const revalidate = 60;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const IP_RATE_LIMIT = 60;
const KEY_RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;

// Independent in-memory cache + rate-limit buckets for the public surface.
// Kept separate from the authenticated read path on purpose.
const publicCache = new Map<string, { expiresAt: number; body: unknown }>();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function cacheHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    'Vary': 'Origin',
  };
}

function checkRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

function parseLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | null): number {
  if (!raw) return 0;
  const decoded = Number.parseInt(Buffer.from(raw, 'base64url').toString('utf8'), 10);
  return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
}

// Public projection: only non-sensitive fields. Never include depositor data.
function toPublicVault(vault: Record<string, unknown>) {
  return {
    id: vault.id,
    name: vault.name,
    symbol: vault.symbol,
    status: vault.status,
    asset: vault.asset,
    apy: vault.apy,
    tvl: vault.tvl,
    navPerShare: vault.navPerShare,
    epoch: vault.epoch,
    updatedAt: vault.updatedAt,
  };
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Respect the launch flag so embeds can't leak an unlaunched surface.
  if (process.env.NEXT_PUBLIC_VAULTS !== 'true') {
    return NextResponse.json(
      { error: 'vaults_unavailable' },
      { status: 404, headers: { ...corsHeaders(), ...cacheHeaders() } },
    );
  }

  const apiKey = req.headers.get('x-api-key');
  const ip = clientIp(req);

  const ipOk = checkRateLimit(`ip:${ip}`, IP_RATE_LIMIT);
  const keyOk = apiKey ? checkRateLimit(`key:${apiKey}`, KEY_RATE_LIMIT) : true;
  if (!ipOk || !keyOk) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: {
          ...corsHeaders(),
          'Retry-After': String(Math.ceil(RATE_WINDOW_MS / 1000)),
        },
      },
    );
  }

  const limit = parseLimit(req.nextUrl.searchParams.get('limit'));
  const offset = decodeCursor(req.nextUrl.searchParams.get('cursor'));
  const cacheKey = `list:${limit}:${offset}`;

  const cached = publicCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.body, {
      status: 200,
      headers: { ...corsHeaders(), ...cacheHeaders(), 'X-Cache': 'HIT' },
    });
  }

  const vaults = await getVaults();
  const publicVaults = vaults.map((v) => toPublicVault(v as unknown as Record<string, unknown>));
  const page = publicVaults.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextCursor = nextOffset < publicVaults.length ? encodeCursor(nextOffset) : null;

  const body = {
    data: page,
    pagination: {
      limit,
      nextCursor,
      total: publicVaults.length,
    },
  };

  publicCache.set(cacheKey, { expiresAt: Date.now() + 60_000, body });

  return NextResponse.json(body, {
    status: 200,
    headers: { ...corsHeaders(), ...cacheHeaders(), 'X-Cache': 'MISS' },
  });
}
