import NavDemo from "@/components/NavDemo";

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
    d: "IMU + camera pose run at 60 fps in WebAssembly in the browser. Two rings: stack them on the crosshair and you are on target and square. 0 tokens at runtime.",
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
          href="https://github.com/EvolvingAgentsLabs"
          className="rounded-full border border-white/15 px-3 py-1.5 font-mono text-xs text-white/70 hover:border-white/40 hover:text-white"
        >
          GitHub ↗
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
      </header>

      <section aria-label="Live navigation demo" className="pb-6">
        <NavDemo />
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <Legend color="var(--amber)" title="Tip ring" body="Where the bit tip is relative to the crosshair. Bring it onto the mark." />
          <Legend color="var(--amber)" title="Chuck ring" body="Where the back of the bit projects. Off-centre = the drill is tilted." />
          <Legend color="var(--green)" title="Concentric = go" body="Both rings stacked on the crosshair: on target and square to the wall. Depth gauge stops you at 35 mm." />
        </div>
      </section>

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
            A language model cannot run a Kalman filter at 120 Hz or promise a 0.5° tolerance. So we split the system:
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
              <li>IMU + visual pose</li>
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
            dedicated workstation. Today a phone carries a 6-axis IMU, multiple cameras, depth sensing, an NPU and a
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
          <Road tag="now" text="Browser simulation of drill navigation (this page) + open-source stack" />
          <Road tag="next" text="Printed dock + marker-based pose on a real drill, measured against a reference jig" />
          <Road tag="next" text="Circular-saw bevel & cut-line guidance; driver sequencing" />
          <Road tag="demo day" text="Live drilling on stage, field pilot with workshops, error data logged in agentvcs" />
        </ol>
      </section>

      <footer className="flex flex-col gap-2 border-t border-white/10 py-10 font-mono text-xs text-white/40 sm:flex-row sm:justify-between">
        <span>SmartTools · EvolvingAgentsLabs</span>
        <span>The navigation shown above is a simulation running in your browser.</span>
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
