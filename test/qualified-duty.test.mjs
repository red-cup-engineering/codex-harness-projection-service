import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { projectOfficeContext } from "../src/projector.mjs";

function fixture(t) {
  const projectRoot = mkdtempSync(join(tmpdir(), "qualified-office-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const corpusRoot = projectRoot, agencyRoot = join(corpusRoot, "group", "lib/agency");
  const foreign = join(corpusRoot, "engineering", "lib/agency");
  for (const root of [agencyRoot, foreign]) for (const pool of ["offices", "duties"]) mkdirSync(join(root, pool), { recursive: true });
  mkdirSync(join(agencyRoot, "skills/execute"), { recursive: true });
  writeFileSync(join(agencyRoot, "skills/execute/SKILL.md"), "---\nname: execute\ndescription: Execute the source duty.\n---\nRead [the original](reference.md).\n");
  writeFileSync(join(agencyRoot, "skills/execute/reference.md"), "The actual source closure.\n");
  const officeFile = join(agencyRoot, "offices/engineer.json"), target = join(projectRoot, ".office-context/office-context.md");
  const office = refs => writeFileSync(officeFile, JSON.stringify({ id: "engineer", "bears-duty": refs }));
  const duty = (root, id, receiving) => writeFileSync(join(root, `duties/${id}.json`), JSON.stringify({ id, skills: [root === agencyRoot ? "execute" : "group#execute"], "receiver-condition": receiving }));
  duty(agencyRoot, "deliver", "local receiving"); duty(foreign, "deliver", "foreign receiving");
  office(["deliver"]);
  return { projectRoot, corpusRoot, agencyRoot, foreign, office, duty, target,
    project: extra => projectOfficeContext({ projectRoot, corpusRoot, agencyRoot, target, office: "engineer", detail: "index", ...extra }) };
}

test("plain, legacy slash, fragment, same-house and cross-house duties retain exact owner custody", t => {
  const f = fixture(t);
  f.office(["deliver", "legacy/duty/deliver", "#deliver", "group#deliver", "engineering#deliver"]);
  const result = f.project();
  assert.equal(result.duties, 5); assert.equal(result.skills, 1);
  const text = readFileSync(f.target, "utf8");
  assert.match(text, /local receiving/); assert.match(text, /foreign receiving/);
  assert.ok(text.includes(join(f.foreign, "duties/deliver.json")), "index links to the actual foreign owner");
  assert.ok(result.sources.some(source => source.root === f.foreign && source.path === "duties/deliver.json"));
  assert.ok(result.sources.some(source => source.path === "skills/execute/reference.md"), "existing linked method closure retained");
  assert.equal(readFileSync(join(f.projectRoot, ".agents/skills/execute/SKILL.md"), "utf8"), readFileSync(join(f.agencyRoot, "skills/execute/SKILL.md"), "utf8"));
  assert.equal(f.project().written, false);
});

test("qualified duty changes refresh the briefing and wrong identities preserve the last complete projection", t => {
  const f = fixture(t); f.office(["engineering#deliver"]);
  const before = f.project(); f.duty(f.foreign, "deliver", "revised foreign receiving");
  const after = f.project(); assert.notDeepEqual(before.sources, after.sources);
  const received = readFileSync(f.target); assert.match(received.toString(), /revised foreign receiving/);
  writeFileSync(join(f.foreign, "duties/deliver.json"), JSON.stringify({ id: "substituted" }));
  assert.throws(() => f.project(), /mismatched duties source identity/);
  assert.deepEqual(readFileSync(f.target), received);
});

test("a moved method keeps its real owner through context, discovery, freshness and retirement", t => {
  const f = fixture(t), source = join(f.foreign, "skills/review/SKILL.md");
  mkdirSync(join(f.foreign, "skills/review"), { recursive: true });
  writeFileSync(source, "---\nname: review\ndescription: Receive the actual source.\n---\nRead [the contract](contract.md).\n");
  writeFileSync(join(f.foreign, "skills/review/contract.md"), "Foreign contract, revision one.\n");
  const office = join(f.agencyRoot, "offices/engineer.json");
  writeFileSync(office, JSON.stringify({ id: "engineer", "provides-skill": ["engineering#review"] }));
  const first = f.project();
  assert.equal(first.skills, 1);
  assert.equal(readFileSync(join(f.projectRoot, ".agents/skills/review/SKILL.md"), "utf8"), readFileSync(source, "utf8"));
  assert.ok(first.sources.some(entry => entry.root === f.foreign && entry.path === "skills/review/contract.md"));
  assert.ok(readFileSync(f.target, "utf8").includes(source));
  writeFileSync(join(f.foreign, "skills/review/contract.md"), "Foreign contract, revision two.\n");
  assert.notDeepEqual(f.project().sources, first.sources);
  const previous = readFileSync(f.target);
  rmSync(source);
  assert.throws(f.project, /skill needs one source/);
  assert.deepEqual(readFileSync(f.target), previous);
  writeFileSync(office, JSON.stringify({ id: "engineer" }));
  assert.equal(f.project().discovery.registered, 0);
  assert.equal(existsSync(join(f.projectRoot, ".agents/skills/review")), false);
});

test("same-named methods from different owners refuse discovery without replacing received context", t => {
  const f = fixture(t); f.project(); const previous = readFileSync(f.target);
  mkdirSync(join(f.foreign, "skills/execute"), { recursive: true });
  writeFileSync(join(f.foreign, "skills/execute/SKILL.md"), "Foreign method with the same discovery name.\n");
  writeFileSync(join(f.agencyRoot, "offices/engineer.json"), JSON.stringify({ id: "engineer", "provides-skill": ["execute", "engineering#execute"] }));
  assert.throws(f.project, /ambiguous discovery names/);
  assert.deepEqual(readFileSync(f.target), previous);
  assert.match(readFileSync(join(f.projectRoot, ".agents/skills/execute/SKILL.md"), "utf8"), /Read \[the original\]/);
});

test("received discovery follows a method's owner move without copying or retaining the old route", t => {
  const f = fixture(t); f.project();
  mkdirSync(join(f.foreign, "skills/execute"), { recursive: true });
  const foreignSource = join(f.foreign, "skills/execute/SKILL.md");
  writeFileSync(foreignSource, "---\nname: execute\ndescription: The moved method.\n---\nCurrent foreign owner.\n");
  writeFileSync(join(f.agencyRoot, "offices/engineer.json"), JSON.stringify({ id: "engineer", "provides-skill": ["engineering#execute"] }));
  const result = f.project();
  assert.equal(result.discovery.referencesChanged, 1);
  assert.equal(readFileSync(join(f.projectRoot, ".agents/skills/execute/SKILL.md"), "utf8"), readFileSync(foreignSource, "utf8"));
  assert.equal(f.project().discovery.referencesChanged, 0);
  assert.ok(readFileSync(f.target, "utf8").includes(foreignSource));
});

test("original source-only custody upgrades before a removed discovery reference retires", t => {
  const f = fixture(t); f.project();
  const marker = "\n\n## Source custody\n\n", text = readFileSync(f.target, "utf8"), index = text.lastIndexOf(marker);
  const custody = JSON.parse(text.slice(index + marker.length));
  delete custody.methods;
  writeFileSync(f.target, text.slice(0, index + marker.length) + JSON.stringify(custody) + "\n");
  writeFileSync(join(f.agencyRoot, "offices/engineer.json"), JSON.stringify({ id: "engineer" }));
  assert.equal(f.project().discovery.registered, 0);
  assert.equal(existsSync(join(f.projectRoot, ".agents/skills/execute")), false);
  assert.ok(readFileSync(f.target, "utf8").includes('"methods": []'));
});

test("qualified references never fall back to another owner's local basename", t => {
  const f = fixture(t); f.project(); const received = readFileSync(f.target);
  f.office(["absent/house#deliver"]);
  assert.throws(() => f.project(), /ENOENT/); assert.deepEqual(readFileSync(f.target), received);
  f.office(["engineering#deliver"]); rmSync(join(f.foreign, "duties/deliver.json"));
  assert.throws(() => f.project(), /ENOENT/); assert.deepEqual(readFileSync(f.target), received);
  assert.throws(() => f.project({ corpusRoot: undefined, projectRoot: undefined }), /declared corpus/);
});

test("invalid escaping, URL and ambiguous duty spellings refuse without replacing context", t => {
  const f = fixture(t); f.project(); const received = readFileSync(f.target);
  for (const ref of ["../engineering#deliver", "group/../engineering#deliver", "/engineering#deliver", "https://foreign.test#deliver", "engineering#deliver#extra", "engineering#../deliver", "engineering%2fother#deliver", "../deliver", "/deliver", "https://foreign.test/deliver", null]) {
    f.office([ref]); assert.throws(() => f.project(), /invalid duties reference/, JSON.stringify(ref));
    assert.deepEqual(readFileSync(f.target), received);
  }
});

test("foreign owner aliases and escaped duty files refuse within the declared corpus boundary", t => {
  const f = fixture(t); f.project(); const received = readFileSync(f.target);
  symlinkSync(join(f.corpusRoot, "engineering"), join(f.corpusRoot, "alias"), "dir");
  f.office(["alias#deliver"]); assert.throws(() => f.project(), /foreign source reference/);
  const outside = mkdtempSync(join(tmpdir(), "outside-office-")); t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, "lib/agency/duties"), { recursive: true });
  writeFileSync(join(outside, "lib/agency/duties/deliver.json"), JSON.stringify({ id: "deliver" }));
  symlinkSync(outside, join(f.corpusRoot, "outside"), "dir");
  f.office(["outside#deliver"]); assert.throws(() => f.project(), /declared corpus|foreign source reference/);
  writeFileSync(join(f.agencyRoot, "duties/outside.json"), JSON.stringify({ id: "deliver", skills: ["execute"] }));
  rmSync(join(f.foreign, "duties/deliver.json")); symlinkSync(join(f.agencyRoot, "duties/outside.json"), join(f.foreign, "duties/deliver.json"));
  f.office(["engineering#deliver"]); assert.throws(() => f.project(), /leaves its declared agency/);
  assert.deepEqual(readFileSync(f.target), received);
});

