//! C ABI for WebAssembly (and any native host). No bindgen: the caller allocates with
//! [`st_alloc`], writes `f64`/`u8` buffers into linear memory, calls a function and reads the
//! output buffer. The TypeScript wrapper is `lib/engine.ts`.
//!
//! Layouts:
//! - point list: `n` points as `[x0, y0, x1, y1, ...]` (`f64`)
//! - homography: 9 `f64`, row-major
//! - pose: 13 `f64` = `R` (9, row-major), `t` (3), `rms`
//!
//! Return codes: `1` = ok, `0` = no solution (output untouched), `-1` = bad arguments.

use crate::geom::{M3, P2};
use crate::pose::{self, Intrinsics, Pose};
use crate::subpix::{self, Rgba};
use std::alloc::{alloc, dealloc, Layout};
use std::slice;

pub const ABI_VERSION: u32 = 1;

#[no_mangle]
pub extern "C" fn st_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocate `bytes` (8-byte aligned). Free with [`st_free`] and the same size.
#[no_mangle]
pub extern "C" fn st_alloc(bytes: usize) -> *mut u8 {
    match Layout::from_size_align(bytes.max(1), 8) {
        // SAFETY: non-zero size, valid alignment
        Ok(l) => unsafe { alloc(l) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `ptr` must come from [`st_alloc`] with the same `bytes`.
#[no_mangle]
pub unsafe extern "C" fn st_free(ptr: *mut u8, bytes: usize) {
    if !ptr.is_null() {
        dealloc(ptr, Layout::from_size_align_unchecked(bytes.max(1), 8));
    }
}

unsafe fn points(p: *const f64, n: usize) -> Option<Vec<P2>> {
    if p.is_null() {
        return None;
    }
    let s: &[f64] = slice::from_raw_parts(p, n * 2);
    Some(s.chunks_exact(2).map(|c| P2::new(c[0], c[1])).collect())
}

unsafe fn write_pose(out: *mut f64, p: &Pose) {
    let o = slice::from_raw_parts_mut(out, 13);
    o[..9].copy_from_slice(&p.r);
    o[9..12].copy_from_slice(&p.t);
    o[12] = p.rms;
}

unsafe fn read_pose(p: *const f64) -> Pose {
    let s = slice::from_raw_parts(p, 13);
    let mut r = [0.0; 9];
    r.copy_from_slice(&s[..9]);
    Pose { r, t: [s[9], s[10], s[11]], rms: s[12] }
}

/// # Safety
/// `world`, `img`: `n` points each. `out`: 9 `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_homography(world: *const f64, img: *const f64, n: usize, out: *mut f64) -> i32 {
    let (Some(w), Some(i)) = (points(world, n), points(img, n)) else { return -1 };
    if out.is_null() {
        return -1;
    }
    match pose::homography(&w, &i) {
        Some(h) => {
            slice::from_raw_parts_mut(out, 9).copy_from_slice(&h);
            1
        }
        None => 0,
    }
}

/// # Safety
/// `h`: 9 `f64`. `out`: 13 `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_pose_from_homography(h: *const f64, f: f64, cx: f64, cy: f64, out: *mut f64) -> i32 {
    if h.is_null() || out.is_null() {
        return -1;
    }
    let mut hm: M3 = [0.0; 9];
    hm.copy_from_slice(slice::from_raw_parts(h, 9));
    match pose::pose_from_homography(&hm, &Intrinsics { f, cx, cy }) {
        Some(p) => {
            write_pose(out, &p);
            1
        }
        None => 0,
    }
}

/// # Safety
/// `pose_in`, `out`: 13 `f64` (may alias). `world`, `img`: `n` points each.
#[no_mangle]
pub unsafe extern "C" fn st_refine_pose(
    pose_in: *const f64,
    world: *const f64,
    img: *const f64,
    n: usize,
    f: f64,
    cx: f64,
    cy: f64,
    iters: u32,
    out: *mut f64,
) -> i32 {
    let (Some(w), Some(i)) = (points(world, n), points(img, n)) else { return -1 };
    if pose_in.is_null() || out.is_null() {
        return -1;
    }
    let p = pose::refine_pose(&read_pose(pose_in), &w, &i, &Intrinsics { f, cx, cy }, iters as usize);
    write_pose(out, &p);
    1
}

/// Homography + decomposition + Gauss-Newton (8 iterations).
///
/// # Safety
/// `world`, `img`: `n` points each. `out`: 13 `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_solve_pose(world: *const f64, img: *const f64, n: usize, f: f64, cx: f64, cy: f64, out: *mut f64) -> i32 {
    let (Some(w), Some(i)) = (points(world, n), points(img, n)) else { return -1 };
    if out.is_null() {
        return -1;
    }
    match pose::solve_pose(&w, &i, &Intrinsics { f, cx, cy }) {
        Some(p) => {
            write_pose(out, &p);
            1
        }
        None => 0,
    }
}

/// Focal length in pixels, or `NaN` when the view does not constrain it.
///
/// # Safety
/// `h`: 9 `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_focal_from_homography(h: *const f64, cx: f64, cy: f64) -> f64 {
    if h.is_null() {
        return f64::NAN;
    }
    let mut hm: M3 = [0.0; 9];
    hm.copy_from_slice(slice::from_raw_parts(h, 9));
    pose::focal_from_homography(&hm, cx, cy).unwrap_or(f64::NAN)
}

/// Refine one marker's 4 corners. Returns 1 and writes `out` when refined; 0 otherwise.
///
/// # Safety
/// `rgba`: `width * height * 4` bytes. `corners`, `out`: 4 points.
#[no_mangle]
pub unsafe extern "C" fn st_refine_corners(rgba: *const u8, width: usize, height: usize, corners: *const f64, out: *mut f64) -> i32 {
    if rgba.is_null() || out.is_null() || width == 0 || height == 0 {
        return -1;
    }
    let Some(c) = points(corners, 4) else { return -1 };
    let img = Rgba { width, height, data: slice::from_raw_parts(rgba, width * height * 4) };
    match subpix::refine_corners(&img, &[c[0], c[1], c[2], c[3]]) {
        Some(r) => {
            let o = slice::from_raw_parts_mut(out, 8);
            for (k, p) in r.iter().enumerate() {
                o[k * 2] = p.x;
                o[k * 2 + 1] = p.y;
            }
            1
        }
        None => 0,
    }
}
