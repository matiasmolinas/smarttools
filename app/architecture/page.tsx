// /architecture: how SmartTools is split between the phone and the cloud, drawn in 3D from lib/architecture.ts.
// The decision and its reasons are docs/ARCHITECTURE.md; this page tells the same story for visitors.

import type { Metadata } from "next";
import dynamic from "next/dynamic";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { BLOCKS, FILE_KINDS, PHASES } from "@/lib/architecture";

const ArchitectureScene = dynamic(() => import("@/components/ArchitectureScene"), {
  loading: () => <div className="h-[460px] rounded-2xl border border-white/10 sm:h-[580px]" />,
});

export const metadata: Metadata = {
  title: "SmartTools architecture: the phone runs the work, the cloud keeps the knowledge",
  description: "A hybrid app: an installable web app with a Rust/WebAssembly engine runs everything real-time on the phone, offline; the cloud keeps plans and memory, shares experts' work and hosts athos and agentvcs.",
};

const SRC = "https://github.com/matiasmolinas/smarttools/blob/main/";

const OPTIONS = [
  { k: "Phone only", v: "The base, not enough", c: "var(--amber)", d: "Fastest, offline, private. But no shared plans, no experts, no sync, no AI planning, and a cleared browser loses the memory." },
  { k: "Cloud only", v: "Rejected", c: "#ff6b6b", d: "Streaming video to a server cannot hold a 120 Hz loop with 30 ms to decide. Workshop Wi-Fi drops, and a safety decision must never wait for a network." },
  { k: "Hybrid", v: "Chosen", c: "var(--green)", d: "Everything real-time on the phone, offline included; the cloud adds memory, sharing, AI and the services, and only exchanges files with the phone." },
  { k: "Native app", v: "Only if measured", c: "var(--cyan)", d: "More camera control (focus, exposure, frame rate). If the real drill shows the browser's camera is the limit, the same app gets wrapped, not rewritten." },
];

const STATUS: Record<number, string> = { 1: "in progress", 2: "next", 3: "after" };

export default function Architecture() {
  const side = (s: "phone" | "cloud") => BLOCKS.filter((b) => b.side === s);
  return (
    <main className="mx-auto w-full max-w-7xl px-4 sm:px-6">
      <SiteNav audience="architecture" />

      <header className="pb-8 pt-10 sm:pt-16">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Architecture</p>
        <h1 className="max-w-4xl text-4xl font-semibold leading-[1.06] tracking-tight sm:text-6xl">
          The phone runs the work.
          <br />
          <span className="text-[var(--green)]">The cloud keeps the knowledge.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/65">
          The cloud delivers an installable web app with the navigation engine in WebAssembly, and the phone runs all of
          it, offline included. Plans, memory, experts and AI live in the cloud, and reach the phone only as files.
        </p>
        <div className="mt-6 inline-flex items-center gap-3 rounded-full border border-[var(--amber)]/40 bg-[var(--amber)]/[0.06] px-4 py-2 text-sm">
          <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--amber)]">The rule</span>
          <span className="text-white/85">The cloud is never between the camera and the trigger.</span>
        </div>
      </header>

      <section id="diagram" className="scroll-mt-4 pb-10">
        <ArchitectureScene />
      </section>

      <section id="where" className="scroll-mt-4 py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">What runs where</p>
        <div className="grid gap-4 lg:grid-cols-2">
          {(["phone", "cloud"] as const).map((s) => (
            <article key={s} className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
              <h2 className="text-xl font-semibold">{s === "phone" ? "On the phone · open source" : "In the cloud · a private service"}</h2>
              <p className="mt-1 text-sm text-white/50">
                {s === "phone" ? "This repository, Apache 2.0. Works with no network." : "Its own repository, like athos-cloud for athos. Talks to the phone only through the files below."}
              </p>
              <ul className="mt-4 space-y-3 border-t border-white/10 pt-4">
                {side(s).map((b) => (
                  <li key={b.id} className="grid grid-cols-[auto_1fr] gap-x-3">
                    <span className={`mt-1.5 inline-block h-2 w-2 rounded-full ${b.realtime ? "bg-[var(--green)]" : "bg-[var(--cyan)]"}`} />
                    <div>
                      <span className="font-medium">{b.label}</span>
                      <span className="ml-2 font-mono text-[10px] text-white/40">F{b.phase}</span>
                      <p className="text-sm leading-relaxed text-white/55">{b.what}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <p className="mt-4 text-sm text-white/50">
          contract-gatekeeper is neither: it is a CI step on the repository, so a new tool&apos;s code stays inside its own capsule.
        </p>
      </section>

      <section id="files" className="scroll-mt-4 py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">The contract</p>
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight sm:text-4xl">Three files cross. Nothing else.</h2>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {Object.values(FILE_KINDS).map((k) => (
            <article key={k.label} className="rounded-2xl border border-white/10 p-6">
              <span className="inline-block h-4 w-3 rounded-[2px]" style={{ background: k.color, boxShadow: `0 0 12px ${k.color}` }} />
              <h3 className="mt-3 text-lg font-semibold">{k.label}</h3>
              <div className="font-mono text-[11px] text-white/45">{k.format}</div>
              <p className="mt-3 text-sm leading-relaxed text-white/60">{k.what}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Why hybrid</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {OPTIONS.map((o) => (
            <article key={o.k} className="rounded-2xl border border-white/10 p-5">
              <div className="font-mono text-[11px] uppercase tracking-wider" style={{ color: o.c }}>
                {o.v}
              </div>
              <h3 className="mt-2 font-semibold">{o.k}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/55">{o.d}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="phases" className="scroll-mt-4 py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Phases</p>
        <div className="grid gap-4 lg:grid-cols-3">
          {PHASES.map((p) => (
            <article key={p.n} className={`rounded-2xl border p-6 ${p.n === 1 ? "border-[var(--green)]/40" : "border-white/10"}`}>
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-3xl text-white/80">{p.label}</span>
                <span className={`font-mono text-[11px] uppercase tracking-wider ${p.n === 1 ? "text-[var(--green)]" : "text-white/40"}`}>{STATUS[p.n]}</span>
              </div>
              <h3 className="mt-2 font-semibold">{p.goal}</h3>
              <ul className="mt-3 space-y-1.5 text-sm text-white/60">
                {BLOCKS.filter((b) => b.phase === p.n).map((b) => (
                  <li key={b.id}>· {b.label}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap gap-3 text-sm">
          <a href={`${SRC}docs/ARCHITECTURE.md`} className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
            Read the architecture ↗
          </a>
          <a href={`${SRC}docs/INTEGRATIONS.md`} className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
            How the three projects come in ↗
          </a>
          <a href="/developers" className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
            For developers →
          </a>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
