// /benchmarks: the build log. What the navigation measures on a real drill (motor off, motor on, drilling),
// raw against filtered, how the tool is calibrated, and what each run found. Simulated runs are labelled.

import type { Metadata } from "next";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import BenchmarksView from "@/components/BenchmarksView";

export const metadata: Metadata = {
  title: "SmartTools benchmarks: motor off vs motor on, measured",
  description: "How steady a phone-mounted drill's navigation stays when the motor runs: raw vs filtered poses, the tip checked against a printed target, and the build log.",
};

const LOG = [
  {
    date: "2026-11-21",
    title: "The bench lab, and what the simulation already shows",
    body: [
      "The phone app (/hud → Bench) now records timed phases (motor off, motor on, drilling, the tip on A2) with every frame's raw pose and the filtered pose the go/no-go gate decides with, plus the accelerometer as a witness of the motor's shake. The navigation never uses the accelerometer: it is purely optical.",
      "In the simulated reference, with a modelled 35 Hz motor shake, the One Euro filter halves the bit's angular jitter (0.17° → 0.09° RMS), but the filtered tip moves slightly more than the raw one (0.32 vs 0.23 mm RMS). The cause: the filter smooths the camera's pose, rotation more than translation, and 20 cm ahead at the tip those two stop cancelling. The fix is to filter at the tip. The real runs will say how much it matters.",
    ],
  },
];

export default function Benchmarks() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 sm:px-6">
      <SiteNav audience="developers" />

      <header className="pb-8 pt-10 sm:pt-14">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Benchmarks · build log</p>
        <h1 className="max-w-4xl text-4xl font-semibold leading-[1.06] tracking-tight sm:text-5xl">
          Motor off, motor on.
          <br />
          <span className="text-[var(--green)]">Measured, not promised.</span>
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/65">
          A phone on a running drill shakes. These runs show how much of that reaches the navigation: every camera frame
          as measured, and the filtered pose the go/no-go gate decides with.
        </p>
      </header>

      <section className="grid gap-4 pb-10 lg:grid-cols-3">
        {[
          ["Stability (precision)", "How much the bit's measured direction and tip move while the drill is held still: motor off, then on. RMS around the mean; the part above 2 Hz is what the motor adds."],
          ["Accuracy, at one point", "With the tip resting on the printed target A2, how far the measured tip is from it. A real reference, not just steadiness."],
          ["What it does not prove yet", "Accuracy across the whole sheet, at depth, and on other drills and phones. Those come next; each run says what it is."],
        ].map(([k, v]) => (
          <article key={k} className="rounded-2xl border border-white/10 p-5">
            <h2 className="font-semibold">{k}</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">{v}</p>
          </article>
        ))}
      </section>

      <section id="runs" className="scroll-mt-4 pb-12">
        <BenchmarksView />
      </section>

      <section id="calibration" className="scroll-mt-4 py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">How the bit is found</p>
        <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div className="space-y-4 leading-relaxed text-white/65">
            <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">The phone sees the markers. Calibration finds the bit.</h2>
            <p>
              The camera knows where it is relative to the printed sheet. Where the bit is, relative to the camera, depends
              on the phone, the mount and the bit. So it is measured, once per mount, in 10 seconds:
            </p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                <b className="text-white">Pivot (5 s).</b> The tip rests on target A2 and the drill circles around it. The one point that stays
                still in every view is the tip.
              </li>
              <li>
                <b className="text-white">Roll (5 s).</b> Same spot, the drill twists around its own bit. The line that stays still is the
                bit&apos;s axis.
              </li>
              <li>
                <b className="text-white">Check.</b> Rest the tip on A2 again: the app reports how far the measured tip is from it, in mm.
              </li>
            </ol>
            <p className="text-sm text-white/50">
              Depth is then geometry: how far the calibrated tip has gone past the surface along the planned axis, whatever the
              bit&apos;s length or the mount&apos;s angle.
            </p>
          </div>
          <CalibrationDiagram />
        </div>
      </section>

      <section id="log" className="scroll-mt-4 py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">Build log</p>
        <div className="space-y-4">
          {LOG.map((e) => (
            <article key={e.date + e.title} className="rounded-2xl border border-white/10 p-6">
              <div className="font-mono text-[11px] text-white/45">{e.date}</div>
              <h3 className="mt-1 text-lg font-semibold">{e.title}</h3>
              {e.body.map((p) => (
                <p key={p.slice(0, 20)} className="mt-3 max-w-4xl text-sm leading-relaxed text-white/65">
                  {p}
                </p>
              ))}
            </article>
          ))}
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

function CalibrationDiagram() {
  const c = { cyan: "#5ad8ff", green: "#3dffa8", amber: "#ffb547", ink: "rgba(233,242,255,0.75)", dim: "rgba(233,242,255,0.35)" };
  return (
    <svg viewBox="0 0 520 360" className="w-full rounded-2xl border border-white/10 bg-white/[0.02]" role="img" aria-label="Calibration: the drill circles around the tip on A2 (pivot), then twists around its bit (roll)">
      {/* the sheet, in perspective */}
      <path d="M40 300 L300 300 L480 250 L220 250 Z" fill="rgba(255,255,255,0.06)" stroke={c.dim} />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={110 + i * 70} y={268} width={22} height={14} fill={c.dim} opacity={0.6} transform="skewX(-35)" />
      ))}
      <circle cx={260} cy={276} r={5} fill="none" stroke={c.amber} strokeWidth={2} />
      <text x={272} y={296} fill={c.amber} fontSize={12} fontFamily="monospace">
        A2 (the tip rests here)
      </text>
      {/* pivot cone: three drill positions around the tip */}
      {[-24, 0, 24].map((deg, i) => (
        <g key={deg} transform={`rotate(${deg} 260 276)`} opacity={i === 1 ? 1 : 0.45}>
          <line x1={260} y1={276} x2={260} y2={130} stroke={c.ink} strokeWidth={3} />
          <rect x={244} y={92} width={32} height={40} rx={4} fill="none" stroke={c.ink} />
          <rect x={276} y={60} width={16} height={42} rx={3} fill="none" stroke={c.cyan} />
          <circle cx={284} cy={92} r={4} fill={c.cyan} />
        </g>
      ))}
      <path d="M190 190 A 80 30 0 0 0 330 190" fill="none" stroke={c.green} strokeWidth={2} strokeDasharray="5 4" />
      <text x={334} y={188} fill={c.green} fontSize={12} fontFamily="monospace">
        1 · pivot: circle around the tip
      </text>
      {/* roll arrow around the bit */}
      <path d="M244 160 A 18 7 0 1 0 278 160" fill="none" stroke={c.green} strokeWidth={2} />
      <path d="M278 160 l-7 -4 m7 4 l-7 4" stroke={c.green} strokeWidth={2} />
      <text x={20} y={150} fill={c.green} fontSize={12} fontFamily="monospace">
        2 · roll: twist around the bit
      </text>
      <text x={296} y={50} fill={c.cyan} fontSize={12} fontFamily="monospace">
        phone camera
      </text>
      <text x={20} y={340} fill={c.dim} fontSize={11} fontFamily="monospace">
        what stays still: the tip (pivot), the bit&apos;s axis (roll)
      </text>
    </svg>
  );
}
