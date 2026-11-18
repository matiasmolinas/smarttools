"use client";

import { useEffect, useRef, useState } from "react";
import { simulate } from "@/lib/sim";
import { drawHud, type HudBackground } from "@/lib/hud";
import { useLiveImu } from "@/lib/useLiveImu";

type WakeLockSentinelLike = { release: () => Promise<void> };

export default function HudScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { live, msg, toggle, rezero, tiltRef } = useLiveImu();
  const [showUi, setShowUi] = useState(true);
  const [bg, setBg] = useState<HudBackground>("wall");
  const bgRef = useRef<HudBackground>("wall");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camMsg, setCamMsg] = useState<string | null>(null);

  // initial background from ?bg= or the last choice
  useEffect(() => {
    let initial: string | null = new URLSearchParams(window.location.search).get("bg");
    if (!initial) {
      try {
        initial = localStorage.getItem("hud-bg");
      } catch {}
    }
    if (initial === "wall" || initial === "wood" || initial === "grid") choose(initial);
    // camera needs a user gesture on iOS, so it is never auto-started
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function choose(next: HudBackground) {
    if (next === "camera") {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamMsg("Camera not available in this browser.");
        return;
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
        setCamMsg("Live camera: the guide is drawn over the real image. Target tracking from markers is the next step.");
      } catch {
        setCamMsg("Camera permission denied.");
        return;
      }
    } else {
      stopCamera();
      setCamMsg(null);
      try {
        localStorage.setItem("hud-bg", next);
      } catch {}
    }
    bgRef.current = next;
    setBg(next);
  }

  useEffect(() => stopCamera, []);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (w > 0 && h > 0) drawHud(ctx, s, w, h, w > h * 1.15, { background: bgRef.current, video: videoRef.current });
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

  // auto-hide controls
  const poke = () => {
    setShowUi(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowUi(false), 4000);
  };
  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const fullscreen = () => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else el.webkitRequestFullscreen?.();
  };

  const btn =
    "rounded-full border border-white/20 bg-black/70 px-3 py-2 font-mono text-[11px] text-white/85 backdrop-blur active:bg-white/20";

  return (
    <div className="fixed inset-0 bg-black" onPointerDown={poke}>
      <canvas ref={canvasRef} className="block h-[100dvh] w-full touch-none" />
      <video ref={videoRef} playsInline muted className="hidden" />
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-opacity duration-500 ${
          showUi ? "opacity-100" : "opacity-0"
        }`}
      >
        {camMsg && <p className="max-w-sm rounded bg-black/70 px-2 py-1 text-center font-mono text-[10px] text-white/70">{camMsg}</p>}
        <div className={`flex gap-1 rounded-full border border-white/20 bg-black/70 p-1 backdrop-blur ${showUi ? "pointer-events-auto" : ""}`}>
          {(["wall", "wood", "camera", "grid"] as const).map((k) => (
            <button
              key={k}
              onClick={() => choose(k)}
              className={`rounded-full px-3 py-1.5 font-mono text-[11px] capitalize ${bg === k ? "bg-white text-black" : "text-white/80"}`}
            >
              {k}
            </button>
          ))}
        </div>
        {msg && <p className="max-w-sm rounded bg-black/70 px-2 py-1 text-center font-mono text-[10px] text-white/70">{msg}</p>}
        <div className={`flex flex-wrap justify-center gap-2 ${showUi ? "pointer-events-auto" : ""}`}>
          <button className={btn} onClick={toggle}>
            {live ? "● Live IMU: on" : "Live IMU"}
          </button>
          {live && (
            <button className={btn} onClick={rezero}>
              Re-zero 90°
            </button>
          )}
          <button className={btn} onClick={fullscreen}>
            Fullscreen
          </button>
          <a className={btn} href="/">
            ← 3D view
          </a>
        </div>
      </div>
    </div>
  );
}
