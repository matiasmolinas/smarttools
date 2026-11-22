"use client";

// /benchmarks: bench runs (lib/bench.ts) as charts and tables. Runs come from three places: the published ones
// (public/benchmarks/index.json), the ones saved on this device by the bench lab (IndexedDB), and a file
// opened from disk. Simulated runs are always labelled as such.

import { useEffect, useMemo, useRef, useState } from "react";
import { PHASES, isBenchRun, type BenchRun, type BenchSample, type PhaseId, type PhaseSummary, type ToolPose } from "@/lib/bench";
import { browserMemory } from "@/lib/memory";

// validated (dataviz validator, dark surface #05080d): raw amber, filtered green
const RAW = "#c27c14";
const FILT = "#189e69";

type Listed = { id: string; title: string; source: "camera" | "simulation"; where: "published" | "device" | "file"; load: () => Promise<BenchRun> };

export default function BenchmarksView() {
  const [list, setList] = useState<Listed[]>([]);
  const [run, setRun] = useState<BenchRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      const out: Listed[] = [];
      try {
        const idx = (await (await fetch("/benchmarks/index.json")).json()) as { runs: { file: string; id: string; title: string; source: "camera" | "simulation" }[] };
        for (const r of idx.runs) out.push({ id: r.id, title: r.title, source: r.source, where: "published", load: async () => (await fetch(`/benchmarks/${r.file}`)).json() });
      } catch {}
      try {
        for (const r of await browserMemory().benchRuns()) out.push({ id: r.id, title: r.value.title, source: r.value.source, where: "device", load: async () => r.value });
      } catch {}
      // measured runs first
      out.sort((a, b) => (a.source === b.source ? 0 : a.source === "camera" ? -1 : 1));
      setList(out);
      if (out[0]) setRun(await out[0].load());
    })();
  }, []);

  const open = async (l: Listed) => {
    setErr(null);
    try {
      setRun(await l.load());
    } catch {
      setErr("Could not load that run.");
    }
  };
  const openFile = async (f: File) => {
    try {
      const r = JSON.parse(await f.text());
      if (!isBenchRun(r)) throw new Error();
      setList((l) => [{ id: r.id, title: r.title, source: r.source, where: "file", load: async () => r }, ...l.filter((x) => x.id !== r.id)]);
      setRun(r);
      setErr(null);
    } catch {
      setErr("Not a SmartTools bench run file.");
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {list.map((l) => (
          <button
            key={`${l.where}-${l.id}`}
            onClick={() => open(l)}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${run?.id === l.id ? "border-[var(--green)]/60 bg-[var(--green)]/10 text-white" : "border-white/15 text-white/65 hover:border-white/35"}`}
          >
            <span className={`mr-2 font-mono text-[10px] uppercase ${l.source === "camera" ? "text-[var(--green)]" : "text-[var(--amber)]"}`}>{l.source === "camera" ? "measured" : "simulated"}</span>
            {l.title.length > 48 ? `${l.title.slice(0, 47)}…` : l.title}
            {l.where !== "published" && <span className="ml-2 font-mono text-[10px] text-white/40">{l.where === "device" ? "this device" : "file"}</span>}
          </button>
        ))}
        <button onClick={() => fileRef.current?.click()} className="rounded-full border border-dashed border-white/25 px-3 py-1.5 text-sm text-white/60 hover:border-white/50">
          Open a run file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openFile(f);
            e.target.value = "";
          }}
        />
      </div>
      {err && <p className="mt-3 text-sm text-[#ff8a8a]">{err}</p>}
      {run ? <Run run={run} /> : <div className="mt-6 h-64 rounded-2xl border border-white/10" />}
    </div>
  );
}

// ---------------- one run ----------------

const PH_ORDER = Object.keys(PHASES) as PhaseId[];

function Run({ run }: { run: BenchRun }) {
  const sim = run.source === "simulation";
  return (
    <div className="mt-6 space-y-6">
      <div className={`rounded-2xl border p-5 ${sim ? "border-[var(--amber)]/30 bg-[var(--amber)]/[0.04]" : "border-[var(--green)]/30 bg-[var(--green)]/[0.04]"}`}>
        <div className={`font-mono text-[11px] uppercase tracking-wider ${sim ? "text-[var(--amber)]" : "text-[var(--green)]"}`}>{sim ? "Simulation · not a measurement" : "Measured on a real drill"}</div>
        <h3 className="mt-1 text-lg font-semibold">{run.title}</h3>
        <p className="mt-1 font-mono text-[11px] text-white/50">
          {new Date(run.created).toLocaleString()} · {run.phone.name} · {run.mount} · lens {run.calibration.lens ? "calibrated" : "not calibrated"} · dock {run.calibration.dock ? "calibrated" : "not calibrated"} · filter {Number(run.filter.posMinCutoff) >= 1000 ? "off" : "One Euro"}
        </p>
        {run.tracker && (
          <p className="mt-1 font-mono text-[11px] text-white/50">
            tracker: {Number(run.tracker.fps).toFixed(1)} frames/s · {Number(run.tracker.latencyMs).toFixed(0)} ms capture → pose · detect {Number(run.tracker.detectMs).toFixed(0)} ms
          </p>
        )}
        {run.notes && <p className="mt-2 text-sm text-white/65">{run.notes}</p>}
      </div>

      <Chart run={run} measure="angle" />
      <Chart run={run} measure="tip" />
      <SummaryTable summary={run.summary} />
    </div>
  );
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angDeg = (a: number[], b: number[]) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (Math.hypot(...a) * Math.hypot(...b))))) * 180) / Math.PI;

/** Each sample's deviation from its phase's mean (angle in deg, or tip distance in mm), raw and filtered. */
function deviations(samples: BenchSample[], measure: "angle" | "tip") {
  const out: { t: number; phase: PhaseId; raw: number | null; filt: number | null }[] = [];
  for (const ph of PH_ORDER) {
    const s = samples.filter((x) => x.phase === ph);
    if (!s.length) continue;
    const mean = (pick: (x: BenchSample) => ToolPose | null) => {
      const ps = s.map(pick).filter(Boolean) as ToolPose[];
      if (!ps.length) return null;
      const v = (k: "tip" | "axis") => [0, 1, 2].map((i) => ps.reduce((a, p) => a + p[k][i], 0) / ps.length);
      return { tip: v("tip"), axis: v("axis") };
    };
    const mr = mean((x) => x.raw), mf = mean((x) => x.filtered);
    const dev = (p: ToolPose | null, m: { tip: number[]; axis: number[] } | null) => (!p || !m ? null : measure === "angle" ? angDeg(p.axis, m.axis) : Math.hypot(p.tip[0] - m.tip[0], p.tip[1] - m.tip[1], p.tip[2] - m.tip[2]));
    for (const x of s) out.push({ t: x.t, phase: ph, raw: dev(x.raw, mr), filt: dev(x.filtered, mf) });
  }
  return out;
}

function Chart({ run, measure }: { run: BenchRun; measure: "angle" | "tip" }) {
  const W = 960, H = 240, L = 52, R = 12, T = 28, B = 30;
  const data = useMemo(() => deviations(run.samples, measure), [run, measure]);
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return null;
  // phases laid end to end on a common x axis (gaps between takes removed)
  const xs: number[] = [];
  const bands: { phase: PhaseId; x0: number; x1: number }[] = [];
  let off = 0;
  for (const ph of PH_ORDER) {
    const d = data.filter((x) => x.phase === ph);
    if (!d.length) continue;
    const t0 = d[0].t, t1 = d[d.length - 1].t;
    bands.push({ phase: ph, x0: off, x1: off + (t1 - t0) });
    for (const x of d) xs.push(off + (x.t - t0));
    off += t1 - t0 + 0.6;
  }
  const xMax = Math.max(off - 0.6, 1);
  const vals = data.flatMap((d) => [d.raw, d.filt]).filter((v): v is number => v != null);
  const yMax = Math.max(1e-6, ...vals.sort((a, b) => a - b).slice(0, Math.ceil(vals.length * 0.995))) * 1.1;
  const sx = (x: number) => L + (x / xMax) * (W - L - R);
  const sy = (y: number) => T + (1 - Math.min(y, yMax) / yMax) * (H - T - B);
  const path = (k: "raw" | "filt") => {
    let d = "", pen = false;
    data.forEach((p, i) => {
      const v = p[k];
      const brk = i > 0 && data[i - 1].phase !== p.phase;
      if (v == null || brk) pen = false;
      if (v == null) return;
      d += `${pen ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const unit = measure === "angle" ? "°" : " mm";
  const ticks = [0, yMax / 2, yMax].map((v) => ({ v, y: sy(v) }));
  const h = hover != null ? data[hover] : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (((e.clientX - r.left) / r.width) * W - L) / (W - L - R) * xMax;
    let best = 0;
    xs.forEach((v, i) => Math.abs(v - x) < Math.abs(xs[best] - x) && (best = i));
    setHover(best);
  };
  return (
    <figure className="rounded-2xl border border-white/10 p-4">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">{measure === "angle" ? "Bit direction: deviation from its mean (deg)" : "Bit tip: deviation from its mean position (mm)"}</span>
        <span className="flex gap-4 text-xs text-white/60">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: RAW }} />
            raw (each frame as measured)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: FILT }} />
            filtered (what the gate decides with)
          </span>
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full touch-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`${measure} deviation over time, raw and filtered, by phase`}>
        {bands.map((b, i) => (
          <g key={b.phase}>
            <rect x={sx(b.x0)} y={T} width={sx(b.x1) - sx(b.x0)} height={H - T - B} fill={i % 2 ? "rgba(255,255,255,0.025)" : "rgba(255,255,255,0.05)"} rx={4} />
            <text x={sx(b.x0) + 6} y={T - 8} fill="rgba(233,242,255,0.6)" fontSize={11} fontFamily="var(--font-geist-mono)">
              {PHASES[b.phase].label}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={L} x2={W - R} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.08)" />
            <text x={L - 6} y={t.y + 4} textAnchor="end" fill="rgba(233,242,255,0.5)" fontSize={10} fontFamily="var(--font-geist-mono)">
              {t.v.toFixed(measure === "angle" ? 2 : 2)}
            </text>
          </g>
        ))}
        <path d={path("raw")} fill="none" stroke={RAW} strokeWidth={1.5} strokeLinejoin="round" opacity={0.9} />
        <path d={path("filt")} fill="none" stroke={FILT} strokeWidth={2} strokeLinejoin="round" />
        {h && (
          <g>
            <line x1={sx(xs[hover!])} x2={sx(xs[hover!])} y1={T} y2={H - B} stroke="rgba(255,255,255,0.35)" />
            {h.raw != null && <circle cx={sx(xs[hover!])} cy={sy(h.raw)} r={4} fill={RAW} stroke="#05080d" strokeWidth={2} />}
            {h.filt != null && <circle cx={sx(xs[hover!])} cy={sy(h.filt)} r={4} fill={FILT} stroke="#05080d" strokeWidth={2} />}
          </g>
        )}
        <text x={L} y={H - 8} fill="rgba(233,242,255,0.45)" fontSize={10} fontFamily="var(--font-geist-mono)">
          time within each phase (s); phases end to end
        </text>
      </svg>
      <div className="mt-1 h-5 font-mono text-[11px] text-white/70">
        {h ? `${PHASES[h.phase].label} · raw ${h.raw?.toFixed(3) ?? "–"}${unit} · filtered ${h.filt?.toFixed(3) ?? "–"}${unit}` : "Hover the chart for values."}
      </div>
    </figure>
  );
}

