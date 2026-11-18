"use client";

import { useEffect, useRef, useState } from "react";
import { simulate } from "@/lib/sim";
import { drawHud, type HudBackground } from "@/lib/hud";
import { useLiveImu } from "@/lib/useLiveImu";

type WakeLockSentinelLike = { release: () => Promise<void> };

const SURFACES: HudBackground[] = ["wall", "wood", "camera", "grid"];
const SURF_LABEL: Record<HudBackground, string> = { wall: "WALL", wood: "WOOD", camera: "CAM", grid: "GRID" };

export default function HudScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { live, msg, toggle, rezero, tiltRef } = useLiveImu();
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

  useEffect(() => {
    if (msg) say(msg);
  }, [msg]);

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
      say(SURF_LABEL[next]);
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
      const s = simulate(t, tiltRef.current);
      const w = canvas.width;
      const h = canvas.height;
      if (w > 0 && h > 0) drawHud(ctx, s, w, h, false, { background: bgRef.current, video: videoRef.current });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [tiltRef]);

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
    <div className="fixed inset-0 flex bg-black text-[#4dff88]">
      <div className="relative min-w-0 flex-1">
        <canvas ref={canvasRef} className="block h-[100dvh] w-full touch-none" />
        <video ref={videoRef} playsInline muted className="hidden" />
        {toast && (
          <div className="pointer-events-none absolute inset-x-0 top-[22%] flex justify-center px-4">
            <div className="rounded-lg border-2 border-[#4dff88] bg-black/80 px-5 py-2 text-center font-mono text-xl font-extrabold tracking-wider sm:text-2xl">
              {toast}
            </div>
          </div>
        )}
      </div>

      {/* side bar: big round controls, usable with gloves */}
      <aside className="flex w-[84px] shrink-0 flex-col items-center justify-center gap-5 border-l-2 border-[#4dff88]/40 bg-black/90 py-4 pr-[env(safe-area-inset-right)] sm:w-[104px]">
        <RoundButton label={SURF_LABEL[bg]} caption="SURF" onClick={cycleSurface}>
          <SurfIcon />
        </RoundButton>
        <RoundButton label={live ? "ON" : "OFF"} caption="IMU" active={live} onClick={toggle}>
          <ImuIcon />
        </RoundButton>
        <RoundButton
          label="90°"
          caption="ZERO"
          disabled={!live}
          onClick={() => {
            rezero();
            say("ZERO SET · 90°");
          }}
        >
          <ZeroIcon />
        </RoundButton>
        <RoundButton label="FULL" caption="SCREEN" onClick={fullscreen}>
          <FullIcon />
        </RoundButton>
        <a href="/" className="mt-1 font-mono text-[11px] font-bold text-[#4dff88]/60 underline-offset-4 hover:underline">
          ← 3D
        </a>
      </aside>
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
        className={`flex h-[60px] w-[60px] items-center justify-center rounded-full border-[3px] transition active:scale-95 sm:h-[72px] sm:w-[72px] ${
          active
            ? "border-[#4dff88] bg-[#4dff88] text-black shadow-[0_0_18px_#4dff88]"
            : "border-[#4dff88] bg-black text-[#4dff88] shadow-[0_0_10px_rgba(77,255,136,0.35)]"
        }`}
      >
        {children}
      </span>
      <span className="font-mono text-[11px] font-extrabold leading-none tracking-wider">{caption}</span>
      <span className="font-mono text-[10px] font-bold leading-none text-[#4dff88]/60">{label}</span>
    </button>
  );
}

const ico = { width: 28, height: 28, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function SurfIcon() {
  return (
    <svg {...ico}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M3 15h18M9 4v6M15 10v5M9 15v5" />
    </svg>
  );
}
function ImuIcon() {
  return (
    <svg {...ico}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v4M12 16v4M4 12h4M16 12h4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
function ZeroIcon() {
  return (
    <svg {...ico}>
      <path d="M4 20h16M6 20V6" />
      <path d="M6 14a6 6 0 0 1 6 6" />
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
