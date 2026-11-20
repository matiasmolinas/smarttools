//! The navigation engine (docs/ENGINE_SPEC.md §6–§10).
//!
//! A fixed-rate logical clock. Every tick:
//! 1. ingest timestamped measurements (relations `T_from_to` seen by a tracker), in capture order;
//! 2. filter each tracked node and predict it to the tick time;
//! 3. recompute every world transform (scene graph);
//! 4. navigate: the tool expressed in every target's frame;
//! 5. checks: measurement age, calibration, steadiness, the go / no-go gate, the lock timer, the
//!    phase machine and safety alarms, producing events;
//! 6. publish a snapshot.
//!
//! Rendering is not part of the engine: renderers read snapshots whenever they can.
//! Time is logical (`t0 + k / tick_hz`), so the same inputs always give the same outputs.

use crate::nav::{gate, GateInput, GateLimits, OneEuro, Steadiness};
use crate::scene::{NodeId, NodeKind, Quat, SceneGraph, Status, Transform};
use std::collections::VecDeque;

type V3 = [f64; 3];

/// A relation observed by a tracker: `T_from_to` at `t_capture`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Measurement {
    pub from: NodeId,
    pub to: NodeId,
    pub transform: Transform,
    pub t_capture: f64,
    pub markers: u32,
    pub rms_px: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EngineConfig {
    pub tick_hz: f64,
    /// Ticks run per `advance_to` call before the backlog is dropped (overrun).
    pub max_catchup: u32,
    /// Prediction horizon cap, seconds.
    pub predict_max_s: f64,
    pub predict: bool,
    /// Status thresholds by measurement age, seconds.
    pub stale_after_s: f64,
    pub lost_after_s: f64,
    /// Out-of-order measurements up to this age are merged by replaying the filter.
    pub history_s: f64,
    /// The gate must hold this long before "ready".
    pub lock_time_s: f64,
    pub steady_window_s: f64,
    pub depth_target_mm: f64,
    /// Engagement: the active target is kept while the tip is within these of it.
    pub engage_gap_mm: f64,
    pub engage_offset_mm: f64,
    /// The requirement promised to the user (alarms); the gate uses `limits` (stricter).
    pub requirement_angle_deg: f64,
    pub limits: GateLimits,
    /// One Euro on position (m) and on quaternion components.
    pub pos_min_cutoff: f64,
    pub pos_beta: f64,
    pub rot_min_cutoff: f64,
    pub rot_beta: f64,
    pub d_cutoff: f64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            tick_hz: 120.0,
            max_catchup: 4,
            // covers one frame interval plus latency at 10-15 fps
            predict_max_s: 0.12,
            predict: true,
            // a phone may detect at 10-15 fps with 30-80 ms of latency: data up to 250 ms old is
            // still usable (steadiness guarantees the tool is still when the gate opens)
            stale_after_s: 0.25,
            lost_after_s: 0.6,
            history_s: 0.25,
            lock_time_s: 0.4,
            steady_window_s: 0.5,
            depth_target_mm: 35.0,
            engage_gap_mm: 3.0,
            engage_offset_mm: 6.0,
            requirement_angle_deg: 0.5,
            limits: GateLimits { max_angle_deg: 0.4, max_offset_mm: 0.75, max_pose_age_s: 0.25, ..GateLimits::default() },
            pos_min_cutoff: 2.0,
            pos_beta: 3000.0,
            rot_min_cutoff: 2.0,
            rot_beta: 300.0,
            d_cutoff: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    Approach = 0,
    Align = 1,
    Drill = 2,
    Hold = 3,
    Retract = 4,
}

/// Safety alarms (bits).
pub mod alarm {
    /// Depth reached: stop.
    pub const DEPTH: u32 = 1;
    /// Bit tilted beyond the requirement while drilling.
    pub const ANGLE: u32 = 2;
    /// Tracking stale or lost while drilling.
    pub const LOST: u32 = 4;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum EventKind {
    TargetChanged = 1,
    Ready = 2,
    NotReady = 3,
    DepthReached = 4,
    Drilled = 5,
    Lost = 6,
    Found = 7,
    AngleAlarm = 8,
    Overrun = 9,
    JobReset = 10,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    pub tick: u64,
    pub t: f64,
    pub kind: EventKind,
    pub node: NodeId,
    pub value: f64,
}

/// The tool in a target's frame (target +Z = planned drilling direction into the material).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TargetNav {
    pub target: NodeId,
    /// Tip and unit bit axis in the target frame.
    pub tip: V3,
    pub axis: V3,
    /// Where the bit axis meets the target plane (z = 0), target frame, metres.
    pub aim: [f64; 2],
    pub yaw_deg: f64,
    pub pitch_deg: f64,
    pub angle_err_deg: f64,
    pub offset_mm: f64,
    pub gap_mm: f64,
    pub depth_mm: f64,
}

/// Distance of the tip from the hole's axis, mm.
fn lateral_mm(n: &TargetNav) -> f64 {
    n.tip[0].hypot(n.tip[1]) * 1000.0
}

pub fn target_nav(target: NodeId, t: &Transform) -> TargetNav {
    let tip = t.p;
    let axis = t.q.rotate([0.0, 0.0, 1.0]);
    let (aim, offset) = if axis[2] > 1e-6 {
        let s = -tip[2] / axis[2];
        let a = [tip[0] + axis[0] * s, tip[1] + axis[1] * s];
        (a, a[0].hypot(a[1]) * 1000.0)
    } else {
        ([tip[0], tip[1]], f64::INFINITY)
    };
    TargetNav {
        target,
        tip,
        axis,
        aim,
        yaw_deg: axis[0].atan2(axis[2]).to_degrees(),
        pitch_deg: axis[1].atan2(axis[2]).to_degrees(),
        angle_err_deg: axis[2].clamp(-1.0, 1.0).acos().to_degrees(),
        offset_mm: offset,
        gap_mm: (-tip[2] * 1000.0).max(0.0),
        depth_mm: (tip[2] * 1000.0).max(0.0),
    }
}

