// TypeScript wrapper for the Rust navigation core (engine/, compiled to public/engine/nav_core.wasm).
// Same types and results as lib/pose.ts and lib/subpix.ts; scripts/engine-parity.mts checks it.

import type { Intrinsics, M3, Pose } from "./pose";

type P = { x: number; y: number };

interface Exports {
  memory: WebAssembly.Memory;
  st_abi_version(): number;
  st_alloc(bytes: number): number;
  st_free(ptr: number, bytes: number): void;
  st_homography(world: number, img: number, n: number, out: number): number;
  st_pose_from_homography(h: number, f: number, cx: number, cy: number, out: number): number;
  st_refine_pose(pose: number, world: number, img: number, n: number, f: number, cx: number, cy: number, iters: number, out: number): number;
  st_solve_pose(world: number, img: number, n: number, f: number, cx: number, cy: number, out: number): number;
  st_focal_from_homography(h: number, cx: number, cy: number): number;
  st_refine_corners(rgba: number, width: number, height: number, corners: number, out: number): number;
}

export const ENGINE_ABI = 1;
export const ENGINE_URL = "/engine/nav_core.wasm";

export class NavCore {
  private x: Exports;
  private constructor(x: Exports) {
    this.x = x;
  }

  /** Load from a URL (browser) or from the .wasm bytes (Node, tests). */
  static async load(source: string | BufferSource = ENGINE_URL): Promise<NavCore> {
    const { instance } =
      typeof source === "string"
        ? await WebAssembly.instantiateStreaming(fetch(source), {})
        : await WebAssembly.instantiate(source, {});
    const x = instance.exports as unknown as Exports;
    const abi = x.st_abi_version();
    if (abi !== ENGINE_ABI) throw new Error(`nav_core ABI ${abi}, expected ${ENGINE_ABI}`);
    return new NavCore(x);
  }

  // ---- linear-memory helpers: allocate, run, always free ----
  private with<T>(sizes: number[], run: (ptrs: number[]) => T): T {
    const ptrs = sizes.map((b) => this.x.st_alloc(b));
    try {
      return run(ptrs);
    } finally {
      ptrs.forEach((p, i) => this.x.st_free(p, sizes[i]));
    }
  }
  private f64(ptr: number, len: number) {
    return new Float64Array(this.x.memory.buffer, ptr, len); // re-create after any alloc (memory may grow)
  }
  private putPts(ptr: number, pts: P[]) {
    const a = this.f64(ptr, pts.length * 2);
    pts.forEach((p, i) => {
      a[i * 2] = p.x;
      a[i * 2 + 1] = p.y;
    });
  }
  private getPose(ptr: number): Pose {
    const a = this.f64(ptr, 13);
    return { R: Array.from(a.subarray(0, 9)) as M3, t: [a[9], a[10], a[11]], rms: a[12] };
  }
  private putPose(ptr: number, p: Pose) {
    const a = this.f64(ptr, 13);
    a.set(p.R, 0);
    a.set(p.t, 9);
    a[12] = p.rms;
  }

  homography(world: P[], img: P[]): M3 | null {
    const n = world.length;
    if (n < 4 || img.length !== n) return null;
    return this.with([n * 16, n * 16, 72], ([w, i, o]) => {
      this.putPts(w, world);
      this.putPts(i, img);
      return this.x.st_homography(w, i, n, o) === 1 ? (Array.from(this.f64(o, 9)) as M3) : null;
    });
  }

  poseFromHomography(H: M3, K: Intrinsics): Pose | null {
    return this.with([72, 104], ([h, o]) => {
      this.f64(h, 9).set(H);
      return this.x.st_pose_from_homography(h, K.f, K.cx, K.cy, o) === 1 ? this.getPose(o) : null;
    });
  }

  refinePose(pose: Pose, world: P[], img: P[], K: Intrinsics, iters = 8): Pose {
    const n = world.length;
    return this.with([104, n * 16, n * 16], ([p, w, i]) => {
      this.putPose(p, pose);
      this.putPts(w, world);
      this.putPts(i, img);
      this.x.st_refine_pose(p, w, i, n, K.f, K.cx, K.cy, iters, p);
      return this.getPose(p);
    });
  }

  /** homography + decomposition + Gauss-Newton, the per-frame solve */
  solvePose(world: P[], img: P[], K: Intrinsics): Pose | null {
    const n = world.length;
    if (n < 4 || img.length !== n) return null;
    return this.with([n * 16, n * 16, 104], ([w, i, o]) => {
      this.putPts(w, world);
      this.putPts(i, img);
      return this.x.st_solve_pose(w, i, n, K.f, K.cx, K.cy, o) === 1 ? this.getPose(o) : null;
    });
  }

  focalFromHomography(H: M3, cx: number, cy: number): number | null {
    return this.with([72], ([h]) => {
      this.f64(h, 9).set(H);
      const f = this.x.st_focal_from_homography(h, cx, cy);
      return Number.isNaN(f) ? null : f;
    });
  }

  /** Sub-pixel corners of one marker; returns the input corners when refinement is rejected. */
  refineCorners(img: { width: number; height: number; data: Uint8ClampedArray }, corners: P[]): P[] {
    const bytes = img.width * img.height * 4;
    return this.with([bytes, 64, 64], ([d, c, o]) => {
      new Uint8Array(this.x.memory.buffer, d, bytes).set(img.data);
      this.putPts(c, corners);
      if (this.x.st_refine_corners(d, img.width, img.height, c, o) !== 1) return corners;
      const a = this.f64(o, 8);
      return [0, 1, 2, 3].map((k) => ({ x: a[k * 2], y: a[k * 2 + 1] }));
    });
  }
}
