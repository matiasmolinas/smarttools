import AssemblyHero from "@/components/gallery/AssemblyHero";
import ScenarioGallery from "@/components/gallery/ScenarioGallery";

const REPOS = [
  {
    name: "athos",
    href: "https://github.com/athos-agent/athos",
    role: "Plan & guide",
    body: "Verified procedural know-how as Markdown steps (When / Do / Check / Because). A frontier model or a master craftsman writes the recipe once; the phone on the tool replays it step by step, and every Check is physical.",
  },
  {
    name: "contract-gatekeeper",
    href: "https://github.com/matiasmolinas/contract-gatekeeper",
    role: "Evolve safely",
    body: "Zero-LLM deterministic verifier (~10 ms). Every plugin ships a Capability Card and a selfTest(); agent-written PRs for new tools are FAST_TRACK, ESCALATE_TO_E2E or REJECTED before they can touch the geometry core.",
  },
  {
    name: "agentvcs",
    href: "https://github.com/EvolvingAgentsLabs/agentvcs",
    role: "Learn in the field",
    body: "Rust-core version control for running agent harnesses. Each hole and cut is a step record (angle error, depth error, time) stamped with the exact harness version, so blame and bisect show which change made users more precise.",
  },
];

const ON_PART = [
  { k: "Anchors", t: "Stick markers on the part", d: "Located once by touch, then followed when you move it, flip it or cover the sheet. A part that slips in the vise stops the job." },
  { k: "Factory markers", t: "Parts that locate themselves", d: "Markers printed on the part at known positions: located and identified on sight, no touching." },
  { k: "Glow · tunnel · x-ray", t: "Guidance on the part", d: "The next hole glows, an approach tunnel rises from it, and x-ray shows the screw inside and the material left." },
  { k: "No-go zones", t: "Never into a pipe", d: "Pipes and cables are volumes in the scene: a hole whose path comes too close is refused." },
  { k: "Hands-free", t: "The drill is the remote", d: "Tap the tip twice to confirm, twist the drill to skip. A tone guides you, so your eyes stay on the work." },
  { k: "Learn", t: "Follow an expert's ghost", d: "An expert's run replayed one step ahead, and a score for every screw from what the engine measured." },
  { k: "Remote", t: "An expert, miles away", d: "Poses, not video: a few kB/s. A remote expert marks a hole and it lights up on the part." },
  { k: "Report", t: "Every screw, on record", d: "Depth, angle and flags per screw, a heat map on the part, and a report to hand over." },
];

