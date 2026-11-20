//! Navigation: from the camera pose and the dock calibration to what the user is told.
//!
//! - [`evaluate`]: tip, bit axis, aim point on the surface, angle and offset errors, gap, depth.
//! - [`OneEuro`]: adaptive low-pass filter (smooth when still, responsive when moving).
//! - [`Steadiness`]: jitter of the tip and the axis over a short window.
//! - [`gate`]: the deterministic go / no-go check before the user may drill.

use crate::geom::{dot, len, normalize, sub3, P2, V3};
use crate::pose::Pose;

/// Where the bit is, relative to the camera (from [`crate::calib::pivot`] and
/// [`crate::calib::axis_from_roll`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolCalib {
    pub tip_cam: V3,
    /// Unit vector from the chuck to the tip.
    pub axis_cam: V3,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavState {
    /// Bit tip, world (sheet) frame, metres. z > 0 in front of the surface, z < 0 inside it.
    pub tip: V3,
    /// Unit bit axis (chuck -> tip), world frame. Square to the surface = (0, 0, -1).
    pub axis: V3,
    /// Where the bit axis meets the surface (z = 0), world metres.
    pub aim: P2,
    pub yaw_deg: f64,
    pub pitch_deg: f64,
    /// Angle between the bit and the surface normal, degrees.
    pub angle_err_deg: f64,
    /// Distance from the aim point to the target, mm.
    pub offset_mm: f64,
    /// Tip distance in front of the surface, mm (0 once inside).
    pub gap_mm: f64,
    /// Tip depth inside the surface, mm (0 while in front).
    pub depth_mm: f64,
}

pub fn evaluate_world(tip: V3, axis: V3, target: P2) -> NavState {
    let axis = normalize(axis);
    let k = if axis[2] < -1e-6 { -tip[2] / axis[2] } else { 0.0 };
    let aim = P2::new(tip[0] + axis[0] * k, tip[1] + axis[1] * k);
    NavState {
        tip,
        axis,
        aim,
        yaw_deg: axis[0].atan2(-axis[2]).to_degrees(),
        pitch_deg: axis[1].atan2(-axis[2]).to_degrees(),
        angle_err_deg: (-axis[2]).clamp(-1.0, 1.0).acos().to_degrees(),
        offset_mm: (aim.x - target.x).hypot(aim.y - target.y) * 1000.0,
        gap_mm: (tip[2] * 1000.0).max(0.0),
        depth_mm: (-tip[2] * 1000.0).max(0.0),
    }
}

/// Navigation state for one camera pose.
pub fn evaluate(pose: &Pose, tool: &ToolCalib, target: P2) -> NavState {
    evaluate_world(pose.to_world(tool.tip_cam), pose.dir_to_world(tool.axis_cam), target)
}

/// One Euro filter (Casiez et al. 2012) for one channel.
#[derive(Clone, Copy, Debug)]
pub struct OneEuro {
    pub min_cutoff: f64,
    pub beta: f64,
    pub d_cutoff: f64,
    state: Option<(f64, f64, f64)>, // (t, x, dx)
}

fn alpha(cutoff: f64, dt: f64) -> f64 {
    let tau = 1.0 / (std::f64::consts::TAU * cutoff);
    1.0 / (1.0 + tau / dt)
}

impl OneEuro {
    pub fn new(min_cutoff: f64, beta: f64, d_cutoff: f64) -> Self {
        Self { min_cutoff, beta, d_cutoff, state: None }
    }
    pub fn reset(&mut self) {
        self.state = None;
    }
    pub fn filter(&mut self, t: f64, x: f64) -> f64 {
        let Some((tp, xp, dxp)) = self.state else {
            self.state = Some((t, x, 0.0));
            return x;
        };
        let dt = t - tp;
        if dt <= 0.0 {
            return xp;
        }
        let dx = (x - xp) / dt;
        let edx = dxp + alpha(self.d_cutoff, dt) * (dx - dxp);
        let cutoff = self.min_cutoff + self.beta * edx.abs();
        let ex = xp + alpha(cutoff, dt) * (x - xp);
        self.state = Some((t, ex, edx));
        ex
    }
}

/// One Euro filter for the tip (metres) and the axis (unit vector, renormalised).
#[derive(Clone, Copy, Debug)]
pub struct PoseFilter {
    tip: [OneEuro; 3],
    axis: [OneEuro; 3],
}

