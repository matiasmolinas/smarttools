import { test } from "node:test";
import assert from "node:assert/strict";
import { readout, depthBar, wordsFor, drawSimple, readUiPrefs, displaySetting, chipNumbers, focusLook, screwNumber, controlLook, phaseButtons, textKey, captureHint, pilotRuns, STAY_FINDABLE, COL, DIM_ALPHA, ABOVE_FULL_MM, type Readout, type ReadoutContext, type SimpleOptions } from "../lib/hudsimple.ts";
import { focus, type PartFit, type PilotState, type PilotText } from "../lib/pilot.ts";
import type { PilotOverlay } from "../lib/pilotnav.ts";
import { SHEET0_ONLY } from "../lib/tablemap.ts";
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
      drawSimple(ctx, { ...S, ...s }, 400, 850, { video, overlay: { ...OV, ...ov }, toolCalibrated: true, showVideo, rightInset: 88 });
      assert.equal(calls.includes("drawImage"), showVideo, `${name}: the video only when asked`);
      assert.ok(calls.includes("stroke"), `${name}: something is drawn`);
    }
  }
  // the readout hidden under a sheet; no video size yet
  const { ctx } = fakeCtx();
  drawSimple(ctx, S, 400, 850, { video, overlay: OV, toolCalibrated: true, showVideo: false, readout: false });
  drawSimple(ctx, S, 400, 850, { video: { width: 0, height: 0 } as unknown as HTMLCanvasElement, overlay: OV, toolCalibrated: false, showVideo: true });
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
  const simple = at((ctx) => drawSimple(ctx, s, 400, 850, { ...opts, showVideo: false, readout: false }));
  const simpleVideo = at((ctx) => drawSimple(ctx, s, 400, 850, { ...opts, showVideo: true, readout: false }));
  // the first arc is the mark's circle in each; the level's outer ring is centred on the tip
  assert.deepEqual(simple[0], classic[0]);
  assert.deepEqual(simpleVideo[0], classic[0]);
  const ring = (a: number[][]) => a.find((x) => Math.abs(x[2] - (400 / 100) * 11) < 1e-9);
  assert.ok(ring(classic), "the level is drawn");
  assert.deepEqual(ring(simple), ring(classic));
});

/** a canvas context with a real save / restore stack that records each stroke, fill and text with the state it
 *  was drawn in */
function recCtx() {
  type St = { globalAlpha: number; shadowBlur: number; shadowColor: string; strokeStyle: string; fillStyle: string };
  const draws: { op: string; alpha: number; blur: number; color: string; text?: string }[] = [];
  let st: St = { globalAlpha: 1, shadowBlur: 0, shadowColor: "rgba(0,0,0,0)", strokeStyle: "#000", fillStyle: "#000" };
  const stack: St[] = [];
  const rec = (op: string, color: string, text?: string) => draws.push({ op, alpha: st.globalAlpha, blur: st.shadowBlur, color, text });
  const fns: Record<string, (...a: unknown[]) => unknown> = {
    save: () => void stack.push({ ...st }),
    restore: () => void (st = stack.pop() ?? st),
    stroke: () => rec("stroke", st.strokeStyle),
    fill: () => rec("fill", st.fillStyle),
    fillRect: () => rec("fillRect", st.fillStyle),
    fillText: (t) => rec("fillText", st.fillStyle, String(t)),
    measureText: (t) => ({ width: String(t).length * 10 }),
  };
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, k) {
      if (typeof k === "string" && k in fns) return fns[k];
      if (typeof k === "string" && k in st) return st[k as keyof St];
      return () => {};
    },
    set(_t, k, v) {
      if (typeof k === "string" && k in st) (st as Record<string, unknown>)[k] = v;
      else if (typeof k === "string" && typeof v === "function") fns[k] = v; // a test's own probe
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, draws, state: () => st, depth: () => stack.length };
}

