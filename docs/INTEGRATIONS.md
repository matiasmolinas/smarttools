# The three projects: use them from their repositories, or migrate them here?

SmartTools sits next to three open-source projects:
- athos (plan & guide);
- contract-gatekeeper (evolve safely);
- agentvcs (learn in the field).

The three "Platform" demos in the gallery are still illustrations: they run the real engine, but the athos step
card, the gatekeeper verdict and the agentvcs record are drawn by the demo (`lib/gallery/scenarios.ts`,
`lib/sim.ts`). The modules below are real and tested.

## Update (2026-11-24): a table of up to four sheets

The marker tracker no longer sees only one sheet. Up to four sheets (`lib/board.ts` `SHEETS`; sheet k has ids
28 k + 0..27) lie flat on the bench; sheet 0 stays the world frame and the others are placed by `{ x, y, yaw }`,
learned by looking at them (`lib/tablemap.ts` `SheetMapper`, kept per device as `st-table`). The tracker solves one
pose from the markers of every mapped sheet. A sheet whose markers stop fitting that pose is left out of the same
frame's pose at once (a second solve, `solveTable`) and dropped from the map after a second. The simulator's
renderer draws the table too (`RenderOptions.sheets`, engine ABI 7; one sheet renders exactly as before), and
`npm run test:pilot` runs the pilot job on four sheets with the block on them.

`lib/tablemap.ts`, `lib/markertracker.ts`, `lib/tracker.ts`, `engine/src/sim.rs`, `lib/scene.ts` (`PILOT_TABLE`).
Tests: `tests/tablemap.test.mts`, `engine/src/sim.rs` (Rust), `scripts/pilot-sim.mts`.

## Update (2026-11-24): a recipe now guides by lighting controls, not by text

