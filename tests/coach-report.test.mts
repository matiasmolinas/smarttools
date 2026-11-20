import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreScrew, type ScrewSample } from "../lib/coach.ts";
import { buildReport, grade, reportHtml } from "../lib/report.ts";

function run(o: { angle: number; offset: number; wobble: number; time: number }): ScrewSample[] {
  const s: ScrewSample[] = [];
  s.push({ t: 0, phase: "align", angleDeg: 2, offsetMm: 2, depthMm: 0 });
  for (let i = 0; i <= 20; i++) s.push({ t: o.time * 0.4 + (o.time * 0.6 * i) / 20, phase: "drill", angleDeg: o.angle + o.wobble * Math.sin(i), offsetMm: o.offset, depthMm: 1 + i * 0.6 });
  s.push({ t: o.time, phase: "hold", angleDeg: o.angle, offsetMm: o.offset, depthMm: 14 });
  return s;
}

test("an expert-like screw scores near 100, a shaky slow one much less", () => {
  const expert = scoreScrew(run({ angle: 0.1, offset: 0.1, wobble: 0.01, time: 2.5 }))!;
  const learner = scoreScrew(run({ angle: 0.6, offset: 0.7, wobble: 0.2, time: 7 }))!;
  assert.ok(expert.score >= 95, `${expert.score}`);
  assert.ok(learner.score < 60, `${learner.score}`);
  assert.equal(scoreScrew([{ t: 0, phase: "align", angleDeg: 1, offsetMm: 1, depthMm: 0 }]), null);
});

test("grades and the report's verdict", () => {
  const ok = { name: "S1", face: "top", size: "M5", plannedMm: 14, seatedMm: 13.9, maxAngleDeg: 0.1 };
  assert.equal(grade(ok), "good");
  assert.equal(grade({ ...ok, maxAngleDeg: 0.35 }), "fair");
  assert.equal(grade({ ...ok, maxAngleDeg: 0.8 }), "redo");
  assert.equal(grade({ ...ok, flagged: "part moved" }), "redo");
  const r = buildReport("robot-arm base", [ok, { ...ok, name: "S2", flagged: "part moved" }], 2, "2026-11-20");
  assert.equal(r.verdict, "1 to redo: S2");
  assert.equal(buildReport("x", [ok], 1).verdict, "all 1 within spec (worst 0.10°)");
  assert.ok(reportHtml(r).includes("<td>S2</td>") && reportHtml(r).includes("redo (part moved)"));
});
