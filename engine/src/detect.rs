//! Square fiducial marker detection (ArUco-style, 6×6 bits inside a black border, 8×8 cells), in Rust so it
//! runs as WebAssembly on the phone. An alternative to the JavaScript detector (js-aruco2): same input (an
//! RGBA frame), same output (marker id and its 4 image corners, in the same order), so the rest of the
//! pipeline (sub-pixel refinement, pose) does not change.
//!
//! 1. grey levels
//! 2. adaptive threshold: a pixel is "dark" if it is darker than its neighbourhood's mean by a margin
//!    (integral image, so the window size costs nothing)
//! 3. connected components of dark pixels (union-find, 8-connected)
//! 4. for each plausible component: its convex hull (from the leftmost / rightmost pixel of each row), and the
//!    quadrilateral that best fits it (two farthest hull points, then the farthest on each side)
//! 5. the 8×8 grid read through the homography of that quadrilateral (averaged samples per cell), the
//!    border checked dark, the 6×6 bits looked up in the dictionary in its 4 rotations (nearest code within a
//!    few bits)
//!
//! Corners are returned clockwise in the image (y down), starting at the marker's own top-left corner.

/// One detected marker: its id and corners (image px, clockwise, the marker's top-left first).
#[derive(Clone, Debug)]
pub struct Detection {
    pub id: u32,
    pub corners: [[f64; 2]; 4],
    /// bits that differ from the dictionary code
    pub distance: u32,
}

/// Detection parameters (defaults tuned for the SmartTools sheet at 540–960 px).
#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// half window of the adaptive threshold, as a fraction of the image's short side (min 3 px)
    pub window_frac: f64,
    /// how much darker than the local mean a pixel must be to count as dark (grey levels)
    pub margin: i32,
    /// smallest marker side accepted (px)
    pub min_side: f64,
    /// most bits a reading may differ from a code and still be accepted
    pub max_distance: u32,
    /// the quadrilateral's area over its hull's: a square in perspective fills it; less means something dark
    /// (the bit, a shadow) is joined to the marker and its outline is not the marker's
    pub min_fill: f64,
}

impl Default for Params {
    fn default() -> Self {
        Params { window_frac: 0.02, margin: 7, min_side: 10.0, max_distance: 3, min_fill: 0.95 }
    }
}

/// Detect markers in an RGBA image. `codes`: 36 bytes per id (1 = white cell), row by row from the
/// marker's top-left, as the renderer draws them.
pub fn detect(rgba: &[u8], width: usize, height: usize, codes: &[u8], p: &Params) -> Vec<Detection> {
    if width < 16 || height < 16 || rgba.len() < width * height * 4 || codes.len() < 36 {
        return Vec::new();
    }
    let grey = to_grey(rgba, width, height);
    let dark = threshold(&grey, width, height, p);
    let (labels, stats) = components(&dark, width, height);
    let dict = Dictionary::new(codes);
    let mut found: Vec<(Detection, f64)> = Vec::new();
    for (label, st) in stats.iter().enumerate() {
        let bw = st.x1 - st.x0 + 1;
        let bh = st.y1 - st.y0 + 1;
        if (bw as f64) < p.min_side || (bh as f64) < p.min_side || bw > width * 9 / 10 || bh > height * 9 / 10 || st.area < 24 {
            continue;
        }
        let hull = hull_of(&labels, width, st, label as u32 + 1);
        if hull.len() < 4 {
            continue;
        }
        let Some(quad) = best_quad(&hull) else { continue };
        let side = (0..4).map(|k| dist(quad[k], quad[(k + 1) % 4])).fold(f64::INFINITY, f64::min);
        if side < p.min_side {
            continue;
        }
        // the quadrilateral must fill its hull (a square seen in perspective does)
        let (qa, ha) = (poly_area(&quad).abs(), poly_area(&hull).abs());
        if ha <= 0.0 || qa / ha < p.min_fill {
            continue;
        }
        let quad = clockwise(quad);
        if let Some(d) = read_marker(&grey, width, height, &quad, &dict, p.max_distance) {
            let perim: f64 = (0..4).map(|k| dist(d.corners[k], d.corners[(k + 1) % 4])).sum();
            found.push((d, perim));
        }
    }
    // the same marker found twice (an inner and an outer outline): keep the larger
    found.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<Detection> = Vec::new();
    for (d, _) in found {
        let c = centre(&d.corners);
        if out.iter().any(|o| o.id == d.id || dist(centre(&o.corners), c) < 4.0) {
            continue;
        }
        out.push(d);
    }
    out
}

