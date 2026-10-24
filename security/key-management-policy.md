# Vault Admin Key Custody Policy

This document defines how the vault suite's privileged signing keys are held, used, and rotated. It is the operational counterpart to the timelock/multisig approval workflow: that workflow decides *whether* a change is approved; this policy decides *how* the signature is produced and kept safe.

## 1. Core Principles

- **No privileged secret material in application code, the repository, CI variables, or container images.** All vault admin/operator signing goes through a KMS/HSM-backed signer abstraction. Application code never reads raw key material.
- **Narrow signing API.** The signer exposes only a "sign this approved intent" operation. There is no raw "sign arbitrary bytes" primitive. Intents are validated against the role policy server-side before KMS/HSM is invoked, and only the signature is returned.
- **Deny by default.** Anything not explicitly allowlisted for a role is rejected at the signing boundary.
- **Roles are independent.** Each role has its own key and can be rotated or revoked without touching the others and without redeploying the contracts.

## 2. Role Separation

Distinct keys are provisioned for each role below. A key belongs to exactly one role.

| Role | Purpose | Typical entry points |
| --- | --- | --- |
| `contract-admin` | Contract admin / upgrade authority | upgrade, set_admin, migrate |
| `parameter-control` | Strategy and parameter control | set_strategy_params, set_strike_authority, set_oracle_authority |
| `oracle-submission` | Oracle price/observation submission | submit_price, submit_observation |
| `emergency-pause` | Emergency pause / unpause | pause, unpause |
| `treasury` | Treasury movement | withdraw_treasury, transfer_fees |

Each role is independently rotatable and revocable (see §5).

## 3. Per-Role Policy Enforcement

Every signing request is validated at the signing boundary against the role's policy before the KMS/HSM is called. A request is rejected unless **all** of the following hold:

1. **Allowed contract IDs** — the target contract is in the role's allowlist.
2. **Allowed entry points** — the target entry point is in the role's allowlist.
3. **Value/amount ceilings** — any amount carried by the intent is within the role's configured ceiling.
4. **Deny by default** — any field not covered by an explicit allowlist rule causes rejection.

Rejections are returned to the caller as a policy error; no signature is produced and no KMS/HSM call is made.

## 4. Signing Flow

1. Caller submits an approved intent (role, contract ID, entry point, arguments, amount, request hash) to the signing service.
2. The service authenticates the caller and resolves the role policy.
3. The intent is validated against the policy (§3). On failure, the request is denied and logged.
4. On success, the service invokes the KMS/HSM with the intent digest and returns only the signature.
5. The signature is logged to the administrative audit trail (§6).

### Local development

Contributors use a clearly-labeled **software key** path that implements the same interface and the same policy checks. It is never used in staging or production, and its keys are generated locally and never committed.

## 5. Rotation and Revocation

Rotation is a routine operation, not a crisis response.

1. **Provision** the new key for the role in the KMS/HSM and register it in the role policy alongside the old key.
2. **Confirm** the new key works by signing a test intent and verifying the signature against the expected address.
3. **Cut over** the role policy to prefer the new key.
4. **Revoke** the old key only after the new key is confirmed working. Never revoke before confirmation (partial rotation is the primary failure mode).
5. **Record** the rotation in the audit trail with role, old key ID, new key ID, operator, and timestamp.

Revocation removes a role's key from the policy and disables it in the KMS/HSM. Revocation does **not** require redeploying the contracts; the on-chain authorization model is unchanged.

### Multi-signer roles

Roles that require multisig coordination (e.g. `contract-admin`, `treasury`) hold one key per signer. Each signer's key is subject to the same role policy, and the signing service coordinates collection of the required signatures for an approved intent.

## 6. Audit Logging

Every privileged signature attempt — successful or denied — is logged to the administrative audit trail with:

- role
- caller identity
- target contract ID and entry point
- request hash
- outcome (signed / denied / error)

Audit-log gaps during outages are treated as incidents; the signing service fails closed (denies signing) if it cannot write the audit record.

## 7. Edge Cases and Constraints

- **KMS/HSM unavailability or latency during an epoch transition:** the signing service fails closed and surfaces a clear error; it does not fall back to software keys outside local development.
- **Partial rotation:** old keys are revoked only after the new key is confirmed working (§5).
- **Multi-signer coordination:** the service tracks which signers have contributed to an intent and rejects duplicate or out-of-policy contributions.
- **Audit-log gaps during outages:** signing fails closed when the audit trail is unavailable.
- **Disaster recovery:** if the primary region's key store is unreachable, the service fails closed and operators follow the documented DR procedure to promote the replica key store; keys are never exported to application-readable storage.

## 8. Testing Requirements

- Unit tests for policy allow/deny per role, including amount ceilings and disallowed entry points.
- Integration tests against a KMS emulator or interface stub.
- A rotation drill test proving the old key is rejected after rotation.
- Negative tests asserting no secret material is readable via the application config surface.

## 9. Out of Scope

The approval/timelock workflow itself and the contract-side authorization model (covered by the Soroban authorization scoping issue) are out of scope for this policy.
