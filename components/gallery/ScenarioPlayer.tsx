"use client";

// Plays one scenario on the real engine (WASM): scripted motion -> measurements -> engine -> snapshots,
// drawn as
// - 3D: the engine's scene (visual3d), with the CAD model of located parts as a cyan "ghost", and the
//   real parts (where they truly are) drawn solid;
// - 2D: the phone HUD over what the camera sees (a rendered phone view in 3D jobs, the simulated sheet
//   image in flat jobs), or a plan (visual2d);
// - a panel with the numbers the engine decides with.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AR } from "@/lib/aruco";
import { DICTIONARY } from "@/lib/board";
import { NavCore, type EngineSnapshot } from "@/lib/engine";
import { cameraPoseForTool, markerCodes } from "@/lib/scene";
import { Scene3D } from "@/lib/render/render3d";
import { GuidanceLayer } from "@/lib/render/guidance3d";
import { guidance, locatedFrom, type Guidance } from "@/lib/guidance";
import { SoundGuide, toneFromHud } from "@/lib/audio";
import { drawPlan } from "@/lib/render/render2d";
import { hudView } from "@/lib/render/hudview";
import { drawHud } from "@/lib/hud";
import { applyPoint, compose, inverse, toPose, type Xf } from "@/lib/xform";
import { toXf, toolLocal, type SceneDef } from "@/lib/scenedef";
import { ScenarioRun } from "@/lib/gallery/runner";
import type { Ctx, PanelModel, Scenario } from "@/lib/gallery/scenarios";

const CAM_W = 480;
const CAM_H = 270;
let corePromise: Promise<NavCore> | null = null;

/** World transforms of a static scene definition (locals composed down the tree), with overrides. */
function staticSnapshot(def: SceneDef, overrides: Record<string, Xf | null> = {}) {
  const ids: Record<string, number> = { world: 0 };
  const worlds: Record<string, Xf | null> = { world: toXf() };
  def.nodes.forEach((n, i) => {
    ids[n.name] = i + 1;
    const parent = n.parent ? worlds[n.parent] : toXf();
    const local = n.name in overrides ? overrides[n.name] : toXf(n.local);
    worlds[n.name] = parent && local ? compose(parent, local) : null;
  });
  const nodes = def.nodes.filter((n) => worlds[n.name]).map((n) => ({ id: ids[n.name], status: "static" as const, age: 0, world: worlds[n.name]! }));
  return { ids, snap: { nodes } as unknown as EngineSnapshot };
}

