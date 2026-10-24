#!/usr/bin/env node
// Guards rollout-controlled flags against silent default changes.
//
// The registry default in src/lib/flags/registry.ts is what production runs
// when remote config is absent. A change to it must come with a matching
// change to src/lib/flags/rollout.json, which records the rollout stage the
// default belongs to. Fails when the two disagree.

import { readFileSync } from "node:fs";

const REGISTRY = "src/lib/flags/registry.ts";
const ROLLOUT = "src/lib/flags/rollout.json";

const registry = readFileSync(REGISTRY, "utf8");
const rollout = JSON.parse(readFileSync(ROLLOUT, "utf8"));

let failed = false;

for (const [name, config] of Object.entries(rollout)) {
  // defaultValue is the first one after `name: "<flag>"` in the registry.
  const match = registry.match(new RegExp(`name: "${name}",[\\s\\S]*?defaultValue: (true|false),`));
  if (!match) {
    console.error(`✖ ${name}: no registry entry with a defaultValue in ${REGISTRY}`);
    failed = true;
    continue;
  }

  const registryDefault = match[1] === "true";
  if (registryDefault !== config.defaultValue) {
    console.error(
      `✖ ${name}: registry defaultValue is ${registryDefault} but ${ROLLOUT} records ${config.defaultValue}.\n` +
        `  Changing a production default requires updating ${ROLLOUT} (and the rollout runbook) in the same PR.`,
    );
    failed = true;
    continue;
  }

  if (!config.stages.includes(config.stage)) {
    console.error(`✖ ${name}: stage "${config.stage}" is not one of ${config.stages.join(", ")}`);
    failed = true;
    continue;
  }

  console.log(`✔ ${name}: default ${registryDefault}, stage ${config.stage}`);
}

process.exit(failed ? 1 : 0);