const PS: PilotState = {
  phase: "sheet", sheetOk: false, sheets: SHEET0_ONLY.map((x) => ({ ...x })), markers: 6, corners: 0, capture: null, fit: null, done: 0, total: 4,
  nearScrew: false, drilling: false, ready: false, stop: false, toolCalibrated: true,
};
const sq = (x: number, y: number, d: number) => [{ x, y }, { x: x + d, y }, { x: x + d, y: y + d }, { x, y: y + d }];
const SHEET_PX = sq(100, 100, 500);
const PART_PX = sq(700, 300, 200);
const BOTTOM_PX = sq(690, 320, 200);
const pilotOv = (p: Partial<PilotOverlay>): PilotOverlay => ({ sheetsPx: [{ k: 0, px: SHEET_PX, state: "mapped", progress: 1 }], partPx: null, bottomPx: null, cornersPx: [], screwsPx: [], ...p });
const drawP = (pilot: PilotOverlay, o: Partial<SimpleOptions> = {}, s: Partial<SimState> = {}, ov: Partial<Overlay> = {}) => {
  const r = recCtx();
  drawSimple(r.ctx, { ...S, ...s }, 400, 850, { video, overlay: { ...OV, ...ov, pilot }, toolCalibrated: true, showVideo: false, rightInset: 88, ...o });
  assert.equal(r.depth(), 0, "every save is restored");
  assert.equal(r.state().shadowBlur, 0, "no glow left on");
  assert.equal(r.state().globalAlpha, 1, "alpha back to 1");
  return r.draws;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("focusLook: dim at 30 %, glow pulses between 0.75 and 1, dim wins", () => {
  const f = { glow: ["part", "tip"], dim: ["depth", "tip"] };
  assert.deepEqual(focusLook(null, "part", 0), { alpha: 1, glow: false });
  assert.deepEqual(focusLook(f, "level", 0), { alpha: 1, glow: false });
  assert.deepEqual(focusLook(f, "depth", 0), { alpha: DIM_ALPHA, glow: false });
  assert.deepEqual(focusLook(f, "tip", 0), { alpha: DIM_ALPHA, glow: false });
  for (let t = 0; t < 2; t += 0.05) {
    const k = focusLook(f, "part", t);
    assert.equal(k.glow, true);
    assert.ok(k.alpha >= 0.75 - 1e-9 && k.alpha <= 1 + 1e-9, `t ${t}: ${k.alpha}`);
  }
  assert.ok(near(focusLook(f, "part", 1 / 3.2).alpha, 1), "the top of the pulse");
});

test("screwNumber: the digits of the label", () => {
  assert.equal(screwNumber("S2"), "2");
  assert.equal(screwNumber("S12"), "12");
  assert.equal(screwNumber("X"), "X");
});

test("drawSimple, sheet phase: the sheet's outline in grey-white at 50 %, glowing while the sheet is not seen well", () => {
  const plain = drawP(pilotOv({}), { drawText: false });
  const outline = plain.filter((d) => d.op === "stroke" && d.color === COL.rest && near(d.alpha, 0.5));
  assert.equal(outline.length, 1, "one outline");
  assert.equal(outline[0].blur, 0);
  const markers = plain.filter((d) => d.op === "stroke" && d.color === COL.rest && near(d.alpha, 0.25));
  assert.equal(markers.length, OV.quads.length, "the markers at 25 %");
  const lit = drawP(pilotOv({}), { focus: focus(PS) });
  assert.ok(lit.some((d) => d.op === "stroke" && d.color === COL.rest && d.blur > 0 && d.alpha >= 0.5 * 0.75 - 1e-9), "the outline glows");
  assert.ok(!lit.some((d) => d.op === "stroke" && d.color === COL.rest && near(d.alpha, 0.25) && d.blur > 0), "the markers never glow");
  // no screw yet: no target, so no arrow, no level, no depth bar and no mark
  assert.ok(!plain.some((d) => d.color === COL.next), "nothing amber without a screw");
  // lost: nothing of the pilot
  const lost = drawP(pilotOv({}), {}, {}, { lost: true });
  assert.ok(!lost.some((d) => d.op === "stroke" && d.color === COL.rest && near(d.alpha, 0.5)));
});

test("drawSimple, the table: in the sheet phase mapped sheets green, one being mapped amber with its ring, moved amber", () => {
  const sheets: PilotOverlay["sheetsPx"] = [
    { k: 0, px: SHEET_PX, state: "mapped", progress: 1 },
    { k: 1, px: sq(620, 100, 500), state: "seen", progress: 0.5 },
    { k: 2, px: sq(100, 620, 500), state: "moved", progress: 0 },
  ];
  const d = drawP(pilotOv({ sheetsPx: sheets }), { drawText: false, phase: "sheet" });
  assert.equal(d.filter((x) => x.op === "stroke" && x.color === COL.ok).length, 1, "sheet 0 green");
  // sheet 1: its amber edge and the ring's progress arc, over the ring's grey track; sheet 2: its amber (dashed) edge
  assert.equal(d.filter((x) => x.op === "stroke" && x.color === COL.next).length, 3);
  assert.equal(d.filter((x) => x.op === "stroke" && x.color === COL.rest && near(x.alpha, 0.25)).length, OV.quads.length + 1, "the markers and the ring's track");
  // the ring with no progress yet: its arc is not drawn
  const empty = drawP(pilotOv({ sheetsPx: [{ ...sheets[1], progress: 0 }] }), { drawText: false, phase: "sheet" });
  assert.equal(empty.filter((x) => x.op === "stroke" && x.color === COL.next).length, 1);
  // after the sheet phase a mapped sheet is grey-white again; a moved one stays amber
  const work = drawP(pilotOv({ sheetsPx: [sheets[0], sheets[2]] }), { drawText: false, phase: "work" });
  assert.equal(work.filter((x) => x.op === "stroke" && x.color === COL.ok).length, 0);
  assert.equal(work.filter((x) => x.op === "stroke" && x.color === COL.rest && near(x.alpha, 0.5)).length, 1);
  assert.equal(work.filter((x) => x.op === "stroke" && x.color === COL.next).length, 1);
  // the outlines glow under the focus
  const lit = drawP(pilotOv({ sheetsPx: sheets }), { drawText: false, phase: "sheet", focus: focus(PS) });
  assert.ok(lit.some((x) => x.op === "stroke" && x.color === COL.ok && x.blur > 0));
});

test("drawSimple, part phase: green corner squares and the capture ring; then the block as a cyan ghost", () => {
  const corners = [{ p: PART_PX[0], state: "done" as const }, { p: PART_PX[1], state: "done" as const }];
  const st = { ...PS, phase: "part" as const, sheetOk: true, corners: 2, capture: { progress: 0.5, why: null } };
  const d = drawP(pilotOv({ cornersPx: corners }), { focus: focus(st), capture: { progress: 0.5 } });
  const squares = d.filter((x) => x.op === "fillRect" && x.color === COL.ok);
  assert.equal(squares.length, 2, "one square per corner");
  assert.ok(squares.every((x) => x.blur > 0), "the corners glow while capturing");
  assert.ok(d.some((x) => x.op === "stroke" && x.color === COL.next && x.blur > 0), "the capture ring, amber and glowing");
  assert.ok(d.some((x) => x.op === "stroke" && x.color === COL.tool && x.blur > 0), "the tip glows");
  const none = drawP(pilotOv({ cornersPx: corners }), { capture: null, drawText: false });
  assert.ok(!none.some((x) => x.color === COL.next), "no capture: no ring");

  // fitted: the top face filled at 16 %, its edges bright, the bottom and the verticals at 40 %
  const fitted = drawP(pilotOv({ partPx: PART_PX, bottomPx: BOTTOM_PX, cornersPx: PART_PX.map((p) => ({ p, state: "done" as const })) }));
  assert.ok(fitted.some((x) => x.op === "fill" && x.color === COL.tool && near(x.alpha, 0.16)), "the ghost's fill");
  assert.ok(fitted.some((x) => x.op === "stroke" && x.color === COL.tool && near(x.alpha, 1)), "its edges");
  assert.equal(fitted.filter((x) => x.op === "stroke" && x.color === COL.tool && near(x.alpha, 0.4)).length, 2, "bottom and verticals");
  // dimmed: the whole ghost at 30 %
  const dim = drawP(pilotOv({ partPx: PART_PX, bottomPx: BOTTOM_PX }), { focus: { glow: [], dim: ["part"] } });
  assert.ok(dim.some((x) => x.op === "fill" && x.color === COL.tool && near(x.alpha, 0.16 * DIM_ALPHA)));
  assert.ok(!dim.some((x) => x.color === COL.tool && near(x.alpha, 0.16)));
});

test("drawSimple: clipped polygons (3 to 6 points, faces of different sizes) draw, the verticals from edgesPx", () => {
  // a sheet with a corner behind the camera comes as a pentagon; the block's faces clipped differently
  const pent = [{ x: 100, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 400 }, { x: 400, y: 600 }, { x: 100, y: 600 }];
  const top6 = [{ x: 700, y: 300 }, { x: 900, y: 300 }, { x: 900, y: 420 }, { x: 860, y: 500 }, { x: 760, y: 500 }, { x: 700, y: 450 }];
  const bot3 = [{ x: 690, y: 320 }, { x: 890, y: 320 }, { x: 690, y: 520 }];
  const edges: NonNullable<PilotOverlay["edgesPx"]> = [[bot3[0], top6[0]], [bot3[1], top6[1]]];
  const r = recCtx();
  const segs: number[] = [];
  let n = 0;
  (r.ctx as unknown as Record<string, unknown>).moveTo = () => void segs.push((n = 1));
  (r.ctx as unknown as Record<string, unknown>).lineTo = () => void (segs[segs.length - 1] = ++n);
  drawSimple(r.ctx, S, 400, 850, { video, overlay: { ...OV, pilot: pilotOv({ sheetsPx: [{ k: 0, px: pent, state: "mapped", progress: 1 }], partPx: top6, bottomPx: bot3, edgesPx: edges }) }, toolCalibrated: true, showVideo: false, rightInset: 88, phase: "sheet", drawText: false });
  assert.equal(r.depth(), 0);
  assert.ok(segs.includes(5) && segs.includes(6) && segs.includes(3), `every point of each polygon is drawn: ${segs.join(",")}`);
  assert.equal(r.draws.filter((x) => x.op === "stroke" && x.color === COL.ok).length, 1, "the pentagon sheet, green");
  assert.ok(r.draws.some((x) => x.op === "fill" && x.color === COL.tool && near(x.alpha, 0.16)), "the clipped top face's fill");
  assert.equal(r.draws.filter((x) => x.op === "stroke" && x.color === COL.tool && near(x.alpha, 0.4)).length, 2, "the bottom and the verticals");
  // faces of different sizes without edgesPx: the bottom is drawn, no verticals (its points do not pair up)
  const d = drawP(pilotOv({ partPx: top6, bottomPx: bot3 }));
  assert.equal(d.filter((x) => x.op === "stroke" && x.color === COL.tool && near(x.alpha, 0.4)).length, 1);
});

test("drawSimple, work phase: done screws green, the others numbered, the active one amber with its tunnel", () => {
  const screws: PilotOverlay["screwsPx"] = [
    { p: { x: 720, y: 320 }, label: "S1", state: "done" },
    { p: PART_PX[1], label: "S2", state: "active" },
    { p: { x: 880, y: 480 }, label: "S3", state: "todo" },
    { p: { x: 720, y: 480 }, label: "S4", state: "todo" },
  ];
  const pilot = pilotOv({ partPx: PART_PX, bottomPx: BOTTOM_PX, screwsPx: screws });
  const st = { ...PS, phase: "work" as const, sheetOk: true, corners: 4, done: 1 };
  const d = drawP(pilot, { focus: focus(st), drawText: false });
  const texts = d.filter((x) => x.op === "fillText").map((x) => x.text);
  assert.deepEqual(texts, ["3", "4"], "only the todo screws' numbers: no top text");
  assert.ok(d.filter((x) => x.op === "fillText").every((x) => x.color === COL.rest));
  assert.ok(d.some((x) => x.op === "fill" && x.color === COL.ok), "the done disc");
  const amber = d.filter((x) => x.op === "stroke" && x.color === COL.next);
  assert.ok(amber.length >= 5, "three tunnel rings, the ring, the arrow");
  assert.ok(amber.some((x) => x.blur > 0), "the active ring glows");
  // the tunnel closes in: its outer ring is smaller near the surface
  const outer = (gapMm: number) => {
    const arcs: number[] = [];
    const r = recCtx();
    (r.ctx as unknown as Record<string, unknown>).arc = (x: number, y: number, rad: number) => { if (x !== 0 || y !== 0) arcs.push(rad); };
    drawSimple(r.ctx, { ...S, gapMm, offsetMm: 30 }, 400, 850, { video, overlay: { ...OV, pilot }, toolCalibrated: true, showVideo: false, drawText: false });
    return Math.max(...arcs.filter((a) => a < 4 * 11));
  };
  assert.ok(outer(5) < outer(50), "rings close in as the tip comes down");
  // near the screw: the level and the depth glow, the screws are as they are
  const lit = drawP(pilot, { focus: focus({ ...st, nearScrew: true }) }, { offsetMm: 0.5, gapMm: 3 });
  assert.ok(lit.some((x) => x.op === "stroke" && (x.color === COL.next || x.color === COL.ok) && x.blur > 0 && x.alpha < 1), "level / depth glow");
});

test("drawSimple: level and depth by state: amber guiding, green when square, red only for the stop alarm", () => {
  const lvl = (s: Partial<SimState>, ov: Partial<Overlay> = {}) => {
    const r = recCtx();
    drawSimple(r.ctx, { ...S, ...s }, 400, 850, { video, overlay: { ...OV, ...ov }, toolCalibrated: true, showVideo: false, readout: false });
    return r.draws;
  };
  const guiding = lvl({ offsetMm: 0.5, gapMm: 0, angleErrDeg: 2 });
  assert.ok(guiding.some((x) => x.color === COL.next) && !guiding.some((x) => x.color === COL.stop));
  const square = lvl({ offsetMm: 0.5, gapMm: 0, angleErrDeg: 0.2 });
  assert.ok(square.some((x) => x.op === "fill" && x.color === COL.ok), "the level's dot, green");
  const atDepth = lvl({ phase: "drill", depthMm: 14, angleErrDeg: 0.2 });
  assert.ok(atDepth.some((x) => x.op === "fillRect" && x.color === COL.ok), "the depth bar, green at depth");
  const drilling = lvl({ phase: "drill", depthMm: 5, angleErrDeg: 2 });
  assert.ok(!drilling.some((x) => x.color === COL.stop), "tilted while drilling is amber, not red");
  assert.ok(drilling.some((x) => x.op === "fillRect" && x.color === COL.next));
});

test("drawSimple: depthX moves the depth bar", () => {
  const xs = (depthX?: number) => {
    const out: number[] = [];
    const r = recCtx();
    (r.ctx as unknown as Record<string, unknown>).fillRect = (x: number) => out.push(x);
    drawSimple(r.ctx, { ...S, phase: "drill", depthMm: 5, angleErrDeg: 0.2 }, 400, 850, { video, overlay: OV, toolCalibrated: true, showVideo: false, readout: false, depthX });
    return out;
  };
  const u = 4, bw = u * 2.4;
  assert.ok(xs().some((x) => near(x, u * 6 - bw / 2)), "default: 6 % of the short side");
  assert.ok(xs(100).some((x) => near(x, 100 - bw / 2)));
  assert.ok(!xs(100).some((x) => near(x, u * 6 - bw / 2)));
});

test("drawSimple: STOP blinks the frame with or without the text; the big icon only with the text", () => {
  const perf = globalThis.performance;
  const orig = perf.now;
  Object.defineProperty(perf, "now", { value: () => 0, configurable: true, writable: true });
  try {
    for (const drawText of [true, false]) {
      const arcs: number[] = [];
      const r = recCtx();
      (r.ctx as unknown as Record<string, unknown>).arc = (_x: number, _y: number, rad: number) => arcs.push(rad);
      drawSimple(r.ctx, S, 400, 850, { video, overlay: { ...OV, alarms: 16 }, toolCalibrated: true, showVideo: false, drawText, rightInset: 88 });
      assert.ok(r.draws.some((x) => x.op === "stroke" && x.color === COL.stop), `drawText ${drawText}: the red frame`);
      // the stop icon: a circle of 0.8 × 11u
      assert.equal(arcs.some((a) => near(a, 0.8 * 11 * 4)), drawText, `drawText ${drawText}: the icon`);
    }
    const r = recCtx();
    drawSimple(r.ctx, S, 400, 850, { video, overlay: OV, toolCalibrated: true, showVideo: false, drawText: false });
    assert.ok(!r.draws.some((x) => x.op === "fillText"), "no text at all without drawText");
  } finally {
    Object.defineProperty(perf, "now", { value: orig, configurable: true, writable: true });
  }
});

test("readUiPrefs: simple and no video by default; anything unknown is the default; the old colour is ignored", () => {
  const from = (o: Record<string, string>) => readUiPrefs((k) => o[k] ?? null);
  assert.deepEqual(from({}), { ui: "simple", video: false });
  assert.deepEqual(from({ "st-ui": "classic" }), { ui: "classic", video: false });
  assert.deepEqual(from({ "st-ui": "simple", "st-ui-video": "1", "st-ui-color": "amber" }), { ui: "simple", video: true });
  assert.deepEqual(from({ "st-ui": "fancy", "st-ui-video": "yes" }), { ui: "simple", video: false });
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

// ---------- the pilot's controls on the screen ----------

const pstate = (o: Partial<PilotState> = {}): PilotState => ({
  phase: "sheet",
  sheetOk: false,
  sheets: SHEET0_ONLY.map((x) => ({ ...x })),
  markers: 0,
  corners: 0,
  capture: null,
  fit: null,
  done: 0,
  total: 4,
  nearScrew: false,
  drilling: false,
  ready: false,
  stop: false,
  toolCalibrated: true,
  ...o,
});
const FIT_OK = { corners: [], origin: [0, 0], angleDeg: 0, topMm: 18, sideMm: 100, freMm: 0.4, ok: true, why: null } as unknown as PartFit;
const FIT_BAD = { ...FIT_OK, ok: false, why: "size" } as PartFit;

test("controlLook: glow, dim at 30 %, Stop and Pause never under 0.5, nothing without a focus", () => {
  assert.deepEqual(controlLook(null, "more"), { glow: false, opacity: 1 });
  const f = { glow: ["more"], dim: ["video", "stop", "pause"] };
  assert.deepEqual(controlLook(f, "more"), { glow: true, opacity: 1 });
  assert.deepEqual(controlLook(f, "video"), { glow: false, opacity: DIM_ALPHA });
  assert.equal(controlLook(f, "stop").opacity, STAY_FINDABLE);
  assert.equal(controlLook(f, "pause").opacity, STAY_FINDABLE);
  assert.deepEqual(controlLook(f, "sound"), { glow: false, opacity: 1 });
  // dim wins over glow, as on the canvas
  assert.deepEqual(controlLook({ glow: ["video"], dim: ["video"] }, "video"), { glow: false, opacity: DIM_ALPHA });
  // the stop alarm: Stop glows at full strength, every other control is dimmed but Pause stays findable
  const alarm = focus(pstate({ phase: "work", fit: FIT_OK, stop: true }));
  assert.deepEqual(controlLook(alarm, "stop"), { glow: true, opacity: 1 });
  assert.equal(controlLook(alarm, "pause").opacity, STAY_FINDABLE);
  assert.equal(controlLook(alarm, "phase-sheet").opacity, DIM_ALPHA);
});

test("phaseButtons: current, enabled from canEnter, ticks, and a hold when corners would be thrown away", () => {
  const at = (s: PilotState) => Object.fromEntries(phaseButtons(s).map((b) => [b.phase, b]));
  let b = at(pstate());
  assert.deepEqual(phaseButtons(pstate()).map((x) => x.phase), ["sheet", "part", "work"]);
  assert.ok(b.sheet.current && b.sheet.enabled && !b.sheet.completed);
  assert.ok(!b.part.enabled && !b.work.enabled);
  b = at(pstate({ sheetOk: true }));
  assert.ok(b.part.enabled && !b.sheet.completed, "seen well, but still in the sheet phase: no tick yet");
  b = at(pstate({ phase: "part", sheetOk: true }));
  assert.ok(b.sheet.completed && b.part.current && !b.part.hold, "no corner yet: a tap is enough");
  b = at(pstate({ phase: "part", sheetOk: true, corners: 2 }));
  assert.ok(b.part.hold && !b.part.completed && !b.work.enabled);
  b = at(pstate({ phase: "part", sheetOk: true, corners: 4, fit: FIT_BAD }));
  assert.ok(b.part.hold && !b.part.completed && !b.work.enabled);
  b = at(pstate({ phase: "part", sheetOk: true, corners: 4, fit: FIT_OK }));
  assert.ok(b.part.completed && b.work.enabled && b.part.hold);
  b = at(pstate({ phase: "work", sheetOk: true, corners: 4, fit: FIT_OK, done: 3 }));
  assert.ok(b.work.current && !b.work.completed && b.part.hold, "going back to the part from work also needs the hold");
  b = at(pstate({ phase: "work", sheetOk: true, corners: 4, fit: FIT_OK, done: 4 }));
  assert.ok(b.work.completed && b.part.completed && b.sheet.completed);
});

test("textKey: a new kind fades, a new value does not", () => {
  assert.equal(textKey({ icon: "arrow", unit: "mm" }), textKey({ icon: "arrow", unit: "mm" }));
  assert.notEqual(textKey({ icon: "arrow", unit: "mm" }), textKey({ icon: "down", unit: "mm" }));
  assert.notEqual(textKey({ icon: "corner", unit: "" }), textKey({ icon: "corner", unit: "mm" }));
  const a: PilotText = { icon: "sheet", value: "5", unit: "", tone: "next" };
  const b: PilotText = { ...a, value: "9", tone: "ok" };
  assert.equal(textKey(a), textKey(b));
});

test("captureHint: words for what a corner capture misses", () => {
  for (const w of ["low", "moving", "near-taken", "pivot"] as const) assert.ok(captureHint(w).length > 10, w);
  assert.equal(captureHint(null), "");
  assert.equal(captureHint(undefined), "");
});

test("pilotRuns: simple only; on the phone without an active plan; in the simulator with &pilot=1", () => {
  assert.equal(pilotRuns({ ui: "simple", sim: false, pilotParam: false, activePlan: null }), true);
  assert.equal(pilotRuns({ ui: "simple", sim: false, pilotParam: false, activePlan: "plan-1" }), false);
  assert.equal(pilotRuns({ ui: "classic", sim: false, pilotParam: false, activePlan: null }), false);
  assert.equal(pilotRuns({ ui: "simple", sim: true, pilotParam: false, activePlan: null }), false);
  assert.equal(pilotRuns({ ui: "simple", sim: true, pilotParam: true, activePlan: null }), true);
  assert.equal(pilotRuns({ ui: "classic", sim: true, pilotParam: true, activePlan: null }), false);
});
