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
| [`/`](https://smarttools-nav.vercel.app) | Landing page with a three.js line scene of the drill, wall, markers and docked phone, plus the 2D HUD |
| [`/hud`](https://smarttools-nav.vercel.app/hud) | The phone screen only. Simulated (wall, wood, grid), the scene simulator tracked by the real pipeline (**Sim cam**), or the rear camera (**Cam**, with **Lens** and **Calibrate**) |
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

## Hardware

[`hardware/dock/`](hardware/dock/) holds a first design (v0.2, not printed yet) of a parametric, adjustable 3D-printable phone dock for cordless drill/drivers
(split V clamp, Ø38–68 mm; phones 140–175 mm; ±15° tilt). It includes the STLs, the
[print and assembly guide](hardware/dock/README.md) and the Python generator (`dock.py`, manifold3d).

## Run locally

```bash
npm install
npm run dev                                   # website at http://localhost:3000
node --no-warnings scripts/pose-selftest.mts  # synthetic test of the tracking prototype
npm run engine:test                           # Rust core: cargo test + parity with TypeScript
npm run scene:test                            # full pipeline on simulated camera frames (add -- --tilt 12 or -- --quick)
```

The camera preview in `/hud` needs HTTPS or `localhost`. To try it on a phone, deploy (for example to Vercel) or use
an HTTPS tunnel.

## Navigation engine (Rust) and scene simulator

[`engine/`](engine/) is the navigation core in Rust (`smarttools-nav-core`), compiled to a ~100 KB WebAssembly
module (`public/engine/nav_core.wasm`, wrapped by `lib/engine.ts`):

- **Pose:** sub-pixel corners, normalised DLT homography, Gauss-Newton refinement, and a robust solve that drops
  markers half hidden by the drill bit.
- **Lens:** Brown-Conrady distortion and camera calibration (focal length, principal point, k1, k2).
- **Dock calibration:** the bit tip by circling around it (pivot), the bit axis by twisting around it, so the camera
  does not have to be parallel to the bit.
- **Navigation:** tip, axis, aim point, angle, offset, depth, a One Euro filter, steadiness, and a deterministic
  go / no-go gate (calibrated, enough markers, good fit, steady, square within 0.4°, on the mark within 0.75 mm).
- **Scene simulator:** renders what the docked camera sees: the marker sheet through a distorting lens, the bit in view,
  hand tremor, motor vibration, motion blur, uneven light, sensor noise and a hand over the markers.

`lib/navpipeline.ts` is the one pipeline used by the phone and by the tests. `npm run scene:test` runs it on simulated
frames and checks everything against the ground truth: lens and dock calibration, three holes with tremor and
vibration, occlusion, an uncalibrated dock and a shaking hand. It currently passes 17/17 (15 fps):

| | Result |
|---|---|
| Lens calibration | focal length within 0.01 %, k1 within 0.001 |
| Dock calibration | tip within 0.1 mm, axis within 0.05° |
| Drilling (p95) | angle 0.08–0.10°, aim 0.09–0.11 mm, depth 0.06 mm |
| Gate | no false "ready" (truth outside 0.5° / 1 mm), "ready" reached on every hole |
| Without calibration | angle error 3.4° (parallel dock) to 13° (tilted dock) |

These are simulated results: they show the method and the software work, not how a real phone performs (rolling
shutter, compression, autofocus, a real hand). `/hud` → **Sim cam** shows the same simulation running in the browser.
See the [engine README](engine/README.md).

## Code map (website)

| Path | Contents |
|---|---|
| `lib/navpipeline.ts` | The navigation pipeline: frame → markers → pose → navigation → gate (phone and tests) |
| `lib/tracker.ts` | Browser side: camera or simulated frames, calibration flows, stored calibration, HUD state |
| `lib/scene.ts` | Scene simulator: the rig, the drilling motion, tremor, vibration, rendered frames |
| `lib/engine.ts` | TypeScript wrapper for the Rust core |
| `lib/pose.ts` | Homography, pose from homography, Gauss-Newton refinement, focal estimate |
| `lib/subpix.ts` | Sub-pixel corner refinement |
| `lib/board.ts` | Marker sheet geometry and targets |
| `lib/hud.ts` | 2D HUD renderer (canvas) |
| `lib/sim.ts` | Deterministic drilling simulation for the demo |
| `components/NavDemo.tsx` | three.js scene |
| `components/HudScreen.tsx` | Full-screen phone HUD |

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
