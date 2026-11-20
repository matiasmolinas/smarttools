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

pub const ABI_VERSION: u32 = 2;

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

// ---------------------------------------------------------------------------------------------
// Camera model, calibration, navigation, filtering, gate, simulator (ABI 2)
//
// More layouts:
// - camera: 7 `f64` = f, cx, cy, k1, k2, p1, p2
// - tool: 6 `f64` = tip_cam (3), axis_cam (3)
// - nav state: 14 `f64` = tip (3), axis (3), aim (2), yaw, pitch, angle_err, offset_mm, gap_mm, depth_mm
// - gate input: 8 `f64` = calibrated (0/1), pose_age_s, rms_px, markers, angle_err_deg, offset_mm,
//   jitter_mm, jitter_deg; limits: 7 `f64` in the order of `nav::GateLimits`
// ---------------------------------------------------------------------------------------------

use crate::calib::{self, View};
use crate::camera::Camera;
use crate::nav::{self, GateInput, GateLimits, OneEuro, PoseFilter, Steadiness, ToolCalib};
use crate::sim::{self, Bit, Lighting, Occluder, RenderSpec, SceneLook};

unsafe fn read_cam(p: *const f64) -> Camera {
    Camera::from_slice(slice::from_raw_parts(p, 7))
}
unsafe fn read_v3(p: *const f64) -> [f64; 3] {
    let s = slice::from_raw_parts(p, 3);
    [s[0], s[1], s[2]]
}
unsafe fn read_poses(p: *const f64, n: usize) -> Vec<Pose> {
    (0..n).map(|i| read_pose(p.add(i * 13))).collect()
}

/// # Safety
/// `cam`: 7. `pts`, `out`: `n` points (may alias).
#[no_mangle]
pub unsafe extern "C" fn st_undistort_points(cam: *const f64, pts: *const f64, n: usize, out: *mut f64) -> i32 {
    if cam.is_null() || pts.is_null() || out.is_null() {
        return -1;
    }
    let c = read_cam(cam);
    let src: Vec<f64> = slice::from_raw_parts(pts, n * 2).to_vec();
    let o = slice::from_raw_parts_mut(out, n * 2);
    for k in 0..n {
        let q = c.undistort_px(P2::new(src[k * 2], src[k * 2 + 1]));
        o[k * 2] = q.x;
        o[k * 2 + 1] = q.y;
    }
    1
}

/// World points (3 `f64` each) -> pixels with distortion; NaN for points behind the camera.
///
/// # Safety
/// `cam`: 7, `pose`: 13, `world`: `3n`, `out`: `2n`.
#[no_mangle]
pub unsafe extern "C" fn st_project_points(cam: *const f64, pose: *const f64, world: *const f64, n: usize, out: *mut f64) -> i32 {
    if cam.is_null() || pose.is_null() || world.is_null() || out.is_null() {
        return -1;
    }
    let (c, p) = (read_cam(cam), read_pose(pose));
    let w = slice::from_raw_parts(world, n * 3);
    let o = slice::from_raw_parts_mut(out, n * 2);
    for k in 0..n {
        let q = c.project([w[k * 3], w[k * 3 + 1], w[k * 3 + 2]], &p);
        o[k * 2] = q.map_or(f64::NAN, |q| q.x);
        o[k * 2 + 1] = q.map_or(f64::NAN, |q| q.y);
    }
    1
}

/// Calibrate from `n_views` views; view `i` has `counts[i]` points, concatenated in `world`/`img`.
/// `flags`: 1 = keep the principal point, 2 = k1 only. Writes the camera (7) and the RMS (px).
///
/// # Safety
/// Buffers as described; `out_cam`: 7, `out_rms`: 1.
#[no_mangle]
pub unsafe extern "C" fn st_calibrate_camera(
    init: *const f64,
    n_views: usize,
    counts: *const u32,
    world: *const f64,
    img: *const f64,
    flags: u32,
    out_cam: *mut f64,
    out_rms: *mut f64,
) -> i32 {
    if init.is_null() || counts.is_null() || world.is_null() || img.is_null() || out_cam.is_null() || out_rms.is_null() {
        return -1;
    }
    let counts = slice::from_raw_parts(counts, n_views);
    let mut views = Vec::with_capacity(n_views);
    let mut off = 0;
    for &c in counts {
        let c = c as usize;
        let (Some(w), Some(i)) = (points(world.add(off * 2), c), points(img.add(off * 2), c)) else { return -1 };
        views.push(View { world: w, img: i });
        off += c;
    }
    let opts = calib::CameraCalibOptions { fix_principal_point: flags & 1 != 0, estimate_k2: flags & 2 == 0, ..Default::default() };
    match calib::calibrate_camera(&views, read_cam(init), opts) {
        Some(r) => {
            slice::from_raw_parts_mut(out_cam, 7).copy_from_slice(&r.camera.to_array());
            *out_rms = r.rms;
            1
        }
        None => 0,
    }
}

