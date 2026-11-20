// 3D-assembly scenarios: a robot-arm base screwed together with the drill/driver. The part is located
// by touching it with the bit tip (the engine registers it), verified on points it never saw, then
// screws go into the top and a 35° chamfer; a bracket is placed, probed, registered and screwed down.
// Everything runs on the real engine: registration uses the tip positions the engine measured.

import { REMOTE_HOLE, BASE_BODY, BASE_NOMINAL, BASE_ON_BENCH, BRACKET_MOUNT, BRACKET_POINTS, CHECKPOINTS, FIDUCIALS, SCREWS, SCREW_DEPTHS, assemblyScene, baseSolids, bracketSolids, probeError } from "../assembly.ts";
import { guidance } from "../guidance.ts";
import { buildReport, grade, reportHtml } from "../report.ts";
import { ScrewRecorder } from "../coach.ts";
import { ScenarioRun } from "./runner.ts";
import type { SceneDef } from "../scenedef.ts";
import { DEFAULT_RIG } from "../scene.ts";
import { applyDir, applyPoint, compose, inverse, qaxis, xf, xlerp, type Xf } from "../xform.ts";
import type { V3 } from "../pose.ts";
import type { Ctx, EngineHooks, PanelLine, PanelModel, Scenario, Segment } from "./scenarios.ts";
import { Timeline } from "./timeline.ts";

const rig = DEFAULT_RIG;
const seg: Segment = { from: 0, rig, label: "dock v0.4" };
const SCENE = () => assemblyScene({ tool: rig.tool });
const REAL = assemblyScene({ tool: rig.tool, basePose: BASE_ON_BENCH });
const PHONE_HIDDEN = ["camera", "dock", "dock-lower", "dock-arm", "dock-jaw", "tool"];
const GHOST = ["base", "bracket", BASE_BODY.name];
const VIEW = { pos: [0.6, -0.5, 0.42] as V3, target: [0.16, -0.01, 0.04] as V3, up: [0, 0, 1] as V3 };
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");

/** where things truly are */
const worldOfBase = (p: V3) => applyPoint(BASE_ON_BENCH, p);
const holeTruth = (name: string, bracketLocal: Xf = BRACKET_MOUNT) => {
  const s = SCREWS.find((x) => x.name === name)!;
  return s.part === "base" ? compose(BASE_ON_BENCH, s.frame) : compose(compose(BASE_ON_BENCH, bracketLocal), s.frame);
};
const CHAMFER_AXIS = applyDir(holeTruth("C1"), [0, 0, 1]);
/** a bracket placed 2.1 mm and 1.5° off its designed mount */
const BRACKET_OFF = compose(BRACKET_MOUNT, xf([0.0021, -0.0008, 0], qaxis([0, 0, 1], (1.5 * Math.PI) / 180)));

interface Store {
  done: Set<string>;
  touches: Record<string, V3>;
  reg?: { world: Xf; freMm: number; at: number; applied: boolean };
  verify: Record<string, number>;
  bracketReal: Xf | null;
  bracketReg?: { local: Xf; freMm: number; at: number; applied: boolean };
  bracketCheck?: number;
  seated: Record<string, { angle: number; depth: number }>;
  maxAngle: Record<string, number>;
  /** screws during which the part moved under the tool */
  flagged: Record<string, boolean>;
}
const store = (ctx: Ctx): Store => {
  const s = ctx.store as unknown as Partial<Store>;
  s.done ??= new Set();
  s.touches ??= {};
  s.verify ??= {};
  s.seated ??= {};
  s.maxAngle ??= {};
  s.flagged ??= {};
  if (s.bracketReal === undefined) s.bracketReal = null;
  return s as Store;
};

const tipOf = (ctx: Ctx, h: EngineHooks): V3 | null => ctx.snap?.nodes.find((n) => n.id === h.ids.tool)?.world.p ?? null;
const worldOf = (ctx: Ctx, h: EngineHooks, name: string): Xf | null => ctx.snap?.nodes.find((n) => n.id === h.ids[name])?.world ?? null;

/** Engine-side actions shared by the assembly scenarios. */
function makeOnStep(tl: Timeline, extra?: (id: string, ctx: Ctx, h: EngineHooks, st: Store) => void) {
  return (ctx: Ctx, h: EngineHooks) => {
    const st = store(ctx);
    for (const a of tl.actions) {
      if (a.at > ctx.t || st.done.has(`${a.id}@${a.at}`)) continue;
      st.done.add(`${a.id}@${a.at}`);
      const tip = tipOf(ctx, h);
      if (a.id.startsWith("touch:") && tip) st.touches[a.id.slice(6)] = tip;
      if (a.id === "register-base") {
        const r = h.core.registerPoints(FIDUCIALS.map((f) => f.p), FIDUCIALS.map((f) => st.touches[f.name]));
        if (r) st.reg = { world: r.transform, freMm: r.freMm, at: ctx.t, applied: false };
      }
      if (a.id === "verify") {
        const base = worldOf(ctx, h, "base");
        for (const k of CHECKPOINTS) if (base && st.touches[k.name]) st.verify[k.name] = probeError(base, k.p, st.touches[k.name]);
      }
      if (a.id === "register-bracket") {
        const base = worldOf(ctx, h, "base");
        const r = h.core.registerPoints(BRACKET_POINTS.map((b) => b.p), BRACKET_POINTS.map((b) => st.touches[b.name]));
        if (r && base) st.bracketReg = { local: compose(inverse(base), r.transform), freMm: r.freMm, at: ctx.t, applied: false };
      }
      extra?.(a.id, ctx, h, st);
    }
    // the CAD model snaps onto the part over 0.8 s, then the part counts as located
    if (st.reg && !st.reg.applied) {
      const k = Math.min(1, (ctx.t - st.reg.at) / 0.8);
      const e = k * k * (3 - 2 * k);
      h.engine.setLocal(h.ids.base, xlerp(BASE_NOMINAL, st.reg.world, e));
      if (k >= 1) {
        h.engine.setCalibrated(h.ids.base, true);
        st.reg.applied = true;
      }
    }
    if (st.bracketReg && !st.bracketReg.applied) {
      const k = Math.min(1, (ctx.t - st.bracketReg.at) / 0.6);
      h.engine.setLocal(h.ids.bracket, xlerp(BRACKET_MOUNT, st.bracketReg.local, k * k * (3 - 2 * k)));
      if (k >= 1) {
        h.engine.setCalibrated(h.ids.bracket, true);
        st.bracketReg.applied = true;
      }
    }
    // screw records from the engine's events
    const s = ctx.snap;
    if (s && s.active >= 0) {
      const a = s.targets[s.active];
      const name = ctx.names[a.id];
      // the angle while the screw is actually going in (past the first 2 mm)
      if ((s.phase === "drill" || s.phase === "hold") && a.depthMm > 2) st.maxAngle[name] = Math.max(st.maxAngle[name] ?? 0, a.angleErrDeg);
      if (s.alarms & 8) st.flagged[name] = true;
    }
    for (const e of ctx.events) {
      const name = ctx.names[e.node];
      if (e.kind === "depth-reached" && name && !st.seated[name]) st.seated[name] = { angle: st.maxAngle[name] ?? 0, depth: e.value };
    }
  };
}

