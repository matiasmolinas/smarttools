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

pub const ABI_VERSION: u32 = 5;

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

/// Gauss-Newton refinement for 3D points (markers on several faces of a part).
///
/// # Safety
/// `pose_in`, `out`: 13 `f64`; `world`: `3n`; `img`: `2n`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn st_refine_pose3(pose_in: *const f64, world: *const f64, img: *const f64, n: usize, f: f64, cx: f64, cy: f64, iters: u32, out: *mut f64) -> i32 {
    let Some(i) = points(img, n) else { return -1 };
    if pose_in.is_null() || out.is_null() || world.is_null() {
        return -1;
    }
    let w: Vec<[f64; 3]> = slice::from_raw_parts(world, 3 * n).chunks(3).map(|c| [c[0], c[1], c[2]]).collect();
    let p = pose::refine_pose3(&read_pose(pose_in), &w, &i, &Intrinsics { f, cx, cy }, iters as usize);
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
        located: true, keep_out: false,
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
    st_render_scene(cam, poses, n, width, height, ss, codes, cfg, std::ptr::null(), 0, out)
}

/// Parse solids and stickers: `[n_solids, (o 3, q 4, shade, n_planes, (n 3, d) * n_planes) * n_solids,
/// n_stickers, (o 3, q 4, half 2, n_markers, (x, y, size, code) * n_markers) * n_stickers]`.
fn parse_scene(v: &[f64]) -> Option<(Vec<sim::Solid>, Vec<sim::Sticker>)> {
    let mut i = 0usize;
    let mut next = |k: usize| -> Option<&[f64]> {
        let r = v.get(i..i + k)?;
        i += k;
        Some(r)
    };
    let frame = |a: &[f64]| ([a[0], a[1], a[2]], crate::scene::Quat::new(a[3], a[4], a[5], a[6]).normalize().to_matrix());
    let ns = next(1)?[0] as usize;
    let mut solids = Vec::with_capacity(ns.min(64));
    for _ in 0..ns.min(64) {
        let h = next(9)?;
        let (o, r) = frame(h);
        let (shade, np) = (h[7], h[8] as usize);
        let planes = (0..np.min(32)).map(|_| next(4).map(|p| ([p[0], p[1], p[2]], p[3]))).collect::<Option<Vec<_>>>()?;
        solids.push(sim::Solid { r, o, planes, shade });
    }
    let nt = next(1).map_or(0, |x| x[0] as usize);
    let mut stickers = Vec::with_capacity(nt.min(64));
    for _ in 0..nt.min(64) {
        let h = next(10)?;
        let (o, r) = frame(h);
        let (half, nm) = ([h[7], h[8]], h[9] as usize);
        let markers = (0..nm.min(64)).map(|_| next(4).map(|m| ([m[0], m[1]], m[2], m[3] as u64))).collect::<Option<Vec<_>>>()?;
        stickers.push(sim::Sticker { r, o, half, markers });
    }
    Some((solids, stickers))
}