/// Pivot calibration. `out`: 8 = tip_cam (3), pivot_world (3), rms (m), spread (deg).
///
/// # Safety
/// `poses`: `13n`, `out`: 8.
#[no_mangle]
pub unsafe extern "C" fn st_pivot(poses: *const f64, n: usize, out: *mut f64) -> i32 {
    if poses.is_null() || out.is_null() {
        return -1;
    }
    match calib::pivot(&read_poses(poses, n)) {
        Some(p) => {
            let o = slice::from_raw_parts_mut(out, 8);
            o[..3].copy_from_slice(&p.tip_cam);
            o[3..6].copy_from_slice(&p.pivot_world);
            o[6] = p.rms;
            o[7] = p.spread_deg;
            1
        }
        None => 0,
    }
}

/// Bit axis from a twist. `out`: 5 = axis_cam (3), spread (deg), rms.
///
/// # Safety
/// `poses`: `13n`, `out`: 5.
#[no_mangle]
pub unsafe extern "C" fn st_axis_from_roll(poses: *const f64, n: usize, out: *mut f64) -> i32 {
    if poses.is_null() || out.is_null() {
        return -1;
    }
    match calib::axis_from_roll(&read_poses(poses, n)) {
        Some(a) => {
            let o = slice::from_raw_parts_mut(out, 5);
            o[..3].copy_from_slice(&a.axis_cam);
            o[3] = a.spread_deg;
            o[4] = a.rms;
            1
        }
        None => 0,
    }
}

/// # Safety
/// `pose`: 13, `tool`: 6, `target`: 2, `out`: 14.
#[no_mangle]
pub unsafe extern "C" fn st_nav_evaluate(pose: *const f64, tool: *const f64, target: *const f64, out: *mut f64) -> i32 {
    if pose.is_null() || tool.is_null() || target.is_null() || out.is_null() {
        return -1;
    }
    let tool = ToolCalib { tip_cam: read_v3(tool), axis_cam: read_v3(tool.add(3)) };
    let tg = slice::from_raw_parts(target, 2);
    let s = nav::evaluate(&read_pose(pose), &tool, P2::new(tg[0], tg[1]));
    write_nav(out, &s);
    1
}

/// Same, from a tip and axis already in the world frame (after filtering).
///
/// # Safety
/// `tip`, `axis`: 3, `target`: 2, `out`: 14.
#[no_mangle]
pub unsafe extern "C" fn st_nav_evaluate_world(tip: *const f64, axis: *const f64, target: *const f64, out: *mut f64) -> i32 {
    if tip.is_null() || axis.is_null() || target.is_null() || out.is_null() {
        return -1;
    }
    let tg = slice::from_raw_parts(target, 2);
    write_nav(out, &nav::evaluate_world(read_v3(tip), read_v3(axis), P2::new(tg[0], tg[1])));
    1
}

unsafe fn write_nav(out: *mut f64, s: &nav::NavState) {
    let o = slice::from_raw_parts_mut(out, 14);
    o[..3].copy_from_slice(&s.tip);
    o[3..6].copy_from_slice(&s.axis);
    o[6] = s.aim.x;
    o[7] = s.aim.y;
    o[8] = s.yaw_deg;
    o[9] = s.pitch_deg;
    o[10] = s.angle_err_deg;
    o[11] = s.offset_mm;
    o[12] = s.gap_mm;
    o[13] = s.depth_mm;
}

/// Go / no-go. Returns the reason bits (0 = ready, see `nav::reason`); `limits` may be null.
///
/// # Safety
/// `input`: 8, `limits`: 7 or null.
#[no_mangle]
pub unsafe extern "C" fn st_gate(input: *const f64, limits: *const f64) -> u32 {
    if input.is_null() {
        return u32::MAX;
    }
    let i = slice::from_raw_parts(input, 8);
    let gi = GateInput {
        calibrated: i[0] != 0.0,
        pose_age_s: i[1],
        rms_px: i[2],
        markers: i[3].max(0.0) as u32,
        angle_err_deg: i[4],
        offset_mm: i[5],
        jitter_mm: i[6],
        jitter_deg: i[7],
    };
    let l = if limits.is_null() {
        GateLimits::default()
    } else {
        let l = slice::from_raw_parts(limits, 7);
        GateLimits {
            max_angle_deg: l[0],
            max_offset_mm: l[1],
            max_rms_px: l[2],
            min_markers: l[3].max(0.0) as u32,
            max_pose_age_s: l[4],
            max_jitter_mm: l[5],
            max_jitter_deg: l[6],
        }
    };
    nav::gate(&gi, &l)
}

