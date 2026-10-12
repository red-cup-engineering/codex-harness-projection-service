import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectOfficeContext } from "../src/projector.mjs";

test("source office changes reach the next projection; incomplete closure leaves prior context intact", t => {
  const root = mkdtempSync(join(tmpdir(), "office-projection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agencyRoot = join(root, "agency"), target = join(root, ".codex/office-context.md");
  for (const p of ["offices", "duties", "skills/receive"]) mkdirSync(join(agencyRoot, p), { recursive: true });
  const office = join(agencyRoot, "offices/cto.json"), method = join(agencyRoot, "skills/receive/SKILL.md");
  writeFileSync(office, JSON.stringify({ id: "cto", "bears-duty": ["firm/duty/receiving"], "provides-skill": ["receive"] }));
  writeFileSync(join(agencyRoot, "duties/receiving.json"), JSON.stringify({ id: "receiving", skills: ["receive"], "receiver-condition": "actual consumer use" }));
  writeFileSync(method, "# Receive\nRead original outcome.");
  const first = projectOfficeContext({ agencyRoot, office: "cto", target });
  assert.equal(first.skills, 1); assert.equal(first.duties, 1);
  assert.match(readFileSync(target, "utf8"), /actual consumer use/);
  writeFileSync(method, "# Receive\nVerify the independently returned exact bytes.");
  const next = projectOfficeContext({ agencyRoot, office: "cto", target });
  assert.notDeepEqual(first.sources, next.sources);
  const received = readFileSync(target, "utf8");
  assert.match(received, /independently returned exact bytes/);
  assert.doesNotMatch(received, /Read original outcome/);
  assert.equal(existsSync(join(root, ".codex/skills")), false);
  rmSync(method);
  assert.throws(() => projectOfficeContext({ agencyRoot, office: "cto", target }), /skill needs one source/);
  assert.equal(readFileSync(target, "utf8"), received);
  assert.throws(() => projectOfficeContext({ agencyRoot, office: "../elsewhere", target }), /canonical office/);
});

test("a current briefing is confirmed without a write; a stale one in a read-only directory is reported as stale", t => {
  const root = mkdtempSync(join(tmpdir(), "office-projection-"));
  t.after(() => { try { chmodSync(join(root, "out"), 0o700); } catch {} rmSync(root, { recursive: true, force: true }); });
  const agencyRoot = join(root, "agency"), out = join(root, "out"), target = join(out, "office-context.md");
  for (const p of ["offices", "duties", "skills/receive"]) mkdirSync(join(agencyRoot, p), { recursive: true });
  const method = join(agencyRoot, "skills/receive/SKILL.md");
  writeFileSync(join(agencyRoot, "offices/cto.json"), JSON.stringify({ id: "cto", "bears-duty": ["firm/duty/receiving"] }));
  writeFileSync(join(agencyRoot, "duties/receiving.json"), JSON.stringify({ id: "receiving", skills: ["receive"] }));
  writeFileSync(method, "# Receive\nOne.");
  assert.equal(projectOfficeContext({ agencyRoot, office: "cto", target }).written, true);
  chmodSync(out, 0o500);
  if (process.getuid?.() === 0) return;
  assert.equal(projectOfficeContext({ agencyRoot, office: "cto", target }).written, false);
  writeFileSync(method, "# Receive\nTwo.");
  assert.throws(() => projectOfficeContext({ agencyRoot, office: "cto", target }), error => error.code === "OFFICE_CONTEXT_STALE");
  assert.match(readFileSync(target, "utf8"), /One\./);
});


test("authored rule corrections enter the actual briefing with custody; refused closure preserves it", t => {
  const root = mkdtempSync(join(tmpdir(), "office-rule-projection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agencyRoot = join(root, "agency"), target = join(root, "office-context.md");
  for (const pool of ["offices", "rules"]) mkdirSync(join(agencyRoot, pool), { recursive: true });
  writeFileSync(join(agencyRoot, "offices/cto.json"), JSON.stringify({ id: "cto" }));
  const rule = join(agencyRoot, "rules/section-owner.json");
  writeFileSync(rule, JSON.stringify({ id: "section-owner", statement: "Use the Leader's section directory.", subject: ["*"], action: ["*"] }));
  const first = projectOfficeContext({ agencyRoot, office: "cto", target });
  assert.equal(first.rules, 1);
  assert.ok(first.sources.some(source => source.path === "rules/section-owner.json"));
  assert.match(readFileSync(target, "utf8"), /Use the Leader's section directory/);
  writeFileSync(rule, JSON.stringify({ id: "section-owner", statement: "The copied forest is not the owner." }));
  const next = projectOfficeContext({ agencyRoot, office: "cto", target });
  assert.notDeepEqual(first.sources, next.sources);
  const received = readFileSync(target, "utf8");
  assert.match(received, /The copied forest is not the owner/);
  assert.doesNotMatch(received, /Use the Leader's section directory/);
  assert.match(received, /do not grant this process runtime authority/);
  writeFileSync(rule, JSON.stringify({ id: "substituted-owner", statement: "Wrong identity" }));
  assert.throws(() => projectOfficeContext({ agencyRoot, office: "cto", target }), /mismatched rules source identity/);
  assert.equal(readFileSync(target, "utf8"), received);
  writeFileSync(rule, " ".repeat(131073));
  assert.throws(() => projectOfficeContext({ agencyRoot, office: "cto", target }), /office context source exceeds bound/);
  assert.equal(readFileSync(target, "utf8"), received);
  rmSync(rule);
  assert.equal(projectOfficeContext({ agencyRoot, office: "cto", target }).rules, 0);
  assert.doesNotMatch(readFileSync(target, "utf8"), /copied forest/);
});


test("index preserves the full rule and source custody while methods remain available on demand", t => {
  const root = mkdtempSync(join(tmpdir(), "office-index-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agencyRoot = join(root, "agency"), target = join(root, "office-context.md");
  for (const pool of ["offices", "rules", "duties", "skills/receive"]) mkdirSync(join(agencyRoot, pool), { recursive: true });
  writeFileSync(join(agencyRoot, "offices/cto.json"), JSON.stringify({ id: "cto", "bears-duty": ["agency/receiving"], "provides-skill": ["receive"] }));
  writeFileSync(join(agencyRoot, "duties/receiving.json"), JSON.stringify({ id: "receiving", "receiver-condition": "independent consumer bytes", skills: ["receive"] }));
  const rule = join(agencyRoot, "rules/source-boundary.json"), method = join(agencyRoot, "skills/receive/SKILL.md");
  writeFileSync(rule, JSON.stringify({ id: "source-boundary", statement: "Preserve the continuing objective.", subject: ["*"], action: ["*"], "x-provenance": "historical annotations" }));
  writeFileSync(method, "# Receive\n" + "conditional detail\n".repeat(5000));
  const first = projectOfficeContext({ agencyRoot, office: "cto", target, detail: "index" });
  const received = readFileSync(target, "utf8");
  assert.match(received, /Preserve the continuing objective/);
  assert.match(received, /independent consumer bytes/);
  assert.ok(received.includes(method));
  assert.doesNotMatch(received, /conditional detail/);
  assert.doesNotMatch(received, /historical annotations/);
  assert.ok(first.sources.some(source => source.path === "skills/receive/SKILL.md"));
  writeFileSync(method, "# Receive\nChanged method.");
  const next = projectOfficeContext({ agencyRoot, office: "cto", target, detail: "index" });
  assert.notDeepEqual(first.sources, next.sources);
  const current = readFileSync(target, "utf8");
  rmSync(method);
  assert.throws(() => projectOfficeContext({ agencyRoot, office: "cto", target, detail: "index" }), /skill needs one source/);
  assert.equal(readFileSync(target, "utf8"), current);
  assert.throws(() => projectOfficeContext({ agencyRoot, office: "cto", target, detail: "unknown" }), /detail/);
});
