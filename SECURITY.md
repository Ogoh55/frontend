# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly by emailing the maintainers rather than opening a public issue. We will acknowledge receipt and work with you on a coordinated disclosure.

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

## Scope

This policy covers the on-chain vault contracts, the vault backend services, and the depositor-facing vault UI in `src/`.

## Depositor Data Retention, Deletion, and Privacy

Vaults accumulate off-chain records that are not purely on-chain: notification addresses, eligibility acknowledgements, support interactions, and analytical event streams that can be joined back to a wallet. This section defines how that data is classified, retained, deleted, and exported. The authoritative field-level inventory lives in [`docs/data-inventory.md`](docs/data-inventory.md).

### Data classification

- **On-chain (immutable) ledger data** — deposits, withdrawals, balances, strategy allocations, and the events derived from them. This is public, immutable, and required for reconciliation and audit. It is **never** deleted or anonymized by a deletion request.
- **Off-chain personal data** — alert/notification email addresses, signed disclosure acknowledgements, support interactions, and analytics events that can be joined back to a wallet. This is mutable and is the target of retention and deletion workflows.

Personal data is stored as an **opaque wallet reference** plus a separately-stored, deletable contact record, rather than denormalized PII embedded in ledger rows. This lets deletion target the contact record without corrupting reconciliations.

### Retention windows

Ephemeral off-chain data is purged or anonymized automatically on a schedule:

| Data | Retention | Action |
| --- | --- | --- |
| Notification delivery logs | 30 days | Purge |
| Analytics events | 90 days | Anonymize (strip wallet reference) |
| Support interactions | 24 months | Purge |
| Signed disclosure acknowledgements | Life of account + 24 months | Retain (audit) |
| Contact / alert email records | Until deletion request or account closure | Delete on request |

Purges are observable (logged with counts and window) and are reversible only via backup restores. A purge job must never touch on-chain-derived ledger or accounting data; the retention job operates only on the ephemeral tables listed above.

### Deletion request workflow

1. **Verified request** — the requester proves control of the wallet (signature over a challenge).
2. **Delete or anonymize** — deletable off-chain fields (contact records, notification logs, analytics joins, support interactions) are deleted or anonymized. Cascading references across services are handled gracefully; missing references do not abort the workflow.
3. **Preserve required records** — financial and audit records are retained in a documented, minimized form. Records under legal hold are **flagged** rather than silently dropped.
4. **Receipt** — a confirmation is returned to the requester summarizing what was deleted, anonymized, and retained (and why).

### Data export

A depositor can request an export of the vault-related records held for their wallet. The export includes off-chain personal data we hold plus a reference to the on-chain ledger data (which is already public). Exports are scoped to the requesting wallet only.

### Privacy notice

The depositor-facing privacy notice on the vault surfaces is consistent with this policy and is linked from the vault pages.

### Out of scope

This policy does not define a KYC/AML identity program and does not constitute jurisdictional legal advice.

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