/// [`st_render`] with parts in the scene: convex solids and marker stickers (see `parse_scene`).
///
/// # Safety
/// As [`st_render`]; `scene`: `scene_len` `f64` (may be null when 0).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn st_render_scene(
    cam: *const f64,
    poses: *const f64,
    n: usize,
    width: usize,
    height: usize,
    ss: usize,
    codes: *const u8,
    cfg: *const f64,
    scene: *const f64,
    scene_len: usize,
    out: *mut u8,
) -> i32 {
    if cam.is_null() || poses.is_null() || codes.is_null() || cfg.is_null() || out.is_null() || n == 0 || width == 0 || height == 0 {
        return -1;
    }
    let (solids, stickers) = if scene.is_null() || scene_len == 0 {
        (Vec::new(), Vec::new())
    } else {
        match parse_scene(slice::from_raw_parts(scene, scene_len)) {
            Some(x) => x,
            None => return -2,
        }
    };
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
        solids: &solids,
        stickers: &stickers,
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

// ---------------------------------------------------------------------------------------------
// Scene graph + engine (ABI 3). Handle-based. Transforms are 10 `f64`: p (3), q (w, x, y, z), s (3).
// ---------------------------------------------------------------------------------------------

use crate::engine::{Engine, EngineConfig, Measurement};
use crate::scene::{NodeKind, SceneGraph, Transform};

/// New engine with an empty scene (just the world root, id 0). Free with [`st_engine_free`].
#[no_mangle]
pub extern "C" fn st_engine_new() -> *mut Engine {
    Box::into_raw(Box::new(Engine::new(SceneGraph::new(), EngineConfig::default())))
}

/// # Safety
/// `h` from [`st_engine_new`], not used afterwards.
#[no_mangle]
pub unsafe extern "C" fn st_engine_free(h: *mut Engine) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

/// Configuration, 26 `f64` in this order: tick_hz, max_catchup, predict_max_s, predict (0/1),
/// stale_after_s, lost_after_s, history_s, lock_time_s, steady_window_s, depth_target_mm,
/// engage_gap_mm, engage_offset_mm, requirement_angle_deg, the 7 gate limits (as `st_gate`),
/// pos_min_cutoff, pos_beta, rot_min_cutoff, rot_beta, d_cutoff, (reserved).
///
/// # Safety
/// `h` valid; `c`: 26 `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_engine_configure(h: *mut Engine, c: *const f64) -> i32 {
    if h.is_null() || c.is_null() {
        return -1;
    }
    let c = slice::from_raw_parts(c, 26);
    let cfg = EngineConfig {
        tick_hz: c[0],
        max_catchup: c[1].max(1.0) as u32,
        predict_max_s: c[2],
        predict: c[3] != 0.0,
        stale_after_s: c[4],
        lost_after_s: c[5],
        history_s: c[6],
        lock_time_s: c[7],
        steady_window_s: c[8],
        depth_target_mm: c[9],
        engage_gap_mm: c[10],
        engage_offset_mm: c[11],
        requirement_angle_deg: c[12],
        limits: GateLimits {
            max_angle_deg: c[13],
            max_offset_mm: c[14],
            max_rms_px: c[15],
            min_markers: c[16].max(0.0) as u32,
            max_pose_age_s: c[17],
            max_jitter_mm: c[18],
            max_jitter_deg: c[19],
        },
        pos_min_cutoff: c[20],
        pos_beta: c[21],
        rot_min_cutoff: c[22],
        rot_beta: c[23],
        d_cutoff: c[24],
    };
    (*h).configure(cfg);
    1
}

/// Add a node. `name`: UTF-8 bytes. `kind`: 0 reference, 1 tracked, 2 calibrated, 3 planned,
/// 4 derived, 5 display. Returns the id, or a negative error (-1 bad args, -2 unknown parent,
/// -3 name taken, -5 scale on a rigid node).
///
/// # Safety
/// `h` valid; `name`: `name_len` bytes; `local`: 10 `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_engine_add_node(h: *mut Engine, name: *const u8, name_len: usize, parent: u32, kind: u32, local: *const f64) -> i32 {
    if h.is_null() || name.is_null() || local.is_null() {
        return -1;
    }
    let Ok(n) = std::str::from_utf8(slice::from_raw_parts(name, name_len)) else { return -1 };
    let Some(k) = NodeKind::from_u8(kind as u8) else { return -1 };
    match (*h).graph.add(n, parent, k, Transform::from_slice(slice::from_raw_parts(local, 10))) {
        Ok(id) => id as i32,
        Err(e) => scene_err(e),
    }
}

fn scene_err(e: crate::scene::SceneError) -> i32 {
    use crate::scene::SceneError::*;
    match e {
        UnknownNode => -2,
        NameTaken => -3,
        Cycle => -4,
        ScaleOnRigidChain => -5,
        RootIsFixed => -6,
    }
}

