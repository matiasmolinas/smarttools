//! Pinhole camera with Brown-Conrady lens distortion (k1, k2 radial; p1, p2 tangential).
//!
//! Normalised coordinates are `(X/Z, Y/Z)` in the camera frame. Pixels: `u = f * xd + cx`.

use crate::geom::{P2, V3};
use crate::pose::{Intrinsics, Pose};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub f: f64,
    pub cx: f64,
    pub cy: f64,
    pub k1: f64,
    pub k2: f64,
    pub p1: f64,
    pub p2: f64,
}

impl Camera {
    pub const fn pinhole(f: f64, cx: f64, cy: f64) -> Self {
        Self { f, cx, cy, k1: 0.0, k2: 0.0, p1: 0.0, p2: 0.0 }
    }

    /// Default for a phone main camera: horizontal field of view in degrees, centred principal point.
    pub fn from_hfov(width: f64, height: f64, hfov_deg: f64) -> Self {
        Self::pinhole(width / 2.0 / (hfov_deg.to_radians() / 2.0).tan(), width / 2.0, height / 2.0)
    }

    pub fn intrinsics(&self) -> Intrinsics {
        Intrinsics { f: self.f, cx: self.cx, cy: self.cy }
    }

    pub fn has_distortion(&self) -> bool {
        self.k1 != 0.0 || self.k2 != 0.0 || self.p1 != 0.0 || self.p2 != 0.0
    }

    /// Ideal normalised -> distorted normalised.
    pub fn distort(&self, x: f64, y: f64) -> (f64, f64) {
        let r2 = x * x + y * y;
        let radial = 1.0 + self.k1 * r2 + self.k2 * r2 * r2;
        (
            x * radial + 2.0 * self.p1 * x * y + self.p2 * (r2 + 2.0 * x * x),
            y * radial + self.p1 * (r2 + 2.0 * y * y) + 2.0 * self.p2 * x * y,
        )
    }

    /// Distorted normalised -> ideal normalised (fixed-point iteration, then Newton polish).
    pub fn undistort(&self, xd: f64, yd: f64) -> (f64, f64) {
        if !self.has_distortion() {
            return (xd, yd);
        }
        let (mut x, mut y) = (xd, yd);
        for _ in 0..8 {
            let r2 = x * x + y * y;
            let radial = 1.0 + self.k1 * r2 + self.k2 * r2 * r2;
            let dx = 2.0 * self.p1 * x * y + self.p2 * (r2 + 2.0 * x * x);
            let dy = self.p1 * (r2 + 2.0 * y * y) + 2.0 * self.p2 * x * y;
            x = (xd - dx) / radial;
            y = (yd - dy) / radial;
        }
        // Newton on F(x, y) = distort(x, y) - (xd, yd), numeric Jacobian
        for _ in 0..4 {
            let (fx, fy) = self.distort(x, y);
            let (ex, ey) = (fx - xd, fy - yd);
            if ex.abs() < 1e-15 && ey.abs() < 1e-15 {
                break;
            }
            let h = 1e-7;
            let (ax, ay) = self.distort(x + h, y);
            let (bx, by) = self.distort(x, y + h);
            let (j00, j10, j01, j11) = ((ax - fx) / h, (ay - fy) / h, (bx - fx) / h, (by - fy) / h);
            let det = j00 * j11 - j01 * j10;
            if det.abs() < 1e-12 {
                break;
            }
            x -= (j11 * ex - j01 * ey) / det;
            y -= (-j10 * ex + j00 * ey) / det;
        }
        (x, y)
    }

    /// Camera-frame point -> pixel (with distortion). `None` behind the camera.
    pub fn project_cam(&self, c: V3) -> Option<P2> {
        if c[2] <= 1e-6 {
            return None;
        }
        let (xd, yd) = self.distort(c[0] / c[2], c[1] / c[2]);
        Some(P2::new(self.f * xd + self.cx, self.f * yd + self.cy))
    }

    /// World point -> pixel through a pose.
    pub fn project(&self, p: V3, pose: &Pose) -> Option<P2> {
        self.project_cam(pose.apply(p))
    }

    /// Pixel -> ideal (undistorted) pixel with the same f, cx, cy, so that the pinhole solvers apply.
    pub fn undistort_px(&self, p: P2) -> P2 {
        let (x, y) = self.undistort((p.x - self.cx) / self.f, (p.y - self.cy) / self.f);
        P2::new(self.f * x + self.cx, self.f * y + self.cy)
    }

    /// Pixel -> viewing ray `(x, y, 1)` in the camera frame.
    pub fn ray(&self, p: P2) -> V3 {
        let (x, y) = self.undistort((p.x - self.cx) / self.f, (p.y - self.cy) / self.f);
        [x, y, 1.0]
    }

    pub fn to_array(&self) -> [f64; 7] {
        [self.f, self.cx, self.cy, self.k1, self.k2, self.p1, self.p2]
    }

    pub fn from_slice(a: &[f64]) -> Self {
        Self { f: a[0], cx: a[1], cy: a[2], k1: a[3], k2: a[4], p1: a[5], p2: a[6] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undistort_inverts_distort() {
        let cam = Camera { f: 1000.0, cx: 640.0, cy: 360.0, k1: -0.12, k2: 0.05, p1: 0.001, p2: -0.0008 };
        for &(x, y) in &[(0.0, 0.0), (0.3, -0.2), (-0.55, 0.32), (0.6, 0.35)] {
            let (xd, yd) = cam.distort(x, y);
            let (u, v) = cam.undistort(xd, yd);
            assert!((u - x).abs() < 1e-12 && (v - y).abs() < 1e-12, "({x},{y}) -> ({u},{v})");
        }
    }

    #[test]
    fn pixel_round_trip() {
        let cam = Camera { f: 900.0, cx: 480.0, cy: 270.0, k1: 0.08, k2: -0.02, p1: 0.0, p2: 0.0 };
        let c = [0.07, -0.04, 0.3];
        let px = cam.project_cam(c).unwrap();
        let r = cam.ray(px);
        assert!((r[0] - c[0] / c[2]).abs() < 1e-12 && (r[1] - c[1] / c[2]).abs() < 1e-12);
    }
}
