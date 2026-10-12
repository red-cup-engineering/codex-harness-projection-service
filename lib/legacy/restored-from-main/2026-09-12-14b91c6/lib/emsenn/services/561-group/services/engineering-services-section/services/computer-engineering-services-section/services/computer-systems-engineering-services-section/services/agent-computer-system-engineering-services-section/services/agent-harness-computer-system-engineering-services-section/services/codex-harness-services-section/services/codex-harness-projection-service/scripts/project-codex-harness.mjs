#!/usr/bin/env node
import { resolve } from "node:path";
import { projectCodexHarness } from "../src/projector.mjs";

if (process.argv.length !== 4) {
  process.stderr.write("usage: project-codex-harness <actor-configuration.json> <explicit-output-directory>\n");
  process.exit(2);
}
const configurationPath = resolve(process.argv[2]);
const target = resolve(process.argv[3]);
process.stdout.write(`${JSON.stringify(projectCodexHarness({ configurationPath, target }), null, 2)}\n`);