/** Start a scenario with the base already located (as at the end of the registration scenario). */
function preRegistered(ctx: Ctx, h: EngineHooks) {
  const st = store(ctx);
  if (st.done.has("pre")) return;
  st.done.add("pre");
  h.engine.setLocal(h.ids.base, compose(BASE_ON_BENCH, xf([0.00006, -0.00004, 0])));
  h.engine.setCalibrated(h.ids.base, true);
  st.reg = { world: BASE_ON_BENCH, freMm: 0.05, at: 0, applied: true };
}

const hiddenScrews = (ctx: Ctx) => {
  const st = store(ctx);
  return SCREWS.filter((s) => !st.seated[s.name]).map((s) => `${s.name}-screw`);
};

function panelFor(ctx: Ctx, extra: PanelLine[] = []): PanelLine[] {
  const st = store(ctx);
  const s = ctx.snap;
  const a = s && s.active >= 0 ? s.targets[s.active] : null;
  const name = a ? ctx.names[a.id] : "";
  const spec = SCREWS.find((x) => x.name === name) ?? (name === REMOTE_HOLE.name ? REMOTE_HOLE : undefined);
  const seated = Object.keys(st.seated).length;
  const lines: PanelLine[] = [
    { label: "part located", value: st.reg?.applied ? `yes · FRE ${fmt(st.reg.freMm)} mm (4 touches)` : st.reg ? "snapping…" : "not yet: touch F1-F4", state: st.reg?.applied ? "ok" : "warn" },
    ...Object.entries(st.verify).map(([k, v]) => ({ label: `check ${k}`, value: `${fmt(v)} mm`, state: (v < 1 ? "ok" : "bad") as PanelLine["state"] })),
    ...extra,
    { label: "screws seated", value: `${seated} / ${SCREWS.length}`, state: seated ? "ok" : "idle" },
    ...guidanceLines(ctx),
  ];
  if (a && spec && s) {
    lines.push(
      { label: "current", value: `${name} · ${spec.size} · ${spec.face} · ${spec.depthMm} mm` },
      { label: "angle to its axis", value: `${fmt(a.angleErrDeg)}°`, state: a.angleErrDeg < 0.4 ? "ok" : "warn" },
      { label: a.depthMm > 0 ? "driven" : "offset", value: a.depthMm > 0 ? `${fmt(a.depthMm, 1)} / ${spec.depthMm} mm` : `${fmt(a.offsetMm)} mm`, state: a.depthMm > 0 || a.offsetMm < 0.75 ? "ok" : "warn" },
      { label: "gate", value: s.ready ? "READY" : s.phase === "drill" || s.phase === "hold" ? "driving" : s.gate & 128 ? "locate the part first" : s.locking ? "locking" : "aligning", state: s.ready ? "ok" : s.gate & 128 ? "warn" : "idle" },
    );
  }
  return lines;
}

function recordsFor(ctx: Ctx) {
  const st = store(ctx);
  const rows = Object.entries(st.seated).map(([n, r]) => {
    const spec = SCREWS.find((x) => x.name === n) ?? REMOTE_HOLE;
    return [n, spec.face, spec.size, `${fmt(r.depth, 1)} mm`, st.flagged[n] ? "⚠ part moved: redo" : `${fmt(r.angle)}°`];
  });
  return { cols: ["screw", "face", "size", "seated", "max angle"], rows };
}

function base(id: string, tl: Timeline, o: Partial<Scenario>): Scenario {
  return {
    id,
    title: "",
    kicker: "",
    summary: "",
    duration: tl.duration,
    view2d: "phone",
    segments: [seg],
    scene: SCENE,
    depths: SCREW_DEPTHS,
    action: "drive",
    ghost: GHOST,
    phoneHidden: PHONE_HIDDEN,
    view3d: VIEW,
    chapters: tl.chapters.map((c) => ({ from: c.from, label: c.label })),
    headline: (ctx) => tl.chapterAt(ctx.t)?.headline ?? "",
    tool: (ctx) => ({ toolW: tl.toolAt(ctx.t) }),
    hidden: hiddenScrews,
    real: {
      def: REAL,
      nodes: ["base", "bracket"],
      pose: (ctx) => ({ bracket: store(ctx).bracketReal }),
    },
    panel: (ctx) => ({ caption: tl.chapterAt(ctx.t)?.headline ?? "", lines: panelFor(ctx), records: recordsFor(ctx), downloads: downloadsFor(ctx) }),
    guidance: solidsFor,
    quality: (ctx, name) => {
      const st = store(ctx);
      const r = st.seated[name];
      const spec = SCREWS.find((x) => x.name === name) ?? (name === REMOTE_HOLE.name ? REMOTE_HOLE : null);
      return r && spec ? grade({ name, face: spec.face, size: spec.size, plannedMm: spec.depthMm, seatedMm: r.depth, maxAngleDeg: r.angle, flagged: st.flagged[name] ? "part moved" : undefined }) : undefined;
    },
    ...o,
  };
}

