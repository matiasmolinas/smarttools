# smarttools-nav-core

The SmartTools navigation core in Rust: from printed-marker corners in a camera image to the 6-DoF pose
of the tool. No dependencies, so the same code runs in the browser (WebAssembly), in a native app and,
later, on our own camera module.

| Module | Contents |
|---|---|
| `geom` | Fixed-size vectors and 3×3 matrices, Rodrigues, Gauss-Jordan solve |
| `pose` | Normalised DLT homography, pose from homography, Gauss-Newton refinement, focal self-calibration |
| `subpix` | Sub-pixel marker corners (edge line fit at the 50 % crossing, side intersection) |
| `board` | Geometry of the printable A4 marker sheet (`/markers`) |
| `ffi` | C ABI for WebAssembly: `st_solve_pose`, `st_refine_corners`, … (wrapped by `lib/engine.ts`) |

Frames: world = the marker sheet (origin at its centre, X right, Y up, Z out of the surface, metres);
camera = OpenCV (x right, y down, z forward), `x_cam = R · X_world + t`.

## Build and test

```bash
rustup target add wasm32-unknown-unknown
npm run engine:build   # cargo build → public/engine/nav_core.wasm (~50 KB)
npm run engine:test    # cargo test + parity against the TypeScript prototype
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
