// The three projects' edges, native (docs/INTEGRATIONS.md): athos recipes (lib/recipe.ts), agentvcs verify /
// blame / bisect (lib/vcs.ts), and gatekeeper's verdicts on recipes and on change sets (lib/gate.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DEMO_PLAN, validatePlan } from "../lib/plan.ts";
import { defaultContext, type HoleRecord, type JobRecord, type TrackingSettings } from "../lib/jobrecord.ts";
import { buildReport } from "../lib/report.ts";
import { canonical, harnessId, harnessLabel, jobLedger, jobManifest } from "../lib/ledger.ts";
import { blame, bisect, summarize, verifyBundle, type Bundle } from "../lib/vcs.ts";
import { bindCheck, checkJob, declaredAuthor, drillOf, evaluate, parseRecipe, planFromRecipe, recipeFromJob, recipeFromPlan } from "../lib/recipe.ts";
import { gateChanges, gateRecipe, glob, type GateConfig } from "../lib/gate.ts";

const TRACK: TrackingSettings = { detector: "js", filter: "camera", detectPx: 640, camera: { fps60: false, lock: false } };

/** A finished demo job: each hole's depth error (mm) and max angle (deg). */
function job(day: number, errs: [number, number][], tracking: TrackingSettings = TRACK, n = 0): JobRecord {
  const t = (s: number) => new Date(Date.UTC(2026, 10, day, 12, 0, s)).toISOString();
  const holes: HoleRecord[] = DEMO_PLAN.holes.slice(0, errs.length).map((h, i) => ({
    name: h.label, face: "sheet", size: `Ø${h.diameterMm} mm`, plannedMm: h.depthMm, seatedMm: h.depthMm + errs[i][0], maxAngleDeg: errs[i][1],
    startedAt: t(i * 10), endedAt: t(i * 10 + 8), score: 90,
  }));
  return {
    kind: "smarttools-job", v: 1, id: `job-${day}-${n}`, started: t(0), ended: t(50), status: holes.length === DEMO_PLAN.holes.length ? "completed" : "aborted",
    plan: DEMO_PLAN, report: buildReport(DEMO_PLAN.name, holes, DEMO_PLAN.holes.length, t(50)), holes,
    context: { ...defaultContext({ phone: { id: "iphone-15", name: "iPhone 15", provisional: false }, calibration: { lens: true, dock: true } }), tracking },
  };
}
const good: [number, number][] = [[0.2, 0.3], [-0.1, 0.4], [0.3, 0.2], [0.1, 0.5]];
const bad: [number, number][] = [[1.4, 1.2], [-1.1, 1.6], [1.2, 0.9], [0.9, 1.4]];

// ---------------- athos: recipes ----------------

test("an athos piece is read: front matter, statements, multi-line fields, links; History is not a statement", () => {
  const r = parseRecipe(readFileSync(new URL("./fixtures/athos/bracket.md", import.meta.url), "utf8"));
  assert.equal(r.id, "drill-a-bracket-pattern");
  assert.equal(r.title, "Drill a bracket pattern");
  assert.match(r.when, /four-hole bracket/);
  assert.equal(r.meta.status, "candidate");
  assert.deepEqual(r.statements.map((s) => s.id), ["clamp", "d1", "d2"]);
  assert.match(r.statements[0].because, /moves under the bit.*every hole/); // continued on a second line
  assert.deepEqual(r.statements[1].links, ["#d2"]);
  assert.deepEqual(r.statements[2].links, ["#clamp", "other-piece#step"]);
  assert.throws(() => parseRecipe("# just a title\n\nno statements"), /no statements/);
});