/** The job report from what the engine recorded (downloads in the panel). */
function reportOf(ctx: Ctx, planned = SCREWS.length) {
  const st = store(ctx);
  const recs = Object.entries(st.seated).map(([n, r]) => {
    const spec = SCREWS.find((x) => x.name === n) ?? REMOTE_HOLE;
    return { name: n, face: spec.face, size: spec.size, plannedMm: spec.depthMm, seatedMm: r.depth, maxAngleDeg: r.angle, flagged: st.flagged[n] ? "part moved" : undefined };
  });
  return buildReport("Robot-arm base assembly", recs, planned);
}
const downloadsFor = (ctx: Ctx, planned?: number) =>
  Object.keys(store(ctx).seated).length
    ? [
        { label: "report (HTML)", filename: "smarttools-report.html", type: "text/html", content: () => reportHtml(reportOf(ctx, planned)) },
        { label: "JSON", filename: "smarttools-report.json", type: "application/json", content: () => JSON.stringify(reportOf(ctx, planned), null, 2) },
      ]
    : undefined;

/** The parts as solids where the engine has them (the bracket once it is on the tower). */
function solidsFor(ctx: Ctx, worldOf: (name: string) => Xf | null) {
  const b = worldOf("base");
  const br = worldOf("bracket");
  return [...(b ? baseSolids(b) : []), ...(br && store(ctx).bracketReal ? bracketSolids(br) : [])];
}

/** Guidance lines for the panel: what is next, the order, the x-ray reading. */
function guidanceLines(ctx: Ctx): PanelLine[] {
  const s = ctx.snap;
  if (!s) return [];
  const ids: Record<string, number> = {};
  for (const [id, n] of Object.entries(ctx.names)) ids[n] = Number(id);
  const worldOf = (n: string) => s.nodes.find((x) => x.id === ids[n])?.world ?? null;
  const st = store(ctx);
  // a part counts as located once the engine has it calibrated (registration or its own markers)
  const partOk = (part: string) => s.nodes.find((x) => x.id === ids[part])?.status !== "uncalibrated" && (part !== "bracket" || !!st.bracketReg?.applied);
  const located = (n: string) => partOk(SCREWS.find((x) => x.name === n)!.part);
  const skipped = (ctx.store as { skipped?: string[] }).skipped;
  const g = guidance({ snap: s, order: SCREWS.map((x) => x.name), ids, depths: SCREW_DEPTHS, solids: solidsFor(ctx, worldOf), located, skipped });
  const out: PanelLine[] = [];
  if (g.outOfOrder) out.push({ label: "order", value: `${g.outOfOrder.active} before ${g.outOfOrder.expected}: out of order`, state: "warn" });
  if (g.xray && Number.isFinite(g.xray.materialMm)) out.push({ label: "x-ray", value: g.xray.breakthrough ? `${fmt(g.xray.materialMm, 0)} mm of material: it breaks through!` : `${fmt(g.xray.leftMm, 0)} mm of material left under the tip`, state: g.xray.breakthrough ? "bad" : "ok" });
  return out;
}

// ---------------- the hero: the whole job ----------------

function heroTimeline() {
  const tl = new Timeline();
  const f1 = worldOfBase(FIDUCIALS[0].p);
  tl.keys.push({ t: 0, tip: [f1[0] - 0.02, f1[1] - 0.03, 0.09], axis: [0, 0, -1] });
  tl.chapter("Locate", "Touch 4 points. The CAD model snaps onto the real part.");
  tl.hold(0.6);
  for (const f of FIDUCIALS) tl.touch(f.name, worldOfBase(f.p));
  tl.action("register-base").hold(1.2);
  tl.chapter("Verify", "Touch a point it never saw. Off by less than a tenth of a millimetre.");
  tl.touch("K1", worldOfBase(CHECKPOINTS[0].p), CHAMFER_AXIS).action("verify").hold(0.4);
  tl.chapter("Drive", "Every screw: right place, right angle, right depth. On any face.");
  for (const s of SCREWS.filter((x) => x.part === "base")) tl.screw(s.name, holeTruth(s.name), s.depthMm, 1.3);
  tl.chapter("Mount", "Place the bracket. Touch 3 points: now it is located too.");
  const top = applyPoint(compose(BASE_ON_BENCH, BRACKET_MOUNT), [0, 0, 0.06]);
  tl.action("place-bracket").to(top, [0, 0, -1], 0.9);
  for (const b of BRACKET_POINTS) tl.touch(b.name, applyPoint(compose(BASE_ON_BENCH, BRACKET_MOUNT), b.p), [0, 0, -1], 0.6);
  tl.action("register-bracket").hold(0.8);
  tl.chapter("Drive", "Four more, through the bracket into the tower.");
  for (const s of SCREWS.filter((x) => x.part === "bracket")) tl.screw(s.name, holeTruth(s.name), s.depthMm, 1.3);
  tl.chapter("Done", "10 screws, every one verified. No jig, no CNC: a phone and a 3D-printed dock.");
  tl.to(applyPoint(BASE_ON_BENCH, [0.08, -0.06, 0.12]), [0, 0.3, -1], 1.2).hold(2.6);
  return tl;
}
const HERO_TL = heroTimeline();

export const assemblyHero: Scenario = base("assembly-hero", HERO_TL, {
  kicker: "3D assembly",
  title: "Assemble a robot-arm base, screw by screw",
  summary: "Locate the part by touching it, verify, drive 10 screws on three faces, place and locate a bracket. The phone shows each step over what the camera sees.",
  onStep: makeOnStep(HERO_TL, (id, _ctx, _h, st) => {
    if (id === "place-bracket") st.bracketReal = BRACKET_MOUNT;
  }),
  // the bracket as a hologram where it goes, before it is placed
  hologram: (ctx) => {
    const mount = HERO_TL.chapters.find((c) => c.label === "Mount")!.from;
    return ctx.t >= mount - 3 && !store(ctx).bracketReal ? { node: "bracket", local: BRACKET_MOUNT, state: "ghost" } : null;
  },
});

// ---------------- gallery: locate & verify ----------------

