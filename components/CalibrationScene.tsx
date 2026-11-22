"use client";

// The tool calibration, animated in 3D (three.js) with the site's own models: the printed sheet with its real
// markers, the drill, the dock v0.4 and the phone. The loop:
//   1 pivot  the tip rests on A2 and the drill circles around it: the lens sweeps a cone, every ray to the
//            tip meets at one point (that point is the tip)
//   2 roll   same spot, the drill twists around its bit: the line that stays still is the bit's axis
//   3 check  the tip rests on A2 again: its measured distance to A2
// An inset shows what the phone's camera sees, rendered from the lens's pose.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AR } from "@/lib/aruco";
import { BOARD_TARGETS, DICTIONARY } from "@/lib/board";
import type { EngineSnapshot } from "@/lib/engine";
import { DEFAULT_RIG, markerCodes } from "@/lib/scene";
import { Scene3D } from "@/lib/render/render3d";
import { INTO_SHEET, smartToolsScene, toXf, toolLocal, type SceneDef } from "@/lib/scenedef";
import { compose, inverse, qaxis, qmul, xf, type Xf } from "@/lib/xform";
import type { V3 } from "@/lib/pose";

const A2 = BOARD_TARGETS.find((t) => t.label === "A2")!;
const TIP: V3 = [A2.x, A2.y, 0];
const PIVOT_TILT = (13 * Math.PI) / 180;
/** the drill's turn around its bit, chosen so the phone faces the viewer */
const BASE_TWIST = -Math.PI / 2;
const PHONE_HIDDEN = ["camera", "dock", "dock-lower", "dock-arm", "dock-jaw"];

const STEPS = [
  { k: "1", name: "Pivot", from: 1.5, to: 7.5, text: "The tip rests on A2; the drill circles around it. Every ray from the lens to the tip meets at one point: that point is the tip." },
  { k: "2", name: "Roll", from: 8, to: 13, text: "Same spot, the drill twists around its own bit. The line that stays still is the bit's axis." },
  { k: "3", name: "Check", from: 13.5, to: 17.5, text: "Rest the tip on A2 again: the app reports how far the measured tip is from it." },
] as const;
const LOOP = 18.5;

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** How the drill is held at time t (s): tip position, tilt (direction and size) and twist around the bit. */
function holdAt(t: number) {
  let tipZ = 0, tilt = 0, az = 0, twist = 0;
  if (t < 1.5) tipZ = 0.06 * (1 - ease(t / 1.4)); // comes down onto A2
  else if (t < 7.5) {
    const u = (t - 1.5) / 6;
    tilt = PIVOT_TILT * ease(Math.min(u * 6, 1)) * ease(Math.min((1 - u) * 6, 1));
    az = u * 2 * Math.PI * 1.5;
  } else if (t < 8) {
    tilt = 0;
  } else if (t < 13) {
    const u = (t - 8) / 5;
    twist = Math.sin(u * Math.PI * 3) * (Math.PI / 3) * ease(Math.min(u * 5, 1)) * ease(Math.min((1 - u) * 5, 1));
  } else if (t < 13.5) tipZ = 0.025 * Math.sin(((t - 13) / 0.5) * Math.PI); // lift and set down again
  else if (t < 17.5) tipZ = 0;
  else tipZ = 0.06 * ease((t - 17.5) / 1); // lifts away, then the loop starts over
  return { tip: [TIP[0], TIP[1], tipZ] as V3, tilt, az, twist };
}

export type SceneFocus = "lens" | "pivot" | "roll" | "check";

/** One step on its own, looped (the guided setup shows the movement of the step you are on). */
function focusTime(focus: SceneFocus, e: number): number {
  if (focus === "pivot") return 1.5 + (e % 6);
  if (focus === "roll") return 8 + (e % 5);
  return 12.9 + (e % 4.6); // check: lift, set the tip on A2, hold
}
/** Calibrating the lens: the drill (phone on it) sweeps over the sheet, near and far, tilting to every side. */
function lensHold(e: number) {
  const w = (2 * Math.PI) / 8;
  return {
    tip: [0.05 * Math.sin(w * e), A2.y + 0.05 * Math.sin(2 * w * e), 0.09 + 0.05 * (0.5 + 0.5 * Math.sin(0.6 * w * e))] as V3,
    tilt: 0.32 * (0.6 + 0.4 * Math.sin(1.3 * w * e)),
    az: w * e * 1.5,
    twist: 0.4 * Math.sin(w * e),
  };
}

