"use client";

// /memory: what this phone remembers (IndexedDB, lib/memory.ts). Plans (use, download, import, delete) and jobs
// (the report as HTML or JSON, the agentvcs ledger, the job as an athos recipe). Recipes come in through the gate
// (lib/gate.ts); jobs are compared by tracking setting (lib/vcs.ts, blame). Everything here works offline; the
// outbox shows what the cloud (F2) does not have yet.

import { useCallback, useEffect, useRef, useState } from "react";
import { BUILT_IN_PLANS, SHEET_PLAN, type Plan } from "@/lib/plan";
import type { JobRecord } from "@/lib/jobrecord";
import { activePlanId, browserMemory, setActivePlanId, type Row } from "@/lib/memory";
import { reportHtml } from "@/lib/report";
import { jobLedger } from "@/lib/ledger";
import { blame, summarize, verifyBundle, type Bundle } from "@/lib/vcs";
import { checkJob, recipeFromJob, recipeFromPlan, recipeOfPlan, tallyChecks, tallyText, type Recipe } from "@/lib/recipe";
import { gateRecipe, type RecipeGate } from "@/lib/gate";
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
  const recipeRef = useRef<HTMLInputElement>(null);
  const ledgerRef = useRef<HTMLInputElement>(null);
  // a recipe the gate escalated: kept until the person reviews it and accepts it, or drops it
  const [pending, setPending] = useState<RecipeGate | null>(null);

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

  const importRecipe = async (f: File) => {
    // no author passed: the recipe's own declaration counts, and a recipe that names nobody is treated as an AI's
    const g = gateRecipe(await f.text());
    setPending(null);
    if (g.verdict === "REJECTED" || !g.plan) return setMsg({ ok: false, text: `Recipe refused: ${g.reasons.join("; ")}.` });
    if (g.verdict === "ESCALATE") {
      setPending(g);
      return setMsg(null);
    }
    await saveRecipePlan(g);
  };
  /** reviewed: a person approved an escalated recipe; the plan keeps when */
  const saveRecipePlan = async (g: RecipeGate, reviewed = false) => {
    const r = await browserMemory().savePlan(reviewed && g.plan ? { ...g.plan, reviewed: new Date().toISOString() } : g.plan);
    setPending(null);
    setMsg(r.ok ? { ok: true, text: `Recipe "${r.plan.name}" saved as a plan (${r.plan.holes.length} holes)${g.manual.length ? `. Steps to do by hand: ${g.manual.join("; ")}` : ""}.` } : { ok: false, text: `Not saved: ${r.errors.join("; ")}.` });
    void load();
  };
  /** The person vouches for an undeclared recipe: gate it again as an expert's. */
  const trustRecipe = async (g: RecipeGate) => {
    const md = g.plan?.recipe?.md;
    if (!md) return;
    const again = gateRecipe(md, { kind: "expert" });
    if (again.verdict === "REJECTED" || !again.plan) {
      setPending(null);
      return setMsg({ ok: false, text: `Recipe refused: ${again.reasons.join("; ")}.` });
    }
    if (again.verdict === "ESCALATE") return setPending(again);
    await saveRecipePlan(again);
  };
  const checkLedger = async (f: File) => {
    try {
      const v = verifyBundle(JSON.parse(await f.text()) as Bundle);
      setMsg(v.ok ? { ok: true, text: `${f.name}: the ledger is intact (hashes, chain and manifest check out).` } : { ok: false, text: `${f.name}: ${v.errors.join("; ")}.` });
    } catch {
      setMsg({ ok: false, text: `${f.name}: not a ledger (JSON).` });
    }
  };
  const fileInput = (ref: React.RefObject<HTMLInputElement | null>, accept: string, f: (file: File) => void) => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) f(file);
        e.target.value = "";
      }}
    />
  );

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
      {pending && (
        <div className="rounded-2xl border border-[var(--amber)]/50 p-5 text-sm">
          <p className="font-semibold text-[var(--amber)]">Review this recipe before it becomes a plan: &ldquo;{pending.plan?.name}&rdquo;</p>
          <p className="mt-2 text-white/80">{writtenBy(pending)}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-white/70">
            {pending.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="rounded-full bg-[var(--amber)] px-3 py-1 text-xs font-semibold text-black" onClick={() => void saveRecipePlan(pending, true)}>
              I reviewed it: save the plan
            </button>
            {!pending.declared && (
              <button className="rounded-full border border-white/20 px-3 py-1 text-xs" onClick={() => void trustRecipe(pending)}>
                A person I trust wrote it
              </button>
            )}
            <button className="rounded-full border border-white/20 px-3 py-1 text-xs" onClick={() => setPending(null)}>
              Drop it
            </button>
          </div>
        </div>
      )}

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl font-semibold">Plans</h2>
          <div className="flex gap-2">
            <button className={btn} onClick={() => fileRef.current?.click()}>
              Import a plan file
            </button>
            {fileInput(fileRef, "application/json,.json", (f) => void importPlan(f))}
            <button className={btn} onClick={() => recipeRef.current?.click()}>
              Import a recipe (athos)
            </button>
            {fileInput(recipeRef, "text/markdown,.md,text/plain", (f) => void importRecipe(f))}
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
                  {p.reviewed ? " · reviewed" : ""}
                  {p.recipe ? " · recipe" : ""}
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
                  <button className={btn} onClick={() => download(`${slug(p.name)}.recipe.md`, recipeFromPlan(p), "text/markdown")}>
                    As a recipe
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

      <Compare jobs={jobs ?? []} />

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl font-semibold">Jobs</h2>
          <button className={btn} onClick={() => ledgerRef.current?.click()}>
            Verify a ledger file
          </button>
          {fileInput(ledgerRef, "application/json,.json", (f) => void checkLedger(f))}
        </div>
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
                <JobChecks job={j} recipe={recipeOfPlan(j.plan)} />
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
                  <button className={btn} onClick={() => download(`${slug(j.plan.name)}-${j.ended.slice(0, 10)}.recipe.md`, recipeFromJob(j), "text/markdown")}>
                    As a recipe (athos)
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

const CHECK_MARK = { pass: { mark: "✓", cls: "text-[var(--green)]" }, fail: { mark: "✗", cls: "text-[#ff8a8a]" }, manual: { mark: "?", cls: "text-[var(--amber)]" } } as const;

/** A job whose plan came from a recipe: its Checks, one per step (a hole not drilled fails: the job is finished). */
function JobChecks({ job, recipe }: { job: JobRecord; recipe: Recipe | null }) {
  if (!recipe) return null;
  const checks = checkJob(recipe, job);
  return (
    <div className="mt-2 font-mono text-[11px] text-white/50">
      <p className="text-white/70">Checks: {tallyText(tallyChecks(checks))}</p>
      <ul className="mt-1 space-y-0.5">
        {checks.map((c) => (
          <li key={c.id}>
            <span className={CHECK_MARK[c.outcome.status].cls}>{CHECK_MARK[c.outcome.status].mark}</span> {c.do} · {c.outcome.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Who wrote a recipe the gate escalated, for the review box. */
function writtenBy(g: RecipeGate): string {
  if (!g.declared) return "Author not stated: treated as written by an AI.";
  const who = g.author.kind === "ai" ? "an AI" : g.author.kind === "expert" ? "an expert" : "a person, by hand";
  return `Written by ${who}${g.author.name ? ` (${g.author.name})` : ""}.`;
}

const METRICS = [
  { key: "depth.error_mm", label: "Depth error", unit: "mm" },
  { key: "angle.max_deg", label: "Max angle", unit: "°" },
];

/** Which tracking setting goes with better holes, over this phone's camera jobs (agentvcs blame, lib/vcs.ts). */
function Compare({ jobs }: { jobs: Row<JobRecord>[] }) {
  const real = jobs.filter((r) => r.value.context.source === "camera" && r.value.holes.length);
  const rows = real.map((r) => summarize(jobLedger(r.value) as unknown as Bundle));
  const show = (v: string) => v.replace(/^"|"$/g, "");
  return (
    <section>
      <h2 className="text-xl font-semibold">Compare jobs by setting</h2>
      <p className="mt-1 text-sm text-white/55">
        Each job records how the phone tracked (detector, filter, detection size, camera). Lower is better. Two or more jobs per value before it means much.
      </p>
      {rows.length < 2 ? (
        <p className="mt-3 text-sm text-white/50">Needs at least two jobs with the camera, with a setting changed between them (menu ☰ → Tests).</p>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {METRICS.map((m) => {
            const b = blame(rows, m.key).slice(0, 3);
            return (
              <div key={m.key} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <h3 className="font-semibold">{m.label}</h3>
                {b.length === 0 && <p className="mt-2 text-sm text-white/50">No setting changed between these jobs.</p>}
                <ul className="mt-2 space-y-2 text-sm">
                  {b.map((x) => (
                    <li key={x.setting}>
                      <span className="font-mono text-xs text-white/60">{x.setting.replace(/^tracking\./, "")}</span>
                      {x.weak && <span className="ml-2 font-mono text-[10px] text-[var(--amber)]">few jobs</span>}
                      <div className="mt-0.5 font-mono text-xs">
                        {x.groups.map((g, i) => (
                          <span key={g.value} className={i === 0 ? "text-[var(--green)]" : "text-white/70"}>
                            {i ? " · " : ""}
                            {show(g.value)} {g.mean.toFixed(2)} {m.unit} ({g.jobs})
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