#[derive(Clone, Copy, Debug)]
struct TrackFilter {
    pos: [OneEuro; 3],
    rot: [OneEuro; 4],
    last_q: Option<Quat>,
}

impl TrackFilter {
    fn new(c: &EngineConfig) -> Self {
        Self {
            pos: [OneEuro::new(c.pos_min_cutoff, c.pos_beta, c.d_cutoff); 3],
            rot: [OneEuro::new(c.rot_min_cutoff, c.rot_beta, c.d_cutoff); 4],
            last_q: None,
        }
    }
    fn step(&mut self, t: f64, x: &Transform) -> Transform {
        let q = match self.last_q {
            Some(r) => x.q.aligned_with(&r),
            None => x.q,
        };
        let p = [self.pos[0].filter(t, x.p[0]), self.pos[1].filter(t, x.p[1]), self.pos[2].filter(t, x.p[2])];
        let fq = Quat::new(self.rot[0].filter(t, q.w), self.rot[1].filter(t, q.x), self.rot[2].filter(t, q.y), self.rot[3].filter(t, q.z)).normalize();
        self.last_q = Some(fq);
        Transform::rigid(p, fq)
    }
}

#[derive(Clone, Copy, Debug)]
struct Hist {
    m: Measurement,
    /// the measurement as a local transform of the tracked node (before filtering)
    raw: Transform,
    /// filter state after applying this measurement, and its output (local frame)
    filt: TrackFilter,
    out: Transform,
}

