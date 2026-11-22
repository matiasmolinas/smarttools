"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import BenchPanel from "./BenchPanel";
import SetupWizard from "./SetupWizard";
import { simulate, type SimState } from "@/lib/sim";
import { SoundGuide, toneFromHud } from "@/lib/audio";
import { drawHud, type HudBackground, type Overlay } from "@/lib/hud";
import { drawGuide } from "@/lib/hudguide";
import { BrowserNav } from "@/lib/tracker";
import { AR } from "@/lib/aruco";
import { DICTIONARY } from "@/lib/board";
import { DEFAULT_DISTURBANCE, DEFAULT_RIG, RUN_TIME, disturb, dockRigAt, markerCodes, navInTarget, toolWorldFromHold, truthAt } from "@/lib/scene";
import { DEFAULT_PHONE_ID, phoneById } from "@/lib/phones";
import { toXf } from "@/lib/scenedef";
import type { Xf } from "@/lib/xform";
import { BUILT_IN_PLANS, SHEET_PLAN, addHole, newPlan, removeLastHole, type Plan } from "@/lib/plan";
import { activePlanId, browserMemory, setActivePlanId } from "@/lib/memory";

type WakeLockSentinelLike = { release: () => Promise<void> };
type VideoFrameMeta = { captureTime?: number; expectedDisplayTime?: number };
type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: VideoFrameMeta) => void) => number; cancelVideoFrameCallback?: (id: number) => void };

// "simcam": the scene simulator renders what the docked camera would see, and the real pipeline tracks it
type View = HudBackground | "simcam";
const SURFACES: View[] = ["wall", "wood", "camera", "simcam", "grid"];
const SURF_LABEL: Record<View, string> = { wall: "Wall", wood: "Wood", camera: "Cam", simcam: "Sim cam", grid: "Grid" };
const SIM_FPS = 15;

