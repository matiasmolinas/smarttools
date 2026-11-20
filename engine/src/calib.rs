//! Calibrations:
//! - [`calibrate_camera`]: focal length, principal point and radial distortion from several views of
//!   the marker sheet (Levenberg-Marquardt over intrinsics and all view poses).
//! - [`pivot`]: the bit tip in the camera frame, from poses while the tip rests on one point and the
//!   tool wobbles around it.
//! - [`axis_from_roll`]: the bit axis in the camera frame, from poses while the tool twists around
//!   its own bit.

use crate::camera::Camera;
use crate::geom::{len, mul, mul_tv, rodrigues, solve, sub3, M3, P2, V3};
use crate::pose::{homography, pose_from_homography, refine_pose, Pose};

/// One view: world points on the sheet (z = 0) and their detected pixels.
pub struct View {
    pub world: Vec<P2>,
    pub img: Vec<P2>,
}

#[derive(Clone, Copy, Debug)]
pub struct CameraCalibOptions {
    /// Keep cx, cy at the initial value.
    pub fix_principal_point: bool,
    /// Estimate k2 (otherwise only k1).
    pub estimate_k2: bool,
    pub iterations: usize,
}

impl Default for CameraCalibOptions {
    fn default() -> Self {
        Self { fix_principal_point: false, estimate_k2: true, iterations: 60 }
    }
}

#[derive(Clone, Debug)]
pub struct CameraCalib {
    pub camera: Camera,
    pub poses: Vec<Pose>,
    /// RMS reprojection error, pixels.
    pub rms: f64,
}

fn view_residuals(cam: &Camera, pose: &Pose, v: &View, out: &mut [f64]) -> bool {
    for (k, (w, m)) in v.world.iter().zip(&v.img).enumerate() {
        match cam.project([w.x, w.y, 0.0], pose) {
            Some(q) => {
                out[2 * k] = q.x - m.x;
                out[2 * k + 1] = q.y - m.y;
            }
            None => return false,
        }
    }
    true
}

fn perturb(p: &Pose, d: &[f64]) -> Pose {
    Pose { r: mul(&rodrigues([d[0], d[1], d[2]]), &p.r), t: [p.t[0] + d[3], p.t[1] + d[4], p.t[2] + d[5]], rms: 0.0 }
}

fn total_error(cam: &Camera, poses: &[Pose], views: &[&View], buf: &mut Vec<f64>) -> Option<f64> {
    let mut e = 0.0;
    for (p, v) in poses.iter().zip(views) {
        buf.resize(v.world.len() * 2, 0.0);
        if !view_residuals(cam, p, v, buf) {
            return None;
        }
        e += buf.iter().map(|x| x * x).sum::<f64>();
    }
    Some(e)
}

/// Calibrate the camera from >= 3 views (more and more varied is better: tilt the phone 20-40°
/// in different directions and fill the corners of the image). Views that disagree with the rest
/// (RMS > 0.5 px and > 4x the median) are dropped and the fit is repeated, up to twice.
pub fn calibrate_camera(views: &[View], init: Camera, opts: CameraCalibOptions) -> Option<CameraCalib> {
    let mut active: Vec<usize> = (0..views.len()).collect();
    for _ in 0..3 {
        let subset: Vec<&View> = active.iter().map(|&i| &views[i]).collect();
        let r = calibrate_subset(&subset, init, opts)?;
        let mut rms: Vec<f64> = r.poses.iter().map(|p| p.rms).collect();
        rms.sort_by(f64::total_cmp);
        let median = rms[rms.len() / 2];
        let bad: Vec<usize> = r.poses.iter().enumerate().filter(|(_, p)| p.rms > 0.5 && p.rms > 4.0 * median).map(|(k, _)| k).collect();
        if bad.is_empty() || active.len() - bad.len() < 3 {
            return Some(r);
        }
        active = active.iter().enumerate().filter(|(k, _)| !bad.contains(k)).map(|(_, &i)| i).collect();
    }
    let subset: Vec<&View> = active.iter().map(|&i| &views[i]).collect();
    calibrate_subset(&subset, init, opts)
}