/// # Safety
/// `h` valid; `local`: 10 `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_engine_set_local(h: *mut Engine, node: u32, local: *const f64) -> i32 {
    if h.is_null() || local.is_null() {
        return -1;
    }
    match (*h).graph.set_local(node, Transform::from_slice(slice::from_raw_parts(local, 10))) {
        Ok(()) => {
            (*h).graph.update();
            1
        }
        Err(e) => scene_err(e),
    }
}

/// # Safety
/// `h` valid.
#[no_mangle]
pub unsafe extern "C" fn st_engine_reparent(h: *mut Engine, node: u32, parent: u32, keep_world: u32) -> i32 {
    if h.is_null() {
        return -1;
    }
    match (*h).graph.reparent(node, parent, keep_world != 0) {
        Ok(()) => 1,
        Err(e) => scene_err(e),
    }
}

/// # Safety
/// `h` valid.
#[no_mangle]
pub unsafe extern "C" fn st_engine_set_calibrated(h: *mut Engine, node: u32, ok: u32) {
    if !h.is_null() {
        (*h).set_calibrated(node, ok != 0);
    }
}

/// # Safety
/// `h` valid; `targets`: `n` ids.
#[no_mangle]
pub unsafe extern "C" fn st_engine_set_nav(h: *mut Engine, tool: u32, targets: *const u32, n: usize) {
    if h.is_null() || (n > 0 && targets.is_null()) {
        return;
    }
    (*h).set_tool(tool);
    let t = if n == 0 { &[][..] } else { slice::from_raw_parts(targets, n) };
    (*h).set_targets(t);
}

/// # Safety
/// `h` valid.
#[no_mangle]
pub unsafe extern "C" fn st_engine_start(h: *mut Engine, t0: f64) {
    if !h.is_null() {
        (*h).start(t0);
    }
}

/// # Safety
/// `h` valid.
#[no_mangle]
pub unsafe extern "C" fn st_engine_reset_job(h: *mut Engine) {
    if !h.is_null() {
        (*h).reset_job();
    }
}

/// Queue a measurement `T_from_to` captured at `t_capture`.
///
/// # Safety
/// `h` valid; `t`: 10 `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_engine_push(h: *mut Engine, from: u32, to: u32, t: *const f64, t_capture: f64, markers: u32, rms_px: f64) {
    if h.is_null() || t.is_null() {
        return;
    }
    (*h).push(Measurement { from, to, transform: Transform::from_slice(slice::from_raw_parts(t, 10)), t_capture, markers, rms_px });
}

/// Run the ticks due up to `t_wall`; returns how many ran.
///
/// # Safety
/// `h` valid.
#[no_mangle]
pub unsafe extern "C" fn st_engine_advance(h: *mut Engine, t_wall: f64) -> u32 {
    if h.is_null() {
        return 0;
    }
    (*h).advance_to(t_wall)
}

/// Engine time of the next tick.
///
/// # Safety
/// `h` valid.
#[no_mangle]
pub unsafe extern "C" fn st_engine_now(h: *const Engine) -> f64 {
    if h.is_null() {
        return f64::NAN;
    }
    (*h).now()
}

pub const SNAP_HEADER: usize = 24;
pub const SNAP_NODE: usize = 13;
pub const SNAP_TARGET: usize = 16;
pub const SNAP_EVENT: usize = 5;