impl PoseFilter {
    /// Defaults tuned in the scene simulator (scripts/scene-test.mts): tip in metres, axis in
    /// unit-vector components. A high beta keeps the lag below 0.2 mm at drilling speeds while
    /// the 2 Hz floor still steadies the display when the tool is still.
    pub fn new() -> Self {
        Self { tip: [OneEuro::new(2.0, 3000.0, 1.0); 3], axis: [OneEuro::new(2.0, 300.0, 1.0); 3] }
    }
    pub fn with(tip: OneEuro, axis: OneEuro) -> Self {
        Self { tip: [tip; 3], axis: [axis; 3] }
    }
    pub fn reset(&mut self) {
        self.tip.iter_mut().chain(self.axis.iter_mut()).for_each(|f| f.reset());
    }
    pub fn filter(&mut self, t: f64, tip: V3, axis: V3) -> (V3, V3) {
        let ft = [self.tip[0].filter(t, tip[0]), self.tip[1].filter(t, tip[1]), self.tip[2].filter(t, tip[2])];
        let fa = [self.axis[0].filter(t, axis[0]), self.axis[1].filter(t, axis[1]), self.axis[2].filter(t, axis[2])];
        (ft, normalize(fa))
    }
}

impl Default for PoseFilter {
    fn default() -> Self {
        Self::new()
    }
}

/// Jitter over the last `window` seconds: RMS distance of the tip from its mean (mm) and RMS angle
/// of the axis from its mean (degrees).
#[derive(Clone, Debug)]
pub struct Steadiness {
    pub window: f64,
    buf: std::collections::VecDeque<(f64, V3, V3)>,
}

impl Steadiness {
    pub fn new(window: f64) -> Self {
        Self { window, buf: Default::default() }
    }
    pub fn reset(&mut self) {
        self.buf.clear();
    }
    pub fn push(&mut self, t: f64, tip: V3, axis: V3) {
        self.buf.push_back((t, tip, axis));
        while let Some(&(t0, _, _)) = self.buf.front() {
            if t - t0 > self.window {
                self.buf.pop_front();
            } else {
                break;
            }
        }
    }
    /// Seconds covered by the buffer.
    pub fn span(&self) -> f64 {
        match (self.buf.front(), self.buf.back()) {
            (Some(a), Some(b)) => b.0 - a.0,
            _ => 0.0,
        }
    }
    /// (tip jitter mm, axis jitter degrees)
    pub fn jitter(&self) -> (f64, f64) {
        let n = self.buf.len();
        if n < 2 {
            return (f64::INFINITY, f64::INFINITY);
        }
        let nf = n as f64;
        let mut mt = [0.0; 3];
        let mut ma = [0.0; 3];
        for (_, t, a) in &self.buf {
            for i in 0..3 {
                mt[i] += t[i] / nf;
                ma[i] += a[i] / nf;
            }
        }
        let ma = normalize(ma);
        let mut et = 0.0;
        let mut ea = 0.0;
        for (_, t, a) in &self.buf {
            et += len(sub3(*t, mt)).powi(2);
            ea += dot(normalize(*a), ma).clamp(-1.0, 1.0).acos().to_degrees().powi(2);
        }
        ((et / nf).sqrt() * 1000.0, (ea / nf).sqrt())
    }
}

