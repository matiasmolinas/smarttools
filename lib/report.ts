// The job report: every screw with its depth, angle and any flag, a verdict, and the same as a file
// (JSON for systems, HTML to print or hand to the customer). The x-ray heat map colours each screw
// with the same grade.

export interface ScrewRecord {
  name: string;
  face: string;
  size: string;
  plannedMm: number;
  seatedMm: number;
  maxAngleDeg: number;
  flagged?: string;
  /** how far the tip was from the hole's mark, sideways, when drilling started (mm); missing on older jobs */
  offsetMm?: number;
}
export type Grade = "good" | "fair" | "redo";

/** A hole in one compact line, as the Job sheet and /memory show it: "S1 13.9/14 mm 0.10° 0.31 mm off the mark". */
export function holeLine(r: ScrewRecord): string {
  return `${r.name} ${r.seatedMm.toFixed(1)}/${r.plannedMm} mm ${r.maxAngleDeg.toFixed(2)}°${r.offsetMm != null ? ` ${r.offsetMm.toFixed(2)} mm off the mark` : ""}`;
}
export interface JobReport {
  job: string;
  date: string;
  screws: (ScrewRecord & { grade: Grade })[];
  summary: { total: number; good: number; fair: number; redo: number; worstAngleDeg: number };
  verdict: string;
}

/** Grade of a screw: square and to depth = good; a little off = fair; flagged or off = redo. */
export function grade(r: ScrewRecord, limits = { angleDeg: 0.5, depthMm: 0.5 }): Grade {
  if (r.flagged) return "redo";
  const depthErr = Math.abs(r.seatedMm - r.plannedMm);
  if (r.maxAngleDeg > limits.angleDeg || depthErr > limits.depthMm) return "redo";
  if (r.maxAngleDeg > limits.angleDeg / 2 || depthErr > limits.depthMm / 2) return "fair";
  return "good";
}

export function buildReport(job: string, records: ScrewRecord[], planned: number, date = new Date().toISOString()): JobReport {
  const screws = records.map((r) => ({ ...r, grade: grade(r) }));
  const n = (g: Grade) => screws.filter((s) => s.grade === g).length;
  const summary = { total: planned, good: n("good"), fair: n("fair"), redo: n("redo"), worstAngleDeg: Math.max(0, ...screws.map((s) => s.maxAngleDeg)) };
  const missing = planned - screws.length;
  const verdict =
    summary.redo > 0
      ? `${summary.redo} to redo: ${screws.filter((s) => s.grade === "redo").map((s) => s.name).join(", ")}`
      : missing > 0
        ? `${screws.length} of ${planned} done, all within spec`
        : `all ${planned} within spec (worst ${summary.worstAngleDeg.toFixed(2)}°)`;
  return { job, date, screws, summary, verdict };
}

export function reportHtml(r: JobReport, source: "camera" | "simulation" = "simulation"): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  // the position column only when a screw has it: an older report stays exactly as it was
  const offset = r.screws.some((s) => s.offsetMm != null);
  const off = (s: ScrewRecord) => (offset ? `<td>${s.offsetMm != null ? `${s.offsetMm.toFixed(2)} mm` : "–"}</td>` : "");
  const rows = r.screws
    .map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.face)}</td><td>${esc(s.size)}</td><td>${s.seatedMm.toFixed(1)} / ${s.plannedMm} mm</td><td>${s.maxAngleDeg.toFixed(2)}°</td>${off(s)}<td class="${s.grade}">${s.grade}${s.flagged ? ` (${esc(s.flagged)})` : ""}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.job)} report</title><style>body{font:14px system-ui;margin:2rem;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}.good{color:#0a7a45}.fair{color:#a86400}.redo{color:#b00020;font-weight:600}</style></head><body><h1>${esc(r.job)}</h1><p>${esc(r.date)} · SmartTools navigation (${source === "camera" ? "measured with the phone's camera" : "simulated run"})</p><p><b>${esc(r.verdict)}</b></p><table><tr><th>screw</th><th>face</th><th>size</th><th>seated</th><th>max angle</th>${offset ? "<th>off the mark</th>" : ""}<th>grade</th></tr>${rows}</table></body></html>`;
}
