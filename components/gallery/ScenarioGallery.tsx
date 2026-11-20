"use client";

// Home-page gallery: scenarios of what SmartTools does, each running the real navigation engine and
// drawn in 3D + 2D. The player (three.js + WASM) loads only when the section comes into view.

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { PROJECT_INFO, SCENARIOS } from "@/lib/gallery/scenarios";

const ScenarioPlayer = dynamic(() => import("./ScenarioPlayer"), { ssr: false });

export default function ScenarioGallery() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const sc = SCENARIOS[index];

  useEffect(() => {
    const io = new IntersectionObserver((e) => {
      if (e[0].isIntersecting) setVisible(true);
      setPlaying(e[0].isIntersecting);
    }, { rootMargin: "200px" });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);

  const go = (d: number) => setIndex((i) => (i + d + SCENARIOS.length) % SCENARIOS.length);

  return (
    <section ref={ref} id="scenarios" className="scroll-mt-6 py-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Scenarios</p>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">See what we are building</h2>
          <p className="mt-2 max-w-2xl text-sm text-white/60">
            Every scenario runs the real navigation engine (Rust, 120 Hz) on scripted motion, and draws it from the same
            snapshots three ways: a 3D scene, a 2D view and the numbers it decides with. The last three show how athos,
            contract-gatekeeper and agentvcs plug in.
          </p>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs">
          <button onClick={() => go(-1)} className="rounded-full border border-white/15 px-3 py-1.5 text-white/70 hover:border-white/40 hover:text-white" aria-label="Previous scenario">
            ←
          </button>
          <button onClick={() => setPlaying((p) => !p)} className="rounded-full border border-white/15 px-3 py-1.5 text-white/70 hover:border-white/40 hover:text-white">
            {playing ? "Pause" : "Play"}
          </button>
          <button onClick={() => go(1)} className="rounded-full border border-white/15 px-3 py-1.5 text-white/70 hover:border-white/40 hover:text-white" aria-label="Next scenario">
            →
          </button>
          <label className="ml-2 flex items-center gap-1.5 text-white/50">
            <input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} className="accent-[var(--green)]" />
            auto
          </label>
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-xs text-white/40">
            {index + 1}/{SCENARIOS.length} · {sc.kicker}
          </span>
          <h3 className="text-lg font-semibold">{sc.title}</h3>
          {sc.concept && <span className="rounded-full border border-[var(--amber)]/40 px-2 py-0.5 font-mono text-[10px] text-[var(--amber)]">planned integration · illustrative</span>}
        </div>
        <p className="mb-4 max-w-3xl text-sm text-white/60">{sc.summary}</p>
        {visible ? (
          <ScenarioPlayer key={sc.id} scenario={sc} playing={playing} onEnd={() => autoAdvance && go(1)} />
        ) : (
          <div className="h-[440px] rounded-2xl border border-white/10" />
        )}
      </div>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SCENARIOS.map((s, i) => (
          <li key={s.id}>
            <button
              onClick={() => {
                setIndex(i);
                setPlaying(true);
              }}
              className={`h-full w-full rounded-xl border p-4 text-left transition ${i === index ? "border-[var(--green)]/60 bg-[var(--green)]/5" : "border-white/10 hover:border-white/30"}`}
            >
              <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-white/40">
                <span>{s.kicker}</span>
                {s.project && <span className="text-[var(--cyan)]">{PROJECT_INFO[s.project].role}</span>}
              </div>
              <div className="mt-1.5 font-medium">{s.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-white/50">{s.summary}</div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
