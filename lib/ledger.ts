// A job record as an agentvcs ledger (docs/INTEGRATIONS.md, agentvcs; protocol agentvcs/0.1, spec/PROTOCOL.md in
// the agentvcs repository). Written on the phone, read by the agentvcs CLI or service: `agentvcs verify` checks
// it, `blame` and `bisect` find which engine change moved the precision.
//
//   manifest: what produced the job (app, engine ABI, phone, calibration, plan), as "config" dimensions
//   ledger:   run_start, one step per hole (metrics: depth error, max angle, score), run_end
//
// Canonical JSON is RFC 8785 (JCS); hashes are BLAKE3-256 written "b3:<hex>".

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { JobRecord } from "./jobrecord.ts";

export const PROTOCOL = "agentvcs/0.1";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** RFC 8785 canonical JSON. Throws on what the protocol calls invalid (NaN, infinities, lone surrogates). */
export function canonical(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("E_CANONICAL: NaN or infinity");
    return JSON.stringify(v);
  }
  if (typeof v === "string") {
    if (!v.isWellFormed()) throw new Error("E_CANONICAL: lone surrogate");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    // keys sorted by UTF-16 code units (the default string order); undefined members are left out
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${canonical(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`E_CANONICAL: ${typeof v}`);
}

export const hashBytes = (b: Uint8Array) => `b3:${bytesToHex(blake3(b))}`;
export const hash = (v: unknown) => hashBytes(utf8ToBytes(canonical(v)));

type Dimension = { kind: "config"; content: Json; content_hash: string };

/** The harness manifest for a job: everything that produced its measurements. */
export function jobManifest(job: JobRecord) {
  const dim = (content: Json): Dimension => ({ kind: "config", content, content_hash: hash(content) });
  const c = job.context;
  const dimensions: Record<string, Dimension> = {
    app: dim({ name: "smarttools", version: c.app, source: c.source }),
    engine: dim({ abi: c.engineAbi }),
    phone: dim({ id: c.phone.id, name: c.phone.name, provisional: c.phone.provisional }),
    calibration: dim({ lens: c.calibration.lens, dock: c.calibration.dock }),
    plan: dim({ id: job.plan.id, hash: hash(job.plan), holes: job.plan.holes.length }),
  };
  const manifest_id = hash({ protocol: PROTOCOL, dimensions });
  return { protocol: PROTOCOL, type: "harness_manifest", name: `smarttools ${c.app} · ${job.plan.name}`, parent_ids: [] as string[], dimensions, manifest_id };
}

/** The job as an agentvcs audit bundle (what `agentvcs verify` reads). */
export function jobLedger(job: JobRecord) {
  const manifest = jobManifest(job);
  const run_id = `smarttools-${job.id}`;
  const entries: Record<string, unknown>[] = [];
  const add = (kind: string, body: Record<string, unknown>) => {
    const e: Record<string, unknown> = { protocol: PROTOCOL, type: "ledger_entry", run_id, seq: entries.length, prev_hash: entries.length ? entries[entries.length - 1].entry_hash : null, kind, body };
    e.entry_hash = hash(e);
    entries.push(e);
  };
  add("run_start", { manifest_id: manifest.manifest_id, started_at: job.started, parent: null });
  job.holes.forEach((h, i) => {
    const planned = job.plan.holes.find((p) => p.label === h.name);
    const metrics: Record<string, number> = { "depth.error_mm": round3(h.seatedMm - h.plannedMm), "angle.max_deg": h.maxAngleDeg, "hole.flagged": h.flagged ? 1 : 0 };
    if (h.score != null) metrics["hole.score"] = h.score;
    add("step", {
      step_index: i,
      manifest_id: manifest.manifest_id,
      agent_id: "hole",
      inputs: [hash(planned ?? { label: h.name })],
      outputs: [hash(h)],
      started_at: h.startedAt,
      ended_at: h.endedAt,
      tokens: { in: 0, out: 0 },
      latency_ms: Math.max(0, Date.parse(h.endedAt) - Date.parse(h.startedAt)),
      metrics,
      checkpoint_ref: null,
    });
  });
  add("run_end", { ended_at: job.ended, status: job.status === "completed" ? "completed" : "aborted" });
  return { protocol: PROTOCOL, type: "audit_bundle", run_id, manifests: { [manifest.manifest_id]: manifest }, ledger: entries };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