// ---------------- 1. grey ----------------

fn to_grey(rgba: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut g = vec![0u8; w * h];
    for (i, px) in rgba.chunks_exact(4).take(w * h).enumerate() {
        g[i] = ((px[0] as u32 * 77 + px[1] as u32 * 150 + px[2] as u32 * 29) >> 8) as u8;
    }
    g
}

// ---------------- 2. adaptive threshold ----------------

fn threshold(grey: &[u8], w: usize, h: usize, p: &Params) -> Vec<bool> {
    // integral image (one extra row and column of zeros)
    let iw = w + 1;
    let mut ii = vec![0u32; iw * (h + 1)];
    for y in 0..h {
        let mut row = 0u32;
        for x in 0..w {
            row += grey[y * w + x] as u32;
            ii[(y + 1) * iw + x + 1] = ii[y * iw + x + 1] + row;
        }
    }
    let r = ((w.min(h) as f64 * p.window_frac).round() as usize).max(3);
    let mut dark = vec![false; w * h];
    for y in 0..h {
        let y0 = y.saturating_sub(r);
        let y1 = (y + r + 1).min(h);
        for x in 0..w {
            let x0 = x.saturating_sub(r);
            let x1 = (x + r + 1).min(w);
            let sum = ii[y1 * iw + x1] + ii[y0 * iw + x0] - ii[y0 * iw + x1] - ii[y1 * iw + x0];
            let n = ((y1 - y0) * (x1 - x0)) as i32;
            // grey * n < sum - margin * n  ⇔  grey < mean - margin
            dark[y * w + x] = (grey[y * w + x] as i32) * n < sum as i32 - p.margin * n;
        }
    }
    dark
}

// ---------------- 3. connected components ----------------

#[derive(Clone, Copy)]
struct Stat {
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    area: usize,
}

fn find(parent: &mut [u32], mut a: u32) -> u32 {
    while parent[a as usize] != a {
        parent[a as usize] = parent[parent[a as usize] as usize];
        a = parent[a as usize];
    }
    a
}

/// Labels (0 = background, else component index + 1) and each component's box and area.
fn components(dark: &[bool], w: usize, h: usize) -> (Vec<u32>, Vec<Stat>) {
    let mut labels = vec![0u32; w * h];
    let mut parent: Vec<u32> = vec![0];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if !dark[i] {
                continue;
            }
            // 8-connected neighbours already visited: W, NW, N, NE
            let mut best = 0u32;
            let mut nb = [0u32; 4];
            if x > 0 {
                nb[0] = labels[i - 1];
            }
            if y > 0 {
                if x > 0 {
                    nb[1] = labels[i - w - 1];
                }
                nb[2] = labels[i - w];
                if x + 1 < w {
                    nb[3] = labels[i - w + 1];
                }
            }
            for &l in &nb {
                if l != 0 && (best == 0 || l < best) {
                    best = l;
                }
            }
            if best == 0 {
                let l = parent.len() as u32;
                parent.push(l);
                labels[i] = l;
            } else {
                labels[i] = best;
                for &l in &nb {
                    if l != 0 && l != best {
                        let (a, b) = (find(&mut parent, l), find(&mut parent, best));
                        if a != b {
                            let (lo, hi) = if a < b { (a, b) } else { (b, a) };
                            parent[hi as usize] = lo;
                        }
                    }
                }
            }
        }
    }
    // flatten to compact indices
    let mut compact = vec![0u32; parent.len()];
    let mut stats: Vec<Stat> = Vec::new();
    for l in 1..parent.len() as u32 {
        let r = find(&mut parent, l);
        if compact[r as usize] == 0 {
            stats.push(Stat { x0: usize::MAX, y0: usize::MAX, x1: 0, y1: 0, area: 0 });
            compact[r as usize] = stats.len() as u32;
        }
        compact[l as usize] = compact[r as usize];
    }
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if labels[i] == 0 {
                continue;
            }
            let c = compact[labels[i] as usize];
            labels[i] = c;
            let s = &mut stats[c as usize - 1];
            s.x0 = s.x0.min(x);
            s.y0 = s.y0.min(y);
            s.x1 = s.x1.max(x);
            s.y1 = s.y1.max(y);
            s.area += 1;
        }
    }
    (labels, stats)
}

