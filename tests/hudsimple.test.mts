import { test } from "node:test";
import assert from "node:assert/strict";
import { readout, depthBar, wordsFor, drawSimple, readUiPrefs, uiColorHex, displaySetting, chipNumbers, SIMPLE_GREEN, SIMPLE_AMBER, ABOVE_FULL_MM, type Readout, type ReadoutContext } from "../lib/hudsimple.ts";
import { drawGuide } from "../lib/hudguide.ts";
import type { SimState } from "../lib/sim.ts";
import type { Overlay } from "../lib/hud.ts";

/** an engine-fed state as lib/render/hudview.ts fills it: approaching A2, 40 mm off, 30 mm above, 2° off */
const S: SimState = {
  t: 1, phase: "approach", targetIndex: 1, target: { x: 0.04, y: -0.06 },
  tip: { x: 0.08, y: -0.04, z: 0.03 }, chuck: { x: 0.08, y: -0.04, z: 0.14 }, axis: { x: 0, y: 0, z: -1 },
  yawDeg: 1.2, pitchDeg: -1.6, angleErrDeg: 2, offsetMm: 40, gapMm: 30, depthMm: 0,
  aligned: false, onTarget: false, drilled: [true, false, false], bitSpin: 0, label: "A2", depthTargetMm: 14, action: "drill",
};
const OV: Overlay = {
  lost: false, aim: { x: 700, y: 500 }, mark: { x: 640, y: 300 }, quads: [[{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }, { x: 10, y: 60 }]],
  info: "6 tags", gate: { ready: false, locking: false, message: "move onto the mark" }, calibrating: null, alarms: 0, hint: null,
  markers: 6, tolDeg: 0.5, tipPx: { x: 640, y: 600 }, bitPx: { x: 640, y: 400 },
};
const C: ReadoutContext = { tipPx: { x: 640, y: 600 }, markPx: { x: 640, y: 300 }, calibrated: true };
/** on the mark, touching, square, gate ready */
const READY: Partial<SimState> = { phase: "align", offsetMm: 0.3, gapMm: 0, angleErrDeg: 0.2 };

const r = (s: Partial<SimState> = {}, ov: Partial<Overlay> = {}, c: Partial<ReadoutContext> = {}): Readout =>
  readout({ ...S, ...s }, { ...OV, ...ov }, { ...C, ...c });
const pick = (x: Readout) => [x.icon, x.value, x.unit, x.level];

test("readout: calibrating, stop alarms, lost, not calibrated, few markers", () => {
  assert.deepEqual(pick(r({}, { calibrating: { text: "lens", progress: 0.426, count: 3 } })), ["setup", "43", "%", "guide"]);
  assert.deepEqual(pick(r({}, { alarms: 16 })), ["stop", "", "", "stop"]);
  assert.deepEqual(pick(r({}, { alarms: 8 })), ["stop", "", "", "stop"]);
  assert.deepEqual(pick(r({}, { alarms: 2 })), ["arrow", "50", "mm", "guide"], "other alarm bits are not STOP");
  assert.deepEqual(pick(r({}, { lost: true, alarms: 16 })), ["stop", "", "", "stop"], "STOP wins over lost");
  assert.deepEqual(pick(r({}, { lost: true })), ["search", "", "", "warn"]);
  assert.deepEqual(pick(r({}, {}, { calibrated: false })), ["setup", "", "", "warn"]);
  assert.deepEqual(pick(r({}, { markers: 3 })), ["search", "3", "", "warn"]);
  assert.deepEqual(pick(r({}, { markers: undefined })), ["search", "0", "", "warn"]);
});

test("readout: hold, retract, drilling", () => {
  assert.deepEqual(pick(r({ phase: "hold", depthMm: 14.04, angleErrDeg: 0.2 })), ["check", "14.0", "mm", "ok"]);
  assert.deepEqual(pick(r({ phase: "retract" })), ["check", "", "", "ok"]);
  assert.deepEqual(pick(r({ phase: "drill", depthMm: 5, angleErrDeg: 0.84 })), ["level", "0.8", "°", "warn"]);
  assert.deepEqual(pick(r({ phase: "drill", depthMm: 5.4, angleErrDeg: 0.3 })), ["drill", "9", "mm", "guide"]);
  assert.deepEqual(pick(r({ phase: "drill", depthMm: 13, angleErrDeg: 0.3 })), ["drill", "1", "mm", "guide"], "no ease-off level: guide");
  assert.deepEqual(pick(r({ phase: "drill", depthMm: 15, angleErrDeg: 0.3 })), ["drill", "0", "mm", "guide"], "never negative");
  assert.deepEqual(pick(r({ phase: "drill", depthMm: 10, angleErrDeg: 0.3, depthTargetMm: undefined })), ["drill", "25", "mm", "guide"], "default 35 mm");
});