#[derive(Clone, Debug)]
struct Track {
    node: NodeId,
    filt: TrackFilter,
    hist: VecDeque<Hist>,
    last_seen: f64,
    markers: u32,
    rms: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stats {
    pub ticks: u64,
    pub overruns: u64,
    pub measurements: u64,
    pub late_merged: u64,
    pub late_dropped: u64,
    /// tick time minus capture time of the latest measurement, at ingestion (s)
    pub latency_s: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NodeState {
    pub id: NodeId,
    pub world: Transform,
    pub status: Status,
    pub age: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub tick: u64,
    pub t: f64,
    pub nodes: Vec<NodeState>,
    /// navigation against every target (same order as `targets`)
    pub targets: Vec<TargetNav>,
    pub drilled: Vec<bool>,
    pub active: Option<usize>,
    pub phase: Phase,
    pub gate: u32,
    pub ready: bool,
    pub locking: bool,
    pub alarms: u32,
    pub jitter_mm: f64,
    pub jitter_deg: f64,
    pub markers: u32,
    pub rms_px: f64,
    pub pose_age_s: f64,
    pub events: Vec<Event>,
    pub stats: Stats,
}

pub struct Engine {
    pub graph: SceneGraph,
    pub config: EngineConfig,
    t0: f64,
    k: u64,
    queue: Vec<Measurement>,
    tracks: Vec<Track>,
    tool: Option<NodeId>,
    targets: Vec<NodeId>,
    /// depth to reach per target (mm); defaults to config.depth_target_mm
    depths: Vec<f64>,
    drilled: Vec<bool>,
    calibrated: Vec<(NodeId, bool)>,
    active: Option<usize>,
    phase: Phase,
    done_at: Option<f64>,
    ready_since: Option<f64>,
    was_ready: bool,
    was_lost: bool,
    alarms: u32,
    steady: Steadiness,
    events: Vec<Event>,
    stats: Stats,
    snap: Snapshot,
}

impl Engine {
    pub fn new(graph: SceneGraph, config: EngineConfig) -> Self {
        let steady = Steadiness::new(config.steady_window_s);
        Self {
            graph,
            config,
            t0: 0.0,
            k: 0,
            queue: Vec::new(),
            tracks: Vec::new(),
            tool: None,
            targets: Vec::new(),
            depths: Vec::new(),
            drilled: Vec::new(),
            calibrated: Vec::new(),
            active: None,
            phase: Phase::Approach,
            done_at: None,
            ready_since: None,
            was_ready: false,
            was_lost: true,
            alarms: 0,
            steady,
            events: Vec::new(),
            stats: Stats::default(),
            snap: Snapshot {
                tick: 0,
                t: 0.0,
                nodes: Vec::new(),
                targets: Vec::new(),
                drilled: Vec::new(),
                active: None,
                phase: Phase::Approach,
                gate: u32::MAX,
                ready: false,
                locking: false,
                alarms: 0,
                jitter_mm: f64::INFINITY,
                jitter_deg: f64::INFINITY,
                markers: 0,
                rms_px: f64::INFINITY,
                pose_age_s: f64::INFINITY,
                events: Vec::new(),
                stats: Stats::default(),
            },
        }
    }

    // ---------------- configuration ----------------

    /// Start the clock: tick k happens at `t0 + k / tick_hz`.
    pub fn start(&mut self, t0: f64) {
        self.t0 = t0;
        self.k = 0;
    }
    pub fn now(&self) -> f64 {
        self.t0 + self.k as f64 / self.config.tick_hz
    }
    /// Replace the configuration (before `start`; resets steadiness).
    pub fn configure(&mut self, c: EngineConfig) {
        self.config = c;
        self.steady = Steadiness::new(c.steady_window_s);
    }
    pub fn set_tool(&mut self, tool: NodeId) {
        self.tool = Some(tool);
    }
    pub fn set_targets(&mut self, targets: &[NodeId]) {
        self.targets = targets.to_vec();
        self.depths = vec![self.config.depth_target_mm; targets.len()];
        self.drilled = vec![false; targets.len()];
        self.active = None;
    }
    /// Depth to reach for each target, mm (a screw seats at its own depth). Missing entries keep the
    /// configured default.
    pub fn set_target_depths(&mut self, depths: &[f64]) {
        for (i, d) in depths.iter().enumerate().take(self.depths.len()) {
            self.depths[i] = *d;
        }
    }

    /// Mark a calibrated node as calibrated or not (the gate requires every calibrated node on
    /// the tool's chain to be calibrated).
    pub fn set_calibrated(&mut self, node: NodeId, ok: bool) {
        self.calibrated.retain(|(n, _)| *n != node);
        self.calibrated.push((node, ok));
        let st = if ok { Status::Static } else { Status::Uncalibrated };
        self.graph.set_status(node, st, self.now());
    }
    pub fn reset_job(&mut self) {
        self.drilled = vec![false; self.targets.len()];
        self.done_at = None;
        self.active = None;
        self.push_event(EventKind::JobReset, crate::scene::ROOT, 0.0);
    }

    /// Queue a measurement (applied at the first tick at or after its capture time).
    pub fn push(&mut self, m: Measurement) {
        self.queue.push(m);
    }

    // ---------------- clock ----------------

    /// Run every tick due up to `t_wall`, at most `max_catchup`; drop the rest of a backlog.
    pub fn advance_to(&mut self, t_wall: f64) -> u32 {
        let mut n = 0;
        while self.now() <= t_wall + 1e-12 {
            if n >= self.config.max_catchup {
                let behind = ((t_wall - self.now()) * self.config.tick_hz).floor() as u64 + 1;
                self.k += behind;
                self.stats.overruns += 1;
                self.push_event(EventKind::Overrun, crate::scene::ROOT, behind as f64);
                break;
            }
            self.tick();
            n += 1;
        }
        self.snap.stats = self.stats;
        self.snap.events = self.events.clone();
        n
    }

    /// One engine cycle at the current logical time.
    pub fn tick(&mut self) {
        let t = self.now();
        self.ingest(t);
        self.predict(t);
        self.graph.update();
        self.navigate_and_check(t);
        self.stats.ticks += 1;
        self.k += 1;
    }

    /// The latest snapshot; events accumulate until [`Engine::take_events`].
    pub fn snapshot(&self) -> &Snapshot {
        &self.snap
    }
    pub fn take_events(&mut self) -> Vec<Event> {
        self.snap.events.clear();
        std::mem::take(&mut self.events)
    }

    fn push_event(&mut self, kind: EventKind, node: NodeId, value: f64) {
        let ev = Event { tick: self.k, t: self.now(), kind, node, value };
        self.events.push(ev);
        if self.events.len() > 256 {
            self.events.remove(0);
        }
    }

    // ---------------- 1-2: measurements, filter, prediction ----------------

    fn track_index(&mut self, node: NodeId) -> usize {
        if let Some(i) = self.tracks.iter().position(|t| t.node == node) {
            return i;
        }
        self.tracks.push(Track { node, filt: TrackFilter::new(&self.config), hist: VecDeque::new(), last_seen: f64::NEG_INFINITY, markers: 0, rms: f64::INFINITY });
        self.tracks.len() - 1
    }

    /// Local transform of the tracked node implied by a measurement (other nodes as they are now).
    fn local_from(&self, m: &Measurement) -> Option<(NodeId, Transform)> {
        let kind = |id| self.graph.node(id).map(|n| n.kind);
        let (node, world) = if kind(m.from) == Some(NodeKind::Tracked) {
            // T_from_to: from = tracked → world(from) = world(to) · T_from_to⁻¹
            (m.from, self.graph.world(m.to)?.compose(&m.transform.inverse()))
        } else if kind(m.to) == Some(NodeKind::Tracked) {
            (m.to, self.graph.world(m.from)?.compose(&m.transform))
        } else {
            return None;
        };
        Some((node, self.graph.local_for_world(node, &world)?))
    }

    fn ingest(&mut self, t: f64) {
        if self.queue.is_empty() {
            return;
        }
        let mut due: Vec<Measurement> = Vec::new();
        self.queue.retain(|m| {
            if m.t_capture <= t + 1e-12 {
                due.push(*m);
                false
            } else {
                true
            }
        });
        due.sort_by(|a, b| a.t_capture.total_cmp(&b.t_capture));
        for m in due {
            let Some((node, local)) = self.local_from(&m) else { continue };
            let ti = self.track_index(node);
            let hist_s = self.config.history_s;
            let cfg = self.config;
            let tr = &mut self.tracks[ti];
            self.stats.measurements += 1;
            if m.t_capture >= tr.last_seen {
                let out = tr.filt.step(m.t_capture, &local);
                tr.hist.push_back(Hist { m, raw: local, filt: tr.filt, out });
                tr.last_seen = m.t_capture;
                tr.markers = m.markers;
                tr.rms = m.rms_px;
                self.stats.latency_s = t - m.t_capture;
            } else if tr.last_seen - m.t_capture <= hist_s {
                // late: insert and replay the filter from just before it
                let i = tr.hist.iter().position(|h| h.m.t_capture > m.t_capture).unwrap_or(tr.hist.len());
                let mut f = if i == 0 { TrackFilter::new(&cfg) } else { tr.hist[i - 1].filt };
                let mut rest: Vec<Hist> = tr.hist.drain(i..).collect();
                rest.insert(0, Hist { m, raw: local, filt: f, out: local });
                for h in rest.iter_mut() {
                    h.out = f.step(h.m.t_capture, &h.raw);
                    h.filt = f;
                }
                tr.hist.extend(rest);
                tr.filt = f;
                self.stats.late_merged += 1;
            } else {
                self.stats.late_dropped += 1;
                continue;
            }
            // trim history
            let last = tr.last_seen;
            while tr.hist.front().is_some_and(|h| last - h.m.t_capture > hist_s) {
                tr.hist.pop_front();
            }
            // steadiness on the raw tool pose at capture time
            if let Some(tool) = self.tool {
                if let (Some(pw), Some(rel)) = (self.graph.node(node).and_then(|n| n.parent).and_then(|p| self.graph.world(p)), self.graph.relative(node, tool)) {
                    let tool_w = pw.compose(&local).compose(&rel);
                    self.steady.push(m.t_capture, tool_w.p, tool_w.q.rotate([0.0, 0.0, 1.0]));
                }
            }
        }
    }

    fn predict(&mut self, t: f64) {
        let cfg = self.config;
        let dt_tick = 1.0 / cfg.tick_hz;
        for tr in &self.tracks {
            let Some(last) = tr.hist.back() else { continue };
            let age = t - last.m.t_capture;
            let mut local = last.out;
            if cfg.predict && tr.hist.len() >= 2 {
                let prev = tr.hist[tr.hist.len() - 2];
                let dt = last.m.t_capture - prev.m.t_capture;
                if dt > 1e-6 {
                    let h = age.clamp(0.0, cfg.predict_max_s);
                    let v = [(last.out.p[0] - prev.out.p[0]) / dt, (last.out.p[1] - prev.out.p[1]) / dt, (last.out.p[2] - prev.out.p[2]) / dt];
                    let dq = last.out.q.mul(&prev.out.q.aligned_with(&last.out.q).conj());
                    let w = dq.to_rotvec();
                    let step = Quat::from_rotvec([w[0] / dt * h, w[1] / dt * h, w[2] / dt * h]);
                    local = Transform::rigid([local.p[0] + v[0] * h, local.p[1] + v[1] * h, local.p[2] + v[2] * h], step.mul(&local.q));
                }
            }
            let status = if age <= dt_tick + 1e-9 {
                Status::Valid
            } else if age <= cfg.stale_after_s {
                Status::Predicted
            } else if age <= cfg.lost_after_s {
                Status::Stale
            } else {
                Status::Lost
            };
            let _ = self.graph.set_local(tr.node, local);
            self.graph.set_status(tr.node, status, last.m.t_capture);
        }
    }

    // ---------------- 4-5: navigation and checks ----------------

    /// Every calibrated node from `n` up to the root has been calibrated (a tool's dock, or a part's
    /// registration for a target on that part).
    fn chain_calibrated(&self, mut n: NodeId) -> bool {
        loop {
            let Some(node) = self.graph.node(n) else { return false };
            if node.kind == NodeKind::Calibrated && !self.calibrated.iter().any(|(id, ok)| *id == n && *ok) {
                return false;
            }
            match node.parent {
                Some(p) => n = p,
                None => return true,
            }
        }
    }

    fn tool_calibrated(&self) -> bool {
        let Some(mut n) = self.tool else { return false };
        loop {
            let Some(node) = self.graph.node(n) else { return false };
            if node.kind == NodeKind::Calibrated && !self.calibrated.iter().any(|(id, ok)| *id == n && *ok) {
                return false;
            }
            match node.parent {
                Some(p) => n = p,
                None => return true,
            }
        }
    }

    /// The tracked node the tool hangs from, and its last measurement.
    fn tool_track(&self) -> Option<&Track> {
        let mut n = self.tool?;
        loop {
            if let Some(tr) = self.tracks.iter().find(|t| t.node == n) {
                return Some(tr);
            }
            n = self.graph.node(n)?.parent?;
        }
    }

    /// The tool's world pose from the last measurement (filtered, not extrapolated).
    fn measured_tool_world(&self) -> Option<Transform> {
        let tool = self.tool?;
        let tr = self.tool_track()?;
        let last = tr.hist.back()?;
        let parent = self.graph.node(tr.node)?.parent.and_then(|p| self.graph.world(p)).unwrap_or(Transform::IDENTITY);
        let rel = self.graph.relative(tr.node, tool)?;
        Some(parent.compose(&last.out).compose(&rel))
    }

    fn navigate_and_check(&mut self, t: f64) {
        let cfg = self.config;
        let (pose_age, markers, rms) = match self.tool_track() {
            Some(tr) if tr.last_seen.is_finite() => (t - tr.last_seen, tr.markers, tr.rms),
            _ => (f64::INFINITY, 0, f64::INFINITY),
        };
        let lost = pose_age > cfg.stale_after_s;
        if lost != self.was_lost {
            self.was_lost = lost;
            self.push_event(if lost { EventKind::Lost } else { EventKind::Found }, self.tool.unwrap_or(0), pose_age);
            if lost {
                self.steady.reset();
            }
        }
        // two views of the tool: predicted to now (for display) and as last measured (for decisions).
        // Prediction compensates latency on screen, but when the tool stops against a part it overshoots
        // for a fraction of a second: phases, the gate, depth events and alarms use measured data only.
        let display: Vec<TargetNav> = match self.tool {
            Some(tool) if pose_age.is_finite() => self.targets.iter().filter_map(|&tg| self.graph.relative(tg, tool).map(|rel| target_nav(tg, &rel))).collect(),
            _ => Vec::new(),
        };
        let navs: Vec<TargetNav> = match (self.tool, self.measured_tool_world()) {
            (Some(_), Some(tool_w)) if pose_age.is_finite() => self
                .targets
                .iter()
                .filter_map(|&tg| self.graph.world(tg).map(|w| target_nav(tg, &w.inverse().compose(&tool_w))))
                .collect(),
            _ => display.clone(),
        };

        // active target: nearest not yet drilled while not engaged; sticky once engaged
        if navs.len() == self.targets.len() && !navs.is_empty() {
            let engaged = self.active.is_some_and(|i| {
                let n = &navs[i];
                (n.depth_mm > 0.3 && lateral_mm(n) < cfg.engage_offset_mm && self.chain_calibrated(self.targets[i]))
                    || (n.gap_mm < cfg.engage_gap_mm && n.offset_mm < cfg.engage_offset_mm)
            });
            let cooling = self.done_at.is_some_and(|d| t - d < 0.5);
            if !engaged && !cooling {
                if self.drilled.iter().all(|&d| d) {
                    self.drilled.iter_mut().for_each(|d| *d = false);
                    self.push_event(EventKind::JobReset, crate::scene::ROOT, 0.0);
                }
                // prefer marks on parts already located (registered); fall back to any mark
                let open: Vec<usize> = (0..navs.len()).filter(|&i| !self.drilled[i]).collect();
                let located: Vec<usize> = open.iter().copied().filter(|&i| self.chain_calibrated(self.targets[i])).collect();
                let pool = if located.is_empty() { open } else { located };
                let best = pool.into_iter().min_by(|&a, &b| navs[a].offset_mm.total_cmp(&navs[b].offset_mm));
                if best != self.active {
                    self.active = best;
                    if let Some(i) = best {
                        self.push_event(EventKind::TargetChanged, self.targets[i], i as f64);
                    }
                }
            }
        }
        let nav = self.active.and_then(|i| navs.get(i).copied());
        let located = self.active.is_none_or(|i| self.chain_calibrated(self.targets[i]));

        // phase
        let mut phase = Phase::Approach;
        if let Some(n) = nav {
            let i = self.active.unwrap_or(0);
            let depth_target = self.depths.get(i).copied().unwrap_or(cfg.depth_target_mm);
            // depth only counts inside the hole: in 3D the tip can be "below" a far-away hole's plane
            // ... and only on a located part: a hole on a part that has not been registered is not real yet
            let in_hole = lateral_mm(&n) < cfg.engage_offset_mm && located;
            if in_hole && n.depth_mm >= depth_target - 0.2 {
                phase = Phase::Hold;
                if !self.drilled[i] {
                    self.drilled[i] = true;
                    self.push_event(EventKind::DepthReached, self.targets[i], n.depth_mm);
                }
                self.done_at = Some(t);
            } else if in_hole && n.depth_mm > 0.3 {
                phase = Phase::Drill;
            } else if self.done_at.is_some_and(|d| t - d < 1.5) {
                phase = Phase::Retract;
            } else if n.gap_mm > 0.8 || n.offset_mm > 1.0 {
                phase = Phase::Approach;
            } else {
                phase = Phase::Align;
            }
            if self.phase == Phase::Hold && phase != Phase::Hold {
                self.push_event(EventKind::Drilled, self.targets[i], n.depth_mm);
            }
        }
        self.phase = phase;

        // gate + lock
        let (jm, jd) = if self.steady.span() > 0.3 { self.steady.jitter() } else { (f64::INFINITY, f64::INFINITY) };
        let g = gate(
            &GateInput {
                calibrated: self.tool_calibrated(),
                // the active target's part must be located (registered) before driving into it
                located,
                pose_age_s: pose_age,
                rms_px: rms,
                markers,
                angle_err_deg: nav.map_or(f64::INFINITY, |n| n.angle_err_deg),
                offset_mm: nav.map_or(f64::INFINITY, |n| n.offset_mm),
                jitter_mm: jm,
                jitter_deg: jd,
            },
            &cfg.limits,
        );
        let candidate = g == 0 && matches!(phase, Phase::Approach | Phase::Align) && nav.is_some_and(|n| n.gap_mm < 0.8);
        if candidate {
            self.ready_since.get_or_insert(t);
        } else {
            self.ready_since = None;
        }
        let ready = self.ready_since.is_some_and(|s| t - s >= cfg.lock_time_s - 1e-9);
        let locking = candidate && !ready;
        if ready != self.was_ready {
            self.was_ready = ready;
            self.push_event(if ready { EventKind::Ready } else { EventKind::NotReady }, self.active.map_or(0, |i| self.targets[i]), 0.0);
        }

        // safety alarms while drilling
        let mut alarms = 0;
        if let Some(n) = nav {
            if phase == Phase::Hold {
                alarms |= alarm::DEPTH;
            }
            if phase == Phase::Drill && n.angle_err_deg > cfg.requirement_angle_deg {
                alarms |= alarm::ANGLE;
            }
        }
        if matches!(self.snap.phase, Phase::Drill | Phase::Hold) && lost {
            alarms |= alarm::LOST;
        }
        if alarms & alarm::ANGLE != 0 && self.alarms & alarm::ANGLE == 0 {
            self.push_event(EventKind::AngleAlarm, self.active.map_or(0, |i| self.targets[i]), nav.map_or(0.0, |n| n.angle_err_deg));
        }
        self.alarms = alarms;

        // 6: snapshot
        let mut nodes = Vec::with_capacity(self.graph.len());
        for n in self.graph.nodes() {
            nodes.push(NodeState { id: n.id, world: n.world, status: n.status, age: if n.stamp.is_finite() { t - n.stamp } else { f64::INFINITY } });
        }
        self.snap = Snapshot {
            tick: self.k,
            t,
            nodes,
            targets: display,
            drilled: self.drilled.clone(),
            active: self.active,
            phase,
            gate: g,
            ready,
            locking,
            alarms,
            jitter_mm: jm,
            jitter_deg: jd,
            markers,
            rms_px: rms,
            pose_age_s: pose_age,
            events: self.events.clone(),
            stats: self.stats,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{NodeKind, ROOT};

    /// sheet at the origin (z out), a square target A at (0.02, 0, 0) (target +Z = into the sheet),
    /// a tracked camera, a calibrated tool 0.17 m ahead of the camera along its +Z.
    fn rig() -> (Engine, NodeId, NodeId, NodeId, NodeId) {
        let mut g = SceneGraph::new();
        let sheet = g.add("sheet", ROOT, NodeKind::Reference, Transform::IDENTITY).unwrap();
        let into = Quat::from_axis_angle([1.0, 0.0, 0.0], std::f64::consts::PI);
        let a = g.add("A", sheet, NodeKind::Planned, Transform::rigid([0.02, 0.0, 0.0], into)).unwrap();
        let cam = g.add("camera", ROOT, NodeKind::Tracked, Transform::IDENTITY).unwrap();
        let tool = g.add("tool", cam, NodeKind::Calibrated, Transform::rigid([0.0, 0.0, 0.17], Quat::IDENTITY)).unwrap();
        let mut e = Engine::new(g, EngineConfig::default());
        e.set_tool(tool);
        e.set_targets(&[a]);
        e.set_calibrated(tool, true);
        e.start(0.0);
        (e, sheet, a, cam, tool)
    }

    /// Camera pose (world) for a tool tip at `tip` (world), bit along `axis` (world).
    fn cam_world(tip: V3, axis: V3) -> Transform {
        let q = Quat::from_two_vectors([0.0, 0.0, 1.0], axis);
        let p = [tip[0] - axis[0] * 0.17, tip[1] - axis[1] * 0.17, tip[2] - axis[2] * 0.17];
        Transform::rigid(p, q)
    }

    /// The tracker sees T_camera_sheet = world(camera)⁻¹ (sheet = world here).
    fn meas(cam: NodeId, sheet: NodeId, w: &Transform, t: f64) -> Measurement {
        Measurement { from: cam, to: sheet, transform: w.inverse(), t_capture: t, markers: 9, rms_px: 0.3 }
    }

    #[test]
    fn target_frame_navigation() {
        // tip 10 mm in front of A, bit square: target frame tip z = -0.01
        let into = Quat::from_axis_angle([1.0, 0.0, 0.0], std::f64::consts::PI);
        let tg = Transform::rigid([0.02, 0.0, 0.0], into);
        let tool = cam_world([0.0205, 0.0, 0.01], [0.0, 0.0, -1.0]).compose(&Transform::rigid([0.0, 0.0, 0.17], Quat::IDENTITY));
        let n = target_nav(1, &tg.inverse().compose(&tool));
        assert!((n.gap_mm - 10.0).abs() < 1e-9 && n.depth_mm == 0.0);
        assert!(n.angle_err_deg < 1e-6 && (n.offset_mm - 0.5).abs() < 1e-9);
        // tilted 1° toward +x of the sheet, tip on the surface: aim = tip
        let a = 1f64.to_radians();
        let tool = cam_world([0.02, 0.0, 0.0], [a.sin(), 0.0, -a.cos()]).compose(&Transform::rigid([0.0, 0.0, 0.17], Quat::IDENTITY));
        let n = target_nav(1, &tg.inverse().compose(&tool));
        assert!((n.angle_err_deg - 1.0).abs() < 1e-9 && n.offset_mm < 1e-9);
    }

    #[test]
    fn clock_is_logical_and_overruns_are_dropped() {
        let (mut e, ..) = rig();
        assert_eq!(e.advance_to(0.05), 4, "max catch-up");
        assert_eq!(e.snapshot().stats.overruns, 1);
        let k = e.snapshot().tick;
        // after an overrun the clock jumps to the wall time
        assert!((e.now() - 0.05).abs() <= 1.0 / 120.0 + 1e-9, "now {}", e.now());
        assert_eq!(e.advance_to(e.now()), 1);
        assert!(e.snapshot().tick > k);
        assert!(e.take_events().iter().any(|ev| ev.kind == EventKind::Overrun));
    }

    #[test]
    fn same_inputs_same_snapshots() {
        let run = || {
            let (mut e, sheet, _, cam, _) = rig();
            let mut out = Vec::new();
            for i in 0..240 {
                let t = i as f64 / 120.0;
                if i % 4 == 0 {
                    let w = cam_world([0.02 + 0.01 * (t * 3.0).sin(), 0.0, 0.02], [0.0, 0.01 * t, -1.0]);
                    e.push(meas(cam, sheet, &w, t - 0.03));
                }
                e.advance_to(t);
                out.push(e.snapshot().clone());
            }
            out
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn statuses_follow_measurement_age() {
        let (mut e, sheet, _, cam, _) = rig();
        assert_eq!(e.graph.node(cam).unwrap().status, Status::Lost);
        e.push(meas(cam, sheet, &cam_world([0.02, 0.0, 0.02], [0.0, 0.0, -1.0]), 0.0));
        e.advance_to(0.0);
        assert_eq!(e.graph.node(cam).unwrap().status, Status::Valid);
        e.advance_to(0.1);
        assert_eq!(e.graph.node(cam).unwrap().status, Status::Predicted);
        for i in 1..=80 {
            e.advance_to(0.1 + i as f64 / 120.0);
        }
        assert_eq!(e.graph.node(cam).unwrap().status, Status::Lost);
        let ev = e.take_events();
        assert!(ev.iter().any(|x| x.kind == EventKind::Found) && ev.iter().any(|x| x.kind == EventKind::Lost));
    }

    #[test]
    fn prediction_compensates_latency() {
        // the tool moves at 50 mm/s along x; measurements arrive 60 ms late
        let run = |predict: bool| {
            let (mut e, sheet, _, cam, tool) = rig();
            e.config.predict = predict;
            e.config.predict_max_s = 0.08;
            let mut worst: f64 = 0.0;
            for i in 0..360 {
                let t = i as f64 / 120.0;
                if i % 4 == 0 && t >= 0.06 {
                    let tc = t - 0.06;
                    e.push(meas(cam, sheet, &cam_world([0.05 * tc, 0.0, 0.02], [0.0, 0.0, -1.0]), tc));
                }
                e.advance_to(t);
                if t > 1.0 {
                    let x = e.graph.world(tool).unwrap().p[0];
                    worst = worst.max((x - 0.05 * t).abs());
                }
            }
            worst * 1000.0
        };
        let (with, without) = (run(true), run(false));
        assert!(without > 2.5, "lag without prediction {without} mm");
        assert!(with < 0.5, "lag with prediction {with} mm");
    }

    #[test]
    fn out_of_order_measurements_are_merged() {
        let (mut e, sheet, _, cam, tool) = rig();
        let w = |x: f64| cam_world([x, 0.0, 0.02], [0.0, 0.0, -1.0]);
        e.push(meas(cam, sheet, &w(0.00), 0.00));
        e.push(meas(cam, sheet, &w(0.02), 0.10));
        for i in 0..=12 {
            e.advance_to(i as f64 / 120.0);
        }
        e.push(meas(cam, sheet, &w(0.01), 0.05)); // late
        e.push(meas(cam, sheet, &w(0.50), -1.0)); // far too late
        e.advance_to(0.11);
        let s = e.snapshot().stats;
        assert_eq!((s.late_merged, s.late_dropped), (1, 1));
        assert!(e.graph.world(tool).unwrap().p[0] > 0.015, "state follows the newest measurement");
    }

    #[test]
    fn ready_needs_calibration_steadiness_and_lock_time_then_drilling_is_tracked() {
        let (mut e, sheet, a, cam, tool) = rig();
        e.set_calibrated(tool, false);
        let at = |d: f64| cam_world([0.0201, 0.0, -d], [0.0, 0.0, -1.0]);
        let mut first_ready = None;
        let feed = |e: &mut Engine, t0: f64, t1: f64, d: &dyn Fn(f64) -> f64| {
            let mut t = t0;
            while t < t1 {
                if ((t * 120.0).round() as i64) % 4 == 0 {
                    e.push(meas(cam, sheet, &at(d(t)), t));
                }
                e.advance_to(t);
                t += 1.0 / 120.0;
            }
        };
        feed(&mut e, 0.0, 1.0, &|_| 0.0);
        assert!(!e.snapshot().ready && e.snapshot().gate & crate::nav::reason::NOT_CALIBRATED != 0);
        e.set_calibrated(tool, true);
        let t_cal = e.now();
        let mut t = t_cal;
        while t < t_cal + 1.5 {
            e.push(meas(cam, sheet, &at(0.0), t));
            e.advance_to(t);
            if e.snapshot().ready && first_ready.is_none() {
                first_ready = Some(t);
            }
            t += 1.0 / 30.0;
        }
        let fr = first_ready.expect("ready");
        assert!(fr - t_cal >= 0.4 - 1e-9, "lock time respected ({})", fr - t_cal);
        assert_eq!(e.snapshot().active, Some(0));
        assert_eq!(e.snapshot().targets[0].target, a);
        // drill to 35 mm
        feed(&mut e, t, t + 3.0, &|tt| ((tt - t) / 2.5 * 0.035).min(0.035));
        assert!(e.snapshot().drilled[0]);
        assert_eq!(e.snapshot().phase, Phase::Hold);
        assert!(e.snapshot().alarms & alarm::DEPTH != 0);
        let ev = e.take_events();
        assert!(ev.iter().any(|x| x.kind == EventKind::Ready));
        assert!(ev.iter().any(|x| x.kind == EventKind::DepthReached && x.node == a));
    }

    #[test]
    fn angle_alarm_while_drilling() {
        let (mut e, sheet, _, cam, _) = rig();
        let a = 1.5f64.to_radians();
        for i in 0..120 {
            let t = i as f64 / 60.0;
            let d = (t * 0.01).min(0.01);
            e.push(meas(cam, sheet, &cam_world([0.0201 + a.sin() * d, 0.0, -a.cos() * d], [a.sin(), 0.0, -a.cos()]), t));
            e.advance_to(t);
        }
        assert_eq!(e.snapshot().phase, Phase::Drill);
        assert!(e.snapshot().alarms & alarm::ANGLE != 0);
        assert!(e.take_events().iter().any(|x| x.kind == EventKind::AngleAlarm));
    }

    #[test]
    fn nearest_target_is_chosen_until_engaged() {
        let mut g = SceneGraph::new();
        let into = Quat::from_axis_angle([1.0, 0.0, 0.0], std::f64::consts::PI);
        let a = g.add("A", ROOT, NodeKind::Planned, Transform::rigid([0.0, 0.08, 0.0], into)).unwrap();
        let b = g.add("B", ROOT, NodeKind::Planned, Transform::rigid([0.0, -0.08, 0.0], into)).unwrap();
        let cam = g.add("camera", ROOT, NodeKind::Tracked, Transform::IDENTITY).unwrap();
        let tool = g.add("tool", cam, NodeKind::Calibrated, Transform::rigid([0.0, 0.0, 0.17], Quat::IDENTITY)).unwrap();
        let mut e = Engine::new(g, EngineConfig::default());
        e.set_tool(tool);
        e.set_targets(&[a, b]);
        e.start(0.0);
        e.push(meas(cam, ROOT, &cam_world([0.0, -0.07, 0.05], [0.0, 0.0, -1.0]), 0.0));
        e.advance_to(0.0);
        assert_eq!(e.snapshot().active, Some(1));
        e.push(meas(cam, ROOT, &cam_world([0.0, 0.07, 0.05], [0.0, 0.0, -1.0]), 0.01));
        e.advance_to(0.02);
        assert_eq!(e.snapshot().active, Some(0));
    }

    #[test]
    fn a_target_on_an_unregistered_part_keeps_the_gate_closed_and_depth_is_per_target() {
        // a part (calibrated = registered) carrying a screw hole that seats at 12 mm
        let mut g = SceneGraph::new();
        let part = g.add("part", ROOT, NodeKind::Calibrated, Transform::IDENTITY).unwrap();
        let into = Quat::from_axis_angle([1.0, 0.0, 0.0], std::f64::consts::PI);
        let hole = g.add("hole", part, NodeKind::Planned, Transform::rigid([0.02, 0.0, 0.0], into)).unwrap();
        let cam = g.add("camera", ROOT, NodeKind::Tracked, Transform::IDENTITY).unwrap();
        let tool = g.add("tool", cam, NodeKind::Calibrated, Transform::rigid([0.0, 0.0, 0.17], Quat::IDENTITY)).unwrap();
        let mut e = Engine::new(g, EngineConfig::default());
        e.set_tool(tool);
        e.set_targets(&[hole]);
        e.set_target_depths(&[12.0]);
        e.set_calibrated(tool, true);
        e.start(0.0);
        let at = |d: f64| cam_world([0.0201, 0.0, -d], [0.0, 0.0, -1.0]);
        let mut t = 0.0;
        while t < 1.5 {
            e.push(meas(cam, ROOT, &at(0.0), t));
            e.advance_to(t);
            t += 1.0 / 30.0;
        }
        assert!(!e.snapshot().ready && e.snapshot().gate & crate::nav::reason::NOT_LOCATED != 0, "part not registered");
        assert_eq!(e.snapshot().gate & crate::nav::reason::NOT_CALIBRATED, 0, "the tool itself is calibrated");
        e.set_calibrated(part, true);
        let t1 = t;
        while t < t1 + 1.5 {
            e.push(meas(cam, ROOT, &at(0.0), t));
            e.advance_to(t);
            t += 1.0 / 30.0;
        }
        assert!(e.snapshot().ready, "registered: ready");
        // drive to 12 mm: the screw is seated, not 35 mm
        let t2 = t;
        while t < t2 + 2.0 {
            e.push(meas(cam, ROOT, &at(((t - t2) / 1.5 * 0.012).min(0.0121)), t));
            e.advance_to(t);
            t += 1.0 / 30.0;
        }
        assert_eq!(e.snapshot().phase, Phase::Hold);
        assert!(e.take_events().iter().any(|x| x.kind == EventKind::DepthReached && (x.value - 12.0).abs() < 0.5));
    }

    #[test]
    fn a_tip_below_a_far_hole_is_not_drilling_it() {
        // two holes: A on the bench (z = 0), B on a raised part 76 mm higher and 60 mm away
        let mut g = SceneGraph::new();
        let into = Quat::from_axis_angle([1.0, 0.0, 0.0], std::f64::consts::PI);
        let a = g.add("A", ROOT, NodeKind::Planned, Transform::rigid([0.0, 0.0, 0.0], into)).unwrap();
        let b = g.add("B", ROOT, NodeKind::Planned, Transform::rigid([0.06, 0.0, 0.076], into)).unwrap();
        let cam = g.add("camera", ROOT, NodeKind::Tracked, Transform::IDENTITY).unwrap();
        let tool = g.add("tool", cam, NodeKind::Calibrated, Transform::rigid([0.0, 0.0, 0.17], Quat::IDENTITY)).unwrap();
        let mut e = Engine::new(g, EngineConfig::default());
        e.set_tool(tool);
        e.set_targets(&[b, a]);
        e.set_calibrated(tool, true);
        e.start(0.0);
        for i in 0..60 {
            let t = i as f64 / 30.0;
            e.push(meas(cam, ROOT, &cam_world([0.0, 0.0, 0.004], [0.0, 0.0, -1.0]), t));
            e.advance_to(t);
        }
        let s = e.snapshot();
        assert_eq!(s.targets[s.active.unwrap()].target, a, "the nearby hole, not the far one above");
        assert_ne!(s.phase, Phase::Hold);
        assert!(!s.drilled.iter().any(|&d| d));
    }

    #[test]
    fn a_hole_on_an_unlocated_part_is_never_drilled() {
        let mut g = SceneGraph::new();
        let part = g.add("part", ROOT, NodeKind::Calibrated, Transform::IDENTITY).unwrap();
        let into = Quat::from_axis_angle([1.0, 0.0, 0.0], std::f64::consts::PI);
        let hole = g.add("hole", part, NodeKind::Planned, Transform::rigid([0.0, 0.0, 0.0], into)).unwrap();
        let cam = g.add("camera", ROOT, NodeKind::Tracked, Transform::IDENTITY).unwrap();
        let tool = g.add("tool", cam, NodeKind::Calibrated, Transform::rigid([0.0, 0.0, 0.17], Quat::IDENTITY)).unwrap();
        let mut e = Engine::new(g, EngineConfig::default());
        e.set_tool(tool);
        e.set_targets(&[hole]);
        e.set_calibrated(tool, true);
        e.start(0.0);
        // the tip 50 mm "inside" the (unlocated) hole
        for i in 0..60 {
            let t = i as f64 / 30.0;
            e.push(meas(cam, ROOT, &cam_world([0.0, 0.0, -0.05], [0.0, 0.0, -1.0]), t));
            e.advance_to(t);
        }
        let s = e.snapshot();
        assert!(!matches!(s.phase, Phase::Drill | Phase::Hold), "phase {:?}", s.phase);
        assert!(!s.drilled[0] && s.gate & crate::nav::reason::NOT_LOCATED != 0);
        assert!(!e.take_events().iter().any(|x| x.kind == EventKind::DepthReached));
    }

    #[test]
    fn decisions_use_measurements_not_the_prediction() {
        // the tool comes down fast and stops on the surface: the prediction overshoots below it,
        // but the phase never becomes "drill" and no depth is reported
        let (mut e, sheet, _, cam, _) = rig();
        e.config.predict_max_s = 0.12;
        let mut worst_display: f64 = 0.0;
        for i in 0..240 {
            let t = i as f64 / 120.0;
            if i % 4 == 0 {
                let tc = (t - 0.08).max(0.0);
                let z = (0.06 - tc * 0.12).max(0.0); // 120 mm/s down, then stopped on the surface
                e.push(meas(cam, sheet, &cam_world([0.0201, 0.0, z], [0.0, 0.0, -1.0]), tc));
            }
            e.advance_to(t);
            let s = e.snapshot();
            if let Some(n) = s.active.and_then(|i| s.targets.get(i)) {
                worst_display = worst_display.max(n.depth_mm);
            }
            assert!(!matches!(s.phase, Phase::Drill | Phase::Hold), "t {t}: phase {:?}", s.phase);
        }
        assert!(worst_display > 1.0, "the displayed (predicted) tip does overshoot: {worst_display} mm");
        assert!(!e.take_events().iter().any(|x| x.kind == EventKind::DepthReached));
    }

    #[test]
    fn angled_targets_need_no_special_case() {
        // a hole planned 20° off the normal: the tool aligned with it reads 0°
        let mut g = SceneGraph::new();
        let into = Quat::from_axis_angle([1.0, 0.0, 0.0], std::f64::consts::PI);
        let tilt = Quat::from_axis_angle([0.0, 1.0, 0.0], 20f64.to_radians());
        let a = g.add("A", ROOT, NodeKind::Planned, Transform::rigid([0.0, 0.0, 0.0], tilt.mul(&into))).unwrap();
        let cam = g.add("camera", ROOT, NodeKind::Tracked, Transform::IDENTITY).unwrap();
        let tool = g.add("tool", cam, NodeKind::Calibrated, Transform::rigid([0.0, 0.0, 0.17], Quat::IDENTITY)).unwrap();
        let mut e = Engine::new(g, EngineConfig::default());
        e.set_tool(tool);
        e.set_targets(&[a]);
        e.start(0.0);
        let axis = tilt.mul(&into).rotate([0.0, 0.0, 1.0]);
        e.push(meas(cam, ROOT, &cam_world([0.0, 0.0, 0.0], axis), 0.0));
        e.advance_to(0.0);
        let n = e.snapshot().targets[0];
        assert!(n.angle_err_deg < 1e-6 && n.offset_mm < 1e-6, "{:?}", n);
    }
}
