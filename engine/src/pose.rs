//! Planar pose from marker corners: normalised DLT homography, decomposition with known
//! intrinsics, Gauss-Newton refinement on reprojection error, and focal self-calibration.

use crate::geom::{add3, cross, mul, mul_tv, mul_v, normalize, rodrigues, scale, solve, sub3, M3, P2, V3};

/// Pinhole intrinsics: square pixels, focal length and principal point in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Intrinsics {
    pub f: f64,
    pub cx: f64,
    pub cy: f64,
}

/// Camera pose: `x_cam = r * X_world + t`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    /// Rotation, row-major.
    pub r: M3,
    /// Translation, metres.
    pub t: V3,
    /// RMS reprojection error, pixels (0 until refined).
    pub rms: f64,
}

impl Pose {
    /// World point -> camera frame.
    pub fn apply(&self, p: V3) -> V3 {
        add3(mul_v(&self.r, p), self.t)
    }
    /// Camera-frame point -> world.
    pub fn to_world(&self, c: V3) -> V3 {
        mul_tv(&self.r, sub3(c, self.t))
    }
    /// Camera-frame direction -> world.
    pub fn dir_to_world(&self, c: V3) -> V3 {
        mul_tv(&self.r, c)
    }
}

/// Project a world point to pixels. `None` behind (or on) the camera plane.
pub fn project(p: V3, pose: &Pose, k: &Intrinsics) -> Option<P2> {
    let c = pose.apply(p);
    if c[2] <= 1e-6 {
        return None;
    }
    Some(P2::new(k.cx + k.f * c[0] / c[2], k.cy + k.f * c[1] / c[2]))
}

struct Normalised {
    s: f64,
    mx: f64,
    my: f64,
    pts: Vec<P2>,
}

fn normalise(pts: &[P2]) -> Normalised {
    let n = pts.len() as f64;
    let (mut mx, mut my) = (0.0, 0.0);
    for p in pts {
        mx += p.x;
        my += p.y;
    }
    mx /= n;
    my /= n;
    let mut d = 0.0;
    for p in pts {
        d += (p.x - mx).hypot(p.y - my);
    }
    d /= n;
    let s = if d > 0.0 { std::f64::consts::SQRT_2 / d } else { 1.0 };
    let pts = pts.iter().map(|p| P2::new((p.x - mx) * s, (p.y - my) * s)).collect();
    Normalised { s, mx, my, pts }
}

/// Homography `img ~ H * [X, Y, 1]` from >= 4 plane-to-image correspondences (normalised DLT,
/// h33 = 1, normal equations).
pub fn homography(world: &[P2], img: &[P2]) -> Option<M3> {
    let n = world.len();
    if n < 4 || img.len() != n {
        return None;
    }
    let w = normalise(world);
    let i = normalise(img);
    let mut ata = [0.0; 64];
    let mut atb = [0.0; 8];
    let mut add = |row: [f64; 8], b: f64| {
        for r in 0..8 {
            atb[r] += row[r] * b;
            for c in 0..8 {
                ata[r * 8 + c] += row[r] * row[c];
            }
        }
    };
    for k in 0..n {
        let P2 { x: xw, y: yw } = w.pts[k];
        let P2 { x: u, y: v } = i.pts[k];
        add([xw, yw, 1.0, 0.0, 0.0, 0.0, -u * xw, -u * yw], u);
        add([0.0, 0.0, 0.0, xw, yw, 1.0, -v * xw, -v * yw], v);
    }
    let h = solve(&ata, &atb, 8)?;
    let hn: M3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0];
    // denormalise: H = Ti^-1 * Hn * Tw
    let tw: M3 = [w.s, 0.0, -w.s * w.mx, 0.0, w.s, -w.s * w.my, 0.0, 0.0, 1.0];
    let ti_inv: M3 = [1.0 / i.s, 0.0, i.mx, 0.0, 1.0 / i.s, i.my, 0.0, 0.0, 1.0];
    Some(mul(&mul(&ti_inv, &hn), &tw))
}

