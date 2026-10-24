# Security

## Coordinated Vulnerability Disclosure & Bug Bounty Program

Zenith operates an active, rewarded **Bug Bounty Program** for the custody-bearing Vault Stack, Smart Contracts, Backend APIs, and Frontend Web Application.

- **Intake:** Submit reports via a **GitHub Private Security Advisory** on this repository or email encrypted reports to `security@zenith-options.org`.
- **Maximum Reward:** **$25,000 USD / USDC** for Critical findings affecting user collateral or contract custody.
- **Detailed Program Specification:** See [`docs/security/bug-bounty-program.md`](docs/security/bug-bounty-program.md) for full scope, asset inventory, reward tiers, and upgrade tracking.
- **Triage Runbook:** Responders follow [`docs/security/triage-runbook.md`](docs/security/triage-runbook.md).

### Response & Triage SLAs

| Step | SLA Window | Commitment |
|---|---|---|
| **Initial Acknowledgment** | ≤ 24 Hours | First human response confirming receipt of report |
| **Triage & Severity Score** | ≤ 72 Hours | Validation, CVSS 3.1 rating, and bounty eligibility assessment |
| **Patch & Remediation** | ≤ 14 Days | Development, testing, and deployment of hotfix |
| **Bounty Settlement** | ≤ 7 Days | Payout via USDC upon verified patch deployment |
| **Public Disclosure** | 90 Calendar Days | Coordinated release of security advisory post-fix |

### Safe Harbour Guarantee

Zenith considers security research conducted under the [Bug Bounty Program](docs/security/bug-bounty-program.md) to be **authorized, legal, and protected**. We will not pursue civil action or initiate legal complaints against researchers acting in good faith who respect user privacy, avoid service disruption, and adhere to coordinated disclosure guidelines.

---

## Bug bounty & coordinated vulnerability disclosure

