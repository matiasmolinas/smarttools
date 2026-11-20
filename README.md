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
| [`/`](https://smarttools-nav.vercel.app) | Landing page with a three.js line scene of the drill, wall, markers and docked phone, plus the 2D HUD, and a [gallery of scenarios](https://smarttools-nav.vercel.app/#scenarios) running the real engine in 3D + 2D |
| [`/hud`](https://smarttools-nav.vercel.app/hud) | The phone screen only. Simulated (wall, wood, grid), the scene simulator tracked by the real pipeline (**Sim cam**), or the rear camera (**Cam**, with **Phone**, **Lens**, **Calibrate**, export / import) |
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

The home page has a gallery of nine scenarios. Each one runs the real engine (WASM) on scripted tool motion and is
drawn three ways from the same snapshots:

- a 3D scene (the scene definition's `visual3d`: STL dock, drill, sheet);
- a 2D view (the phone HUD over the simulated camera image, or a plan from `visual2d`);
- a panel with the numbers the engine decides with.

| Scenario | What it shows |
|---|---|
| The core loop | Three holes, square and to depth |
| Calibrate | Circle around the tip, then twist: the gate opens only after |
| Angled hole | A mark planned 15° off the normal, no special case |
| The gate says no | Covered markers, a shaking hand, a tilted bit while drilling |
| What the camera sees | Dock v0.2 (tip out of view, no markers) vs v0.3 |
| One dock, any phone | Redmi Note 13 vs Redmi 15 profiles in the same dock |
| athos (planned) | The recipe as When / Do / Check / Because steps, each Check passed by the engine |
| contract-gatekeeper (planned) | An agent-written tool plugin fast-tracked, another rejected for touching the geometry core |
| agentvcs (planned) | One step record per hole from live engine events; blame / bisect across versions (illustrative) |

The code is in `lib/gallery/` (scenarios and a headless runner) and `components/gallery/`. `tests/gallery.test.mts`
runs every scenario on the engine and checks what each one claims.

## Phone profiles

The printed dock is the same for every phone. A profile (`lib/phones.ts`) gives the phone's size and the position of
its main lens. With it, the simulator, the 3D view and the rig check place the camera correctly. On the phone,
`/hud` → **Phone** selects the profile. Lens and dock calibrations are stored per phone, and **Export** / **Import**
move them as JSON.

After **Calibrate**, the app compares the measured tip with what the profile predicts across the tilt range. It warns
if they differ by more than 15 mm, which usually means the phone is the wrong way round, the dock moved or the profile
is wrong. The Redmi 15 profile is provisional until measured. To check a phone's rig before printing, run
`npm run test:e2e -- --phone redmi-15 --only rig`.

## Hardware

[`hardware/dock/`](hardware/dock/) holds the parametric, adjustable 3D-printable phone dock for cordless drill/drivers
(v0.3, not printed yet): split V clamp for Ø38–68 mm bodies, phones 140–175 mm, 0–20° tilt. It includes the STLs, the
[print and assembly guide](hardware/dock/README.md) and the Python generator (`dock.py`, manifold3d).

`dock.py` also exports the dock's geometry (`hardware/dock/rig.json`, `lib/dockgeom.ts`). The scene simulator, the 3D
view and the end-to-end tests place the camera, the bit and the dock parts from it, so the software is tested against
the dock as designed. The simulator also caught a design error this way: v0.2 left the bit tip out of the camera's
image and no marker in view on A1 (`npm run test:e2e -- --rig v02 --only rig`). v0.3 puts the camera right above the
bit, with the tip 14° below the image centre.

## Run locally

```bash
npm install
npm run dev                                   # website at http://localhost:3000
node --no-warnings scripts/pose-selftest.mts  # synthetic test of the tracking prototype
npm run engine:test                           # Rust core: cargo test + parity with TypeScript
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
npm run engine:test   # Rust: 43 tests + TypeScript/Rust parity
npm run test:unit     # TypeScript: 31 tests (transforms, engine wrapper, scene definitions, dock geometry, phones, session, renderers, gallery)
npm run test:e2e      # 9 end-to-end scenarios, 34 checks on the dock v0.3 (add -- --tilt 10, -- --rig ideal|v02, -- --quick, -- --only drill)
```

The end-to-end scenarios render camera frames with the simulator (lens distortion, the bit in view, hand tremor,
motor vibration, blur, uneven light, noise, a hand over the markers). They track the frames with the real tracker,
feed the engine with capture timestamps and compare every snapshot with the ground truth:

| Scenario | Result (15 fps camera, 50 ms latency) |
|---|---|
| Rig (dock v0.3) | bit tip 14° below the image centre; 9–23 markers in view on every mark |
| Lens calibration | focal length within 0.01 %, k1 within 0.001 |
| Dock calibration | tip within 0.05 mm, axis within 0.003° |
| Three holes with tremor and vibration (p95, aligning and drilling) | tip 0.24 mm, angle 0.13°, aim 0.30 mm, depth 0.19 mm |
| Latency compensation (80 ms) | moving-tip error p95 10.4 mm → 3.7 mm |
| Renderer at 20 Hz, a 300 ms stall | ~6 ticks skipped per frame; the stall reported as an overrun; no "ready" on old data |
| Frames out of order | merged, none dropped |
| A hole planned 15° off the normal | "ready" and drilled along its own axis (angle p95 0.07°) |
| Safety | no false "ready" in any scenario; never "ready" when covered, uncalibrated or shaking; angle alarm while drilling |

These are simulated results. They show that the method and the software work, not how a real phone performs (rolling
shutter, compression, autofocus, a real hand).

## Code map (website)

| Path | Contents |
|---|---|
| `components/NavDemo.tsx` | three.js line scene on the landing page |
| `components/HudScreen.tsx` | Full-screen phone HUD (`/hud`): camera, simulated camera, calibration flows |
| `components/EngineLab.tsx` | `/engine`: the engine drawn in 3D, as a 2D plan and as the HUD |
| `components/gallery/` | The home-page scenario gallery (player + cards) |
| `lib/sim.ts` | Scripted drilling animation for the landing page |
| `lib/board.ts` | Marker sheet geometry and targets |

## Related projects

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
