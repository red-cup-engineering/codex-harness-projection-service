import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { admitJavascriptOperationSkillSource } from "@red-cup-engineering/admit-javascript-operation-skill-source-service";
import { canonicalizeJsonValue } from "@red-cup-engineering/atomic-json-file-service/canonical";
import { writeFileAtomically, writeJsonAtomically } from "@red-cup-engineering/atomic-json-file-service/write";
import { verifySeatings } from "@red-cup-engineering/claude-harness-projection-service/projector";
import { projectAgentSkillFileProjections } from "@red-cup-engineering/project-agent-skill-file-projections-service";
import { readJavascriptFileExportDocumentation } from "@red-cup-engineering/read-javascript-file-export-documentation-service";
import { readJavascriptFileMainGuards } from "@red-cup-engineering/read-javascript-file-main-guards-service";
import { readMarkdownFrontmatter } from "@red-cup-engineering/read-markdown-frontmatter-service";
import { decodeToml, encodeToml } from "@red-cup-engineering/toml-codec-service";

const DEFAULT_OFFICE_PROJECTOR = resolve(import.meta.dirname, "../../codex-office-agent-projection-service/scripts/install-codex-as-an-agent.mjs");
const OPERATION_DISCOVERY_SKIP = new Set(["node_modules", "legacy", "test", "fixtures", "data", ".git", ".agents", ".codex"]);

export function loadActorConfiguration(path) {
  const configuration = JSON.parse(readFileSync(path, "utf8"));
  if (configuration?.type !== "BareCedarFogCodexInVsCodeConfiguration") throw new Error("expected a Bare Cedar Fog Codex-in-VS-Code configuration");
  if (configuration.actor !== "urn:ame:bare-cedar-fog-codex") throw new Error("configuration must belong to the stable Bare Cedar Fog Codex actor");
  if (configuration.surface !== "vscode-codex") throw new Error("configuration must describe the VS Code Codex surface");
  if (configuration.projection?.template !== "projection") throw new Error("configuration must name its colocated projection template");
  if (configuration.projection.skills !== undefined) throw new Error("projected skills are forbidden: capabilities belong to external enterprise actuator faces, not the harness projection");
  if (!Array.isArray(configuration.projection.files) || configuration.projection.files.length === 0) throw new Error("projection must name a nonempty file allowlist");
  for (const path of configuration.projection.files) {
    if (typeof path !== "string" || path === "" || path.startsWith("/") || path.split("/").includes("..")) throw new Error("projection files must be safe relative paths");
  }
  return configuration;
}

function files(root, directory = root) {
  const result = [];
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) result.push(...files(root, path)); else if (name.isFile()) result.push(relative(root, path));
  }
  return result.sort();
}

export function projectCodexHarness({ configurationPath, target }) {
  configurationPath = resolve(configurationPath);
  const configuration = loadActorConfiguration(configurationPath);
  if (typeof target !== "string" || target.trim() === "") throw new Error("an explicit output directory is required");
  const codex = resolve(target);
  const template = join(dirname(configurationPath), configuration.projection.template);
  if (!existsSync(template)) throw new Error(`projection template is absent: ${template}`);
  mkdirSync(codex, { recursive: true });
  // The explicitly named output directory is entirely disposable runtime projection. Durable
  // knowledge, handoffs, and capabilities belong to their owning enterprises.
  // In particular, never recreate the historical .codex/skills source sink.
  const allowed = new Set(configuration.projection.files);
  for (const path of files(codex)) if (!allowed.has(path)) rmSync(join(codex, path), { force: true });
  const prune = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) prune(join(directory, entry.name));
    if (directory !== codex && readdirSync(directory).length === 0) rmdirSync(directory);
  };
  prune(codex);
  for (const path of allowed) {
    const source = join(template, path);
    if (!existsSync(source)) throw new Error(`allowed projection file is absent: ${path}`);
    const destination = join(codex, path); mkdirSync(dirname(destination), { recursive: true }); cpSync(source, destination, { force: true });
  }
  const projected = files(codex);
  return Object.freeze({ actor: configuration.actor, target: codex, files: projected });
}

function requireRelativeSourcePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.split("/").includes("..")) {
    throw new TypeError(`${label} must be a safe repository-relative path`);
  }
  return value;
}

