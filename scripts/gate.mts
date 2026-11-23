// The verdict for this branch's changes before merging and deploying (lib/gate.ts, gate.config.json):
// FAST_TRACK, ESCALATE (run the engine tests and the end-to-end too) or REJECTED (with the reasons).
//
// Run: node --no-warnings scripts/gate.mts [base]        (base defaults to main; uncommitted changes count)
//      node --no-warnings scripts/gate.mts [base] --run  (and run the commands the verdict asks for)

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { gateChanges, type GateConfig } from "../lib/gate.ts";

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--")) ?? "main";
const sh = (c: string) => execSync(c, { encoding: "utf8" }).trim();
const files = [...new Set([...sh(`git diff --name-only ${base}...HEAD`).split("\n"), ...sh("git diff --name-only HEAD").split("\n"), ...sh("git ls-files --others --exclude-standard").split("\n")].filter(Boolean))].sort();
const cfg = JSON.parse(readFileSync("gate.config.json", "utf8")) as GateConfig;
const g = gateChanges(files, (f) => (existsSync(f) ? readFileSync(f, "utf8") : null), cfg);

const by = new Map<string, string[]>();
for (const t of g.touched) by.set(t.capsule, [...(by.get(t.capsule) ?? []), t.file]);
console.log(`${files.length} files changed against ${base}`);
for (const [c, fs] of by) console.log(`  ${c.padEnd(9)} ${fs.length}  ${fs.slice(0, 4).join(", ")}${fs.length > 4 ? ", …" : ""}`);
console.log(`\n${g.verdict}`);
for (const r of g.reasons) console.log(`  · ${r}`);
if (g.run.length) console.log(`\nbefore merging:\n${g.run.map((c) => `  ${c}`).join("\n")}`);
if (g.verdict === "REJECTED") process.exit(1);
if (args.includes("--run")) for (const c of g.run) execSync(c, { stdio: "inherit" });
