// The architecture as data: what runs on the phone, what runs in the cloud, the files that cross between them,
// and in which phase each piece arrives. The /architecture page draws it in 3D and lists it as text; the test
// checks the rule (nothing from the cloud on the real-time path). The decision is docs/ARCHITECTURE.md.

export type Side = "phone" | "cloud" | "ci";
export type Phase = 1 | 2 | 3;

export interface Block {
  id: string;
  side: Side;
  label: string;
  /** one line, shown on hover and in the lists */
  what: string;
  phase: Phase;
  /** part of the camera → engine → trigger loop */
  realtime?: boolean;
  /** position in the 3D diagram (x right, y up, z towards the viewer), arbitrary units */
  at: [number, number, number];
}

export interface FileFlow {
  id: string;
  kind: "plan" | "recipe" | "job";
  label: string;
  from: string;
  to: string;
  phase: Phase;
}

export const BLOCKS: Block[] = [
  // the phone: a column, the loop on top
  { id: "camera", side: "phone", label: "Camera", what: "The rear camera, 30 frames a second, looking past the bit at the markers.", phase: 1, realtime: true, at: [-2.2, 1.55, 0] },
  { id: "tracker", side: "phone", label: "Marker tracker", what: "Finds the markers and solves the camera's 6-DoF pose, in a Web Worker.", phase: 1, realtime: true, at: [-2.2, 0.95, 0] },
  { id: "engine", side: "phone", label: "Engine · 120 Hz", what: "Rust compiled to WebAssembly: the scene graph, the go / no-go gate, depth and angle alarms. Every decision.", phase: 1, realtime: true, at: [-2.2, 0.35, 0] },
  { id: "hud", side: "phone", label: "HUD · AR · sound", what: "What the person sees and hears: rings, the glowing hole, the tone when square.", phase: 1, realtime: true, at: [-2.2, -0.25, 0] },
  { id: "pointer", side: "phone", label: "Plan with the tool", what: "The calibrated bit tip marks where each hole goes. The plan is a file.", phase: 1, at: [-2.2, -0.85, 0] },
  { id: "recorder", side: "phone", label: "Job recorder", what: "Every hole with its depth and angle, graded; the report and an agentvcs ledger.", phase: 1, at: [-2.2, -1.45, 0] },
  { id: "memory", side: "phone", label: "Local memory", what: "IndexedDB on the phone: calibrations, plans, jobs, and an outbox of what is not synced yet. Works offline.", phase: 1, at: [-2.2, -2.05, 0] },
  // the cloud: a ring of services
  { id: "accounts", side: "cloud", label: "Plans & memory", what: "Accounts and projects: parts, plans and every job, synced from the phone's outbox.", phase: 2, at: [2.3, -1.2, 0.4] },
  { id: "experts", side: "cloud", label: "Experts", what: "A library of expert plans shared by link, and a live expert who sends changes to the plan, never commands to the loop.", phase: 2, at: [2.9, 0.1, -0.5] },
  { id: "ai", side: "cloud", label: "AI planning", what: "From a CAD model to a plan of holes and a recipe. Only a file: the engine validates it before use.", phase: 3, at: [2.3, 1.35, 0.3] },
  { id: "athos", side: "cloud", label: "athos", what: "Recipes as checked steps; a job measured within spec can become a candidate recipe to verify.", phase: 3, at: [1.5, 0.55, 0.9] },
  { id: "agentvcs", side: "cloud", label: "agentvcs", what: "Receives ledgers, runs verify, answers blame and bisect on precision across engine versions.", phase: 3, at: [1.5, -0.45, -0.9] },
  // outside both: development
  { id: "gatekeeper", side: "ci", label: "contract-gatekeeper", what: "A CI step on the repository: a new tool's code stays in its capsule. Not a service.", phase: 3, at: [0.2, -2.6, -1.2] },
];

export const FLOWS: FileFlow[] = [
  { id: "plan-local", kind: "plan", label: "Plan", from: "pointer", to: "memory", phase: 1 },
  { id: "job-local", kind: "job", label: "Job record", from: "recorder", to: "memory", phase: 1 },
  { id: "plan-down", kind: "plan", label: "Plan", from: "experts", to: "memory", phase: 2 },
  { id: "sync-up", kind: "job", label: "Job record", from: "memory", to: "accounts", phase: 2 },
  { id: "ai-plan", kind: "plan", label: "Plan", from: "ai", to: "memory", phase: 3 },
  { id: "recipe", kind: "recipe", label: "Recipe", from: "athos", to: "memory", phase: 3 },
  { id: "ledger", kind: "job", label: "Ledger", from: "memory", to: "agentvcs", phase: 3 },
];

export const FILE_KINDS = {
  plan: { label: "Plan", format: "smarttools-plan v1", color: "#5ad8ff", what: "Where each hole goes and how deep. Made by the pointer, an expert or AI; validated by the phone before the engine uses it." },
  recipe: { label: "Recipe", format: "athos piece (Markdown)", color: "#3dffa8", what: "The steps (When / Do / Check / Because); each Check is answered by an engine measurement." },
  job: { label: "Job record", format: "smarttools-job v1 + agentvcs/0.1", color: "#ffb547", what: "The report (every hole, depth, angle, grade) and a ledger stamped with the engine version." },
} as const;

export const PHASES: { n: Phase; label: string; goal: string }[] = [
  { n: 1, label: "F1", goal: "It works, with no cloud" },
  { n: 2, label: "F2", goal: "A minimal cloud: accounts, sync, shared plans" },
  { n: 3, label: "F3", goal: "The services: athos, agentvcs, live expert, AI planning" },
];

export const block = (id: string) => {
  const b = BLOCKS.find((x) => x.id === id);
  if (!b) throw new Error(`no block ${id}`);
  return b;
};

/** The rule, as a check: no file flow ends in a real-time block, and no cloud block is real-time. */
export function ruleViolations(): string[] {
  const out: string[] = [];
  for (const b of BLOCKS) if (b.realtime && b.side !== "phone") out.push(`${b.id} is real-time but not on the phone`);
  for (const f of FLOWS) {
    if (block(f.to).realtime) out.push(`${f.id} delivers into the real-time loop (${f.to})`);
    if (f.phase < Math.max(block(f.from).phase, block(f.to).phase)) out.push(`${f.id} comes before its blocks`);
  }
  return out;
}
