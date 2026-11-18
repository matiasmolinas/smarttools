"use client";

import { useEffect, useRef, useState } from "react";
import { simulate } from "@/lib/sim";
import { drawHud, type HudBackground } from "@/lib/hud";
import { OpticalTracker } from "@/lib/tracker";

type WakeLockSentinelLike = { release: () => Promise<void> };

const SURFACES: HudBackground[] = ["wall", "wood", "camera", "grid"];
const SURF_LABEL: Record<HudBackground, string> = { wall: "Wall", wood: "Wood", camera: "Cam", grid: "Grid" };

export default function HudScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const restartRef = useRef(false);
  const trackerRef = useRef<OpticalTracker | null>(null);
  const [bg, setBg] = useState<HudBackground>("wall");
  const bgRef = useRef<HudBackground>("wall");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (initial === "wall" || initial === "wood" || initial === "grid") {
      bgRef.current = initial;
      setBg(initial);
    }
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }
  useEffect(() => stopCamera, []);

  async function choose(next: HudBackground) {
    if (next === "camera") {
      if (!navigator.mediaDevices?.getUserMedia) {
        say("NO CAMERA");
        return choose("grid");
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        stopCamera();
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
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
    }
    bgRef.current = next;
    setBg(next);
  }

  const cycleSurface = () => choose(SURFACES[(SURFACES.indexOf(bg) + 1) % SURFACES.length]);

  // render loop
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
    let raf = 0;
    let last = performance.now();
    let t = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      t += Math.min((now - last) / 1000, 0.05);
      last = now;
      if (restartRef.current) {
        restartRef.current = false;
        t = 0;
      }
      const w = canvas.width;
      const h = canvas.height;
      if (w <= 0 || h <= 0) return;
      const v = videoRef.current;
      if (bgRef.current === "camera" && v && v.readyState >= 2) {
        // 100% optical: markers -> pose -> drill state
        trackerRef.current ??= new OpticalTracker();
        const r = trackerRef.current.update(v, t);
        if (r) {
          drawHud(ctx, r.state, w, h, false, { background: "camera", video: v, overlay: r.overlay });
          return;
        }
      }
      drawHud(ctx, simulate(t), w, h, false, { background: bgRef.current, video: v });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
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

      {/* floating control column, right edge (portrait and landscape) */}
      <div className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-1/2 flex -translate-y-1/2 flex-col items-center gap-3.5">
        <RoundButton label={SURF_LABEL[bg]} caption="View" onClick={cycleSurface}>
          <SurfIcon />
        </RoundButton>
        {bg === "camera" ? (
          <RoundButton
            label="A2"
            caption="Calibrate"
            onClick={() => {
              const ok = trackerRef.current?.calibrateTipOn("A2");
              say(ok ? "TIP CALIBRATED ON A2" : "POINT AT THE MARKERS");
            }}
          >
            <CalIcon />
          </RoundButton>
        ) : (
          <RoundButton
            label=""
            caption="Restart"
            onClick={() => {
              restartRef.current = true;
              say("RESTART");
            }}
          >
            <RestartIcon />
          </RoundButton>
        )}
        <RoundButton label="" caption="Full" onClick={fullscreen}>
          <FullIcon />
        </RoundButton>
        <a href="/markers" className="mt-1 font-mono text-[10px] text-white/60 hover:text-white">
          Markers
        </a>
        <a href="/" className="font-mono text-[10px] text-white/50 hover:text-white/80">
          ← 3D
        </a>
      </div>
    </div>
  );
}

function RoundButton({
  children,
  label,
  caption,
  onClick,
  active,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  caption: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={`${caption} ${label}`}
      className="flex flex-col items-center gap-1 disabled:opacity-30"
    >
      <span
        className={`flex h-[52px] w-[52px] items-center justify-center rounded-full border backdrop-blur-md transition active:scale-95 ${
          active ? "border-[#3ee59b] bg-[#3ee59b]/20 text-[#3ee59b]" : "border-white/35 bg-black/45 text-white/90"
        }`}
      >
        {children}
      </span>
      <span className="font-mono text-[10px] leading-none text-white/70 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
        {caption}
        {label ? ` · ${label}` : ""}
      </span>
    </button>
  );
}

const ico = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function SurfIcon() {
  return (
    <svg {...ico}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M3 15h18M9 4v6M15 10v5M9 15v5" />
    </svg>
  );
}
function CalIcon() {
  return (
    <svg {...ico}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
    </svg>
  );
}
function RestartIcon() {
  return (
    <svg {...ico}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4h4" />
    </svg>
  );
}
function FullIcon() {
  return (
    <svg {...ico}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}