function SummaryTable({ summary }: { summary: PhaseSummary[] }) {
  const f = (v: number | null | undefined, d = 3) => (v == null ? "–" : v.toFixed(d));
  const rows: [string, (s: PhaseSummary) => string][] = [
    ["frames · tracked", (s) => `${s.frames} · ${Math.round(s.tracked * 100)}%`],
    ["markers seen (median)", (s) => f(s.markers, 0)],
    ["reprojection error (px)", (s) => f(s.rmsPx, 2)],
    ["bit vs sheet normal (°)", (s) => f(s.filtered?.tiltDeg ?? s.raw?.tiltDeg, 2)],
    ["angle jitter, raw (° RMS)", (s) => f(s.raw?.angleJitterDeg)],
    ["angle jitter, filtered (° RMS)", (s) => f(s.filtered?.angleJitterDeg)],
    ["angle, filtered p95 (°)", (s) => f(s.filtered?.angleP95Deg)],
    ["angle jitter > 2 Hz, raw / filtered (°)", (s) => `${f(s.raw?.angleJitterHpDeg)} / ${f(s.filtered?.angleJitterHpDeg)}`],
    ["tip jitter, raw / filtered (mm RMS)", (s) => `${f(s.raw?.tipJitterMm)} / ${f(s.filtered?.tipJitterMm)}`],
    ["accelerometer (m/s² RMS)", (s) => f(s.accelRms, 2)],
    ["tip to A2 (mm)", (s) => (s.a2 ? `${f(s.a2.distanceMm, 2)} (plane ${f(s.a2.planarMm, 2)}, height ${f(s.a2.heightMm, 2)})` : "–")],
  ];
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-white/45">
          <tr>
            <th className="px-4 py-2 font-normal">measure</th>
            {summary.map((s) => (
              <th key={s.phase} className="px-4 py-2 font-normal">
                {PHASES[s.phase].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, get]) => (
            <tr key={k} className="border-b border-white/5 last:border-0">
              <td className="px-4 py-2 text-white/55">{k}</td>
              {summary.map((s) => (
                <td key={s.phase} className="px-4 py-2 font-mono text-[12px] text-white/85">
                  {get(s)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
