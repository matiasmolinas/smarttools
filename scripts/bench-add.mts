// Publish a bench run (a file downloaded from /memory on the phone) on /benchmarks: checks it, writes it to
// public/benchmarks/<id>.json and lists it in public/benchmarks/index.json (camera runs first, newest first, then
// simulations). Deploy afterwards to put it online.
//
// Run: npm run bench:add -- <file.json> [--id <slug>] [--title "<text>"] [--replace] [--simulation]
//   --id          default <phone id>-<created YYYYMMDD-HHMM> (UTC)
//   --title       default the run's own title
//   --replace     publish over a run with the same id
//   --simulation  allow a simulated run (refused by default: this is for measured runs)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { checkBenchRun, indexWith, phaseLine, type BenchIndex, type BenchRun } from "../lib/bench.ts";

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
function fail(...lines: string[]): never {
  for (const l of lines) console.error(l);
  process.exit(1);
}
const file = args.find((a, i) => !a.startsWith("--") && !["--id", "--title"].includes(args[i - 1] ?? ""));
if (!file) fail("usage: npm run bench:add -- <file.json> [--id <slug>] [--title \"<text>\"] [--replace] [--simulation]");
if (!existsSync(file)) fail(`no such file: ${file}`);

let run: BenchRun;
try {
  run = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  fail(`${file} is not JSON: ${(e as Error).message}`);
}
const problems = checkBenchRun(run);
if (problems.length) fail(`${file} cannot be published:`, ...problems.map((p) => `  - ${p}`));
if (run.source === "simulation" && !args.includes("--simulation")) fail(`${file} is a simulation: add --simulation to publish it anyway`);

const stamp = run.created.slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
const id = opt("--id") ?? `${(run.phone?.id || "phone").toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${stamp}`;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) fail(`id "${id}": use lower-case letters, digits and dashes`);
const title = opt("--title") ?? run.title;

const DIR = new URL("../public/benchmarks/", import.meta.url);
const INDEX = new URL("index.json", DIR);
const index: BenchIndex = JSON.parse(readFileSync(INDEX, "utf8"));
if (index.runs.some((r) => r.id === id) && !args.includes("--replace")) fail(`a run with id "${id}" is already published: add --replace to publish over it`);

const out: BenchRun = { ...run, id, title };
writeFileSync(new URL(`${id}.json`, DIR), JSON.stringify(out));
const next = indexWith(index, { id, file: `${id}.json`, source: out.source, title, created: out.created });
writeFileSync(INDEX, JSON.stringify(next, null, 2) + "\n");

console.log(`${out.source === "camera" ? "measured" : "simulated"} run "${title}" (${out.phone?.name ?? "unknown phone"}, ${out.created})`);
for (const s of out.summary) console.log(`  ${phaseLine(s)}`);
console.log(`wrote public/benchmarks/${id}.json and the index (${next.runs.length} runs). Deploy to publish it.`);
