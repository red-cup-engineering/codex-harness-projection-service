#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { projectOfficeContext } from "../src/projector.mjs";
import { writeHostResourceControl } from "@red-cup-engineering/agent-harness-computer-system-engineering-services-section/host-resource-hook";

if (process.argv.length !== 3) throw new Error("usage: project-office-context <project-office.json>");
const file = resolve(process.argv[2]);
const config = JSON.parse(readFileSync(file, "utf8"));
if (config.type !== "SourceOfficeContextProjection" || config.authority !== "source-context-only") throw new Error("expected source-only office context binding");
// The binding may name where the briefing goes. Codex's workspace-write sandbox holds `.codex` read-only, so a binding
// placed there names a target outside it; the default stays the binding's sibling for bindings that are projected before the sandbox.
const target = resolve(dirname(file), config.target ?? "office-context.md");
try {
  const declaredProject = config.projectRoot ?? config.hostResources?.node;
  const result = projectOfficeContext({ agencyRoot: resolve(dirname(file), config.agencyRoot), office: config.office, target, detail: config.detail ?? "full", ...(declaredProject === undefined ? {} : { projectRoot: resolve(dirname(file), declaredProject) }) });
  const resources = config.hostResources === undefined ? undefined : writeHostResourceControl({ node: resolve(dirname(file), config.hostResources.node), providers: config.hostResources.providers ?? ["codex"] });
  console.log(JSON.stringify({ office: result.office, duties: result.duties, skills: result.skills, rules: result.rules, target: result.target, written: result.written, ...(result.discovery === undefined ? {} : { discovery: result.discovery }), ...(resources === undefined ? {} : { resources }) }));
} catch (error) {
  if (error?.code !== "OFFICE_CONTEXT_STALE") throw error;
  console.error(error.message);
  process.exitCode = 3;
}