/// Write the latest snapshot and hand over its events (they are not repeated). Returns the number
/// of `f64` written, or minus the size needed if `cap` is too small (nothing is consumed).
/// Layout: header (24) = tick, t, n_nodes, n_targets, active (-1 none), phase, gate, ready, locking,
/// alarms, jitter_mm, jitter_deg, markers, rms_px, pose_age_s, n_events, ticks, overruns,
/// measurements, late_merged, late_dropped, latency_s, 0, 0; then per node (13) = id, status, age,
/// world (10); per target (16) = id, drilled, tip (3), axis (3), aim (2), yaw, pitch, angle_err,
/// offset_mm, gap_mm, depth_mm; per event (5) = tick, t, kind, node, value.
///
/// # Safety
/// `h` valid; `out`: `cap` `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_engine_snapshot(h: *mut Engine, out: *mut f64, cap: usize) -> i32 {
    if h.is_null() || out.is_null() {
        return 0;
    }
    let e = &mut *h;
    let s = e.snapshot();
    let n_ev = s.events.len();
    let need = SNAP_HEADER + s.nodes.len() * SNAP_NODE + s.targets.len() * SNAP_TARGET + n_ev * SNAP_EVENT;
    if cap < need {
        return -(need as i32);
    }
    let o = slice::from_raw_parts_mut(out, need);
    let st = s.stats;
    o[..SNAP_HEADER].copy_from_slice(&[
        s.tick as f64,
        s.t,
        s.nodes.len() as f64,
        s.targets.len() as f64,
        s.active.map_or(-1.0, |i| i as f64),
        s.phase as u8 as f64,
        s.gate as f64,
        s.ready as u8 as f64,
        s.locking as u8 as f64,
        s.alarms as f64,
        s.jitter_mm,
        s.jitter_deg,
        s.markers as f64,
        s.rms_px,
        s.pose_age_s,
        n_ev as f64,
        st.ticks as f64,
        st.overruns as f64,
        st.measurements as f64,
        st.late_merged as f64,
        st.late_dropped as f64,
        st.latency_s,
        0.0,
        0.0,
    ]);
    let mut k = SNAP_HEADER;
    for n in &s.nodes {
        o[k] = n.id as f64;
        o[k + 1] = n.status as u8 as f64;
        o[k + 2] = n.age;
        o[k + 3..k + 13].copy_from_slice(&n.world.to_array());
        k += SNAP_NODE;
    }
    for (i, t) in s.targets.iter().enumerate() {
        o[k..k + SNAP_TARGET].copy_from_slice(&[
            t.target as f64,
            s.drilled.get(i).copied().unwrap_or(false) as u8 as f64,
            t.tip[0],
            t.tip[1],
            t.tip[2],
            t.axis[0],
            t.axis[1],
            t.axis[2],
            t.aim[0],
            t.aim[1],
            t.yaw_deg,
            t.pitch_deg,
            t.angle_err_deg,
            t.offset_mm,
            t.gap_mm,
            t.depth_mm,
        ]);
        k += SNAP_TARGET;
    }
    for ev in &s.events {
        o[k..k + SNAP_EVENT].copy_from_slice(&[ev.tick as f64, ev.t, ev.kind as u8 as f64, ev.node as f64, ev.value]);
        k += SNAP_EVENT;
    }
    e.take_events();
    need as i32
}

/// Per-target depths (mm), in the order of `st_engine_set_nav`'s targets.
///
/// # Safety
/// `h` valid; `depths`: `n` `f64`.
#[no_mangle]
pub unsafe extern "C" fn st_engine_set_target_depths(h: *mut Engine, depths: *const f64, n: usize) {
    if h.is_null() || depths.is_null() {
        return;
    }
    (*h).set_target_depths(slice::from_raw_parts(depths, n));
}

/// Mark a located part as movable: measurements of the camera against markers on it (its anchors)
/// update its pose instead of only the camera's.
///
/// # Safety
/// `h` valid.
#[no_mangle]
pub unsafe extern "C" fn st_engine_set_movable(h: *mut Engine, node: u32, on: i32) {
    if !h.is_null() {
        (*h).set_movable(node, on != 0);
    }
}

/// Feed limit for the "pushing too hard" advice (mm/s).
///
/// # Safety
/// `h` valid.
#[no_mangle]
pub unsafe extern "C" fn st_engine_set_feed_limit(h: *mut Engine, mm_s: f64) {
    if !h.is_null() {
        (*h).set_feed_limit(mm_s);
    }
}

/// Add a no-go zone: a box of half sizes (m) in `node`'s frame, kept clear by `margin_mm`.
///
/// # Safety
/// `h` valid.
#[no_mangle]
pub unsafe extern "C" fn st_engine_add_keepout(h: *mut Engine, node: u32, hx: f64, hy: f64, hz: f64, margin_mm: f64) {
    if !h.is_null() {
        (*h).add_keepout(crate::engine::KeepOut { node, half: [hx, hy, hz], margin_mm });
    }
}

