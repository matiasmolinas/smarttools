//! Gestures made with the tool itself, so a gloved hand never has to touch the phone:
//! - **double tap**: the bit tip tapped twice on the surface (short touches, within a second) = confirm;
//! - **twist**: the drill turned about its bit by more than 50° and back, within 1.2 s = next.
//!
//! Detected on measured poses (not the prediction), never while drilling.

use crate::scene::{Quat, Transform};
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gesture {
    DoubleTap,
    Twist,
}

/// Tip on the surface below this gap (mm), and lifted above this one (hysteresis).
pub const TOUCH_MM: f64 = 0.6;
pub const LIFT_MM: f64 = 1.5;
/// A tap is shorter than this (s); two taps closer than this (s, onset to onset).
pub const TAP_MAX_S: f64 = 0.45;
pub const DOUBLE_TAP_S: f64 = 1.0;
/// A twist: out by more than this (deg) and back within this (deg), inside the window (s).
pub const TWIST_OUT_DEG: f64 = 50.0;
pub const TWIST_BACK_DEG: f64 = 15.0;
pub const TWIST_WINDOW_S: f64 = 1.2;
const COOLDOWN_S: f64 = 1.0;

#[derive(Clone, Debug, Default)]
pub struct Gestures {
    touching: bool,
    touch_at: f64,
    taps: VecDeque<f64>,
    last_q: Option<Quat>,
    roll: f64,
    hist: VecDeque<(f64, f64)>,
    quiet_until: f64,
}

impl Gestures {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// One step: the tool's world pose (+Z along the bit), the tip's gap to the active hole's surface
    /// (mm, None when there is no hole) and whether gestures are allowed now (not drilling).
    pub fn step(&mut self, t: f64, tool: &Transform, gap_mm: Option<f64>, allowed: bool) -> Option<Gesture> {
        // roll about the bit: the twist part of the rotation since the last step, accumulated
        if let Some(prev) = self.last_q {
            let rel = prev.conj().mul(&tool.q.aligned_with(&prev));
            // twist about the local +Z: angle of (w, z)
            let d = 2.0 * rel.z.atan2(rel.w);
            let d = if d > std::f64::consts::PI { d - std::f64::consts::TAU } else if d < -std::f64::consts::PI { d + std::f64::consts::TAU } else { d };
            self.roll += d.to_degrees();
        }
        self.last_q = Some(tool.q);
        self.hist.push_back((t, self.roll));
        while self.hist.front().is_some_and(|(s, _)| t - s > TWIST_WINDOW_S) {
            self.hist.pop_front();
        }
        if !allowed || t < self.quiet_until {
            self.taps.clear();
            return None;
        }

        // taps
        if let Some(g) = gap_mm {
            if !self.touching && g < TOUCH_MM {
                self.touching = true;
                self.touch_at = t;
            } else if self.touching && g > LIFT_MM {
                self.touching = false;
                if t - self.touch_at <= TAP_MAX_S {
                    self.taps.push_back(self.touch_at);
                } else {
                    self.taps.clear(); // a long rest is not a tap
                }
            }
        }
        while self.taps.front().is_some_and(|s| t - s > DOUBLE_TAP_S + TAP_MAX_S) {
            self.taps.pop_front();
        }
        if self.taps.len() >= 2 && self.taps[self.taps.len() - 1] - self.taps[self.taps.len() - 2] <= DOUBLE_TAP_S {
            return Some(self.fire(t));
        }

        // twist: out and back inside the window
        if let Some(&(_, r0)) = self.hist.front() {
            let out = self.hist.iter().map(|&(_, r)| (r - r0).abs()).fold(0.0, f64::max);
            if out > TWIST_OUT_DEG && (self.roll - r0).abs() < TWIST_BACK_DEG {
                self.fire(t);
                return Some(Gesture::Twist);
            }
        }
        None
    }

    fn fire(&mut self, t: f64) -> Gesture {
        self.taps.clear();
        self.hist.clear();
        self.hist.push_back((t, self.roll));
        self.quiet_until = t + COOLDOWN_S;
        Gesture::DoubleTap
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pose(roll_deg: f64) -> Transform {
        // bit pointing down, turned about it
        let down = Quat::from_axis_angle([1.0, 0.0, 0.0], std::f64::consts::PI);
        Transform::rigid([0.0, 0.0, 0.0], down.mul(&Quat::from_axis_angle([0.0, 0.0, 1.0], roll_deg.to_radians())))
    }

    fn run(gaps: impl Fn(f64) -> f64, roll: impl Fn(f64) -> f64, dur: f64) -> Vec<(f64, Gesture)> {
        let mut g = Gestures::default();
        let mut out = Vec::new();
        let mut t = 0.0;
        while t < dur {
            if let Some(x) = g.step(t, &pose(roll(t)), Some(gaps(t)), true) {
                out.push((t, x));
            }
            t += 1.0 / 30.0;
        }
        out
    }

    #[test]
    fn two_quick_taps_confirm() {
        // taps at 1.0 and 1.5 s, 0.15 s each
        let gap = |t: f64| if (1.0..1.15).contains(&t) || (1.5..1.65).contains(&t) { 0.1 } else { 4.0 };
        let r = run(gap, |_| 0.0, 3.0);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].1, Gesture::DoubleTap);
        assert!((1.65..1.8).contains(&r[0].0), "{r:?}");
    }

    #[test]
    fn resting_on_the_mark_is_not_a_tap() {
        // a long rest, a lift, another long rest: what aligning on a mark looks like
        let gap = |t: f64| if (0.5..1.5).contains(&t) || (1.8..3.0).contains(&t) { 0.1 } else { 4.0 };
        assert!(run(gap, |_| 0.0, 3.5).is_empty());
        // taps too far apart
        let gap = |t: f64| if (0.5..0.6).contains(&t) || (2.0..2.1).contains(&t) { 0.1 } else { 4.0 };
        assert!(run(gap, |_| 0.0, 3.0).is_empty());
    }

    #[test]
    fn a_twist_out_and_back_is_next() {
        // 70° out over 0.4 s and back over 0.4 s
        let roll = |t: f64| if t < 1.0 { 0.0 } else if t < 1.4 { 70.0 * (t - 1.0) / 0.4 } else if t < 1.8 { 70.0 * (1.8 - t) / 0.4 } else { 0.0 };
        let r = run(|_| 10.0, roll, 3.0);
        assert_eq!(r.iter().map(|x| x.1).collect::<Vec<_>>(), vec![Gesture::Twist]);
    }

    #[test]
    fn turning_the_drill_to_face_the_sheet_is_not_a_twist() {
        // a slow turn that stays there (the user re-orients the camera), and small wobbles
        let roll = |t: f64| (t * 40.0).min(90.0) + 4.0 * (t * 9.0).sin();
        assert!(run(|_| 10.0, roll, 4.0).is_empty());
    }

    #[test]
    fn nothing_while_not_allowed() {
        let mut g = Gestures::default();
        let mut n = 0;
        let mut t = 0.0;
        while t < 3.0 {
            let gap = if (1.0..1.1).contains(&t) || (1.4..1.5).contains(&t) { 0.1 } else { 4.0 };
            n += g.step(t, &pose(0.0), Some(gap), false).is_some() as usize;
            t += 1.0 / 30.0;
        }
        assert_eq!(n, 0);
    }
}