function registerTimeline() {
  const tl = new Timeline();
  const f1 = worldOfBase(FIDUCIALS[0].p);
  tl.keys.push({ t: 0, tip: [f1[0] - 0.02, f1[1] - 0.03, 0.09], axis: [0, 0, -1] });
  tl.chapter("Locate", "Touch four dimples with the bit tip: the engine computes where the part is.");
  tl.hold(0.5);
  for (const f of FIDUCIALS) tl.touch(f.name, worldOfBase(f.p), [0, 0, -1], 1.0);
  tl.action("register-base").hold(1.4);
  tl.chapter("Verify", "Two points it never saw: on the 35° chamfer and on the tower.");
  tl.touch("K1", worldOfBase(CHECKPOINTS[0].p), CHAMFER_AXIS, 0.9);
  tl.touch("K2", worldOfBase(CHECKPOINTS[1].p), [0, 0, -1], 0.9).action("verify").hold(2);
  return tl;
}
const REG_TL = registerTimeline();
export const assemblyRegister: Scenario = base("assembly-register", REG_TL, {
  kicker: "3D assembly · locate",
  title: "Touch four points, and the CAD snaps onto the real part",
  summary: "The bit tip is a measuring probe. Four touches register the part (as in surgical navigation): its CAD model, with every hole, jumps onto the real part. Then it checks itself on points it never saw.",
  onStep: makeOnStep(REG_TL),
  panel: (ctx) => ({
    caption: REG_TL.chapterAt(ctx.t)?.headline ?? "",
    lines: panelFor(ctx).filter((l) => !["screws seated"].includes(l.label)),
    note: "Paired-point registration (Horn) in the Rust engine, on the tip positions the engine measured. In the end-to-end test with simulated images: FRE 0.04 mm, every hole within 0.10 mm.",
  }),
});

// ---------------- gallery: screws on every face ----------------

function facesTimeline() {
  const tl = new Timeline();
  const s1 = holeTruth("S1").p;
  tl.keys.push({ t: 0, tip: [s1[0], s1[1], s1[2] + 0.05], axis: [0, 0, -1] });
  tl.chapter("Top", "Four M5 screws on the top, in a cross pattern, 14 mm each.");
  for (const s of SCREWS.filter((x) => x.face === "top")) tl.screw(s.name, holeTruth(s.name), s.depthMm, 1.15);
  tl.chapter("Chamfer", "Two M4 screws into the 35° chamfer: same rings, its own axis, 10 mm.");
  for (const s of SCREWS.filter((x) => x.face !== "top" && x.part === "base")) tl.screw(s.name, holeTruth(s.name), s.depthMm, 1.15);
  tl.hold(1.5);
  return tl;
}
const FACES_TL = facesTimeline();
export const assemblyFaces: Scenario = base("assembly-faces", FACES_TL, {
  kicker: "3D assembly · drive",
  title: "Screws on every face, each at its own angle and depth",
  summary: "Every hole is its own frame on the part. The rings, the gate and the depth stop follow the hole's axis, whether it points down or into a 35° chamfer.",
  onStep: (ctx, h) => {
    preRegistered(ctx, h);
    makeOnStep(FACES_TL)(ctx, h);
  },
  panel: (ctx) => ({ caption: FACES_TL.chapterAt(ctx.t)?.headline ?? "", lines: panelFor(ctx), records: recordsFor(ctx) }),
});

// ---------------- gallery: verify a mount by probing ----------------

function verifyTimeline() {
  const tl = new Timeline();
  const top = applyPoint(compose(BASE_ON_BENCH, BRACKET_MOUNT), [0, 0, 0.06]);
  tl.keys.push({ t: 0, tip: top, axis: [0, 0, -1] });
  tl.chapter("Place", "The bracket goes on the tower. Is it where the CAD says?");
  tl.action("place-off").hold(0.8);
  tl.touch("P1", applyPoint(compose(BASE_ON_BENCH, BRACKET_OFF), BRACKET_POINTS[0].p), [0, 0, -1], 0.9).action("check-bracket");
  tl.chapter("Catch", "2 mm off: caught before a single screw goes in. Re-seat it.");
  tl.to(top, [0, 0, -1], 0.6).action("remount").hold(1.4);
  tl.chapter("Locate", "Probe three points: the bracket is located, its holes with it.");
  for (const b of BRACKET_POINTS) tl.touch(b.name, applyPoint(compose(BASE_ON_BENCH, BRACKET_MOUNT), b.p), [0, 0, -1], 0.6);
  tl.action("register-bracket").hold(0.8);
  tl.chapter("Drive", "Then the screws, through the bracket into the tower.");
  for (const s of SCREWS.filter((x) => x.part === "bracket").slice(0, 2)) tl.screw(s.name, holeTruth(s.name), s.depthMm, 1.2);
  tl.hold(1.2);
  return tl;
}
const VERIFY_TL = verifyTimeline();
export const assemblyVerify: Scenario = base("assembly-verify", VERIFY_TL, {
  kicker: "3D assembly · verify",
  title: "A part placed 2 mm off is caught before the first screw",
  summary: "Probing a mounted part with the tip compares it with the CAD. A bracket 2 mm and 1.5° off is flagged; once re-seated, three touches locate it and the screws follow.",
  onStep: (ctx, h) => {
    preRegistered(ctx, h);
    makeOnStep(VERIFY_TL, (id, c, hh, st) => {
      if (id === "place-off") st.bracketReal = BRACKET_OFF;
      if (id === "remount") st.bracketReal = BRACKET_MOUNT;
      if (id === "check-bracket") {
        const b = worldOf(c, hh, "base");
        if (b && st.touches.P1) st.bracketCheck = probeError(compose(b, BRACKET_MOUNT), BRACKET_POINTS[0].p, st.touches.P1);
      }
    })(ctx, h);
  },
  // where the bracket should be: red while it is off, green once it sits right, gone once located
  hologram: (ctx) => {
    const st = store(ctx);
    if (st.bracketReg) return null;
    if (st.bracketReal === BRACKET_OFF) return { node: "bracket", local: BRACKET_MOUNT, state: st.bracketCheck != null ? "off" : "ghost" };
    if (st.bracketReal === BRACKET_MOUNT) return { node: "bracket", local: BRACKET_MOUNT, state: "match" };
    return { node: "bracket", local: BRACKET_MOUNT, state: "ghost" };
  },
  panel: (ctx): PanelModel => {
    const st = store(ctx);
    const extra: PanelLine[] = [];
    if (st.bracketCheck != null) extra.push({ label: "bracket P1 vs CAD", value: `${fmt(st.bracketCheck)} mm ${st.bracketCheck > 1 ? "✗ re-seat" : "✓"}`, state: st.bracketCheck > 1 ? "bad" : "ok" });
    if (st.bracketReg) extra.push({ label: "bracket located", value: `FRE ${fmt(st.bracketReg.freMm)} mm (3 touches)`, state: "ok" });
    return { caption: VERIFY_TL.chapterAt(ctx.t)?.headline ?? "", lines: panelFor(ctx, extra), records: recordsFor(ctx) };
  },
});

