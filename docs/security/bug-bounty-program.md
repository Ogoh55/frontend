# Zenith Vault Stack Bug Bounty Program & Vulnerability Disclosure Policy

## 1. Program Overview

The Zenith Protocol operates decentralized options markets and custody-bearing collateral vaults on Stellar (Soroban). An audit is a point-in-time assessment; custody-bearing smart contracts and trading infrastructure require continuous, adversarial examination by independent security researchers.

To protect user collateral and reward security researchers for responsible disclosure, Zenith maintains this public **Bug Bounty Program and Coordinated Vulnerability Disclosure (CVD)** framework.

- **Intake Channel:** GitHub Private Security Advisory on `Zenith-options/frontend` or encrypted email to `security@zenith-options.org`
- **Maximum Bounty Payout:** **$25,000 USD / USDC**
- **Payment Currencies:** USDC (Stellar / EVM Base / Polygon / Ethereum) or direct wire transfer
- **Safe Harbour:** Full legal immunity for good-faith researchers adhering to this policy

---

## 2. In-Scope Assets

The program scopes coverage across the three tiers of the Zenith protocol:

### A. Smart Contracts (Soroban Core)
Directly bound to the machine-readable contract registry in [`src/lib/soroban/registry.ts`](../../src/lib/soroban/registry.ts) and the live [`/contracts.json`](../../src/app/contracts.json/route.ts) endpoint:

| Contract Key | Module Name | Primary Responsibility | Invariant / Critical Failure Mode |
|---|---|---|---|
| `vault` | **Vault Contract** | Per-tag collateral escrow ledger. Scopes `deposit` and `withdraw` to caller-defined tags. | A withdrawal drawing down more than was specifically deposited under that tag, unauthorized tag transfers, or insolvency. |
| `options_market` | **Options Market** | European-style options on XLM, BTC, ETH, and SOL. Collateral locking, premium transfer, and settlement at expiry. | Premature settlement, miscalculated exercise payoff, unlocked collateral before expiry, unauthorized position cancellation. |
| `price_oracle` | **Price Oracle** | Median price aggregation across authorized feeders with quorum gating. | Feeder manipulation bypassing quorum, stale price replay, zero-price arithmetic panics. |
| `multisig` | **Multisig Governance** | M-of-N threshold approval tracking for administrative protocol actions. | Unauthorized action execution, signature bypass, threshold subversion, replay attacks across action IDs. |

### B. Vault Backend Infrastructure
- **REST Order & Position APIs:** Order placement, quote generation, positions ledger, and settlement dispatch (documented in [`ORDER_TICKET_BACKEND.md`](../../ORDER_TICKET_BACKEND.md)).
- **WebSocket Streaming Engine:** Live price tick streams, order execution broadcasts, and risk parameter updates.
- **Ledger Verification Services:** On-chain transaction monitor syncing Soroban ledger events with client state.

### C. Frontend Surfaces & Client Security
- **Web Application:** Production deployment at `app.zenith-options.org` and preview staging environments.
- **Transaction Clear-Signing:** Integrity of transaction construction prior to wallet submission (ensuring amounts, destination addresses, and Soroban contract auth arguments are never spoofed).
- **Sanitization & Content Security:** Prevention of XSS, prototype pollution, or DOM injection that could tamper with signing payloads (governed by [`SECURITY.md`](../../SECURITY.md) and [`src/lib/sanitize.ts`](../../src/lib/sanitize.ts)).

---

## 3. Severity Tiers & Reward Bands

Rewards are scaled based on the actual business impact, financial risk to user funds, and reproducibility of the vulnerability according to the **Common Vulnerability Scoring System (CVSS v3.1)** combined with smart-contract specific criteria:

| Severity Tier | Reward Range (USD / USDC) | Impact & Failure Mode Examples |
|---|---|---|
| **Critical** | **$10,000 – $25,000** | - Direct permanent loss or theft of user funds from the `vault` contract.<br>- Unauthorized withdrawal draining collateral without a matching valid tag.<br>- Complete protocol insolvency or irreversible fund freezing.<br>- Remote code execution (RCE) on backend infrastructure with access to signing keys.<br>- Exploitation of the `options_market` allowing arbitrary minting or burning of option positions without collateral. |
| **High** | **$3,000 – $7,500** | - Temporary freezing or griefing of vault withdrawals exceeding 24 hours.<br>- Price oracle quorum bypass allowing price feed manipulation within a single block/epoch.<br>- Authorization bypass on backend API permitting execution of trades on behalf of other users.<br>- Frontrunning attacks extracting risk-free arbitrage from user settlement transactions.<br>- Client-side transaction prompt injection rewriting the recipient contract ID. |
| **Medium** | **$1,000 – $2,500** | - Accounting drift in historical ledger events not resulting in direct fund loss.<br>- Denial-of-service (DoS) against public RPC or price feeder endpoints.<br>- Logic error in European option exercise timing window (e.g. 1-minute drift).<br>- Stored XSS requiring non-standard user interaction in authenticated sessions. |
| **Low** | **$250 – $500** | - Precision rounding errors in fee calculations below dust threshold.<br>- Non-sensitive information disclosure (e.g. backend server headers, nonces).<br>- UI display desynchronization causing misleading quote estimates before signing. |

