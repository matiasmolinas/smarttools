# SmartTools architecture: the phone runs the work, the cloud keeps the knowledge

**Decision (November 2026).** SmartTools is a hybrid application:
- **The cloud delivers the app.** It is an installable web app (a PWA) with the navigation engine compiled from
  Rust to WebAssembly.
- **The phone runs it all,** offline included.
- **The cloud keeps** the plans and the memory, shares the work of experts, plans with AI, and hosts the services
  of athos and agentvcs.

**One rule above all the others: the cloud is never between the camera and the trigger.**

The page [`/architecture`](https://smarttools-nav.vercel.app/architecture) draws this document in 3D.

## 1. Why hybrid, and not the alternatives

| Option | Verdict | Why |
|---|---|---|
| **A. Phone only** | The base, but not enough | Fastest, offline and private. But no shared plans, no experts, no sync, no AI planning, and a cleared browser loses the memory |
| **B. Cloud only** (stream the video, compute on a server) | Rejected | The engine ticks at 120 Hz with about 30 ms from capture to decision; no network does that reliably. Workshop Wi-Fi drops, and **a safety decision must never depend on a network** |
| **C. Hybrid** | **Chosen** | A, plus memory, sharing, AI and the three projects, with the real-time loop untouched |
| **D. Native app** (Android, or the same web app wrapped with Capacitor) | Later, only if measured | More camera control (fixed focus, exposure, frame rate). Decided by the measurements on a real drill: the same app wrapped, not a rewrite |

## 2. What runs where

```
 PHONE (PWA + WebAssembly), works offline              │  CLOUD (later phases), never on the real-time path
                                                        │
 camera ─► marker tracker (worker) ─► ENGINE 120 Hz ─┐  │  accounts, projects
                                      gate, alarms   │  │  plans & memory  ◄── sync ──┐
 HUD / AR / sound / gestures ◄── snapshots ◄─────────┘  │  expert library, live expert │
                                                        │  AI planning (CAD → plan)    │
 plan with the tool as a pointer ─► PLAN ──────────────────────────────────────────────┤
 job recorder ─► JOB RECORD (report + agentvcs ledger) ────────────────────────────────┤
 local memory (IndexedDB): calibrations, plans, jobs, outbox ──────────────────────────┘
                                                        │  athos service: recipes, learning, verification
                                                        │  agentvcs service: ledgers, verify, blame, bisect
                                                        │  contract-gatekeeper: CI only (GitHub), no service
```

### On the phone (open source, this repository, Apache 2.0)

- **The real-time loop.** Camera, marker tracker (in a Web Worker), the engine (Rust → WebAssembly, 120 Hz),
  the go / no-go gate and the alarms.
- **The views.** HUD, AR guidance on the camera view, sound, gestures.
- **Planning with the tool as a pointer.** The calibrated bit tip marks where each hole goes on the reference sheet.
- **The job recorder.** Every hole and screw with its depth and angle, graded. It writes:
  - the job report;
  - an agentvcs ledger stamped with the engine version, the phone and the calibration.
- **Local memory.** IndexedDB holds calibrations, plans and jobs. An *outbox* lists what has not been synced yet.
- **Offline.** A service worker keeps the app, the engine and the tracker available without a network.

### In the cloud (a separate, private service, as athos-cloud is for athos)

- **Accounts and projects:** parts (CAD / STL), plans and the jobs done. It is the memory of a person and of a
  workshop.
- **Experts:**
  - a library of expert plans, shared by link;
  - a live expert who sends *changes to the plan* over a realtime channel, never commands to the loop.
- **AI planning.** From a CAD model to a plan of holes and a recipe. The result is only a **plan file**: the
  engine on the phone validates it deterministically before using it. AI proposes; math decides.
- **athos.** SmartTools is a client of the athos cloud (sync, memory, sharing, the improvement agent):
  - the phone only *reads* recipes;
  - a screw the engine measured within spec is an objective check, so a job done well can become a candidate
    recipe for athos to verify.
- **agentvcs.** It receives the ledgers the phone uploads and runs `agentvcs verify` on them. It stores them and
  answers `blame` and `bisect` on precision across engine versions.
- **contract-gatekeeper** is not a service. It is a CI step on this repository; see
  [INTEGRATIONS.md](INTEGRATIONS.md).

## 3. The contract between both sides: three versioned files

The phone works alone; the cloud only exchanges files with it. Each format has a `kind` and a version, a validator
on the phone, and tests.

| File | Kind | Made by | Read by | Module |
|---|---|---|---|---|
| **Plan** | `smarttools-plan` v1 | The phone (pointer), an expert, AI in the cloud | The phone's engine, after validation | `lib/plan.ts` |
| **Recipe** | athos piece (Markdown) | athos | The phone (the step card); each Check bound to a measurement | `lib/recipe.ts` (F3) |
| **Job record** | `smarttools-job` v1 + `agentvcs/0.1` audit bundle | The phone | The person (report), the cloud, agentvcs | `lib/jobrecord.ts`, `lib/ledger.ts` |

The rule above becomes a property of the code:
- nothing from the cloud reaches the engine except through these validated files;
- the engine's decisions use only its own measurements.

## 4. Phases

| Phase | Goal | What it contains | Status |
|---|---|---|---|
| **F1** | It works, with no cloud | An installable, offline app. Plan with the tool as a pointer. Local memory (plans, jobs, outbox). Export the job report and the agentvcs ledger, checked by the agentvcs CLI. In parallel, print the dock and measure it on a real drill | Software done (see below); the real drill is pending |
| **F2** | A minimal cloud | Accounts, sync of plans and jobs from the outbox, sharing an expert plan by link | Next |
| **F3** | The services | athos recipes (reader on the phone, library in the cloud); agentvcs ledger service (verify, blame, bisect); a live remote expert; AI planning from CAD; gatekeeper in CI with the second tool | After |

### F1, what is in place

| Piece | Where | Checked by |
|---|---|---|
| Plan file v1: validation, holes → engine targets | `lib/plan.ts`, `smartToolsScene({ targets })` | `tests/f1.test.mts` |
| Planning with the tool as a pointer (the tip must touch the sheet's plane, camera measured) | `tipOnSheet`, `BrowserNav.markHere`, the bar at the bottom of `/hud` (camera view) | Unit test, plus a headless run where the tip resting on A1 marks (0, 60) mm within 1 mm |
| Job recorder: every hole's depth, angle, score and flags, graded | `lib/jobrecord.ts`, `BrowserNav.finishJob` | A headless job on the engine: 3 holes, all within spec |
| agentvcs ledger | `lib/ledger.ts` | The agentvcs hash conformance cases (`tests/fixtures/agentvcs-hash`), and `agentvcs verify` when `AGENTVCS_BIN` is set |
| Local memory (IndexedDB) with an outbox | `lib/memory.ts`, `/memory` | Unit test (in-memory backend); in the browser |
| Installable and offline | `app/manifest.ts`, `public/sw.js`, `components/ServiceWorker.tsx` | In the browser with the server stopped: `/hud` runs, the engine loads from the cache, `/memory` shows the stored plans and jobs |

Not yet: drawing the marked holes on the HUD while planning, and holes at an angle (v1 holes are square to the
sheet). Planning and recording have been tested on simulated motion only; the real phone and drill come next.

The cloud's stack is chosen when F2 starts. It stays on Vercel next to the app: functions, a Postgres database,
blob storage for CAD files and ledgers, and authentication.

## 5. Risks

- **The real drill.** The dock has not been printed and measured. Every precision number is simulated. This decides
  option D (native camera access), and no architecture removes it.
- **Browser camera limits:** autofocus hunting, exposure, frame pacing. Measured in F1; Capacitor is the fallback.
- **Storage eviction.** A browser can clear IndexedDB. The app asks for persistent storage, and exports files until
  F2 syncs them.
- **Format drift** with athos and agentvcs. Both formats are pinned to a version and tested against the upstream
  tools (`agentvcs verify` runs in the tests when the CLI is available).

## 6. Open source and private

- **Open (this repository):** the phone app, the engine, the formats and their validators, the dock.
- **Private:** the SmartTools cloud service, in its own repository. It talks to the phone only through the three
  files above, the way athos-cloud talks to athos through the exported know-how format.