const STEPS = [
  {
    n: "01",
    t: "Clip the phone on",
    d: "A 3D-printed dock clamps behind the chuck. The rear camera looks at the work, the screen faces you. Fits the drill you already own.",
  },
  {
    n: "02",
    t: "AI plans the job",
    d: "Say “hang this shelf” or scan a plan. A multimodal model picks the athos recipe and places targets relative to printed fiducial markers.",
  },
  {
    n: "03",
    t: "Deterministic guidance",
    d: "The rear camera sees printed markers and computes the tool's 6-DoF pose at camera rate, on the phone. Centre the tip and chuck rings on the mark and you are on target and square. 0 tokens at runtime.",
  },
  {
    n: "04",
    t: "Every hole is logged",
    d: "Angle and depth error per operation go to agentvcs, against the exact calibration and guidance version that produced them.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 sm:px-6">
      <nav className="flex items-center justify-between py-5">
        <div className="flex items-center gap-2 font-mono text-sm">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--green)] shadow-[0_0_10px_var(--green)]" />
          <span className="font-semibold tracking-tight">SmartTools</span>
          <span className="hidden text-white/40 sm:inline">/ physical AI for the tools you own</span>
        </div>
        <a
          href="https://github.com/matiasmolinas/smarttools"
          className="rounded-full border border-white/15 px-3 py-1.5 font-mono text-xs text-white/70 hover:border-white/40 hover:text-white"
        >
          Source on GitHub ↗
        </a>
      </nav>

      <header className="pb-8 pt-8 sm:pt-14">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">
          Smart 3D navigation → everyday power tools
        </p>
        <h1 className="max-w-4xl text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          A bicycle for humans
          <br className="hidden sm:block" /> in the <span className="text-[var(--green)]">real world</span>.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-white/65 sm:text-lg">
          Manipulation is where robots fail. SmartTools makes the human better than the robot: your phone, clipped to
          the drill you already own, becomes a ±0.5° guide. 6-DoF navigation from knee-replacement surgery, on a $20
          dock and the sensors already in your pocket. AI plans the job; deterministic math guides your hands.
        </p>
        <p className="mt-3 max-w-2xl font-mono text-sm text-white/45">
          Today, the drill and the screwdriver. Tomorrow, every tool in your hands.
        </p>
        <p className="mt-6 inline-block rounded-full border border-[var(--amber)]/40 bg-[var(--amber)]/10 px-4 py-1.5 font-mono text-xs text-[var(--amber)]">
          This site is a demo. The SmartTools app ships in the coming weeks.
        </p>
      </header>

      <section aria-label="Live navigation demo" className="pb-6">
        <AssemblyHero />
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <Legend color="var(--amber)" title="The tip is a probe" body="Touch four points of a part and its CAD model snaps onto it, every hole with it. Touch any other point to verify it." />
          <Legend color="var(--cyan)" title="Every hole, its own axis" body="Top, chamfer or bracket: the rings, the go / no-go gate and the depth stop follow each hole's own frame." />
          <Legend color="var(--green)" title="Checked, not trusted" body="A part 2 mm off is caught before the first screw. Each screw is logged with its depth and angle." />
        </div>
      </section>

      <section aria-label="On the part" className="py-10">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">On the part, in your hands</p>
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">The camera and the engine see the job. So the job can talk back.</h2>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ON_PART.map((x) => (
            <div key={x.t} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="font-mono text-[10px] uppercase tracking-wider text-white/40">{x.k}</div>
              <h3 className="mt-1.5 font-medium">{x.t}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-white/55">{x.d}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 font-mono text-[11px] text-white/40">Each one is a scenario below, running on the real engine.</p>
      </section>

      <ScenarioGallery />

      <section className="py-16">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">How it works</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <div className="font-mono text-xs text-[var(--cyan)]">{s.n}</div>
              <h3 className="mt-3 font-semibold">{s.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/60">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-10 py-16 lg:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">LLMs plan. Math verifies.</h2>
          <p className="mt-4 leading-relaxed text-white/65">
            A language model cannot estimate a 6-DoF pose at camera rate or promise a 0.5° tolerance. So we split the system:
            agentic plugins reason about <em>what</em> to build; deterministic plugins (WebAssembly / Rust / Mojo) compute
            pose, angle and depth in milliseconds and gate every step. Nothing probabilistic sits between the sensor and
            the trigger.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 font-mono text-xs">
          <div className="rounded-2xl border border-white/10 p-4">
            <div className="text-[var(--amber)]">AGENTIC</div>
            <ul className="mt-3 space-y-1.5 text-white/65">
              <li>reads plans / scene</li>
              <li>picks athos recipe</li>
              <li>places targets</li>
              <li>seconds · tokens</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-[var(--green)]/30 p-4">
            <div className="text-[var(--green)]">DETERMINISTIC</div>
            <ul className="mt-3 space-y-1.5 text-white/65">
              <li>marker-based optical pose</li>
              <li>angle · offset · depth</li>
              <li>Check: pass / fail</li>
              <li>&lt;10 ms · 0 tokens</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="py-16">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">The open-source stack underneath</h2>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {REPOS.map((r) => (
            <a
              key={r.name}
              href={r.href}
              className="group rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition hover:border-[var(--cyan)]/50"
            >
              <div className="font-mono text-xs uppercase tracking-wider text-white/40">{r.role}</div>
              <div className="mt-2 font-mono text-lg text-[var(--cyan)] group-hover:underline">{r.name} ↗</div>
              <p className="mt-3 text-sm leading-relaxed text-white/60">{r.body}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="grid gap-10 py-16 lg:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Why now</h2>
          <p className="mt-4 leading-relaxed text-white/65">
            Fifteen years ago, 6-DoF navigation for total knee replacement needed an infrared tracking tower and a
            dedicated workstation. Today a phone carries high-resolution cameras, depth sensing, an NPU and a
            bright screen, and a browser can reach all of it. No regulator stands between this math and a workshop.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3">
          <Stat k="5 yrs" v="building smart tools for knee-replacement surgery: 3D navigation & visualization" />
          <Stat k="$20" v="target cost of the universal 3D-printed dock" />
          <Stat k="±0.5°" v="angular tolerance gate before the trigger" />
          <Stat k="0" v="LLM tokens in the real-time loop" />
        </dl>
      </section>

      <section className="py-16">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Roadmap</h2>
        <ol className="mt-8 space-y-3 font-mono text-sm">
          <Road tag="now" text="This website: simulated navigation, the phone HUD (/hud) and a browser prototype of marker-based tracking (/markers, /hud → Cam)" />
          <Road tag="weeks" text="The SmartTools app: first public release, within the next month" />
          <Road tag="next" text="Printed dock on a real drill, error measured against a reference jig; then our own camera module if the phone is the limit" />
          <Road tag="next" text="Circular-saw bevel & cut-line guidance; driver sequencing" />
          <Road tag="demo day" text="Live drilling on stage, field pilot with workshops, error data logged in agentvcs" />
        </ol>
      </section>

      <footer className="flex flex-col gap-2 border-t border-white/10 py-10 font-mono text-xs text-white/40 sm:flex-row sm:justify-between">
        <span>
          SmartTools ·{" "}
          <a href="https://github.com/matiasmolinas/smarttools" className="underline decoration-white/20 hover:text-white">
            github.com/matiasmolinas/smarttools
          </a>{" "}
          · Apache 2.0
        </span>
        <span>Demo site: the navigation above is a simulation, and the camera mode is a prototype.</span>
      </footer>
    </main>
  );
}

function Legend({ color, title, body }: { color: string; title: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-white/10 p-4">
      <span className="mt-1 inline-block h-4 w-4 shrink-0 rounded-full border-2" style={{ borderColor: color }} />
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-1 text-sm text-white/55">{body}</p>
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-2xl border border-white/10 p-5">
      <dt className="font-mono text-2xl text-[var(--green)]">{k}</dt>
      <dd className="mt-2 text-sm text-white/55">{v}</dd>
    </div>
  );
}

function Road({ tag, text }: { tag: string; text: string }) {
  return (
    <li className="flex items-start gap-4 rounded-xl border border-white/10 p-4">
      <span className="w-20 shrink-0 uppercase text-[var(--cyan)]">{tag}</span>
      <span className="text-white/70">{text}</span>
    </li>
  );
}