// ---------------- gallery: markers on the part (learned stickers, factory markers) ----------------

/** a pose of the base turned about its own centre and slid */
function aboutCentre(deg: number, shift: V3): Xf {
  const c = applyPoint(BASE_ON_BENCH, [0.08, 0.055, 0]);
  return compose(xf([c[0] + shift[0], c[1] + shift[1], 0], qaxis([0, 0, 1], (deg * Math.PI) / 180)), compose(xf([-c[0], -c[1], 0]), BASE_ON_BENCH));
}
const MOVED = aboutCentre(-24, [0.02, 0.035, 0]);
const holeOn = (part: Xf, name: string) => compose(part, SCREWS.find((x) => x.name === name)!.frame);
const CLOTH = { name: "cloth", kind: "display" as const, local: { p: [0, 0, 0.004] as V3 }, visual3d: [{ kind: "box" as const, size: [0.25, 0.34, 0.006] as V3, material: { color: "#2a3340", roughness: 1, opacity: 0.97 } }] };
const realWith = (anchors: "learned" | "factory"): SceneDef => {
  const d = assemblyScene({ tool: rig.tool, basePose: BASE_ON_BENCH, anchors });
  return { ...d, nodes: [...d.nodes, CLOTH] };
};

interface AnchorStore {
  stuck?: number;
  learned?: number;
  moveAt?: number;
  covered?: boolean;
  slipAt?: number;
  locatedAt?: number;
  alarmAt?: number;
}
const astore = (ctx: Ctx) => ctx.store as AnchorStore;

function anchorsTimeline() {
  const tl = new Timeline();
  const s1 = holeOn(BASE_ON_BENCH, "S1").p;
  const above = (p: V3, h = 0.05): V3 => [p[0], p[1], p[2] + h];
  tl.keys.push({ t: 0, tip: above(s1, 0.06), axis: [0, 0, -1] });
  tl.chapter("Stick", "Located by touch. Now stick a few marker stickers on it, anywhere.");
  tl.hold(0.4).action("stick").hold(1.6);
  tl.chapter("Learn", "The camera sees them once: it learns where each sticker sits on the part.");
  tl.to(above(holeOn(BASE_ON_BENCH, "C1").p, 0.05), [0, 0.2, -1], 1.1).to(above(holeOn(BASE_ON_BENCH, "S2").p, 0.05), [0, 0, -1], 1.1).action("learn").hold(0.9);
  tl.chapter("Move", "Turn it, slide it. The CAD follows the part. No touching again.");
  const hover = above(applyPoint(BASE_ON_BENCH, [0.08, 0.04, 0.03]), 0.09);
  tl.to(hover, [0, 0.25, -1], 0.8).action("move").hold(3.0);
  tl.chapter("Drive", "Drive on the moved part: the holes moved with it.");
  for (const n of ["S1", "S2"]) tl.screw(n, holeOn(MOVED, n), SCREWS.find((x) => x.name === n)!.depthMm, 1.2);
  tl.chapter("No sheet", "Cover the sheet. The part itself is the reference now.");
  tl.action("cover").hold(0.6);
  tl.screw("C1", holeOn(MOVED, "C1"), 10, 1.2);
  tl.chapter("Slip", "The vise slips 1.5 mm while driving: stop, before the screw goes in crooked.");
  tl.action("uncover");
  const start = tl.t;
  tl.screw("S3", holeOn(MOVED, "S3"), 14, 1.2);
  tl.actions.push({ at: start + 2.75 / 1.2, id: "slip" });
  tl.hold(1.8);
  return tl;
}
const ANCHORS_TL = anchorsTimeline();
const SLIPPED = compose(xf([0.0015, 0.0004, 0]), MOVED);
const realBase = (ctx: Ctx): Xf => {
  const a = astore(ctx);
  if (a.slipAt != null && ctx.t >= a.slipAt) return xlerp(MOVED, SLIPPED, Math.min(1, (ctx.t - a.slipAt) / 0.12));
  if (a.moveAt == null || ctx.t < a.moveAt) return BASE_ON_BENCH;
  const k = Math.min(1, (ctx.t - a.moveAt) / 2.2);
  return xlerp(BASE_ON_BENCH, MOVED, k * k * (3 - 2 * k));
};