export default function ScenarioPlayer({ scenario, playing, onEnd, variant = "gallery" }: { scenario: Scenario; playing: boolean; onEnd: () => void; variant?: "gallery" | "hero" }) {
  const mount = useRef<HTMLDivElement>(null);
  const view2d = useRef<HTMLCanvasElement>(null);
  const [panel, setPanel] = useState<PanelModel | null>(null);
  const [progress, setProgress] = useState(0);
  const [segment, setSegment] = useState("");
  const [headline, setHeadline] = useState("");
  const [chapter, setChapter] = useState(-1);
  // sound guidance: off until the viewer turns it on (browsers need a click to start audio)
  const sound = useRef<SoundGuide | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const [says, setSays] = useState("");
  useEffect(() => () => sound.current?.close(), []);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const hero = variant === "hero";

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    (async () => {
      const core = await (corePromise ??= NavCore.load());
      if (disposed) return;
      const codes = markerCodes(new AR.Dictionary(DICTIONARY).codeList);
      const run = new ScenarioRun(core, scenario);
      cleanups.push(() => run.dispose());

      // ---- 3D ----
      const el = mount.current!;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      el.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05080d);
      scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x101820, 1.5));
      const sun = new THREE.DirectionalLight(0xffffff, 1.7);
      sun.position.set(0.4, -0.5, 0.9);
      scene.add(sun);
      const bench = !!scenario.view3d?.up && scenario.view3d.up[2] === 1;
      const grid = new THREE.GridHelper(bench ? 1.0 : 0.8, bench ? 50 : 40, 0x1d3a4a, 0x0f1d26);
      grid.rotation.x = Math.PI / 2;
      grid.position.z = -0.001;
      scene.add(grid);
      const cam = new THREE.PerspectiveCamera(hero ? 34 : 40, 1, 0.01, 10);
      const v = scenario.view3d ?? { pos: [0.42, 0.14, 0.5], target: [0, 0, 0.1] };
      if (v.up) cam.up.set(...v.up);
      cam.position.set(...v.pos);
      cam.layers.enable(1);
      const controls = new OrbitControls(cam, renderer.domElement);
      controls.target.set(...v.target);
      controls.enableZoom = false;
      controls.autoRotate = hero;
      controls.autoRotateSpeed = 0.35;
      let s3: Scene3D | null = null;
      let s3Version = -1;
      // the real parts (solid), placed statically
      const real = scenario.real ? new Scene3D(scenario.real.def, { only: scenario.real.nodes, markerCodes: codes }) : null;
      if (real) scene.add(real.root);
      // guidance on the part: next hole glowing, approach tunnel, x-ray (seen by the phone too)
      const guide = scenario.guidance ? new GuidanceLayer() : null;
      if (guide) scene.add(guide.root);
      // the next part as a hologram where it goes (cyan; green when the real part matches, red when off)
      const holoNode = scenario.hologram && scenario.real ? (scenario.hologram(run.ctx(0, scenario.segments[0]) as Ctx)?.node ?? "bracket") : null;
      const holo = holoNode && scenario.real ? new Scene3D(scenario.real.def, { only: [holoNode], ghost: [holoNode] }) : null;
      if (holo) scene.add(holo.root);
      let model: Guidance | null = null;

      // ---- the phone's view (3D jobs): the same scene seen from the docked camera ----
      const phoneR = scenario.view2d === "phone" ? new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }) : null;
      const phoneCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.03, 5);
      phoneCam.layers.set(0);
      const PW = 640, PH = 360;
      phoneR?.setSize(PW, PH, false);

      const resize = () => {
        if (disposed || !view2d.current) return;
        const w = el.clientWidth, h = el.clientHeight;
        renderer.setSize(w, h, false);
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        const c = view2d.current!;
        const d = Math.min(window.devicePixelRatio, 2);
        c.width = Math.round(c.clientWidth * d);
        c.height = Math.round(c.clientHeight * d);
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();
      cleanups.push(() => {
        ro.disconnect();
        controls.dispose();
        s3?.dispose();
        real?.dispose();
        guide?.dispose();
        holo?.dispose();
        renderer.dispose();
        phoneR?.dispose();
        el.removeChild(renderer.domElement);
      });

      // ---- the simulated phone camera image (flat jobs) ----
      const camCanvas = document.createElement("canvas");
      camCanvas.width = CAM_W;
      camCanvas.height = CAM_H;
      const camCtx = camCanvas.getContext("2d")!;
      let lastCamRender = -1;

      let t = 0;
      let last = performance.now();
      let lastPanel = -1;
      let toneSays = "";
      let raf = 0;
      const frame = (now: number) => {
        if (disposed || !view2d.current) return;
        raf = requestAnimationFrame(frame);
        const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
        last = now;
        if (playingRef.current) t += dt;
        if (t > scenario.duration) {
          t = 0;
          run.reset();
          onEndRef.current();
        }
        const f = run.step(t);
        const { def, ids } = f.scene;
        if (run.sceneVersion !== s3Version) {
          if (s3) {
            scene.remove(s3.root);
            s3.dispose();
          }
          s3 = new Scene3D(def, { markerCodes: codes, ghost: scenario.ghost, layer1: scenario.phoneHidden });
          scene.add(s3.root);
          s3Version = run.sceneVersion;
        }
        if (f.snap && s3) {
          s3.update(f.snap, ids);
          for (const n of f.hidden) {
            const o = s3.objects.get(n);
            if (o) o.visible = false;
          }
        }
        if (guide && scenario.guidance && f.snap) {
          const snap0 = f.snap;
          const worldOf = (n: string) => snap0.nodes.find((x) => x.id === ids[n])?.world ?? null;
          const located = locatedFrom(def, snap0, ids);
          const gctx = run.ctx(t, f.segment) as Ctx;
          const order = scenario.order?.(gctx) ?? def.navigation.targets;
          const depths = order.map((n) => (def.nodes.find((x) => x.name === n)?.meta?.depthMm as number | undefined) ?? scenario.depths?.[def.navigation.targets.indexOf(n)] ?? 0);
          model = guidance({ snap: snap0, order, ids, depths, solids: scenario.guidance(gctx, worldOf), located, skipped: scenario.skipped?.(gctx), quality: (n) => scenario.quality?.(gctx, n) });
          guide.update(model, t);
          guide.setGhostTool(scenario.ghostTool?.(gctx) ?? null);
        }
        if (holo && scenario.real && scenario.hologram) {
          const h = scenario.hologram(run.ctx(t, f.segment) as Ctx);
          holo.root.visible = !!h;
          if (h) {
            const st = staticSnapshot(scenario.real.def, { [h.node]: h.local });
            holo.update(st.snap, st.ids);
            const col = h.state === "match" ? 0x3dffa8 : h.state === "off" ? 0xff5a6a : 0x5ad8ff;
            const pulse = 0.12 + 0.1 * (0.5 + 0.5 * Math.sin(t * 5));
            holo.root.traverse((c) => {
              const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.LineBasicMaterial | undefined;
              if (!m || !("color" in m)) return;
              m.color.setHex(col);
              if ("emissive" in m) (m as THREE.MeshStandardMaterial).emissive.setHex(col).multiplyScalar(0.25);
              m.opacity = c.type === "LineSegments" ? 0.9 : pulse;
            });
          }
        }
        if (real && scenario.real) {
          const ctx = run.ctx(t, f.segment) as Ctx;
          const st = staticSnapshot(scenario.real.def, scenario.real.pose?.(ctx) ?? {});
          real.update(st.snap, st.ids);
        }
        controls.update();
        renderer.render(scene, cam);

        // ---- 2D ----
        const c = view2d.current!;
        const ctx2 = c.getContext("2d")!;
        const snap = f.snap;
        if (snap) {
          const depthOf = (id: number) => {
            const i = snap.targets.findIndex((x) => x.id === id);
            return i >= 0 ? scenario.depths?.[i] : undefined;
          };
          if (scenario.view2d === "plan") {
            ctx2.fillStyle = "#05080d";
            ctx2.fillRect(0, 0, c.width, c.height);
            drawPlan(ctx2, def, ids, snap, { frame: "sheet", follow: "tool", pxPerM: c.width / 0.22, width: c.width, height: c.height });
          } else {
            const rig = f.segment.rig;
            const k = (scenario.view2d === "phone" ? PW : CAM_W) / rig.width;
            const camScaled = { ...rig.camera, f: rig.camera.f * k, cx: rig.camera.cx * k, cy: rig.camera.cy * k };
            let source: HTMLCanvasElement = camCanvas;
            if (scenario.view2d === "phone" && phoneR) {
              // the true camera pose (what the lens sees), drawn with three.js
              const camW = compose(f.toolW, inverse(toolLocal(rig.tool)));
              phoneCam.position.set(...camW.p);
              const q = new THREE.Quaternion(camW.q[1], camW.q[2], camW.q[3], camW.q[0]);
              phoneCam.quaternion.copy(q.multiply(new THREE.Quaternion(1, 0, 0, 0)));
              phoneCam.fov = (2 * Math.atan(PH / 2 / camScaled.f) * 180) / Math.PI;
              phoneCam.updateProjectionMatrix();
              phoneR.render(scene, phoneCam);
              source = phoneR.domElement;
            } else if (t - lastCamRender > 1 / 15 || t < lastCamRender) {
              lastCamRender = t;
              const img = core.render(camScaled, [cameraPoseForTool(rig, f.toolW)], {
                width: CAM_W,
                height: CAM_H,
                ss: 1,
                codes,
                noise: 2,
                seed: 1 + Math.round(t * 30),
                bit: { tipCam: rig.tool.tipCam, axisCam: rig.tool.axisCam, length: rig.bitLength, radius: rig.bitRadius },
                occluders: f.seen ? [] : [{ cx: CAM_W * 0.55, cy: CAM_H * 0.35, r: CAM_W * 0.5 }],
              });
              camCtx.putImageData(new ImageData(new Uint8ClampedArray(img), CAM_W, CAM_H), 0, 0);
            }
            // overlay points from the engine's estimate (where the phone would draw them)
            let aim = null, mark = null;
            const camNode = snap.nodes.find((n) => n.id === ids[def.navigation.tracked]);
            if (snap.active >= 0 && camNode) {
              const tgt = snap.targets[snap.active];
              const tw = snap.nodes.find((n) => n.id === tgt.id)?.world;
              if (tw) [aim, mark] = core.projectPoints(camScaled, toPose(inverse(camNode.world)), [applyPoint(tw, [tgt.aim[0], tgt.aim[1], 0]), applyPoint(tw, [0, 0, 0])]);
            }
            const hint = model?.outOfOrder
              ? `out of order: ${model.outOfOrder.expected} first`
              : model?.xray && Number.isFinite(model.xray.materialMm) && snap.phase === "drill"
                ? model.xray.breakthrough
                  ? `x-ray: only ${model.xray.materialMm.toFixed(0)} mm of material: it breaks through`
                  : `x-ray: ${model.xray.leftMm.toFixed(0)} mm of material under the screw`
                : null;
            const hv = hudView({ def, ids, snapshot: snap, image: { aim, mark, quads: [] }, info: `${snap.markers} tags · ${f.segment.label}`, depthTargetMm: depthOf, action: scenario.action, hint });
            drawHud(ctx2, hv.state, c.width, c.height, false, { background: "camera", video: source, overlay: hv.overlay });
            const tone = toneFromHud(hv.state, hv.overlay);
            if (playingRef.current) sound.current?.play(tone);
            else sound.current?.play({ ...tone, mode: "silent" });
            toneSays = tone.says;
          }
        }
        if (t - lastPanel > 0.2 || t < lastPanel) {
          lastPanel = t;
          const ctx = run.ctx(t, f.segment) as Ctx;
          setPanel(run.panel(t));
          setProgress(t / scenario.duration);
          setSegment(scenario.segments.length > 1 ? f.segment.label : "");
          setHeadline(scenario.headline?.(ctx) ?? "");
          setSays(toneSays);
          const chs = scenario.chapters ?? [];
          let ci = -1;
          chs.forEach((ch, i) => {
            if (ch.from <= t) ci = i;
          });
          setChapter(ci);
        }
      };
      raf = requestAnimationFrame(frame);
      cleanups.push(() => cancelAnimationFrame(raf));
    })();
    return () => {
      disposed = true;
      cleanups.reverse().forEach((f) => f());
    };
  }, [scenario, hero]);

  const chapters = scenario.chapters ?? [];
  return (
    <div className={`grid gap-3 ${hero ? "lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"}`}>
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#05080d]">
        <div ref={mount} className={`w-full cursor-grab ${hero ? "h-[380px] sm:h-[560px]" : "h-[340px] sm:h-[440px]"}`} />
        {headline && (
          <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-4 pb-10 pt-4">
            <p className={`max-w-xl font-semibold leading-tight tracking-tight text-white ${hero ? "text-xl sm:text-3xl" : "text-base sm:text-lg"}`}>{headline}</p>
          </div>
        )}
        {chapters.length > 0 && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-wrap gap-1.5">
            {chapters.map((ch, i) => (
              <span
                key={`${ch.label}-${i}`}
                className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${i === chapter ? "border-[var(--green)] bg-[var(--green)]/15 text-[var(--green)]" : i < chapter ? "border-white/20 text-white/50" : "border-white/10 text-white/30"}`}
              >
                {i < chapter ? "✓ " : ""}
                {ch.label}
              </span>
            ))}
          </div>
        )}
        {!headline && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-full border border-cyan-300/30 bg-black/50 px-2.5 py-1 font-mono text-[11px] text-cyan-200">3D · scene definition (visual3d)</div>
        )}
        {segment && <div className="pointer-events-none absolute right-3 top-3 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 font-mono text-[11px] text-white/80">{segment}</div>}
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/5">
          <div className="h-full bg-[var(--green)]/70" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className={`relative overflow-hidden border border-white/10 bg-black ${hero ? "rounded-[1.6rem] p-1.5 shadow-[0_0_60px_-20px_rgba(90,216,255,0.45)]" : "rounded-2xl"}`}>
          <canvas ref={view2d} className={`block aspect-video w-full ${hero ? "rounded-[1.2rem]" : ""}`} />
          {scenario.action === "drive" && (
            <button
              onClick={() => {
                if (sound.current) {
                  sound.current.close();
                  sound.current = null;
                  setSoundOn(false);
                } else {
                  sound.current = new SoundGuide();
                  setSoundOn(true);
                }
              }}
              className={`absolute left-3 bottom-2 rounded-full border px-2 py-0.5 font-mono text-[10px] ${soundOn ? "border-[var(--green)]/60 bg-[var(--green)]/15 text-[var(--green)]" : "border-white/20 bg-black/60 text-white/70 hover:text-white"}`}
              aria-label="Sound guidance"
            >
              {soundOn ? "♪ sound on" : "♪ sound"}
              {(soundOn || scenario.sound) && says ? ` · ${says}` : ""}
            </button>
          )}
          <div className="pointer-events-none absolute bottom-2 right-3 rounded-full bg-black/60 px-2 py-0.5 font-mono text-[10px] text-white/70">
            {scenario.view2d === "plan" ? "2D plan (visual2d)" : scenario.view2d === "phone" ? "the phone: camera view + HUD (simulated)" : "phone HUD over the simulated camera"}
          </div>
        </div>
        <PanelView panel={panel} compact={hero} />
      </div>
    </div>
  );
}

function PanelView({ panel, compact }: { panel: PanelModel | null; compact?: boolean }) {
  if (!panel) return <div className="rounded-2xl border border-white/10 p-4 font-mono text-xs text-white/40">Loading the engine…</div>;
  const color = (s?: string) => (s === "ok" ? "text-[var(--green)]" : s === "warn" ? "text-[var(--amber)]" : s === "bad" ? "text-red-400" : "text-white/80");
  return (
    <div className="flex min-h-[180px] flex-col gap-3 rounded-2xl border border-white/10 p-4">
      {!compact && <p className="text-sm leading-relaxed text-white/80">{panel.caption}</p>}
      {panel.steps && (
        <ol className="space-y-1.5">
          {panel.steps.map((s) => (
            <li
              key={s.id}
              className={`rounded-lg border px-3 py-2 font-mono text-[11px] ${s.state === "active" ? "border-[var(--amber)]/60 bg-[var(--amber)]/10" : s.state === "done" ? "border-[var(--green)]/30" : "border-white/10 opacity-50"}`}
            >
              <div className="flex justify-between">
                <span className="text-white/90">
                  {s.id} · {s.title}
                </span>
                <span className={s.state === "done" ? "text-[var(--green)]" : "text-white/40"}>{s.state === "done" ? "✓ check passed" : s.state === "active" ? "now" : ""}</span>
              </div>
              {s.state === "active" && (
                <div className="mt-1 space-y-0.5 text-white/60">
                  <div>When: {s.when}</div>
                  <div>Do: {s.do}</div>
                  <div>Check: {s.check}</div>
                  <div>Because: {s.because}</div>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {panel.lines && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
          {panel.lines.map((l) => (
            <div key={l.label} className="contents">
              <dt className="text-white/40">{l.label}</dt>
              <dd className={color(l.state)}>{l.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {panel.records && panel.records.rows.length > 0 && (
        <div className="max-h-40 overflow-auto">
          <table className="w-full font-mono text-[10.5px]">
            <thead>
              <tr className="text-left text-white/40">
                {panel.records.cols.map((c) => (
                  <th key={c} className="pb-1 pr-3 font-normal">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {panel.records.rows.map((r) => (
                <tr key={r[0]} className="text-white/80">
                  {r.map((v, i) => (
                    <td key={i} className="pr-3">
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {panel.note && <p className="font-mono text-[10px] text-white/40">{panel.note}</p>}
      {panel.downloads && panel.downloads.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {panel.downloads.map((d) => (
            <button
              key={d.filename}
              onClick={() => {
                const url = URL.createObjectURL(new Blob([d.content()], { type: d.type }));
                const a = document.createElement("a");
                a.href = url;
                a.download = d.filename;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="rounded-full border border-[var(--green)]/50 px-3 py-1 font-mono text-[11px] text-[var(--green)] hover:bg-[var(--green)]/10"
            >
              ↓ {d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
