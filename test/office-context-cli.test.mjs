import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("the office CLI projects the configured resource consumer without trusting it", t => {
  const root = mkdtempSync(join(tmpdir(), "office-context-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agency = join(root, "agency");
  mkdirSync(join(agency, "offices"), { recursive: true }); mkdirSync(join(root, ".codex"));
  writeFileSync(join(agency, "offices/fixture.json"), JSON.stringify({ id: "fixture", name: "Source-only fixture" }));
  const binding = join(root, ".codex/office.json");
  writeFileSync(binding, JSON.stringify({ type: "SourceOfficeContextProjection", authority: "source-context-only", agencyRoot: agency, office: "fixture", target: "../office-context.md", hostResources: { node: "..", providers: ["codex"] } }));
  const script = fileURLToPath(new URL("../scripts/project-office-context.mjs", import.meta.url));
  const received = spawnSync(process.execPath, [script, binding], { encoding: "utf8", timeout: 5000 });
  assert.equal(received.status, 0, received.stderr);
  const result = JSON.parse(received.stdout);
  assert.equal(result.resources.codexTrustRequired, true); assert.equal(result.resources.activeSessionGuarded, false);
  const hook = JSON.parse(readFileSync(join(root, ".codex/hooks.json"))).hooks.PreToolUse[0].hooks[0];
  // The projection names the harness's hook as installed beside this service: a real file, run by node.
  const named = /'([^']*\/src\/host-resource-hook\.mjs)'/u.exec(hook.command)?.[1];
  assert.ok(named !== undefined && existsSync(named), hook.command);
  assert.match(hook.command, /--provider codex$/u);
  assert.match(readFileSync(join(root, ".codex/config.toml"), "utf8"), /hooks = true/);
});