export const assemblyAnchors: Scenario = base("assembly-anchors", ANCHORS_TL, {
  kicker: "3D assembly · markers on the part",
  title: "Stick markers on the part: move it, flip it, and it is still located",
  summary: "After locating the part by touch, a few marker stickers make it a moving reference: the engine learns where they are, follows the part when it is moved, works with the sheet covered, and stops when the part slips in the vise.",
  scene: () => assemblyScene({ tool: rig.tool, anchors: "learned" }),
  real: {
    def: realWith("learned"),
    nodes: ["base", BASE_BODY.name, "cloth"],
    pose: (ctx) => ({ base: realBase(ctx), bracket: null, [BASE_BODY.name]: astore(ctx).stuck != null ? xf() : null, cloth: astore(ctx).covered ? xf([0, 0, 0.004]) : null }),
  },
  // the camera sees the stickers once they are on (the engine uses them once it has learned them)
  bodies: (ctx) => (astore(ctx).stuck != null ? [{ node: BASE_BODY.name, world: realBase(ctx) }] : []),
  sheetSeen: (ctx) => !astore(ctx).covered,
  hidden: (ctx) => [...hiddenScrews(ctx), ...(astore(ctx).learned != null ? [] : [BASE_BODY.name])],
  onStep: (ctx, h) => {
    preRegistered(ctx, h);
    makeOnStep(ANCHORS_TL, (id, c, hh) => {
      const a = astore(c);
      if (id === "stick") a.stuck = c.t;
      if (id === "learn") {
        a.learned = c.t;
        hh.engine.setCalibrated(hh.ids[BASE_BODY.name], true);
      }
      if (id === "move") a.moveAt = c.t;
      if (id === "cover") a.covered = true;
      if (id === "uncover") a.covered = false;
      if (id === "slip") a.slipAt = c.t;
    })(ctx, h);
    const a = astore(ctx);
    if (a.alarmAt == null && ctx.snap && ctx.snap.alarms & 8) a.alarmAt = ctx.t;
  },
  panel: (ctx): PanelModel => {
    const a = astore(ctx);
    const s = ctx.snap;
    const lines: PanelLine[] = [
      { label: "stickers", value: a.learned != null ? "learned: 9 stickers on 4 faces" : a.stuck != null ? "on the part, not learned yet" : "none yet", state: a.learned != null ? "ok" : "idle" },
      { label: "reference", value: a.covered ? "the part's own markers (sheet covered)" : a.learned != null ? "sheet + the part's markers" : "sheet", state: a.covered ? "warn" : "ok" },
    ];
    if (a.moveAt != null) lines.push({ label: "part moved", value: "turned 24°, slid 4 cm: followed, no touch", state: "ok" });
    if (s && s.alarms & 8) lines.push({ label: "ALARM", value: "the part moved under the tool: stop", state: "bad" });
    else if (a.alarmAt != null) lines.push({ label: "slip", value: `caught ${fmt((a.alarmAt - (a.slipAt ?? a.alarmAt)) * 1000, 0)} ms after it happened`, state: "bad" });
    return { caption: ANCHORS_TL.chapterAt(ctx.t)?.headline ?? "", lines: panelFor(ctx, lines), records: recordsFor(ctx) };
  },
});

function factoryTimeline() {
  const tl = new Timeline();
  const s4 = holeOn(MOVED, "S1").p;
  tl.keys.push({ t: 0, tip: [s4[0] - 0.03, s4[1] - 0.04, 0.12], axis: [0, 0.2, -1] });
  tl.chapter("Arrive", "A part with markers printed on it by the factory arrives on the bench.");
  tl.action("arrive").hold(1.6);
  tl.chapter("Locate", "The camera sees it: located and identified at once. Nothing to touch.");
  tl.to([s4[0], s4[1], s4[2] + 0.06], [0, 0, -1], 1.2).hold(1.4);
  tl.chapter("Drive", "Straight to the screws.");
  for (const n of ["S1", "S2", "C1"]) tl.screw(n, holeOn(MOVED, n), SCREWS.find((x) => x.name === n)!.depthMm, 1.2);
  tl.hold(1.5);
  return tl;
}
const FACTORY_TL = factoryTimeline();
const arriving = (ctx: Ctx): Xf | null => {
  const at = (ctx.store as { arrive?: number }).arrive;
  if (at == null) return null;
  const k = Math.min(1, (ctx.t - at) / 1.4);
  return xlerp(compose(xf([0.0, -0.16, 0]), MOVED), MOVED, k * k * (3 - 2 * k));
};
export const assemblyFactory: Scenario = base("assembly-factory", FACTORY_TL, {
  kicker: "3D assembly · factory markers",
  title: "A part that comes with its own markers locates itself",
  summary: "Markers printed, engraved or labelled on the part at known CAD positions: the camera sees them and the part is located and identified on sight. No touching, no setup.",
  scene: () => assemblyScene({ tool: rig.tool, anchors: "factory" }),
  real: {
    def: realWith("factory"),
    nodes: ["base", BASE_BODY.name],
    pose: (ctx) => ({ base: arriving(ctx), bracket: null }),
  },
  bodies: (ctx) => {
    const w = arriving(ctx);
    return w ? [{ node: BASE_BODY.name, world: w }] : [];
  },
  hidden: (ctx) => [...hiddenScrews(ctx), ...(ctx.snap?.gate !== undefined && (ctx.store as { locatedAt?: number }).locatedAt != null ? [] : ["base", BASE_BODY.name, ...SCREWS.map((x) => x.name)])],
  onStep: (ctx, h) => {
    makeOnStep(FACTORY_TL, (id, c) => {
      if (id === "arrive") (c.store as { arrive?: number }).arrive = c.t;
    })(ctx, h);
    const st = ctx.store as { locatedAt?: number };
    if (st.locatedAt == null && ctx.events.some((e) => e.kind === "part-located")) st.locatedAt = ctx.t;
  },
  panel: (ctx): PanelModel => {
    const st = ctx.store as { locatedAt?: number; arrive?: number };
    const lines: PanelLine[] = st.locatedAt != null
      ? [
          { label: "part", value: "robot-arm base · rev B (markers 40-65)", state: "ok" },
          { label: "this job?", value: "yes: step 1 of the assembly", state: "ok" },
          { label: "located", value: `from its own markers, ${fmt((st.locatedAt - (st.arrive ?? st.locatedAt)), 1)} s after it arrived, 0 touches`, state: "ok" },
        ]
      : [{ label: "part", value: st.arrive != null ? "arriving…" : "none on the bench", state: "idle" }];
    const all = panelFor(ctx, lines).filter((l) => l.label !== "part located");
    return { caption: FACTORY_TL.chapterAt(ctx.t)?.headline ?? "", lines: all, records: recordsFor(ctx) };
  },
});

// ---------------- gallery: hands-free (gestures with the tool, sound) ----------------

