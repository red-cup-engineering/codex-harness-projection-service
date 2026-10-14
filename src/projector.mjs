import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, lstatSync, realpathSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const stat = file => { try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } };
const inside = (root, file) => file.startsWith(root + sep);
function directory(file) {
  const value = stat(file);
  if (value && (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid())) throw new Error("skill discovery directory is not an owned ordinary directory");
}
function linkState(file) {
  const value = stat(file);
  if (!value) return undefined;
  if (!value.isSymbolicLink() || value.uid !== process.getuid()) throw new Error("skill discovery entry is occupied by foreign content");
  return resolve(dirname(file), readlinkSync(file));
}
function previousMethods(target, agencyRoot, projectRoot, office) {
  if (!existsSync(target)) return [];
  const bytes = readFileSync(target);
  if (bytes.length > 524288) throw new Error("previous office context exceeds bound");
  const text = bytes.toString("utf8"), marker = "\n\n## Source custody\n\n", at = text.lastIndexOf(marker);
  if (at < 0) return [];
  let custody;
  try { custody = JSON.parse(text.slice(at + marker.length).trim()); } catch { return []; }
  // The existing briefing carries ownership; there is no parallel registry.
  if (custody.agencyRoot !== agencyRoot || custody.projectRoot !== projectRoot || custody.office !== office || !Array.isArray(custody.sources)) return [];
  if (custody.sources.length > 1024) throw new Error("previous office source custody exceeds bound");
  return custody.sources.flatMap(source => {
    const match = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(source.path ?? "");
    return match ? [match[1]] : [];
  });
}
function skillDiscoveryPlan({ agencyRoot, projectRoot, office, target, methods }) {
  if (projectRoot === undefined) return undefined;
  projectRoot = realpathSync(resolve(projectRoot));
  directory(projectRoot);
  if (!inside(projectRoot, target)) throw new Error("office briefing is outside its declared project");
  for (let ancestor = dirname(target); ancestor !== projectRoot; ancestor = dirname(ancestor)) directory(ancestor);
  if (stat(target)?.isSymbolicLink()) throw new Error("office briefing is occupied by a foreign source reference");
  const sourceRoot = realpathSync(agencyRoot), declaredSkills = join(agencyRoot, "skills");
  const skillsRoot = stat(declaredSkills) ? realpathSync(declaredSkills) : join(sourceRoot, "skills");
  if (methods.length > 0 && !stat(declaredSkills)) throw new Error("declared skill source is unavailable");
  if (!inside(sourceRoot, skillsRoot)) throw new Error("skill source is outside its declared agency");
  const directoryRoot = join(projectRoot, ".agents"), entriesRoot = join(directoryRoot, "skills");
  directory(directoryRoot); directory(entriesRoot);
  const desired = new Map(), changes = [];
  for (const method of methods) {
    if (method.path !== `skills/${method.id}/SKILL.md`) throw new Error("discovered methods need their one canonical SKILL.md directory");
    const file = join(agencyRoot, method.path), source = dirname(file), received = realpathSync(file);
    if (!inside(skillsRoot, received) || !stat(received)?.isFile()) throw new Error("skill reference leaves its declared source");
    // Codex owns frontmatter admission. Preserve its exact source bytes rather
    // than inventing another skill metadata parser or copying a manifest.
    desired.set(method.id, source);
    const entry = join(entriesRoot, method.id), held = linkState(entry);
    if (held !== undefined && held !== source) throw new Error("skill discovery entry names a foreign source");
    if (held === undefined) changes.push({ kind: "add", entry, source });
  }
  for (const id of previousMethods(target, agencyRoot, projectRoot, office)) {
    if (desired.has(id)) continue;
    const entry = join(entriesRoot, id), source = join(agencyRoot, "skills", id), held = linkState(entry);
    if (held !== undefined && held !== source) throw new Error("removed office skill reference was replaced by foreign content");
    if (held !== undefined) changes.push({ kind: "remove", entry, source });
  }
  return { projectRoot, directoryRoot, entriesRoot, changes, desired, methods };
}
function applySkillDiscovery(plan) {
  if (!plan) return [];
  for (const method of plan.methods) {
    if (digest(readFileSync(join(plan.desired.get(method.id), "SKILL.md"))) !== digest(Buffer.from(method.text))) throw new Error("skill source changed during projection");
  }
  directory(plan.directoryRoot); directory(plan.entriesRoot);
  mkdirSync(plan.entriesRoot, { recursive: true, mode: 0o700 });
  const applied = [];
  try {
    for (const change of plan.changes) {
      const held = linkState(change.entry);
      if (change.kind === "add") {
        if (held !== undefined) throw new Error("skill entry changed during projection");
        symlinkSync(change.source, change.entry, "dir");
      } else {
        if (held !== change.source) throw new Error("skill entry changed during projection");
        unlinkSync(change.entry);
      }
      applied.push(change);
    }
    return applied;
  } catch (error) { rollbackSkillDiscovery(applied); throw error; }
}
function rollbackSkillDiscovery(applied) {
  for (const change of [...applied].reverse()) {
    if (change.kind === "add") {
      if (linkState(change.entry) !== change.source) throw new Error("projected skill reference changed before recovery");
      unlinkSync(change.entry);
    } else {
      if (stat(change.entry)) throw new Error("removed skill entry was occupied before recovery");
      symlinkSync(change.source, change.entry, "dir");
    }
  }
}