---

## 4. Out-of-Scope Categories

To preserve engineering focus for high-impact security vulnerabilities, the following issues are strictly excluded from reward eligibility:

1. **Denial of Service:** Volumetric network-level DDoS or application stress tests that merely exhaust public bandwidth without exploiting an algorithmic flaw.
2. **Social Engineering & Phishing:** Attacks targeting Zenith employees, contributors, contractors, or community members (e.g., spear-phishing, credential stuffing, SIM swapping).
3. **Third-Party Wallet Client Defects:** Bugs residing exclusively within external wallet extensions (Freighter, Albedo, xBull, Metamask) rather than our SDK integration layer.
4. **Testnet-Only Faucet & Quotas:** Exploits against testnet token distribution faucets, testnet rate limits, or manipulation of testnet collateral that does not affect mainnet security invariants.
5. **Physical & Local Attacks:** Attacks requiring physical access to a user's unlocked device or malware already executing in the host operating system.
6. **Known & Publicly Disclosed Issues:** Any issue previously identified in published audit reports, active public GitHub issues, or already submitted by another researcher.

---

## 5. Safe Harbour & Legal Protection

Zenith considers security research conducted under this policy to be **authorized, legal, and protected**. We commit to the following safe-harbour guarantees:

- **No Legal Action:** Zenith will not initiate civil lawsuits or contact law enforcement against researchers for accidental or good-faith security testing conducted within the rules of this program.
- **Safe Harbour Compliance:** If a third party initiates legal action against you for activities conducted under this policy, Zenith will issue a public statement confirming that your actions were authorized by the protocol.
- **Researcher Expectations:**
  - Do not intentionally damage or degrade protocol availability for real users.
  - Do not access, modify, or retain customer personal data or private trading history.
  - Stop testing immediately and file a report once a Proof of Concept (PoC) demonstrating impact is confirmed.
  - Do not extort, demand ransom, or threaten public disclosure.

---

## 6. Triage SLA Commitments

We understand that researchers dedicate significant expertise and time to our protocol. We guarantee strict timeline adherence:

```
[T+0h] Intake Received ──► [T+24h] Initial Acknowledgment ──► [T+72h] Triage & Severity Assignment ──► [T+14d] Remediation Patched & Deployed ──► [T+90d] Coordinated Disclosure
```

- **Initial Acknowledgment:** ≤ **24 hours** from submission.
- **Triage & Severity Rating:** ≤ **72 hours** from acknowledgment, with initial reward assessment.
- **Remediation Target:** ≤ **14 business days** for Critical/High findings.
- **Bounty Settlement:** Disbursed within **7 business days** of fix verification.
- **Coordinated Disclosure Embargo:** 90 calendar days from report submission, or 7 days after the patch is deployed to mainnet (whichever comes first).

---

## 7. Payout Terms & Sanctions Compliance

1. **Reward Calculation:** Bounties are nominated in USD and paid in **USDC** (on Stellar, Base, Polygon, or Ethereum) or direct bank transfer upon mutual agreement.
2. **KYC & Sanctions Screening:** In compliance with international AML regulations (OFAC / FATF), payout recipients must not appear on international sanctions lists (e.g., OFAC SDN, UK HM Treasury, EU Sanctions).
3. **First-Come, First-Served:** In the event of duplicate reports for the same root cause, the reward will be awarded exclusively to the first reproducible submission received.

---

## 8. Re-scoping & Contract Upgrade Path

The Zenith protocol is designed for modular, verifiable upgrades via Soroban contract migration. The bug bounty scope tracks protocol changes automatically:

1. **Canonical Registry Alignment:** All valid smart contract deployments are declared in `src/lib/soroban/registry.ts` and output via `/contracts.json`.
2. **Upgrade History:** Whenever a contract executes `upgrade(new_wasm_hash)`, the update is appended to the contract's `upgradeHistory` array including:
   - `version`
   - `wasmHash`
   - `deployedAt`
   - `sourceCommit`
3. **Automatic Scope Transition:**
   - Any new WASM hash committed to `registry.ts` enters bug bounty scope immediately upon on-chain deployment.
   - Deprecated WASM versions remain in scope for 30 calendar days post-upgrade to allow identification of potential migration vulnerabilities.
   - The validation script `npm run security:bounty-scope` gates continuous integration to prevent documentation drift.
