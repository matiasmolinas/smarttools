//! Sub-pixel marker corners: fit a line to each side of the black square (50 % intensity crossing
//! between the black border and the white quiet zone), then intersect adjacent sides.
//!
//! Input corners are the detector's (js-aruco2): indices of the boundary black pixels.

use crate::geom::P2;

/// An RGBA8 image, row-major.
pub struct Rgba<'a> {
    pub width: usize,
    pub height: usize,
    pub data: &'a [u8],
}

impl Rgba<'_> {
    fn luma(&self, x: i64, y: i64) -> f64 {
        let cx = x.clamp(0, self.width as i64 - 1) as usize;
        let cy = y.clamp(0, self.height as i64 - 1) as usize;
        let i = (cy * self.width + cx) * 4;
        0.299 * self.data[i] as f64 + 0.587 * self.data[i + 1] as f64 + 0.114 * self.data[i + 2] as f64
    }

    /// Bilinear sample with pixel centres at +0.5.
    fn sample(&self, x: f64, y: f64) -> f64 {
        let x0f = (x - 0.5).floor();
        let y0f = (y - 0.5).floor();
        let (fx, fy) = (x - 0.5 - x0f, y - 0.5 - y0f);
        let (x0, y0) = (x0f as i64, y0f as i64);
        self.luma(x0, y0) * (1.0 - fx) * (1.0 - fy)
            + self.luma(x0 + 1, y0) * fx * (1.0 - fy)
            + self.luma(x0, y0 + 1) * (1.0 - fx) * fy
            + self.luma(x0 + 1, y0 + 1) * fx * fy
    }
}

struct Line {
    px: f64,
    py: f64,
    dx: f64,
    dy: f64,
}

