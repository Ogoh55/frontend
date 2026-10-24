/**
 * Strict allowlist of backend paths and methods the BFF will proxy (#118).
 * Anything not listed is a 404. This is a fixed set of routes, not an open
 * proxy. `/api/v1/auth/verify` and `/api/v1/auth/me` are intentionally
 * absent: they return or accept the bearer token, so only
 * `/api/bff/session` calls them, server-side.
 *
 * `auth` controls whether the session's bearer token is attached:
 *   required: a session is needed (401 without calling the backend if missing)
 *   optional: the token is attached when present (for endpoints that personalise public data)
 *   none:     the token is never attached
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AuthMode = "required" | "optional" | "none";

export interface AllowRule {
  pattern: RegExp;
  methods: Partial<Record<Method, AuthMode>>;
}

const ID = "[A-Za-z0-9_-]{1,128}";
const route = (path: string) => new RegExp(`^${path.replace(/:id/g, ID)}$`);

export const ALLOWLIST: AllowRule[] = [
  // Auth (nonce only — verify/me are handled by /api/bff/session)
  { pattern: route("/api/v1/auth/nonce"), methods: { POST: "none" } },

  // Account & portfolio
  { pattern: route("/api/v1/account"), methods: { GET: "required" } },
  { pattern: route("/api/v1/history"), methods: { GET: "required" } },
  { pattern: route("/api/v1/portfolio/greeks"), methods: { GET: "required" } },
  { pattern: route("/api/v1/portfolio/payoff"), methods: { POST: "required" } },
  { pattern: route("/api/v1/features"), methods: { GET: "optional" } },

  // Positions & strategies
  { pattern: route("/api/v1/positions"), methods: { GET: "required" } },
  { pattern: route("/api/v1/positions/open"), methods: { POST: "required" } },
  { pattern: route("/api/v1/positions/:id/close"), methods: { POST: "required" } },
  { pattern: route("/api/v1/positions/:id/roll"), methods: { POST: "required" } },
  { pattern: route("/api/v1/strategies/execute"), methods: { POST: "required" } },
  { pattern: route("/api/v1/strategies/:id/close"), methods: { POST: "required" } },

  // Market data
  { pattern: route("/api/v1/market/:id/iv-atm"), methods: { GET: "none" } },
  { pattern: route("/api/v1/market/:id/vol-history"), methods: { GET: "none" } },

  // On-chain helpers
  { pattern: route("/api/v1/onchain/positions"), methods: { GET: "optional" } },
  { pattern: route("/api/v1/onchain/build-deposit"), methods: { POST: "required" } },
  { pattern: route("/api/v1/onchain/build-withdraw"), methods: { POST: "required" } },
  { pattern: route("/api/v1/onchain/reconciliation-report"), methods: { POST: "optional" } },

  // Settlement
  { pattern: route("/api/v1/settlement"), methods: { GET: "required" } },
  { pattern: route("/api/v1/settlement/batch-claim"), methods: { POST: "required" } },
  { pattern: route("/api/v1/settlement/:id/claim"), methods: { POST: "required" } },
  { pattern: route("/api/v1/settlement/:id/reclaim"), methods: { POST: "required" } },

  // Vaults
  { pattern: route("/api/v1/vaults"), methods: { GET: "optional" } },
  { pattern: route("/api/v1/vaults/:id"), methods: { GET: "optional" } },
  { pattern: route("/api/v1/vaults/:id/deposit"), methods: { POST: "required" } },
  { pattern: route("/api/v1/vaults/:id/withdraw"), methods: { POST: "required" } },

  // Vault operator console. Operator authorization is enforced by the backend
  // (403 is passed through); the BFF only attaches the session token.
  { pattern: route("/api/v1/operator/vaults/:id/status"), methods: { GET: "required" } },
  { pattern: route("/api/v1/operator/vaults/:id/rollover"), methods: { POST: "required" } },
  { pattern: route("/api/v1/operator/vaults/:id/pause"), methods: { POST: "required" } },
  { pattern: route("/api/v1/operator/vaults/:id/resume"), methods: { POST: "required" } },
  { pattern: route("/api/v1/operator/vaults/:id/parameter-changes"), methods: { POST: "required" } },
  { pattern: route("/api/v1/operator/vaults/:id/alerts/:id/resolve"), methods: { POST: "required" } },
  { pattern: route("/api/v1/operator/audit-log"), methods: { GET: "required" } },

  // Watchlist & alerts
  { pattern: route("/api/v1/watchlist"), methods: { GET: "required", POST: "required" } },
  { pattern: route("/api/v1/watchlist/:id"), methods: { DELETE: "required" } },
  { pattern: route("/api/v1/alerts"), methods: { GET: "required", POST: "required" } },
  { pattern: route("/api/v1/alerts/:id"), methods: { DELETE: "required" } },

  // Grants
  { pattern: route("/grants/programs"), methods: { GET: "optional" } },
  { pattern: route("/grants/programs/:id"), methods: { GET: "optional" } },
  { pattern: route("/grants/approved"), methods: { GET: "optional" } },
  { pattern: route("/grants/my-applications"), methods: { GET: "required" } },
  { pattern: route("/grants/applications"), methods: { POST: "required" } },
  { pattern: route("/grants/applications/:id"), methods: { GET: "required" } },

  // Referrals
  { pattern: route("/referrals/code"), methods: { GET: "required" } },
  { pattern: route("/referrals/dashboard"), methods: { GET: "required" } },
  { pattern: route("/referrals/attribution"), methods: { POST: "required" } },
  { pattern: route("/referrals/claim"), methods: { POST: "required" } },

  // Community strategies
  { pattern: route("/community/strategies"), methods: { GET: "optional", POST: "required" } },
  { pattern: route("/community/strategies/:id"), methods: { GET: "optional", DELETE: "required" } },
  { pattern: route("/community/strategies/:id/upvote"), methods: { POST: "required" } },
  { pattern: route("/community/strategies/:id/flag"), methods: { POST: "required" } },

  // Governance
  { pattern: route("/governance/delegates"), methods: { GET: "optional" } },
  { pattern: route("/governance/delegates/profile"), methods: { POST: "required" } },
  { pattern: route("/governance/delegates/:id"), methods: { GET: "optional" } },
  { pattern: route("/governance/delegate"), methods: { POST: "required" } },
  { pattern: route("/governance/my-delegation"), methods: { GET: "required" } },

  // Public stats
  { pattern: route("/stats"), methods: { GET: "none" } },
  { pattern: route("/stats/history"), methods: { GET: "none" } },
];

export type AllowDecision =
  | { allowed: true; auth: AuthMode }
  | { allowed: false; status: 404 | 405 };

/** Rejects traversal and encoded separators before matching. */
export function isSafePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.includes("//") &&
    !path.includes("\\") &&
    !/(^|\/)\.\.?(\/|$)/.test(path) &&
    !/%2e|%2f|%5c/i.test(path)
  );
}

export function checkAllowlist(method: string, path: string): AllowDecision {
  if (!isSafePath(path)) return { allowed: false, status: 404 };
  const rule = ALLOWLIST.find((r) => r.pattern.test(path));
  if (!rule) return { allowed: false, status: 404 };
  const auth = rule.methods[method.toUpperCase() as Method];
  return auth ? { allowed: true, auth } : { allowed: false, status: 405 };
}