// ---------------- 4. hull and quadrilateral ----------------

/// Convex hull of a component from its leftmost and rightmost pixel per row (pixel corners, so the hull
/// follows the outer edge of the pixels).
fn hull_of(labels: &[u32], w: usize, st: &Stat, label: u32) -> Vec<[f64; 2]> {
    let mut pts: Vec<[f64; 2]> = Vec::new();
    for y in st.y0..=st.y1 {
        let row = &labels[y * w + st.x0..=y * w + st.x1];
        let Some(l) = row.iter().position(|&v| v == label) else { continue };
        let r = row.iter().rposition(|&v| v == label).unwrap();
        let (xl, xr) = ((st.x0 + l) as f64, (st.x0 + r) as f64 + 1.0);
        pts.push([xl, y as f64]);
        pts.push([xl, y as f64 + 1.0]);
        pts.push([xr, y as f64]);
        pts.push([xr, y as f64 + 1.0]);
    }
    convex_hull(pts)
}

fn cross(o: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// Andrew's monotone chain.
fn convex_hull(mut pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap().then(a[1].partial_cmp(&b[1]).unwrap()));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let mut lower: Vec<[f64; 2]> = Vec::new();
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<[f64; 2]> = Vec::new();
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// The quadrilateral inscribed in a convex hull: the two farthest points (a diagonal), then the farthest
/// point on each side of it. Returned in hull order.
fn best_quad(hull: &[[f64; 2]]) -> Option<[[f64; 2]; 4]> {
    let n = hull.len();
    let (mut ia, mut ic, mut best) = (0, 0, -1.0);
    for i in 0..n {
        for j in i + 1..n {
            let d = dist(hull[i], hull[j]);
            if d > best {
                best = d;
                ia = i;
                ic = j;
            }
        }
    }
    let (a, c) = (hull[ia], hull[ic]);
    let (mut ib, mut bmax, mut id, mut dmin) = (usize::MAX, 0.0, usize::MAX, 0.0);
    for (k, &p) in hull.iter().enumerate() {
        let s = cross(a, c, p);
        if s > bmax {
            bmax = s;
            ib = k;
        }
        if s < dmin {
            dmin = s;
            id = k;
        }
    }
    if ib == usize::MAX || id == usize::MAX {
        return None;
    }
    // the second diagonal should also be close to the longest: refine it as the farthest pair (b, d)
    let mut q = [(ia, a), (ib, hull[ib]), (ic, c), (id, hull[id])];
    q.sort_by_key(|e| e.0);
    Some([q[0].1, q[1].1, q[2].1, q[3].1])
}

fn poly_area(p: &[[f64; 2]]) -> f64 {
    let n = p.len();
    (0..n).map(|i| p[i][0] * p[(i + 1) % n][1] - p[(i + 1) % n][0] * p[i][1]).sum::<f64>() / 2.0
}

/// Clockwise in the image (y down), as js-aruco2's candidates.
fn clockwise(q: [[f64; 2]; 4]) -> [[f64; 2]; 4] {
    if cross(q[0], q[1], q[2]) < 0.0 {
        [q[0], q[3], q[2], q[1]]
    } else {
        q
    }
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}
fn centre(c: &[[f64; 2]; 4]) -> [f64; 2] {
    [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4.0, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4.0]
}

// ---------------- 5. reading the marker ----------------

struct Dictionary {
    codes: Vec<u64>,
}
impl Dictionary {
    fn new(codes: &[u8]) -> Self {
        let n = codes.len() / 36;
        Dictionary {
            codes: (0..n)
                .map(|id| (0..36).fold(0u64, |acc, i| acc | (((codes[id * 36 + i] != 0) as u64) << i)))
                .collect(),
        }
    }
    /// Nearest code to `bits`: (id, distance).
    fn nearest(&self, bits: u64) -> Option<(u32, u32)> {
        let mut best: Option<(u32, u32)> = None;
        for (id, &c) in self.codes.iter().enumerate() {
            let d = (c ^ bits).count_ones();
            if best.map_or(true, |b| d < b.1) {
                best = Some((id as u32, d));
                if d == 0 {
                    break;
                }
            }
        }
        best
    }
}

/// Homography from the unit grid (0..8 × 0..8) to the quadrilateral (corners in order TL, TR, BR, BL).
fn grid_homography(q: &[[f64; 2]; 4]) -> Option<[f64; 9]> {
    let src = [[0.0, 0.0], [8.0, 0.0], [8.0, 8.0], [0.0, 8.0]];
    let mut a = [[0.0f64; 9]; 8];
    for k in 0..4 {
        let (x, y) = (src[k][0], src[k][1]);
        let (u, v) = (q[k][0], q[k][1]);
        a[2 * k] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        a[2 * k + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    // Gaussian elimination with partial pivoting on the 8×8 system
    for col in 0..8 {
        let piv = (col..8).max_by(|&i, &j| a[i][col].abs().partial_cmp(&a[j][col].abs()).unwrap())?;
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        for r in 0..8 {
            if r != col {
                let f = a[r][col] / a[col][col];
                for c in col..9 {
                    a[r][c] -= f * a[col][c];
                }
            }
        }
    }
    let h: Vec<f64> = (0..8).map(|i| a[i][8] / a[i][i]).collect();
    Some([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0])
}

fn apply_h(h: &[f64; 9], x: f64, y: f64) -> [f64; 2] {
    let w = h[6] * x + h[7] * y + h[8];
    [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
}

fn sample(grey: &[u8], w: usize, h: usize, p: [f64; 2]) -> Option<f64> {
    let (x, y) = (p[0] - 0.5, p[1] - 0.5);
    if x < 0.0 || y < 0.0 || x >= (w - 1) as f64 || y >= (h - 1) as f64 {
        return None;
    }
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (fx, fy) = (x - x0 as f64, y - y0 as f64);
    let g = |xx: usize, yy: usize| grey[yy * w + xx] as f64;
    Some(g(x0, y0) * (1.0 - fx) * (1.0 - fy) + g(x0 + 1, y0) * fx * (1.0 - fy) + g(x0, y0 + 1) * (1.0 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy)
}

/// Rotate a 6×6 bit grid a quarter turn clockwise: new(r, c) = old(5 - c, r).
fn rotate_bits(b: u64) -> u64 {
    let mut o = 0u64;
    for r in 0..6 {
        for c in 0..6 {
            if (b >> ((5 - c) * 6 + r)) & 1 == 1 {
                o |= 1 << (r * 6 + c);
            }
        }
    }
    o
}

fn read_marker(grey: &[u8], w: usize, h: usize, quad: &[[f64; 2]; 4], dict: &Dictionary, max_distance: u32) -> Option<Detection> {
    let hm = grid_homography(quad)?;
    let mut cell = [[0.0f64; 8]; 8];
    for r in 0..8 {
        for c in 0..8 {
            let mut s = 0.0;
            let mut n = 0.0;
            for dy in [-0.22, 0.0, 0.22] {
                for dx in [-0.22, 0.0, 0.22] {
                    if let Some(v) = sample(grey, w, h, apply_h(&hm, c as f64 + 0.5 + dx, r as f64 + 0.5 + dy)) {
                        s += v;
                        n += 1.0;
                    }
                }
            }
            if n == 0.0 {
                return None;
            }
            cell[r][c] = s / n;
        }
    }
    let (lo, hi) = cell.iter().flatten().fold((f64::MAX, f64::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    if hi - lo < 30.0 {
        return None;
    }
    let t = (lo + hi) / 2.0;
    for k in 0..8 {
        if cell[0][k] > t || cell[7][k] > t || cell[k][0] > t || cell[k][7] > t {
            return None;
        }
    }
    let mut bits = 0u64;
    for r in 0..6 {
        for c in 0..6 {
            if cell[r + 1][c + 1] > t {
                bits |= 1 << (r * 6 + c);
            }
        }
    }
    // try the 4 rotations: after k quarter turns clockwise the reading matches a code, so the marker's own
    // top-left corner is image corner (4 - k) % 4
    let mut best: Option<(u32, u32, usize)> = None;
    let mut b = bits;
    for k in 0..4 {
        if let Some((id, d)) = dict.nearest(b) {
            if best.map_or(true, |x| d < x.1) {
                best = Some((id, d, k));
            }
        }
        b = rotate_bits(b);
    }
    let (id, d, k) = best?;
    if d > max_distance {
        return None;
    }
    let s = (4 - k) % 4;
    let corners = [quad[s], quad[(s + 1) % 4], quad[(s + 2) % 4], quad[(s + 3) % 4]];
    // the outline found by the threshold sits slightly outside the black edge (blur, anti-aliasing): put
    // each side where the image crosses halfway between the black border and the white paper
    let dark: f64 = (0..8).map(|i| cell[0][i] + cell[7][i] + cell[i][0] + cell[i][7]).sum::<f64>() / 32.0;
    // a side that is not one clean straight edge (the bit or a finger over the marker, a fold in the paper)
    // makes a marker whose corners cannot be trusted: drop it, as the outline detector would
    let corners = refine_edges(grey, w, h, &corners, dark, hi)?;
    Some(Detection { id, corners, distance: d })
}

/// Each side of the quadrilateral moved to where the grey level crosses `(dark + light) / 2` along its normal,
/// fitted as a line through several samples; the corners are where the lines meet.
fn refine_edges(grey: &[u8], w: usize, h: usize, q: &[[f64; 2]; 4], dark: f64, light: f64) -> Option<[[f64; 2]; 4]> {
    let mid = (dark + light) / 2.0;
    let c = centre(q);
    let side = (0..4).map(|k| dist(q[k], q[(k + 1) % 4])).fold(f64::INFINITY, f64::min);
    // search no further than a third of a cell, so the white bits inside are never reached
    let reach = (side / 8.0 * 0.6).clamp(1.0, 6.0);
    let mut lines: Vec<([f64; 2], [f64; 2])> = Vec::with_capacity(4);
    for k in 0..4 {
        let (a, b) = (q[k], q[(k + 1) % 4]);
        let len = dist(a, b);
        let d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        let mut nrm = [-d[1], d[0]];
        let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        if (m[0] - c[0]) * nrm[0] + (m[1] - c[1]) * nrm[1] < 0.0 {
            nrm = [-nrm[0], -nrm[1]];
        }
        let mut pts: Vec<[f64; 2]> = Vec::new();
        let n = 16;
        for i in 1..n {
            let t = 0.12 + 0.76 * i as f64 / n as f64;
            let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            // from inside (dark) outwards (light): the first crossing of the mid level
            let step = 0.2;
            let mut prev = sample(grey, w, h, [p[0] - nrm[0] * reach, p[1] - nrm[1] * reach]);
            let mut s = -reach + step;
            while s <= reach {
                let cur = sample(grey, w, h, [p[0] + nrm[0] * s, p[1] + nrm[1] * s]);
                if let (Some(v0), Some(v1)) = (prev, cur) {
                    if v0 < mid && v1 >= mid {
                        let f = (mid - v0) / (v1 - v0);
                        let ss = s - step + f * step;
                        pts.push([p[0] + nrm[0] * ss, p[1] + nrm[1] * ss]);
                        break;
                    }
                }
                prev = cur;
                s += step;
            }
        }
        // most samples must find the edge
        if pts.len() < (n - 1) * 3 / 4 {
            return None;
        }
        // least-squares line: centroid and principal direction
        let (mx, my) = (pts.iter().map(|p| p[0]).sum::<f64>() / pts.len() as f64, pts.iter().map(|p| p[1]).sum::<f64>() / pts.len() as f64);
        let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
        for p in &pts {
            let (dx, dy) = (p[0] - mx, p[1] - my);
            sxx += dx * dx;
            sxy += dx * dy;
            syy += dy * dy;
        }
        let ang = 0.5 * (2.0 * sxy).atan2(sxx - syy);
        let dir = [ang.cos(), ang.sin()];
        // and lie on one straight line
        let rms = (pts.iter().map(|p| ((p[0] - mx) * dir[1] - (p[1] - my) * dir[0]).powi(2)).sum::<f64>() / pts.len() as f64).sqrt();
        let worst = pts.iter().map(|p| ((p[0] - mx) * dir[1] - (p[1] - my) * dir[0]).abs()).fold(0.0, f64::max);
        if rms > 0.35 || worst > 1.0 {
            return None;
        }
        lines.push(([mx, my], dir));
    }
    let mut out = [[0.0; 2]; 4];
    for k in 0..4 {
        // corner k is where side k-1 (ending at it) meets side k (starting at it)
        let (p1, d1) = lines[(k + 3) % 4];
        let (p2, d2) = lines[k];
        let den = d1[0] * d2[1] - d1[1] * d2[0];
        if den.abs() < 1e-6 {
            return None;
        }
        let t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
        out[k] = [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
        // never move a corner far from the outline it came from
        if dist(out[k], q[k]) > reach * 2.0 + 1.0 {
            return None;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Draw one marker (id 0 of a tiny dictionary) axis-aligned into an RGBA image.
    fn draw(code: &[u8; 36], w: usize, h: usize, x0: usize, y0: usize, cell: usize) -> Vec<u8> {
        let mut img = vec![255u8; w * h * 4];
        for r in 0..8 {
            for c in 0..8 {
                let white = r > 0 && r < 7 && c > 0 && c < 7 && code[(r - 1) * 6 + (c - 1)] == 1;
                for y in 0..cell {
                    for x in 0..cell {
                        let i = ((y0 + r * cell + y) * w + x0 + c * cell + x) * 4;
                        let v = if white { 255 } else { 0 };
                        img[i] = v;
                        img[i + 1] = v;
                        img[i + 2] = v;
                    }
                }
            }
        }
        img
    }

    #[test]
    fn finds_an_axis_aligned_marker_with_its_corners() {
        let mut code = [0u8; 36];
        for (i, v) in code.iter_mut().enumerate() {
            *v = ((i * 7 + 3) % 5 < 2) as u8;
        }
        let img = draw(&code, 200, 160, 40, 30, 10);
        let d = detect(&img, 200, 160, &code, &Params::default());
        assert_eq!(d.len(), 1, "{d:?}");
        assert_eq!(d[0].id, 0);
        assert_eq!(d[0].distance, 0);
        let want = [[40.0, 30.0], [120.0, 30.0], [120.0, 110.0], [40.0, 110.0]];
        for k in 0..4 {
            assert!(dist(d[0].corners[k], want[k]) < 1.5, "corner {k}: {:?} vs {:?}", d[0].corners[k], want[k]);
        }
    }

    #[test]
    fn rotation_moves_the_first_corner() {
        // an irregular code (no rotational symmetry, like the real dictionary's)
        let mut code = [0u8; 36];
        let mut s = 12345u32;
        for v in code.iter_mut() {
            s = s.wrapping_mul(1103515245).wrapping_add(12345);
            *v = ((s >> 16) & 1) as u8;
        }
        // the same marker drawn a quarter turn clockwise: its own top-left is now the image's top-right
        let mut rot = [0u8; 36];
        for r in 0..6 {
            for c in 0..6 {
                rot[r * 6 + c] = code[(5 - c) * 6 + r];
            }
        }
        let img = draw(&rot, 200, 160, 40, 30, 10);
        let d = detect(&img, 200, 160, &code, &Params::default());
        assert_eq!(d.len(), 1);
        assert!(dist(d[0].corners[0], [120.0, 30.0]) < 1.5, "{:?}", d[0].corners);
        assert!(dist(d[0].corners[1], [120.0, 110.0]) < 1.5, "{:?}", d[0].corners);
    }

    #[test]
    fn nothing_on_a_blank_image() {
        let img = vec![200u8; 120 * 100 * 4];
        assert!(detect(&img, 120, 100, &[0u8; 36], &Params::default()).is_empty());
    }
}