function handsFreeTimeline() {
  const tl = new Timeline();
  const s1 = holeTruth("S1");
  tl.keys.push({ t: 0, tip: [s1.p[0] + 0.01, s1.p[1] - 0.02, s1.p[2] + 0.06], axis: [0, 0, -1] });
  tl.chapter("Confirm", "Gloves on, hands full. Tap the tip twice on the part: confirmed.");
  tl.hold(0.4).doubleTap(s1.p);
  tl.chapter("Listen", "Eyes on the work: the pitch rises as it lines up, a steady note when ready, ticks to the depth.");
  tl.screw("S1", s1, 14, 0.9);
  tl.chapter("Twist", "Twist the drill and back: skip S2 for later. The glow moves on.");
  const s2 = holeTruth("S2").p;
  tl.to([s2[0], s2[1], s2[2] + 0.03], [0, 0, -1], 0.9).hold(0.3).twist(75, 0.8).hold(0.9);
  tl.chapter("Drive", "Next one, by ear.");
  tl.screw("S3", holeTruth("S3"), 14, 0.9);
  tl.hold(1.2);
  return tl;
}
const HANDS_TL = handsFreeTimeline();
interface HandsStore {
  accepted?: number;
  skipped: string[];
  gestures: { t: number; kind: string }[];
}
const hstore = (ctx: Ctx) => {
  const s = ctx.store as unknown as Partial<HandsStore>;
  s.skipped ??= [];
  s.gestures ??= [];
  return s as HandsStore;
};
export const assemblyHandsFree: Scenario = base("assembly-handsfree", HANDS_TL, {
  kicker: "3D assembly · hands-free",
  title: "The drill is the remote: tap twice to confirm, twist to skip, and listen",
  summary: "Gestures with the tool itself, detected by the engine on measured poses: two taps of the tip confirm, a twist of the drill and back moves on. A tone guides the alignment and the depth, so the eyes stay on the work.",
  onStep: (ctx, h) => {
    preRegistered(ctx, h);
    makeOnStep(HANDS_TL)(ctx, h);
    const st = hstore(ctx);
    for (const e of ctx.snap?.events ?? []) {
      if (e.kind !== "gesture-tap" && e.kind !== "gesture-twist") continue;
      if (st.gestures.some((g) => Math.abs(g.t - e.t) < 1e-6)) continue;
      st.gestures.push({ t: e.t, kind: e.kind });
      if (e.kind === "gesture-tap" && st.accepted == null) st.accepted = ctx.t;
      if (e.kind === "gesture-twist") {
        const s = ctx.snap!;
        const done = new Set(s.targets.filter((x) => x.drilled).map((x) => ctx.names[x.id]));
        const next = SCREWS.map((x) => x.name).find((n) => !done.has(n) && !st.skipped.includes(n));
        if (next) st.skipped.push(next);
      }
    }
  },
  panel: (ctx): PanelModel => {
    const st = hstore(ctx);
    const lines: PanelLine[] = [
      { label: "tap-tap", value: st.accepted != null ? `✓ confirmed at ${fmt(st.accepted, 1)} s` : "waiting", state: st.accepted != null ? "ok" : "idle" },
      { label: "twist", value: st.skipped.length ? `✓ ${st.skipped.join(", ")} for later` : "–", state: st.skipped.length ? "ok" : "idle" },
    ];
    return { caption: HANDS_TL.chapterAt(ctx.t)?.headline ?? "", lines: panelFor(ctx, lines), records: recordsFor(ctx) };
  },
  skipped: (ctx) => hstore(ctx).skipped,
  sound: true,
});

// ---------------- gallery: learn from an expert (a ghost to follow, a score per screw) ----------------

function coachTimeline(expert: boolean) {
  const tl = new Timeline();
  const s1 = holeTruth("S1");
  tl.keys.push({ t: 0, tip: [s1.p[0] + 0.02, s1.p[1] - 0.03, s1.p[2] + 0.07], axis: [0, 0.2, -1] });
  tl.chapter("Follow", expert ? "" : "Follow the ghost: an expert's recorded run, one step ahead of you.");
  tl.hold(0.5);
  // the learner: slower, tilted and off-centre at first, better on each screw
  const tries: [string, number, number][] = expert ? [["S1", 0.06, 0.05], ["S2", 0.06, 0.05], ["S3", 0.06, 0.05]] : [["S1", 0.6, 0.7], ["S2", 0.3, 0.35], ["S3", 0.1, 0.12]];
  tries.forEach(([n, tilt, off], i) => {
    if (i === 1 && !expert) tl.chapter("Improve", "Each screw is scored against the expert's: square, centred, steady, in time.");
    if (i === 2 && !expert) tl.chapter("Match", "Third screw: as good as the ghost.");
    tl.screw(n, holeTruth(n), 14, expert ? 1.25 : 0.85, { driveTiltDeg: tilt, offsetMm: off });
  });
  tl.hold(1.6);
  return tl;
}
const LEARNER_TL = coachTimeline(false);
const EXPERT_TL = coachTimeline(true);
/** the expert's time for a learner's time: screw by screw, so the ghost stays with the learner */
function expertTime(t: number): number {
  const anchors: [number, number][] = [[0, 0]];
  for (const n of ["S1", "S2", "S3"]) {
    const a = LEARNER_TL.screws[n], b = EXPERT_TL.screws[n];
    anchors.push([a[0], b[0]], [a[1], b[1]]);
  }
  anchors.push([LEARNER_TL.duration, EXPERT_TL.duration]);
  for (let i = 1; i < anchors.length; i++) {
    const [l0, e0] = anchors[i - 1], [l1, e1] = anchors[i];
    if (t <= l1) return e0 + ((t - l0) / Math.max(1e-6, l1 - l0)) * (e1 - e0);
  }
  return EXPERT_TL.duration;
}
// the expert's own scores: its recorded run through the same engine, headless (computed once)
let expertScores: Record<string, number> | null = null;
function scoresOfExpert(core: Ctx["core"]): Record<string, number> {
  if (expertScores) return expertScores;
  const rec = new ScrewRecorder();
  const sc = base("assembly-coach-expert", EXPERT_TL, {
    onStep: (ctx, h) => {
      preRegistered(ctx, h);
      makeOnStep(EXPERT_TL)(ctx, h);
      const sn = ctx.snap;
      if (sn && sn.active >= 0) {
        const a = sn.targets[sn.active];
        rec.add(ctx.names[a.id] ?? null, { t: ctx.t, phase: sn.phase, angleDeg: a.angleErrDeg, offsetMm: a.offsetMm, depthMm: a.depthMm });
      }
    },
  });
  const run = new ScenarioRun(core, sc);
  for (let t = 0; t <= sc.duration; t += 1 / 60) run.step(t);
  run.dispose();
  expertScores = {};
  for (const n of ["S1", "S2", "S3"]) {
    const x = rec.score(n);
    if (x) expertScores[n] = x.score;
  }
  return expertScores;
}
interface CoachStore {
  rec?: ScrewRecorder;
}
export const assemblyCoach: Scenario = base("assembly-coach", LEARNER_TL, {
  kicker: "3D assembly · learn",
  title: "Follow an expert's ghost, and get a score for every screw",
  summary: "An expert's run is recorded as tool poses and replayed as a ghost one step ahead. Each screw the learner drives is scored from what the engine measured: square, centred, steady and in time.",
  onStep: (ctx, h) => {
    preRegistered(ctx, h);
    makeOnStep(LEARNER_TL)(ctx, h);
    const cs = ctx.store as CoachStore;
    cs.rec ??= new ScrewRecorder();
    const s = ctx.snap;
    if (s && s.active >= 0) {
      const a = s.targets[s.active];
      cs.rec.add(ctx.names[a.id] ?? null, { t: ctx.t, phase: s.phase, angleDeg: a.angleErrDeg, offsetMm: a.offsetMm, depthMm: a.depthMm });
    }
  },
  ghostTool: (ctx) => EXPERT_TL.toolAt(Math.min(EXPERT_TL.duration, expertTime(ctx.t) + 0.35), 0),
  panel: (ctx): PanelModel => {
    const cs = ctx.store as CoachStore;
    const ex = scoresOfExpert(ctx.core);
    const rows = ["S1", "S2", "S3"].flatMap((n) => {
      const sc = cs.rec?.score(n);
      if (!sc || !store(ctx).seated[n]) return [];
      return [[n, `${sc.score}`, ex[n] != null ? `${ex[n]}` : "–", `${fmt(sc.maxAngleDeg)}°`, `${fmt(sc.startOffsetMm)} mm`, `${fmt(sc.timeS, 1)} s`]];
    });
    return {
      caption: LEARNER_TL.chapterAt(ctx.t)?.headline ?? "",
      lines: panelFor(ctx).filter((l) => l.label !== "screws seated"),
      records: { cols: ["screw", "you", "expert", "max angle", "start offset", "time"], rows },
      note: "The ghost is the expert's recorded run (tool poses over time), replayed in step with you. Scores come from the engine's measurements, not from the script.",
    };
  },
});

