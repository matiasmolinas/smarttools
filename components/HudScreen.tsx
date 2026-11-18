"use client";

import { useEffect, useRef, useState } from "react";
import { simulate } from "@/lib/sim";
import { drawHud } from "@/lib/hud";
import { useLiveImu } from "@/lib/useLiveImu";

type WakeLockSentinelLike = { release: () => Promise<void> };

export default function HudScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { live, msg, toggle, rezero, tiltRef } = useLiveImu();
  const [showUi, setShowUi] = useState(true);
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
      if (w > 0 && h > 0) drawHud(ctx, s, w, h, w > h * 1.15);
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
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-opacity duration-500 ${
          showUi ? "opacity-100" : "opacity-0"
        }`}
      >
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
