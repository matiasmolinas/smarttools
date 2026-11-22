// /developers: everything for people building on SmartTools, around four things: the navigation engine with its
// 3D / 2D / AR views, and the three open-source projects (athos, contract-gatekeeper, agentvcs), each with the
// analysis of how it should come in: used from its own repository, or migrated here as a native module.
// The full analysis is docs/INTEGRATIONS.md; the site's structure is explained in docs/SITE.md.

import type { Metadata } from "next";
import ScenarioGallery from "@/components/gallery/ScenarioGallery";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";

export const metadata: Metadata = {
  title: "SmartTools for developers: the navigation engine, 3D and AR views, and the open-source stack",
  description: "A deterministic 6-DoF navigation engine in Rust and WebAssembly, its 3D, 2D and AR views, and how athos, contract-gatekeeper and agentvcs plug in.",
};

const REPO = "https://github.com/matiasmolinas/smarttools";
const src = (p: string) => `${REPO}/blob/main/${p}`;

const FOUR = [
  { href: "#engine", k: "1", name: "The engine", role: "Navigation + 3D, 2D and AR views", c: "var(--green)" },
  { href: "#athos", k: "2", name: "athos", role: "Plan & guide: know-how as checked steps", c: "var(--cyan)" },
  { href: "#gatekeeper", k: "3", name: "contract-gatekeeper", role: "Evolve safely: one capsule per tool", c: "var(--cyan)" },
  { href: "#agentvcs", k: "4", name: "agentvcs", role: "Learn in the field: every screw on record", c: "var(--cyan)" },
];

const ENGINE = [
  {
    k: "Navigation",
    d: "Rust compiled to WebAssembly (~244 KB), a 120 Hz clock fed by 30 Hz camera poses. A scene graph of frames (sheet, parts, holes, tool), registration by touch, parts that move, the go / no-go gate, depth and angle alarms, no-go zones, gestures. Every decision uses measured poses; prediction is only for drawing. A marker detector in Rust is the alternative to js-aruco2: about 3× faster, as accurate.",
    files: [["engine/src/", "engine/src"], ["lib/engine.ts", "lib/engine.ts"], ["Engine spec", "docs/ENGINE_SPEC.md"]],
  },
  {
    k: "3D and 2D views",
    d: "three.js draws any scene definition from the engine's snapshot: primitives and STL meshes, the CAD ghost, the 2D plan and the phone HUD. The renderers can be dropped (headless tests) or replaced; the engine never depends on them.",
    files: [["lib/render/render3d.ts", "lib/render/render3d.ts"], ["lib/scenedef.ts", "lib/scenedef.ts"], ["lib/hud.ts", "lib/hud.ts"]],
  },
  {
    k: "Augmented reality",
    d: "Guidance drawn in the camera's own view, on the part: the next hole glows, an approach tunnel, x-ray of the screw inside, the expert's ghost tool, the heat map. Shown today on the simulated phone view; on the live camera the app draws the 2D guide, and the 3D overlay comes with the app.",
    files: [["lib/render/guidance3d.ts", "lib/render/guidance3d.ts"], ["lib/guidance.ts", "lib/guidance.ts"], ["lib/markertracker.ts", "lib/markertracker.ts"]],
  },
];

const NUMBERS = [
  { k: "0.04 mm", v: "registration error after touching 4 points" },
  { k: "< 0.6 mm", v: "tip error while driving, 95th percentile, in every scenario" },
  { k: "< 0.3°", v: "angle error while driving, 95th percentile" },
  { k: "120 Hz", v: "the engine's clock, on the phone" },
  { k: "0", v: "language-model tokens in the real-time loop" },
  { k: "203", v: "automated checks: 68 Rust, 82 TypeScript, 53 end-to-end" },
];

type Project = {
  id: string;
  name: string;
  href: string;
  role: string;
  what: string;
  inSmartTools: string;
  stack: string;
  verdict: string;
  native: string;
  stays: string;
  next: string;
};