test("the actual Chief Engineering source receives all five duties from their authored houses", { skip: !process.env.HARNESS_SOURCE_CORPUS }, t => {
  const projectRoot = mkdtempSync(join(tmpdir(), "actual-chief-engineer-")); t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const corpusRoot = process.env.HARNESS_SOURCE_CORPUS, agencyRoot = join(corpusRoot, "services/internal-services-section/lib/agency");
  const target = join(projectRoot, ".office-context/office-context.md");
  const result = projectOfficeContext({ projectRoot, corpusRoot, agencyRoot, target, office: "chief-engineering-officer", detail: "index" });
  assert.equal(result.duties, 5); assert.ok(result.skills > 0);
  const foreign = result.sources.filter(source => source.root !== undefined);
  assert.equal(foreign.length, 4); assert.equal(new Set(foreign.map(source => source.root)).size, 2);
  for (const source of foreign) assert.ok(existsSync(join(source.root, source.path)));
  assert.match(readFileSync(target, "utf8"), /do not grant this process runtime authority/);
});

test("the original CLI derives the corpus from its declared project and accepts an explicit corpus", t => {
  const f = fixture(t); f.office(["engineering#deliver"]); mkdirSync(join(f.projectRoot, ".codex"));
  const config = join(f.projectRoot, ".codex/office.json");
  for (const explicit of [false, true]) {
    writeFileSync(config, JSON.stringify({ type: "SourceOfficeContextProjection", authority: "source-context-only", agencyRoot: f.agencyRoot, office: "engineer", projectRoot: "..", ...(explicit ? { corpusRoot: ".." } : {}), target: "../.office-context/office-context.md", detail: "index" }));
    const result = spawnSync(process.execPath, [new URL("../scripts/project-office-context.mjs", import.meta.url).pathname, config], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).duties, 1);
    assert.match(readFileSync(f.target, "utf8"), /foreign receiving/);
  }
});
