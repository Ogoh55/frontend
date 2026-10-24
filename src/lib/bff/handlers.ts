/**
 * BFF request handlers (#118). Server-only. The route files under
 * src/app/api/bff/ are thin wrappers around these, which keeps them easy to
 * test with plain Request objects.
 */

import { BFF_PREFIX, type SessionInfo } from "./constants";
import { checkAllowlist } from "./allowlist";
import { checkCsrf, newCsrfToken } from "./csrf";
import {
  clearedCookie,
  csrfCookie,
  csrfCookieName,
  sealSession,
  secureCookies,
  sessionCookie,
  sessionCookieName,
  tokenExpiry,
  unsealSession,
  type CookieSpec,
  type SessionPayload,
} from "./session";

/** Backend base URL — server-side config, falls back to the public one. */
export function upstreamUrl(): string {
  return (process.env.BFF_UPSTREAM_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8081").replace(/\/$/, "");
}

const MAX_BODY_BYTES = 1024 * 1024;
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "accept-language", "idempotency-key"];
// content-length / content-encoding are deliberately not forwarded: fetch()
// has already decoded the upstream body, so they would no longer be accurate.
const FORWARDED_RESPONSE_HEADERS = ["content-type", "etag", "last-modified", "retry-after"];

// ── Cookies ───────────────────────────────────────────────────────────────────

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(c: CookieSpec): string {
  return [
    `${c.name}=${encodeURIComponent(c.value)}`,
    `Path=${c.path}`,
    `Max-Age=${c.maxAge}`,
    `SameSite=${c.sameSite === "strict" ? "Strict" : "Lax"}`,
    c.secure ? "Secure" : "",
    c.httpOnly ? "HttpOnly" : "",
  ].filter(Boolean).join("; ");
}

interface RequestContext {
  secure: boolean;
  cookies: Record<string, string>;
  session: SessionPayload | null;
  csrf: string | undefined;
}

async function context(req: Request): Promise<RequestContext> {
  const secure = secureCookies(req.url);
  const cookies = parseCookies(req.headers.get("cookie"));
  return {
    secure,
    cookies,
    session: await unsealSession(cookies[sessionCookieName(secure)]),
    csrf: cookies[csrfCookieName(secure)],
  };
}

function json(body: unknown, status: number, cookies: CookieSpec[] = []): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", serializeCookie(c));
  return new Response(JSON.stringify(body), { status, headers });
}

function clearSession(ctx: RequestContext): CookieSpec {
  return clearedCookie(sessionCookieName(ctx.secure), ctx.secure, true);
}

function info(session: SessionPayload | null): SessionInfo {
  return session
    ? { authenticated: true, wallet_address: session.a, expires_at: session.exp }
    : { authenticated: false, wallet_address: null, expires_at: null };
}

// ── /api/bff/session ──────────────────────────────────────────────────────────

/** GET: current session (validated against the backend), and mints a CSRF cookie if missing. */
export async function getSession(req: Request): Promise<Response> {
  const ctx = await context(req);
  const cookies: CookieSpec[] = [];
  if (!ctx.csrf) cookies.push(csrfCookie(newCsrfToken(), ctx.secure));

  if (!ctx.session) {
    if (ctx.cookies[sessionCookieName(ctx.secure)]) cookies.push(clearSession(ctx)); // expired / tampered
    return json(info(null), 200, cookies);
  }

  const me = await fetch(`${upstreamUrl()}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${ctx.session.t}` },
    cache: "no-store",
  }).catch(() => null);

  if (me && me.status === 401) {
    cookies.push(clearSession(ctx));
    return json(info(null), 200, cookies);
  }
  // Backend unreachable: report the cookie's view rather than logging the user out.
  return json(info(ctx.session), 200, cookies);
}