test("readout: approach: the distance, its formatting and the arrow's angle", () => {
  const far = r();
  assert.deepEqual(pick(far), ["arrow", "50", "mm", "guide"]); // hypot(40, 30)
  assert.ok(Math.abs(far.angle! - -Math.PI / 2) < 1e-12, "the mark is straight up from the tip");
  assert.equal(r({ offsetMm: 6, gapMm: 8 }).value, "10", "10 mm and over: no decimals");
  assert.equal(r({ offsetMm: 3, gapMm: 4 }).value, "5.0", "under 10 mm: one decimal");
  assert.equal(r({ offsetMm: 2.5, gapMm: -1 }).value, "2.5", "a negative gap does not count");
  const right = r({}, {}, { markPx: { x: 740, y: 600 } });
  assert.ok(Math.abs(right.angle!) < 1e-12, "mark to the right: angle 0");
  const downLeft = r({}, {}, { markPx: { x: 540, y: 700 } });
  assert.ok(Math.abs(downLeft.angle! - (3 * Math.PI) / 4) < 1e-12, "down-left: 135°");
  assert.ok(Math.abs(r({}, {}, { tipPx: null }).angle! - -Math.PI / 2) < 1e-12, "no tip: points up");
});

test("readout: on the mark: touch down, tilt, hold still, ready", () => {
  assert.deepEqual(pick(r({ offsetMm: 0.5, gapMm: 12.4 })), ["down", "12", "mm", "guide"]);
  assert.deepEqual(pick(r({ offsetMm: 0.5, gapMm: 0.2, angleErrDeg: 1.84 })), ["level", "1.8", "°", "guide"]);
  assert.deepEqual(pick(r(READY)), ["level", "0.2", "°", "guide"], "gate not ready");
  assert.deepEqual(pick(r(READY, { gate: { ready: true, message: null } })), ["check", "0.2", "°", "ok"]);
  assert.deepEqual(pick(r(READY, { gate: undefined })), ["check", "0.2", "°", "ok"]);
  // the tolerance in use decides square
  assert.deepEqual(pick(r({ ...READY, angleErrDeg: 0.8 }, { gate: { ready: true, message: null }, tolDeg: 1 })), ["check", "0.8", "°", "ok"]);
  assert.deepEqual(pick(r({ ...READY, angleErrDeg: 0.8 }, { gate: { ready: true, message: null } })), ["level", "0.8", "°", "guide"]);
});

test("wordsFor: the classic banner's words", () => {
  assert.deepEqual(wordsFor(S, OV, C), { title: "A2 · 50 mm", sub: "move the tip to the cross" });
  assert.equal(wordsFor(S, { ...OV, lost: true }, C).title, "Find the sheet");
  assert.equal(wordsFor({ ...S, ...READY }, OV, C).title, "Hold still");
  assert.equal(wordsFor({ ...S, phase: "drill", depthMm: 5, angleErrDeg: 0.3 }, OV, C).title, "Drill · 9 mm");
  assert.equal(wordsFor(S, { ...OV, alarms: 16 }, C).title, "STOP · no-go");
});

test("depthBar: surface, above, depth, target, over", () => {
  assert.deepEqual(depthBar(0, 0, 14), { above: 0, below: 0, target: -0.75, over: false, beyond: false });
  assert.deepEqual(depthBar(30, 0, 14), { above: 0.5, below: 0, target: -0.75, over: false, beyond: false });
  assert.deepEqual(depthBar(ABOVE_FULL_MM, 0, 14), { above: 1, below: 0, target: -0.75, over: false, beyond: false });
  assert.deepEqual(depthBar(200, 0, 14), { above: 1, below: 0, target: -0.75, over: false, beyond: true });
  assert.deepEqual(depthBar(0, 7, 14), { above: 0, below: -0.375, target: -0.75, over: false, beyond: false });
  assert.deepEqual(depthBar(0, 14, 14), { above: 0, below: -0.75, target: -0.75, over: false, beyond: false });
  assert.deepEqual(depthBar(0, 14.5, 14).over, false, "0.5 mm of slack");
  const over = depthBar(0, 16, 14);
  assert.equal(over.over, true);
  assert.ok(Math.abs(over.below - -0.75 * 16 / 14) < 1e-12);
  assert.equal(depthBar(0, 40, 14).below, -1, "clamped at the bottom");
  assert.equal(depthBar(5, 3, 14).above, 0, "in the material: no height");
});

/** a canvas context that accepts every call and records the ones that draw */
function fakeCtx() {
  const calls: string[] = [];
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "measureText") return (s: string) => ({ width: s.length * 10 });
      return () => { calls.push(String(k)); };
    },
    set(t, k, v) { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}
const video = { width: 1280, height: 720 } as unknown as HTMLCanvasElement;