/// New pose filter (One Euro on tip and axis). Free with [`st_filter_free`].
#[no_mangle]
pub extern "C" fn st_filter_new(tip_min_cutoff: f64, tip_beta: f64, axis_min_cutoff: f64, axis_beta: f64, d_cutoff: f64) -> *mut PoseFilter {
    Box::into_raw(Box::new(PoseFilter::with(OneEuro::new(tip_min_cutoff, tip_beta, d_cutoff), OneEuro::new(axis_min_cutoff, axis_beta, d_cutoff))))
}

/// # Safety
/// `h` from [`st_filter_new`]; `tip`, `axis`: 3; `out`: 6.
#[no_mangle]
pub unsafe extern "C" fn st_filter_step(h: *mut PoseFilter, t: f64, tip: *const f64, axis: *const f64, out: *mut f64) {
    let (ft, fa) = (*h).filter(t, read_v3(tip), read_v3(axis));
    let o = slice::from_raw_parts_mut(out, 6);
    o[..3].copy_from_slice(&ft);
    o[3..].copy_from_slice(&fa);
}

/// # Safety
/// `h` from [`st_filter_new`].
#[no_mangle]
pub unsafe extern "C" fn st_filter_reset(h: *mut PoseFilter) {
    (*h).reset();
}

/// # Safety
/// `h` from [`st_filter_new`], not used afterwards.
#[no_mangle]
pub unsafe extern "C" fn st_filter_free(h: *mut PoseFilter) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

#[no_mangle]
pub extern "C" fn st_steady_new(window_s: f64) -> *mut Steadiness {
    Box::into_raw(Box::new(Steadiness::new(window_s)))
}

/// # Safety
/// `h` from [`st_steady_new`]; `tip`, `axis`: 3.
#[no_mangle]
pub unsafe extern "C" fn st_steady_push(h: *mut Steadiness, t: f64, tip: *const f64, axis: *const f64) {
    (*h).push(t, read_v3(tip), read_v3(axis));
}

/// Writes (jitter mm, jitter deg, span s).
///
/// # Safety
/// `h` from [`st_steady_new`]; `out`: 3.
#[no_mangle]
pub unsafe extern "C" fn st_steady_jitter(h: *mut Steadiness, out: *mut f64) {
    let (mm, deg) = (*h).jitter();
    let o = slice::from_raw_parts_mut(out, 3);
    o[0] = mm;
    o[1] = deg;
    o[2] = (*h).span();
}

/// # Safety
/// `h` from [`st_steady_new`].
#[no_mangle]
pub unsafe extern "C" fn st_steady_reset(h: *mut Steadiness) {
    (*h).reset();
}

/// # Safety
/// `h` from [`st_steady_new`], not used afterwards.
#[no_mangle]
pub unsafe extern "C" fn st_steady_free(h: *mut Steadiness) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

/// Camera pose for a held tool (see `sim::rig_pose`): yaw, pitch, twist in degrees.
///
/// # Safety
/// `tip_world`, `tip_cam`, `axis_cam`: 3, `out`: 13.
#[no_mangle]
pub unsafe extern "C" fn st_rig_pose(yaw: f64, pitch: f64, twist: f64, tip_world: *const f64, tip_cam: *const f64, axis_cam: *const f64, out: *mut f64) -> i32 {
    if tip_world.is_null() || tip_cam.is_null() || axis_cam.is_null() || out.is_null() {
        return -1;
    }
    let u = sim::tool_rotation(yaw, pitch, twist);
    write_pose(out, &sim::rig_pose(&u, read_v3(tip_world), read_v3(tip_cam), read_v3(axis_cam)));
    1
}