function operationSkillProjection(repoRoot, sourcePath) {
  const path = requireRelativeSourcePath(sourcePath, "operation source");
  const reading = Object.freeze({ type: "TextFileRead", path, text: readFileSync(join(repoRoot, path), "utf8") });
  const source = admitJavascriptOperationSkillSource({
    type: "JavascriptOperationSkillSourceCandidate",
    version: 1,
    reading,
    documentations: readJavascriptFileExportDocumentation(reading),
    mainGuards: readJavascriptFileMainGuards(reading),
  });
  if (source.type !== "JavascriptOperationSkillSource") {
    throw new Error(`operation skill source was refused: ${path}: ${source.code} ${source.message}`);
  }
  return projectAgentSkillFileProjections(source);
}

/**
 * Discovers explicitly marked operation-skill sources beneath owner-selected roots.
 *
 * Discovery is not admission: only scripts carrying an `@summary` marker become
 * candidates, and every candidate must still pass the complete skill-source
 * admission before projection.
 */
export function discoverOperationSources(repoRoot, operationRoots = []) {
  if (!Array.isArray(operationRoots)) throw new TypeError("operationRoots must be an array");
  repoRoot = resolve(repoRoot);
  const discovered = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!OPERATION_DISCOVERY_SKIP.has(entry.name)) walk(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !/\.(?:mjs|js)$/u.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const relativePath = relative(repoRoot, path);
      if (!relativePath.split("/").includes("scripts")) continue;
      if (readFileSync(path, "utf8").includes("@summary")) discovered.push(relativePath);
    }
  };
  for (const root of operationRoots) {
    const relativeRoot = requireRelativeSourcePath(root, "operation root");
    const directory = join(repoRoot, relativeRoot);
    if (!existsSync(directory)) throw new Error(`operation root is absent: ${relativeRoot}`);
    walk(directory);
  }
  return Object.freeze([...new Set(discovered)].sort());
}

function writeProjection(path, text, mode = 0o644) {
  writeFileAtomically(path, text, { mode });
}

export function projectCodexMcpServerConfiguration({ target, config, serverNames, obsoleteServerNames = [], obsoleteSettings = {}, includeSettings = false, check = false }) {
  if (typeof target !== "string" || target.trim() === "") throw new TypeError("an explicit target is required");
  if (typeof config !== "string" || config.length === 0) throw new TypeError("rendered Codex config is required");
  if (!Array.isArray(serverNames) || serverNames.length === 0 || serverNames.some((name) => typeof name !== "string" || name.length === 0)) throw new TypeError("one nonempty named MCP server list is required");
  if (!Array.isArray(obsoleteServerNames) || obsoleteServerNames.some((name) => typeof name !== "string" || name.length === 0)) throw new TypeError("obsolete MCP server names must be an array of nonempty strings");
  const path = join(resolve(target), ".codex/config.toml");
  const projected = decodeToml(config);
  const sourceServers = projected.mcp_servers;
  if (!sourceServers || typeof sourceServers !== "object" || Array.isArray(sourceServers)) throw new TypeError("rendered Codex config has no MCP server tables");
  const existing = existsSync(path) ? decodeToml(readFileSync(path, "utf8")) : {};
  const actualServers = existing.mcp_servers && typeof existing.mcp_servers === "object" && !Array.isArray(existing.mcp_servers) ? existing.mcp_servers : {};
  const selected = Object.fromEntries(serverNames.map((name) => {
    if (!Object.hasOwn(sourceServers, name)) throw new Error(`rendered Codex config has no MCP server ${name}`);
    return [name, sourceServers[name]];
  }));
  if (!obsoleteSettings || typeof obsoleteSettings !== "object" || Array.isArray(obsoleteSettings) || Object.values(obsoleteSettings).some((fields) => !Array.isArray(fields) || fields.some((field) => typeof field !== "string"))) throw new TypeError("obsolete settings must name table fields");
  const obsoletePresent = Object.entries(obsoleteSettings).some(([section, fields]) => fields.some((field) => Object.hasOwn(existing[section] ?? {}, field)));
  const settings = includeSettings ? Object.fromEntries(Object.entries(projected).filter(([key]) => key !== "mcp_servers")) : {};
  const table = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const settingsCurrent = Object.entries(settings).every(([key, wanted]) => table(wanted)
    ? Object.entries(wanted).every(([field, value]) => canonicalizeJsonValue(existing[key]?.[field]) === canonicalizeJsonValue(value))
    : canonicalizeJsonValue(existing[key]) === canonicalizeJsonValue(wanted));
  if (check) {
    if (obsoletePresent) throw new Error("obsolete Codex harness settings remain: " + path);
    if (!settingsCurrent) throw new Error("Codex harness settings are stale or missing: " + path);
    if (obsoleteServerNames.some((name) => Object.hasOwn(actualServers, name))) throw new Error("obsolete Codex MCP configuration remains: " + path);
    if (serverNames.some((name) => canonicalizeJsonValue(actualServers[name]) !== canonicalizeJsonValue(selected[name]))) throw new Error(`Codex MCP configuration is stale or missing: ${path}`);
    return Object.freeze({ target: path, changed: false, checked: true });
  }
  const retainedServers = { ...actualServers };
  for (const name of obsoleteServerNames) delete retainedServers[name];
  const mergedSettings = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, table(value) ? { ...(table(existing[key]) ? existing[key] : {}), ...value } : value]));
  const next = { ...existing, ...mergedSettings, mcp_servers: { ...retainedServers, ...selected } };
  for (const [section, fields] of Object.entries(obsoleteSettings)) {
    if (!table(next[section])) continue;
    next[section] = { ...next[section] };
    for (const field of fields) delete next[section][field];
  }
  const { changed } = writeFileAtomically(path, encodeToml(next), { mode: 0o644 });
  return Object.freeze({ target: path, changed, checked: false });
}

