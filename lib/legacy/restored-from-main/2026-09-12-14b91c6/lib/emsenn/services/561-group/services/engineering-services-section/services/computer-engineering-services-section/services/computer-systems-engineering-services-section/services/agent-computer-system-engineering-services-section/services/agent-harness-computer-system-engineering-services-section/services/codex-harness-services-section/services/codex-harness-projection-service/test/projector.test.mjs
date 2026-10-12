import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverOperationSources, projectCodexHarness, projectCodexHooks, projectCodexMcpServerConfiguration, projectRepositoryCodexHarness } from "../src/projector.mjs";

const configurationPath = join(import.meta.dirname, "fixtures/bare-cedar-fog-codex/config.json");

test("projects only disposable runtime files and removes generated skill state", (t) => {
  const target = mkdtempSync(join(tmpdir(), "codex-harness-projection-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const contaminated = join(target, "skills/handwritten/SKILL.md");
  mkdirSync(join(target, "skills/handwritten"), { recursive: true });
  writeFileSync(contaminated, "knowledge stranded in generated state\n");
  const projection = projectCodexHarness({ configurationPath, target });
  assert.equal(existsSync(join(target, "skills")), false);
  assert.deepEqual(projection.files, ["config.toml", "hooks.json"]);
  const hooks = JSON.parse(readFileSync(join(target, "hooks.json"), "utf8")).hooks;
  for (const event of ["SessionStart", "UserPromptSubmit", "SubagentStart"]) {
    assert.equal(hooks[event][0].hooks[0].additionalContextLimit, 512, event);
  }
  assert.equal(hooks.SubagentStop[0].hooks[0].additionalContextLimit, undefined);
  assert.equal(projection.files.some((path) => path.startsWith("skills/")), false);
});

test("projects an owned hook slice while preserving unrelated project hooks", (t) => {
  const target = mkdtempSync(join(tmpdir(), "codex-hooks-projection-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  mkdirSync(join(target, ".codex"), { recursive: true });
  writeFileSync(join(target, ".codex/hooks.json"), `${JSON.stringify({ description: "local", hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "local-post" }] }] } })}\n`);
  const projection = { description: "actor", hooks: { Stop: [{ hooks: [{ type: "command", command: "actor-stop" }] }] } };
  assert.equal(projectCodexHooks({ target, projection }).changed, true);
  const installed = JSON.parse(readFileSync(join(target, ".codex/hooks.json"), "utf8"));
  assert.equal(installed.description, "local");
  assert.equal(installed.hooks.PostToolUse[0].hooks[0].command, "local-post");
  assert.equal(installed.hooks.Stop[0].hooks[0].command, "actor-stop");
  assert.equal(projectCodexHooks({ target, projection, check: true }).checked, true);
});

test("hook projection check reports drift without rewriting it", (t) => {
  const target = mkdtempSync(join(tmpdir(), "codex-hooks-projection-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const projection = { hooks: { Stop: [{ hooks: [{ type: "command", command: "actor-stop" }] }] } };
  projectCodexHooks({ target, projection });
  const path = join(target, ".codex/hooks.json");
  writeFileSync(path, "{}\n");
  assert.throws(() => projectCodexHooks({ target, projection, check: true }), /stale or missing/u);
  assert.equal(readFileSync(path, "utf8"), "{}\n");
});

test("hook projection check is key-order insensitive: same law in a different key order is not drift", (t) => {
  const target = mkdtempSync(join(tmpdir(), "codex-hooks-order-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const projection = { hooks: { Stop: [{ matcher: "x", hooks: [{ type: "command", command: "actor-stop", timeout: 5 }] }] } };
  projectCodexHooks({ target, projection });
  const path = join(target, ".codex/hooks.json");
  const installed = JSON.parse(readFileSync(path, "utf8"));
  const reordered = {
    ...installed,
    hooks: {
      Stop: installed.hooks.Stop.map((group) => ({
        hooks: group.hooks.map((hook) => ({ timeout: hook.timeout, command: hook.command, type: hook.type })),
        matcher: group.matcher,
      })),
    },
  };
  writeFileSync(path, `${JSON.stringify(reordered, null, 2)}\n`);
  assert.equal(projectCodexHooks({ target, projection, check: true }).checked, true);
});

test("projects named MCP tables while preserving unrelated Codex configuration", (t) => {
  const target = mkdtempSync(join(tmpdir(), "codex-mcp-projection-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  mkdirSync(join(target, ".codex"), { recursive: true });
  writeFileSync(join(target, ".codex/config.toml"), "approval_policy = \"never\"\n[features]\nother = true\n[mcp_servers.unmanaged]\nurl = \"http://example.invalid/mcp\"\n");
  const config = "approval_policy = \"never\"\n[mcp_servers.managed]\ncommand = \"node\"\nargs = [\"server.mjs\"]\nenabled_tools = [\"observe\"]\n";
  assert.equal(projectCodexMcpServerConfiguration({ target, config, serverNames: ["managed"] }).changed, true);
  const installed = readFileSync(join(target, ".codex/config.toml"), "utf8");
  assert.match(installed, /\[mcp_servers\.unmanaged\]/u);
  assert.match(installed, /\[mcp_servers\.managed\]/u);
  assert.equal(projectCodexMcpServerConfiguration({ target, config, serverNames: ["managed"], check: true }).checked, true);
});

test("removes only explicitly retired MCP aliases", (t) => {
  const target = mkdtempSync(join(tmpdir(), "codex-mcp-alias-projection-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  mkdirSync(join(target, ".codex"), { recursive: true });
  writeFileSync(join(target, ".codex/config.toml"), '[mcp_servers.retired]\nurl = "http://example.invalid/mcp"\n[mcp_servers.unrelated]\nurl = "http://other.invalid/mcp"\n');
  const config = '[mcp_servers.managed]\nurl = "http://example.invalid/mcp"\n';
  projectCodexMcpServerConfiguration({ target, config, serverNames: ["managed"], obsoleteServerNames: ["retired"] });
  const installed = readFileSync(join(target, ".codex/config.toml"), "utf8");
  assert.doesNotMatch(installed, /mcp_servers\.retired/u);
  assert.match(installed, /mcp_servers\.unrelated/u);
  assert.throws(() => projectCodexMcpServerConfiguration({ target, config, serverNames: ["managed"], obsoleteServerNames: ["unrelated"], check: true }), /obsolete Codex MCP configuration remains/u);
});

test("projects repository instructions, config, and admitted operation skills", (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "codex-harness-repository-"));
  const target = mkdtempSync(join(tmpdir(), "codex-harness-target-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  mkdirSync(join(repoRoot, "owner/scripts"), { recursive: true });
  mkdirSync(join(repoRoot, "owner/agents"), { recursive: true });
  mkdirSync(join(repoRoot, "owner/skills/guide"), { recursive: true });
  mkdirSync(join(target, ".agents/skills/unowned"), { recursive: true });
  mkdirSync(join(target, ".agents/skills/obsolete"), { recursive: true });
  mkdirSync(join(target, ".codex/agents"), { recursive: true });
  mkdirSync(join(target, ".codex/skills/parallel"), { recursive: true });
  writeFileSync(join(target, ".agents/skills/unowned/SKILL.md"), "unowned\n");
  writeFileSync(join(target, ".agents/skills/obsolete/SKILL.md"), "obsolete\n");
  writeFileSync(join(target, ".codex/agents/unowned.toml"), "name = \"unowned\"\n");
  writeFileSync(join(target, ".codex/agents/obsolete.toml"), "name = \"obsolete\"\n");
  writeFileSync(join(target, ".codex/skills/parallel/SKILL.md"), "parallel generated skill\n");
  writeFileSync(join(target, ".codex/.codex-agent-manifest"), "obsolete\nskill:obsolete\n");
  writeFileSync(join(repoRoot, "owner/skills/guide/SKILL.md"), "---\nname: guide\ndescription: Guides the example.\n---\n\n# Guide\n");
  writeFileSync(join(repoRoot, "owner/agents/node-programming.md"), "---\nname: node-programming\ndescription: Projects Node work.\n---\n\n# Node\n\nUse https://registry.561.group.\n");
  writeFileSync(join(repoRoot, "owner/scripts/observe-example.mjs"), `#!/usr/bin/env node
/**
 * Returns one bounded example observation.
 * @summary Observes one bounded example.
 * @returns {object} The observation.
 */
export function observeExample() { return Object.freeze({ observed: true }); }

if (import.meta.main) process.stdout.write(JSON.stringify(observeExample()) + "\\n");
`);

  const projection = projectRepositoryCodexHarness({
    repoRoot,
    target,
    instructions: "# Generated instructions\n",
    config: "approval_policy = \"never\"\n",
    skillSources: ["owner/skills/guide"],
    operationSources: ["owner/scripts/observe-example.mjs"],
    providerAgentSources: ["owner/agents/node-programming.md"],
  });

  assert.equal(readFileSync(join(target, "AGENTS.md"), "utf8"), "# Generated instructions\n");
  assert.equal(readFileSync(join(target, ".codex/config.toml"), "utf8"), "approval_policy = \"never\"\n");
  assert.match(readFileSync(join(target, ".agents/skills/observe-example/SKILL.md"), "utf8"), /name: observe-example/u);
  assert.match(readFileSync(join(target, ".agents/skills/guide/SKILL.md"), "utf8"), /name: guide/u);
  assert.match(readFileSync(join(target, ".agents/skills/observe-example/SKILL.md"), "utf8"), /cd owner\nnode scripts\/observe-example\.mjs/u);
  assert.equal(existsSync(join(target, ".codex/skills")), false);
  assert.equal(readFileSync(join(target, ".agents/skills/observe-example/scripts/observe-example.mjs"), "utf8"), readFileSync(join(repoRoot, "owner/scripts/observe-example.mjs"), "utf8"));
  assert.equal(readFileSync(join(target, ".agents/skills/unowned/SKILL.md"), "utf8"), "unowned\n");
  assert.equal(readFileSync(join(target, ".codex/agents/unowned.toml"), "utf8"), "name = \"unowned\"\n");
  assert.equal(existsSync(join(target, ".agents/skills/obsolete")), false);
  assert.equal(existsSync(join(target, ".codex/agents/obsolete.toml")), false);
  assert.equal(readFileSync(join(target, ".codex/.codex-agent-manifest"), "utf8"), "agent:node-programming\nskill:guide\nskill:observe-example\n");
  assert.match(readFileSync(join(target, ".codex/agents/node-programming.toml"), "utf8"), /https:\/\/registry\.561\.group/u);
  assert.deepEqual(projection.files, [
    ".agents/skills/observe-example/SKILL.md",
    ".agents/skills/observe-example/scripts/observe-example.mjs",
    ".agents/skills/guide/SKILL.md",
    ".codex/config.toml",
    ".codex/.codex-agent-manifest",
    ".codex/agents/node-programming.toml",
    ".codex/agents/unowned.toml",
    "AGENTS.md",
    ".agents/skills/unowned/SKILL.md",
  ].sort());

  const duplicateTarget = mkdtempSync(join(tmpdir(), "codex-harness-duplicate-skill-"));
  t.after(() => rmSync(duplicateTarget, { recursive: true, force: true }));
  mkdirSync(join(repoRoot, "owner/skills/observe-example"), { recursive: true });
  writeFileSync(join(repoRoot, "owner/skills/observe-example/SKILL.md"), "---\nname: observe-example\ndescription: Parallel copy.\n---\n");
  assert.throws(() => projectRepositoryCodexHarness({
    repoRoot,
    target: duplicateTarget,
    instructions: "# Generated instructions\n",
    config: "approval_policy = \"never\"\n",
    skillSources: ["owner/skills/observe-example"],
    operationSources: ["owner/scripts/observe-example.mjs"],
  }), /duplicate projected skill name: observe-example/u);

  const collisionTarget = mkdtempSync(join(tmpdir(), "codex-harness-provider-office-collision-"));
  t.after(() => rmSync(collisionTarget, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, "owner/office.json"), "{}\n");
  writeFileSync(join(repoRoot, "owner/scripts/project-office.mjs"), `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const target = process.argv[3];
mkdirSync(join(target, ".codex/agents"), { recursive: true });
writeFileSync(join(target, ".codex/agents/node-programming.toml"), "office\\n");
writeFileSync(join(target, ".codex/.codex-agent-manifest"), "agent:node-programming\\n");
`);
  assert.throws(() => projectRepositoryCodexHarness({
    repoRoot,
    target: collisionTarget,
    instructions: "# Generated instructions\n",
    config: "approval_policy = \"never\"\n",
    providerAgentSources: ["owner/agents/node-programming.md"],
    offices: ["owner/office.json"],
    officeProjector: join(repoRoot, "owner/scripts/project-office.mjs"),
  }), /provider agent target conflicts with an office projection: node-programming/u);
});

test("discovers only explicitly summarized scripts beneath selected owner roots", (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "codex-harness-operation-discovery-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  mkdirSync(join(repoRoot, "owner/scripts"), { recursive: true });
  mkdirSync(join(repoRoot, "owner/node_modules/dependency/scripts"), { recursive: true });
  writeFileSync(join(repoRoot, "owner/scripts/eligible.mjs"), "#!/usr/bin/env node\n/** @summary Eligible. */\n");
  writeFileSync(join(repoRoot, "owner/scripts/unmarked.mjs"), "#!/usr/bin/env node\n");
  writeFileSync(join(repoRoot, "owner/node_modules/dependency/scripts/copied.mjs"), "#!/usr/bin/env node\n/** @summary Copied. */\n");
  assert.deepEqual(discoverOperationSources(repoRoot, ["owner"]), ["owner/scripts/eligible.mjs"]);
});

test("projectRepositoryCodexHarness gates a colleague office on the shared seating verification when colleagueSeatings is given", (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "codex-harness-seating-"));
  const target = mkdtempSync(join(tmpdir(), "codex-harness-seating-target-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  mkdirSync(join(repoRoot, "owner/offices"), { recursive: true });
  writeFileSync(join(repoRoot, "owner/offices/system-architect.json"), "{}\n");
  // No character/incumbency records are seated under repoRoot: the shared
  // gate must refuse before any office is rendered.
  assert.throws(() => projectRepositoryCodexHarness({
    repoRoot,
    target,
    instructions: "# Generated instructions\n",
    config: "approval_policy = \"never\"\n",
    offices: ["owner/offices/system-architect.json"],
    colleagueSeatings: { "system-architect": { character: "owner/characters/system-architect.json", incumbency: "owner/incumbencies/system-architect.json" } },
    incumbenciesDir: join(repoRoot, "owner/incumbencies"),
    rootOffice: "executive-officer-to-the-leader",
  }), /colleague office 'system-architect' has no incumbency record seated/u);
  assert.equal(existsSync(join(target, ".codex/agents")), false);
});

test("full harness projection includes native settings and preserves unrelated fields", (t) => {
  const target = mkdtempSync(join(tmpdir(), "codex-settings-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  mkdirSync(join(target, ".codex"), { recursive: true });
  writeFileSync(join(target, ".codex/config.toml"), 'model = "chosen"\n[features]\nother = true\n');
  const config = '[features]\nhooks = true\n[agents]\nmax_threads = 3\n[mcp_servers.managed]\ncommand = "node"\n';
  const args = { target, config, serverNames: ["managed"], obsoleteSettings: { agents: ["enabled"] }, includeSettings: true };
  projectCodexMcpServerConfiguration(args);
  const installed = readFileSync(join(target, ".codex/config.toml"), "utf8");
  assert.match(installed, /model = "chosen"/);
  assert.match(installed, /other = true/);
  assert.match(installed, /hooks = true/);
  assert.match(installed, /max_threads = 3/);
  writeFileSync(join(target, ".codex/config.toml"), installed.replace("max_threads = 3", "max_threads = 3\nenabled = true"));
  assert.throws(() => projectCodexMcpServerConfiguration({ ...args, check: true }), /obsolete Codex harness settings/);
  projectCodexMcpServerConfiguration(args);
  assert.equal(projectCodexMcpServerConfiguration({ ...args, check: true }).checked, true);
  writeFileSync(join(target, ".codex/config.toml"), installed.replace("max_threads = 3", "max_threads = 8"));
  assert.throws(() => projectCodexMcpServerConfiguration({ ...args, check: true }), /settings are stale/);
});

test("shared skill installation retains the office owner's skill pool", (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "codex-owner-skills-"));
  const target = mkdtempSync(join(tmpdir(), "codex-owner-skills-target-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  mkdirSync(join(repoRoot, "owner/offices"), { recursive: true });
  for (const [pool, name] of [["owner/skills", "normalize-code"], ["shared/skills", "inspect-code"]]) {
    mkdirSync(join(repoRoot, pool, name), { recursive: true });
    writeFileSync(join(repoRoot, pool, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\ntype: skill\nskill-closure-kind: process\n---\n\nExecute ${name} at its declared owner.\n`);
  }
  writeFileSync(join(repoRoot, "owner/offices/code-lead.json"), JSON.stringify({
    id: "code-lead", kind: "office", name: "Code Lead",
    "normative-structure": "Realize admitted code transformations.",
    "deontic-profile": {}, "bears-duty": [],
    "provides-skill": ["normalize-code", "inspect-code"],
  }));
  projectRepositoryCodexHarness({
    repoRoot, target, instructions: "# Instructions\n", config: 'approval_policy = "never"\n',
    offices: ["owner/offices/code-lead.json"], sharedSkillRoots: [join(repoRoot, "shared/skills")],
  });
  const installed = readFileSync(join(target, ".codex/agents/code-lead.toml"), "utf8");
  assert.match(installed, /Execute normalize-code at its declared owner/u);
  assert.match(installed, /Execute inspect-code at its declared owner/u);
});