// ---------------- gallery: a remote expert adds a hole ----------------

function remoteTimeline() {
  const tl = new Timeline();
  const s1 = holeTruth("S1");
  tl.keys.push({ t: 0, tip: [s1.p[0] + 0.02, s1.p[1] - 0.03, s1.p[2] + 0.07], axis: [0, 0.2, -1] });
  tl.chapter("Drive", "On the shop floor: the job as planned.");
  tl.screw("S1", s1, 14, 1.1);
  tl.chapter("Remote", "Miles away, an expert sees the same 3D scene live and marks one more hole.");
  tl.hold(0.6).action("remote-add").hold(2.2);
  tl.chapter("Drive", "It appears on the part, glowing, on the phone. Drive it.");
  const r = compose(BASE_ON_BENCH, REMOTE_HOLE.frame);
  tl.screw("R1", r, REMOTE_HOLE.depthMm, 1.1);
  tl.hold(1.4);
  return tl;
}
const REMOTE_TL = remoteTimeline();
const REMOTE_SCENE = () => assemblyScene({ tool: rig.tool, extraHoles: [REMOTE_HOLE] });
export const assemblyRemote: Scenario = base("assembly-remote", REMOTE_TL, {
  kicker: "3D assembly · remote expert",
  title: "A remote expert marks a hole, and it lights up on the part",
  summary: "The engine streams poses, not video: a remote expert sees the whole scene live in 3D from a few kB/s, marks a hole on the CAD, and it appears on the operator's phone, on the real part, ready to drive.",
  scene: REMOTE_SCENE,
  depths: [...SCREW_DEPTHS, REMOTE_HOLE.depthMm],
  order: (ctx) => [...SCREWS.map((x) => x.name), ...((ctx.store as { added?: number }).added != null ? [REMOTE_HOLE.name] : [])],
  hidden: (ctx) => [...hiddenScrews(ctx).filter((n) => n !== `${REMOTE_HOLE.name}-screw` || !store(ctx).seated.R1), ...((ctx.store as { added?: number }).added != null ? [] : [REMOTE_HOLE.name, `${REMOTE_HOLE.name}-screw`]), ...(store(ctx).seated.R1 ? [] : [`${REMOTE_HOLE.name}-screw`])],
  onStep: (ctx, h) => {
    preRegistered(ctx, h);
    makeOnStep(REMOTE_TL, (id, c, hh) => {
      if (id !== "remote-add") return;
      (c.store as { added?: number }).added = c.t;
      // the engine's job gets the new hole (its depth too); the drilled flags are kept by re-marking nothing: the
      // remote adds it right after S1, and S1 stays recorded by the scenario
      hh.engine.setNavigation(hh.ids.tool, [...SCREWS.map((x) => hh.ids[x.name]), hh.ids[REMOTE_HOLE.name]]);
      hh.engine.setTargetDepths([...SCREW_DEPTHS, REMOTE_HOLE.depthMm]);
    })(ctx, h);
  },
  panel: (ctx): PanelModel => {
    const added = (ctx.store as { added?: number }).added;
    const lines: PanelLine[] = [
      { label: "remote link", value: "poses, 30 Hz: ≈ 1.4 kB/s (video would be ≈ 250 kB/s)", state: "ok" },
      { label: "remote expert", value: added != null ? `marked R1 (M4×12, top) at ${fmt(added, 1)} s` : "watching the live 3D scene", state: added != null ? "ok" : "idle" },
    ];
    return { caption: REMOTE_TL.chapterAt(ctx.t)?.headline ?? "", lines: panelFor(ctx, lines), records: recordsFor(ctx), downloads: downloadsFor(ctx, SCREWS.length + 1) };
  },
});

export const ASSEMBLY_SCENARIOS = [assemblyHero, assemblyAnchors, assemblyFactory, assemblyHandsFree, assemblyCoach, assemblyRemote, assemblyRegister, assemblyFaces, assemblyVerify];