test("the pieces in the person's athos store read too (when the athos CLI is installed)", (t) => {
  let list = "";
  try {
    list = execFileSync("athos", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return t.skip("athos is not installed");
  }
  const ids = [...list.matchAll(/([a-z0-9]+(?:-[a-z0-9]+){2,})/g)].map((m) => m[1]).slice(0, 5);
  if (!ids.length) return t.skip("the athos store is empty");
  for (const id of ids) {
    let md = "";
    try {
      md = execFileSync("athos", ["show", id], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    if (!/^## #/m.test(md)) continue;
    const r = parseRecipe(md);
    assert.ok(r.title && r.statements.length, id);
    for (const s of r.statements) assert.ok(s.do, `${id}#${s.id} has a Do`);
  }
});

test("a Check is bound to the engine's measurements; words it does not know are left for the person", () => {
  assert.deepEqual(bindCheck("depth within 0.5 mm and angle under 1°"), { measures: [{ kind: "depth", tolMm: 0.5 }, { kind: "angle", maxDeg: 1 }], manual: "" });
  assert.deepEqual(bindCheck("Angle less than 0,8 deg; no alarm").measures, [{ kind: "angle", maxDeg: 0.8 }, { kind: "clean" }]);
  assert.deepEqual(bindCheck("score at least 80").measures, [{ kind: "score", min: 80 }]);
  const mixed = bindCheck("depth within 0.5 mm and the hole is clean of chips");
  assert.deepEqual(mixed.measures, [{ kind: "depth", tolMm: 0.5 }]);
  assert.match(mixed.manual, /chips/);
  assert.deepEqual(bindCheck("the board does not move when pushed").measures, []);
});

test("a bound Check is answered by the hole's record", () => {
  const j = job(20, good);
  const b = bindCheck("depth within 0.5 mm and angle under 1°");
  assert.equal(evaluate(b, j.holes[0]).status, "pass");
  assert.equal(evaluate(b, job(20, bad).holes[0]).status, "fail");
  assert.match(evaluate(b, job(20, bad).holes[0]).detail, /depth \+1\.40 mm.*angle 1\.20°/);
  assert.equal(evaluate(bindCheck("depth within 0.5 mm and clean of chips"), j.holes[0]).status, "manual");
});

test("recipe ⇄ plan: a plan written as a recipe reads back as the same holes, and a job becomes a recipe", () => {
  const md = recipeFromPlan(DEMO_PLAN);
  const r = parseRecipe(md);
  assert.equal(r.statements.length, 4);
  const back = planFromRecipe(r, { kind: "expert" }, DEMO_PLAN.created);
  assert.deepEqual(back.holes, DEMO_PLAN.holes);
  assert.equal(validatePlan(back).ok, true);
  assert.deepEqual(drillOf("Drill H3: ⌀8,5 mm at (-12.5, 40) mm, 25 mm deep"), { label: "H3", diameterMm: 8.5, x: -12.5, y: 40, depthMm: 25 });
  assert.equal(drillOf("Clamp the board"), null);

  const j = job(20, [[0.2, 0.3], [0.9, 0.4], [0.1, 0.2]]); // an aborted job: D4 not drilled
  const fromJob = parseRecipe(recipeFromJob(j));
  assert.match(fromJob.statements[0].because, /done this way on 2026-11-20: 20\.2 of 20 mm, 0\.30°/);
  assert.match(fromJob.statements[3].because, /not drilled/);
  assert.deepEqual(checkJob(fromJob, j).map((c) => c.outcome.status), ["pass", "fail", "pass", "fail"]);
});

// ---------------- agentvcs: verify, blame, bisect ----------------

test("verify accepts what lib/ledger.ts writes, and names each kind of tampering", () => {
  const b = jobLedger(job(20, good)) as unknown as Bundle;
  assert.deepEqual(verifyBundle(b), { ok: true });
  const edited = structuredClone(b);
  (edited.ledger[1].body.metrics as Record<string, number>)["depth.error_mm"] = 0;
  assert.match((verifyBundle(edited) as { errors: string[] }).errors.join(), /entry 1: its content does not match/);
  const cut = structuredClone(b);
  cut.ledger.splice(2, 1);
  const e = (verifyBundle(cut) as { errors: string[] }).errors.join(" | ");
  assert.match(e, /seq/);
  assert.match(e, /chain is broken/);
  const swapped = structuredClone(b);
  const m = Object.values(swapped.manifests)[0];
  (m.dimensions.phone.content as { name: string }).name = "other";
  assert.match((verifyBundle(swapped) as { errors: string[] }).errors.join(), /dimension phone does not match/);
});

test("the tracking settings are in the manifest, and blame finds the setting that moved the precision", () => {
  const rust = { ...TRACK, detector: "rust" };
  const rows = [job(20, bad, TRACK, 1), job(20, bad, TRACK, 2), job(21, good, rust, 1), job(21, good, rust, 2)].map((j) => summarize(jobLedger(j) as unknown as Bundle));
  assert.equal(rows[2].settings["tracking.detector"], '"rust"');
  const b = blame(rows, "depth.error_mm");
  assert.equal(b[0].setting, "tracking.detector");
  assert.equal(b[0].weak, false);
  assert.deepEqual(b[0].groups.map((g) => [g.value, g.jobs]), [['"rust"', 2], ['"js"', 2]]);
  assert.ok(Math.abs(b[0].spread - (1.15 - 0.175)) < 1e-9, `spread ${b[0].spread}`);
  // identity fields (plan hash, run) never show up as suspects
  assert.ok(!b.some((x) => /plan\.(hash|id)/.test(x.setting)));
});

test("the display is a tracking setting: it reaches the manifest and blame compares classic with simple", () => {
  const classic = { ...TRACK, display: "classic" as const }, simple = { ...TRACK, display: "simple" as const };
  const rows = [job(20, bad, classic, 1), job(20, bad, classic, 2), job(21, good, simple, 1), job(21, good, simple, 2)].map((j) => summarize(jobLedger(j) as unknown as Bundle));
  assert.equal(rows[0].settings["tracking.display"], '"classic"');
  assert.equal(rows[2].settings["tracking.display"], '"simple"');
  const b = blame(rows, "depth.error_mm");
  assert.equal(b[0].setting, "tracking.display");
  assert.deepEqual(b[0].groups.map((g) => [g.value, g.jobs]), [['"simple"', 2], ['"classic"', 2]]);
});

test("bisect finds the first bad job in time order and what changed from the last good one", () => {
  const tip = { ...TRACK, filter: "tip" as const };
  const big = { ...tip, detectPx: 960 };
  const jobs = [job(10, good), job(11, good), job(12, good, tip), job(13, good, tip), job(14, bad, big), job(15, bad, big), job(16, bad, big)];
  const rows = jobs.map((j) => summarize(jobLedger(j) as unknown as Bundle)).reverse();
  const r = bisect(rows, (x) => x.metrics["depth.error_mm"] > 0.5)!;
  assert.equal(r.firstBad.run, "smarttools-job-14-0");
  assert.equal(r.lastGood?.run, "smarttools-job-13-0");
  assert.deepEqual(r.changed.filter((c) => c.setting.startsWith("tracking")), [{ setting: "tracking.detectPx", from: "640", to: "960" }]);
  assert.ok(r.probes <= 5);
  assert.equal(bisect(rows, () => false), null);
});

test("the harness fingerprint: build and engine hash reach the manifest only when known, and change its id", () => {
  const plain = job(20, good);
  const m0 = jobManifest(plain);
  // a job without them keeps today's manifest exactly
  assert.deepEqual(m0.dimensions.app.content, { name: "smarttools", version: plain.context.app, source: "camera" });
  assert.deepEqual(m0.dimensions.engine.content, { abi: plain.context.engineAbi });
  const H1 = "b3:" + "1".repeat(64), H2 = "b3:" + "2".repeat(64);
  const withIt = (engineHash: string, build = "abc1234"): JobRecord => ({ ...plain, context: { ...plain.context, build, engineHash } });
  const m1 = jobManifest(withIt(H1));
  assert.deepEqual(m1.dimensions.app.content, { name: "smarttools", version: plain.context.app, source: "camera", build: "abc1234" });
  assert.deepEqual(m1.dimensions.engine.content, { abi: plain.context.engineAbi, hash: H1 });
  assert.notEqual(m1.manifest_id, m0.manifest_id);
  assert.notEqual(jobManifest(withIt(H2)).manifest_id, m1.manifest_id, "another engine binary, another harness");
  assert.notEqual(jobManifest(withIt(H1, "def5678")).manifest_id, m1.manifest_id, "another build, another harness");
  assert.equal(harnessId(withIt(H1)), m1.manifest_id);
  assert.equal(harnessId(plain), m0.manifest_id);
  assert.match(harnessLabel(plain), /^harness [0-9a-f]{12}$/);
  assert.equal(harnessLabel(withIt(H1)), `harness ${m1.manifest_id.slice(3, 15)}`);
  assert.deepEqual(verifyBundle(jobLedger(withIt(H1)) as unknown as Bundle), { ok: true });
});

test("blame names the engine binary when only its hash differs between good and bad jobs", () => {
  const H1 = "b3:" + "a".repeat(64), H2 = "b3:" + "b".repeat(64);
  const on = (j: JobRecord, engineHash: string): JobRecord => ({ ...j, context: { ...j.context, build: "abc1234", engineHash } });
  const rows = [on(job(20, good, TRACK, 1), H1), on(job(20, good, TRACK, 2), H1), on(job(21, bad, TRACK, 1), H2), on(job(21, bad, TRACK, 2), H2)].map((j) => summarize(jobLedger(j) as unknown as Bundle));
  const b = blame(rows, "depth.error_mm");
  assert.equal(b.length, 1, b.map((x) => x.setting).join(", "));
  assert.equal(b[0].setting, "engine.hash");
  assert.equal(b[0].weak, false);
  assert.deepEqual(b[0].groups.map((g) => g.value), [JSON.stringify(H1), JSON.stringify(H2)]);
});

test("a hole's position error becomes position.error_mm in its step; a hole without it writes the step it always did", () => {
  const plain = job(20, good);
  const withPos: JobRecord = { ...plain, holes: plain.holes.map((h, i) => ({ ...h, offsetMm: [0.31, 0.12, 0.5, 0.08][i] })) };
  const steps = (j: JobRecord) => (jobLedger(j).ledger.filter((e) => e.kind === "step") as { body: { metrics: Record<string, number> } }[]).map((e) => e.body.metrics);
  assert.deepEqual(steps(withPos).map((m) => m["position.error_mm"]), [0.31, 0.12, 0.5, 0.08]);
  for (const m of steps(plain)) assert.deepEqual(Object.keys(m).sort(), ["angle.max_deg", "depth.error_mm", "hole.flagged", "hole.score"]);
  // the old job's ledger is a function of the old fields only: adding then removing the field gives the same bytes
  const stripped: JobRecord = { ...withPos, holes: withPos.holes.map(({ offsetMm: _, ...h }) => h) };
  assert.equal(canonical(jobLedger(stripped)), canonical(jobLedger(plain)));
});

test("a Check can ask for the position: offset or position within N mm", () => {
  assert.deepEqual(bindCheck("depth within 0.5 mm, angle under 1° and position within 0.75 mm"), { measures: [{ kind: "depth", tolMm: 0.5 }, { kind: "angle", maxDeg: 1 }, { kind: "position", maxMm: 0.75 }], manual: "" });
  assert.deepEqual(bindCheck("offset under 1 mm").measures, [{ kind: "position", maxMm: 1 }]);
  assert.deepEqual(bindCheck("position error at most 0,5 mm").measures, [{ kind: "position", maxMm: 0.5 }]);
  const h = job(20, good).holes[0];
  const b = bindCheck("position within 0.75 mm");
  assert.equal(evaluate(b, { ...h, offsetMm: 0.31 }).status, "pass");
  assert.match(evaluate(b, { ...h, offsetMm: 0.31 }).detail, /position 0\.31 mm \(≤ 0\.75 mm\)/);
  assert.equal(evaluate(b, { ...h, offsetMm: 0.9 }).status, "fail");
  // a hole recorded before the position was kept cannot pass it
  assert.equal(evaluate(b, h).status, "fail");
  assert.match(evaluate(b, h).detail, /position – /);
});

// ---------------- gatekeeper: recipes and change sets ----------------

test("a recipe is gated before the engine sees it: fast track, escalate to a person, or rejected", () => {
  const fast = gateRecipe(recipeFromPlan(DEMO_PLAN));
  assert.equal(fast.verdict, "FAST_TRACK");
  assert.equal(fast.plan?.holes.length, 4);

  const piece = readFileSync(new URL("./fixtures/athos/bracket.md", import.meta.url), "utf8");
  const g = gateRecipe(piece);
  assert.equal(g.verdict, "ESCALATE"); // #d2 says "flush with the surface": the engine does not measure that
  assert.match(g.reasons.join(), /#d2/);
  assert.match(g.manual.join(), /#clamp: Clamp the board/);
  assert.equal(g.plan?.holes.length, 2);

  assert.equal(gateRecipe(recipeFromPlan(DEMO_PLAN, { check: "angle under 5°" })).verdict, "ESCALATE");
  assert.equal(gateRecipe(recipeFromPlan(DEMO_PLAN), { kind: "ai" }).verdict, "ESCALATE");

  const deep = gateRecipe(recipeFromPlan({ ...DEMO_PLAN, holes: [{ ...DEMO_PLAN.holes[0], depthMm: 200 }] }));
  assert.equal(deep.verdict, "REJECTED");
  assert.equal(deep.plan, undefined);
  assert.match(deep.reasons.join(), /depth must be/);
  assert.match(gateRecipe(recipeFromPlan(DEMO_PLAN).replace("Ø6 mm at (0, 60) mm", "Ø6 mm near the corner")).reasons.join(), /not a hole the engine can read/);
  assert.equal(gateRecipe("hello").verdict, "REJECTED");
});

// ---------------- authorship: who wrote a recipe, and the plan that keeps it ----------------

const BRACKET = readFileSync(new URL("./fixtures/athos/bracket.md", import.meta.url), "utf8");
const front = (lines: string[]) => `---\nid: t\ntitle: T\n${lines.join("\n")}\n---\n\n## #a\n**Do:** Drill A: Ø6 mm at (0, 60) mm, 20 mm deep\n**Check:** depth within 0.5 mm\n`;

test("one level of nested front matter is kept as dotted keys", () => {
  const r = parseRecipe(BRACKET);
  assert.equal(r.meta["origin.platform"], "claude-code");
  assert.equal(r.meta.version, "1"); // the key after the nested block is top level again
  assert.equal(r.meta["origin.version"], undefined);
  const deep = parseRecipe(front(["a:", "  b: 1", "    c: 2", "d: x", "  e: 3"]));
  assert.equal(deep.meta["a.b"], "1");
  assert.equal(deep.meta["a.c"], "2"); // deeper indentation still counts as one level under a
  assert.equal(deep.meta["d.e"], undefined); // d has a value: nothing nests under it
});

test("declaredAuthor: what the recipe says about who wrote it", () => {
  const of = (lines: string[]) => declaredAuthor(parseRecipe(front(lines)));
  assert.deepEqual(of(["author: ai"]), { kind: "ai", why: "the recipe says an AI wrote it" });
  assert.deepEqual(of(["author: Expert", "author_name: A. Carpenter"]), { kind: "expert", name: "A. Carpenter", why: "the recipe says an expert wrote it" });
  assert.equal(of(["author: manual"])?.kind, "manual");
  assert.deepEqual(of(["origin:", "  platform: claude-code"]), { kind: "ai", why: "learned by an agent (claude-code)" });
  assert.equal(of(["author: expert", "origin:", "  platform: claude-code"])?.kind, "expert"); // author: wins over the origin
  assert.equal(of(["author: someone"]), null);
  assert.equal(of([]), null);
});

test("recipeFromPlan writes the author; a recipe written from an AI's plan gates back as an AI's", () => {
  assert.match(recipeFromPlan(DEMO_PLAN), /^author: manual\nauthor_name: SmartTools$/m);
  assert.match(recipeFromPlan({ ...DEMO_PLAN, author: { kind: "pointer" } }), /^author: manual$/m);
  assert.doesNotMatch(recipeFromPlan({ ...DEMO_PLAN, author: { kind: "pointer" } }), /author_name/);
  const ai = gateRecipe(recipeFromPlan({ ...DEMO_PLAN, author: { kind: "ai" } }));
  assert.equal(ai.verdict, "ESCALATE");
  assert.equal(ai.declared, true);
  assert.deepEqual(ai.author, { kind: "ai" });
  assert.match(ai.reasons.join(), /written by an AI \(the recipe says an AI wrote it\)/);
  assert.match(recipeFromJob(job(20, good)), /^author: manual$/m);
});

test("a recipe that names nobody is treated as an AI's; a declared or given author decides", () => {
  const nobody = recipeFromPlan(DEMO_PLAN).replace(/^author.*\n/gm, "");
  const g = gateRecipe(nobody);
  assert.equal(g.verdict, "ESCALATE");
  assert.equal(g.declared, false);
  assert.deepEqual(g.author, { kind: "ai" });
  assert.deepEqual(g.reasons, ["nobody is named as its author: treated as written by an AI, a person reviews it before the first hole"]);
  assert.equal(g.plan?.author.kind, "ai");
  // the caller vouches for it: an expert's recipe with measurable Checks goes straight through
  const trusted = gateRecipe(nobody, { kind: "expert" });
  assert.equal(trusted.verdict, "FAST_TRACK");
  assert.equal(trusted.declared, true);
  const expert = gateRecipe(nobody.replace("projects:", "author: expert\nprojects:"));
  assert.equal(expert.verdict, "FAST_TRACK");
  assert.deepEqual(expert.author, { kind: "expert" });
  // the athos fixture was learned by an agent: with no author passed it is an AI's
  const b = gateRecipe(BRACKET);
  assert.equal(b.author.kind, "ai");
  assert.equal(b.declared, true);
  assert.match(b.reasons.join(), /written by an AI \(learned by an agent \(claude-code\)\)/);
  assert.doesNotMatch(gateRecipe(BRACKET, { kind: "expert" }).reasons.join(), /AI/);
  // nothing to read: still says who it would be
  assert.deepEqual(gateRecipe("hello"), { verdict: "REJECTED", reasons: ["not a recipe: no statements (## #id)"], manual: [], author: { kind: "ai" }, declared: false });
});

test("the plan a recipe makes carries the recipe, and validatePlan checks recipe and reviewed", () => {
  const md = recipeFromPlan(DEMO_PLAN);
  const g = gateRecipe(md, undefined, DEMO_PLAN.created);
  assert.deepEqual(g.plan?.recipe, { id: "demo-4-holes-40-mm-square-20-mm-deep", md });
  assert.equal(validatePlan(g.plan).ok, true);
  assert.equal(validatePlan({ ...g.plan, reviewed: "2026-11-23T10:00:00.000Z" }).ok, true);
  const errs = (p: unknown) => (validatePlan(p) as { ok: false; errors: string[] }).errors.join(" | ");
  assert.match(errs({ ...DEMO_PLAN, reviewed: "yesterday" }), /reviewed is not a date/);
  assert.match(errs({ ...DEMO_PLAN, reviewed: 5 }), /reviewed is not a date/);
  assert.match(errs({ ...DEMO_PLAN, recipe: { id: "", md } }), /recipe\.id is missing/);
  assert.match(errs({ ...DEMO_PLAN, recipe: { id: "x" } }), /recipe\.md must be text/);
  assert.match(errs({ ...DEMO_PLAN, recipe: { id: "x", md: "# a title, no steps" } }), /not a recipe/);
  assert.match(errs({ ...DEMO_PLAN, recipe: { id: "x", md: md + " ".repeat(20_001) } }), /longer than 20000/);
  assert.match(errs({ ...DEMO_PLAN, recipe: null }), /recipe must be an object/);
  assert.equal(validatePlan(DEMO_PLAN).ok, true); // old plans, with neither, stay valid
  // too long to keep: the gate refuses it rather than dropping the recipe
  const long = gateRecipe(`${md}\n## History\n${"x".repeat(20_001)}\n`);
  assert.equal(long.verdict, "REJECTED");
  assert.match(long.reasons.join(), /longer than 20000/);
});

const CFG = JSON.parse(readFileSync(new URL("../gate.config.json", import.meta.url), "utf8")) as GateConfig;
const src = (abiRs: number, abiTs: number) => (f: string) => (f === "engine/src/ffi.rs" ? `pub const ABI_VERSION: u32 = ${abiRs};` : f === "lib/engine.ts" ? `export const ENGINE_ABI = ${abiTs};` : "{}");

test("a change set is gated: screens fast-track, the engine escalates, a stale WebAssembly or an ABI mismatch is rejected", () => {
  assert.ok(glob("lib/workers/**").test("lib/workers/tracker.worker.ts"));
  assert.ok(!glob("*.md").test("docs/FIELD-TEST.md"));
  assert.equal(gateChanges(["components/HudScreen.tsx", "docs/FIELD-TEST.md"], src(6, 6), CFG).verdict, "FAST_TRACK");
  const eng = gateChanges(["engine/src/detect.rs", "public/engine/nav_core.wasm"], src(6, 6), CFG);
  assert.equal(eng.verdict, "ESCALATE");
  assert.ok(eng.run.includes("npm run test:e2e"));
  assert.match(gateChanges(["engine/src/detect.rs"], src(6, 6), CFG).reasons.join(), /not rebuilt/);
  assert.equal(gateChanges(["engine/src/ffi.rs", "public/engine/nav_core.wasm"], src(7, 6), CFG).verdict, "REJECTED");
  assert.equal(gateChanges(["somewhere/new.ts"], src(6, 6), CFG).verdict, "ESCALATE");
  // every file in the repository falls in a capsule
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  const loose = gateChanges(files, src(6, 6), CFG).touched.filter((t) => t.capsule === "(none)").map((t) => t.file);
  assert.deepEqual(loose, []);
});