const PROJECTS: Project[] = [
  {
    id: "athos",
    name: "athos",
    href: "https://github.com/athos-agent/athos",
    role: "Plan & guide",
    what: "Keeps how a person works as Markdown steps (When / Do / Check / Because), learned by a frontier model, verified, and replayed by any model.",
    inSmartTools: "A master's recipe becomes the job: the phone shows one step at a time, and every Check is a physical measurement from the engine (depth, angle, located).",
    stack: "Python CLI and agent hooks, ~170 Python files. Runs on a computer, next to an AI agent.",
    verdict: "Use from its repository; read its format natively.",
    native: "A small TypeScript reader of the piece format, and a binder from each Check to an engine measurement. A few hundred lines, tested against pieces exported by athos.",
    stays: "Learning, verification, the router and the audit log: they need an AI agent and a computer, not a phone in a browser.",
    next: "Pin a version of the piece format and add conformance tests with real pieces.",
  },
  {
    id: "gatekeeper",
    name: "contract-gatekeeper",
    href: "https://github.com/matiasmolinas/contract-gatekeeper",
    role: "Evolve safely",
    what: "A deterministic pre-PR and CI check: did a change stay inside one module and keep its contract, or did it cross a boundary?",
    inSmartTools: "Each tool (drill, screwdriver, then the saw) becomes a capsule with a contract. A new tool, written by a person or an agent, cannot touch the engine's core unchecked.",
    stack: "TypeScript, zero runtime dependencies, Node 22. A development and CI tool: it never runs on the phone.",
    verdict: "Use from its repository, as a pinned dev dependency.",
    native: "Nothing of its code. SmartTools adds the capsules (one folder per tool, with its contract) and the gatekeeper.config.json that names them.",
    stays: "All of it: it has its own users and releases, and copying it would fork it.",
    next: "Split the tool-specific code into lib/tools/<tool>/ capsules, then run the check in CI.",
  },
  {
    id: "agentvcs",
    name: "agentvcs",
    href: "https://github.com/EvolvingAgentsLabs/agentvcs",
    role: "Learn in the field",
    what: "Version control for running agent harnesses: every step stamped with the exact version that produced it, patches gated, and blame and bisect on metrics.",
    inSmartTools: "Every hole and screw becomes a step record with its depth and angle errors, stamped with the engine version that guided it. A precision regression is bisected to one change.",
    stack: "Rust workspace (core with SQLite and BLAKE3), CLI, MCP server, Python SDK. 117/117 protocol conformance cases.",
    verdict: "Use from its repository; write its records natively.",
    native: "A writer of its ledger format (canonical JSON, BLAKE3 hashes, step records with metrics) next to the job report, so the phone exports a ledger file.",
    stays: "The store, blame, bisect, diff and merge: they run on a computer or in CI, on the exported ledgers.",
    next: "Export each job's report as an agentvcs ledger and check it with the agentvcs CLI in a test.",
  },
];

const STATUS = [
  { k: "Works today", c: "var(--green)", items: ["The navigation engine (Rust → WebAssembly), tested end to end on simulated camera images", "The phone app in the browser (/hud): live camera tracking of the marker sheet, lens and dock calibration", "The dock design, checked for fit and for what the camera can see"] },
  { k: "Next weeks", c: "var(--amber)", items: ["The SmartTools app, first public release", "The dock printed and measured on a real drill against a reference jig", "The three integrations, as above"] },
  { k: "After", c: "var(--cyan)", items: ["Circular-saw bevel and cut lines", "A field pilot with workshops, error data logged per screw", "Our own camera module, if the phone turns out to be the limit"] },
];

function Row({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="grid gap-1 border-t border-white/10 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="font-mono text-[11px] uppercase tracking-wider text-white/40">{k}</dt>
      <dd className={strong ? "font-semibold text-white" : "text-sm leading-relaxed text-white/65"}>{v}</dd>
    </div>
  );
}

