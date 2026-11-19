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
| [`/hud`](https://smarttools-nav.vercel.app/hud) | The phone screen only, for demos. Simulated (wall, wood, grid) or with an experimental rear-camera preview (**Cam**) |
| [`/markers`](https://smarttools-nav.vercel.app/markers) | Printable A4 sheet with 6 ArUco markers and 3 targets (A1–A3) |

## How the demo works

The website includes a browser prototype of the optical tracking, built to illustrate the idea in the demo. It is
not the SmartTools application, which will be published separately.

1. **Markers.** Print `/markers` at 100 % and tape it where you'll drill. Six ArUco markers (ARUCO_MIP_36h12, 40 mm)
   surround three targets.
2. **Pose.** The rear camera detects the markers ([js-aruco2](https://github.com/damianofalcioni/js-aruco2)). Corners
   are refined to sub-pixel accuracy, then a normalized DLT homography gives an initial pose, which Gauss-Newton refines.
   The focal length self-calibrates from tilted views.
3. **Tool.** The dock keeps the camera rigid with the drill. One calibration (tip resting on A2) stores the bit tip in
   the camera frame, so every frame gives the tip position, the bit axis, the aim point on the surface, the angle error
   and the depth.
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
```

The camera preview in `/hud` needs HTTPS or `localhost`. To try it on a phone, deploy (for example to Vercel) or use
an HTTPS tunnel.

## Code map (website)

| Path | Contents |
|---|---|
| `lib/tracker.ts` | Tracking prototype: markers → pose → drill state + overlay |
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
