# Security Triage & Incident Runbook: Vault Stack

This runbook defines the operational procedure for the Zenith Core Engineering and Security team when handling incoming vulnerability disclosures under the [Bug Bounty Program](bug-bounty-program.md).

---

## 1. Triage Workflow Overview

```
[Inbound Report]
       │
       ▼
[Phase 1: Intake & Acknowledgment] (SLA: ≤ 24 Hours)
  - Generate Report ID (e.g., ZEN-SEC-YYYY-NNN)
  - Verify PGP signature / sender identity
  - Dispatch official acknowledgment
       │
       ▼
[Phase 2: Reproduction & Sandboxing] (SLA: ≤ 48 Hours)
  - Spin up local Soroban sandbox or dev backend
  - Replicate Proof of Concept (PoC)
  - Invalidate report if unproven / out-of-scope
       │
       ▼
[Phase 3: Severity Assessment & Protocol Gate] (SLA: ≤ 72 Hours)
  - Calculate CVSS v3.1 base score
  - Evaluate Vault Risk:
      • If Critical (Direct Vault Drain) ──► Invoke Emergency Multisig Pause
      • If High/Medium/Low ──► Queue for prioritized patch sprint
  - Notify reporter of preliminary severity & bounty eligibility
       │
       ▼
[Phase 4: Remediation & Internal Verification] (SLA: ≤ 14 Days)
  - Open private security patch branch (never push to public fork)
  - Author regression unit/integration test reproducing flaw
  - Execute audit gates (`npm run test`, `cargo test`, `scripts/security/audit-gate.mjs`)
  - Request second-party security review
       │
       ▼
[Phase 5: Mainnet Deployment & Bounty Settlement] (SLA: ≤ 7 Days Post-Deploy)
  - Execute Soroban contract upgrade via `multisig` or deploy backend release
  - Perform sanctions check (OFAC SDN list) on recipient address
  - Disburse bounty in USDC
  - Record payment transaction hash
       │
       ▼
[Phase 6: Coordinated Disclosure & Post-Mortem] (90-Day Embargo)
  - Publish GitHub Security Advisory with CVE ID
  - Add researcher to Zenith Security Hall of Fame
```

---

## 2. Phase-by-Phase Standard Operating Procedures

### Phase 1: Intake & Logging
1. **Intake Monitoring:**
   - GitHub Private Security Advisories (`https://github.com/Zenith-options/frontend/security/advisories`)
   - Encrypted email to `security@zenith-options.org`
2. **Ticket Creation:**
   - Assign tracking ID: `ZEN-SEC-YYYY-NNN`.
   - Log timestamp, reporter handle, reported components, and initial claims.
3. **Acknowledgment Message (Send within 24h):**
   > "Thank you for contacting the Zenith Security Team. We have received your report regarding [Asset Name] and assigned it tracking ID `ZEN-SEC-YYYY-NNN`. Our engineering team is reviewing the submission under our Bug Bounty Program guidelines. You will receive an initial triage assessment within 72 hours."

### Phase 2: Reproduction in Isolation
1. **Rule of Isolation:** NEVER execute unverified exploit payloads against production networks or live collateral vaults.
2. **Local Environment:**
   ```bash
   # Clone to isolated workspace
   git checkout -b sec/ZEN-SEC-YYYY-NNN
   
   # For contract tests (Soroban):
   cargo test --test exploit_poc
   
   # For frontend/API tests:
   npm run test
   ```
3. **Validation Criteria:**
   - Does the PoC demonstrate a breach of contract invariants or security boundaries?
   - Can an unauthorized actor profit or cause irreversible collateral loss?
   - If reproduction fails, request clarification from researcher within the 72h window.

### Phase 3: Severity Scoring Matrix

Severity is determined by combining CVSS v3.1 with protocol economic impact:

| Metric | Critical | High | Medium | Low |
|---|---|---|---|---|
| **CVSS v3.1 Score** | 9.0 – 10.0 | 7.0 – 8.9 | 4.0 – 6.9 | 0.1 – 3.9 |
| **Custody Impact** | Direct vault drain / theft | Temporary lock > 24h | Event drift, no loss | Dust rounding discrepancy |
| **Bounty Band** | **$10,000 – $25,000** | **$3,000 – $7,500** | **$1,000 – $2,500** | **$250 – $500** |
| **Emergency Action** | **Multisig Pause Required** | Engineering Sprint | Scheduled Release | Routine Hygiene |

### Phase 4: Patching & Verification
1. Implement fix in private security advisory branch.
2. Add a non-regression test proving that the exploit vector is blocked.
3. Verify that all standard test suites and linting pass with zero warnings:
   ```bash
   npm run lint
   npm run test
   node scripts/security/validate-bounty-scope.mjs
   ```

### Phase 5: Payout Settlement
1. Request recipient wallet address (Stellar or EVM).
2. Execute automated sanctions check against US OFAC SDN and global AML blacklists.
3. Disburse approved USDC reward from the Zenith Community Security Reserve.
4. Provide transaction hash to the researcher.

### Phase 6: Disclosure & Advisory
1. Agree with researcher on advisory text and release date.
2. Publish GitHub Security Advisory with remediation details.
3. Update `CHANGELOG.md` and release notes.