export default function HudScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const restartRef = useRef(false);
  const trackerRef = useRef<BrowserNav | null>(null);
  const simTrackerRef = useRef<BrowserNav | null>(null);
  const loadingRef = useRef(false);
  const simCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const simTruthRef = useRef<Xf | null>(null);
  const tNowRef = useRef(0);
  const [bg, setBg] = useState<View>("wall");
  const bgRef = useRef<View>("wall");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const codesRef = useRef<Uint8Array | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // sound guidance (off until the user turns it on: browsers need a tap to start audio)
  const soundRef = useRef<SoundGuide | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const lastCue = useRef({ phase: "", alarms: 0 });
  const [phoneName, setPhoneName] = useState(phoneById(DEFAULT_PHONE_ID).name);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // plans and jobs (F1: planned with the tool as a pointer, kept in the phone's memory)
  const [draft, setDraft] = useState<Plan | null>(null);
  const [plan, setPlanState] = useState<Plan>(SHEET_PLAN);
  const [done, setDone] = useState(0);
  const [benchOpen, setBenchOpen] = useState(false);
  // the guided setup (opens by itself when the drill is not calibrated yet) and the job sheet
  const [setupOpen, setSetupOpen] = useState(false);
  const [jobOpen, setJobOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tol, setTol] = useState(0.5);
  const setupDecided = useRef(false);
  // the camera's resolution: 1080p by default, 720p is lighter for slow phones (kept per device)
  const [camRes, setCamRes] = useState<720 | 1080>(1080);
  const camResRef = useRef<720 | 1080>(1080);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem("st-cam-res"));
      if (v === 720 || v === 1080) {
        camResRef.current = v;
        setCamRes(v);
      }
    } catch {}
  }, []);
  // the tracker of the view in use (camera or the simulated camera), stable for the bench panel
  const benchTracker = useCallback(() => (bgRef.current === "simcam" ? simTrackerRef.current : trackerRef.current), []);

  function say(t: string) {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }

  // initial background from ?bg= or the last choice (camera needs a tap, never auto-started)
  useEffect(() => {
    let initial: string | null = new URLSearchParams(window.location.search).get("bg");
    if (!initial) {
      try {
        initial = localStorage.getItem("hud-bg");
      } catch {}
    }
    if (initial === "wall" || initial === "wood" || initial === "grid" || initial === "simcam") {
      bgRef.current = initial;
      setBg(initial);
    }
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }
  useEffect(() => stopCamera, []);

  // the engine (WASM) loads on first use of a tracked view
  function ensureTracker(sim: boolean) {
    const ref = sim ? simTrackerRef : trackerRef;
    if (ref.current || loadingRef.current) return;
    loadingRef.current = true;
    BrowserNav.create()
      .then((tr) => {
        tr.onMessage = say;
        tr.onSimImage = (img) => {
          const c = (simCanvasRef.current ??= document.createElement("canvas"));
          if (c.width !== img.width || c.height !== img.height) {
            c.width = img.width;
            c.height = img.height;
          }
          c.getContext("2d")!.putImageData(img, 0, 0);
        };
        if (!sim) {
          setPhoneName(tr.phone.name);
          setTol(tr.tolDeg);
          const id = activePlanId();
          if (id)
            browserMemory()
              .plan(id)
              .then((p) => {
                const plan = p ?? BUILT_IN_PLANS.find((b) => b.id === id);
                if (plan) applyPlan(plan, tr, false);
              })
              .catch(() => {});
        }
        if (sim) {
          const rig = dockRigAt(undefined, DEFAULT_RIG, tr.phone);
          tr.useCalibration(rig.camera, rig.tool, rig.width, rig.height, performance.now() / 1000);
          tr.extraInfo = () => {
            const s = tr.session, snap = s?.snapshot, truth = simTruthRef.current;
            if (!s || !snap || snap.active < 0 || !truth) return "";
            const tgt = snap.targets[snap.active];
            const def = s.scene.def.nodes.find((n) => s.scene.ids[n.name] === tgt.id)!;
            const tn = navInTarget(toXf(def.local), truth);
            return ` · true ${tn.angleErrDeg.toFixed(2)}° est ${tgt.angleErrDeg.toFixed(2)}°`;
          };
        }
        ref.current = tr;
      })
      .catch(() => say("ENGINE FAILED TO LOAD"))
      .finally(() => (loadingRef.current = false));
  }

  async function choose(next: View) {
    if (next === "camera") {
      if (!navigator.mediaDevices?.getUserMedia) {
        say("NO CAMERA");
        return choose("grid");
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: camResRef.current === 720 ? 1280 : 1920 }, height: { ideal: camResRef.current } },
          audio: false,
        });
        stopCamera();
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
        ensureTracker(false);
        say("CAMERA ON");
      } catch {
        say("CAMERA BLOCKED");
        return choose("grid");
      }
    } else {
      stopCamera();
      try {
        localStorage.setItem("hud-bg", next);
      } catch {}
      say(SURF_LABEL[next].toUpperCase());
      if (next === "simcam") {
        ensureTracker(true);
        restartRef.current = true;
      }
    }
    bgRef.current = next;
    setBg(next);
  }

  function applyPlan(p: Plan, tr = trackerRef.current, announce = true) {
    if (!tr) return;
    tr.setPlan(p);
    setPlanState(p);
    setActivePlanId(p.id === SHEET_PLAN.id ? null : p.id);
    if (announce) say(`PLAN · ${p.name.toUpperCase()} · ${p.holes.length} HOLES`);
  }
  async function nextPlan() {
    const tr = trackerRef.current;
    if (!tr) return say("ENGINE LOADING");
    const saved = (await browserMemory().plans().catch(() => [])).map((r) => r.value);
    const all = [...BUILT_IN_PLANS, ...saved];
    const i = all.findIndex((p) => p.id === plan.id);
    applyPlan(all[(i + 1) % all.length]);
  }
  function mark() {
    const tr = trackerRef.current;
    if (!tr || !draft) return;
    const m = tr.markHere();
    if (!m.ok) return say(m.reason.toUpperCase());
    const r = addHole(draft, m);
    if (!r.ok) return say(r.reason.toUpperCase());
    setDraft(r.plan);
    const h = r.plan.holes[r.plan.holes.length - 1];
    say(`${h.label} · ${h.x.toFixed(1)}, ${h.y.toFixed(1)} MM`);
    soundRef.current?.vibrate("depth-reached");
  }
  async function savePlan() {
    if (!draft) return;
    if (!draft.holes.length) return say("MARK A HOLE FIRST");
    const r = await browserMemory().savePlan(draft);
    if (!r.ok) return say(r.errors[0].toUpperCase());
    setDraft(null);
    applyPlan(r.plan, trackerRef.current, false);
    say(`PLAN SAVED · ${r.plan.holes.length} HOLES`);
  }
  async function finishJob() {
    const tr = trackerRef.current;
    if (!tr) return say("ENGINE LOADING");
    const rec = tr.finishJob();
    if (!rec) return say("NO HOLE DRILLED YET");
    await browserMemory().saveJob(rec);
    setDone(0);
    say(`JOB SAVED · ${rec.report.verdict.toUpperCase()}`);
  }
  // open the guided setup once, when the camera is on and the drill is not calibrated
  useEffect(() => {
    if (bg !== "camera") return;
    const iv = setInterval(() => {
      const tr = trackerRef.current;
      if (setupDecided.current || !tr?.session) return;
      setupDecided.current = true;
      if (!tr.calibrated.tool) setSetupOpen(true);
    }, 500);
    return () => clearInterval(iv);
  }, [bg]);

  // holes done in this job, for the bar
  useEffect(() => {
    const iv = setInterval(() => setDone(trackerRef.current?.recorder?.holes.length ?? 0), 500);
    return () => clearInterval(iv);
  }, []);

  const cycleSurface = () => choose(SURFACES[(SURFACES.indexOf(bg) + 1) % SURFACES.length]);

  // three independent loops: frames (camera rate), engine clock (120 Hz), render (display rate)
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    const now = () => performance.now() / 1000;
    let simStart = now();

    // 1a. camera frames, with their capture time when the browser provides it
    const v = videoRef.current as VideoWithRvfc;
    let rvfc = 0;
    let fallback: ReturnType<typeof setInterval> | null = null;
    const onVideoFrame = (t: number, meta: VideoFrameMeta) => {
      if (bgRef.current === "camera") trackerRef.current?.frame(v, (meta.captureTime ?? t) / 1000);
      rvfc = v.requestVideoFrameCallback!(onVideoFrame);
    };
    if (v.requestVideoFrameCallback) rvfc = v.requestVideoFrameCallback(onVideoFrame);
    else fallback = setInterval(() => bgRef.current === "camera" && trackerRef.current?.frame(v, now()), 33);

    // 1b. simulated camera frames
    const sim = setInterval(() => {
      if (bgRef.current !== "simcam") return;
      ensureTracker(true);
      const tr = simTrackerRef.current;
      if (!tr) return;
      if (restartRef.current) {
        restartRef.current = false;
        simStart = now();
        tr.cancelCalibration();
      }
      const ts = (now() - simStart) % RUN_TIME;
      const st = truthAt(ts);
      const rig = dockRigAt(undefined, DEFAULT_RIG, tr.phone);
      const truth = toolWorldFromHold(tr.core, rig, disturb(st.hold, ts, st.phase, DEFAULT_DISTURBANCE));
      simTruthRef.current = truth;
      const codes = (codesRef.current ??= markerCodes(new AR.Dictionary(DICTIONARY).codeList));
      // the worker renders the camera view and tracks it; the image comes back for display
      tr.simFrame(rig, codes, truth, now(), 1 + Math.round(ts * 1000));
    }, 1000 / SIM_FPS);

    // 2. the engine clock: ticks at 120 Hz regardless of rendering
    const clock = setInterval(() => {
      const t = now();
      tNowRef.current = t;
      if (bgRef.current === "camera") trackerRef.current?.advance(t);
      if (bgRef.current === "simcam") simTrackerRef.current?.advance(t);
    }, 4);

    // 3. render: the latest snapshot, as often as the display allows
    let raf = 0;
    let last = performance.now();
    let tSim = 0;
    const draw = (frameNow: number) => {
      raf = requestAnimationFrame(draw);
      tSim += Math.min((frameNow - last) / 1000, 0.05);
      last = frameNow;
      const w = canvas.width;
      const h = canvas.height;
      if (w <= 0 || h <= 0) return;
      const listen = (view: { state: SimState; overlay: Overlay }) => {
        const sg = soundRef.current;
        if (!sg) return;
        sg.play(toneFromHud(view.state, view.overlay));
        // vibrate when a screw seats or an alarm starts
        const al = view.overlay.alarms ?? 0;
        if (view.state.phase === "hold" && lastCue.current.phase !== "hold") sg.vibrate("depth-reached");
        if (al && !lastCue.current.alarms) sg.vibrate("alarm");
        lastCue.current = { phase: view.state.phase, alarms: al };
      };
      if (bgRef.current === "camera" && v.readyState >= 2) {
        const view = trackerRef.current?.view();
        if (view) {
          listen(view);
          return drawGuide(ctx, view.state, w, h, { video: v, overlay: view.overlay, toolCalibrated: trackerRef.current?.calibrated.tool ?? false });
        }
      }
      if (bgRef.current === "simcam" && simCanvasRef.current) {
        const view = simTrackerRef.current?.view();
        if (view) {
          listen(view);
          return drawGuide(ctx, view.state, w, h, { video: simCanvasRef.current, overlay: view.overlay, toolCalibrated: simTrackerRef.current?.calibrated.tool ?? false });
        }
      }
      if (bgRef.current !== "simcam" && restartRef.current) {
        restartRef.current = false;
        tSim = 0;
      }
      const bgNow = bgRef.current === "simcam" ? "grid" : bgRef.current;
      drawHud(ctx, simulate(tSim), w, h, false, { background: bgNow, video: v });
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(clock);
      clearInterval(sim);
      if (fallback) clearInterval(fallback);
      if (rvfc) v.cancelVideoFrameCallback?.(rvfc);
      ro.disconnect();
    };
  }, []);

  // keep the screen awake during a demo
  useEffect(() => {
    let lock: WakeLockSentinelLike | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinelLike> } };
    const req = () => nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    req();
    const onVis = () => document.visibilityState === "visible" && req();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
    };
  }, []);

  const fullscreen = () => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else el.webkitRequestFullscreen?.();
  };

  return (
    <div className="fixed inset-0 bg-black text-white">
      <canvas ref={canvasRef} className="block h-[100dvh] w-full touch-none" />
      <video ref={videoRef} playsInline muted className="hidden" />
      {toast && (
        <div className="pointer-events-none absolute inset-x-0 top-[max(1rem,env(safe-area-inset-top))] flex justify-center px-4">
          <div className="rounded-full bg-black/60 px-4 py-1.5 font-mono text-xs tracking-wide text-white/90 backdrop-blur-md">
            {toast}
          </div>
        </div>
      )}

      {benchOpen && (bg === "camera" || bg === "simcam") && <BenchPanel
          tracker={benchTracker}
          say={say}
          onClose={() => setBenchOpen(false)}
          realCamera={bg === "camera"}
          cameraRes={camRes}
          onCameraRes={(r) => {
            camResRef.current = r;
            setCamRes(r);
            try {
              localStorage.setItem("st-cam-res", String(r));
            } catch {}
            void choose("camera");
          }}
        />}

      {/* planning with the tool as a pointer: big buttons at the top while a plan is being drawn */}
      {bg === "camera" && draft && (
        <div className="absolute inset-x-3 top-[max(8rem,calc(env(safe-area-inset-top)+7rem))] z-10 rounded-2xl border border-white/20 bg-black/75 p-3 text-white backdrop-blur-md">
          <div className="text-lg font-semibold">Planning · {draft.holes.length} holes</div>
          <div className="text-base text-white/70">Touch the surface with the tip, then tap Mark hole.</div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <BigButton onClick={mark} strong>
              Mark hole
            </BigButton>
            <BigButton onClick={savePlan}>Save plan</BigButton>
            <BigButton onClick={() => draft.holes.length && setDraft(removeLastHole(draft))}>Undo</BigButton>
            <BigButton onClick={() => setDraft(null)}>Cancel</BigButton>
          </div>
        </div>
      )}

      {/* the job: which plan, a new plan, finish (a sheet, so nothing covers the tip while drilling) */}
      {bg === "camera" && jobOpen && !draft && (
        <div className="absolute inset-x-0 top-0 z-20 rounded-b-3xl border-b border-white/15 bg-black/80 px-5 pb-5 pt-[max(1rem,env(safe-area-inset-top))] text-white backdrop-blur-md">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-semibold">Job</h2>
            <button onClick={() => setJobOpen(false)} className="px-3 text-2xl text-white/60" aria-label="Close">
              ✕
            </button>
          </div>
          <p className="mt-1 text-lg text-white/70">
            Plan: <b className="text-white">{plan.name}</b> · {done} of {plan.holes.length} holes done
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <BigButton onClick={nextPlan}>Change plan</BigButton>
            <BigButton
              onClick={() => {
                const tr = trackerRef.current;
                if (!tr) return;
                const next = tr.tolDeg === 0.5 ? 2 : 0.5;
                tr.setTolerance(next);
                setTol(next);
              }}
            >
              Precision: ±{tol}° {tol === 0.5 ? "(spec)" : "(practice)"}
            </BigButton>
            <BigButton
              onClick={() => {
                setDraft(newPlan(`Plan ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`));
                setJobOpen(false);
              }}
            >
              New plan with the tool
            </BigButton>
            <BigButton
              strong
              onClick={async () => {
                await finishJob();
                setJobOpen(false);
              }}
            >
              Finish job and save
            </BigButton>
            <a href="/memory" className="text-center text-base text-white/60 underline decoration-white/25">
              See saved plans and jobs
            </a>
          </div>
        </div>
      )}

      {setupOpen && (bg === "camera" || bg === "simcam") && (
        <SetupWizard
          tracker={benchTracker}
          onClose={() => setSetupOpen(false)}
          onOpenBench={() => setBenchOpen(true)}
          phoneName={phoneName}
          onNextPhone={() => {
            const tr = trackerRef.current;
            if (!tr) return;
            const p = tr.nextPhone();
            setPhoneName(p.name);
          }}
        />
      )}

      {/* one menu button, top right (the screen stays clear: the tip works at the bottom) */}
      {!setupOpen && (
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Menu"
          className={`absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-30 flex h-16 w-16 items-center justify-center rounded-2xl border text-3xl backdrop-blur-md ${menuOpen ? "border-[#3ee59b] bg-[#3ee59b] text-black" : "border-white/30 bg-black/60 text-white"}`}
        >
          {menuOpen ? "✕" : "☰"}
        </button>
      )}
      {menuOpen && !setupOpen && (
        <div className="absolute inset-x-0 top-0 z-20 rounded-b-3xl border-b border-white/15 bg-black/80 px-4 pb-4 pt-[max(5.5rem,calc(env(safe-area-inset-top)+5rem))] text-white backdrop-blur-md">
          <div className="grid grid-cols-2 gap-3">
            {(bg === "camera" || bg === "simcam") && (
              <BigButton strong onClick={() => (setMenuOpen(false), setJobOpen(false), setBenchOpen(false), setSetupOpen(true))}>
                Setup
              </BigButton>
            )}
            {bg === "camera" && <BigButton onClick={() => (setMenuOpen(false), setSetupOpen(false), setJobOpen(true))}>Job · {done}/{plan.holes.length}</BigButton>}
            {(bg === "camera" || bg === "simcam") && (
              <BigButton
                onClick={async () => {
                  // iOS asks for permission to read the accelerometer, from a tap
                  const DM = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
                  if (!benchOpen && DM?.requestPermission) await DM.requestPermission().catch(() => "denied");
                  setMenuOpen(false);
                  setBenchOpen(!benchOpen);
                }}
              >
                {benchOpen ? "Close tests" : "Tests (Bench)"}
              </BigButton>
            )}
            <BigButton
              onClick={() => {
                if (soundRef.current) {
                  soundRef.current.close();
                  soundRef.current = null;
                  setSoundOn(false);
                } else {
                  soundRef.current = new SoundGuide();
                  setSoundOn(true);
                }
              }}
            >
              Sound: {soundOn ? "on" : "off"}
            </BigButton>
            <BigButton onClick={cycleSurface}>View: {SURF_LABEL[bg]}</BigButton>
            {bg !== "camera" && (
              <BigButton
                onClick={() => {
                  restartRef.current = true;
                  setMenuOpen(false);
                }}
              >
                Restart demo
              </BigButton>
            )}
            <BigButton onClick={fullscreen}>Full screen</BigButton>
          </div>
          <div className="mt-4 flex justify-around text-lg text-white/70">
            <a href="/memory" className="underline decoration-white/25">
              Plans & jobs
            </a>
            <a href="/markers" className="underline decoration-white/25">
              Print the sheet
            </a>
            <a href="/" className="underline decoration-white/25">
              Website
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function BigButton({ children, onClick, strong }: { children: React.ReactNode; onClick: () => void; strong?: boolean }) {
  return (
    <button onClick={onClick} className={`h-14 rounded-2xl px-4 text-lg font-semibold active:scale-[0.99] ${strong ? "bg-[#3ee59b] text-black" : "border border-white/25 text-white"}`}>
      {children}
    </button>
  );
}