function toolWorld(h: ReturnType<typeof holdAt>): Xf {
  // tool frame: origin at the tip, +Z the drilling direction; tilted in the direction az, twisted around +Z
  const tiltQ = qaxis([-Math.sin(h.az), Math.cos(h.az), 0], h.tilt);
  const q = qmul(tiltQ, qmul(INTO_SHEET, qaxis([0, 0, 1], BASE_TWIST + h.twist)));
  return xf(h.tip, q);
}

/** World transforms of every node of the scene, with the camera placed (sheet = world). */
function snapshotFor(def: SceneDef, camW: Xf) {
  const ids: Record<string, number> = {};
  const worlds: Record<string, Xf | null> = {};
  def.nodes.forEach((n, i) => {
    ids[n.name] = i + 1;
    const parent = n.parent ? worlds[n.parent] : toXf();
    const local = n.name === "camera" ? camW : toXf(n.local);
    worlds[n.name] = parent ? compose(parent, local) : null;
  });
  const nodes = def.nodes.filter((n) => worlds[n.name]).map((n) => ({ id: ids[n.name], status: "static" as const, age: 0, world: worlds[n.name]! }));
  return { ids, snap: { nodes } as unknown as EngineSnapshot };
}

const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

export default function CalibrationScene({ focus, compact = false, className }: { focus?: SceneFocus; compact?: boolean; className?: string } = {}) {
  const focusRef = useRef(focus);
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);
  const mountRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLCanvasElement>(null);
  const [step, setStep] = useState(-1);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = mountRef.current!;
    const inset = insetRef.current!;
    const rig = DEFAULT_RIG;
    const tool = rig.tool;
    const def = smartToolsScene({ tool });
    const codes = markerCodes(new AR.Dictionary(DICTIONARY).codeList);

    // compact (over the camera, in the guided setup): a transparent background, so the camera shows through
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: compact });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    const phoneR = new THREE.WebGLRenderer({ canvas: inset, antialias: true });
    phoneR.setPixelRatio(1);
    const PW = 384, PH = 216;
    phoneR.setSize(PW, PH, false);

    const scene = new THREE.Scene();
    scene.background = compact ? null : new THREE.Color(0x05080d);
    scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x101820, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(0.4, -0.5, 0.9);
    scene.add(sun);
    const grid = new THREE.GridHelper(0.8, 40, 0x1d3a4a, 0x0f1d26);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.001;
    scene.add(grid);

    const s3 = new Scene3D(def, { markerCodes: codes, layer1: PHONE_HIDDEN });
    scene.add(s3.root);

    // ---- overlays (layer 1: the viewer sees them, the phone's camera does not) ----
    const overlay = new THREE.Group();
    scene.add(overlay);
    const disposables: { dispose: () => void }[] = [];
    const mat = <T extends THREE.Material>(m: T) => (disposables.push(m), m);
    const geo = <T extends THREE.BufferGeometry>(g: T) => (disposables.push(g), g);
    // the fixed point: the tip on A2
    const tipGlow = new THREE.Mesh(geo(new THREE.SphereGeometry(0.0035, 20, 14)), mat(new THREE.MeshBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0.95 })));
    tipGlow.position.copy(v3(TIP));
    overlay.add(tipGlow);
    const halo = new THREE.Mesh(geo(new THREE.RingGeometry(0.006, 0.0075, 40)), mat(new THREE.MeshBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0.8, side: THREE.DoubleSide })));
    halo.position.set(TIP[0], TIP[1], 0.0008);
    overlay.add(halo);
    // the lens's path while pivoting, and rays from recent lens positions to the tip
    const TRAIL = 140;
    const trailGeo = geo(new THREE.BufferGeometry());
    trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
    const trail = new THREE.Line(trailGeo, mat(new THREE.LineBasicMaterial({ color: 0x3dffa8, transparent: true, opacity: 0.9 })));
    overlay.add(trail);
    const RAYS = 10;
    const raysGeo = geo(new THREE.BufferGeometry());
    raysGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RAYS * 6), 3));
    const rays = new THREE.LineSegments(raysGeo, mat(new THREE.LineBasicMaterial({ color: 0x5ad8ff, transparent: true, opacity: 0.45 })));
    overlay.add(rays);
    // the bit's axis, extended, while rolling
    const axisGeo = geo(new THREE.BufferGeometry());
    axisGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    // drawn over everything: the axis runs through the bit, the chuck and the drill
    const axisLine = new THREE.Line(axisGeo, mat(new THREE.LineBasicMaterial({ color: 0x3dffa8, transparent: true, opacity: 0, depthTest: false })));
    axisLine.renderOrder = 10;
    overlay.add(axisLine);
    overlay.traverse((o) => o.layers.set(1));

    const cam = new THREE.PerspectiveCamera(36, 1, 0.01, 10);
    cam.up.set(0, 0, 1);
    // compact (inside the guided setup): closer, on the tip and the drill
    if (!compact) cam.position.set(0.46, -0.52, 0.36);
    cam.layers.enable(1);
    const controls = new OrbitControls(cam, renderer.domElement);
    if (!compact) controls.target.set(-0.01, -0.01, 0.13);
    // compact: framed per step (the lens step needs the whole drill high above the sheet)
    let framed: SceneFocus | undefined | null = null;
    const frameFor = (fc: SceneFocus | undefined) => {
      if (fc === "lens") {
        cam.position.set(0.42, -0.5, 0.34);
        controls.target.set(0, -0.02, 0.14);
      } else {
        cam.position.set(0.34, -0.4, 0.26);
        controls.target.set(0, -0.015, 0.12);
      }
      controls.update();
    };
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = 1.45;

    const phoneCam = new THREE.PerspectiveCamera((2 * Math.atan(rig.height / 2 / rig.camera.f) * 180) / Math.PI, rig.width / rig.height, 0.02, 5);
    phoneCam.layers.set(0);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      cam.aspect = w / h;
      cam.fov = compact ? 38 : w < 640 ? 50 : 36;
      cam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    let visible = true;
    const io = new IntersectionObserver((e) => (visible = e[0].isIntersecting), { rootMargin: "100px" });
    io.observe(el);

    const lensPath: THREE.Vector3[] = [];
    let raf = 0;
    let lastStep = -2;
    const t0 = performance.now();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!visible) return;
      const e = (performance.now() - t0) / 1000;
      const fc = focusRef.current;
      if (compact && fc !== framed) {
        framed = fc;
        frameFor(fc);
      }
      const t = fc ? (fc === "lens" ? 0 : focusTime(fc, e)) : e % LOOP;
      const h = fc === "lens" ? lensHold(e) : holdAt(t);
      const toolW = toolWorld(h);
      const camW = compose(toolW, inverse(toolLocal(tool)));
      const { ids, snap } = snapshotFor(def, camW);
      s3.update(snap, ids);

      // pivot: the lens sweeps a cone; its rays all meet at the tip
      const pivoting = fc !== "lens" && t >= 1.5 && t < 7.5;
      if (fc !== "lens" && t < 1.5) lensPath.length = 0;
      if (pivoting || fc === "lens") {
        lensPath.push(v3(camW.p));
        if (lensPath.length > TRAIL) lensPath.shift();
      }
      const tp = trailGeo.attributes.position as THREE.BufferAttribute;
      lensPath.forEach((p, i) => tp.setXYZ(i, p.x, p.y, p.z));
      tp.needsUpdate = true;
      trailGeo.setDrawRange(0, lensPath.length);
      (trail.material as THREE.LineBasicMaterial).opacity = fc === "lens" || t < 8 ? 0.9 : Math.max(0, 0.9 - (t - 8) * 0.6);
      const rp = raysGeo.attributes.position as THREE.BufferAttribute;
      let nr = 0;
      if (fc !== "lens" && t < 8.5) {
        for (let i = 0; i < RAYS && lensPath.length; i++) {
          const p = lensPath[Math.floor((i / RAYS) * lensPath.length)];
          rp.setXYZ(nr * 2, p.x, p.y, p.z);
          rp.setXYZ(nr * 2 + 1, TIP[0], TIP[1], TIP[2]);
          nr++;
        }
      }
      rp.needsUpdate = true;
      raysGeo.setDrawRange(0, nr * 2);

      // roll: the bit's axis, extended, stays still
      const rolling = t >= 8 && t < 13;
      const ap = axisGeo.attributes.position as THREE.BufferAttribute;
      ap.setXYZ(0, TIP[0], TIP[1], TIP[2] - 0.02);
      ap.setXYZ(1, TIP[0], TIP[1], TIP[2] + 0.42);
      ap.needsUpdate = true;
      (axisLine.material as THREE.LineBasicMaterial).opacity = rolling ? 0.95 : t >= 13 && t < 14 ? 0.95 - (t - 13) : 0;

      // the fixed point pulses
      const pulse = 1 + 0.25 * Math.sin(t * 6);
      halo.scale.setScalar(fc !== "lens" && (pivoting || t >= 13.5) ? pulse : 1);
      (halo.material as THREE.MeshBasicMaterial).color.set(t >= 13.5 && t < 17.5 ? 0x3dffa8 : 0xffb547);

      controls.update();
      renderer.render(scene, cam);
      // what the phone's camera sees (the true lens pose; OpenCV axes → three.js camera axes)
      phoneCam.position.set(...camW.p);
      const q = new THREE.Quaternion(camW.q[1], camW.q[2], camW.q[3], camW.q[0]);
      phoneCam.quaternion.copy(q.multiply(new THREE.Quaternion(1, 0, 0, 0)));
      if (!compact) phoneR.render(scene, phoneCam);

      if (!compact) {
        // the step in progress (a short pause between steps keeps the last one); -1 before, 3 after
        const st = t < STEPS[0].from ? -1 : t >= STEPS[2].to ? 3 : STEPS.reduce((k, s, i) => (t >= s.from ? i : k), 0);
        if (st !== lastStep) {
          lastStep = st;
          setStep(st);
        }
        setProgress(t / LOOP);
      }
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      s3.dispose();
      renderer.dispose();
      phoneR.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  const cur = step >= 0 && step < STEPS.length ? STEPS[step] : null;
  if (compact)
    return (
      <div className={`relative overflow-hidden rounded-2xl ${className ?? "h-56"}`}>
        <div ref={mountRef} className="h-full w-full" />
        <canvas ref={insetRef} className="hidden" />
      </div>
    );
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10">
      <div ref={mountRef} className="h-[420px] w-full cursor-grab sm:h-[480px]" />
      {/* what the phone sees */}
      <div className="pointer-events-none absolute right-3 top-3 w-[38%] max-w-[260px] overflow-hidden rounded-lg border border-white/20 bg-black shadow-lg">
        <canvas ref={insetRef} className="block aspect-video w-full" />
        <div className="bg-black/70 px-2 py-1 font-mono text-[10px] text-white/60">what the phone&apos;s camera sees</div>
      </div>
      {/* the step and its explanation */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-xl border border-white/10 bg-black/65 p-3 backdrop-blur-md">
        <div className="flex flex-wrap gap-1.5">
          {STEPS.map((s, i) => (
            <span key={s.k} className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] ${i === step ? "bg-[var(--green)] text-black" : "border border-white/15 text-white/50"}`}>
              {s.k} · {s.name}
            </span>
          ))}
        </div>
        <p className="mt-2 min-h-[2.5rem] text-sm leading-snug text-white/80">
          {cur ? cur.text : step === 3 ? "Calibrated: the app now knows where the tip is and which way the bit points, for this mount. Starting over." : "The drill comes down onto the printed target A2."}
          {step === 2 && <span className="ml-1 font-mono text-[var(--green)]">tip → A2: 0.05 mm (simulated reference)</span>}
        </p>
        <div className="mt-2 h-0.5 w-full rounded bg-white/10">
          <div className="h-0.5 rounded bg-[var(--green)]" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
