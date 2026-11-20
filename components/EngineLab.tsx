"use client";

// Engine lab: one navigation session (Rust engine, 120 Hz) fed by the scene simulator, drawn three
// ways from the same snapshots: a 3D scene (STL meshes and primitives), a 2D plan (simplified
// symbols) and the phone HUD. Each renderer can be slowed down or switched off: the engine keeps its
// clock either way (docs/ENGINE_SPEC.md).

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AR } from "@/lib/aruco";
import { DICTIONARY } from "@/lib/board";
import { gateReasonNames, type EngineSnapshot } from "@/lib/engine";
import { gateMessage } from "@/lib/session";
import { BrowserNav } from "@/lib/tracker";
import { DEFAULT_DISTURBANCE, DEFAULT_RIG, RUN_TIME, disturb, markerCodes, navInTarget, toolWorldFromHold, truthAt } from "@/lib/scene";
import { toXf } from "@/lib/scenedef";
import { Scene3D } from "@/lib/render/render3d";
import { drawPlan } from "@/lib/render/render2d";
import { hudView } from "@/lib/render/hudview";
import { drawHud } from "@/lib/hud";

const RATES = [0, 60, 30, 10, 2] as const; // 0 = every display frame
type Rate = (typeof RATES)[number] | -1; // -1 = off

interface Stats {
  engineHz: number;
  ticks: number;
  overruns: number;
  latencyMs: number;
  trackerFps: number;
  fps3d: number;
  fps2d: number;
  fpsHud: number;
  phase: string;
  target: string;
  gate: string;
  ready: boolean;
  est: string;
  truth: string;
  markers: number;
}

