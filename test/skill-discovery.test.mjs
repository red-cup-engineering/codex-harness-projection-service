import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, readlinkSync, realpathSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { projectOfficeContext } from "../src/projector.mjs";

function fixture(t) {
  const projectRoot = mkdtempSync(join(tmpdir(), "office-discovery-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const agencyRoot = join(projectRoot, "agency"), target = join(projectRoot, ".office-context/office-context.md");
  for (const p of ["offices", "skills/receive", "skills/assess"]) mkdirSync(join(agencyRoot, p), { recursive: true });
  const office = join(agencyRoot, "offices/cto.json");
  writeFileSync(office, JSON.stringify({ id: "cto", "provides-skill": ["receive", "assess"] }));
  for (const id of ["receive", "assess"]) writeFileSync(join(agencyRoot, `skills/${id}/SKILL.md`), `---\nname: ${id}\ndescription: Receive ${id} work.\n---\nUse the original source.\n`);
  return { projectRoot, agencyRoot, target, office, project: () => projectOfficeContext({ projectRoot, agencyRoot, target, office: "cto", detail: "index" }) };
}

// Independent receiving reads the product's actual discovery directory and
// follows each reference to the original source. This is filesystem discovery,
// not a claim that a running Codex session has reloaded its available skills.
function receive(projectRoot) {
  const root = join(projectRoot, ".agents/skills");
  return readdirSync(root).sort().map(id => {
    const entry = join(root, id), source = realpathSync(join(entry, "SKILL.md")), bytes = readFileSync(source);
    return { id, link: readlinkSync(entry), source, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  });
}

test("bound project discovers original methods without copied manifests; regeneration is idempotent", t => {
  const f = fixture(t), first = f.project(), original = receive(f.projectRoot);
  assert.equal(first.discovery.registered, 2);
  assert.equal(first.discovery.currentSessionDiscovery, "unobserved");
  assert.equal(first.discovery.authority, "source-context-only");
  for (const row of original) assert.equal(row.source, join(f.agencyRoot, `skills/${row.id}/SKILL.md`));
  const inode = lstatSync(join(f.projectRoot, ".agents/skills/receive")).ino;
  const again = f.project(); assert.equal(again.written, false); assert.equal(again.discovery.referencesChanged, 0);
  assert.equal(lstatSync(join(f.projectRoot, ".agents/skills/receive")).ino, inode);
  writeFileSync(join(f.agencyRoot, "skills/receive/SKILL.md"), "---\nname: receive\ndescription: Changed native receiving.\n---\nReceive exact returned bytes.\n");
  const changed = f.project(), received = receive(f.projectRoot);
  assert.equal(changed.discovery.referencesChanged, 0);
  assert.notEqual(received.find(row => row.id === "receive").sha256, original.find(row => row.id === "receive").sha256);
  assert.ok(changed.sources.some(source => source.sha256 === received.find(row => row.id === "receive").sha256));
});

test("removed canonical methods retire only received references; unrelated skills and provider settings survive", t => {
  const f = fixture(t); f.project();
  mkdirSync(join(f.projectRoot, ".agents/skills/unrelated"));
  writeFileSync(join(f.projectRoot, ".agents/skills/unrelated/SKILL.md"), "unrelated source\n");
  mkdirSync(join(f.projectRoot, ".codex")); mkdirSync(join(f.projectRoot, ".claude"));
  writeFileSync(join(f.projectRoot, ".codex/config.toml"), "unrelated_provider = true\n");
  writeFileSync(join(f.projectRoot, ".claude/settings.local.json"), "{\"unrelated\":true}\n");
  writeFileSync(f.office, JSON.stringify({ id: "cto", "provides-skill": ["receive"] }));
  rmSync(join(f.agencyRoot, "skills/assess"), { recursive: true });
  const removed = f.project(); assert.equal(removed.discovery.registered, 1); assert.equal(removed.discovery.referencesChanged, 1);
  assert.deepEqual(readdirSync(join(f.projectRoot, ".agents/skills")).sort(), ["receive", "unrelated"]);
  assert.equal(readFileSync(join(f.projectRoot, ".agents/skills/unrelated/SKILL.md"), "utf8"), "unrelated source\n");
  assert.equal(readFileSync(join(f.projectRoot, ".codex/config.toml"), "utf8"), "unrelated_provider = true\n");
  assert.equal(readFileSync(join(f.projectRoot, ".claude/settings.local.json"), "utf8"), "{\"unrelated\":true}\n");
  writeFileSync(f.office, JSON.stringify({ id: "cto", "provides-skill": [] }));
  rmSync(join(f.agencyRoot, "skills"), { recursive: true });
  const empty = f.project(); assert.equal(empty.discovery.registered, 0);
  assert.deepEqual(readdirSync(join(f.projectRoot, ".agents/skills")), ["unrelated"]);
});

test("foreign occupied entries, escaped source and replaced retired references refuse before altering context", t => {
  for (const scenario of ["foreign-entry", "escaped-source", "replaced-retired"]) {
    const f = fixture(t); f.project(); const previous = readFileSync(f.target);
    const foreign = join(f.projectRoot, "foreign"); mkdirSync(foreign); writeFileSync(join(foreign, "SKILL.md"), "foreign contents\n");
    if (scenario === "escaped-source") {
      rmSync(join(f.agencyRoot, "skills/receive"), { recursive: true }); symlinkSync(foreign, join(f.agencyRoot, "skills/receive"), "dir");
    } else {
      rmSync(join(f.projectRoot, ".agents/skills/receive")); symlinkSync(foreign, join(f.projectRoot, ".agents/skills/receive"), "dir");
      if (scenario === "replaced-retired") writeFileSync(f.office, JSON.stringify({ id: "cto", "provides-skill": ["assess"] }));
    }
    assert.throws(f.project, /foreign|declared source/);
    assert.deepEqual(readFileSync(f.target), previous);
    assert.equal(readFileSync(join(foreign, "SKILL.md"), "utf8"), "foreign contents\n");
  }
});

test("linked project discovery or briefing directories cannot write outside the declared project", t => {
  for (const name of [".agents", ".office-context"]) {
    const f = fixture(t), outside = mkdtempSync(join(tmpdir(), "foreign-projection-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "sentinel"), "foreign data remains\n");
    symlinkSync(outside, join(f.projectRoot, name), "dir");
    assert.throws(f.project, /owned ordinary directory/);
    assert.deepEqual(readdirSync(outside), ["sentinel"]);
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "foreign data remains\n");
  }
});

test("the actual CTO source is received through eight project references, with source and digest custody", t => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cto-discovery-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const agencyRoot = "/home/emsenn/info/lib/emsenn/services/561-group/services/561-group-services-section/lib/agency";
  const target = join(projectRoot, ".office-context/office-context.md");
  const result = projectOfficeContext({ projectRoot, agencyRoot, target, office: "chief-technology-officer", detail: "index" });
  const received = receive(projectRoot);
  assert.equal(received.length, 8); assert.equal(result.discovery.registered, 8);
  for (const row of received) {
    assert.ok(row.source.startsWith(agencyRoot + "/skills/"));
    assert.ok(result.sources.some(source => source.path === `skills/${row.id}/SKILL.md` && source.sha256 === row.sha256));
    assert.ok(row.bytes.length > 0);
  }
  assert.match(readFileSync(target, "utf8"), /"projectRoot"/);
  assert.equal(result.discovery.currentSessionDiscovery, "unobserved");
});

test("existing project binding and CLI expose eight canonical references without changing provider settings", t => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cto-cli-discovery-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  mkdirSync(join(projectRoot, ".codex")); mkdirSync(join(projectRoot, ".claude"));
  writeFileSync(join(projectRoot, ".codex/config.toml"), "unrelated_provider = true\n");
  writeFileSync(join(projectRoot, ".claude/settings.local.json"), "{\"unrelated\":true}\n");
  const agencyRoot = "/home/emsenn/info/lib/emsenn/services/561-group/services/561-group-services-section/lib/agency";
  const file = join(projectRoot, ".codex/office.json");
  writeFileSync(file, JSON.stringify({ type: "SourceOfficeContextProjection", authority: "source-context-only", office: "chief-technology-officer", agencyRoot, target: "../.office-context/office-context.md", detail: "index", hostResources: { node: "..", providers: [] } }));
  const result = spawnSync(process.execPath, [new URL("../scripts/project-office-context.mjs", import.meta.url).pathname, file], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.discovery.registered, 8); assert.equal(report.discovery.projectRoot, projectRoot);
  assert.equal(report.discovery.currentSessionDiscovery, "unobserved");
  assert.deepEqual(report.resources.written, []); assert.equal(report.resources.activeSessionGuarded, false);
  assert.equal(receive(projectRoot).length, 8);
  assert.equal(readFileSync(join(projectRoot, ".codex/config.toml"), "utf8"), "unrelated_provider = true\n");
  assert.equal(readFileSync(join(projectRoot, ".claude/settings.local.json"), "utf8"), "{\"unrelated\":true}\n");
});
