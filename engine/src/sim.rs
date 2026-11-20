//! Scene simulator: what the phone camera on the drill sees. Renders the printed marker sheet on a
//! wall through a camera with lens distortion, with the drill bit in view, motion blur (several
//! poses per exposure), uneven lighting, vignetting, sensor noise and occluders (a hand, a cable).
//!
//! It is the test bench for the whole pipeline: render -> detect -> refine -> pose -> navigation,
//! compared against the ground truth that generated the frame.

use crate::board::{marker_at, marker_center, BOARD_TARGETS, MARKER_SIZE, SHEET_H, SHEET_W};
use crate::camera::Camera;
use crate::geom::{cross, dot, len, mul, mul_v, normalize, rodrigues, scale, sub3, M3, V3};
use crate::pose::Pose;

/// World -> camera rotation of a camera that looks straight at the sheet (camera z = world -Z).
pub const BASE: M3 = [1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0];

fn transpose(m: &M3) -> M3 {
    [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

/// Camera pose of the phone in the dock, given how the tool is held.
///
/// - `tool_rot`: rotation (world) applied to a tool that is square to the surface; it maps the
///   nominal bit direction (0, 0, -1) to the actual one. Its rotation about world Z is the twist.
/// - `tip_world`: where the bit tip is.
/// - `tip_cam`, `axis_cam`: the dock geometry (bit tip and bit axis in the camera frame).
pub fn rig_pose(tool_rot: &M3, tip_world: V3, tip_cam: V3, axis_cam: V3) -> Pose {
    let ez = [0.0, 0.0, 1.0];
    let axis_cam = normalize(axis_cam);
    let k = cross(ez, axis_cam);
    let ang = dot(ez, axis_cam).clamp(-1.0, 1.0).acos();
    let a = if len(k) < 1e-12 { crate::geom::IDENTITY } else { rodrigues(scale(normalize(k), ang)) };
    let cam_to_world = mul(&mul(tool_rot, &transpose(&BASE)), &transpose(&a));
    let r = transpose(&cam_to_world);
    Pose { r, t: sub3(tip_cam, mul_v(&r, tip_world)), rms: 0.0 }
}

/// Tool rotation from yaw (about world Y), pitch (about world X) and twist (about the bit), degrees.
pub fn tool_rotation(yaw_deg: f64, pitch_deg: f64, twist_deg: f64) -> M3 {
    // positive yaw tilts the bit toward +X, positive pitch toward +Y (same signs as nav::NavState)
    let ry = rodrigues([0.0, -yaw_deg.to_radians(), 0.0]);
    let rx = rodrigues([pitch_deg.to_radians(), 0.0, 0.0]);
    let rz = rodrigues([0.0, 0.0, twist_deg.to_radians()]);
    mul(&mul(&ry, &rx), &rz)
}

/// Grey levels and options of the printed scene.
#[derive(Clone, Copy, Debug)]
pub struct SceneLook {
    pub wall: f64,
    pub paper: f64,
    pub ink: f64,
    /// Draw the A1-A3 crosshairs (they are printed on the real sheet).
    pub crosses: bool,
}

impl Default for SceneLook {
    fn default() -> Self {
        Self { wall: 150.0, paper: 232.0, ink: 22.0, crosses: true }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Lighting {
    pub gain: f64,
    /// Darkening at the image corners, 0..1.
    pub vignette: f64,
    /// Brightness change from the left to the right edge, fraction (e.g. 0.3).
    pub gradient: f64,
    /// Sensor noise, grey levels (standard deviation).
    pub noise: f64,
    pub seed: u32,
}

impl Default for Lighting {
    fn default() -> Self {
        Self { gain: 1.0, vignette: 0.25, gradient: 0.15, noise: 3.0, seed: 1 }
    }
}

/// The drill bit as seen by the camera (rigid with it).
#[derive(Clone, Copy, Debug)]
pub struct Bit {
    pub tip_cam: V3,
    pub axis_cam: V3,
    pub length: f64,
    pub radius: f64,
}

/// A disc in image pixels that hides the scene (a finger, a cable).
#[derive(Clone, Copy, Debug)]
pub struct Occluder {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
}

/// Printed-sheet intensity at a world point on the surface. `codes`: 36 bits per marker id (1 = white).
pub fn sheet_value(x: f64, y: f64, codes: &[u8], look: &SceneLook) -> f64 {
    if let Some(id) = marker_at(x, y) {
        let m = marker_center(id).unwrap_or(crate::geom::P2::new(0.0, 0.0));
        let h = MARKER_SIZE / 2.0;
        let cell = MARKER_SIZE / 8.0;
        let col = ((x - (m.x - h)) / cell).floor() as i64;
        let row = ((m.y + h - y) / cell).floor() as i64;
        if (1..=6).contains(&col) && (1..=6).contains(&row) {
            let bit = codes.get(id as usize * 36 + ((row - 1) * 6 + (col - 1)) as usize).copied().unwrap_or(0);
            return if bit == 1 { look.paper } else { look.ink };
        }
        return look.ink;
    }
    if x.abs() < SHEET_W / 2.0 && y.abs() < SHEET_H / 2.0 {
        if look.crosses {
            for t in &BOARD_TARGETS {
                let (dx, dy) = ((x - t.x).abs(), (y - t.y).abs());
                let arm = 0.0055;
                if (dx < 0.0003 && dy < arm) || (dy < 0.0003 && dx < arm) {
                    return look.ink + 30.0;
                }
                let r = dx.hypot(dy);
                if (r - 0.003).abs() < 0.00025 {
                    return look.ink + 30.0;
                }
            }
        }
        return look.paper;
    }
    // painted wall: gentle large-scale shading + fine texture
    let fine = (((x * 4000.0).floor() * 12.9898 + (y * 4000.0).floor() * 78.233).sin() * 43758.5453).fract();
    look.wall + 10.0 * (x * 23.0 + 1.3).sin() * (y * 17.0 + 0.4).sin() + 8.0 * (fine - 0.5)
}

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f64 + 0.5) / 4294967296.0
    }
    fn gauss(&mut self) -> f64 {
        let (u, v) = (self.next(), self.next());
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}

/// Distance from a ray through the origin (unit `d`) to a segment; returns (distance, segment param).
fn ray_segment(d: V3, a: V3, b: V3) -> (f64, f64) {
    let u = sub3(b, a);
    let (uu, ud, ad, au) = (dot(u, u), dot(u, d), dot(a, d), dot(a, u));
    let den = uu - ud * ud;
    let s = if den.abs() < 1e-12 { 0.0 } else { ((ad * ud - au) / den).clamp(0.0, 1.0) };
    let p = [a[0] + u[0] * s, a[1] + u[1] * s, a[2] + u[2] * s];
    let tray = dot(p, d).max(0.0);
    (len(sub3(p, scale(d, tray))), s)
}

type RayCache = Option<([f64; 7], usize, usize, usize, std::rc::Rc<Vec<V3>>)>;
thread_local! {
    static RAYS: std::cell::RefCell<RayCache> = const { std::cell::RefCell::new(None) };
}

/// Viewing rays of every sample (undistortion is the expensive part); cached per camera and size.
fn ray_table(cam: &Camera, w: usize, h: usize, ss: usize) -> std::rc::Rc<Vec<V3>> {
    let key = cam.to_array();
    RAYS.with(|c| {
        if let Some((k, cw, ch, css, r)) = &*c.borrow() {
            if *k == key && *cw == w && *ch == h && *css == ss {
                return r.clone();
            }
        }
        let mut t = Vec::with_capacity(w * h * ss * ss);
        for v in 0..h {
            for sy in 0..ss {
                for u in 0..w {
                    for sx in 0..ss {
                        let px = u as f64 + (sx as f64 + 0.5) / ss as f64;
                        let py = v as f64 + (sy as f64 + 0.5) / ss as f64;
                        t.push(cam.ray(crate::geom::P2::new(px, py)));
                    }
                }
            }
        }
        let r = std::rc::Rc::new(t);
        *c.borrow_mut() = Some((key, w, h, ss, r.clone()));
        r
    })
}

pub struct RenderSpec<'a> {
    pub camera: Camera,
    /// Camera poses during the exposure (1 = no motion blur).
    pub poses: &'a [Pose],
    pub width: usize,
    pub height: usize,
    /// Supersampling per axis (2 -> 4 samples per pixel).
    pub ss: usize,
    pub codes: &'a [u8],
    pub look: SceneLook,
    pub light: Lighting,
    pub bit: Option<Bit>,
    pub occluders: &'a [Occluder],
}

/// Render one RGBA frame into `out` (`width * height * 4`).
pub fn render(spec: &RenderSpec, out: &mut [u8]) {
    let (w, h, ss) = (spec.width, spec.height, spec.ss.max(1));
    let cam = &spec.camera;
    let n_pose = spec.poses.len().max(1);
    // per-pose camera centre and camera->world rotation
    let frames: Vec<(V3, M3)> = spec.poses.iter().map(|p| (p.to_world([0.0, 0.0, 0.0]), transpose(&p.r))).collect();
    let rays = ray_table(cam, w, h, ss);
    let mut rng = Rng(spec.light.seed.max(1));
    let inv = 1.0 / (ss * ss * n_pose) as f64;
    let diag2 = (w * w + h * h) as f64 / 4.0;
    for v in 0..h {
        for u in 0..w {
            let mut acc = 0.0;
            for sy in 0..ss {
                for sx in 0..ss {
                    let px = u as f64 + (sx as f64 + 0.5) / ss as f64;
                    let py = v as f64 + (sy as f64 + 0.5) / ss as f64;
                    if spec.occluders.iter().any(|o| (px - o.cx).hypot(py - o.cy) < o.r) {
                        acc += 70.0 * n_pose as f64;
                        continue;
                    }
                    let ray = rays[((v * ss + sy) * w + u) * ss + sx];
                    let d = normalize(ray);
                    if let Some(b) = spec.bit {
                        let tip = b.tip_cam;
                        let chuck = sub3(tip, scale(normalize(b.axis_cam), b.length));
                        let (dist, s) = ray_segment(d, chuck, tip);
                        if dist < b.radius {
                            // only the part in front of the surface is visible: check that bit point in world
                            let p = [chuck[0] + (tip[0] - chuck[0]) * s, chuck[1] + (tip[1] - chuck[1]) * s, chuck[2] + (tip[2] - chuck[2]) * s];
                            let in_front = spec.poses.first().map(|ps| ps.to_world(p)[2] > 0.0).unwrap_or(true);
                            if in_front {
                                let shade = 95.0 + 60.0 * (1.0 - dist / b.radius) + 25.0 * ((s * 40.0).sin() > 0.6) as i32 as f64;
                                acc += shade * n_pose as f64;
                                continue;
                            }
                        }
                    }
                    for (c, cw) in &frames {
                        let dw = mul_v(cw, ray);
                        let k = -c[2] / dw[2];
                        acc += if k > 0.0 && dw[2].is_finite() {
                            sheet_value(c[0] + k * dw[0], c[1] + k * dw[1], spec.codes, &spec.look)
                        } else {
                            spec.look.wall
                        };
                    }
                }
            }
            let mut val = acc * inv;
            let (nx, ny) = (u as f64 + 0.5 - w as f64 / 2.0, v as f64 + 0.5 - h as f64 / 2.0);
            let l = &spec.light;
            val *= l.gain * (1.0 - l.vignette * (nx * nx + ny * ny) / diag2) * (1.0 + l.gradient * ((u as f64 + 0.5) / w as f64 - 0.5));
            if l.noise > 0.0 {
                val += l.noise * rng.gauss();
            }
            let g = val.round().clamp(0.0, 255.0) as u8;
            let i = (v * w + u) * 4;
            out[i] = g;
            out[i + 1] = g;
            out[i + 2] = g;
            out[i + 3] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes() -> Vec<u8> {
        // a checkerboard-ish code per marker; enough to test the renderer
        (0..crate::board::MARKER_COUNT * 36).map(|i| ((i * 7 + i / 6) % 3 == 0) as u8).collect()
    }

    #[test]
    fn rig_pose_puts_the_tip_and_axis_where_asked() {
        let tip_cam = [0.0, 0.055, 0.17];
        let axis_cam = normalize([0.01, -0.02, 1.0]);
        let u = tool_rotation(3.0, -2.0, 15.0);
        let p = rig_pose(&u, [0.01, -0.02, 0.005], tip_cam, axis_cam);
        let tip = p.to_world(tip_cam);
        assert!(len(sub3(tip, [0.01, -0.02, 0.005])) < 1e-12);
        let s = crate::nav::evaluate_world(tip, p.dir_to_world(axis_cam), crate::geom::P2::new(0.0, 0.0));
        assert!((s.yaw_deg - 3.0).abs() < 0.05 && (s.pitch_deg + 2.0).abs() < 0.05, "{} {}", s.yaw_deg, s.pitch_deg);
    }

    #[test]
    fn render_shows_paper_marker_and_wall() {
        let cam = Camera::from_hfov(320.0, 240.0, 66.0);
        // camera 30 cm in front of the sheet centre, looking straight at it
        let pose = Pose { r: BASE, t: [0.0, 0.0, 0.30], rms: 0.0 };
        let c = codes();
        let spec = RenderSpec {
            camera: cam,
            poses: &[pose],
            width: 320,
            height: 240,
            ss: 1,
            codes: &c,
            look: SceneLook::default(),
            light: Lighting { noise: 0.0, vignette: 0.0, gradient: 0.0, ..Default::default() },
            bit: None,
            occluders: &[],
        };
        let mut img = vec![0u8; 320 * 240 * 4];
        render(&spec, &mut img);
        let at = |w: [f64; 3]| {
            let p = cam.project(w, &pose).unwrap();
            img[(p.y as usize * 320 + p.x as usize) * 4] as f64
        };
        assert!((at([0.0, 0.02, 0.0]) - 232.0).abs() < 1.0, "paper");
        // marker 14 (x 0.02, y 0) border (black) at its left edge, inside
        assert!(at([0.02 - 0.0105, 0.0, 0.0]) < 30.0, "marker border");
        assert!((at([0.16, 0.02, 0.0]) - 150.0).abs() < 20.0, "wall");
    }
}