/** POST: exchange a wallet signature for a session cookie. The token never reaches JS. */
export async function createSession(req: Request): Promise<Response> {
  const ctx = await context(req);
  const csrf = checkCsrf(req, ctx.csrf);
  if (csrf) return json({ error: `CSRF check failed (${csrf})` }, 403);

  let body: { wallet_address?: unknown; message?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { wallet_address, message, signature } = body;
  if (typeof wallet_address !== "string" || typeof message !== "string" || typeof signature !== "string") {
    return json({ error: "wallet_address, message and signature are required" }, 400);
  }

  const res = await fetch(`${upstreamUrl()}/api/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet_address, message, signature }),
    cache: "no-store",
  }).catch(() => null);
  if (!res) return json({ error: "Backend unavailable" }, 502);
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    return json({ error: typeof err?.error === "string" ? err.error : "Sign-in failed" }, res.status);
  }

  const verified = (await res.json().catch(() => null)) as { token?: unknown; wallet_address?: unknown } | null;
  if (!verified || typeof verified.token !== "string" || verified.wallet_address !== wallet_address) {
    return json({ error: "Unexpected verify response" }, 502);
  }

  const exp = tokenExpiry(verified.token);
  const payload: SessionPayload = { t: verified.token, a: wallet_address, exp };
  return json(info(payload), 200, [
    sessionCookie(await sealSession(payload), exp, ctx.secure),
    // Rotate the CSRF token on privilege change.
    csrfCookie(newCsrfToken(), ctx.secure),
  ]);
}

/** DELETE: sign out. */
export async function deleteSession(req: Request): Promise<Response> {
  const ctx = await context(req);
  const csrf = checkCsrf(req, ctx.csrf);
  if (csrf) return json({ error: `CSRF check failed (${csrf})` }, 403);
  return json(info(null), 200, [clearSession(ctx), csrfCookie(newCsrfToken(), ctx.secure)]);
}

// ── /api/bff/[...path] ────────────────────────────────────────────────────────

export async function proxy(req: Request, segments: string[]): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  // Rebuild from the raw pathname (not the decoded segments) so encoded
  // separators are rejected by the allowlist instead of being normalised.
  const path = url.pathname.slice(BFF_PREFIX.length) || `/${segments.join("/")}`;
  const method = req.method.toUpperCase();

  const decision = checkAllowlist(method, path);
  if (!decision.allowed) {
    return json({ error: decision.status === 404 ? "Not found" : "Method not allowed" }, decision.status);
  }

  const ctx = await context(req);
  const csrf = checkCsrf(req, ctx.csrf);
  if (csrf) return json({ error: `CSRF check failed (${csrf})` }, 403);

  if (decision.auth === "required" && !ctx.session) {
    return json({ error: "Not signed in" }, 401, ctx.cookies[sessionCookieName(ctx.secure)] ? [clearSession(ctx)] : []);
  }

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: "Request body too large" }, 413);

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const attachToken = decision.auth !== "none" && !!ctx.session;
  if (attachToken) headers.set("authorization", `Bearer ${ctx.session!.t}`);

  const hasBody = method !== "GET" && method !== "DELETE" && req.body !== null;
  const upstreamStarted = performance.now();
  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamUrl()}${path}${url.search}`, {
      method,
      headers,
      body: hasBody ? req.body : undefined,
      // Stream the request body through (Node fetch requires duplex for streams).
      ...(hasBody ? { duplex: "half" } : {}),
      cache: "no-store",
      redirect: "manual",
    } as RequestInit);
  } catch {
    return json({ error: "Backend unavailable" }, 502);
  }
  const upstreamMs = performance.now() - upstreamStarted;

  const out = new Headers({ "cache-control": attachToken ? "private, no-store" : "no-store" });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // Latency budget visibility (#118: "measure it").
  out.set("server-timing", `upstream;dur=${upstreamMs.toFixed(1)}, bff;dur=${(performance.now() - started - upstreamMs).toFixed(1)}`);
  // The backend rejected our token → the cookie is useless; drop it so the client re-signs.
  if (upstream.status === 401 && attachToken) out.append("set-cookie", serializeCookie(clearSession(ctx)));

  // Stream the response body straight through.
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