test("drawSimple draws in every level, with and without the video", () => {
  const cases: [string, Partial<SimState>, Partial<Overlay>, Readout["level"]][] = [
    ["guide", {}, {}, "guide"],
    ["ok", READY, { gate: { ready: true, message: null } }, "ok"],
    ["warn", { phase: "drill", depthMm: 16, angleErrDeg: 2 }, {}, "warn"],
    ["stop", {}, { alarms: 16 }, "stop"],
    ["lost", {}, { lost: true }, "warn"],
  ];
  for (const [name, s, ov, level] of cases) {
    assert.equal(r(s, ov).level, level, name);
    for (const showVideo of [false, true]) {
      const { ctx, calls } = fakeCtx();
      drawSimple(ctx, { ...S, ...s }, 400, 850, { video, overlay: { ...OV, ...ov }, toolCalibrated: true, showVideo, color: "#3ee59b", rightInset: 88 });
      assert.equal(calls.includes("drawImage"), showVideo, `${name}: the video only when asked`);
      assert.ok(calls.includes("stroke"), `${name}: something is drawn`);
    }
  }
  // the readout hidden under a sheet; no video size yet
  const { ctx } = fakeCtx();
  drawSimple(ctx, S, 400, 850, { video, overlay: OV, toolCalibrated: true, showVideo: false, color: "#ffb547", readout: false });
  drawSimple(ctx, S, 400, 850, { video: { width: 0, height: 0 } as unknown as HTMLCanvasElement, overlay: OV, toolCalibrated: false, showVideo: true, color: "#ffb547" });
});

test("the mark and the tip sit on the same pixels in classic and simple, video or not", () => {
  const at = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    const arcs: number[][] = [];
    const { ctx } = fakeCtx();
    (ctx as unknown as Record<string, unknown>).arc = (x: number, y: number, r: number) => arcs.push([x, y, r]);
    draw(ctx);
    return arcs;
  };
  const s = { ...S, offsetMm: 0.5, gapMm: 12 };
  const opts = { video, overlay: OV, toolCalibrated: true };
  const classic = at((ctx) => drawGuide(ctx, s, 400, 850, { ...opts, banner: false }));
  const simple = at((ctx) => drawSimple(ctx, s, 400, 850, { ...opts, showVideo: false, color: "#3ee59b", readout: false }));
  const simpleVideo = at((ctx) => drawSimple(ctx, s, 400, 850, { ...opts, showVideo: true, color: "#3ee59b", readout: false }));
  // the first arc is the mark's circle in each; the level's outer ring is centred on the tip
  assert.deepEqual(simple[0], classic[0]);
  assert.deepEqual(simpleVideo[0], classic[0]);
  const ring = (a: number[][]) => a.find((x) => Math.abs(x[2] - (400 / 100) * 11) < 1e-9);
  assert.ok(ring(classic), "the level is drawn");
  assert.deepEqual(ring(simple), ring(classic));
});

test("readUiPrefs: classic, no video and green by default; anything unknown is the default", () => {
  const from = (o: Record<string, string>) => readUiPrefs((k) => o[k] ?? null);
  assert.deepEqual(from({}), { ui: "classic", video: false, color: "green" });
  assert.deepEqual(from({ "st-ui": "simple", "st-ui-video": "1", "st-ui-color": "amber" }), { ui: "simple", video: true, color: "amber" });
  assert.deepEqual(from({ "st-ui": "fancy", "st-ui-video": "yes", "st-ui-color": "red" }), { ui: "classic", video: false, color: "green" });
  assert.equal(uiColorHex("green"), SIMPLE_GREEN);
  assert.equal(uiColorHex("amber"), SIMPLE_AMBER);
});

test("displaySetting: what a job records", () => {
  assert.equal(displaySetting("classic", false), "classic");
  assert.equal(displaySetting("classic", true), "classic");
  assert.equal(displaySetting("simple", false), "simple");
  assert.equal(displaySetting("simple", true), "simple+video");
});

test("chipNumbers: only the measured numbers, the detail as it is otherwise", () => {
  assert.equal(chipNumbers("depth -0.07 mm (±0.5) · angle 0.30° (≤ 0.5°)"), "−0.07 mm · 0.30°");
  assert.equal(chipNumbers("depth +0.12 mm (±0.5) · no alarm"), "+0.12 mm");
  assert.equal(chipNumbers("score 87 (≥ 80)"), "87");
  assert.equal(chipNumbers("score – (≥ 80)"), "–");
  assert.equal(chipNumbers("angle 1.20° (≤ 0.5°) · flagged: part moved"), "1.20°");
  assert.equal(chipNumbers("not drilled"), "not drilled");
  assert.equal(chipNumbers("confirmed: deburred"), "confirmed: deburred");
  assert.equal(chipNumbers(""), "");
});