/// Refine the 4 corners of one marker. Returns `None` (keep the detector's corners) when an edge
/// is too weak or the result moves a corner more than 3 px.
pub fn refine_corners(img: &Rgba, corners: &[P2; 4]) -> Option<[P2; 4]> {
    let c: Vec<P2> = corners.iter().map(|p| P2::new(p.x + 0.5, p.y + 0.5)).collect();
    let mx = c.iter().map(|p| p.x).sum::<f64>() / 4.0;
    let my = c.iter().map(|p| p.y).sum::<f64>() / 4.0;
    let side = ((c[1].x - c[0].x).hypot(c[1].y - c[0].y) + (c[2].x - c[1].x).hypot(c[2].y - c[1].y)) / 2.0;
    let reach = (side / 8.0 * 0.45).clamp(1.5, 4.0); // stay inside the 1-cell black border
    let mut lines: Vec<Line> = Vec::with_capacity(4);
    for s in 0..4 {
        let (a, b) = (c[s], c[(s + 1) % 4]);
        let (mut dx, mut dy) = (b.x - a.x, b.y - a.y);
        let l = dx.hypot(dy);
        if l < 4.0 {
            return None;
        }
        dx /= l;
        dy /= l;
        let (mut nx, mut ny) = (-dy, dx);
        let (midx, midy) = ((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
        if (midx - mx) * nx + (midy - my) * ny < 0.0 {
            nx = -nx;
            ny = -ny;
        }
        let mut pts: Vec<P2> = Vec::with_capacity(14);
        for k in 0..14 {
            let tt = 0.18 + (0.64 * k as f64) / 13.0;
            let (ox, oy) = (a.x + (b.x - a.x) * tt, a.y + (b.y - a.y) * tt);
            let in_v = img.sample(ox - nx * reach, oy - ny * reach);
            let out_v = img.sample(ox + nx * reach, oy + ny * reach);
            if out_v - in_v < 25.0 {
                continue; // weak edge
            }
            let mid = (in_v + out_v) / 2.0;
            let (mut prev_s, mut prev_v) = (-reach, in_v);
            let mut found = None;
            let mut sd = -reach + 0.1;
            while sd <= reach + 1e-9 {
                let v = img.sample(ox + nx * sd, oy + ny * sd);
                if prev_v < mid && v >= mid {
                    found = Some(prev_s + ((mid - prev_v) / (v - prev_v)) * (sd - prev_s));
                    break;
                }
                prev_s = sd;
                prev_v = v;
                sd += 0.1;
            }
            if let Some(f) = found {
                pts.push(P2::new(ox + nx * f, oy + ny * f));
            }
        }
        if pts.len() < 5 {
            return None;
        }
        // least-squares line through the points (PCA)
        let n = pts.len() as f64;
        let qx = pts.iter().map(|p| p.x).sum::<f64>() / n;
        let qy = pts.iter().map(|p| p.y).sum::<f64>() / n;
        let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
        for p in &pts {
            sxx += (p.x - qx) * (p.x - qx);
            sxy += (p.x - qx) * (p.y - qy);
            syy += (p.y - qy) * (p.y - qy);
        }
        let th = 0.5 * (2.0 * sxy).atan2(sxx - syy);
        lines.push(Line { px: qx, py: qy, dx: th.cos(), dy: th.sin() });
    }
    let mut out = [P2::new(0.0, 0.0); 4];
    for i in 0..4 {
        let (l1, l2) = (&lines[(i + 3) % 4], &lines[i]); // corner i joins side i-1 and side i
        let den = l1.dx * l2.dy - l1.dy * l2.dx;
        if den.abs() < 1e-6 {
            return None;
        }
        let tt = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
        let p = P2::new(l1.px + l1.dx * tt, l1.py + l1.dy * tt);
        if (p.x - c[i].x).hypot(p.y - c[i].y) > 3.0 {
            return None; // sanity
        }
        out[i] = p;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A rotated black square on white, 4x4 supersampled, and its true corners.
    fn render(w: usize, h: usize, cx: f64, cy: f64, half: f64, ang: f64) -> (Vec<u8>, [P2; 4]) {
        let (s, c) = ang.sin_cos();
        let mut data = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let mut acc: f64 = 0.0;
                for sy in 0..4 {
                    for sx in 0..4 {
                        let px = x as f64 + (sx as f64 + 0.5) / 4.0 - cx;
                        let py = y as f64 + (sy as f64 + 0.5) / 4.0 - cy;
                        let (u, v) = (c * px + s * py, -s * px + c * py);
                        acc += if u.abs() < half && v.abs() < half { 20.0 } else { 235.0 };
                    }
                }
                let i = (y * w + x) * 4;
                let g = (acc / 16.0).round() as u8;
                data[i..i + 4].copy_from_slice(&[g, g, g, 255]);
            }
        }
        let corner = |u: f64, v: f64| P2::new(cx + c * u - s * v, cy + s * u + c * v);
        (data, [corner(-half, -half), corner(half, -half), corner(half, half), corner(-half, half)])
    }

    #[test]
    fn corners_are_sub_pixel() {
        let (data, truth) = render(120, 120, 60.3, 58.7, 30.0, 0.21);
        let img = Rgba { width: 120, height: 120, data: &data };
        // detector-like input: boundary black pixel indices (about 1 px inside, integer)
        let rough: [P2; 4] = truth.map(|p| {
            let dx = (60.3 - p.x).signum();
            let dy = (58.7 - p.y).signum();
            P2::new((p.x + dx * 0.5).floor(), (p.y + dy * 0.5).floor())
        });
        let out = refine_corners(&img, &rough).expect("refined");
        for (o, t) in out.iter().zip(&truth) {
            let e = (o.x - t.x).hypot(o.y - t.y);
            assert!(e < 0.1, "corner error {e} px");
        }
    }

    #[test]
    fn flat_image_keeps_detector_corners() {
        let data = vec![128u8; 64 * 64 * 4];
        let img = Rgba { width: 64, height: 64, data: &data };
        let rough = [P2::new(10.0, 10.0), P2::new(50.0, 10.0), P2::new(50.0, 50.0), P2::new(10.0, 50.0)];
        assert!(refine_corners(&img, &rough).is_none());
    }
}
