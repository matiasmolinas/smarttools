// Home page. One story, in the order a visitor asks the questions:
//   what is it (hero) → show me (the job, start to finish) → what does it do (3 things) → can I try it
//   (what you need) → does it really work (demos, numbers) → how is it built (inside) → where is it going.
// The reasoning behind this structure is in docs/SITE.md.

import AssemblyHero from "@/components/gallery/AssemblyHero";
import ScenarioGallery from "@/components/gallery/ScenarioGallery";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";

const PILLARS = [
  {
    color: "var(--amber)",
    k: "Locate",
    t: "It knows where the part is.",
    d: "Touch four points with the bit tip, or stick a few markers on the part: its CAD model, every hole included, snaps onto the real thing. Move the part, and it follows.",
    demos: [
      ["assembly-register", "Locate by touch"],
      ["assembly-anchors", "Markers on the part"],
      ["assembly-factory", "Parts that locate themselves"],
    ],
  },
  {
    color: "var(--cyan)",
    k: "Guide",
    t: "It shows you, right on the part.",
    d: "The next hole glows. A tunnel lines up the bit. X-ray shows the screw inside the part. A tone tells you when you are square, so your eyes stay on the work.",
    demos: [
      ["assembly-faces", "Every face, its own angle"],
      ["assembly-handsfree", "Hands-free: tap, twist, listen"],
      ["assembly-coach", "Follow an expert's ghost"],
    ],
  },
  {
    color: "var(--green)",
    k: "Protect",
    t: "It says no before you get it wrong.",
    d: "Not square, not located, a pipe behind the wall, the part slipped in the vise: the go / no-go gate stops you. Every screw is recorded with its depth and angle.",
    demos: [
      ["no-go", "Never into a pipe"],
      ["assembly-verify", "A part 2 mm off, caught"],
      ["safety", "When the gate says no"],
    ],
  },
] as const;

const NEEDS = [
  { n: "1", t: "Your phone", d: "Its camera, screen and chip do the work. Profiles for the Redmi 15 and Redmi Note 13; more to come.", link: null },
  { n: "2", t: "A printed dock", d: "Clamps behind the chuck of any drill from Ø38 to 68 mm. About $20 of plastic and an M5 bolt. Open STL files.", link: { href: "https://github.com/matiasmolinas/smarttools/tree/main/hardware/dock", label: "Print the dock ↗" } },
  { n: "3", t: "A sheet of paper", d: "Printed markers are the reference. Tape it beside the work, or stick markers on the part itself.", link: { href: "/markers", label: "Print the sheet →" } },
];

const NUMBERS = [
  { k: "0.04 mm", v: "registration error after touching 4 points" },
  { k: "< 0.6 mm", v: "tip error while driving, 95th percentile, in every scenario" },
  { k: "< 0.3°", v: "angle error while driving, 95th percentile" },
  { k: "120 Hz", v: "the engine's clock, on the phone" },
  { k: "0", v: "language-model tokens in the real-time loop" },
  { k: "178", v: "automated checks: 64 Rust, 61 TypeScript, 53 end-to-end" },
];

const STACK = [
  { name: "athos", href: "https://github.com/athos-agent/athos", role: "Plan & guide", body: "Verified know-how as steps (When / Do / Check / Because), replayed on the tool." },
  { name: "contract-gatekeeper", href: "https://github.com/matiasmolinas/contract-gatekeeper", role: "Evolve safely", body: "A deterministic verifier: new tool plugins pass its checks before they touch the core." },
  { name: "agentvcs", href: "https://github.com/EvolvingAgentsLabs/agentvcs", role: "Learn in the field", body: "Every hole and screw recorded against the exact software version that guided it." },
];

