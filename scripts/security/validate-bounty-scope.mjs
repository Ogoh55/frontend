#!/usr/bin/env node
/**
 * validate-bounty-scope.mjs
 * 
 * Verifies that the machine-readable bug bounty asset inventory in docs/security/bug-bounty-program.md
 * stays in 100% sync with the official Soroban contract registry (src/lib/soroban/registry.ts).
 * 
 * If a new contract is added to CONTRACTS or an upgrade is registered, this gate
 * ensures the bug bounty scope is updated simultaneously, preventing drift.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const REGISTRY_PATH = path.join(ROOT, 'src/lib/soroban/registry.ts');
const BOUNTY_DOC_PATH = path.join(ROOT, 'docs/security/bug-bounty-program.md');
const SECURITY_PATH = path.join(ROOT, 'SECURITY.md');

function runCheck() {
  console.log('🔍 Validating Bug Bounty Program scope against contract registry...');

  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`❌ Missing registry file at ${REGISTRY_PATH}`);
    process.exit(1);
  }

  const registryContent = fs.readFileSync(REGISTRY_PATH, 'utf8');

  // Extract keys from CONTRACTS array in registry.ts
  const keyMatches = [...registryContent.matchAll(/key:\s*["']([^"']+)["']/g)].map(m => m[1]);
  if (keyMatches.length === 0) {
    console.error('❌ Failed to parse contract keys from registry.ts');
    process.exit(1);
  }

  console.log(`📋 Found ${keyMatches.length} registered protocol contracts: [${keyMatches.join(', ')}]`);

  if (!fs.existsSync(BOUNTY_DOC_PATH)) {
    console.error(`❌ Bug bounty document missing at ${BOUNTY_DOC_PATH}`);
    process.exit(1);
  }

  const bountyDocContent = fs.readFileSync(BOUNTY_DOC_PATH, 'utf8');
  const securityContent = fs.readFileSync(SECURITY_PATH, 'utf8');

  let missing = 0;
  for (const key of keyMatches) {
    if (!bountyDocContent.includes(key)) {
      console.error(`❌ Contract '${key}' registered in registry.ts is missing from ${BOUNTY_DOC_PATH}`);
      missing++;
    } else {
      console.log(`  ✅ Contract '${key}' verified in bug bounty scope documentation`);
    }
  }

  // Verify critical policy sections exist in docs
  const requiredSections = [
    'Severity Tiers & Reward Bands',
    'Safe Harbour',
    'Triage SLA',
    'Out-of-Scope',
    'Re-scoping & Contract Upgrade Path'
  ];

  for (const sec of requiredSections) {
    if (!bountyDocContent.includes(sec)) {
      console.error(`❌ Missing required policy section '${sec}' in ${BOUNTY_DOC_PATH}`);
      missing++;
    } else {
      console.log(`  ✅ Policy section '${sec}' present`);
    }
  }

  // Verify SECURITY.md references the Bug Bounty Program
  if (!securityContent.includes('Bug Bounty Program') || !securityContent.includes('Safe Harbour')) {
    console.error(`❌ SECURITY.md must reference the Bug Bounty Program and Safe Harbour`);
    missing++;
  } else {
    console.log(`  ✅ SECURITY.md properly references the Bug Bounty Program`);
  }

  if (missing > 0) {
    console.error(`\n❌ Bug bounty scope validation FAILED with ${missing} error(s).`);
    process.exit(1);
  }

  console.log('\n🎉 Bug bounty scope is 100% synchronized and machine-verified against protocol registry!');
}

runCheck();