/// Reasons the gate says "not yet". 0 = ready.
pub mod reason {
    pub const NOT_CALIBRATED: u32 = 1;
    pub const STALE: u32 = 2;
    pub const POOR_FIT: u32 = 4;
    pub const FEW_MARKERS: u32 = 8;
    pub const TILTED: u32 = 16;
    pub const OFF_TARGET: u32 = 32;
    pub const UNSTEADY: u32 = 64;
    /** the target's part has not been located (registered) yet */
    pub const NOT_LOCATED: u32 = 128;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GateLimits {
    pub max_angle_deg: f64,
    pub max_offset_mm: f64,
    pub max_rms_px: f64,
    pub min_markers: u32,
    pub max_pose_age_s: f64,
    pub max_jitter_mm: f64,
    pub max_jitter_deg: f64,
}

impl Default for GateLimits {
    fn default() -> Self {
        Self {
            max_angle_deg: 0.5,
            max_offset_mm: 1.0,
            max_rms_px: 1.5,
            min_markers: 2,
            max_pose_age_s: 0.15,
            max_jitter_mm: 0.4,
            max_jitter_deg: 0.25,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GateInput {
    pub calibrated: bool,
    /// the active target's part is located (registered); true for fixed targets
    pub located: bool,
    pub pose_age_s: f64,
    pub rms_px: f64,
    pub markers: u32,
    pub angle_err_deg: f64,
    pub offset_mm: f64,
    pub jitter_mm: f64,
    pub jitter_deg: f64,
}

/// Go / no-go before drilling. Pure function: the same input always gives the same answer.
/// Comparisons are written so that NaN always fails (never "ready" on a broken number).
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn gate(i: &GateInput, l: &GateLimits) -> u32 {
    use reason::*;
    let mut r = 0;
    if !i.calibrated {
        r |= NOT_CALIBRATED;
    }
    if !i.located {
        r |= NOT_LOCATED;
    }
    if !(i.pose_age_s <= l.max_pose_age_s) {
        r |= STALE;
    }
    if !(i.rms_px <= l.max_rms_px) {
        r |= POOR_FIT;
    }
    if i.markers < l.min_markers {
        r |= FEW_MARKERS;
    }
    if !(i.angle_err_deg < l.max_angle_deg) {
        r |= TILTED;
    }
    if !(i.offset_mm < l.max_offset_mm) {
        r |= OFF_TARGET;
    }
    if !(i.jitter_mm <= l.max_jitter_mm && i.jitter_deg <= l.max_jitter_deg) {
        r |= UNSTEADY;
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_on_target() {
        let s = evaluate_world([0.001, 0.0, 0.02], [0.0, 0.0, -1.0], P2::new(0.0, 0.0));
        assert!((s.offset_mm - 1.0).abs() < 1e-9);
        assert!(s.angle_err_deg.abs() < 1e-9 && (s.gap_mm - 20.0).abs() < 1e-9 && s.depth_mm == 0.0);
    }

    #[test]
    fn tilted_bit_aims_off() {
        // 1° pitch, 50 mm from the surface: aim moves ~0.87 mm
        let a = 1f64.to_radians();
        let s = evaluate_world([0.0, 0.0, 0.05], [0.0, a.sin(), -a.cos()], P2::new(0.0, 0.0));
        assert!((s.angle_err_deg - 1.0).abs() < 1e-9 && (s.pitch_deg - 1.0).abs() < 1e-9);
        assert!((s.offset_mm - 50.0 * a.tan()).abs() < 1e-9);
    }

    #[test]
    fn one_euro_smooths_noise_and_follows_motion() {
        let mut f = OneEuro::new(1.0, 0.5, 1.0);
        let mut worst_still: f64 = 0.0;
        for i in 0..120 {
            let t = i as f64 / 60.0;
            let noisy = if i % 2 == 0 { 0.001 } else { -0.001 };
            if i > 30 {
                worst_still = worst_still.max(f.filter(t, noisy).abs());
            } else {
                f.filter(t, noisy);
            }
        }
        assert!(worst_still < 0.0002, "still noise {worst_still}");
        // a ramp is followed
        let mut last = 0.0;
        for i in 0..120 {
            last = f.filter(2.0 + i as f64 / 60.0, i as f64 * 0.01);
        }
        assert!((last - 1.19).abs() < 0.05, "ramp {last}");
    }

    #[test]
    fn steadiness_measures_jitter() {
        let mut s = Steadiness::new(0.3);
        for i in 0..60 {
            let d = if i % 2 == 0 { 0.0005 } else { -0.0005 };
            s.push(i as f64 / 60.0, [d, 0.0, 0.0], [0.0, 0.0, -1.0]);
        }
        let (mm, deg) = s.jitter();
        assert!((mm - 0.5).abs() < 0.01 && deg < 1e-6, "{mm} {deg}");
        assert!(s.span() <= 0.3 + 1e-9);
    }

    #[test]
    fn gate_reasons() {
        use reason::*;
        let ok = GateInput { calibrated: true, located: true, pose_age_s: 0.03, rms_px: 0.4, markers: 4, angle_err_deg: 0.2, offset_mm: 0.4, jitter_mm: 0.1, jitter_deg: 0.05 };
        let l = GateLimits::default();
        assert_eq!(gate(&ok, &l), 0);
        assert_eq!(gate(&GateInput { angle_err_deg: 0.5, ..ok }, &l), TILTED);
        assert_eq!(gate(&GateInput { offset_mm: f64::NAN, calibrated: false, ..ok }, &l), OFF_TARGET | NOT_CALIBRATED);
        assert_eq!(gate(&GateInput { pose_age_s: 1.0, markers: 1, rms_px: 3.0, jitter_mm: f64::INFINITY, ..ok }, &l), STALE | FEW_MARKERS | POOR_FIT | UNSTEADY);
        assert_eq!(gate(&GateInput { located: false, ..ok }, &l), NOT_LOCATED);
    }
}