fn calibrate_subset(views: &[&View], init: Camera, opts: CameraCalibOptions) -> Option<CameraCalib> {
    if views.len() < 3 || views.iter().any(|v| v.world.len() < 4 || v.world.len() != v.img.len()) {
        return None;
    }
    let mut cam = Camera { k1: 0.0, k2: 0.0, p1: 0.0, p2: 0.0, ..init };
    // initial poses on the pinhole model
    let mut poses = Vec::with_capacity(views.len());
    for v in views.iter() {
        let h = homography(&v.world, &v.img)?;
        let p0 = pose_from_homography(&h, &cam.intrinsics())?;
        poses.push(refine_pose(&p0, &v.world, &v.img, &cam.intrinsics(), 8));
    }
    // intrinsic parameters being estimated: 0 f, 1 cx, 2 cy, 3 k1, 4 k2
    let mut free: Vec<usize> = vec![0];
    if !opts.fix_principal_point {
        free.extend([1, 2]);
    }
    free.push(3);
    if opts.estimate_k2 {
        free.push(4);
    }
    let ni = free.len();
    let np = ni + 6 * views.len();
    let set = |c: &Camera, k: usize, d: f64| -> Camera {
        let mut c = *c;
        match k {
            0 => c.f += d,
            1 => c.cx += d,
            2 => c.cy += d,
            3 => c.k1 += d,
            _ => c.k2 += d,
        }
        c
    };
    let istep = |k: usize, c: &Camera| match k {
        0 => 1e-4 * c.f,
        1 | 2 => 1e-3,
        _ => 1e-6,
    };
    let psteps = [1e-6, 1e-6, 1e-6, 1e-7, 1e-7, 1e-7];

    let mut buf = Vec::new();
    let mut err = total_error(&cam, &poses, views, &mut buf)?;
    let mut lambda = 1e-3;
    let mut a = vec![0.0; np * np];
    let mut g = vec![0.0; np];
    for _ in 0..opts.iterations {
        a.iter_mut().for_each(|x| *x = 0.0);
        g.iter_mut().for_each(|x| *x = 0.0);
        for (vi, v) in views.iter().enumerate() {
            let m = v.world.len() * 2;
            let mut r0 = vec![0.0; m];
            if !view_residuals(&cam, &poses[vi], v, &mut r0) {
                return None;
            }
            // Jacobian columns for this view: intrinsics (global) + its own 6 pose params
            let mut cols: Vec<(usize, Vec<f64>)> = Vec::with_capacity(ni + 6);
            let mut rk = vec![0.0; m];
            for (ci, &k) in free.iter().enumerate() {
                let h = istep(k, &cam);
                if !view_residuals(&set(&cam, k, h), &poses[vi], v, &mut rk) {
                    return None;
                }
                cols.push((ci, rk.iter().zip(&r0).map(|(a, b)| (a - b) / h).collect()));
            }
            for (k, &h) in psteps.iter().enumerate() {
                let mut d = [0.0; 6];
                d[k] = h;
                if !view_residuals(&cam, &perturb(&poses[vi], &d), v, &mut rk) {
                    return None;
                }
                cols.push((ni + 6 * vi + k, rk.iter().zip(&r0).map(|(a, b)| (a - b) / h).collect()));
            }
            for (ia, ja) in &cols {
                g[*ia] -= ja.iter().zip(&r0).map(|(a, b)| a * b).sum::<f64>();
                for (ib, jb) in &cols {
                    a[ia * np + ib] += ja.iter().zip(jb).map(|(x, y)| x * y).sum::<f64>();
                }
            }
        }
        // Levenberg-Marquardt step with retries
        let mut improved = false;
        for _ in 0..8 {
            let mut al = a.clone();
            for i in 0..np {
                al[i * np + i] *= 1.0 + lambda;
                al[i * np + i] += 1e-12;
            }
            let Some(dx) = solve(&al, &g, np) else {
                lambda *= 10.0;
                continue;
            };
            let mut c2 = cam;
            for (ci, &k) in free.iter().enumerate() {
                c2 = set(&c2, k, dx[ci]);
            }
            let p2: Vec<Pose> = poses.iter().enumerate().map(|(vi, p)| perturb(p, &dx[ni + 6 * vi..ni + 6 * vi + 6])).collect();
            match total_error(&c2, &p2, views, &mut buf) {
                Some(e2) if e2 < err => {
                    let gain = err - e2;
                    cam = c2;
                    poses = p2;
                    err = e2;
                    lambda = (lambda / 3.0).max(1e-9);
                    improved = gain > 1e-12 * err.max(1e-12);
                    break;
                }
                _ => lambda *= 5.0,
            }
        }
        if !improved {
            break;
        }
    }
    let n: usize = views.iter().map(|v| v.world.len()).sum();
    let rms = (err / n as f64).sqrt();
    for (p, v) in poses.iter_mut().zip(views.iter()) {
        let mut r = vec![0.0; v.world.len() * 2];
        view_residuals(&cam, p, v, &mut r);
        p.rms = (r.iter().map(|x| x * x).sum::<f64>() / v.world.len() as f64).sqrt();
    }
    Some(CameraCalib { camera: cam, poses, rms })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pivot {
    /// Bit tip in the camera frame, metres.
    pub tip_cam: V3,
    /// The point the tip rested on, world (sheet) frame, metres.
    pub pivot_world: V3,
    /// RMS distance of the per-frame tip estimates from the pivot, metres.
    pub rms: f64,
    /// Largest rotation between frames, degrees (needs >= ~15° to be well conditioned).
    pub spread_deg: f64,
}

fn rot_angle_deg(r: &M3) -> f64 {
    (((r[0] + r[4] + r[8]) - 1.0) / 2.0).clamp(-1.0, 1.0).acos().to_degrees()
}

fn rel(a: &M3, b: &M3) -> M3 {
    // a * b^T
    let bt = [b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]];
    mul(a, &bt)
}

