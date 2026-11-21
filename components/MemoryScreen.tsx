"use client";

// /memory: what this phone remembers (IndexedDB, lib/memory.ts). Plans (use, download, import, delete) and jobs
// (the report as HTML or JSON, the agentvcs ledger). Everything here works offline; the outbox shows what the
// cloud (F2) does not have yet.

import { useCallback, useEffect, useRef, useState } from "react";
import { BUILT_IN_PLANS, SHEET_PLAN, type Plan } from "@/lib/plan";
import type { JobRecord } from "@/lib/jobrecord";
import { activePlanId, browserMemory, setActivePlanId, type Row } from "@/lib/memory";
import { reportHtml } from "@/lib/report";
import { jobLedger } from "@/lib/ledger";
import { PHASES, type BenchRun } from "@/lib/bench";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "plan";
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export default function MemoryScreen() {
  const [plans, setPlans] = useState<Row<Plan>[] | null>(null);
  const [jobs, setJobs] = useState<Row<JobRecord>[] | null>(null);
  const [bench, setBench] = useState<Row<BenchRun>[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [outbox, setOutbox] = useState(0);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const m = browserMemory();
      const [p, j, o] = await Promise.all([m.plans(), m.jobs(), m.outbox()]);
      setPlans(p);
      setJobs(j);
      setBench(await m.benchRuns().catch(() => []));
      setOutbox(o.plans.length + o.jobs.length);
    } catch {
      setPlans([]);
      setJobs([]);
      setMsg({ ok: false, text: "This browser does not allow local storage here (private window?). Nothing can be kept." });
    }
    setActive(activePlanId());
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const use = (id: string | null) => {
    setActivePlanId(id);
    setActive(id);
    setMsg({ ok: true, text: "The phone app will work this plan next time it opens." });
  };

  const importPlan = async (f: File) => {
    try {
      const r = await browserMemory().savePlan(JSON.parse(await f.text()));
      setMsg(r.ok ? { ok: true, text: `Imported "${r.plan.name}" (${r.plan.holes.length} holes).` } : { ok: false, text: `Not imported: ${r.errors.join("; ")}.` });
    } catch {
      setMsg({ ok: false, text: "Not imported: the file is not JSON." });
    }
    void load();
  };

  const card = "rounded-2xl border border-white/10 bg-white/[0.02]";
  const btn = "rounded-full border border-white/20 px-3 py-1 text-xs hover:border-white/50";

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className={`rounded-full border px-3 py-1 font-mono text-xs ${outbox ? "border-[var(--amber)]/40 text-[var(--amber)]" : "border-white/15 text-white/50"}`}>
          {outbox} not in the cloud yet · sync arrives with F2
        </span>
        <span className="font-mono text-xs text-white/45">
          {persisted === true ? "storage: kept by the browser" : persisted === false ? "storage: the browser may clear it under pressure; download what matters" : ""}
        </span>
      </div>
      {msg && <p className={`text-sm ${msg.ok ? "text-[var(--green)]" : "text-[#ff8a8a]"}`}>{msg.text}</p>}

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl font-semibold">Plans</h2>
          <div className="flex gap-2">
            <button className={btn} onClick={() => fileRef.current?.click()}>
              Import a plan file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importPlan(f);
                e.target.value = "";
              }}
            />
            <a href="/hud" className="rounded-full bg-[var(--green)] px-3 py-1 text-xs font-semibold text-black">
              Plan on the phone →
            </a>
          </div>
        </div>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...BUILT_IN_PLANS.map((p) => ({ id: p.id, value: p, updated: p.updated, synced: true }) as Row<Plan>), ...(plans ?? [])].map((r) => {
            const p = r.value;
            const isActive = (active ?? SHEET_PLAN.id) === p.id;
            const builtIn = BUILT_IN_PLANS.some((b) => b.id === p.id);
            return (
              <li key={r.id} className={`${card} p-5 ${isActive ? "border-[var(--green)]/50" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{p.name}</h3>
                  {isActive && <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--green)]">in use</span>}
                </div>
                <p className="mt-1 font-mono text-[11px] text-white/45">
                  {p.holes.length} holes · by {p.author.kind}
                  {builtIn ? " · built in" : ` · ${when(r.updated)}${r.synced ? "" : " · not synced"}`}
                </p>
                <p className="mt-2 text-xs text-white/55">{p.holes.map((h) => `${h.label} ${h.depthMm} mm`).join(" · ")}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {!isActive && (
                    <button className={btn} onClick={() => use(p.id === SHEET_PLAN.id ? null : p.id)}>
                      Use
                    </button>
                  )}
                  <button className={btn} onClick={() => download(`${slug(p.name)}.plan.json`, JSON.stringify(p, null, 2), "application/json")}>
                    Download
                  </button>
                  {!builtIn && (
                    <button
                      className={`${btn} text-white/50`}
                      onClick={async () => {
                        await browserMemory().deletePlan(p.id);
                        if (active === p.id) use(null);
                        void load();
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl font-semibold">Bench runs</h2>
          <a href="/benchmarks" className={btn}>
            See the charts →
          </a>
        </div>
        {bench.length === 0 && <p className="mt-3 text-sm text-white/50">No runs yet. On the phone, open /hud, turn on the camera and tap Bench.</p>}
        <ul className="mt-4 space-y-3">
          {bench.map((r) => {
            const b = r.value;
            return (
              <li key={r.id} className={`${card} p-5`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-semibold">{b.title}</h3>
                  <span className="font-mono text-[11px] text-white/45">
                    {when(b.created)} · {b.phone.name} · {b.mount}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[11px] text-white/55">
                  {b.summary.map((s) => `${PHASES[s.phase].label}: ${s.raw?.angleJitterDeg.toFixed(3) ?? "–"}° raw / ${s.filtered?.angleJitterDeg.toFixed(3) ?? "–"}° filtered${s.a2 ? `, A2 ${s.a2.distanceMm} mm` : ""}`).join(" · ")}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button className={btn} onClick={() => download(`smarttools-bench-${b.created.slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(b), "application/json")}>
                    Download run
                  </button>
                  <button
                    className={`${btn} text-white/50`}
                    onClick={async () => {
                      await browserMemory().deleteBenchRun(b.id);
                      void load();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Jobs</h2>
        {jobs && jobs.length === 0 && <p className="mt-3 text-sm text-white/50">No jobs yet. On the phone, drill the plan&apos;s holes and tap Finish job.</p>}
        <ul className="mt-4 space-y-3">
          {(jobs ?? []).map((r) => {
            const j = r.value;
            const s = j.report.summary;
            return (
              <li key={r.id} className={`${card} p-5`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-semibold">{j.plan.name}</h3>
                  <span className="font-mono text-[11px] text-white/45">
                    {when(j.ended)} · {j.status} · {j.context.source} · {j.context.phone.name}
                    {r.synced ? "" : " · not synced"}
                  </span>
                </div>
                <p className={`mt-2 text-sm ${s.redo ? "text-[#ff8a8a]" : "text-[var(--green)]"}`}>{j.report.verdict}</p>
                <p className="mt-1 font-mono text-[11px] text-white/50">
                  {j.holes.map((h) => `${h.name} ${h.seatedMm.toFixed(1)}/${h.plannedMm} mm ${h.maxAngleDeg.toFixed(2)}°`).join(" · ")}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button className={btn} onClick={() => download(`${slug(j.plan.name)}-report.html`, reportHtml(j.report, j.context.source), "text/html")}>
                    Report (HTML)
                  </button>
                  <button className={btn} onClick={() => download(`${slug(j.plan.name)}-job.json`, JSON.stringify(j, null, 2), "application/json")}>
                    Job record (JSON)
                  </button>
                  <button className={btn} onClick={() => download(`${slug(j.plan.name)}-ledger.json`, JSON.stringify(jobLedger(j), null, 2), "application/json")}>
                    agentvcs ledger
                  </button>
                  <button
                    className={`${btn} text-white/50`}
                    onClick={async () => {
                      await browserMemory().deleteJob(j.id);
                      void load();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
