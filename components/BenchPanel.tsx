"use client";

// The bench lab on the phone screen (/hud → Bench): live readouts while you set up, then timed recordings
// of each phase (motor off, motor on, drilling, check on A2), the One Euro filter on or off, and a run file
// saved on the phone and downloaded. The protocol is docs/FIELD-TEST.md; the charts are on /benchmarks.

import { useEffect, useRef, useState } from "react";
import { DETECT_SIDES, type BrowserNav, type TrackerPerf } from "@/lib/tracker";
import { PHASES, summarize, type BenchRun, type PhaseId, type PhaseSummary } from "@/lib/bench";
import { browserMemory } from "@/lib/memory";

const MOUNTS = ["provisional mount", "dock v0.4"] as const;
const COUNTDOWN_S = 3;

type Live = ReturnType<NonNullable<BrowserNav["bench"]>["liveStats"]>;

export default function BenchPanel({
  tracker,
  say,
  onClose,
  realCamera = true,
  cameraRes = 1080,
  onCameraRes,
}: {
  tracker: () => BrowserNav | null;
  say: (m: string) => void;
  onClose: () => void;
  /** the real camera (the speed settings apply to it, not to the simulated one) */
  realCamera?: boolean;
  cameraRes?: 720 | 1080;
  onCameraRes?: (r: 720 | 1080) => void;
}) {
  const [perf, setPerf] = useState<TrackerPerf | null>(null);
  const [side, setSide] = useState<number>(960);
  const [live, setLive] = useState<Live | null>(null);
  const [rec, setRec] = useState<{ phase: PhaseId; left: number; countdown: number } | null>(null);
  const [done, setDone] = useState<PhaseSummary[]>([]);
  const [filterOn, setFilterOn] = useState(true);
  const [mount, setMount] = useState<(typeof MOUNTS)[number]>(MOUNTS[0]);
  const [accel, setAccel] = useState<number | null>(null);
  const countdownRef = useRef<{ phase: PhaseId; at: number } | null>(null);

  // open the lab on the tracker (and close it when the panel goes)
  useEffect(() => {
    const tr = tracker();
    tr?.openBench(true);
    if (tr) setFilterOn(tr.filterOn);
    return () => tracker()?.openBench(false);
  }, [tracker]);

  // the accelerometer, as a witness of how hard the motor shakes (never used for the pose)
  useEffect(() => {
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.acceleration;
      let m: number | null = null;
      if (a && a.x != null && a.y != null && a.z != null) m = Math.hypot(a.x, a.y, a.z);
      else {
        const g = e.accelerationIncludingGravity;
        if (g && g.x != null && g.y != null && g.z != null) m = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
      }
      if (m == null) return;
      setAccel(m);
      tracker()?.bench?.addAccel(performance.now() / 1000, m);
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [tracker]);

  // refresh the readouts, run the countdown, and notice when a phase ends
  useEffect(() => {
    const iv = setInterval(() => {
      const tr = tracker();
      // the engine may still have been loading when the panel opened
      if (tr && !tr.bench) {
        tr.openBench(true);
        setFilterOn(tr.filterOn);
      }
      const b = tr?.bench;
      if (tr) {
        setPerf(tr.perf());
        setSide(tr.maxSide);
      }
      if (!b) return;
      const now = performance.now() / 1000;
      setLive(b.liveStats());
      const cd = countdownRef.current;
      if (cd) {
        const left = cd.at - now;
        if (left <= 0) {
          b.start(cd.phase, now);
          countdownRef.current = null;
          say(`RECORDING · ${PHASES[cd.phase].label.toUpperCase()}`);
        } else setRec({ phase: cd.phase, left: PHASES[cd.phase].seconds, countdown: Math.ceil(left) });
        return;
      }
      if (b.current) setRec({ phase: b.current.phase, left: b.remaining(now), countdown: 0 });
      else if (rec) {
        setRec(null);
        const phases = b.recorded();
        setDone(phases.map((p) => summarize(p, b.samples, b.accel)));
        say(`DONE · ${PHASES[rec.phase].label.toUpperCase()}`);
      }
    }, 200);
    return () => clearInterval(iv);
  }, [tracker, rec, say]);

  const start = (p: PhaseId) => {
    if (!tracker()?.bench) return say("POINT THE CAMERA AT THE SHEET FIRST");
    if (rec) return;
    countdownRef.current = { phase: p, at: performance.now() / 1000 + COUNTDOWN_S };
    setRec({ phase: p, left: PHASES[p].seconds, countdown: COUNTDOWN_S });
  };

  const save = async () => {
    const tr = tracker(), b = tr?.bench;
    if (!tr || !b || !b.recorded().length) return say("RECORD A PHASE FIRST");
    const run = b.finish({
      source: "camera",
      title: `Bench ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${mount}`,
      mount,
      phone: { id: tr.phone.id, name: tr.phone.name },
      calibration: { lens: tr.calibrated.camera, dock: tr.calibrated.tool },
      filter: tr.filterConfig(),
      tracker: tr.perf() as unknown as BenchRun["tracker"],
      notes: "",
    });
    try {
      await browserMemory().saveBenchRun(run);
    } catch {}
    const url = URL.createObjectURL(new Blob([JSON.stringify(run)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `smarttools-bench-${run.created.slice(0, 16).replace(/[:T]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    tr.openBench(false);
    tr.openBench(true);
    setDone([]);
    say("RUN SAVED · ALSO ON /BENCHMARKS");
  };

  const f = (v: number | null | undefined, d = 2) => (v == null || Number.isNaN(v) ? "–" : v.toFixed(d));
  const btn = "rounded-full border border-white/25 px-3 py-1.5 text-[13px] hover:border-white/60 disabled:opacity-30";

  return (
    <div className="pointer-events-auto absolute left-[max(0.75rem,env(safe-area-inset-left))] top-[max(2.5rem,env(safe-area-inset-top))] max-h-[85dvh] w-[min(400px,calc(100vw-6rem))] overflow-y-auto rounded-2xl border border-white/20 bg-black/80 p-3 font-mono text-[13px] text-white/90 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-[#3ee59b]">BENCH LAB</span>
        <button onClick={onClose} className="text-white/60 hover:text-white">
          close ✕
        </button>
      </div>

      <div className="mt-2 rounded-lg border border-white/10 p-2">
        <div className="flex items-center justify-between">
          <span className="text-white/50">TRACKER SPEED</span>
          <span className={perf && perf.latencyMs > 150 ? "text-[#ff8a8a]" : "text-[#3ee59b]"}>{perf ? `${f(perf.latencyMs, 0)} ms` : "–"}</span>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
          <span className="text-white/50">frames/s · dropped/s</span>
          <span>{perf ? `${f(perf.fps, 1)} · ${f(perf.droppedPerS, 1)}` : "–"}</span>
          <span className="text-white/50">camera → detect px</span>
          <span>{perf ? `${perf.video.w}×${perf.video.h} → ${perf.detect.w}×${perf.detect.h}` : "–"}</span>
          <span className="text-white/50">copy · scale ms</span>
          <span>{perf ? `${f(perf.bitmapMs, 0)} · ${f(perf.drawMs, 0)}` : "–"}</span>
          <span className="text-white/50">detect · refine · pose</span>
          <span>{perf ? `${f(perf.detectMs, 0)} · ${f(perf.refineMs, 0)} · ${f(perf.poseMs, 0)}` : "–"}</span>
        </div>
        {realCamera && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              className={btn}
              onClick={() => {
                const tr = tracker();
                if (!tr) return;
                const next = DETECT_SIDES[(DETECT_SIDES.indexOf(tr.maxSide as (typeof DETECT_SIDES)[number]) + 1) % DETECT_SIDES.length];
                tr.setMaxSide(next);
                setSide(next);
                say(`DETECTION ${next} PX`);
              }}
            >
              detect {side} px
            </button>
            <button className={btn} onClick={() => onCameraRes?.(cameraRes === 1080 ? 720 : 1080)}>
              camera {cameraRes}p
            </button>
          </div>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
        <span className="text-white/50">tracked</span>
        <span>{live ? `${Math.round(live.tracked * 100)}% · ${live.markers} tags` : "–"}</span>
        <span className="text-white/50">bit vs sheet</span>
        <span>{f(live?.tiltDeg)}°</span>
        <span className="text-white/50">tip → A2</span>
        <span>{f(live?.toA2Mm, 1)} mm</span>
        <span className="text-white/50">jitter 1 s raw</span>
        <span>
          {f(live?.raw?.angleJitterDeg, 3)}° · {f(live?.raw?.tipJitterMm, 3)} mm
        </span>
        <span className="text-white/50">jitter 1 s filt.</span>
        <span>
          {f(live?.filtered?.angleJitterDeg, 3)}° · {f(live?.filtered?.tipJitterMm, 3)} mm
        </span>
        <span className="text-white/50">accelerometer</span>
        <span>{accel == null ? "no data" : `${f(accel, 2)} m/s²`}</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {(Object.keys(PHASES) as PhaseId[]).map((p) => (
          <button key={p} className={btn} disabled={!!rec} onClick={() => start(p)} title={PHASES[p].hint}>
            {done.some((d) => d.phase === p) ? "✓ " : ""}
            {PHASES[p].label} {PHASES[p].seconds}s
          </button>
        ))}
      </div>
      {rec && (
        <div className="mt-2 rounded-lg bg-[#3ee59b]/15 px-2 py-1.5 text-[#3ee59b]">
          {rec.countdown ? `${PHASES[rec.phase].label} starts in ${rec.countdown} s · ${PHASES[rec.phase].hint}` : `● ${PHASES[rec.phase].label}: ${rec.left.toFixed(1)} s left`}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          className={`${btn} ${filterOn ? "border-[#3ee59b] text-[#3ee59b]" : ""}`}
          onClick={() => {
            const tr = tracker();
            if (!tr) return;
            tr.setFilter(!filterOn);
            setFilterOn(!filterOn);
            say(!filterOn ? "FILTER ON (ONE EURO)" : "FILTER OFF (RAW POSES)");
          }}
        >
          filter {filterOn ? "on" : "off"}
        </button>
        <button className={btn} onClick={() => setMount(MOUNTS[(MOUNTS.indexOf(mount) + 1) % MOUNTS.length])}>
          {mount}
        </button>
        <button className={`${btn} border-[#3ee59b] bg-[#3ee59b] font-semibold text-black`} onClick={save}>
          save run
        </button>
      </div>

      {done.length > 0 && (
        <table className="mt-3 w-full text-left">
          <thead className="text-white/45">
            <tr>
              <th className="font-normal">phase</th>
              <th className="font-normal">angle σ raw/filt</th>
              <th className="font-normal">tip σ mm</th>
            </tr>
          </thead>
          <tbody>
            {done.map((d) => (
              <tr key={d.phase}>
                <td>{PHASES[d.phase].label.split(" ")[0]}{d.phase === "motor-on" ? " on" : d.phase === "motor-off" ? " off" : ""}</td>
                <td>
                  {f(d.raw?.angleJitterDeg, 3)}/{f(d.filtered?.angleJitterDeg, 3)}°
                </td>
                <td>
                  {d.a2 ? `A2 ${f(d.a2.distanceMm, 2)}` : `${f(d.raw?.tipJitterMm, 3)}/${f(d.filtered?.tipJitterMm, 3)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-[10px] leading-snug text-white/45">Prediction is off while the lab is open: "filtered" is the pose the gate decides with. Protocol: docs/FIELD-TEST.md.</p>
    </div>
  );
}