export default function Developers() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 sm:px-6">
      <SiteNav audience="developers" />

      <header className="pb-10 pt-10 sm:pt-16">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">For developers</p>
        <h1 className="max-w-4xl text-4xl font-semibold leading-[1.06] tracking-tight sm:text-6xl">
          AI plans the job.
          <br />
          <span className="text-[var(--green)]">Math guides the hands.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/65">
          A deterministic navigation engine makes every real-time call. Around it, three open-source projects: one to
          plan, one to evolve the code safely, one to learn from the field. Apache 2.0.
        </p>
        <a href="/architecture" className="mt-6 inline-block text-sm text-[var(--cyan)] hover:underline">
          How it splits between the phone and the cloud: the architecture in 3D →
        </a>
        <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FOUR.map((f) => (
            <li key={f.k}>
              <a href={f.href} className="group flex h-full flex-col rounded-2xl border border-white/10 p-5 transition hover:border-white/35">
                <span className="font-mono text-2xl" style={{ color: f.c }}>
                  {f.k}
                </span>
                <span className="mt-2 font-mono text-white group-hover:underline">{f.name}</span>
                <span className="mt-1 text-sm text-white/55">{f.role}</span>
              </a>
            </li>
          ))}
        </ol>
      </header>

      {/* 1. The engine */}
      <section id="engine" className="scroll-mt-4 py-14">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--green)]">1 · The engine</p>
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight sm:text-4xl">Navigation, and three ways to see it.</h2>
        <p className="mt-4 max-w-3xl text-white/60">
          The camera behind the bit sees printed markers and computes where the tool is, in six degrees of freedom. The
          same kind of navigation that guides knee-replacement surgery, on a phone. Nothing probabilistic sits between the
          camera and the trigger.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {ENGINE.map((e) => (
            <article key={e.k} className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-6">
              <h3 className="text-lg font-semibold">{e.k}</h3>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-white/60">{e.d}</p>
              <ul className="mt-4 space-y-1 border-t border-white/10 pt-3 font-mono text-xs">
                {e.files.map(([label, path]) => (
                  <li key={path}>
                    <a href={src(path)} className="text-[var(--cyan)] hover:underline">
                      {label} ↗
                    </a>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h3 className="text-lg font-semibold">The numbers</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/55">
              From end-to-end tests: rendered camera images with tremor, vibration, blur and noise go through the real
              tracker and the real engine. Simulated, not yet measured on a real drill.
            </p>
            <div className="mt-5 flex flex-wrap gap-3 text-sm">
              <a href="/engine" className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
                Open the engine lab →
              </a>
              <a href={src("docs/ENGINE_SPEC.md")} className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
                Read the spec ↗
              </a>
              <a href="/hud" className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
                The phone app →
              </a>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {NUMBERS.map((x) => (
              <div key={x.v} className="rounded-2xl border border-white/10 p-5">
                <dt className="font-mono text-2xl text-[var(--green)] sm:text-3xl">{x.k}</dt>
                <dd className="mt-2 text-xs leading-relaxed text-white/55">{x.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* 2-4. The three projects */}
      <section className="py-6">
        <div className="rounded-2xl border border-[var(--amber)]/30 bg-[var(--amber)]/[0.04] p-6">
          <p className="font-mono text-xs uppercase tracking-wider text-[var(--amber)]">The integration question</p>
          <p className="mt-2 max-w-4xl text-white/75">
            Use each project from its own repository, or migrate it here as a native module? Our analysis: <b className="text-white">migrate none of
            them whole.</b> They are written in other languages for other runtimes (Python on a computer, a Node CI tool, a
            Rust workspace with SQLite), and each has its own users. What comes in natively is the thin edge each one
            meets the phone at: athos&apos;s step format, agentvcs&apos;s ledger format, and the tool capsules gatekeeper checks.
          </p>
          <a href={src("docs/INTEGRATIONS.md")} className="mt-3 inline-block text-sm text-[var(--cyan)] hover:underline">
            Read the full analysis ↗
          </a>
        </div>
      </section>

      {PROJECTS.map((p, i) => (
        <section key={p.id} id={p.id} className="scroll-mt-4 py-12">
          <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">
            {i + 2} · {p.role}
          </p>
          <div className="grid gap-8 lg:grid-cols-[1fr_1.5fr]">
            <div>
              <h2 className="font-mono text-2xl font-semibold tracking-tight sm:text-4xl">{p.name}</h2>
              <p className="mt-4 leading-relaxed text-white/65">{p.what}</p>
              <p className="mt-4 leading-relaxed text-white/80">{p.inSmartTools}</p>
              <div className="mt-6 flex flex-wrap gap-3 text-sm">
                <a href={p.href} className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
                  Repository ↗
                </a>
                <a href={`#scenario-${p.id}`} className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
                  ▶ See the illustration
                </a>
              </div>
            </div>
            <dl className="rounded-2xl border border-white/10 px-5 pb-2 pt-1">
              <Row k="Built with" v={p.stack} />
              <Row k="Recommendation" v={p.verdict} strong />
              <Row k="Native in SmartTools" v={p.native} />
              <Row k="Stays in its repo" v={p.stays} />
              <Row k="Next step" v={p.next} />
            </dl>
          </div>
        </section>
      ))}

      <ScenarioGallery title="All the demos, platform included." />

      <section id="status" className="scroll-mt-4 py-14">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Where we are</p>
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight sm:text-4xl">Honest status.</h2>
        <p className="mt-4 max-w-2xl text-white/60">
          Built by a team with five years of 3D navigation and visualization for knee-replacement surgery.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {STATUS.map((s) => (
            <div key={s.k} className="rounded-2xl border border-white/10 p-5">
              <div className="font-mono text-xs uppercase tracking-wider" style={{ color: s.c }}>
                {s.k}
              </div>
              <ul className="mt-3 space-y-2 text-sm text-white/65">
                {s.items.map((it) => (
                  <li key={it} className="flex gap-2">
                    <span className="text-white/30">·</span>
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