/// Paired-point registration: the rigid transform mapping `model` points onto `measured` points.
/// `out`: 12 `f64` = transform (10: p, q, s), FRE (m), max residual (m). Returns 1, or 0 if
/// degenerate (fewer than 3 points, collinear).
///
/// # Safety
/// `model`, `measured`: `3n` `f64`; `out`: 12.
#[no_mangle]
pub unsafe extern "C" fn st_register_points(model: *const f64, measured: *const f64, n: usize, out: *mut f64) -> i32 {
    if model.is_null() || measured.is_null() || out.is_null() {
        return -1;
    }
    let pts = |p: *const f64| -> Vec<[f64; 3]> { slice::from_raw_parts(p, n * 3).chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect() };
    match calib::register_points(&pts(model), &pts(measured)) {
        Some(r) => {
            let o = slice::from_raw_parts_mut(out, 12);
            o[..10].copy_from_slice(&r.transform.to_array());
            o[10] = r.fre;
            o[11] = r.max_residual;
            1
        }
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_through_the_c_abi() {
        unsafe {
            let h = st_engine_new();
            let id = |name: &str, parent: u32, kind: u32, t: [f64; 10]| st_engine_add_node(h, name.as_ptr(), name.len(), parent, kind, t.as_ptr());
            let ident = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0];
            let sheet = id("sheet", 0, 0, ident);
            // target A, +Z into the sheet (180° about X: q = (0, 1, 0, 0))
            let a = id("A", sheet as u32, 3, [0.02, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
            let cam = id("camera", 0, 1, ident);
            let tool = id("tool", cam as u32, 2, [0.0, 0.0, 0.17, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
            assert!(sheet > 0 && a > 0 && cam > 0 && tool > 0);
            assert_eq!(id("A", 0, 3, ident), -3, "name taken");
            assert_eq!(id("x", 99, 3, ident), -2, "unknown parent");
            assert_eq!(id("y", 0, 1, [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 2.0, 1.0, 1.0]), -5, "scale on a tracked node");
            st_engine_set_nav(h, tool as u32, [a as u32].as_ptr(), 1);
            st_engine_set_calibrated(h, tool as u32, 1);
            st_engine_start(h, 0.0);
            // camera 0.17 m in front of A looking into the sheet: world(camera) = (0.02, 0, 0.17), 180° about X
            let cam_w = Transform::rigid([0.02, 0.0, 0.17], crate::scene::Quat::new(0.0, 1.0, 0.0, 0.0));
            let m = cam_w.inverse().to_array(); // T_camera_sheet
            st_engine_push(h, cam as u32, sheet as u32, m.as_ptr(), 0.0, 8, 0.2);
            assert_eq!(st_engine_advance(h, 0.0), 1);
            let mut small = [0.0; 4];
            let need = -st_engine_snapshot(h, small.as_mut_ptr(), 4);
            assert!(need > 0);
            let mut buf = vec![0.0; need as usize];
            assert_eq!(st_engine_snapshot(h, buf.as_mut_ptr(), buf.len()), need);
            assert_eq!(buf[2] as usize, 5, "nodes: world, sheet, A, camera, tool");
            assert_eq!(buf[3] as usize, 1);
            assert_eq!(buf[4], 0.0, "active target 0");
            let tgt = SNAP_HEADER + 5 * SNAP_NODE;
            assert_eq!(buf[tgt] as i32, a);
            assert!(buf[tgt + 12].abs() < 1e-9, "angle 0");
            assert!(buf[tgt + 13].abs() < 1e-9 && buf[tgt + 14].abs() < 1e-9, "on the mark, touching");
            // events are handed over once
            assert!(buf[15] >= 1.0);
            let mut again = vec![0.0; 512];
            st_engine_snapshot(h, again.as_mut_ptr(), again.len());
            assert_eq!(again[15], 0.0);
            st_engine_free(h);
        }
    }
}
