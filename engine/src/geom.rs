//! Small fixed-size linear algebra. Matrices are row-major `[f64; 9]`.

pub type V3 = [f64; 3];
pub type M3 = [f64; 9];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct P2 {
    pub x: f64,
    pub y: f64,
}

impl P2 {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

pub const IDENTITY: M3 = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

pub fn len(v: V3) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}
pub fn scale(v: V3, s: f64) -> V3 {
    [v[0] * s, v[1] * s, v[2] * s]
}
pub fn add3(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn normalize(v: V3) -> V3 {
    let l = len(v);
    scale(v, 1.0 / if l != 0.0 { l } else { 1.0 })
}
pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn mul(a: &M3, b: &M3) -> M3 {
    let mut o = [0.0; 9];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
            }
        }
    }
    o
}

pub fn mul_v(m: &M3, v: V3) -> V3 {
    [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ]
}

/// `m^T * v`
pub fn mul_tv(m: &M3, v: V3) -> V3 {
    [
        m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
        m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
        m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
    ]
}

/// Rotation matrix from an axis-angle vector.
pub fn rodrigues(w: V3) -> M3 {
    let th = len(w);
    if th < 1e-12 {
        return IDENTITY;
    }
    let [x, y, z] = scale(w, 1.0 / th);
    let (s, c) = th.sin_cos();
    let cc = 1.0 - c;
    [
        c + x * x * cc,
        x * y * cc - z * s,
        x * z * cc + y * s,
        y * x * cc + z * s,
        c + y * y * cc,
        y * z * cc - x * s,
        z * x * cc - y * s,
        z * y * cc + x * s,
        c + z * z * cc,
    ]
}

/// Solve `A x = b` (n x n, row-major `a`) by Gauss-Jordan with partial pivoting.
pub fn solve(a: &[f64], b: &[f64], n: usize) -> Option<Vec<f64>> {
    let w = n + 1;
    let mut m = vec![0.0; n * w];
    for r in 0..n {
        m[r * w..r * w + n].copy_from_slice(&a[r * n..r * n + n]);
        m[r * w + n] = b[r];
    }
    for c in 0..n {
        let mut p = c;
        for r in c + 1..n {
            if m[r * w + c].abs() > m[p * w + c].abs() {
                p = r;
            }
        }
        if m[p * w + c].abs() < 1e-12 {
            return None;
        }
        if p != c {
            for j in 0..w {
                m.swap(c * w + j, p * w + j);
            }
        }
        for r in 0..n {
            if r == c {
                continue;
            }
            let k = m[r * w + c] / m[c * w + c];
            for j in c..w {
                m[r * w + j] -= k * m[c * w + j];
            }
        }
    }
    Some((0..n).map(|i| m[i * w + n] / m[i * w + i]).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rodrigues_is_orthonormal() {
        let r = rodrigues([0.3, -0.2, 0.9]);
        let rt_r = mul(&[r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]], &r);
        for i in 0..9 {
            assert!((rt_r[i] - IDENTITY[i]).abs() < 1e-12);
        }
    }

    #[test]
    fn solve_small_system() {
        let x = solve(&[2.0, 1.0, 1.0, 3.0], &[3.0, 5.0], 2).unwrap();
        assert!((x[0] - 0.8).abs() < 1e-12 && (x[1] - 1.4).abs() < 1e-12);
        assert!(solve(&[1.0, 2.0, 2.0, 4.0], &[1.0, 2.0], 2).is_none());
    }
}