/// Pose from a plane homography with known intrinsics. The rotation is orthonormalised by
/// splitting the error symmetrically between its first two columns.
pub fn pose_from_homography(h: &M3, k: &Intrinsics) -> Option<Pose> {
    let kinv = |c: usize| -> V3 {
        [(h[c] - k.cx * h[6 + c]) / k.f, (h[3 + c] - k.cy * h[6 + c]) / k.f, h[6 + c]]
    };
    let (h1, h2, h3) = (kinv(0), kinv(1), kinv(2));
    let l = crate::geom::len(h1) + crate::geom::len(h2);
    if l.is_nan() || l <= 0.0 {
        return None;
    }
    let lam = 2.0 / l;
    let (mut r1, mut r2, mut t) = (scale(h1, lam), scale(h2, lam), scale(h3, lam));
    if t[2] < 0.0 {
        r1 = scale(r1, -1.0);
        r2 = scale(r2, -1.0);
        t = scale(t, -1.0);
    }
    let a = normalize(r1);
    let b = normalize(r2);
    let c = normalize(add3(a, b));
    let d = normalize(cross(cross(a, b), c));
    let r1 = normalize(sub3(c, d));
    let r2 = normalize(add3(c, d));
    let r3 = cross(r1, r2);
    let r: M3 = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
    Some(Pose { r, t, rms: 0.0 })
}

/// Focal length from one homography, principal point known, square pixels. Needs a clearly
/// tilted view: frontal views are ill-conditioned.
pub fn focal_from_homography(h: &M3, cx: f64, cy: f64) -> Option<f64> {
    let a1 = h[0] - cx * h[6];
    let a2 = h[1] - cx * h[7];
    let b1 = h[3] - cy * h[6];
    let b2 = h[4] - cy * h[7];
    let (c1, c2) = (h[6], h[7]);
    let mut sum = 0.0;
    let mut n = 0;
    let d1 = c1 * c2;
    if d1.abs() > 1e-12 {
        let f2 = -(a1 * a2 + b1 * b2) / d1;
        if f2 > 0.0 {
            sum += f2.sqrt();
            n += 1;
        }
    }
    let d2 = c1 * c1 - c2 * c2;
    if d2.abs() > 1e-12 {
        let f2 = -(a1 * a1 + b1 * b1 - a2 * a2 - b2 * b2) / d2;
        if f2 > 0.0 {
            sum += f2.sqrt();
            n += 1;
        }
    }
    (n > 0).then(|| sum / n as f64)
}

fn residuals(p: &Pose, world: &[V3], img: &[P2], k: &Intrinsics, out: &mut Vec<f64>) -> bool {
    out.clear();
    for (w, m) in world.iter().zip(img) {
        match project(*w, p, k) {
            Some(q) => {
                out.push(q.x - m.x);
                out.push(q.y - m.y);
            }
            None => return false,
        }
    }
    true
}

fn perturb(p: &Pose, d: &[f64; 6]) -> Pose {
    Pose { r: mul(&rodrigues([d[0], d[1], d[2]]), &p.r), t: [p.t[0] + d[3], p.t[1] + d[4], p.t[2] + d[5]], rms: 0.0 }
}

/// Gauss-Newton refinement of the pose on reprojection error (6 parameters, numeric Jacobian).
/// Stops when the error stops decreasing. Sets `rms`.
pub fn refine_pose(pose: &Pose, world: &[P2], img: &[P2], k: &Intrinsics, iters: usize) -> Pose {
    let w3: Vec<V3> = world.iter().map(|w| [w.x, w.y, 0.0]).collect();
    refine_pose3(pose, &w3, img, k, iters)
}

/// The same refinement for points anywhere in 3D (markers on several faces of a part).
pub fn refine_pose3(pose: &Pose, world: &[V3], img: &[P2], k: &Intrinsics, iters: usize) -> Pose {
    let mut cur = *pose;
    let mut r0 = Vec::with_capacity(world.len() * 2);
    if !residuals(&cur, world, img, k, &mut r0) {
        return *pose;
    }
    let m = r0.len();
    let steps = [1e-5, 1e-5, 1e-5, 1e-6, 1e-6, 1e-6];
    let mut j = vec![0.0; 6 * m];
    let mut rk = Vec::with_capacity(m);
    let mut r1 = Vec::with_capacity(m);
    'outer: for _ in 0..iters {
        for kk in 0..6 {
            let mut d = [0.0; 6];
            d[kk] = steps[kk];
            if !residuals(&perturb(&cur, &d), world, img, k, &mut rk) {
                return cur;
            }
            for i in 0..m {
                j[kk * m + i] = (rk[i] - r0[i]) / steps[kk];
            }
        }
        let mut a = [0.0; 36];
        let mut b = [0.0; 6];
        for r in 0..6 {
            for c in 0..6 {
                a[r * 6 + c] = (0..m).map(|i| j[r * m + i] * j[c * m + i]).sum();
            }
            a[r * 6 + r] *= 1.0001;
            b[r] = -(0..m).map(|i| j[r * m + i] * r0[i]).sum::<f64>();
        }
        let Some(dx) = solve(&a, &b, 6) else { break };
        let next = perturb(&cur, &[dx[0], dx[1], dx[2], dx[3], dx[4], dx[5]]);
        if !residuals(&next, world, img, k, &mut r1) {
            break 'outer;
        }
        let e0: f64 = r0.iter().map(|v| v * v).sum();
        let e1: f64 = r1.iter().map(|v| v * v).sum();
        if e1 > e0 {
            break;
        }
        cur = next;
        std::mem::swap(&mut r0, &mut r1);
        if e0 - e1 < 1e-9 {
            break;
        }
    }
    let e: f64 = r0.iter().map(|v| v * v).sum();
    cur.rms = (e / ((r0.len() / 2).max(1) as f64)).sqrt();
    cur
}

