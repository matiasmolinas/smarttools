"use client";

// The phone app (/hud): only what is needed to work. A start screen (the browser needs a tap to turn on the
// camera), then the live camera with the GPS-style guide (lib/hudguide.ts). The guided setup opens by itself
// when the drill is not calibrated. One menu: Setup, Job, Tests, Sound, Full screen.
// Three loops run independently: camera frames (tracked in a worker), the engine clock (120 Hz), drawing.
// For development only, /hud?sim=1 replaces the camera with the scene simulator (no button for it).

import { useCallback, useEffect, useRef, useState } from "react";
import BenchPanel from "./BenchPanel";
import SetupWizard from "./SetupWizard";
import type { SimState } from "@/lib/sim";
import { SoundGuide, toneFromHud } from "@/lib/audio";
import type { Overlay } from "@/lib/hud";
import { drawGuide } from "@/lib/hudguide";
import { BrowserNav } from "@/lib/tracker";
import { AR } from "@/lib/aruco";
import { DICTIONARY } from "@/lib/board";
import { DEFAULT_DISTURBANCE, DEFAULT_RIG, RUN_TIME, disturb, dockRigAt, markerCodes, toolWorldFromHold, truthAt } from "@/lib/scene";
import { DEFAULT_PHONE_ID, phoneById } from "@/lib/phones";
import { BUILT_IN_PLANS, SHEET_PLAN, addHole, newPlan, removeLastHole, type Plan } from "@/lib/plan";
import { activePlanId, browserMemory, setActivePlanId } from "@/lib/memory";

type WakeLockSentinelLike = { release: () => Promise<void> };
type VideoFrameMeta = { captureTime?: number; expectedDisplayTime?: number };
type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: VideoFrameMeta) => void) => number; cancelVideoFrameCallback?: (id: number) => void };
type Status = "start" | "starting" | "running" | "blocked";