We run a public bug bounty and coordinated vulnerability disclosure program
for the vault stack. The full program page (severity tiers, reward bands,
payment process) lives in [`docs/bug-bounty.md`](docs/bug-bounty.md), and the
triage runbook lives in [`docs/triage-runbook.md`](docs/triage-runbook.md).
Researchers should start at [`CONTRIBUTING.md`](CONTRIBUTING.md#security-research).

### In-scope assets

| Asset | Location | Notes |
|---|---|---|
| Vault contracts | `contracts/vault/` | Deployed contract IDs and code hashes are tracked in the verified-build registry; the program page references them so scope can't drift from reality. |
| Vault backend API | `backend/vault/` | Authentication, authorization, and custody-affecting endpoints. |
| Vault frontend surfaces | `src/features/vault/` | Transaction construction, signing prompts, and custody-affecting UI. |

Deployed contract IDs and code hashes are the source of truth for what is in
scope. **Testnet-only deployments do not qualify** for a reward unless the
program page explicitly lists them; mainnet deployments referenced from the
verified-build registry are in scope.

### Out of scope

- The third-party audit engagement itself and its findings.
- Contract-level hardening work already tracked in the repo.
- Issues in dependencies that are already covered by an upstream advisory
  (report upstream instead).
- Reports about known, already-filed issues: these are acknowledged and
  linked to the existing issue, but are not eligible for a reward.
- Social engineering, physical attacks, and denial-of-service against
  production infrastructure.

### Safe harbour

We will not pursue legal action against researchers who act in good faith,
stay within the in-scope assets above, avoid privacy violations and data
destruction, and give us reasonable time to remediate before public
disclosure. If a third party brings action against you for research that
follows this policy, we will make it known that your conduct was authorised.

### Payouts

Rewards are paid in the currency and through the process described on the
program page, and are subject to the same sanctions/AML screening applied
elsewhere in the project. Reports that fail screening are not paid.

---

## Dependency security (supply chain)

### Threat model

A DeFi frontend is a high-value supply-chain target. If an attacker gets code
into the bundle, they can rewrite transaction prompts and drain connected
wallets. The attacks we defend against:

| # | Threat | Example |
|---|---|---|
| T1 | A known-vulnerable dependency ships to users | A prototype-pollution or ReDoS advisory in a transitive package |
| T2 | A compromised maintainer publishes a malicious version | The `event-stream` / `ua-parser-js` / `@ledgerhq/connect-kit` incidents |
| T3 | A malicious install script runs on a developer or CI machine | Token theft or a backdoored build from `postinstall` |
| T4 | Lockfile injection: a PR swaps a resolved URL or integrity hash | `resolved` points at an attacker registry and the diff is easy to overlook |
| T5 | Dependency confusion or typosquatting | A package name that resolves from an unexpected host |
| T6 | A license incompatible with how we distribute | GPL code in the shipped bundle, or a package with no license |

### Controls

| Control | Where | Mitigates | Purpose |
|---|---|---|---|
| **Audit gate** | `security.yml` → `audit`, `scripts/security/audit-gate.mjs` | T1 | Fails on **high** or **critical** advisories from `npm audit`. Waivers go in `security/audit-exceptions.json`. Each waiver needs a GHSA id, a reason, an approver, and an expiry date no more than 90 days out. Expired waivers stop working and CI fails. The job also runs daily, so new advisories fail even when the code hasn't changed. |
| **OSV-Scanner** | `security.yml` → `osv` | T1 | A second, independent advisory database (OSV aggregates GHSA and ecosystem feeds). Ignores go in `osv-scanner.toml` with a reason and an expiry. |
| **Minimum release age of 3 days** | `renovate.json` | T2 | Most malicious releases are found and unpublished within hours. Waiting 3 days before proposing an update removes most of that window. Security fixes skip the wait. |
| **Reviewed updates; auto-merge only for dev-dependency patches** | `renovate.json` | T2 | Runtime dependencies, and anything wallet-, signing- or chain-related (`security-critical` label), always get a human review. Only `devDependencies` patch updates auto-merge, and only after required CI passes. |
| **`ignore-scripts=true`** | `.npmrc` | T3 | npm never runs dependency lifecycle scripts implicitly. |
| **Install-script allowlist** | `package.json` → `lavamoat.allowScripts`, `npm run setup` | T3 | `@lavamoat/allow-scripts` fails CI if any dependency has install scripts that aren't in the allowlist. It then runs only the scripts marked `true`. `@lavamoat/preinstall-always-fail` makes installs break loudly on any machine where `ignore-scripts` got turned off. |
| **`npm ci` only** | `security.yml` → `lockfile` | T2, T4 | Installs exactly what the lockfile says. CI rejects `npm install` in workflows and the Dockerfile, and fails if `package.json` and the lockfile disagree. |
| **lockfile-lint** | `security.yml` → `lockfile`, `npm run security:lockfile` | T4, T5 | Every `resolved` URL must be on `registry.npmjs.org` over HTTPS. Every entry must have an integrity hash and a package name that matches its URL. |
| **Lockfile-only change flag** | `security.yml` → `lockfile` | T4 | A PR that changes `package-lock.json` without changing `package.json` fails. A maintainer can pass it by adding the `lockfile-only-change` label after reviewing the diff. Renovate's monthly lock maintenance PRs carry this label. |
| **Exact pins** | `.npmrc save-exact`, Renovate `rangeStrategy: pin` | T2 | New dependencies are pinned exactly, so a version only changes through a reviewed PR. |
| **License gate** | `security.yml` → `licenses`, `scripts/security/check-licenses.mjs`, `security/license-policy.json` | T6 | Evaluates each package's SPDX expression against an allowlist of permissive licenses. It rejects strong copyleft (GPL, AGPL, SSPL) and unknown or missing licenses. Reviewed exceptions expire. |

### Packages that need install scripts

All current lifecycle scripts are **denied** (`false`). Each package has a
prebuilt binary or a JS fallback:

| Package (path) | Why it has a script | Decision |
|---|---|---|
| `…>@near-js/crypto>secp256k1` | Native build via node-gyp-build | `false`. Falls back to the pure-JS `elliptic`. |
| `…>ws>bufferutil`, `…>ws>utf-8-validate` | Optional native speed-ups | `false`. `ws` works without them. |
| `…>jest-haste-map>@parcel/watcher` | Builds from source only if no prebuild exists | `false`. Uses the prebuilt optional packages. |
| `…>eslint-import-resolver-typescript>unrs-resolver` | Fixes up napi optional binaries | `false`. Optional platform packages are installed normally. |
| `tailwindcss>chokidar>fsevents` | macOS-only native watcher | `false`. Prebuilt. |
| `@creit.tech/stellar-wallets-kit>@reown/appkit` | postinstall | `false`. Not needed at runtime. |

To add a package that genuinely needs its script (for example `esbuild`,
which downloads a platform binary):

1. `npm install` it (scripts won't run).
2. Run `npx allow-scripts auto`. This adds the package's canonical path to
   `lavamoat.allowScripts` as `false`.
3. Read the package's `install` or `postinstall` script. If it's required,
   set the entry to `true` and explain why in the PR.
4. Run `npm run setup` to execute the allowlisted scripts.

### Local workflow

```sh
npm ci            # installs, runs no scripts
npm run setup     # runs only the allowlisted install scripts
npm run security:audit
npm run security:lockfile
npm run security:licenses
```

### Demonstrating the gate

To check that the audit gate actually blocks something:

```sh
git switch -c demo/vulnerable-dep
npm install --save-exact lodash@4.17.20     # GHSA-35jh-r3h4-6jhm (command injection, HIGH)
node scripts/security/audit-gate.mjs        # exits 1: "HIGH lodash GHSA-35jh-r3h4-6jhm …"
```

Opening that branch as a PR shows `Security / Dependency audit` failing. The
`lockfile` job also flags the lockfile change. Attach that CI run to the PR
that introduces these controls as gate-failure evidence, then close the demo
PR without merging.

---

## Untrusted content (XSS)

User-generated and backend-provided content is untrusted: proposal markdown,
delegate statements, strategy descriptions, backend error strings, and token
and asset metadata. There is one place to render each kind:

| Content | Render with |
|---|---|
| Markdown | `<SafeMarkdown>` (`src/components/SafeMarkdown.tsx`) |
| Plain strings, including backend errors | `safeText()` / `<SafeText>` (`src/lib/sanitize.ts`) |
| Stellar addresses | `<SafeAddress>`: homoglyphs and zero-width characters are shown explicitly |
| Display names, asset codes | `<SafeName>`: bidi isolation plus a mixed-script warning |
| URLs from data | `safeUrl()`: absolute `http(s)` only, no credentials |

`SANITIZE_SCHEMA` (`src/lib/sanitize.ts`, `SANITIZE_SCHEMA_VERSION`) is the
only sanitize schema. It allows no raw HTML, no `style`, `class`, `id` or
`on*` attributes, and only http(s) and mailto links. Links get
`rel="noopener noreferrer nofollow"`. Images render only from
`TRUSTED_IMAGE_ORIGINS` (the image proxy); otherwise they're replaced by
their alt text. Any change to the schema bumps the version and needs a
security review.

ESLint enforces the following (`.eslintrc.json`):
`react/no-danger`, allowed only in `src/components/TrustedHtml.tsx`, which
accepts only interpolation-free build-time literals; `react/jsx-no-script-url`
and `no-script-url`; `react/jsx-no-target-blank`; bans on `innerHTML`,
`outerHTML`, `insertAdjacentHTML`, `createContextualFragment` and
`document.write`; and a ban on importing `react-markdown`, `rehype-sanitize`
or `rehype-raw` outside the sanitize layer.

The corpus in `src/test-utils/xssCorpus.ts` holds

/* … truncated 330 chars — edit only what you need near the top … */
