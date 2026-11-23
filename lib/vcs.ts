// agentvcs, the part the phone needs, native (docs/INTEGRATIONS.md): verify a ledger, and find what moved the
// precision across this phone's jobs. lib/ledger.ts writes the bundles; this reads them, ours or imported.
//
//   verifyBundle  the protocol's integrity rules: hashes, the chain, manifest ids, entry order
//   summarize     one bundle as a row: its manifest flattened to settings, its metrics averaged
//   blame         which setting goes with a change in a metric (jobs grouped by each setting's value)
//   bisect        in time order, the first bad job and what changed from the last good one
//
// The store, diff, merge and the MCP server stay in agentvcs: they run on a computer, on the exported files.

import { PROTOCOL, hash } from "./ledger.ts";

type Entry = { protocol: string; type: string; run_id: string; seq: number; prev_hash: string | null; kind: string; body: Record<string, unknown>; entry_hash: string };
type Manifest = { protocol: string; dimensions: Record<string, { kind: string; content: unknown; content_hash: string }>; manifest_id: string };
export type Bundle = { protocol: string; type: string; run_id: string; manifests: Record<string, Manifest>; ledger: Entry[] };

export type Verified = { ok: true } | { ok: false; errors: string[] };

/** Check a bundle as `agentvcs verify` does. Every problem is listed, not only the first. */
export function verifyBundle(b: Bundle): Verified {
  const e: string[] = [];
  if (b?.protocol !== PROTOCOL) e.push(`protocol must be ${PROTOCOL}`);
  if (b?.type !== "audit_bundle") e.push("type must be audit_bundle");
  if (!Array.isArray(b?.ledger) || !b.ledger.length) return { ok: false, errors: [...e, "the ledger is empty"] };
  for (const [id, m] of Object.entries(b.manifests ?? {})) {
    for (const [name, d] of Object.entries(m.dimensions ?? {})) if (hash(d.content) !== d.content_hash) e.push(`manifest ${short(id)}: dimension ${name} does not match its hash`);
    if (hash({ protocol: m.protocol, dimensions: m.dimensions }) !== id || m.manifest_id !== id) e.push(`manifest ${short(id)}: its id is not its hash`);
  }
  b.ledger.forEach((x, i) => {
    const at = `entry ${i}`;
    if (x.run_id !== b.run_id) e.push(`${at}: belongs to run ${x.run_id}`);
    if (x.seq !== i) e.push(`${at}: seq ${x.seq}`);
    if (x.prev_hash !== (i ? b.ledger[i - 1].entry_hash : null)) e.push(`${at}: the chain is broken (prev_hash)`);
    const { entry_hash, ...rest } = x;
    if (hash(rest) !== entry_hash) e.push(`${at}: its content does not match entry_hash (edited?)`);
    const mid = x.body?.manifest_id as string | undefined;
    if (mid && !b.manifests?.[mid]) e.push(`${at}: names a manifest the bundle does not have`);
  });
  if (b.ledger[0].kind !== "run_start") e.push("the first entry must be run_start");
  if (b.ledger[b.ledger.length - 1].kind !== "run_end") e.push("the last entry must be run_end");
  if (b.ledger.slice(1, -1).some((x) => x.kind !== "step")) e.push("between run_start and run_end there must only be steps");
  return e.length ? { ok: false, errors: e } : { ok: true };
}

export interface RunRow {
  run: string;
  started: string;
  /** "dimension" or "dimension.key" -> the value as text, e.g. "tracking.detector" -> "rust" */
  settings: Record<string, string>;
  /** each metric averaged over the run's steps (depth.error_mm as its absolute value) */
  metrics: Record<string, number>;
  steps: number;
}

