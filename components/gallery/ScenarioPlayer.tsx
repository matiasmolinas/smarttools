"use client";

// Plays one gallery scenario: the real engine (WASM) on scripted motion, drawn in 3D (three.js, the
// scene's visual3d), in 2D (the phone HUD over the simulated camera image, or a plan from visual2d)
// and as a side panel. Everything is drawn from the engine's snapshots.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AR } from "@/lib/aruco";
import { DICTIONARY } from "@/lib/board";
import { NavCore } from "@/lib/engine";
import { cameraPoseForTool, markerCodes } from "@/lib/scene";
import { Scene3D } from "@/lib/render/render3d";
import { drawPlan } from "@/lib/render/render2d";
import { hudView } from "@/lib/render/hudview";
import { drawHud } from "@/lib/hud";
import { applyPoint, inverse, toPose } from "@/lib/xform";
import { ScenarioRun } from "@/lib/gallery/runner";
import type { PanelModel, Scenario } from "@/lib/gallery/scenarios";

const CAM_W = 480;
const CAM_H = 270;
let corePromise: Promise<NavCore> | null = null;

export default function ScenarioPlayer({ scenario, playing, onEnd }: { scenario: Scenario; playing: boolean; onEnd: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const view2d = useRef<HTMLCanvasElement>(null);
  const [panel, setPanel] = useState<PanelModel | null>(null);
  const [progress, setProgress] = useState(0);
  const [segment, setSegment] = useState("");
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

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
      scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x101820, 1.4));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(0.4, 0.6, 0.8);
      scene.add(sun);
      const grid = new THREE.GridHelper(0.8, 40, 0x1d3a4a, 0x0f1d26);
      grid.rotation.x = Math.PI / 2;
      grid.position.z = -0.001;
      scene.add(grid);
      const cam = new THREE.PerspectiveCamera(40, 1, 0.01, 10);
      const v = scenario.view3d ?? { pos: [0.42, 0.14, 0.5], target: [0, 0, 0.1] };
      cam.position.set(...v.pos);
      const controls = new OrbitControls(cam, renderer.domElement);
      controls.target.set(...v.target);
      controls.enableZoom = false;
      let s3: Scene3D | null = null;
      let s3Version = -1;
      const resize = () => {
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
        renderer.dispose();
        el.removeChild(renderer.domElement);
      });

      // ---- the simulated phone camera (for the HUD) ----
      const camCanvas = document.createElement("canvas");
      camCanvas.width = CAM_W;
      camCanvas.height = CAM_H;
      const camCtx = camCanvas.getContext("2d")!;
      let lastCamRender = -1;

      let t = 0;
      let last = performance.now();
      let lastPanel = -1;
      let raf = 0;
      const frame = (now: number) => {
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
          s3 = new Scene3D(def, { markerCodes: codes });
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
        controls.update();
        renderer.render(scene, cam);

        // ---- 2D ----
        const c = view2d.current!;
        const ctx = c.getContext("2d")!;
        if (f.snap) {
          if (scenario.view2d === "plan") {
            ctx.fillStyle = "#05080d";
            ctx.fillRect(0, 0, c.width, c.height);
            drawPlan(ctx, def, ids, f.snap, { frame: "sheet", follow: "tool", pxPerM: c.width / 0.22, width: c.width, height: c.height });
          } else {
            const rig = f.segment.rig;
            const k = CAM_W / rig.width;
            const camScaled = { ...rig.camera, f: rig.camera.f * k, cx: rig.camera.cx * k, cy: rig.camera.cy * k };
            if (t - lastCamRender > 1 / 15 || t < lastCamRender) {
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
            const snap = f.snap;
            let aim = null, mark = null;
            const camNode = snap.nodes.find((n) => n.id === ids[def.navigation.tracked]);
            if (snap.active >= 0 && camNode) {
              const tgt = snap.targets[snap.active];
              const tw = snap.nodes.find((n) => n.id === tgt.id)?.world;
              if (tw) [aim, mark] = core.projectPoints(camScaled, toPose(inverse(camNode.world)), [applyPoint(tw, [tgt.aim[0], tgt.aim[1], 0]), applyPoint(tw, [0, 0, 0])]);
            }
            const hv = hudView({ def, ids, snapshot: snap, image: { aim, mark, quads: [] }, info: `${snap.markers} tags · ${f.segment.label}` });
            drawHud(ctx, hv.state, c.width, c.height, false, { background: "camera", video: camCanvas, overlay: hv.overlay });
          }
        }
        if (t - lastPanel > 0.2 || t < lastPanel) {
          lastPanel = t;
          setPanel(run.panel(t));
          setProgress(t / scenario.duration);
          setSegment(scenario.segments.length > 1 ? f.segment.label : "");
        }
      };
      raf = requestAnimationFrame(frame);
      cleanups.push(() => cancelAnimationFrame(raf));
    })();
    return () => {
      disposed = true;
      cleanups.reverse().forEach((f) => f());
    };
  }, [scenario]);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#05080d]">
        <div ref={mount} className="h-[340px] w-full cursor-grab sm:h-[440px]" />
        <div className="pointer-events-none absolute left-3 top-3 rounded-full border border-cyan-300/30 bg-black/50 px-2.5 py-1 font-mono text-[11px] text-cyan-200">
          3D · scene definition (visual3d)
        </div>
        {segment && (
          <div className="pointer-events-none absolute right-3 top-3 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 font-mono text-[11px] text-white/80">{segment}</div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/5">
          <div className="h-full bg-[var(--green)]/70" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black">
          <canvas ref={view2d} className="block aspect-video w-full" />
          <div className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 font-mono text-[10px] text-white/70">
            {scenario.view2d === "plan" ? "2D plan (visual2d)" : "phone HUD over the simulated camera"}
          </div>
        </div>
        <PanelView panel={panel} />
      </div>
    </div>
  );
}

function PanelView({ panel }: { panel: PanelModel | null }) {
  if (!panel) return <div className="rounded-2xl border border-white/10 p-4 font-mono text-xs text-white/40">Loading the engine…</div>;
  const color = (s?: string) => (s === "ok" ? "text-[var(--green)]" : s === "warn" ? "text-[var(--amber)]" : s === "bad" ? "text-red-400" : "text-white/80");
  return (
    <div className="flex min-h-[180px] flex-col gap-3 rounded-2xl border border-white/10 p-4">
      <p className="text-sm leading-relaxed text-white/80">{panel.caption}</p>
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
        <div className="overflow-x-auto">
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
    </div>
  );
}