The pilot job (a 100 × 100 mm wood block, four screws) is an athos recipe (`lib/pilot.ts` `pilotRecipe`): three
steps before the screws (`#sheet`, `#place`, `#register`), then one Drill step per screw. On the phone's simple
display the recipe no longer shows step cards or step text. For the current step, the controls and the drawn guides
that matter glow (an amber ring that pulses) and the rest is dimmed (`focus`). The step's words show only on a tap
on the top text, for 3 s. The steps before the screws are answered by the phases themselves (the sheet seen well,
the block's four corners fitting a 100 mm square), so no Step sheet asks for them: they are confirmed with the job
once the fit is ok. The screws' Checks are answered by the engine as before.

`lib/pilot.ts` (`focus`, `currentStep`, `pilotText`, `pilotWords`), `lib/hudsimple.ts` (`controlLook`,
`phaseButtons`), `components/HudScreen.tsx`. Tests: `tests/pilot.test.mts`, `tests/hudsimple.test.mts`.

## Update (2026-11-23): who wrote a recipe, and its Checks answered live

A recipe now says who wrote it, and the plan it makes keeps it. Then the phone works it step by step.

- **Authorship and review.** A recipe names its author in its front matter (`author: ai | expert | manual`, or
  an agent's `origin.platform`). When it names nobody, it is treated as written by an AI. The gate sends an AI's
  recipe to a person: in `/memory` the review box says who wrote it, and the plan keeps when it was reviewed.
- **The recipe travels with the plan.** The plan keeps the recipe's id and its Markdown (`plan.recipe`), so the
  phone has every step and every Check, offline.
- **Checks answered live.** On `/hud`, each finished hole shows a card with its Check answered by the engine:
  green (pass, goes by itself), red (fail, stays until OK), or amber (words the engine cannot measure: Yes / No).
  The steps that are not holes ("Clamp the board") come up as a sheet, Done or Skip. The answers are kept with
  the job (`confirmations`); the hole Checks are recomputed from the hole records, never stored. `/memory` lists
  each job's Checks, step by step.

`lib/recipe.ts` (`checkHole`, `dueManual`, `checkJob`, `tallySoFar`), `lib/jobrecord.ts` (`confirmations`),
`lib/tracker.ts` (`onHoleDone`, `confirmStep`). Tests: `tests/livechecks.test.mts`, `tests/native.test.mts`.

**Still to do:** the agent that writes recipes, and sending a job's Checks back to it.

## Update (2026-11-23): the part SmartTools uses is now native

The first decision (below) was to keep each project upstream and implement only its file format here. Working
on the phone showed that the formats alone are not enough. The phone has to answer a recipe's Checks, compare its
own jobs, and refuse a bad plan, all offline. So the part SmartTools uses is now rewritten natively, in TypeScript,
for this project. Each project still lives upstream for its own users, so nothing here is a fork of their code:
these modules implement their formats and their rules.

| | Native module | What it does here | Tests |
|---|---|---|---|
| athos | `lib/recipe.ts` | Reads pieces (front matter, `## #statement`, When / Do / Check / Because / Links). `bindCheck` turns a Check's words into engine measurements (depth within, angle under, score at least, no alarm) and leaves the rest for the person. `Drill D1: Ø6 mm at (0, 60) mm, 20 mm deep` steps become a plan, and a plan or a finished job is written back as a recipe. `checkJob` answers every step with the job's records. | `tests/native.test.mts`, `tests/fixtures/athos/`; the pieces in the local athos store when the CLI is installed |
| agentvcs | `lib/ledger.ts`, `lib/vcs.ts` | Writes each job as a ledger, with the tracking settings (detector, filter, detection size, camera) in the manifest. `verifyBundle` checks hashes, the chain, manifest ids and entry order. `blame` ranks which setting goes with a change in a metric. `bisect` finds the first bad job in time order and what changed from the last good one. | `tests/native.test.mts`, `tests/f1.test.mts` (conformance hashes; `agentvcs verify` with `AGENTVCS_BIN`) |
| contract-gatekeeper | `lib/gate.ts`, `scripts/gate.mts`, `gate.config.json` | Its three verdicts in two places. **Recipes:** FAST_TRACK, ESCALATE (a Check the engine does not measure, a tolerance outside what it checks well, an AI author: a person reviews it), or REJECTED (an invalid plan, a Drill step it cannot read, no hole at all). **Change sets:** `npm run gate` sorts the branch's files into capsules. The engine, tracking and scene escalate to the engine tests and the end-to-end run. Rust changed without a rebuilt WebAssembly, or an ABI mismatch, is rejected. | `tests/native.test.mts` (also: every file in the repository falls in a capsule) |

**In the app (`/memory`):**
- import a recipe through the gate, with a review step when it escalates;
- download any plan or job as a recipe;
- verify a ledger file;
- compare jobs by tracking setting (blame on depth error and maximum angle).

**Still upstream:**
- athos: learning, verification by a second model, the router and the agent hooks;
- agentvcs: the store, diff, merge and the MCP server;
- gatekeeper: the general tool for any repository.

All of these need a computer or an AI agent, not a phone.

**Still to do:**
- work a recipe step by step on the phone, with each Check passing live;
- one capsule per tool when the saw starts;
- the gate in CI.

The analysis that led to the first decision follows, unchanged.

This document decides, for each one, how it should come in:
- **A. Use from its repository:** a pinned dependency, a CLI, or a file format.
- **B. Migrate:** copy its code here as a native module and maintain it in this repository.

## The deciding facts

| | athos | contract-gatekeeper | agentvcs |
|---|---|---|---|
| Language | Python (~170 files), Markdown | TypeScript, zero runtime dependencies | Rust workspace, plus a Python SDK |
| Where it runs | On a computer, next to an AI agent (hooks, CLI) | In development and CI (Node 22) | CLI, MCP server and library on a computer; core uses SQLite (`rusqlite`) and BLAKE3 |
| Where SmartTools runs | The phone, in the browser: TypeScript plus a Rust → WebAssembly engine | | |
| Its own users and releases | Yes | Yes (npm package, v1.2.0) | Yes (117/117 conformance cases, CI) |
| License | Apache 2.0 | Apache 2.0 | Apache 2.0 |
| What SmartTools needs from it on the phone | Read a recipe; bind each Check to a measurement | Nothing (it checks code, not jobs) | Write one record per hole or screw |

Two things decide it:
1. **None of the three runs on the phone as it is.** Python does not run in the browser, gatekeeper is a CI tool, and
   agentvcs's core needs SQLite and a file system.
2. **Each has its own users.** Copying one here would fork it: two copies to fix, drifting apart.

What the phone needs from athos and agentvcs is small and well specified: a file format. gatekeeper needs nothing on
the phone at all.

## Decision: migrate none of them whole; implement natively only the edge each one meets the phone at

### athos: use from its repository; read its format natively

**What it is.** athos keeps how a person works as Markdown pieces:
- each step is a statement with **When / Do / Check / Because** and links to the next step;
- a frontier model learns the pieces, a second model verifies them;
- any model can then replay them.

**In SmartTools.** A master's recipe becomes the job:
- the phone shows one statement at a time;
- each **Check** is answered by the engine, not by a person or a model. Examples: "depth within 0.5 mm", "angle
  under 1°", "part located".

**Native here** (new, small):
- `lib/recipe.ts`: a parser for the piece format. It reads the title, the `when` front matter, and the
  `## #statement` blocks with their When / Do / Check / Because / Links fields.
- A binder from a Check's text to an engine measurement:
  - a small fixed vocabulary, such as `depth`, `angle`, `located`, `gate`;
  - a Check outside that vocabulary is shown, but it must be confirmed by hand.
- Conformance tests on real pieces exported from athos, kept in `tests/fixtures/athos/`.

**Stays in athos:**
- learning on a frontier model;
- verification by a second model;
- the router that picks pieces;
- the audit log;
- the CLI and the agent hooks.

All of these need a computer and an AI agent.

**Risk.** The piece format changes upstream. Mitigation: pin a format version, and fail the conformance test on a
change.

**Next step.** Write the parser and the binder, and add three real pieces as fixtures (one hole, one screw, one
registration).

### contract-gatekeeper: use from its repository, as a pinned dev dependency

**What it is.** A deterministic pre-PR and CI check: for a change set, did it stay inside one capsule and keep its
contract (`FAST_TRACK`), cross a boundary (`ESCALATE_TO_E2E`), or break isolation (`REJECTED`)?

**In SmartTools.** One capsule per tool (drill, screwdriver, then the circular saw). A new tool, written by a person
or an agent, cannot change the engine's core, the gate or the safety rules without escalating to the full
end-to-end run.

**Native here.** None of gatekeeper's code. SmartTools adds:
- `lib/tools/<tool>/index.ts` capsules. Each one holds the tool's rig, scene pieces, HUD hints and scenario hooks,
  behind a declared contract.
- `gatekeeper.config.json`, which names the capsules and allowed packages, and maps key flows to the end-to-end
  scenarios (`npm run test:e2e`).
- A CI step: `contract-gatekeeper check` against the base branch.

**Stays in its repository:** all of it. It is a development tool, and migrating it would only fork it.

**Risk.** The capsule split is real work. Today the drill-specific code is spread over `lib/assembly.ts`,
`lib/hud.ts` and `lib/gallery/`. Do it when the second tool (the saw) starts, not before.

**Next step.** Add it as a dev dependency pinned to a tag, with a config that marks the engine and `lib/` as
shared. Move the first tool into a capsule when the saw work begins.

### agentvcs: use from its repository; write its records natively

**What it is.** Version control for running agent harnesses:
- every step is stamped with the exact version that produced it;
- patches are gated before they apply;
- `blame` and `bisect` attribute a change in a metric to the change that caused it.

**In SmartTools.** Every hole or screw becomes a step record:
- its inputs: the plan, the calibration, the scene;
- its metrics: depth error, angle error, time, gate stops;
- the manifest: the engine version, the ABI, the phone profile, the dock rig.

When precision drops in the field, `bisect` finds the engine change that caused it.

**Native here** (new, small):
- `lib/ledger.ts`, which turns a job report (`lib/report.ts`) into an agentvcs ledger, following `spec/PROTOCOL.md`:
  - canonical JSON (RFC 8785);
  - BLAKE3 hashes written as `b3:…`;
  - `run_start`, one `step` entry per screw with `metrics`, and `run_end`;
  - the hash chain through `prev_hash` and `entry_hash`.
- A "Download ledger" button next to the report's HTML and JSON.

BLAKE3 in the browser is a small dependency, or the Rust `blake3` crate inside the existing WebAssembly engine.

**Stays in agentvcs:**
- the store;
- `verify`, `blame`, `bisect`, `diff` and `merge`;
- the MCP server.

They run on a computer or in CI, on the exported ledger files. Compiling `agentvcs-core` to WebAssembly is not
worth it: it brings SQLite to the phone for a job that writes a few dozen records.

**Risk.** The protocol version changes (it is `agentvcs/0.1`). Mitigation: a test that runs `agentvcs verify` on
a ledger written by `lib/ledger.ts`, when the CLI is installed.

**Next step.** Write `lib/ledger.ts` and its test, and validate one exported ledger with the agentvcs CLI.

## When migrating would be the right call

Revisit this if one of these happens:
- one of the projects stops being maintained upstream;
- SmartTools needs to change its internals, not only its formats;
- the phone must run its logic offline and the format edge is no longer enough. For example, athos-style learning
  on the device.

Then migrate that part only, as a module under `lib/`, keeping the upstream license notice and the format
conformance tests.

## Order of work

1. **agentvcs ledger export.** It is the smallest step, it is self-contained, and it turns every demo job into real
   field data.
2. **athos recipe reader and Check binder.** It replaces the illustrative step card with real pieces.
3. **contract-gatekeeper in CI.** It comes with the second tool, when there is a capsule to protect.