export default function EngineLab() {
  const mount3d = useRef<HTMLDivElement>(null);
  const plan = useRef<HTMLCanvasElement>(null);
  const hud = useRef<HTMLCanvasElement>(null);
  const [rate3d, setRate3d] = useState<Rate>(0);
  const [rate2d, setRate2d] = useState<Rate>(30);
  const [rateHud, setRateHud] = useState<Rate>(30);
  const [camFps, setCamFps] = useState(15);
  const [latencyMs, setLatencyMs] = useState(50);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cfg = useRef({ rate3d, rate2d, rateHud, camFps, latencyMs });
  cfg.current = { rate3d, rate2d, rateHud, camFps, latencyMs };

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    (async () => {
      const nav = await BrowserNav.create();
      if (disposed) return;
      const core = nav.core;
      const rig = DEFAULT_RIG;
      const now = () => performance.now() / 1000;
      nav.useCalibration(rig.camera, rig.tool, rig.width, rig.height, now());
      const session = nav.session!;
      const def = session.scene.def;
      cleanups.push(() => nav.forgetCalibrationSilently());
      const codes = markerCodes(new AR.Dictionary(DICTIONARY).codeList);
      const ids = session.scene.ids;

      // ---- the simulated camera: a frame every 1/camFps, captured `latency` ago, tracked in the worker ----
      const simStart = now();
      const simCanvas = document.createElement("canvas");
      simCanvas.width = rig.width;
      simCanvas.height = rig.height;
      nav.onSimImage = (img) => simCanvas.getContext("2d")!.putImageData(img, 0, 0);
      let nextFrame = now();
      let seed = 1;
      const camLoop = setInterval(() => {
        const t = now();
        if (t < nextFrame) return;
        nextFrame = t + 1 / cfg.current.camFps;
        const tc = t - cfg.current.latencyMs / 1000;
        const ts = (tc - simStart + RUN_TIME * 10) % RUN_TIME;
        const st = truthAt(ts);
        nav.simFrame(rig, codes, toolWorldFromHold(core, rig, disturb(st.hold, ts, st.phase, DEFAULT_DISTURBANCE)), tc, seed++);
      }, 5);
      cleanups.push(() => clearInterval(camLoop));
      const frames = () => nav.frames;

      // ---- the engine clock ----
      let ticks = 0;
      const clock = setInterval(() => (ticks += nav.advance(now())), 4);
      cleanups.push(() => clearInterval(clock));

      // ---- 3D ----
      const el = mount3d.current!;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      el.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05080d);
      scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x101820, 1.4));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(0.4, 0.6, 0.8);
      scene.add(sun);
      const grid = new THREE.GridHelper(0.6, 30, 0x1d3a4a, 0x0f1d26);
      grid.rotation.x = Math.PI / 2;
      grid.position.z = -0.001;
      scene.add(grid);
      const s3 = new Scene3D(def, { markerCodes: codes });
      scene.add(s3.root);
      s3.ready.catch(() => setError("a mesh failed to load"));
      // the sheet is a wall: world Y up, Z out of the wall
      const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10);
      camera.position.set(0.42, 0.12, 0.5);
      camera.up.set(0, 1, 0);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 0, 0.1);
      const resize = () => {
        const w = el.clientWidth, h = el.clientHeight;
        renderer.setSize(w, h, false);
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        for (const c of [plan.current!, hud.current!]) {
          const d = Math.min(window.devicePixelRatio, 2);
          c.width = Math.round(c.clientWidth * d);
          c.height = Math.round(c.clientHeight * d);
        }
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();
      cleanups.push(() => {
        ro.disconnect();
        controls.dispose();
        s3.dispose();
        renderer.dispose();
        el.removeChild(renderer.domElement);
      });

      // ---- render loop: each renderer at its own rate, from the latest snapshot ----
      const last = { r3: 0, r2: 0, rh: 0, stats: 0 };
      const count = { r3: 0, r2: 0, rh: 0, ticks0: 0, frames0: 0, t0: now() };
      const due = (rate: Rate, key: "r3" | "r2" | "rh", t: number) => {
        if (rate === -1) return false;
        if (rate === 0 || t - last[key] >= 1 / rate - 1e-3) {
          last[key] = t;
          count[key]++;
          return true;
        }
        return false;
      };
      let raf = 0;
      const draw = () => {
        raf = requestAnimationFrame(draw);
        const snap: EngineSnapshot | null = session.snapshot;
        if (!snap) return;
        const t = now();
        if (due(cfg.current.rate3d, "r3", t)) {
          s3.update(snap, ids);
          controls.update();
          renderer.render(scene, camera);
        }
        if (due(cfg.current.rate2d, "r2", t)) {
          const c = plan.current!, ctx = c.getContext("2d")!;
          ctx.fillStyle = "#05080d";
          ctx.fillRect(0, 0, c.width, c.height);
          drawPlan(ctx, def, ids, snap, { frame: "sheet", follow: "tool", pxPerM: c.width / 0.16, width: c.width, height: c.height });
        }
        if (due(cfg.current.rateHud, "rh", t)) {
          const c = hud.current!, ctx = c.getContext("2d")!;
          const pts = session.overlayPoints(snap);
          const v = hudView({ def, ids, snapshot: snap, image: { aim: pts.aim, mark: pts.mark, quads: session.lastFrame?.quads ?? [] }, info: `${snap.markers} tags · sim` });
          drawHud(ctx, v.state, c.width, c.height, false, { background: "camera", video: simCanvas, overlay: v.overlay });
        }
        if (t - last.stats > 0.25) {
          const dt = t - count.t0;
          const act = snap.active >= 0 ? snap.targets[snap.active] : null;
          const actName = act ? session.name(act.id) : "–";
          let truthText = "–";
          if (act) {
            // the truth at the snapshot's time (the engine predicts to now)
            const ts = (snap.t - simStart + RUN_TIME * 10) % RUN_TIME;
            const st = truthAt(ts);
            const truthNow = toolWorldFromHold(core, rig, disturb(st.hold, ts, st.phase, DEFAULT_DISTURBANCE));
            const node = def.nodes.find((n) => n.name === actName)!;
            const tn = navInTarget(toXf(node.local), truthNow);
            truthText = `${tn.angleErrDeg.toFixed(2)}° · ${tn.offsetMm.toFixed(2)} mm · ${tn.depthMm > 0 ? `${tn.depthMm.toFixed(1)} mm deep` : `${tn.gapMm.toFixed(1)} mm gap`}`;
          }
          setStats({
            engineHz: (snap.stats.ticks - count.ticks0) / dt,
            ticks: snap.stats.ticks,
            overruns: snap.stats.overruns,
            latencyMs: snap.stats.latencyS * 1000,
            trackerFps: (frames() - count.frames0) / dt,
            fps3d: count.r3 / dt,
            fps2d: count.r2 / dt,
            fpsHud: count.rh / dt,
            phase: snap.phase,
            target: actName,
            gate: snap.gate ? `${gateMessage(snap.gate)} (${gateReasonNames(snap.gate).join(", ")})` : "open",
            ready: snap.ready,
            est: act ? `${act.angleErrDeg.toFixed(2)}° · ${act.offsetMm.toFixed(2)} mm · ${act.depthMm > 0 ? `${act.depthMm.toFixed(1)} mm deep` : `${act.gapMm.toFixed(1)} mm gap`}` : "–",
            truth: truthText,
            markers: snap.markers,
          });
          last.stats = t;
          Object.assign(count, { r3: 0, r2: 0, rh: 0, ticks0: snap.stats.ticks, frames0: frames(), t0: t });
        }
      };
      raf = requestAnimationFrame(draw);
      cleanups.push(() => cancelAnimationFrame(raf));
    })().catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      cleanups.reverse().forEach((f) => f());
    };
  }, []);

  return (
    <div className="flex min-h-[100dvh] flex-col gap-4 bg-[#05080d] p-4 text-white">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Engine lab</h1>
          <p className="font-mono text-xs text-white/50">
            One engine (Rust/WASM, 120 Hz) fed by the scene simulator. Three renderers read its snapshots at their own pace, or not at all.
          </p>
        </div>
        <span className="flex gap-4 font-mono text-xs text-white/50">
          <a href="/developers" className="hover:text-white">
            ← SmartTools for developers
          </a>
          <a href="/hud" className="hover:text-white">
            the phone app →
          </a>
        </span>
      </header>
      {error && <p className="font-mono text-sm text-red-400">{error}</p>}
      <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Panel title="3D scene · visual3d (STL dock, primitives)" rate={rate3d} setRate={setRate3d} fps={stats?.fps3d}>
          <div ref={mount3d} className="h-[46vh] w-full lg:h-full lg:min-h-[480px]" />
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel title="2D plan · visual2d (sheet frame, following the tool)" rate={rate2d} setRate={setRate2d} fps={stats?.fps2d}>
            <canvas ref={plan} className="block aspect-square w-full" />
          </Panel>
          <Panel title="Phone HUD · simulated camera" rate={rateHud} setRate={setRateHud} fps={stats?.fpsHud}>
            <canvas ref={hud} className="block aspect-video w-full" />
          </Panel>
        </div>
      </div>
      <section className="grid gap-3 font-mono text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Stat k="engine" v={stats ? `${stats.engineHz.toFixed(0)} Hz · ${stats.ticks} ticks · ${stats.overruns} overruns` : "loading…"} />
        <Stat k="tracker (worker)" v={stats ? `${stats.trackerFps.toFixed(1)} fps · ${stats.markers} markers · age at ingest ${stats.latencyMs.toFixed(0)} ms` : "–"} />
        <Stat k="phase · target" v={stats ? `${stats.phase} · ${stats.target}` : "–"} />
        <Stat k="gate" v={stats ? (stats.ready ? "READY" : stats.gate) : "–"} good={stats?.ready} />
        <Stat k="estimated (engine)" v={stats?.est ?? "–"} />
        <Stat k="truth (simulator)" v={stats?.truth ?? "–"} />
        <label className="flex items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-2">
          <span className="text-white/50">camera fps</span>
          <select className="bg-transparent" value={camFps} onChange={(e) => setCamFps(Number(e.target.value))}>
            {[30, 15, 10, 5].map((v) => (
              <option key={v} value={v} className="bg-black">
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-2">
          <span className="text-white/50">camera latency</span>
          <select className="bg-transparent" value={latencyMs} onChange={(e) => setLatencyMs(Number(e.target.value))}>
            {[0, 50, 100, 200].map((v) => (
              <option key={v} value={v} className="bg-black">
                {v} ms
              </option>
            ))}
          </select>
        </label>
      </section>
    </div>
  );
}

function Panel({ title, rate, setRate, fps, children }: { title: string; rate: Rate; setRate: (r: Rate) => void; fps?: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-white/10">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5 font-mono text-[11px] text-white/60">
        <span>{title}</span>
        <span className="flex items-center gap-2">
          <span className="text-white/40">{rate === -1 ? "off" : `${(fps ?? 0).toFixed(0)} fps`}</span>
          <select className="bg-transparent" value={rate} onChange={(e) => setRate(Number(e.target.value) as Rate)}>
            {[...RATES, -1].map((r) => (
              <option key={r} value={r} className="bg-black">
                {r === -1 ? "off" : r === 0 ? "max" : `${r} Hz`}
              </option>
            ))}
          </select>
        </span>
      </div>
      {children}
    </section>
  );
}

function Stat({ k, v, good }: { k: string; v: string; good?: boolean }) {
  return (
    <div className="rounded-lg border border-white/10 px-3 py-2">
      <div className="text-white/40">{k}</div>
      <div className={good ? "text-[#3dffa8]" : "text-white/85"}>{v}</div>
    </div>
  );
}
