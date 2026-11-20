// Home page, for makers: people who will use SmartTools on their own work. One promise, three steps to do
// (print, mount, work) and a job to watch. Everything for developers (the engine, the open-source projects,
// the platform demos, the numbers) is on /developers. The reasoning is in docs/SITE.md.

import AssemblyHero from "@/components/gallery/AssemblyHero";
import ScenarioGallery from "@/components/gallery/ScenarioGallery";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";

type Item = { t: string; d: string; link?: { href: string; label: string }; soon?: boolean; demos?: (readonly [string, string])[] };
type Step = { n: string; k: string; t: string; color: string; items: Item[] };

const DOCK = "https://github.com/matiasmolinas/smarttools/tree/main/hardware/dock";

const STEPS: Step[] = [
  {
    n: "1",
    k: "Print",
    t: "Your dock, your sheet and your markers.",
    color: "var(--amber)",
    items: [
      { t: "The dock", d: "Four plastic parts and an M5 bolt, about $20. It clamps behind the chuck of any drill from Ø38 to 68 mm.", link: { href: DOCK, label: "Get the STL files ↗" } },
      { t: "Your sheet", d: "One A4 page of printed markers, at 100%. It is the reference: tape it beside the work.", link: { href: "/markers", label: "Print the sheet →" } },
      { t: "Markers for your parts", d: "Stickers you put on a part, so it stays located when you move it or flip it.", soon: true, demos: [["assembly-anchors", "See stickers on a part"]] },
    ],
  },
  {
    n: "2",
    k: "Mount",
    t: "Put it on your screwdriver.",
    color: "var(--cyan)",
    items: [
      { t: "Clamp it and slide in the phone", d: "The dock holds the phone behind the bit, its camera looking past the tip at the work." },
      { t: "Calibrate once", d: "Once per phone, wave it over the sheet for 20 s. Once per drill, rest the tip on a target and circle the drill for 10 s.", demos: [["calibrate", "Watch the calibration"]] },
      { t: "More tools are coming", d: "Today, the cordless drill / screwdriver. Next, the circular saw, with bevel and cut lines. Then every tool in your hands.", soon: true },
    ],
  },
  {
    n: "3",
    k: "Work",
    t: "Register, plan, operate.",
    color: "var(--green)",
    items: [
      { t: "Register your work area", d: "The phone finds the sheet and knows where the wall, the bench or the jig is." },
      { t: "Register your parts", d: "Touch four points with the bit tip, or let the markers do it: the part's model snaps onto the real part.", demos: [["assembly-register", "Touch four points"], ["assembly-factory", "Parts with their own markers"]] },
      { t: "Register your tool", d: "After calibration it knows where the tip is, which way the bit points and how deep it went." },
      { t: "Plan with your tool as a pointer", d: "Touch where each hole goes and set its depth. The bit tip is the pen.", soon: true },
      {
        t: "Operate, with your plan or an expert's",
        d: "The next hole glows on the part, a tone tells you when you are square, and the gate stops you before a mistake. Or follow an expert's plan, step by step, with their ghost to copy.",
        demos: [
          ["assembly-handsfree", "Hands-free: tap, twist, listen"],
          ["assembly-coach", "Follow an expert's ghost"],
          ["assembly-remote", "An expert adds a hole from afar"],
          ["no-go", "It says no before a pipe"],
        ],
      },
    ],
  },
];

const MAKER_CATS = ["assembly", "drilling"] as const;

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 sm:px-6">
      <SiteNav audience="makers" />

      <header className="pb-10 pt-10 sm:pt-16">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">For the drill you already own</p>
        <h1 className="max-w-4xl text-4xl font-semibold leading-[1.04] tracking-tight sm:text-6xl lg:text-7xl">
          Every hole in its place.
          <br />
          <span className="text-[var(--green)]">Every screw square.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/65 sm:text-xl">
          Clip your phone to your screwdriver. It sees the part, knows where every hole goes, and guides your hands to
          half a degree, with a light on the part and a tone in your ear.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a href="#steps" className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/90">
            Start in three steps ↓
          </a>
          <a href="#build" className="rounded-full border border-white/20 px-5 py-2.5 text-sm font-semibold text-white hover:border-white/50">
            Watch a job →
          </a>
          <span className="font-mono text-xs text-white/40">Demo site · the app ships in the coming weeks</span>
        </div>
      </header>

      <section id="steps" className="scroll-mt-4 py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">How it works</p>
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight sm:text-4xl">Print. Mount. Work.</h2>
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {STEPS.map((s) => (
            <article key={s.n} className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-6">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-4xl" style={{ color: s.color }}>
                  {s.n}
                </span>
                <span className="font-mono text-xs uppercase tracking-wider" style={{ color: s.color }}>
                  {s.k}
                </span>
              </div>
              <h3 className="mt-3 text-xl font-semibold">{s.t}</h3>
              <ul className="mt-5 flex-1 space-y-4 border-t border-white/10 pt-4">
                {s.items.map((i) => (
                  <li key={i.t}>
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {i.t}
                      {i.soon && <span className="rounded-full border border-[var(--amber)]/40 px-2 py-0.5 font-mono text-[10px] font-normal text-[var(--amber)]">coming with the app</span>}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-white/55">{i.d}</p>
                    {i.link && (
                      <a href={i.link.href} className="mt-1.5 inline-block text-sm text-[var(--cyan)] hover:underline">
                        {i.link.label}
                      </a>
                    )}
                    {i.demos && (
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                        {i.demos.map(([id, label]) => (
                          <a key={id} href={`#scenario-${id}`} className="text-white/70 hover:text-white">
                            <span className="mr-1.5 text-white/35">▶</span>
                            {label}
                          </a>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a href="/hud" className="rounded-full bg-[var(--green)] px-5 py-2.5 text-sm font-semibold text-black hover:brightness-110">
            Open the app on your phone →
          </a>
          <span className="font-mono text-[11px] text-white/40">Runs in the browser. Point it at the printed sheet to see it track.</span>
        </div>
      </section>

      <section id="build" aria-label="One job, start to finish" className="scroll-mt-4 py-12">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">One job, start to finish: a robot-arm base, 10 screws, 3 faces.</h2>
          <span className="font-mono text-[11px] text-white/40">left: the workshop in 3D · right: what the phone shows</span>
        </div>
        <AssemblyHero />
      </section>

      <ScenarioGallery cats={MAKER_CATS} title="Every step, working." />

      <section className="py-12">
        <div className="grid gap-6 rounded-2xl border border-white/10 p-6 sm:p-8 lg:grid-cols-[1.4fr_1fr] lg:items-center">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-[var(--amber)]">Honest status</p>
            <p className="mt-3 text-white/70">
              The demos run the real navigation engine on simulated cameras. The phone app in the browser tracks the
              printed sheet today. The dock has not yet been printed and measured on a real drill, and the full app ships
              in the coming weeks. Do not drill where a mistake can hurt someone.
            </p>
          </div>
          <div className="lg:border-l lg:border-white/10 lg:pl-6">
            <p className="font-semibold">Building on it?</p>
            <p className="mt-1 text-sm text-white/55">The engine, the 3D, 2D and AR views, and the open-source projects around them.</p>
            <a href="/developers" className="mt-3 inline-block rounded-full border border-white/20 px-4 py-2 text-sm hover:border-white/50">
              For developers →
            </a>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
