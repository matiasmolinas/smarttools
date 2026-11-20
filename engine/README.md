# smarttools-nav-core

Architecture and specification: [docs/ENGINE_SPEC.md](../docs/ENGINE_SPEC.md).

The SmartTools navigation core in Rust: from printed-marker corners in a camera image to the 6-DoF pose
of the tool. No dependencies, so the same code runs in the browser (WebAssembly), in a native app and,
later, on our own camera module.

| Module | Contents |
|---|---|
| `geom` | Fixed-size vectors and 3×3 matrices, Rodrigues, Gauss-Jordan solve |
| `pose` | Normalised DLT homography, pose from homography, Gauss-Newton, focal from a homography, robust solve (drops inconsistent markers) |
| `subpix` | Sub-pixel marker corners (edge line fit at the 50 % crossing, side intersection) |
| `camera` | Pinhole + Brown-Conrady distortion (k1, k2, p1, p2), undistortion, projection |
| `calib` | Camera calibration (Levenberg-Marquardt over intrinsics and all views, drops bad views), pivot (tip), twist (axis) |
| `nav` | Navigation state, One Euro filter, steadiness, the go / no-go gate |
| `sim` | Scene simulator: renders the sheet through the lens with the bit, blur, light, noise and occluders |
| `scene` | Scene graph: quaternions, transforms, nodes with parents, topological world update, relative transforms |
| `engine` | The engine: logical clock, measurement queue, filter and prediction per tracked node, navigation in target frames, gate, lock, phases, alarms, events, snapshot |
| `board` | Geometry of the printable A4 marker sheet v2 (`/markers`) |
| `ffi` | C ABI for WebAssembly (`st_*`), wrapped by `lib/engine.ts` |

Frames: world = the marker sheet (origin at its centre, X right, Y up, Z out of the surface, metres);
camera = OpenCV (x right, y down, z forward), `x_cam = R · X_world + t`.

## Build and test

```bash
rustup target add wasm32-unknown-unknown
npm run engine:build   # cargo build → public/engine/nav_core.wasm (~170 KB)
npm run engine:test    # cargo test (43 tests) + parity against the TypeScript prototype
npm run test:unit      # TypeScript unit tests (node:test)
npm run test:e2e       # end-to-end scenarios on simulated camera frames, against ground truth
```

`scripts/engine-parity.mts` runs 300 random camera views (24 noisy corners each) and 60 anti-aliased
marker images through both implementations. The results match to ~1e-14 (limit 1e-9).
The full solve (homography + pose + Gauss-Newton) takes 6.5 µs in WASM versus 31 µs in TypeScript (Node, Apple Silicon).

## Use from TypeScript

```ts
import { NavCore } from "@/lib/engine";
const core = await NavCore.load();              // fetches /engine/nav_core.wasm
const pose = core.solvePose(world, img, { f, cx, cy });
```

`public/engine/nav_core.wasm` is committed so the site builds without a Rust toolchain. Rebuild it after
changing the crate and rerun the parity test.