/// Pivot calibration: the tip stays on one point while the tool wobbles. Solves
/// `R_i^T (p - t_i) = q` for the tip `p` (camera) and the pivot `q` (world) by least squares.
pub fn pivot(poses: &[Pose]) -> Option<Pivot> {
    if poses.len() < 3 {
        return None;
    }
    let mut a = [0.0; 36];
    let mut b = [0.0; 6];
    for p in poses {
        let r = &p.r;
        // rows of [R^T | -I]
        let rhs = mul_tv(r, p.t);
        for i in 0..3 {
            let row = [r[i], r[3 + i], r[6 + i], if i == 0 { -1.0 } else { 0.0 }, if i == 1 { -1.0 } else { 0.0 }, if i == 2 { -1.0 } else { 0.0 }];
            for x in 0..6 {
                b[x] += row[x] * rhs[i];
                for y in 0..6 {
                    a[x * 6 + y] += row[x] * row[y];
                }
            }
        }
    }
    let spread = poses.iter().map(|p| rot_angle_deg(&rel(&p.r, &poses[0].r))).fold(0.0, f64::max);
    if spread < 3.0 {
        return None;
    }
    let s = solve(&a, &b, 6)?;
    let tip: V3 = [s[0], s[1], s[2]];
    let q: V3 = [s[3], s[4], s[5]];
    let rms = (poses.iter().map(|p| len(sub3(p.to_world(tip), q)).powi(2)).sum::<f64>() / poses.len() as f64).sqrt();
    Some(Pivot { tip_cam: tip, pivot_world: q, rms, spread_deg: spread })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Axis {
    /// Unit bit axis in the camera frame, pointing from the chuck to the tip (camera +z side).
    pub axis_cam: V3,
    /// Largest twist between frames, degrees (needs >= ~10°).
    pub spread_deg: f64,
    /// RMS of |(M_i - I) a|, a measure of how pure the twist was.
    pub rms: f64,
}

/// Eigen-decomposition of a symmetric 3x3 matrix (Jacobi). Returns (values, vectors as columns).
fn sym_eigen(m: &M3) -> ([f64; 3], M3) {
    let mut a = *m;
    let mut v = crate::geom::IDENTITY;
    for _ in 0..50 {
        let (mut p, mut q, mut big) = (0, 1, a[1].abs());
        if a[2].abs() > big {
            (p, q, big) = (0, 2, a[2].abs());
        }
        if a[5].abs() > big {
            (p, q, big) = (1, 2, a[5].abs());
        }
        if big < 1e-18 {
            break;
        }
        let (app, aqq, apq) = (a[p * 3 + p], a[q * 3 + q], a[p * 3 + q]);
        let theta = 0.5 * (2.0 * apq).atan2(aqq - app);
        let (s, c) = theta.sin_cos();
        // rotate rows/cols p, q
        for k in 0..3 {
            let (akp, akq) = (a[k * 3 + p], a[k * 3 + q]);
            a[k * 3 + p] = c * akp - s * akq;
            a[k * 3 + q] = s * akp + c * akq;
        }
        for k in 0..3 {
            let (apk, aqk) = (a[p * 3 + k], a[q * 3 + k]);
            a[p * 3 + k] = c * apk - s * aqk;
            a[q * 3 + k] = s * apk + c * aqk;
        }
        for k in 0..3 {
            let (vkp, vkq) = (v[k * 3 + p], v[k * 3 + q]);
            v[k * 3 + p] = c * vkp - s * vkq;
            v[k * 3 + q] = s * vkp + c * vkq;
        }
    }
    ([a[0], a[4], a[8]], v)
}

/// Bit axis from a twist around the bit (tip resting on a point). Every relative rotation
/// `M_i = R_i R_0^T` keeps the axis fixed: `a = argmin Σ |(M_i - I) a|²`, |a| = 1.
pub fn axis_from_roll(poses: &[Pose]) -> Option<Axis> {
    if poses.len() < 3 {
        return None;
    }
    let mut s = [0.0; 9];
    let mut spread: f64 = 0.0;
    let mut ms = Vec::with_capacity(poses.len());
    for p in &poses[1..] {
        let mut m = rel(&p.r, &poses[0].r);
        spread = spread.max(rot_angle_deg(&m));
        for i in 0..3 {
            m[i * 4] -= 1.0;
        }
        // S += (M - I)^T (M - I)
        for i in 0..3 {
            for j in 0..3 {
                s[i * 3 + j] += (0..3).map(|k| m[k * 3 + i] * m[k * 3 + j]).sum::<f64>();
            }
        }
        ms.push(m);
    }
    if spread < 5.0 {
        return None;
    }
    let (vals, vecs) = sym_eigen(&s);
    let i = (0..3).min_by(|&a, &b| vals[a].total_cmp(&vals[b]))?;
    let mut a: V3 = [vecs[i], vecs[3 + i], vecs[6 + i]];
    if a[2] < 0.0 {
        a = [-a[0], -a[1], -a[2]];
    }
    let rms = (ms.iter().map(|m| len(crate::geom::mul_v(m, a)).powi(2)).sum::<f64>() / ms.len() as f64).sqrt();
    Some(Axis { axis_cam: a, spread_deg: spread, rms })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{dot, normalize};

    const BASE: M3 = [1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0];

    fn board_points() -> Vec<P2> {
        let mut v = Vec::new();
        for id in 0..crate::board::MARKER_COUNT as u32 {
            v.extend(crate::board::marker_corners(id).unwrap());
        }
        v
    }

    /// Camera pose for a tool: tip at `tip_w`, tool rotated by `u` (world), dock geometry tip_cam/axis_cam.
    fn tool_pose(u: &M3, tip_w: V3, tip_cam: V3, axis_cam: V3) -> Pose {
        // A maps ez to axis_cam
        let ez = [0.0, 0.0, 1.0];
        let k = crate::geom::cross(ez, axis_cam);
        let ang = dot(ez, axis_cam).clamp(-1.0, 1.0).acos();
        let a = if len(k) < 1e-12 { crate::geom::IDENTITY } else { rodrigues(crate::geom::scale(normalize(k), ang)) };
        let at = [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
        let bt = [BASE[0], BASE[3], BASE[6], BASE[1], BASE[4], BASE[7], BASE[2], BASE[5], BASE[8]];
        let c = mul(&mul(u, &bt), &at); // camera -> world
        let r = [c[0], c[3], c[6], c[1], c[4], c[7], c[2], c[5], c[8]];
        let rt = crate::geom::mul_v(&r, tip_w);
        Pose { r, t: sub3(tip_cam, rt), rms: 0.0 }
    }

    #[test]
    fn camera_calibration_recovers_intrinsics_and_distortion() {
        let truth = Camera { f: 1180.0, cx: 652.0, cy: 351.0, k1: -0.09, k2: 0.04, p1: 0.0, p2: 0.0 };
        let world = board_points();
        let mut views = Vec::new();
        for i in 0..12 {
            let a = i as f64 * 0.52;
            let u = mul(&rodrigues([0.45 * a.cos(), 0.45 * a.sin(), 0.2 * (a * 1.7).sin()]), &crate::geom::IDENTITY);
            let p = tool_pose(&u, [0.03 * a.sin(), 0.02 * a.cos(), 0.0], [0.0, 0.0, 0.30 + 0.05 * (a * 0.7).cos()], [0.0, 0.0, 1.0]);
            let img: Vec<P2> = world.iter().map(|w| truth.project([w.x, w.y, 0.0], &p).unwrap()).collect();
            views.push(View { world: world.clone(), img });
        }
        // one view with a corrupted marker (half hidden by the bit)
        let mut bad = View { world: views[3].world.clone(), img: views[3].img.clone() };
        bad.img[5].x += 6.0;
        bad.img[6].y -= 5.0;
        views.push(bad);
        let init = Camera::from_hfov(1280.0, 720.0, 66.0);
        let c = calibrate_camera(&views, init, CameraCalibOptions::default()).unwrap();
        assert_eq!(c.poses.len(), 12, "the corrupted view is dropped");
        assert!(c.rms < 1e-4, "rms {}", c.rms);
        assert!((c.camera.f - truth.f).abs() < 0.05, "f {}", c.camera.f);
        assert!((c.camera.cx - truth.cx).abs() < 0.05 && (c.camera.cy - truth.cy).abs() < 0.05);
        assert!((c.camera.k1 - truth.k1).abs() < 1e-4 && (c.camera.k2 - truth.k2).abs() < 1e-3, "k {} {}", c.camera.k1, c.camera.k2);
    }

    #[test]
    fn pivot_and_roll_recover_the_dock_geometry() {
        let tip_cam = [0.002, 0.056, 0.168];
        let axis_cam = normalize([0.02, -0.015, 1.0]); // ~1.4° misaligned dock
        let tip_w = [0.0, 0.0, 0.0];
        // wobble: tilt around the tip in a cone
        let wobble: Vec<Pose> = (0..24)
            .map(|i| {
                let a = i as f64 / 24.0 * std::f64::consts::TAU;
                tool_pose(&rodrigues([0.3 * a.cos(), 0.3 * a.sin(), 0.0]), tip_w, tip_cam, axis_cam)
            })
            .collect();
        let pv = pivot(&wobble).unwrap();
        assert!(len(sub3(pv.tip_cam, tip_cam)) < 1e-9, "tip {:?}", pv.tip_cam);
        assert!(len(pv.pivot_world) < 1e-9 && pv.rms < 1e-9);
        // roll: twist around the bit (world -z through the tip) with a slight lean
        let lean = rodrigues([0.05, -0.03, 0.0]);
        let roll: Vec<Pose> = (0..20)
            .map(|i| {
                let r = -0.5 + i as f64 / 19.0;
                tool_pose(&mul(&lean, &rodrigues([0.0, 0.0, r])), tip_w, tip_cam, axis_cam)
            })
            .collect();
        let ax = axis_from_roll(&roll).unwrap();
        let err = dot(ax.axis_cam, axis_cam).clamp(-1.0, 1.0).acos().to_degrees();
        assert!(err < 1e-6, "axis error {err}°");
        assert!(ax.spread_deg > 50.0);
    }

    #[test]
    fn too_little_motion_is_rejected() {
        let p = Pose { r: BASE, t: [0.0, 0.0, 0.3], rms: 0.0 };
        assert!(pivot(&[p, p, p]).is_none());
        assert!(axis_from_roll(&[p, p, p]).is_none());
    }
}
