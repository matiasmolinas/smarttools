// 3D-assembly scenarios: a robot-arm base screwed together with the drill/driver. The part is located
// by touching it with the bit tip (the engine registers it), verified on points it never saw, then
// screws go into the top and a 35° chamfer; a bracket is placed, probed, registered and screwed down.
// Everything runs on the real engine: registration uses the tip positions the engine measured.

import { BASE_NOMINAL, BASE_ON_BENCH, BRACKET_MOUNT, BRACKET_POINTS, CHECKPOINTS, FIDUCIALS, SCREWS, SCREW_DEPTHS, assemblyScene, probeError } from "../assembly.ts";
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
const GHOST = ["base", "bracket"];
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
}
const store = (ctx: Ctx): Store => {
  const s = ctx.store as unknown as Partial<Store>;
  s.done ??= new Set();
  s.touches ??= {};
  s.verify ??= {};
  s.seated ??= {};
  s.maxAngle ??= {};
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
  const spec = SCREWS.find((x) => x.name === name);
  const seated = Object.keys(st.seated).length;
  const lines: PanelLine[] = [
    { label: "part located", value: st.reg?.applied ? `yes · FRE ${fmt(st.reg.freMm)} mm (4 touches)` : st.reg ? "snapping…" : "not yet: touch F1-F4", state: st.reg?.applied ? "ok" : "warn" },
    ...Object.entries(st.verify).map(([k, v]) => ({ label: `check ${k}`, value: `${fmt(v)} mm`, state: (v < 1 ? "ok" : "bad") as PanelLine["state"] })),
    ...extra,
    { label: "screws seated", value: `${seated} / ${SCREWS.length}`, state: seated ? "ok" : "idle" },
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
    const spec = SCREWS.find((x) => x.name === n)!;
    return [n, spec.face, spec.size, `${fmt(r.depth, 1)} mm`, `${fmt(r.angle)}°`];
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
    panel: (ctx) => ({ caption: tl.chapterAt(ctx.t)?.headline ?? "", lines: panelFor(ctx), records: recordsFor(ctx) }),
    ...o,
  };
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
  panel: (ctx): PanelModel => {
    const st = store(ctx);
    const extra: PanelLine[] = [];
    if (st.bracketCheck != null) extra.push({ label: "bracket P1 vs CAD", value: `${fmt(st.bracketCheck)} mm ${st.bracketCheck > 1 ? "✗ re-seat" : "✓"}`, state: st.bracketCheck > 1 ? "bad" : "ok" });
    if (st.bracketReg) extra.push({ label: "bracket located", value: `FRE ${fmt(st.bracketReg.freMm)} mm (3 touches)`, state: "ok" });
    return { caption: VERIFY_TL.chapterAt(ctx.t)?.headline ?? "", lines: panelFor(ctx, extra), records: recordsFor(ctx) };
  },
});

export const ASSEMBLY_SCENARIOS = [assemblyHero, assemblyRegister, assemblyFaces, assemblyVerify];