function providerAgentProjection(repoRoot, sourcePath) {
  const path = requireRelativeSourcePath(sourcePath, "provider agent source");
  const { frontmatter, body } = readMarkdownFrontmatter(readFileSync(join(repoRoot, path), "utf8"));
  if (!/^[a-z0-9-]+$/u.test(frontmatter?.name ?? "") || typeof frontmatter?.description !== "string" || frontmatter.description.length === 0 || typeof body !== "string" || body.trim().length === 0) throw new Error(`provider agent source is incomplete: ${path}`);
  return Object.freeze({ name: frontmatter.name, text: `name = ${JSON.stringify(frontmatter.name)}\ndescription = ${JSON.stringify(frontmatter.description)}\ndeveloper_instructions = ${JSON.stringify(`${body.trim()}\n`)}\n` });
}

/**
 * Projects a complete repository-local Codex harness from owner-rendered bytes,
 * admitted operation sources, and canonical enterprise offices.
 *
 * The caller owns actor policy and source selection. This generic boundary owns
 * the disposable Codex discovery surfaces and recreates them deterministically.
 * When colleagueSeatings is given, every office is gated by the same
 * seating verification the Claude harness uses (owner-ruled 2026-09-04:
 * seating verification lives once upstream of both harness masks) before
 * any office is rendered; a colleague office renders exactly like any
 * other, no per-colleague logic beyond the gate.
 */