/** A bundle as one row: what produced it, and how it went. */
export function summarize(b: Bundle): RunRow {
  const start = b.ledger.find((x) => x.kind === "run_start");
  const m = b.manifests[(start?.body.manifest_id as string) ?? ""] ?? Object.values(b.manifests)[0];
  const settings: Record<string, string> = {};
  for (const [name, d] of Object.entries(m?.dimensions ?? {})) flatten(name, d.content, settings);
  const steps = b.ledger.filter((x) => x.kind === "step");
  const sums: Record<string, [number, number]> = {};
  for (const s of steps)
    for (const [k, v] of Object.entries((s.body.metrics ?? {}) as Record<string, number>)) {
      const val = k === "depth.error_mm" ? Math.abs(v) : v;
      sums[k] = [(sums[k]?.[0] ?? 0) + val, (sums[k]?.[1] ?? 0) + 1];
    }
  const metrics = Object.fromEntries(Object.entries(sums).map(([k, [s, n]]) => [k, s / n]));
  return { run: b.run_id, started: String(start?.body.started_at ?? ""), settings, metrics, steps: steps.length };
}

// identity and bookkeeping fields: they differ on every job and explain nothing
const SKIP = new Set(["plan.hash", "plan.id", "app.source", "phone.name"]);

function flatten(prefix: string, v: unknown, out: Record<string, string>) {
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flatten(`${prefix}.${k}`, x, out);
  else if (!SKIP.has(prefix)) out[prefix] = JSON.stringify(v);
}

export interface Blame {
  setting: string;
  /** each value of the setting: how many jobs had it and the metric's mean over them */
  groups: { value: string; jobs: number; mean: number }[];
  /** worst mean minus best mean (the metric's own unit) */
  spread: number;
  /** fewer than 2 jobs on some value: a hint, not evidence */
  weak: boolean;
}

/** For a metric (lower is better), the settings that vary across the runs, the one with the largest spread first. */
export function blame(rows: RunRow[], metric: string): Blame[] {
  const have = rows.filter((r) => Number.isFinite(r.metrics[metric]));
  const keys = new Set(have.flatMap((r) => Object.keys(r.settings)));
  const out: Blame[] = [];
  for (const k of keys) {
    const g = new Map<string, number[]>();
    for (const r of have) {
      const v = r.settings[k] ?? "(none)";
      g.set(v, [...(g.get(v) ?? []), r.metrics[metric]]);
    }
    if (g.size < 2) continue;
    const groups = [...g].map(([value, xs]) => ({ value, jobs: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length })).sort((a, b) => a.mean - b.mean);
    out.push({ setting: k, groups, spread: groups[groups.length - 1].mean - groups[0].mean, weak: groups.some((x) => x.jobs < 2) });
  }
  return out.sort((a, b) => Number(a.weak) - Number(b.weak) || b.spread - a.spread);
}

export interface Bisected {
  /** the first bad run, in time order, and the last good one before it */
  firstBad: RunRow;
  lastGood: RunRow | null;
  /** settings that differ between the two: the suspects */
  changed: { setting: string; from: string; to: string }[];
  /** runs looked at (a binary search: about log2 of the runs) */
  probes: number;
}

/** Find where runs went from good to bad, as `agentvcs bisect` does: runs in time order, assumed good up to some
 * point and bad after it. null when the newest run is good or the oldest is already bad. */
export function bisect(rows: RunRow[], isBad: (r: RunRow) => boolean): Bisected | null {
  const r = [...rows].sort((a, b) => a.started.localeCompare(b.started));
  if (!r.length || !isBad(r[r.length - 1])) return null;
  let probes = 1;
  if (isBad(r[0])) return null;
  probes++;
  let lo = 0, hi = r.length - 1; // r[lo] good, r[hi] bad
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    probes++;
    if (isBad(r[mid])) hi = mid;
    else lo = mid;
  }
  const good = r[lo], bad = r[hi];
  const keys = new Set([...Object.keys(good.settings), ...Object.keys(bad.settings)]);
  const changed = [...keys].filter((k) => good.settings[k] !== bad.settings[k]).map((k) => ({ setting: k, from: good.settings[k] ?? "(none)", to: bad.settings[k] ?? "(none)" }));
  return { firstBad: bad, lastGood: good, changed, probes };
}

const short = (id: string) => id.slice(0, 11);