export default function HudScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackerRef = useRef<BrowserNav | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const simRef = useRef(false);
  const simCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<Status>("start");
  const statusRef = useRef<Status>("start");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soundRef = useRef<SoundGuide | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const lastCue = useRef({ phase: "", alarms: 0 });
  const [phoneName, setPhoneName] = useState(phoneById(DEFAULT_PHONE_ID).name);
  // plans and jobs
  const [draft, setDraft] = useState<Plan | null>(null);
  const [plan, setPlanState] = useState<Plan>(SHEET_PLAN);
  const [done, setDone] = useState(0);
  const [tol, setTol] = useState(0.5);
  // sheets: one at a time
  const [sheet, setSheet] = useState<null | "menu" | "setup" | "job" | "bench">(null);
  const setupDecided = useRef(false);
  const sheetRef = useRef<typeof sheet>(null);
  useEffect(() => {
    sheetRef.current = sheet;
  }, [sheet]);
  // the camera's resolution: 1080p, or 720p for slow phones (kept per device)
  const [camRes, setCamRes] = useState<720 | 1080>(1080);
  const camResRef = useRef<720 | 1080>(1080);
  // camera options to evaluate: 60 frames/s, focus and exposure locked (kept per device)
  const [camOpts, setCamOpts] = useState({ fps60: false, lock: false });
  const camOptsRef = useRef({ fps60: false, lock: false });
  const [camInfo, setCamInfo] = useState("");
  const tracker = useCallback(() => trackerRef.current, []);

  const say = useCallback((t: string) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);
  const setStatusBoth = (s: Status) => {
    statusRef.current = s;
    setStatus(s);
  };

  useEffect(() => {
    simRef.current = new URLSearchParams(window.location.search).get("sim") === "1";
    try {
      const o = { fps60: localStorage.getItem("st-cam-fps60") === "1", lock: localStorage.getItem("st-cam-lock") === "1" };
      camOptsRef.current = o;
      setCamOpts(o);
    } catch {}
    try {
      const v = Number(localStorage.getItem("st-cam-res"));
      if (v === 720 || v === 1080) {
        camResRef.current = v;
        setCamRes(v);
      }
    } catch {}
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => stopCamera, []);

  // the engine (WebAssembly) and the tracker, once
  async function ensureTracker(): Promise<BrowserNav> {
    if (trackerRef.current) return trackerRef.current;
    const tr = await BrowserNav.create();
    tr.onMessage = say;
    if (simRef.current) {
      tr.onSimImage = (img) => {
        const c = (simCanvasRef.current ??= document.createElement("canvas"));
        if (c.width !== img.width || c.height !== img.height) {
          c.width = img.width;
          c.height = img.height;
        }
        c.getContext("2d")!.putImageData(img, 0, 0);
      };
      const rig = dockRigAt(undefined, DEFAULT_RIG, tr.phone);
      tr.useCalibration(rig.camera, rig.tool, rig.width, rig.height, performance.now() / 1000);
    } else {
      setPhoneName(tr.phone.name);
      setTol(tr.tolDeg);
      const id = activePlanId();
      if (id) {
        const p = (await browserMemory().plan(id).catch(() => undefined)) ?? BUILT_IN_PLANS.find((b) => b.id === id);
        if (p) applyPlan(p, tr, false);
      }
    }
    trackerRef.current = tr;
    return tr;
  }

  async function start() {
    setStatusBoth("starting");
    try {
      if (!simRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: camResRef.current === 720 ? 1280 : 1920 },
            height: { ideal: camResRef.current },
            frameRate: { ideal: camOptsRef.current.fps60 ? 60 : 30 },
          },
          audio: false,
        });
        stopCamera();
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
        setCamInfo(await applyCameraLock(stream, camOptsRef.current.lock));
      }
      await ensureTracker();
      setStatusBoth("running");
    } catch {
      setStatusBoth("blocked");
    }
  }

  function applyPlan(p: Plan, tr = trackerRef.current, announce = true) {
    if (!tr) return;
    tr.setPlan(p);
    setPlanState(p);
    setActivePlanId(p.id === SHEET_PLAN.id ? null : p.id);
    if (announce) say(`Plan: ${p.name} · ${p.holes.length} holes`);
  }
  async function nextPlan() {
    const saved = (await browserMemory().plans().catch(() => [])).map((r) => r.value);
    const all = [...BUILT_IN_PLANS, ...saved];
    applyPlan(all[(all.findIndex((p) => p.id === plan.id) + 1) % all.length]);
  }
  function mark() {
    const tr = trackerRef.current;
    if (!tr || !draft) return;
    const m = tr.markHere();
    if (!m.ok) return say(m.reason);
    const r = addHole(draft, m);
    if (!r.ok) return say(r.reason);
    setDraft(r.plan);
    say(`${r.plan.holes[r.plan.holes.length - 1].label} marked`);
    soundRef.current?.vibrate("depth-reached");
  }
  async function savePlan() {
    if (!draft) return;
    if (!draft.holes.length) return say("Mark a hole first");
    const r = await browserMemory().savePlan(draft);
    if (!r.ok) return say(r.errors[0]);
    setDraft(null);
    applyPlan(r.plan, trackerRef.current, false);
    say(`Plan saved · ${r.plan.holes.length} holes`);
  }
  async function finishJob() {
    const tr = trackerRef.current;
    if (tr) tr.cameraOpts = { ...camOptsRef.current };
    const rec = tr?.finishJob();
    if (!rec) return say("No hole drilled yet");
    await browserMemory().saveJob(rec);
    setDone(0);
    say(`Job saved · ${rec.report.verdict}`);
  }

  // the setup opens by itself, once, when the drill is not calibrated
  useEffect(() => {
    if (status !== "running") return;
    const iv = setInterval(() => {
      const tr = trackerRef.current;
      if (setupDecided.current || !tr?.session) return;
      setupDecided.current = true;
      if (!tr.calibrated.tool) setSheet("setup");
    }, 500);
    return () => clearInterval(iv);
  }, [status]);

  useEffect(() => {
    const iv = setInterval(() => setDone(trackerRef.current?.recorder?.holes.length ?? 0), 500);
    return () => clearInterval(iv);
  }, []);

  // the loops: frames (camera rate), engine clock (120 Hz), drawing (display rate)
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
    const running = () => statusRef.current === "running";

    const v = videoRef.current as VideoWithRvfc;
    let rvfc = 0;
    let fallback: ReturnType<typeof setInterval> | null = null;
    const onVideoFrame = (t: number, meta: VideoFrameMeta) => {
      if (running() && !simRef.current) trackerRef.current?.frame(v, (meta.captureTime ?? t) / 1000);
      rvfc = v.requestVideoFrameCallback!(onVideoFrame);
    };
    if (v.requestVideoFrameCallback) rvfc = v.requestVideoFrameCallback(onVideoFrame);
    else fallback = setInterval(() => running() && !simRef.current && trackerRef.current?.frame(v, now()), 33);

    // development only (?sim=1): simulated camera frames of the scripted drilling run
    let simStart = now();
    const codes = markerCodes(new AR.Dictionary(DICTIONARY).codeList);
    const sim = setInterval(() => {
      const tr = trackerRef.current;
      if (!simRef.current || !running() || !tr) return;
      const ts = (now() - simStart) % RUN_TIME;
      if (ts < 0.07) simStart = now() - ts;
      const st = truthAt(ts);
      const rig = dockRigAt(undefined, DEFAULT_RIG, tr.phone);
      tr.simFrame(rig, codes, toolWorldFromHold(tr.core, rig, disturb(st.hold, ts, st.phase, DEFAULT_DISTURBANCE)), now(), 1 + Math.round(ts * 1000));
    }, 1000 / 15);

    const clock = setInterval(() => running() && trackerRef.current?.advance(now()), 4);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = canvas.width, h = canvas.height;
      if (w <= 0 || h <= 0 || !running()) return;
      const tr = trackerRef.current;
      const source = simRef.current ? simCanvasRef.current : v.readyState >= 2 ? v : null;
      const view = tr?.view();
      if (!tr || !source || !view) return;
      listen(view);
      // the banner hides under a sheet (setup, menu, job): it would show through it
      drawGuide(ctx, view.state, w, h, { video: source, overlay: view.overlay, toolCalibrated: tr.calibrated.tool, banner: sheetRef.current === null || sheetRef.current === "bench" });
    };
    const listen = (view: { state: SimState; overlay: Overlay }) => {
      const sg = soundRef.current;
      if (!sg) return;
      sg.play(toneFromHud(view.state, view.overlay));
      const al = view.overlay.alarms ?? 0;
      if (view.state.phase === "hold" && lastCue.current.phase !== "hold") sg.vibrate("depth-reached");
      if (al && !lastCue.current.alarms) sg.vibrate("alarm");
      lastCue.current = { phase: view.state.phase, alarms: al };
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

  // keep the screen awake while working
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
  const toggleSound = () => {
    if (soundRef.current) {
      soundRef.current.close();
      soundRef.current = null;
      setSoundOn(false);
    } else {
      soundRef.current = new SoundGuide();
      setSoundOn(true);
    }
  };
  const openBench = async () => {
    // iOS asks for permission to read the accelerometer, from a tap
    const DM = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (DM?.requestPermission) await DM.requestPermission().catch(() => "denied");
    setSheet("bench");
  };

  return (
    <div className="fixed inset-0 bg-black text-white">
      <canvas ref={canvasRef} className="block h-[100dvh] w-full touch-none" />
      <video ref={videoRef} playsInline muted className="hidden" />

      {/* start: one button (the browser needs a tap to turn the camera on) */}
      {status !== "running" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-8 text-center">
          <span className="inline-block h-10 w-10 rounded-full border-4 border-[#3ee59b] shadow-[0_0_24px_#3ee59b]" />
          <h1 className="text-3xl font-semibold">SmartTools</h1>
          <p className="max-w-sm text-lg leading-snug text-white/75">
            {status === "blocked" ? "The camera is blocked. Allow the camera for this site in the browser's settings, then try again." : "Phone on the drill, printed sheet on the work. Tap Start and point the camera at the sheet."}
          </p>
          <button onClick={start} disabled={status === "starting"} className="h-16 w-full max-w-xs rounded-2xl bg-[#3ee59b] text-2xl font-semibold text-black disabled:opacity-50">
            {status === "starting" ? "Starting…" : status === "blocked" ? "Try again" : "Start"}
          </button>
          <div className="flex gap-6 text-base text-white/55">
            <a href="/markers" className="underline decoration-white/25">
              Print the sheet
            </a>
            <a href="/memory" className="underline decoration-white/25">
              Plans & jobs
            </a>
          </div>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none absolute inset-x-0 top-[max(8rem,calc(env(safe-area-inset-top)+7rem))] z-40 flex justify-center px-4">
          <div className="rounded-2xl bg-black/75 px-5 py-2.5 text-lg font-medium text-white backdrop-blur-md">{toast}</div>
        </div>
      )}

      {status === "running" && (
        <>
          {/* planning with the tool as a pointer: big buttons under the banner */}
          {draft && (
            <div className="absolute inset-x-3 top-[max(8rem,calc(env(safe-area-inset-top)+7rem))] z-10 rounded-2xl border border-white/20 bg-black/75 p-3 backdrop-blur-md">
              <div className="text-lg font-semibold">New plan · {draft.holes.length} holes</div>
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

          {sheet === "setup" && (
            <SetupWizard
              tracker={tracker}
              onClose={() => setSheet(null)}
              onOpenBench={() => void openBench()}
              phoneName={phoneName}
              onNextPhone={() => {
                const tr = trackerRef.current;
                if (tr) setPhoneName(tr.nextPhone().name);
              }}
            />
          )}

          {sheet === "bench" && (
            <BenchPanel
              tracker={tracker}
              say={say}
              onClose={() => setSheet(null)}
              realCamera={!simRef.current}
              cameraRes={camRes}
              cameraOpts={camOpts}
              cameraInfo={camInfo}
              onCameraOpts={(o) => {
                camOptsRef.current = o;
                setCamOpts(o);
                try {
                  localStorage.setItem("st-cam-fps60", o.fps60 ? "1" : "0");
                  localStorage.setItem("st-cam-lock", o.lock ? "1" : "0");
                } catch {}
                void start();
              }}
              onCameraRes={(r) => {
                camResRef.current = r;
                setCamRes(r);
                try {
                  localStorage.setItem("st-cam-res", String(r));
                } catch {}
                void start();
              }}
            />
          )}

          {sheet === "job" && !draft && (
            <TopSheet title="Job" onClose={() => setSheet(null)}>
              <p className="text-lg text-white/75">
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
                    setSheet(null);
                  }}
                >
                  New plan with the tool
                </BigButton>
                <BigButton strong onClick={async () => (await finishJob(), setSheet(null))}>
                  Finish job and save
                </BigButton>
              </div>
            </TopSheet>
          )}

          {sheet === "menu" && (
            <TopSheet title="Menu" onClose={() => setSheet(null)}>
              <div className="grid grid-cols-2 gap-3">
                <BigButton strong onClick={() => setSheet("setup")}>
                  Setup
                </BigButton>
                <BigButton onClick={() => setSheet("job")}>
                  Job · {done}/{plan.holes.length}
                </BigButton>
                <BigButton onClick={() => void openBench()}>Tests</BigButton>
                <BigButton onClick={toggleSound}>Sound: {soundOn ? "on" : "off"}</BigButton>
                <BigButton onClick={fullscreen}>Full screen</BigButton>
                <BigButton onClick={() => (window.location.href = "/memory")}>Plans & jobs</BigButton>
              </div>
            </TopSheet>
          )}

          {/* the menu button, top right, when nothing else is open */}
          {sheet === null && (
            <button
              onClick={() => setSheet("menu")}
              aria-label="Menu"
              className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-30 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/30 bg-black/60 text-3xl backdrop-blur-md"
            >
              ☰
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Lock focus and exposure where the browser allows it (Chrome on Android; not Safari on iPhone), and say
 * what the camera actually runs at. */
async function applyCameraLock(stream: MediaStream, lock: boolean): Promise<string> {
  const track = stream.getVideoTracks()[0];
  if (!track) return "";
  type Caps = MediaTrackCapabilities & { focusMode?: string[]; exposureMode?: string[]; focusDistance?: { min: number } };
  type Sets = MediaTrackSettings & { focusMode?: string; exposureMode?: string; focusDistance?: number; exposureTime?: number };
  const caps = (track.getCapabilities?.() ?? {}) as Caps;
  let lockNote = "focus auto";
  if (lock) {
    const set = track.getSettings() as Sets;
    const adv: Record<string, unknown> = {};
    if (caps.focusMode?.includes("manual") && set.focusDistance != null) Object.assign(adv, { focusMode: "manual", focusDistance: set.focusDistance });
    else if (caps.focusMode?.includes("single-shot")) adv.focusMode = "single-shot";
    if (caps.exposureMode?.includes("manual") && set.exposureTime != null) Object.assign(adv, { exposureMode: "manual", exposureTime: set.exposureTime });
    if (Object.keys(adv).length) {
      try {
        await track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] });
        lockNote = `${adv.focusMode ? "focus locked" : "focus auto"} · ${adv.exposureMode ? "exposure locked" : "exposure auto"}`;
      } catch {
        lockNote = "lock refused by the camera";
      }
    } else lockNote = "lock not supported here";
  }
  const s = track.getSettings();
  return `${s.width}×${s.height} · ${Math.round(s.frameRate ?? 0)} fps · ${lockNote}`;
}

function TopSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute inset-x-0 top-0 z-20 rounded-b-3xl border-b border-white/15 bg-black/85 px-5 pb-5 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-md">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-2xl font-semibold">{title}</h2>
        <button onClick={onClose} className="px-3 text-3xl text-white/70" aria-label="Close">
          ✕
        </button>
      </div>
      {children}
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
