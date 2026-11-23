// contract-gatekeeper's verdict, native, where SmartTools needs it (docs/INTEGRATIONS.md):
//
//   gateRecipe     a recipe from outside (an expert, a file, later the cloud or an AI) before the engine sees it
//   gateChanges    a change set of this repository before it is merged and deployed (scripts/gate.mts)
//
// The same three verdicts as gatekeeper:
//   FAST_TRACK   inside the contract: go
//   ESCALATE     crosses a boundary: go only after the heavier check (a person for a recipe, the end-to-end run
//                and the engine tests for code)
//   REJECTED     breaks the contract: stop, with the reasons

import { validatePlan, type Plan } from "./plan.ts";
import { bindCheck, drillOf, parseRecipe, planFromRecipe, type Recipe } from "./recipe.ts";

export type Verdict = "FAST_TRACK" | "ESCALATE" | "REJECTED";

/** What the engine can tell apart (the tracker's measured steadiness), and how loose a Check may be before it
 * says nothing (wider than the drill's safe angle, deeper than the bit's slack). */
export const CHECK_BAND = { depthMm: [0.2, 2] as const, angleDeg: [0.2, 3] as const };

export interface RecipeGate {
  verdict: Verdict;
  reasons: string[];
  recipe?: Recipe;
  plan?: Plan;
  /** steps the person confirms on the phone (no measurement answers them) */
  manual: string[];
}

/** Gate a recipe (its Markdown). A plan comes out only when it is not rejected. */
export function gateRecipe(md: string, author: Plan["author"] = { kind: "expert" }, now?: string): RecipeGate {
  let recipe: Recipe;
  try {
    recipe = parseRecipe(md);
  } catch (e) {
    return { verdict: "REJECTED", reasons: [(e as Error).message], manual: [] };
  }
  const reject: string[] = [], escalate: string[] = [], manual: string[] = [];
  const plan = planFromRecipe(recipe, author, now);
  const drills = recipe.statements.filter((s) => drillOf(s.do));
  // a step that looks like a hole but does not read as one would be silently skipped: refuse it instead
  for (const s of recipe.statements) if (/^\s*drill\b/i.test(s.do) && !drillOf(s.do)) reject.push(`#${s.id}: "${s.do}" is not a hole the engine can read (Drill D1: Ø6 mm at (x, y) mm, 20 mm deep)`);
  if (!drills.length) reject.push("no Drill step: nothing for the engine to do");
  else {
    const v = validatePlan(plan);
    if (!v.ok) reject.push(...v.errors);
  }
  for (const s of recipe.statements) {
    const b = bindCheck(s.check);
    if (!drillOf(s.do)) {
      manual.push(`#${s.id}: ${s.do}${s.check ? ` (check: ${s.check})` : ""}`);
      continue;
    }
    if (!b.measures.length) escalate.push(`#${s.id}: its Check is not something the engine measures ("${s.check || "none"}"); a person must judge it`);
    else if (b.manual) manual.push(`#${s.id}: confirm "${b.manual}"`);
    for (const m of b.measures) {
      if (m.kind === "depth" && (m.tolMm < CHECK_BAND.depthMm[0] || m.tolMm > CHECK_BAND.depthMm[1]))
        escalate.push(`#${s.id}: depth ±${m.tolMm} mm is outside what the engine checks well (±${CHECK_BAND.depthMm[0]} to ±${CHECK_BAND.depthMm[1]} mm)`);
      if (m.kind === "angle" && (m.maxDeg < CHECK_BAND.angleDeg[0] || m.maxDeg > CHECK_BAND.angleDeg[1]))
        escalate.push(`#${s.id}: angle under ${m.maxDeg}° is outside what the engine checks well (${CHECK_BAND.angleDeg[0]}° to ${CHECK_BAND.angleDeg[1]}°)`);
    }
  }
  if (author.kind === "ai") escalate.push("written by an AI: a person reviews it before the first hole");
  if (reject.length) return { verdict: "REJECTED", reasons: reject, recipe, manual };
  return { verdict: escalate.length ? "ESCALATE" : "FAST_TRACK", reasons: escalate, recipe, plan, manual };
}

// ---------------- change sets of this repository ----------------

export interface Capsule {
  name: string;
  paths: string[];
  /** what touching it costs: FAST_TRACK (unit tests and build) or ESCALATE (engine tests and end-to-end too) */
  verdict: "FAST_TRACK" | "ESCALATE";
  why: string;
}

export interface GateConfig {
  capsules: Capsule[];
  commands: { FAST_TRACK: string[]; ESCALATE: string[] };
}

export interface ChangeGate {
  verdict: Verdict;
  /** each changed file and the capsule it falls in */
  touched: { file: string; capsule: string }[];
  reasons: string[];
  /** what to run before merging */
  run: string[];
}

/** `**` any path, `*` within one folder. */
export function glob(p: string): RegExp {
  const re = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`);
}

/**
 * Gate a change set. files: the changed paths; read: a file's text at the new revision (null if deleted).
 * The invariants are the mistakes that break the phone without breaking the build: the engine's Rust changed but
 * its WebAssembly was not rebuilt, the two sides of the ABI disagree, dependencies changed without the lock file.
 */
export function gateChanges(files: string[], read: (f: string) => string | null, cfg: GateConfig): ChangeGate {
  const caps = cfg.capsules.map((c) => ({ ...c, re: c.paths.map(glob) }));
  const touched = files.map((file) => ({ file, capsule: caps.find((c) => c.re.some((r) => r.test(file)))?.name ?? "(none)" }));
  const reasons: string[] = [];
  const reject: string[] = [];
  const has = (f: string) => files.includes(f);

  if (files.some((f) => /^engine\/src\/.*\.rs$/.test(f)) && !has("public/engine/nav_core.wasm"))
    reject.push("engine/src changed but public/engine/nav_core.wasm was not rebuilt (bash engine/build.sh): the phone would run the old engine");
  const ffi = read("engine/src/ffi.rs"), ts = read("lib/engine.ts");
  const abiRs = ffi && /ABI_VERSION:\s*u32\s*=\s*(\d+)/.exec(ffi)?.[1];
  const abiTs = ts && /ENGINE_ABI\s*=\s*(\d+)/.exec(ts)?.[1];
  if (abiRs && abiTs && abiRs !== abiTs) reject.push(`ABI mismatch: engine/src/ffi.rs says ${abiRs}, lib/engine.ts says ${abiTs}`);
  if (has("package.json") && !has("package-lock.json")) {
    const pkg = read("package.json");
    if (pkg && /"(?:dev)?[dD]ependencies"/.test(pkg)) reasons.push("package.json changed without package-lock.json: if a dependency changed, run npm install");
  }
  const loose = touched.filter((t) => t.capsule === "(none)").map((t) => t.file);
  if (loose.length) reasons.push(`outside every capsule (treated as shared code): ${loose.join(", ")}`);

  if (reject.length) return { verdict: "REJECTED", touched, reasons: [...reject, ...reasons], run: [] };
  const hit = caps.filter((c) => touched.some((t) => t.capsule === c.name));
  const esc = hit.filter((c) => c.verdict === "ESCALATE");
  const verdict: Verdict = esc.length || loose.length ? "ESCALATE" : "FAST_TRACK";
  for (const c of esc) reasons.unshift(`${c.name}: ${c.why}`);
  return { verdict, touched, reasons, run: verdict === "ESCALATE" ? cfg.commands.ESCALATE : files.length ? cfg.commands.FAST_TRACK : [] };
}

