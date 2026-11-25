// athos, the part the phone needs, native (docs/INTEGRATIONS.md): a master's know-how as a recipe the phone works.
//
// A recipe is an athos piece: Markdown with a front matter (id, title, when, ...) and one statement per step,
//
//   ## #d1
//   **When:** The tip is on hole D1
//   **Do:** Drill D1: Ø6 mm at (0, 60) mm, 20 mm deep
//   **Check:** depth within 0.5 mm and angle under 1°
//   **Because:** ...
//   **Links:** [[#d2]]
//
// Here a Check is answered by the engine's measurements, not by a person or a model: bindCheck turns its words
// into measurements (depth, angle, position, score, no alarm); words it does not know are left for the person to confirm.
// A "Drill ..." step is a hole: planFromRecipe makes the plan the engine works, recipeFromPlan and recipeFromJob
// write one back (an expert's job becomes a recipe someone else can follow).
//
// Learning pieces on a frontier model, verifying them with a second one, routing and the agent hooks stay in
// athos: they need a computer and an AI agent.

import { DEFAULT_HOLE, PLAN_KIND, PLAN_VERSION, SHEET_ID, SHEET_PLAN, type Plan, type PlanHole } from "./plan.ts";
import type { Confirmation, HoleRecord, JobRecord } from "./jobrecord.ts";

export interface Statement {
  id: string;
  when: string;
  do: string;
  check: string;
  because: string;
  /** link targets as written: "#d2" (this piece) or "page#statement" */
  links: string[];
}

export interface Recipe {
  id: string;
  title: string;
  when: string;
  /** the rest of the front matter, as text */
  meta: Record<string, string>;
  statements: Statement[];
}

const FIELDS = { when: "When", do: "Do", check: "Check", because: "Because", links: "Links" } as const;

/** Read an athos piece. Throws when it has no statements (it is not a recipe). */
export function parseRecipe(md: string): Recipe {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const meta: Record<string, string> = {};
  let i = 0;
  if (lines[0]?.trim() === "---") {
    let parent = ""; // a key with no value on its line: its indented keys follow ("origin:\n  platform: x" → "origin.platform")
    for (i = 1; i < lines.length && lines[i].trim() !== "---"; i++) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
      if (m) {
        meta[m[1]] = unquote(m[2].trim());
        parent = m[2].trim() ? "" : m[1];
        continue;
      }
      const n = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]); // one level of nesting, no deeper
      if (n && parent) meta[`${parent}.${n[1]}`] = unquote(n[2].trim());
    }
    i++;
  }
  const statements: Statement[] = [];
  let cur: Statement | null = null;
  let field: keyof typeof FIELDS | null = null;
  let title = meta.title ?? "";
  for (; i < lines.length; i++) {
    const l = lines[i];
    const h = /^##\s+(.*)$/.exec(l);
    if (h) {
      const sid = /^#([\w.-]+)\s*$/.exec(h[1].trim());
      cur = sid ? { id: sid[1], when: "", do: "", check: "", because: "", links: [] } : null; // "## History" ends statements
      if (cur) statements.push(cur);
      field = null;
      continue;
    }
    const t = /^#\s+(.*)$/.exec(l);
    if (t && !title) title = t[1].trim();
    if (!cur) continue;
    const f = /^\*\*(When|Do|Check|Because|Links):\*\*\s*(.*)$/.exec(l);
    if (f) {
      field = (Object.keys(FIELDS) as (keyof typeof FIELDS)[]).find((k) => FIELDS[k] === f[1])!;
      if (field === "links") cur.links = links(f[2]);
      else cur[field] = f[2].trim();
    } else if (field && l.trim()) {
      if (field === "links") cur.links.push(...links(l));
      else cur[field] = `${cur[field]} ${l.trim()}`.trim();
    }
  }
  if (!statements.length) throw new Error("not a recipe: no statements (## #id)");
  return { id: meta.id ?? slug(title), title, when: meta.when ?? "", meta, statements };
}