const STATUS = [
  { k: "Works today", c: "var(--green)", items: ["The navigation engine (Rust → WebAssembly), tested end to end on simulated camera images", "The phone app in the browser (/hud): live camera tracking of the marker sheet, lens and dock calibration", "The dock design, checked for fit and for what the camera can see"] },
  { k: "Next weeks", c: "var(--amber)", items: ["The SmartTools app, first public release", "The dock printed and measured on a real drill against a reference jig"] },
  { k: "After", c: "var(--cyan)", items: ["Circular-saw bevel and cut lines", "A field pilot with workshops, error data logged per screw", "Our own camera module, if the phone turns out to be the limit"] },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 sm:px-6">
      <SiteNav />

      {/* 1. What it is */}
      <header className="pb-10 pt-10 sm:pt-16">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">For the drill you already own</p>
        <h1 className="max-w-4xl text-4xl font-semibold leading-[1.04] tracking-tight sm:text-6xl lg:text-7xl">
          Every hole in its place.
          <br />
          <span className="text-[var(--green)]">Every screw square.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/65 sm:text-xl">
          Clip your phone to your drill. It sees the part, knows where every hole goes, and guides your hands to half a
          degree, with a light on the part and a tone in your ear.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a href="#build" className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/90">
            Watch it build ↓
          </a>
          <a href="/hud" className="rounded-full border border-white/20 px-5 py-2.5 text-sm font-semibold text-white hover:border-white/50">
            Try it on your phone →
          </a>
          <span className="font-mono text-xs text-white/40">Demo site · the app ships in the coming weeks</span>
        </div>
      </header>

      {/* 2. Show me */}
      <section id="build" aria-label="One job, start to finish" className="scroll-mt-4 pb-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">One job, start to finish: a robot-arm base, 10 screws, 3 faces.</h2>
          <span className="font-mono text-[11px] text-white/40">left: the workshop in 3D · right: what the phone shows</span>
        </div>
        <AssemblyHero />
      </section>

      {/* 3. What it does */}
      <section id="what" className="scroll-mt-4 py-16">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">What it does</p>
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight sm:text-4xl">Three things, so you can do the fourth: the work.</h2>
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {PILLARS.map((p) => (
            <article key={p.k} className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-6">
              <div className="flex items-center gap-2">
                <span className="inline-block h-3.5 w-3.5 rounded-full border-2" style={{ borderColor: p.color, boxShadow: `0 0 12px ${p.color}` }} />
                <span className="font-mono text-xs uppercase tracking-wider" style={{ color: p.color }}>
                  {p.k}
                </span>
              </div>
              <h3 className="mt-4 text-xl font-semibold">{p.t}</h3>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-white/60">{p.d}</p>
              <ul className="mt-5 space-y-1.5 border-t border-white/10 pt-4 text-sm">
                {p.demos.map(([id, label]) => (
                  <li key={id}>
                    <a href={`#scenario-${id}`} className="text-white/75 hover:text-white">
                      <span className="mr-2 text-white/35">▶</span>
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      {/* 4. Can I try it */}
      <section id="start" className="scroll-mt-4 py-16">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Get started</p>
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">Three things you already have, or can print tonight.</h2>
            <p className="mt-4 text-white/60">
              No tracking tower, no laser, no new tool. The precision comes from geometry, measured by the camera you
              carry every day.
            </p>
            <a href="/hud" className="mt-6 inline-block rounded-full bg-[var(--green)] px-5 py-2.5 text-sm font-semibold text-black hover:brightness-110">
              Open the app on your phone →
            </a>
            <p className="mt-3 font-mono text-[11px] text-white/40">Runs in the browser. Point it at the printed sheet to see it track.</p>
          </div>
          <ol className="grid gap-3 sm:grid-cols-3">
            {NEEDS.map((n) => (
              <li key={n.n} className="flex flex-col rounded-2xl border border-white/10 p-5">
                <span className="font-mono text-3xl text-white/25">{n.n}</span>
                <h3 className="mt-3 font-semibold">{n.t}</h3>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-white/55">{n.d}</p>
                {n.link && (
                  <a href={n.link.href} className="mt-4 text-sm text-[var(--cyan)] hover:underline">
                    {n.link.label}
                  </a>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 5. Does it really work */}
      <ScenarioGallery />

      {/* 6. How it is built */}
      <section id="inside" className="scroll-mt-4 py-16">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">How it works</p>
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">AI plans the job. Math guides your hands.</h2>
            <div className="mt-5 space-y-4 leading-relaxed text-white/60">
              <p>
                The camera behind the bit sees printed markers and computes where the tool is, in six degrees of freedom,
                many times a second. The same navigation that guides knee-replacement surgery, on a phone.
              </p>
              <p>
                A deterministic engine, written in Rust and compiled to WebAssembly, makes every call: where the tip is,
                how square the bit is, how deep, and whether it is safe to go. A language model can help plan the job, but
                nothing probabilistic sits between the camera and the trigger.
              </p>
              <p className="text-sm text-white/45">
                The numbers come from end-to-end tests: rendered camera images with tremor, vibration, blur and noise go
                through the real tracker and the real engine. Simulated, not yet measured on a real drill.
              </p>
            </div>
            <div className="mt-6 flex flex-wrap gap-3 text-sm">
              <a href="/engine" className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
                Open the engine lab →
              </a>
              <a href="https://github.com/matiasmolinas/smarttools/blob/main/docs/ENGINE_SPEC.md" className="rounded-full border border-white/20 px-4 py-2 hover:border-white/50">
                Read the engine spec ↗
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

        <div className="mt-14 grid gap-3 lg:grid-cols-4">
          <div className="lg:pr-4">
            <h3 className="text-lg font-semibold">Built in the open</h3>
            <p className="mt-2 text-sm text-white/55">Apache 2.0. The engine, the app, the dock and the tests are on GitHub, with the open-source stack around them.</p>
          </div>
          {STACK.map((r) => (
            <a key={r.name} href={r.href} className="group rounded-2xl border border-white/10 p-5 transition hover:border-[var(--cyan)]/50">
              <div className="font-mono text-[10px] uppercase tracking-wider text-white/40">{r.role}</div>
              <div className="mt-1.5 font-mono text-[var(--cyan)] group-hover:underline">{r.name} ↗</div>
              <p className="mt-2 text-sm text-white/55">{r.body}</p>
            </a>
          ))}
        </div>
      </section>

      {/* 7. Where it is going */}
      <section id="status" className="scroll-mt-4 py-16">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Where we are</p>
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight sm:text-4xl">Honest status.</h2>
        <p className="mt-4 max-w-2xl text-white/60">
          Built by a team with five years of 3D navigation and visualization for knee-replacement surgery. Today the drill
          and the screwdriver; then every tool in your hands.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {STATUS.map((s) => (
            <div key={s.k} className="rounded-2xl border border-white/10 p-5">
              <div className="font-mono text-xs uppercase tracking-wider" style={{ color: s.c }}>
                {s.k}
              </div>
              <ul className="mt-3 space-y-2 text-sm text-white/65">
                {s.items.map((i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-white/30">·</span>
                    {i}
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