/// Homography -> pose -> Gauss-Newton, the full solve used per frame.
pub fn solve_pose(world: &[P2], img: &[P2], k: &Intrinsics) -> Option<Pose> {
    let h = homography(world, img)?;
    let p0 = pose_from_homography(&h, k)?;
    Some(refine_pose(&p0, world, img, k, 8))
}

/// Per-marker reprojection RMS (pixels) for correspondences grouped `group` points per marker.
pub fn group_rms(pose: &Pose, world: &[P2], img: &[P2], k: &Intrinsics, group: usize) -> Vec<f64> {
    world
        .chunks(group)
        .zip(img.chunks(group))
        .map(|(w, m)| {
            let e: f64 = w
                .iter()
                .zip(m)
                .map(|(w, m)| project([w.x, w.y, 0.0], pose, k).map_or(1e6, |q| (q.x - m.x).powi(2) + (q.y - m.y).powi(2)))
                .sum();
            (e / w.len() as f64).sqrt()
        })
        .collect()
}

/// Like [`solve_pose`], but drops markers whose corners disagree with the rest (a marker partly
/// hidden by the drill bit, a reflection) and solves again. `group` = points per marker (4).
/// Each marker is tested by leaving it out: if, under the pose of the others, its RMS exceeds both
/// `min_px` and 4x theirs, the most inconsistent one is dropped (up to 3 times, keeping >= 2 markers).
/// Returns the pose and which markers were kept.
pub fn solve_pose_robust(world: &[P2], img: &[P2], k: &Intrinsics, group: usize, min_px: f64) -> Option<(Pose, Vec<bool>)> {
    let group = group.max(1);
    let n = world.len() / group;
    let subset = |keep: &[bool]| -> (Vec<P2>, Vec<P2>) {
        world
            .chunks(group)
            .zip(img.chunks(group))
            .zip(keep)
            .filter(|(_, &k)| k)
            .flat_map(|((w, m), _)| w.iter().copied().zip(m.iter().copied()))
            .unzip()
    };
    let mut keep = vec![true; n];
    let (w, m) = subset(&keep);
    let mut pose = solve_pose(&w, &m, k)?;
    for _ in 0..3 {
        if keep.iter().filter(|&&k| k).count() < 3 {
            break;
        }
        let rms = group_rms(&pose, world, img, k, group);
        if (0..n).filter(|&i| keep[i]).all(|i| rms[i] <= min_px) {
            break;
        }
        // leave each marker out in turn; the one the others disagree with most is the suspect
        let mut best: Option<(f64, usize, Pose)> = None;
        for i in (0..n).filter(|&i| keep[i]) {
            let mut trial = keep.clone();
            trial[i] = false;
            let (w, m) = subset(&trial);
            let Some(p2) = solve_pose(&w, &m, k) else { continue };
            let r2 = group_rms(&p2, world, img, k, group);
            let mut rest: Vec<f64> = (0..n).filter(|&j| trial[j]).map(|j| r2[j]).collect();
            rest.sort_by(f64::total_cmp);
            let rest_med = rest[rest.len() / 2].max(0.05);
            if r2[i] > min_px && r2[i] > 4.0 * rest_med {
                let score = r2[i] / rest_med;
                if best.as_ref().is_none_or(|b| score > b.0) {
                    best = Some((score, i, p2));
                }
            }
        }
        match best {
            Some((_, i, p2)) => {
                keep[i] = false;
                pose = p2;
            }
            None => break,
        }
    }
    Some((pose, keep))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::rodrigues;

    fn grid() -> Vec<P2> {
        let mut v = Vec::new();
        for i in 0..4 {
            for j in 0..3 {
                v.push(P2::new(-0.07 + 0.0467 * i as f64, -0.1 + 0.1 * j as f64));
            }
        }
        v
    }

    fn truth() -> (Pose, Intrinsics) {
        // camera ~25 cm in front of the sheet, tilted, looking at it
        let base: M3 = [1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0];
        let r = mul(&rodrigues([0.25, -0.35, 0.1]), &base);
        (Pose { r, t: [0.01, -0.02, 0.25], rms: 0.0 }, Intrinsics { f: 1000.0, cx: 640.0, cy: 360.0 })
    }

    #[test]
    fn exact_correspondences_recover_the_pose() {
        let (p, k) = truth();
        let w = grid();
        let img: Vec<P2> = w.iter().map(|q| project([q.x, q.y, 0.0], &p, &k).unwrap()).collect();
        let s = solve_pose(&w, &img, &k).unwrap();
        for i in 0..9 {
            assert!((s.r[i] - p.r[i]).abs() < 1e-9, "R[{i}]");
        }
        for i in 0..3 {
            assert!((s.t[i] - p.t[i]).abs() < 1e-9, "t[{i}]");
        }
        assert!(s.rms < 1e-6);
    }

    #[test]
    fn focal_from_a_tilted_view() {
        let (p, k) = truth();
        let w = grid();
        let img: Vec<P2> = w.iter().map(|q| project([q.x, q.y, 0.0], &p, &k).unwrap()).collect();
        let h = homography(&w, &img).unwrap();
        let f = focal_from_homography(&h, k.cx, k.cy).unwrap();
        assert!((f - k.f).abs() < 1e-3, "f = {f}");
    }

    #[test]
    fn noisy_corners_stay_sub_millimetre() {
        let (p, k) = truth();
        let w = grid();
        // deterministic +-0.3 px noise
        let img: Vec<P2> = w
            .iter()
            .enumerate()
            .map(|(i, q)| {
                let c = project([q.x, q.y, 0.0], &p, &k).unwrap();
                let n = (i as f64 * 12.9898).sin() * 0.3;
                P2::new(c.x + n, c.y - n * 0.7)
            })
            .collect();
        let s = solve_pose(&w, &img, &k).unwrap();
        let tip = [0.0, 0.055, 0.17];
        let e = crate::geom::len(sub3(s.to_world(tip), p.to_world(tip)));
        assert!(e < 1e-3, "tip error {e} m");
    }

    #[test]
    fn a_bad_marker_is_dropped() {
        let (p, k) = truth();
        // 4 markers of 4 corners
        let mut w = Vec::new();
        for (cx, cy) in [(-0.06, 0.04), (0.06, 0.04), (-0.06, -0.04), (0.06, -0.04)] {
            for (dx, dy) in [(-0.012, 0.012), (0.012, 0.012), (0.012, -0.012), (-0.012, -0.012)] {
                w.push(P2::new(cx + dx, cy + dy));
            }
        }
        let mut img: Vec<P2> = w.iter().map(|q| project([q.x, q.y, 0.0], &p, &k).unwrap()).collect();
        // marker 1 partly covered by the bit: two of its corners land on the bit's edge
        img[4].x += 3.0;
        img[5].y -= 2.5;
        let plain = solve_pose(&w, &img, &k).unwrap();
        let (robust, keep) = solve_pose_robust(&w, &img, &k, 4, 0.8).unwrap();
        assert_eq!(keep, vec![true, false, true, true]);
        let err = |q: &Pose| crate::geom::len(sub3(q.t, p.t));
        assert!(err(&robust) < 1e-9 && err(&plain) > 1e-5, "robust {} plain {}", err(&robust), err(&plain));
    }

    #[test]
    fn degenerate_input_is_rejected() {
        let k = Intrinsics { f: 1000.0, cx: 0.0, cy: 0.0 };
        let w = [P2::new(0.0, 0.0); 4];
        assert!(solve_pose(&w, &w, &k).is_none());
        assert!(homography(&w[..3], &w[..3]).is_none());
    }
}