export interface DeclaredAuthor {
  kind: "ai" | "expert" | "manual";
  name?: string;
  why: string;
}

/** Who the recipe says wrote it (author:, author_name:, or an agent's origin.platform); null when it says nothing. */
export function declaredAuthor(r: Recipe): DeclaredAuthor | null {
  const kind = r.meta.author?.trim().toLowerCase();
  const name = r.meta.author_name?.trim() || undefined;
  const why = { ai: "the recipe says an AI wrote it", expert: "the recipe says an expert wrote it", manual: "the recipe says a person wrote it by hand" };
  if (kind === "ai" || kind === "expert" || kind === "manual") return { kind, ...(name ? { name } : {}), why: why[kind] };
  const platform = r.meta["origin.platform"]?.trim();
  if (platform) return { kind: "ai", why: `learned by an agent (${platform})` };
  return null;
}

const unquote = (s: string) => (/^".*"$/.test(s) ? JSON.parse(s) : /^'.*'$/.test(s) ? s.slice(1, -1) : s);
const links = (s: string) => [...s.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "recipe";

// ---------------- Checks the engine answers ----------------

export type Measure =
  | { kind: "depth"; tolMm: number }
  | { kind: "angle"; maxDeg: number }
  | { kind: "position"; maxMm: number }
  | { kind: "score"; min: number }
  | { kind: "clean" };

export interface Binding {
  measures: Measure[];
  /** the words no measurement covers: the person confirms them ("" when the engine answers all of it) */
  manual: string;
}

const NUM = "(\\d+(?:[.,]\\d+)?)";
const VOCAB: { re: RegExp; make: (n: number) => Measure }[] = [
  { re: new RegExp(`depth(?:\\s+error)?\\s+(?:within|under|below|less than|at most|<=?|±)\\s*±?\\s*${NUM}\\s*mm`, "gi"), make: (n) => ({ kind: "depth", tolMm: n }) },
  { re: new RegExp(`angle(?:\\s+error)?\\s+(?:within|under|below|less than|at most|<=?)\\s*${NUM}\\s*(?:°|deg(?:rees?)?)`, "gi"), make: (n) => ({ kind: "angle", maxDeg: n }) },
  { re: new RegExp(`(?:position|offset)(?:\\s+error)?\\s+(?:within|under|below|less than|at most|<=?)\\s*${NUM}\\s*mm`, "gi"), make: (n) => ({ kind: "position", maxMm: n }) },
  { re: new RegExp(`score\\s+(?:at least|over|above|>=?)\\s*${NUM}`, "gi"), make: (n) => ({ kind: "score", min: n }) },
  { re: /\b(?:no alarms?|not flagged|no flags?)\b/gi, make: () => ({ kind: "clean" }) },
];

/** What of a Check the engine can answer, and what is left for the person. */
export function bindCheck(check: string): Binding {
  const measures: Measure[] = [];
  let rest = check;
  for (const v of VOCAB)
    rest = rest.replace(v.re, (...a: unknown[]) => {
      const n = typeof a[1] === "string" ? a[1] : null; // a pattern without a number gets the offset here
      measures.push(v.make(n == null ? 0 : Number(n.replace(",", "."))));
      return " ";
    });
  // what is left once the connectors and punctuation go: if words remain, a person must confirm them
  const left = rest.replace(/\b(?:and|both|the|is|are|with|y)\b/gi, " ").replace(/[\s.,;:()·-]+/g, " ").trim();
  return { measures, manual: /[a-z]{2,}/i.test(left) ? check.trim() : "" };
}

export type Outcome = { status: "pass" | "fail" | "manual"; detail: string };

/** Answer a bound Check with a drilled hole's record. */
export function evaluate(b: Binding, h: HoleRecord): Outcome {
  const fails: string[] = [], seen: string[] = [];
  for (const m of b.measures) {
    if (m.kind === "depth") {
      const err = h.seatedMm - h.plannedMm;
      (Math.abs(err) <= m.tolMm ? seen : fails).push(`depth ${err >= 0 ? "+" : ""}${err.toFixed(2)} mm (±${m.tolMm})`);
    } else if (m.kind === "angle") (h.maxAngleDeg <= m.maxDeg ? seen : fails).push(`angle ${h.maxAngleDeg.toFixed(2)}° (≤ ${m.maxDeg}°)`);
    // a hole recorded before the position was kept cannot pass a position Check
    else if (m.kind === "position") (h.offsetMm != null && h.offsetMm <= m.maxMm ? seen : fails).push(`position ${h.offsetMm != null ? `${h.offsetMm.toFixed(2)} mm` : "–"} (≤ ${m.maxMm} mm)`);
    else if (m.kind === "score") (h.score != null && h.score >= m.min ? seen : fails).push(`score ${h.score ?? "–"} (≥ ${m.min})`);
    else (h.flagged ? fails : seen).push(h.flagged ? `flagged: ${h.flagged}` : "no alarm");
  }
  if (fails.length) return { status: "fail", detail: fails.join(" · ") };
  if (b.manual) return { status: "manual", detail: [...seen, `confirm: ${b.manual}`].join(" · ") };
  return { status: "pass", detail: seen.join(" · ") };
}

// ---------------- recipes and plans ----------------

const DRILL = new RegExp(`^drill\\s+([A-Za-z0-9-]{1,12})\\s*:\\s*[Øø⌀]?\\s*${NUM}\\s*mm\\s+at\\s+\\(\\s*(-?${NUM.slice(1, -1)})\\s*,\\s*(-?${NUM.slice(1, -1)})\\s*\\)\\s*mm\\s*,\\s*${NUM}\\s*mm\\s+deep`, "i");

/** The hole a "Do" describes ("Drill D1: Ø6 mm at (0, 60) mm, 20 mm deep"), or null for any other step. */
export function drillOf(doText: string): PlanHole | null {
  const m = DRILL.exec(doText.trim());
  if (!m) return null;
  const n = (s: string) => Number(s.replace(",", "."));
  return { label: m[1], diameterMm: n(m[2]), x: n(m[3]), y: n(m[4]), depthMm: n(m[5]) };
}

export const drillText = (h: PlanHole) => `Drill ${h.label}: Ø${fmt(h.diameterMm)} mm at (${fmt(h.x)}, ${fmt(h.y)}) mm, ${fmt(h.depthMm)} mm deep`;
const fmt = (v: number) => String(Math.round(v * 10) / 10);

/** The plan a recipe's drill steps make (validate it with validatePlan before the engine sees it; lib/gate.ts does). */
export function planFromRecipe(r: Recipe, author: Plan["author"] = { kind: "expert" }, now = new Date().toISOString()): Plan {
  return {
    kind: PLAN_KIND,
    v: PLAN_VERSION,
    id: `recipe-${r.id}`,
    name: r.title || r.id,
    created: now,
    updated: now,
    author,
    reference: { kind: "sheet", id: SHEET_ID },
    holes: r.statements.map((s) => drillOf(s.do)).filter((h): h is PlanHole => !!h),
    ...(r.when ? { notes: r.when } : {}),
  };
}

export const DEFAULT_CHECK = "depth within 0.5 mm and angle under 1°";

/** A plan written as a recipe: one statement per hole, each with a Check the engine answers. */
export function recipeFromPlan(plan: Plan, o: { check?: string; because?: (h: PlanHole, i: number) => string; when?: string; id?: string } = {}): string {
  const id = o.id ?? slug(plan.name);
  const sid = (h: PlanHole) => h.label.toLowerCase().replace(/[^a-z0-9-]/g, "") || "hole";
  const body = plan.holes.map((h, i) => {
    const next = plan.holes[i + 1];
    return [
      `## #${sid(h)}`,
      `**When:** The tip is on hole ${h.label}`,
      `**Do:** ${drillText(h)}`,
      `**Check:** ${o.check ?? DEFAULT_CHECK}`,
      `**Because:** ${o.because?.(h, i) ?? (h.diameterMm === DEFAULT_HOLE.diameterMm ? "the plan's hole" : `a Ø${fmt(h.diameterMm)} mm bit`)}`,
      `**Links:** ${next ? `[[#${sid(next)}]]` : ""}`.trimEnd(),
    ].join("\n");
  });
  // a plan marked with the tool as a pointer was made by a person's hand
  const author = [`author: ${plan.author.kind === "pointer" ? "manual" : plan.author.kind}`, ...(plan.author.name ? [`author_name: ${plan.author.name}`] : [])];
  const front = ["---", `id: ${id}`, `title: ${plan.name}`, `when: ${JSON.stringify(o.when ?? `drilling the ${plan.holes.length} holes of "${plan.name}" on the SmartTools sheet`)}`, ...author, `projects: [smarttools]`, "---"].join("\n");
  return `${front}\n\n${body.join("\n\n")}\n`;
}

/** A finished job as a recipe: the plan's holes, and in each Because what the job measured there. */
export function recipeFromJob(job: JobRecord, check = DEFAULT_CHECK): string {
  const day = job.ended.slice(0, 10);
  return recipeFromPlan(job.plan, {
    check,
    id: `${slug(job.plan.name)}-${day}`,
    because: (h) => {
      const r = job.holes.find((x) => x.name === h.label);
      return r ? `done this way on ${day}: ${r.seatedMm.toFixed(1)} of ${r.plannedMm} mm, ${r.maxAngleDeg.toFixed(2)}° at most${r.flagged ? `, flagged: ${r.flagged}` : ""}` : `not drilled in the job of ${day}`;
    },
  });
}

// ---------------- Checks while a job is worked ----------------

/** One step of a recipe, answered: by the engine's measurements (a hole), by the person, or still open. */
export interface StepCheck {
  /** the statement id */
  id: string;
  do: string;
  /** the hole's label, for a Drill step */
  hole?: string;
  outcome: Outcome;
}

const answerOf = (id: string, confirmations?: readonly Confirmation[]) => confirmations?.find((c) => c.id === id);

/** A finished hole against its step: the statement whose Drill label is the hole's name (null when none is).
 * A Check with words the engine cannot measure stays "manual" until the person answers it: yes, and the
 * measurements decide; no, and it fails. */
export function checkHole(r: Recipe, h: HoleRecord, confirmations?: readonly Confirmation[]): StepCheck | null {
  const s = r.statements.find((x) => drillOf(x.do)?.label === h.name);
  if (!s) return null;
  const b = bindCheck(s.check);
  const out = evaluate(b, h);
  const a = b.manual ? answerOf(s.id, confirmations) : undefined;
  const step = { id: s.id, do: s.do, hole: h.name };
  if (out.status !== "manual" || !a) return { ...step, outcome: out };
  // what the measurements said, without the words left for the person
  const seen = evaluate({ measures: b.measures, manual: "" }, h).detail;
  if (!a.ok) return { ...step, outcome: { status: "fail", detail: [seen, `the person said no: ${b.manual}`].filter(Boolean).join(" · ") } };
  return { ...step, outcome: { status: "pass", detail: [seen, `confirmed: ${b.manual}`].filter(Boolean).join(" · ") } };
}

/** The steps for the person to confirm now, in order: not holes, not yet answered, and every Drill step written
 * before them done (before the first hole: the steps written before it). */
export function dueManual(r: Recipe, doneHoles: readonly string[], confirmed: readonly string[]): Statement[] {
  const out: Statement[] = [];
  let open = false; // an earlier hole is not done yet: nothing after it is due
  for (const s of r.statements) {
    const hole = drillOf(s.do);
    if (hole) {
      if (!doneHoles.includes(hole.label)) open = true;
      continue;
    }
    if (open) break;
    if (!confirmed.includes(s.id)) out.push(s);
  }
  return out;
}

/** Every step of a recipe against a job (finished or so far): holes answered by their records (a hole not in the
 * job fails, "not drilled"), other steps by the person's answers in job.confirmations, "manual" when unanswered. */
export function checkJob(r: Recipe, job: JobRecord): StepCheck[] {
  const conf = job.confirmations;
  return r.statements.map((s) => {
    const hole = drillOf(s.do);
    if (!hole) {
      const a = answerOf(s.id, conf);
      const words = s.check ? `: ${s.check}` : "";
      const outcome: Outcome = !a ? { status: "manual", detail: s.check ? `confirm: ${s.check}` : "confirm it was done" } : a.ok ? { status: "pass", detail: `confirmed${words}` } : { status: "fail", detail: `the person said no${words}` };
      return { id: s.id, do: s.do, outcome };
    }
    const rec = job.holes.find((h) => h.name === hole.label);
    if (!rec) return { id: s.id, do: s.do, hole: hole.label, outcome: { status: "fail", detail: "not drilled" } };
    return checkHole(r, rec, conf) ?? { id: s.id, do: s.do, hole: hole.label, outcome: evaluate(bindCheck(s.check), rec) };
  });
}

/** How many steps passed, failed and wait for the person. */
export function tallyChecks(list: readonly StepCheck[]): { pass: number; fail: number; manual: number } {
  const t = { pass: 0, fail: 0, manual: 0 };
  for (const c of list) t[c.outcome.status]++;
  return t;
}

export interface Tally {
  pass: number;
  fail: number;
  manual: number;
  /** holes not drilled yet, in a job still in progress */
  todo: number;
}

/** The tally of a job still in progress: a hole not drilled yet is still to do, not a fail (in a finished job,
 * tallyChecks(checkJob(...)) counts it as failed). */
export function tallySoFar(r: Recipe, job: JobRecord): Tally {
  const drilled = new Set(job.holes.map((h) => h.name));
  const t: Tally = { pass: 0, fail: 0, manual: 0, todo: 0 };
  for (const c of checkJob(r, job)) {
    if (c.hole && !drilled.has(c.hole)) t.todo++;
    else t[c.outcome.status]++;
  }
  return t;
}

/** A tally in words: "2 pass · 1 fail · 1 to confirm · 1 to drill" (pass and fail always, the others when not 0). */
export function tallyText(t: { pass: number; fail: number; manual: number; todo?: number }): string {
  return [`${t.pass} pass`, `${t.fail} fail`, ...(t.manual ? [`${t.manual} to confirm`] : []), ...(t.todo ? [`${t.todo} to drill`] : [])].join(" · ");
}

/** Development only (/hud?sim=1&recipe=1): the sheet's plan (A1-A3, the simulator's scene) with a recipe of its
 * own, so the three kinds of Check card can be seen: a step to confirm before the first hole, A2's Check with words
 * the engine cannot measure, and A1 / A3 answered by the measurements alone. */
export function simulatorRecipePlan(): Plan {
  const plan: Plan = { ...SHEET_PLAN, author: { kind: "ai" }, reviewed: SHEET_PLAN.created };
  const clamp = ["## #clamp", "**When:** Before the first hole", "**Do:** Clamp the work to the bench", "**Check:** the work does not move when pushed", "**Because:** a part that moves spoils every hole", "**Links:** [[#a1]]"].join("\n");
  const md = recipeFromPlan(plan, { id: "sheet-targets-sim" })
    .replace("\n## #a1\n", `\n${clamp}\n\n## #a1\n`)
    .replace(/(## #a2\n[\s\S]*?\*\*Check:\*\* )[^\n]*/, "$1depth within 0.5 mm and angle under 1° and flush with the surface");
  return { ...plan, recipe: { id: "sheet-targets-sim", md } };
}

/** The recipe a plan came from (plan.recipe), parsed; null when it has none or it cannot be read. Never throws. */
export function recipeOfPlan(plan: Plan): Recipe | null {
  const md = plan.recipe?.md;
  if (typeof md !== "string") return null;
  try {
    return parseRecipe(md);
  } catch {
    return null;
  }
}