/** Project source-authored office methods as context, never as operational authority. */
export function projectOfficeContext({ agencyRoot, office, target, detail = "full", projectRoot }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(office ?? "")) throw new TypeError("a canonical office id is required");
  if (!["full", "index"].includes(detail)) throw new TypeError("office context detail must be full or index");
  agencyRoot = resolve(agencyRoot);
  target = resolve(target);
  const sources = [];
  const read = file => {
    const bytes = readFileSync(join(agencyRoot, file));
    if (bytes.length > 131072) throw new Error(`office context source exceeds bound: ${file}`);
    if (/^(?:<{7}|>{7})(?: .*)?$/m.test(bytes.toString("utf8"))) throw new Error(`office context source has unresolved merge markers: ${file}`);
    sources.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex") });
    return bytes.toString("utf8");
  };
  const record = (pool, id) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`invalid ${pool} reference`);
    const value = JSON.parse(read(`${pool}/${id}.json`));
    if (value.id !== id) throw new Error(`mismatched ${pool} source identity`);
    return value;
  };
  // Rules are source context, not a ruling on applicability or an authority grant.
  // Reading the whole authored pool prevents a newer Leader correction from being
  // silently omitted merely because office and method records did not change.
  const rulesRoot = join(agencyRoot, "rules");
  const ruleFiles = existsSync(rulesRoot)
    ? readdirSync(rulesRoot).filter(file => file.endsWith(".json")).sort()
    : [];
  if (ruleFiles.length > 512) throw new Error("office rule context exceeds record bound");
  const rules = ruleFiles.map(file => record("rules", file.slice(0, -5)));
  const definition = record("offices", office);
  const duties = (definition["bears-duty"] ?? []).map(ref => record("duties", ref.split("/").at(-1)));
  const skills = [...new Set([...(definition["provides-skill"] ?? []), ...duties.flatMap(d => d.skills ?? [])])];
  const methods = skills.map(id => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("invalid skill reference");
    const candidates = [`skills/${id}/SKILL.md`, `skills/${id}.md`, `skills/${id}.json`].filter(file => existsSync(join(agencyRoot, file)));
    if (candidates.length !== 1) throw new Error(`skill needs one source: ${id}`);
    return { id, path: candidates[0], text: read(candidates[0]) };
  });
  if (methods.length > 128) throw new Error("office skill discovery exceeds bound");
  // An unchanged SKILL.md can point to a revised intake. Include the actual
  // linked source closure in freshness custody, without copying it into context.
  const received = new Set(sources.map(source => source.path));
  const pending = methods.map(method => ({ path: method.path, text: method.text }));
  while (pending.length) {
    const source = pending.pop();
    for (const match of source.text.matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1].split("#")[0];
      if (!href || href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const file = resolve(agencyRoot, dirname(source.path), href);
      if (!inside(agencyRoot, file) || !/\.(md|json)$/.test(file)) continue;
      const path = relative(agencyRoot, file);
      if (received.has(path)) continue;
      if (received.size >= 1024) throw new Error("office linked source custody exceeds bound");
      received.add(path);
      pending.push({ path, text: read(path) });
    }
  }
  const discovery = skillDiscoveryPlan({ agencyRoot, projectRoot, office, target, methods });
  const custody = { agencyRoot, ...(discovery === undefined ? {} : { projectRoot: discovery.projectRoot, office }), sources };
  const full = [
    `# Projected office context: ${definition.name ?? office}`,
    "Generated from source records. Edit the owning office, duty or skill and project again; do not edit this output. These records describe the office and its methods. They do not grant this process runtime authority, incumbency, delegation or permission to override the current human request.",
    "## Office", JSON.stringify(definition, null, 2),
    ...rules.flatMap(rule => [`## Authored rule: ${rule.id}`, JSON.stringify(rule, null, 2)]),
    ...duties.flatMap(d => [`## Duty: ${d.id}`, JSON.stringify(d, null, 2)]),
    ...methods.flatMap(m => [`## Skill: ${m.id}`, m.text]),
    "## Source custody", JSON.stringify(custody, null, 2), "",
  ].join("\n\n");
  const pick = (value, fields) => Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
  const link = file => `[${file}](${join(agencyRoot, file)})`;
  const text = detail === "full" ? full : [
    `# Projected office context: ${definition.name ?? office}`,
    "Generated from source records. These records do not grant this process runtime authority, incumbency, delegation or permission to override the human's continuing objective and accumulated corrections.",
    "This is a source index, not a replacement for its complete records. Every authored rule statement and source digest is retained. Read the complete applicable duty, rule and skill sources before using them; load conditional methods only when the current work needs them. Keep method application distinct from product requirements.",
    "## Source methods", ...methods.map(method => `- ${method.id}: ${link(method.path)}`),
    "Read the applicable complete method before selecting execution. Original requirements and source design govern construction; repeated partial compilation and patching do not establish that design.",
    "## Office", link(`offices/${office}.json`), JSON.stringify(pick(definition, ["id", "name", "authority-scope", "jurisdiction", "bears-duty", "provides-skill"]), null, 2),
    ...rules.flatMap(rule => [`## Authored rule: ${rule.id}`, link(`rules/${rule.id}.json`), JSON.stringify(pick(rule, ["id", "statement", "subject", "action"]), null, 2)]),
    ...duties.flatMap(duty => [`## Duty: ${duty.id}`, link(`duties/${duty.id}.json`), JSON.stringify(pick(duty, ["id", "name", "authority", "work", "skills"]), null, 2)]),
    "## Source custody", JSON.stringify({ ...custody, detail }, null, 2), "",
  ].join("\n\n");
  if (Buffer.byteLength(text) > 524288) throw new Error("office context exceeds bound");
  // A briefing that is already current is not rewritten: a sandboxed session may run the projector to confirm it.
  const current = existsSync(target) && readFileSync(target, "utf8") === text;
  const result = (written, applied) => Object.freeze({ office, target, detail, duties: duties.length, skills: skills.length, rules: rules.length, sources, written,
    ...(discovery === undefined ? {} : { discovery: Object.freeze({ projectRoot: discovery.projectRoot, directory: discovery.entriesRoot, registered: methods.length, referencesChanged: applied.length, authority: "source-context-only", currentSessionDiscovery: "unobserved" }) }) });
  if (current) return result(false, applySkillDiscovery(discovery));
  // Prepare the whole closure before replacing output; a missing method never yields a partial briefing.
  const temporary = `${target}.${process.pid}.tmp`;
  let applied = [];
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temporary, text, { mode: 0o600 });
    applied = applySkillDiscovery(discovery);
    renameSync(temporary, target);
  } catch (error) {
    rollbackSkillDiscovery(applied);
    if (!["EROFS", "EACCES", "EPERM"].includes(error?.code)) throw error;
    throw Object.assign(new Error(`office context is stale and this process cannot write ${target} (${error.code}); project it before the session starts, or bind a target the session may write`), { code: "OFFICE_CONTEXT_STALE", cause: error });
  } finally { rmSync(temporary, { force: true }); }
  return result(true, applied);
}
