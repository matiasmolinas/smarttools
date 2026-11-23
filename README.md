# SmartTools

> [!IMPORTANT]
> ## This repository is the website only
> What is published here is the **SmartTools website**: the landing page, the simulated HUD demo, the printable
> markers and the first dock design.
>
> **The real SmartTools application is not in this repository yet.** I will publish it over the coming weeks, within
> the next month.

**A bicycle for humans in the real world.**

SmartTools turns everyday power tools into precision tools. A phone in a 3D-printed dock on a cordless drill/driver
looks at printed markers, computes the tool's 6-DoF pose in the browser, and shows a simple 2D guide: where the hole
goes, where the tip is, and whether the bit is square. Today, the drill and the screwdriver. Tomorrow, every tool in
your hands.

**Live demo:** https://smarttools-nav.vercel.app

| Page | What it is |
|---|---|
| [`/`](https://smarttools-nav.vercel.app) | For makers: print (dock, sheet, markers), mount it on your screwdriver, then register, plan and operate. The whole 3D-assembly job, and the assembly and drilling demos running the real engine in 3D + 2D |
| [`/developers`](https://smarttools-nav.vercel.app/developers) | For developers: the navigation engine with its 3D, 2D and AR views, the numbers, athos, contract-gatekeeper and agentvcs with how each should be integrated ([docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)), and every demo |
| [`/architecture`](https://smarttools-nav.vercel.app/architecture) | The architecture in 3D: the phone runs the work (offline), the cloud keeps the knowledge, and only three files cross ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)) |
| [`/benchmarks`](https://smarttools-nav.vercel.app/benchmarks) | Motor off vs motor on: raw and filtered poses from the bench lab (`/hud` → Bench), the tip checked on A2, and the build log. Simulated runs are labelled; the field-test protocol is [docs/FIELD-TEST.md](docs/FIELD-TEST.md) |
| [`/memory`](https://smarttools-nav.vercel.app/memory) | What this phone keeps: plans (made with the tool as a pointer, or imported) and jobs, with the report, the agentvcs ledger and an athos recipe to download; recipes imported through the gate; jobs compared by tracking setting. Works offline |
| [`/engine`](https://smarttools-nav.vercel.app/engine) | The engine lab: one engine drawn in 3D, as a 2D plan and as the HUD |
| [`/hud`](https://smarttools-nav.vercel.app/hud) | The phone app, only what is needed to work: **Start** (the rear camera), then a GPS-style guide over the camera. The guided **Setup** (lens, tip, check) opens by itself; one menu for Setup, Job, Tests and Sound. (`/hud?sim=1` replaces the camera with the scene simulator, for development) |
| [`/markers`](https://smarttools-nav.vercel.app/markers) | Printable A4 sheet v2: 28 ArUco markers of 24 mm and 3 targets (A1–A3) |

## How the demo works

The website includes a browser prototype of the optical tracking, built to illustrate the idea in the demo. It is
not the SmartTools application, which will be published separately.

1. **Markers.** Print `/markers` at 100 % and tape it where you'll drill. A grid of 28 ArUco markers (ARUCO_MIP_36h12,
   24 mm) with three targets in the gaps: the docked camera only sees a ~22 × 12 cm strip above the bit tip, so the grid
   keeps 5–12 markers in view on every target.
2. **Pose.** The rear camera detects the markers ([js-aruco2](https://github.com/damianofalcioni/js-aruco2)). Corners
   are refined to sub-pixel accuracy, then a normalized DLT homography gives an initial pose, which Gauss-Newton refines.
   The focal length self-calibrates from tilted views.
3. **Tool.** The dock keeps the camera rigid with the drill. Two calibrations: the lens (once per phone) and the dock (tip
   on A2: circle, then twist). Then every frame gives the tip position, the bit axis, the aim point on the surface, the
   angle error and the depth.
4. **HUD.** Two rings, tip and chuck: when they are concentric on the mark, you're on target and square. One short
   instruction at a time (*Tip to the mark → Line up the rings → Ready · drill → Stop · 35 mm*).

In the prototype, everything runs in the browser at camera rate: no IMU, no server, and no LLM tokens in the real-time
loop.

### Prototype accuracy (synthetic)

`scripts/pose-selftest.mts` renders the marker sheet with a known perspective, runs the full detection and pose
pipeline, and compares the result with ground truth. It passes at < 1 mm and < 0.1°, and typically measures
0.06–0.21 mm and ≤ 0.03°. Real-camera accuracy (lens distortion, vibration) has not been measured, so these figures describe the prototype
under ideal conditions, not the SmartTools application.

## Scenario gallery

The home page opens with a 3D-assembly job (below) and has a gallery of nineteen scenarios. Each one runs the real
engine (WASM) on scripted tool motion and is drawn three ways from the same snapshots:

- a 3D scene (the scene definition's `visual3d`: STL dock, drill, sheet);
- a 2D view (the phone HUD over what the camera sees, or a plan from `visual2d`);
- a panel with the numbers the engine decides with.

| Scenario | What it shows |
|---|---|
| 3D assembly (main animation) | A robot-arm base: located by touch, verified, 10 screws on three faces, a bracket placed, probed and screwed |
| Markers on the part | Stickers learned, the part moved and followed, the sheet covered, a slip caught |
| Factory markers | A part that locates itself on sight |
| Hands-free | Tap twice to confirm, twist to skip, sound guidance |
| Learn from an expert | A ghost to follow and a score per screw |
| Remote expert | A hole marked from afar lights up on the part |
| No-go zones | A pipe behind a mark: refused; pushing too hard: flagged |
| Locate by touch | Four touches with the bit tip register the part; its CAD model snaps onto it |
| Screws on every face | Top and 35° chamfer, each screw along its own axis and to its own depth |
| Verify a mount | A bracket 2 mm off is caught by probing before the first screw |
| The core loop | Three holes, square and to depth |
| Calibrate | Circle around the tip, then twist: the gate opens only after |
| Angled hole | A mark planned 15° off the normal, no special case |
| The gate says no | Covered markers, a shaking hand, a tilted bit while drilling |
| What the camera sees | Dock v0.2 (tip out of view, no markers) vs v0.4 |
| One dock, any phone | Redmi Note 13 vs Redmi 15 profiles in the same dock |
| athos (planned) | The recipe as When / Do / Check / Because steps, each Check passed by the engine |
| contract-gatekeeper (planned) | An agent-written tool plugin fast-tracked, another rejected for touching the geometry core |
| agentvcs (planned) | One step record per hole from live engine events; blame / bisect across versions (illustrative) |

The code is in `lib/gallery/` (scenarios and a headless runner) and `components/gallery/`. `tests/gallery.test.mts`
runs every scenario on the engine and checks what each one claims.

## 3D assembly: the bit tip as a probe

Real jobs are not flat. `lib/assembly.ts` defines a robot-arm base:

- a block with a 35° chamfer, a tower, and a bracket that mounts on the tower;
- 10 screws on three faces, each with its own depth: M5 × 14 mm on the top, M4 × 10 mm on the chamfer, M4 × 12 mm
  through the bracket;
- four registration dimples, and checkpoints for verification.

Every screw hole is a frame that is a child of its part in the engine's scene graph. The job goes like this:

1. **Locate:** touch the four dimples with the bit tip. The engine registers the part by paired-point registration
   (Horn), in Rust, using the tip positions it measured. The part's CAD model, every hole included, snaps onto the
   real part.
2. **Verify:** touch points the registration did not use, and compare them with the CAD.
3. **Drive:** for each screw, the rings, the go / no-go gate and the depth stop follow that hole's own axis.
4. **Mount and probe:** a placed part is probed. If it is off, it is caught; once re-seated, three touches locate it
   too.

Safety rules in the engine:

- **No screw on a part that is not located:** a new gate reason, `NOT_LOCATED`.
- **Depth only counts inside the hole.** In 3D the tip can be "below" a far-away hole's plane.
- **Decisions use measured poses.** The prediction that compensates latency is only for display; it overshoots for a
  moment when the tool stops against a part.

End-to-end, with simulated camera images (`npm run test:e2e -- --only lens,dock,assembly`):

| | Result |
|---|---|
| Before registering | never "ready" (gate: not located) |
| Registration from 4 touches | FRE 0.04 mm; every base hole within 0.10 mm of the true part |
| Verification on 2 unused points | 0.07 mm and 0.05 mm |
| M5 on the top / M4 on the 35° chamfer | seated at 14 / 10 mm; tip p95 0.27 / 0.15 mm; angle p95 0.09° / 0.04° |

The marker sheet lies on the bench beside the part. The camera is turned about the bit to face it, which keeps 6–29
markers in view on every touch and screw.



The printed dock is the same for every phone. A profile (`lib/phones.ts`) gives the phone's size and the position of
its main lens. With it, the simulator, the 3D view and the rig check place the camera correctly. On the phone,
`/hud` → **Phone** selects the profile. Lens and dock calibrations are stored per phone, and **Export** / **Import**
move them as JSON.

After **Calibrate**, the app compares the measured tip with what the profile predicts across the tilt range. It warns
if they differ by more than 15 mm, which usually means the phone is the wrong way round, the dock moved or the profile
is wrong. The Redmi 15 profile is provisional until measured. To check a phone's rig before printing, run
`npm run test:e2e -- --phone redmi-15 --only rig`.

## On the part: anchors, guidance, safety, hands-free

The camera sees the job and the engine knows where every hole is, so the job can talk back. Each item is a scenario
in the gallery, running on the real engine.

- **Markers on the part (anchors).** After registering a part by touch, stick a few marker stickers on it anywhere.
  The camera sees them once and learns where they are (`lib/anchors.ts`). From then on the part is a moving
  reference: the engine follows it when it is moved or flipped, and it can replace the sheet. A part that slips in
  the vise while driving raises an alarm.
- **Factory markers.** A part with markers at known CAD positions is located and identified on sight. No touching.
- **Guidance on the part** (`lib/guidance.ts`, drawn by `lib/render/guidance3d.ts` in the 3D view and in the
  phone's view):
  - the next hole glows, done screws turn green, and going out of order is flagged;
  - an approach tunnel rises from the active hole, coloured by the error;
  - x-ray shows the screw inside the part and the material left beyond its tip, and warns when it would break
    through;
  - the next part appears as a hologram where it goes, and turns green when the real one matches.
- **No-go zones.** Pipes and cables are boxes in the scene. A hole whose path comes too close is refused (gate
  reason `KEEP_OUT`), and a tip that comes too close while drilling raises an alarm.
- **Feed advice.** The engine flags pushing too hard and a bit that has stopped advancing.
- **Hands-free.** The drill is the remote: two taps of the tip confirm, a twist of the drill and back moves on (both
  detected by the engine, `engine/src/gesture.rs`). A tone guides alignment and depth (`lib/audio.ts`; Sound
  button in the HUD), and the phone vibrates when a screw seats.
- **Learn from an expert.** An expert's run is replayed as a ghost tool one step ahead, and each screw gets a score
  from what the engine measured (`lib/coach.ts`).
- **Remote expert.** The engine streams poses, not video: a few kB/s. A remote expert sees the 3D scene live, marks a
  hole, and it lights up on the operator's phone.
- **Report.** Depth, angle and flags per screw, a heat map on the part, and an HTML or JSON report to download
  (`lib/report.ts`).

End-to-end with simulated camera images (`npm run test:e2e -- --only lens,dock,anchors,factory,gestures,nogo`):

| | Result |
|---|---|
| Stickers learned from images | 7 of 9, each within 0.4 mm of where it was stuck (0.54 mm with the Redmi 15 profile) |
| Part turned 25° and slid 4 cm | followed without touching it again: every hole within 0.2 mm |
| Screw on the moved part / with the sheet covered | seated; tip p95 0.45 / 0.24 mm |
| Part slips 1.2 mm while driving | part-moved alarm 0.21 s later (0.28 s with the Redmi 15), no false alarm before |
| Factory markers | located 0.04 s after it was seen; holes within 0.13 mm; screws seated with tip p95 ≤ 0.5 mm |
| Gestures | one confirm for two taps, one next for a twist; resting on a mark and a slow turn are not gestures |
| No-go zone | never "ready" on a hole with a pipe behind it |

A limit found on the way: a slip can only be told apart from the camera moving while a fixed reference (the sheet)
is in view. With only the part's own markers in view, the part is the reference and a slip goes unnoticed.

## Hardware

[`hardware/dock/`](hardware/dock/) holds the parametric, adjustable 3D-printable phone dock for cordless drill/drivers
(v0.4, not printed yet): split V clamp for Ø38–68 mm bodies, phones 140–175 mm, 0–25° tilt (15° by default). It includes the STLs, the
[print and assembly guide](hardware/dock/README.md) and the Python generator (`dock.py`, manifold3d).

`dock.py` also exports the dock's geometry (`hardware/dock/rig.json`, `lib/dockgeom.ts`). The scene simulator, the 3D
view and the end-to-end tests place the camera, the bit and the dock parts from it, so the software is tested against
the dock as designed. The simulator also caught a design error this way: v0.2 left the bit tip out of the camera's
image and no marker in view on A1 (`npm run test:e2e -- --rig v02 --only rig`). v0.3 put the lens right above the bit
but low: a check that intersects the camera's view with the parts showed the arm's leg in front of the lens and the
saddle hiding the tip. v0.4 puts the lens above the bit and above the hinge, tilted 15°, with the arm's post beside
the phone: the view to the tip is clear (`dock.py` fails the build if it is not).

## Run locally

```bash
npm install
npm run dev                                   # website at http://localhost:3000
node --no-warnings scripts/pose-selftest.mts  # synthetic test of the tracking prototype
npm run engine:test                           # Rust core: cargo test + parity with TypeScript
node --no-warnings scripts/replay.mts f.strec # replay a camera recording from the phone with both detectors
npm test                                      # Rust + parity + TypeScript unit + quick E2E
```

The camera preview in `/hud` needs HTTPS or `localhost`. To try it on a phone, deploy (for example to Vercel) or use
an HTTPS tunnel.

## Navigation engine

The design is in [docs/ENGINE_SPEC.md](docs/ENGINE_SPEC.md):

- **Clock.** A central engine clock ticks at 120 Hz. Every tick, it ingests timestamped measurements, filters and
  predicts each tracked element, recomputes its scene graph and runs every check: the go / no-go gate, the lock, the
  phases and the safety alarms.
- **Scene graph.** Each element (sheet, holes, phone camera, drill, dock) is a node with a position, a quaternion and
  an optional parent. World transforms are recomputed from scratch every tick, so nothing drifts.
- **Trackers and renderers.** Trackers only write measurements; they run in a Web Worker on the phone. Renderers only
  read snapshots, as often as they can, or not at all.
- **Representations.** Every element can have a 3D representation (STL meshes or primitives, with surface
  properties) and a simplified 2D one. The drill, for example, is a 3D model in the 3D scene and tip and chuck rings in
  the 2D plan and on the phone.

| Part | Where |
|---|---|
| Scene graph, engine, math, calibration, scene simulator | [`engine/`](engine/) (Rust → ~170 KB WebAssembly, `lib/engine.ts`) |
| Tracker (frames → measurements) | `lib/markertracker.ts`, run in `lib/workers/tracker.worker.ts` |
| Session (tracker → engine → snapshots) | `lib/session.ts`, browser loops in `lib/tracker.ts` |
| Scene definition with 3D / 2D representations | `lib/scenedef.ts` |
| Renderers: 3D, 2D plan, phone HUD | `lib/render/`, `lib/hud.ts` |

[`/engine`](https://smarttools-nav.vercel.app/engine) shows it working. One engine is fed by the scene simulator and
drawn three ways from the same snapshots: 3D, 2D plan and HUD. Each renderer can be slowed down or switched off while
the engine keeps 120 Hz.

### Tests

```bash
npm run engine:test   # Rust: 68 tests + TypeScript/Rust parity
npm run test:unit     # TypeScript: 92 tests (transforms, engine wrapper, scene definitions, dock geometry, phones, assembly, anchors, guidance, sound, coach and report, session, renderers, gallery, plans, jobs, memory, agentvcs ledger, bench lab, Rust marker detector, recordings, athos recipes, agentvcs verify / blame / bisect, gates); set AGENTVCS_BIN to the agentvcs CLI to also run `agentvcs verify`
npm run gate          # the verdict for this branch against main: FAST_TRACK, ESCALATE (run the engine tests and e2e too) or REJECTED
npm run test:e2e      # 15 end-to-end scenarios, 53 checks on the dock v0.4 (add -- --tilt 10, -- --rig ideal|v02, -- --quick, -- --only drill)
```

The end-to-end scenarios render camera frames with the simulator (lens distortion, the bit in view, hand tremor,
motor vibration, blur, uneven light, noise, a hand over the markers). They track the frames with the real tracker,
feed the engine with capture timestamps and compare every snapshot with the ground truth:

| Scenario | Result (15 fps camera, 50 ms latency) |
|---|---|
| Rig (dock v0.4) | bit tip 15° below the image centre; 9–19 markers in view on every mark |
| Lens calibration | focal length within 0.01 %, k1 within 0.001 |
| Dock calibration | tip within 0.05 mm, axis within 0.003° |
| Three holes with tremor and vibration (p95, aligning and drilling) | tip 0.24 mm, angle 0.13°, aim 0.30 mm, depth 0.19 mm |
| Latency compensation (80 ms) | moving-tip error p95 10.4 mm → 3.7 mm |
| Renderer at 20 Hz, a 300 ms stall | ~6 ticks skipped per frame; the stall reported as an overrun; no "ready" on old data |
| Frames out of order | merged, none dropped |
| A hole planned 15° off the normal | "ready" and drilled along its own axis (angle p95 0.07°) |
| 3D assembly | located by 4 touches (FRE 0.04 mm), verified (≤ 0.07 mm), screws seated on the top and a 35° chamfer |
| Safety | no false "ready" in any scenario; never "ready" when covered, uncalibrated or shaking; angle alarm while drilling |

These are simulated results. They show that the method and the software work, not how a real phone performs (rolling
shutter, compression, autofocus, a real hand).

## Code map (website)

| Path | Contents |
|---|---|
| `components/NavDemo.tsx` | three.js line scene on the landing page |
| `components/HudScreen.tsx` | Full-screen phone HUD (`/hud`): camera, simulated camera, calibration flows |
| `components/EngineLab.tsx` | `/engine`: the engine drawn in 3D, as a 2D plan and as the HUD |
| `components/gallery/` | The home-page main animation (3D assembly) and the scenario gallery |
| `lib/assembly.ts` | The 3D-assembly job: parts, screw holes as frames, registration and probing, stickers, solids |
| `lib/anchors.ts` | Markers on parts: solving a part's pose from several faces, learning stickers |
| `lib/guidance.ts`, `lib/render/guidance3d.ts` | Glow, approach tunnel, x-ray, order, heat map, ghost tool |
| `lib/audio.ts`, `lib/coach.ts`, `lib/report.ts` | Sound guidance, scores against an expert, the job report |
| `lib/sim.ts` | Scripted drilling animation for the landing page |
| `lib/board.ts` | Marker sheet geometry and targets |

## Related projects

How each one should come in (used from its repository, with only its format implemented here) is analysed in
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

- [athos](https://github.com/athos-agent/athos): verified procedural know-how as Markdown steps (When / Do / Check / Because), replayed step by step on the tool
- [contract-gatekeeper](https://github.com/matiasmolinas/contract-gatekeeper): zero-LLM deterministic verifier for agent-written plugins
- [agentvcs](https://github.com/EvolvingAgentsLabs/agentvcs): version control for running agent harnesses, with each hole recorded as a step

## Status

This repository is the website and its demo, v0. The SmartTools application will be published separately over the
coming weeks, within the next month. The tracking prototype here is verified only synthetically and with a simulated
camera feed, and the dock has not been printed yet. **Do not use the demo to drill where a mistake can hurt someone**
(hidden wires, pipes, structural elements).

## License

Copyright 2026 Matias Molinas. Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