export function projectRepositoryCodexHarness({
  repoRoot,
  target = repoRoot,
  instructions,
  config,
  configServerNames,
  obsoleteMcpServerNames = [],
  obsoleteSettings = {},
  skillSources = [],
  sharedSkillRoots = [],
  operationSources = [],
  operationRoots = [],
  providerAgentSources = [],
  offices = [],
  obsoleteAgentNames = [],
  colleagueSeatings,
  incumbenciesDir,
  foreignOfficeSourceRoots = [],
  rootOffice,
  officeProjector = DEFAULT_OFFICE_PROJECTOR,
}) {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") throw new TypeError("an explicit repository root is required");
  if (typeof target !== "string" || target.trim() === "") throw new TypeError("an explicit target is required");
  if (typeof instructions !== "string" || instructions.length === 0) throw new TypeError("rendered root instructions are required");
  if (typeof config !== "string" || config.length === 0) throw new TypeError("rendered Codex config is required");
  if (!Array.isArray(skillSources) || !Array.isArray(operationSources) || !Array.isArray(operationRoots) || !Array.isArray(providerAgentSources) || !Array.isArray(offices) || !Array.isArray(obsoleteAgentNames)) throw new TypeError("skillSources, operationSources, operationRoots, providerAgentSources, offices, and obsoleteAgentNames must be arrays");
  if (obsoleteAgentNames.some((name) => typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))) throw new TypeError("obsolete agent names must be safe kebab-case identifiers");
  if (colleagueSeatings !== undefined) {
    // Only the offices actually named in colleagueSeatings are gated: some
    // Codex colleague offices predate seating and are not yet modeled with
    // a character/incumbency, and retrofitting them is not this call's job.
    const seatedIds = new Set(Object.keys(colleagueSeatings));
    const seatedOffices = offices.filter((office) => seatedIds.has(office.split("/").at(-1).replace(/\.json$/u, "")));
    verifySeatings({ policy: { colleagueOffices: seatedOffices, colleagueSeatings, rootOffice }, repoRoot, incumbenciesDir, rootOffice, foreignOfficeSourceRoots });
  }
  repoRoot = resolve(repoRoot);
  target = resolve(target);
  mkdirSync(target, { recursive: true });

  const rootInstructions = join(target, "AGENTS.md");
  const codex = join(target, ".codex");
  const agents = join(codex, "agents");
  const skills = join(target, ".agents");
  const manifest = join(codex, ".codex-agent-manifest");
  const previouslyManaged = existsSync(manifest)
    ? readFileSync(manifest, "utf8").split("\n").map((entry) => entry.trim()).filter(Boolean)
    : [];
  for (const entry of previouslyManaged) {
    if (entry.startsWith("skill:")) {
      const name = entry.slice("skill:".length);
      rmSync(join(skills, "skills", name), { recursive: true, force: true });
    } else {
      const name = entry.startsWith("agent:") ? entry.slice("agent:".length) : entry;
      rmSync(join(agents, `${name}.toml`), { force: true });
    }
  }
  // These are specifically named former generated projections. Their policy
  // owner has withdrawn them; remove only through this authored projector.
  for (const name of obsoleteAgentNames) rmSync(join(agents, `${name}.toml`), { force: true });
  // `.agents/skills` is the one runtime skill projection. Historical dual
  // projection into `.codex/skills` exposed every operation twice and allowed
  // generated bytes to masquerade as another source tree.
  rmSync(join(codex, "skills"), { recursive: true, force: true });
  rmSync(manifest, { force: true });
  writeProjection(rootInstructions, instructions);
  if (configServerNames === undefined) writeProjection(join(codex, "config.toml"), config);
  else projectCodexMcpServerConfiguration({ target, config, serverNames: configServerNames, obsoleteServerNames: obsoleteMcpServerNames, obsoleteSettings, includeSettings: true });

  const selectedOperationSources = [...new Set([...operationSources, ...discoverOperationSources(repoRoot, operationRoots)])].sort();
  const projectedSkillNames = new Set();
  for (const sourcePath of [...new Set(skillSources)].sort()) {
    const relativeSource = requireRelativeSourcePath(sourcePath, "skill source");
    const source = join(repoRoot, relativeSource);
    const name = basename(relativeSource);
    if (!existsSync(join(source, "SKILL.md"))) throw new Error(`skill source has no SKILL.md: ${relativeSource}`);
    if (projectedSkillNames.has(name)) throw new Error(`duplicate projected skill name: ${name}`);
    const destination = join(skills, "skills", name);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
    projectedSkillNames.add(name);
  }
  for (const sourcePath of selectedOperationSources) {
    const projection = operationSkillProjection(repoRoot, sourcePath);
    const ownerDirectory = dirname(dirname(sourcePath));
    const ownerScript = join("scripts", basename(sourcePath));
    const operationSkillNames = new Set(projection.files.map((file) => file.path.split("/")[0]));
    if (operationSkillNames.size !== 1) throw new Error(`operation source projected an ambiguous skill name: ${sourcePath}`);
    const [operationSkillName] = operationSkillNames;
    if (projectedSkillNames.has(operationSkillName)) throw new Error(`duplicate projected skill name: ${operationSkillName}`);
    projectedSkillNames.add(operationSkillName);
    for (const file of projection.files) {
      requireRelativeSourcePath(file.path, "projected skill file");
      const text = file.path.endsWith("/SKILL.md")
        ? `${file.text.trimEnd()}\n\n## Canonical operation\n\nExecute this operation from its owning package so Node resolves the package's declared dependencies:\n\n\`\`\`sh\ncd ${ownerDirectory}\nnode ${ownerScript}\n\`\`\`\n`
        : file.text;
      writeProjection(join(skills, "skills", file.path), text, file.mode);
    }
  }

  if (offices.length > 0 && (!existsSync(officeProjector) || !existsSync(repoRoot))) {
    throw new Error(`Codex office projector or repository root is absent: ${officeProjector}`);
  }
  if (!Array.isArray(sharedSkillRoots) || sharedSkillRoots.some((path) => typeof path !== "string" || !isAbsolute(path) || !existsSync(path))) throw new TypeError("shared skill roots must be existing absolute directories");
  for (const officePath of offices) {
    const office = requireRelativeSourcePath(officePath, "office source");
    const result = spawnSync(process.execPath, [officeProjector, join(repoRoot, office), target, "--root", repoRoot, "--from", dirname(join(repoRoot, office)), ...sharedSkillRoots.flatMap((path) => ["--skill-root", path])], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Codex office projection failed for ${office}: ${(result.stderr || result.stdout).trim()}`);
  }
  const officeEntries = existsSync(manifest)
    ? readFileSync(manifest, "utf8").split("\n").map((entry) => entry.trim()).filter(Boolean)
    : [];
  const officeAgentNames = new Set(officeEntries.filter((entry) => !entry.startsWith("skill:")).map((entry) => entry.startsWith("agent:") ? entry.slice("agent:".length) : entry));
  const providerAgents = [...new Set(providerAgentSources)].map((sourcePath) => providerAgentProjection(repoRoot, sourcePath));
  const providerNames = new Set();
  for (const provider of providerAgents) {
    if (providerNames.has(provider.name)) throw new Error(`duplicate provider agent target: ${provider.name}`);
    if (officeAgentNames.has(provider.name)) throw new Error(`provider agent target conflicts with an office projection: ${provider.name}`);
    providerNames.add(provider.name);
    writeProjection(join(agents, `${provider.name}.toml`), provider.text);
  }
  writeProjection(manifest, [...new Set([...officeEntries, ...[...projectedSkillNames].map((name) => `skill:${name}`), ...[...providerNames].map((name) => `agent:${name}`)])].sort().map((entry) => `${entry}\n`).join(""));

  return Object.freeze({
    target,
    files: ["AGENTS.md", ...(existsSync(skills) ? files(skills) : []).map((path) => `.agents/${path}`), ...files(codex).map((path) => `.codex/${path}`)].sort(),
  });
}

function installedHookConfiguration(path) {
  if (!existsSync(path)) return null;
  let configuration;
  try {
    configuration = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new TypeError(`installed Codex hooks configuration is not valid JSON: ${path}`);
  }
  return configuration && typeof configuration === "object" && configuration.hooks && typeof configuration.hooks === "object"
    ? configuration
    : null;
}

/**
 * Project one owner-declared slice of a project's Codex lifecycle hooks.
 *
 * The caller supplies the actor-specific hook values. This generic boundary
 * retains hooks belonging to other project-local owners and refuses to infer a
 * user-level destination.
 */
export function projectCodexHooks({ target, projection, check = false }) {
  if (typeof target !== "string" || target.trim() === "") throw new TypeError("an explicit project root is required");
  if (!projection || typeof projection !== "object" || !projection.hooks || typeof projection.hooks !== "object") {
    throw new TypeError("a projected Codex hooks configuration is required");
  }
  const root = resolve(target);
  const path = join(root, ".codex/hooks.json");
  const existing = installedHookConfiguration(path);
  const installed = existing
    ? { ...existing, hooks: { ...existing.hooks, ...projection.hooks } }
    : projection;
  if (check) {
    const stale = !existing || Object.entries(projection.hooks).some(([event, hooks]) => canonicalizeJsonValue(existing.hooks[event]) !== canonicalizeJsonValue(hooks));
    if (stale) throw new Error(`Codex hooks projection is stale or missing: ${path}`);
    return Object.freeze({ target: path, changed: false, checked: true });
  }
  const { changed } = writeJsonAtomically(path, installed, { mode: 0o600 });
  return Object.freeze({ target: path, changed, checked: false });
}