/// Render a simulated camera frame. `cfg` (64 `f64`):
/// 0 wall, 1 paper, 2 ink, 3 crosses (0/1), 4 gain, 5 vignette, 6 gradient, 7 noise, 8 seed,
/// 9 bit on (0/1), 10-12 bit tip_cam, 13-15 bit axis_cam, 16 bit length, 17 bit radius,
/// 18 occluder count (<= 14), 19-60 occluders (cx, cy, r) in pixels.
///
/// # Safety
/// `cam`: 7, `poses`: `13n`, `codes`: `36 * board::MARKER_COUNT` bytes (36 bits per id), `cfg`: 64,
/// `out`: `width * height * 4` bytes.
#[no_mangle]
pub unsafe extern "C" fn st_render(
    cam: *const f64,
    poses: *const f64,
    n: usize,
    width: usize,
    height: usize,
    ss: usize,
    codes: *const u8,
    cfg: *const f64,
    out: *mut u8,
) -> i32 {
    if cam.is_null() || poses.is_null() || codes.is_null() || cfg.is_null() || out.is_null() || n == 0 || width == 0 || height == 0 {
        return -1;
    }
    let c = slice::from_raw_parts(cfg, 64);
    let occ: Vec<Occluder> = (0..(c[18] as usize).min(14)).map(|k| Occluder { cx: c[19 + k * 3], cy: c[20 + k * 3], r: c[21 + k * 3] }).collect();
    let ps = read_poses(poses, n);
    let spec = RenderSpec {
        camera: read_cam(cam),
        poses: &ps,
        width,
        height,
        ss,
        codes: slice::from_raw_parts(codes, 36 * crate::board::MARKER_COUNT),
        look: SceneLook { wall: c[0], paper: c[1], ink: c[2], crosses: c[3] != 0.0 },
        light: Lighting { gain: c[4], vignette: c[5], gradient: c[6], noise: c[7], seed: c[8] as u32 },
        bit: (c[9] != 0.0).then(|| Bit { tip_cam: [c[10], c[11], c[12]], axis_cam: [c[13], c[14], c[15]], length: c[16], radius: c[17] }),
        occluders: &occ,
    };
    sim::render(&spec, slice::from_raw_parts_mut(out, width * height * 4));
    1
}

/// Board geometry for parity checks: `out` = count, marker size, then (x, y) per marker id, then
/// (x, y) per target. Returns the number of `f64` written (needs `2 + 2 * (count + 3)`).
///
/// # Safety
/// `out`: at least `cap` `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_board_info(out: *mut f64, cap: usize) -> i32 {
    use crate::board::*;
    let need = 2 + 2 * (MARKER_COUNT + BOARD_TARGETS.len());
    if out.is_null() || cap < need {
        return -(need as i32);
    }
    let o = slice::from_raw_parts_mut(out, need);
    o[0] = MARKER_COUNT as f64;
    o[1] = MARKER_SIZE;
    for id in 0..MARKER_COUNT {
        let m = marker_center(id as u32).unwrap_or(P2::new(f64::NAN, f64::NAN));
        o[2 + id * 2] = m.x;
        o[3 + id * 2] = m.y;
    }
    for (k, t) in BOARD_TARGETS.iter().enumerate() {
        o[2 + MARKER_COUNT * 2 + k * 2] = t.x;
        o[3 + MARKER_COUNT * 2 + k * 2] = t.y;
    }
    need as i32
}

/// Robust per-frame solve: drops markers (4 points each) whose corners disagree with the rest.
/// Writes the pose (13), 1/0 per marker in `keep_out` (may be null) and returns the number of
/// markers kept (0 = no solution).
///
/// # Safety
/// `world`, `img`: `n` points each (`n` a multiple of 4). `out`: 13 `f64`. `keep_out`: `n / 4` bytes.
#[no_mangle]
pub unsafe extern "C" fn st_solve_pose_robust(world: *const f64, img: *const f64, n: usize, f: f64, cx: f64, cy: f64, min_px: f64, out: *mut f64, keep_out: *mut u8) -> i32 {
    let (Some(w), Some(i)) = (points(world, n), points(img, n)) else { return -1 };
    if out.is_null() || !n.is_multiple_of(4) {
        return -1;
    }
    match pose::solve_pose_robust(&w, &i, &Intrinsics { f, cx, cy }, 4, min_px) {
        Some((p, keep)) => {
            write_pose(out, &p);
            if !keep_out.is_null() {
                let k = slice::from_raw_parts_mut(keep_out, keep.len());
                for (d, s) in k.iter_mut().zip(&keep) {
                    *d = *s as u8;
                }
            }
            keep.iter().filter(|&&k| k).count() as i32
        }
        None => 0,
    }
}
