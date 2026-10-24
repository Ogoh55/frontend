# Contributing to Zenith Frontend

Thanks for contributing. This document covers the development workflow, CI
pipeline, and branch protection setup.

## Contents

- [Getting started](#getting-started)
- [Security researchers & bug bounty program](#security-researchers--bug-bounty-program)
- [Development workflow](#development-workflow)
- [CI pipeline](#ci-pipeline)
- [Bundle budgets](#bundle-budgets)
- [Branch protection setup](#branch-protection-setup)
- [TypeScript strictness](#typescript-strictness)
- [Reporting a security vulnerability](#reporting-a-security-vulnerability)

---

## Security researchers & bug bounty program

If you have discovered a security vulnerability or potential defect affecting vault custody, smart contracts, backend APIs, or client signing surfaces:

- **DO NOT open public GitHub issues or pull requests.**
- Submit your finding confidentially via a **GitHub Private Security Advisory** on this repository or email encrypted reports to `security@zenith-options.org`.
- Zenith maintains an active, public **Bug Bounty Program** with rewards up to **$25,000 USD / USDC** and full **Safe Harbour** protection for good-faith researchers.
- Read the complete scope, asset inventory, and triage SLAs in [`docs/security/bug-bounty-program.md`](docs/security/bug-bounty-program.md) and [`SECURITY.md`](SECURITY.md).

---

## Getting started

```bash
# Node version is pinned in .nvmrc — use nvm or volta to match it
nvm install   # reads .nvmrc automatically

npm install
cp .env.local.example .env.local

npm run dev   # http://localhost:3000
```

Run the [backend](https://github.com/Zenith-options/backend) alongside it
(`cargo run`, default port 8081) for account/positions/history/watchlist/
alerts/live spot to actually load.

---

## Development workflow

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server with hot reload |
| `npm run lint` | ESLint via `next lint` |
| `npm run lint:ci` | Lint with `--max-warnings 0` (used in CI) |
| `npm run typecheck` | `tsc --noEmit` — no emit, just types |
| `npm test` | Jest unit tests |
| `npm run test:ci` | Jest with coverage (used in CI) |
| `npm run build` | Production build (`next build`) |
| `npm run size` | Bundle budget check against `.next/` output |
| `npm run api:check` | Validate backend fixture contracts against Zod schemas |
| `npm run storybook` | Storybook dev server at `:6006` |

---

## CI pipeline

Every pull request targeting `main` triggers two workflows:

### `ci.yml` — main gate

Four jobs run in **parallel**. All four must pass before a PR can be merged.

```
┌─────────┐  ┌────────────┐  ┌─────────────┐  ┌───────┐
│  lint   │  │ typecheck  │  │    unit     │  │ build │
│         │  │            │  │ (coverage)  │  │       │
└─────────┘  └────────────┘  └─────────────┘  └───────┘
```

| Job | Command | Failure condition |
|---|---|---|
| **lint** | `npm run lint:ci` | Any ESLint error or warning |
| **typecheck** | `npm run typecheck` | Any TypeScript error |
| **unit** | `npm run test:ci` | Any failing test |
| **build** | `npm run build` | Build failure |

A coverage report artifact is uploaded on every run (14-day retention).

The build job restores `.next/cache` between runs for fast incremental builds,
and uploads the built `.next/` as an artifact so the bundle job can use it.

### `bundle.yml` — bundle size gate

Runs on every PR. Builds the PR branch, measures gzip sizes with
[size-limit](https://github.com/ai/size-limit), and posts a comment to the
PR with the full budget table. It also builds the base branch to show a diff.

The job **fails if any budget is exceeded**, blocking the merge.

Example PR comment:

```
## ✅ Bundle budgets passed

|   | Name                               | Size (gzip) | Limit  | Diff vs base |
|---|---|---|---|---|
| ✅ | Shared vendor bundle (largest chunk) | 211.2 kB   | 280 kB | —            |
| ✅ | React framework chunk              | 45.2 kB     | 60 kB  | —            |
| ✅ | Page: / (home)                     | 5.2 kB      | 10 kB  | —            |
| ✅ | Page: /options                     | 0.1 kB      | 5 kB   | —            |
| ✅ | Page: /portfolio                   | 25.6 kB     | 35 kB  | —            |
| ✅ | Page: /history                     | 5.8 kB      | 10 kB  | —            |
```

### `storybook.yml` — component tests (path-filtered)

Runs when `src/components/**`, `src/lib/**`, or `.storybook/**` change.
Builds Storybook, runs interaction + a11y tests, runs visual regression tests,
and publishes to GitHub Pages on `main`.

---

## Bundle budgets

Budgets are defined in the `"size-limit"` section of `package.json`.
Each entry is the **gzip size** of a specific chunk in the Next.js output.

To check sizes locally:

```bash
npm run build    # must run first — size-limit reads .next/
npm run size
```

To see what changed:

```bash
# Before your change
git stash
npm run build
npx size-limit --json > /tmp/base.json
git stash pop

# After your change
npm run build
npx size-limit --json > /tmp/pr.json

# Compare
diff /tmp/base.json /tmp/pr.json
```

### Raising a limit

If a budget legitimately needs to increase (e.g. a new required dependency),
update the relevant entry in `package.json → "size-limit"` in the same PR.
Include a brief justification in the PR description.

### Reducing the vendor bundle

The largest chunk (`~211 kB` gzip, budget `280 kB`) is the shared vendor
bundle. It currently includes:

- `@stellar/stellar-sdk` — the main driver; explore dynamic imports if possible
- `@creit.tech/stellar-wallets-kit`
- Zustand, React, Next.js internals

Use `ANALYZE=true npm run build` with `@next/bundle-analyzer` (add it as a dev
dep) to visualise the tree map.

---

## Branch protection setup

The following GitHub branch protection settings are recommended for `main`.
A repo admin can apply them at:

**Settings → Branches → Add branch protection rule → `main`**

### Recommended rules

| Setting | Value | Why |
|---|---|---|
| Require a pull request before merging | ✅ | No direct pushes to `main` |
| Required approvals | **1** (or 2 for prod-sensitive changes) | Peer review |
| Dismiss stale reviews on new push | ✅ | Re-review after each fixup |
| Require status checks to pass before merging | ✅ | Gates on CI |
| **Required status checks** | See below | Block merges on failures |
| Require branches to be up to date before merging | ✅ | Prevent stale PRs |
| Require linear history | ✅ (optional) | Cleaner git log |
| Do not allow bypassing the above settings | ✅ | Admins too |

### Required status checks to add

Add each of these as a required check (they match the job names in the
workflow files):

```
Lint                  # ci.yml → lint
Typecheck             # ci.yml → typecheck
Unit Tests            # ci.yml → unit
Build                 # ci.yml → build
Bundle Budget Check   # bundle.yml → bundle
```

Optionally also require:

```
Build Storybook                   # storybook.yml (path-filtered)
Test Runner (interactions + a11y) # storybook.yml (path-filtered)
```

Note: path-filtered workflows only trigger when relevant files change. GitHub
marks them as "not run" (not "passed") when they are skipped due to path
filters — configure those checks as optional or use the
[`paths-ignore` workaround](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/troubleshooting-required-status-checks#handling-skipped-but-required-checks) to avoid blocking PRs that don't touch those paths.

### Applying via GitHub CLI

```bash
# Install gh CLI: https://cli.github.com
gh api \
  --method PUT \
  /repos/Zenith-options/frontend/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Lint", "Typecheck", "Unit Tests", "Build", "Bundle Budget Check"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

---

## TypeScript strictness

The project uses `strict: false` with a manually curated set of strict
sub-flags enabled (see `tsconfig.json`). The currently enabled flags are:

| Flag | Description |
|---|---|
| `strictFunctionTypes` | Covariant/contravariant function parameter checking |
| `strictBindCallApply` | Strict types for `bind`/`call`/`apply` |
| `noImplicitThis` | Error on `this` with implicit `any` type |
| `useUnknownInCatchVariables` | Catch bindings typed as `unknown` |
| `noUncheckedIndexedAccess` | Array/index access returns `T \| undefined` |
| `forceConsistentCasingInFileNames` | Case-insensitive import errors |
| `noFallthroughCasesInSwitch` | No implicit switch fallthrough |

The remaining strict flags (`strictNullChecks`, `noImplicitAny`) are not yet
enabled because they

---

## Reporting a security vulnerability

**Do not open a public issue, PR, or discussion for a security bug.**

Security reports for the vault stack (vault contracts, vault backend API, and
vault frontend surfaces) go through our coordinated vulnerability disclosure
process. Researchers are the entry point for that program:

- **Program page (scope, severity tiers, reward bands, safe harbour):**
  [`docs/bug-bounty.md`](docs/bug-bounty.md)
- **Repository security policy:** [`SECURITY.md`](SECURITY.md)
- **Triage runbook (intake, SLAs, embargo/disclosure timeline):**
  [`docs/triage-runbook.md`](docs/triage-runbook.md)

### How to submit

1. Read the scope and out-of-scope categories in
   [`docs/bug-bounty.md`](docs/bug-bounty.md) before testing.
2. Send the report to the private intake channel listed in
   [`SECURITY.md`](SECURITY.md) — never via a public GitHub issue.
3. Include reproduction steps, affected asset (contract ID / API endpoint /
   frontend route), and impact assessment.

You will receive an acknowledgement within the SLA defined in the triage
runbook. Please respect the embargo window before any public disclosure.

If you are unsure whether something is in scope, submit it anyway — triage
will make the scope call, and good-faith reports are covered by the
safe-harbour statement in the program page.
