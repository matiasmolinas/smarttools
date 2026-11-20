"use client";

// The demos: every scenario runs the real navigation engine and is drawn in 3D + 2D. Grouped by what it
// shows; a link to #scenario-<id> opens one. The player (three.js + WASM) loads only when in view.

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { HERO, PROJECT_INFO, SCENARIOS as ALL } from "@/lib/gallery";

// the whole job is the page's main animation already: the demos are its parts
const SCENARIOS = ALL.filter((s) => s.id !== HERO.id);
import type { Scenario } from "@/lib/gallery/scenarios";

const ScenarioPlayer = dynamic(() => import("./ScenarioPlayer"), { ssr: false });

export const CATEGORIES = [
  { id: "assembly", label: "3D assembly", blurb: "A real part, many screws, every face." },
  { id: "drilling", label: "Drilling & safety", blurb: "Holes in a wall, square and to depth; what the gate refuses." },
  { id: "platform", label: "Platform", blurb: "How the open-source stack plugs in (planned integrations)." },
] as const;
type Cat = (typeof CATEGORIES)[number]["id"];
export const categoryOf = (s: Scenario): Cat => (s.id.startsWith("assembly") ? "assembly" : s.project ? "platform" : "drilling");

export default function ScenarioGallery() {
  const [cat, setCat] = useState<Cat>("assembly");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const list = useMemo(() => SCENARIOS.filter((s) => categoryOf(s) === cat), [cat]);
  const sc = list[Math.min(index, list.length - 1)];

  useEffect(() => {
    const io = new IntersectionObserver((e) => {
      if (e[0].isIntersecting) setVisible(true);
      setPlaying(e[0].isIntersecting);
    }, { rootMargin: "200px" });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);

  // #scenario-<id>: open that demo (links from the rest of the page)
  useEffect(() => {
    const open = () => {
      const m = /^#scenario-(.+)$/.exec(window.location.hash);
      const s = m && SCENARIOS.find((x) => x.id === m[1]);
      if (!s) return;
      const c = categoryOf(s);
      setCat(c);
      setIndex(SCENARIOS.filter((x) => categoryOf(x) === c).indexOf(s));
      setPlaying(true);
      setAutoAdvance(false);
      ref.current?.scrollIntoView({ behavior: "smooth" });
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);

  const go = (d: number) => setIndex((i) => (i + d + list.length) % list.length);

  return (
    <section ref={ref} id="scenarios" className="scroll-mt-6 py-16">
      <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Demos</p>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">See every part of it, working.</h2>
          <p className="mt-2 max-w-2xl text-sm text-white/55">
            Each demo runs the real navigation engine on scripted motion and draws it three ways: the 3D scene, what the
            phone shows, and the numbers it decides with.
          </p>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs">
          <button onClick={() => go(-1)} className="rounded-full border border-white/15 px-3 py-1.5 text-white/70 hover:border-white/40 hover:text-white" aria-label="Previous demo">
            ←
          </button>
          <button onClick={() => setPlaying((p) => !p)} className="rounded-full border border-white/15 px-3 py-1.5 text-white/70 hover:border-white/40 hover:text-white">
            {playing ? "Pause" : "Play"}
          </button>
          <button onClick={() => go(1)} className="rounded-full border border-white/15 px-3 py-1.5 text-white/70 hover:border-white/40 hover:text-white" aria-label="Next demo">
            →
          </button>
          <label className="ml-2 flex items-center gap-1.5 text-white/50">
            <input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} className="accent-[var(--green)]" />
            auto
          </label>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2" role="tablist">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={c.id === cat}
            onClick={() => {
              setCat(c.id);
              setIndex(0);
              setPlaying(true);
            }}
            className={`rounded-full border px-4 py-1.5 text-sm transition ${c.id === cat ? "border-[var(--green)]/60 bg-[var(--green)]/10 text-white" : "border-white/15 text-white/60 hover:border-white/35 hover:text-white"}`}
          >
            {c.label} <span className="font-mono text-[11px] text-white/40">{SCENARIOS.filter((s) => categoryOf(s) === c.id).length}</span>
          </button>
        ))}
        <span className="self-center pl-1 text-xs text-white/40">{CATEGORIES.find((c) => c.id === cat)!.blurb}</span>
      </div>

      <div className="mt-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-xs text-white/40">
            {list.indexOf(sc) + 1}/{list.length} · {sc.kicker}
          </span>
          <h3 className="text-lg font-semibold">{sc.title}</h3>
          {sc.concept && <span className="rounded-full border border-[var(--amber)]/40 px-2 py-0.5 font-mono text-[10px] text-[var(--amber)]">planned integration · illustrative</span>}
        </div>
        <p className="mb-4 max-w-3xl text-sm text-white/60">{sc.summary}</p>
        {visible ? <ScenarioPlayer key={sc.id} scenario={sc} playing={playing} onEnd={() => autoAdvance && go(1)} /> : <div className="h-[440px] rounded-2xl border border-white/10" />}
      </div>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((s, i) => (
          <li key={s.id}>
            <button
              onClick={() => {
                setIndex(i);
                setPlaying(true);
              }}
              className={`h-full w-full rounded-xl border p-4 text-left transition ${s === sc ? "border-[var(--green)]/60 bg-[var(--green)]/5" : "border-white/10 hover:border-white/30"}`}
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
