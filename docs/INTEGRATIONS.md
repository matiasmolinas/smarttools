# The three projects: use them from their repositories, or migrate them here?

SmartTools sits next to three open-source projects:
- athos (plan & guide);
- contract-gatekeeper (evolve safely);
- agentvcs (learn in the field).

Today none of them is wired in. The three "Platform" demos are illustrations: they run the real engine, but the
athos step card, the gatekeeper verdict and the agentvcs record are drawn by the demo (`lib/gallery/scenarios.ts`,
`lib/sim.ts`).

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
