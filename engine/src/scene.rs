//! Scene graph: a tree of coordinate frames (docs/ENGINE_SPEC.md §4).
//!
//! Every node has a local transform (position, unit quaternion, scale) relative to its parent, or to
//! the world root. World transforms are recomputed from the local ones on every update, in
//! topological order: nothing is integrated, so a still scene never drifts. Trackers, calibrations
//! and plans write `local`; only [`SceneGraph::update`] writes `world`.
//!
//! Notation: `T_a_b` is the pose of frame b in frame a; it maps points from b to a.

use crate::geom::{M3, V3};

/// Unit quaternion, Hamilton convention, `(w, x, y, z)`, active rotation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quat {
    pub w: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Quat {
    pub const IDENTITY: Quat = Quat { w: 1.0, x: 0.0, y: 0.0, z: 0.0 };

    pub const fn new(w: f64, x: f64, y: f64, z: f64) -> Self {
        Self { w, x, y, z }
    }

    pub fn norm(&self) -> f64 {
        (self.w * self.w + self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }

    /// Unit quaternion; the identity if the input is zero or not finite.
    pub fn normalize(&self) -> Quat {
        let n = self.norm();
        if n.is_nan() || n <= 1e-300 || !n.is_finite() {
            return Quat::IDENTITY;
        }
        Quat::new(self.w / n, self.x / n, self.y / n, self.z / n)
    }

    pub fn conj(&self) -> Quat {
        Quat::new(self.w, -self.x, -self.y, -self.z)
    }

    pub fn dot(&self, o: &Quat) -> f64 {
        self.w * o.w + self.x * o.x + self.y * o.y + self.z * o.z
    }

    /// Hamilton product `self ⊗ o` (apply `o` first, then `self`).
    pub fn mul(&self, o: &Quat) -> Quat {
        Quat::new(
            self.w * o.w - self.x * o.x - self.y * o.y - self.z * o.z,
            self.w * o.x + self.x * o.w + self.y * o.z - self.z * o.y,
            self.w * o.y - self.x * o.z + self.y * o.w + self.z * o.x,
            self.w * o.z + self.x * o.y - self.y * o.x + self.z * o.w,
        )
    }

    /// Rotate a vector.
    pub fn rotate(&self, v: V3) -> V3 {
        // v' = v + 2 u × (u × v + w v), u = (x, y, z)
        let u = [self.x, self.y, self.z];
        let c1 = cross(u, v);
        let t = [c1[0] + self.w * v[0], c1[1] + self.w * v[1], c1[2] + self.w * v[2]];
        let c2 = cross(u, t);
        [v[0] + 2.0 * c2[0], v[1] + 2.0 * c2[1], v[2] + 2.0 * c2[2]]
    }

    /// Rotation of `angle` radians about `axis` (any length).
    pub fn from_axis_angle(axis: V3, angle: f64) -> Quat {
        let l = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
        if l < 1e-300 {
            return Quat::IDENTITY;
        }
        let (s, c) = (angle / 2.0).sin_cos();
        Quat::new(c, axis[0] / l * s, axis[1] / l * s, axis[2] / l * s)
    }

    /// From a rotation vector (axis × angle).
    pub fn from_rotvec(r: V3) -> Quat {
        let th = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt();
        if th < 1e-12 {
            return Quat::new(1.0, r[0] / 2.0, r[1] / 2.0, r[2] / 2.0).normalize();
        }
        Quat::from_axis_angle(r, th)
    }

    /// Rotation vector (axis × angle, angle in [0, π]).
    pub fn to_rotvec(&self) -> V3 {
        let q = if self.w < 0.0 { Quat::new(-self.w, -self.x, -self.y, -self.z) } else { *self };
        let s = (q.x * q.x + q.y * q.y + q.z * q.z).sqrt();
        if s < 1e-12 {
            return [2.0 * q.x, 2.0 * q.y, 2.0 * q.z];
        }
        let th = 2.0 * s.atan2(q.w);
        [q.x / s * th, q.y / s * th, q.z / s * th]
    }

    /// Smallest rotation taking direction `a` to direction `b`.
    pub fn from_two_vectors(a: V3, b: V3) -> Quat {
        let na = norm3(a);
        let nb = norm3(b);
        let d = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
        if d < -1.0 + 1e-12 {
            // opposite: any perpendicular axis
            let p = if na[0].abs() < 0.9 { cross(na, [1.0, 0.0, 0.0]) } else { cross(na, [0.0, 1.0, 0.0]) };
            return Quat::from_axis_angle(p, std::f64::consts::PI);
        }
        let c = cross(na, nb);
        Quat::new(1.0 + d, c[0], c[1], c[2]).normalize()
    }

    /// Row-major rotation matrix.
    pub fn to_matrix(&self) -> M3 {
        let Quat { w, x, y, z } = *self;
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - w * z),
            2.0 * (x * z + w * y),
            2.0 * (x * y + w * z),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - w * x),
            2.0 * (x * z - w * y),
            2.0 * (y * z + w * x),
            1.0 - 2.0 * (x * x + y * y),
        ]
    }

    /// From a row-major rotation matrix (Shepperd's method).
    pub fn from_matrix(m: &M3) -> Quat {
        let tr = m[0] + m[4] + m[8];
        let q = if tr > 0.0 {
            let s = (tr + 1.0).sqrt() * 2.0;
            Quat::new(0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s)
        } else if m[0] > m[4] && m[0] > m[8] {
            let s = (1.0 + m[0] - m[4] - m[8]).sqrt() * 2.0;
            Quat::new((m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s)
        } else if m[4] > m[8] {
            let s = (1.0 + m[4] - m[0] - m[8]).sqrt() * 2.0;
            Quat::new((m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s)
        } else {
            let s = (1.0 + m[8] - m[0] - m[4]).sqrt() * 2.0;
            Quat::new((m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s)
        };
        q.normalize()
    }

    /// Angle between two rotations, radians (handles q ≡ -q).
    pub fn angle_to(&self, o: &Quat) -> f64 {
        // atan2 form: accurate for small angles (acos of a dot product loses half the digits)
        let d = self.conj().mul(o);
        2.0 * (d.x * d.x + d.y * d.y + d.z * d.z).sqrt().atan2(d.w.abs())
    }

    /// `self` or `-self`, whichever is in the same hemisphere as `reference` (for filtering and
    /// interpolation: q and -q are the same rotation).
    pub fn aligned_with(&self, reference: &Quat) -> Quat {
        if self.dot(reference) < 0.0 {
            Quat::new(-self.w, -self.x, -self.y, -self.z)
        } else {
            *self
        }
    }
}

fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm3(v: V3) -> V3 {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if l < 1e-300 {
        return [0.0, 0.0, 1.0];
    }
    [v[0] / l, v[1] / l, v[2] / l]
}

/// Position, orientation and scale. Rigid chains (tracking, navigation) keep scale = 1; scale is
/// for display leaves only (docs/ENGINE_SPEC.md §4.1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    pub p: V3,
    pub q: Quat,
    pub s: V3,
}

impl Transform {
    pub const IDENTITY: Transform = Transform { p: [0.0; 3], q: Quat::IDENTITY, s: [1.0; 3] };

    pub fn rigid(p: V3, q: Quat) -> Self {
        Self { p, q: q.normalize(), s: [1.0; 3] }
    }

    pub fn is_rigid(&self) -> bool {
        self.s.iter().all(|v| (v - 1.0).abs() < 1e-12)
    }

    /// `self · child`: the child's transform expressed in this one's parent frame.
    pub fn compose(&self, c: &Transform) -> Transform {
        let sp = [self.s[0] * c.p[0], self.s[1] * c.p[1], self.s[2] * c.p[2]];
        let r = self.q.rotate(sp);
        Transform {
            p: [self.p[0] + r[0], self.p[1] + r[1], self.p[2] + r[2]],
            q: self.q.mul(&c.q).normalize(),
            s: [self.s[0] * c.s[0], self.s[1] * c.s[1], self.s[2] * c.s[2]],
        }
    }

    /// Inverse of the rigid part (scale ignored: rigid chains have unit scale).
    pub fn inverse(&self) -> Transform {
        let qi = self.q.conj();
        let p = qi.rotate(self.p);
        Transform { p: [-p[0], -p[1], -p[2]], q: qi, s: [1.0; 3] }
    }

    /// Map a point from this frame to the parent frame.
    pub fn apply_point(&self, v: V3) -> V3 {
        let r = self.q.rotate([self.s[0] * v[0], self.s[1] * v[1], self.s[2] * v[2]]);
        [self.p[0] + r[0], self.p[1] + r[1], self.p[2] + r[2]]
    }

    /// Map a direction (no translation, no scale).
    pub fn apply_dir(&self, v: V3) -> V3 {
        self.q.rotate(v)
    }

    /// Row-major 4x4 matrix (for renderers).
    pub fn to_matrix4(&self) -> [f64; 16] {
        let r = self.q.to_matrix();
        let s = self.s;
        [
            r[0] * s[0], r[1] * s[1], r[2] * s[2], self.p[0],
            r[3] * s[0], r[4] * s[1], r[5] * s[2], self.p[1],
            r[6] * s[0], r[7] * s[1], r[8] * s[2], self.p[2],
            0.0, 0.0, 0.0, 1.0,
        ]
    }

    /// From the pose solver's `Pose` (`x_cam = R X + t`, i.e. `T_cam_ref`).
    pub fn from_pose(p: &crate::pose::Pose) -> Transform {
        Transform::rigid(p.t, Quat::from_matrix(&p.r))
    }

    pub fn to_pose(&self) -> crate::pose::Pose {
        crate::pose::Pose { r: self.q.to_matrix(), t: self.p, rms: 0.0 }
    }

    /// 10 numbers: p (3), q (w, x, y, z), s (3).
    pub fn to_array(&self) -> [f64; 10] {
        [self.p[0], self.p[1], self.p[2], self.q.w, self.q.x, self.q.y, self.q.z, self.s[0], self.s[1], self.s[2]]
    }

    pub fn from_slice(a: &[f64]) -> Transform {
        Transform { p: [a[0], a[1], a[2]], q: Quat::new(a[3], a[4], a[5], a[6]).normalize(), s: [a[7], a[8], a[9]] }
    }
}

pub type NodeId = u32;
/// The world root always exists and has id 0.
pub const ROOT: NodeId = 0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum NodeKind {
    /// The root and fixed references (a marker sheet).
    Reference = 0,
    /// Measured by a tracker (the phone camera).
    Tracked = 1,
    /// Set by a calibration (the tool relative to the camera).
    Calibrated = 2,
    /// From the job plan (a hole, a screw).
    Planned = 3,
    /// Fixed offset of another node (the chuck relative to the tip).
    Derived = 4,
    /// Display only (labels, meshes); may carry scale.
    Display = 5,
}

impl NodeKind {
    pub fn from_u8(v: u8) -> Option<NodeKind> {
        Some(match v {
            0 => NodeKind::Reference,
            1 => NodeKind::Tracked,
            2 => NodeKind::Calibrated,
            3 => NodeKind::Planned,
            4 => NodeKind::Derived,
            5 => NodeKind::Display,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Status {
    /// Not measured: references, plans, derived and display nodes.
    Static = 0,
    /// Measured within the last tick.
    Valid = 1,
    /// Extrapolated from a recent measurement.
    Predicted = 2,
    /// Too old to trust for decisions; still drawn.
    Stale = 3,
    /// No measurement for a long time.
    Lost = 4,
    /// A calibrated node whose calibration has not been done.
    Uncalibrated = 5,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub id: NodeId,
    pub name: String,
    pub parent: Option<NodeId>,
    pub kind: NodeKind,
    pub local: Transform,
    pub world: Transform,
    pub status: Status,
    /// Capture time of the measurement behind `local` (tracked nodes), seconds.
    pub stamp: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SceneError {
    UnknownNode,
    NameTaken,
    Cycle,
    RootIsFixed,
    ScaleOnRigidChain,
}

/// The tree. Node ids are indices; the root is id 0 ("world").
#[derive(Clone, Debug)]
pub struct SceneGraph {
    nodes: Vec<Node>,
    order: Vec<NodeId>,
}

impl Default for SceneGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneGraph {
    pub fn new() -> Self {
        let root = Node {
            id: ROOT,
            name: "world".into(),
            parent: None,
            kind: NodeKind::Reference,
            local: Transform::IDENTITY,
            world: Transform::IDENTITY,
            status: Status::Static,
            stamp: 0.0,
        };
        Self { nodes: vec![root], order: vec![ROOT] }
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }
    pub fn is_empty(&self) -> bool {
        false
    }
    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }
    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(id as usize)
    }
    pub fn find(&self, name: &str) -> Option<NodeId> {
        self.nodes.iter().find(|n| n.name == name).map(|n| n.id)
    }
    /// Topological order (parents before children).
    pub fn order(&self) -> &[NodeId] {
        &self.order
    }

    /// Add a node under `parent` (ROOT for the world).
    pub fn add(&mut self, name: &str, parent: NodeId, kind: NodeKind, local: Transform) -> Result<NodeId, SceneError> {
        if self.node(parent).is_none() {
            return Err(SceneError::UnknownNode);
        }
        if self.find(name).is_some() {
            return Err(SceneError::NameTaken);
        }
        if kind != NodeKind::Display && !local.is_rigid() {
            return Err(SceneError::ScaleOnRigidChain);
        }
        let id = self.nodes.len() as NodeId;
        let status = if kind == NodeKind::Tracked {
            Status::Lost
        } else if kind == NodeKind::Calibrated {
            Status::Uncalibrated
        } else {
            Status::Static
        };
        let local = Transform { q: local.q.normalize(), ..local };
        self.nodes.push(Node { id, name: name.into(), parent: Some(parent), kind, local, world: local, status, stamp: f64::NEG_INFINITY });
        self.rebuild_order();
        self.update();
        Ok(id)
    }

    fn is_ancestor(&self, a: NodeId, mut n: NodeId) -> bool {
        loop {
            if n == a {
                return true;
            }
            match self.nodes[n as usize].parent {
                Some(p) => n = p,
                None => return false,
            }
        }
    }

    /// Move a node under a new parent. `keep_world`: adjust `local` so its world pose is unchanged.
    pub fn reparent(&mut self, id: NodeId, parent: NodeId, keep_world: bool) -> Result<(), SceneError> {
        if id == ROOT {
            return Err(SceneError::RootIsFixed);
        }
        if self.node(id).is_none() || self.node(parent).is_none() {
            return Err(SceneError::UnknownNode);
        }
        if self.is_ancestor(id, parent) {
            return Err(SceneError::Cycle);
        }
        self.update();
        if keep_world {
            let w = self.nodes[id as usize].world;
            let pw = self.nodes[parent as usize].world;
            let l = pw.inverse().compose(&w);
            self.nodes[id as usize].local = Transform { s: w.s, ..l };
        }
        self.nodes[id as usize].parent = Some(parent);
        self.rebuild_order();
        self.update();
        Ok(())
    }

    fn rebuild_order(&mut self) {
        // breadth-first from the root
        let mut children: Vec<Vec<NodeId>> = vec![Vec::new(); self.nodes.len()];
        for n in &self.nodes {
            if let Some(p) = n.parent {
                children[p as usize].push(n.id);
            }
        }
        let mut order = Vec::with_capacity(self.nodes.len());
        let mut queue = std::collections::VecDeque::from([ROOT]);
        while let Some(id) = queue.pop_front() {
            order.push(id);
            queue.extend(children[id as usize].iter().copied());
        }
        self.order = order;
    }

    /// Set a node's local transform (the only way trackers, calibrations and plans change the scene).
    pub fn set_local(&mut self, id: NodeId, t: Transform) -> Result<(), SceneError> {
        let n = self.nodes.get_mut(id as usize).ok_or(SceneError::UnknownNode)?;
        if id == ROOT {
            return Err(SceneError::RootIsFixed);
        }
        if n.kind != NodeKind::Display && !t.is_rigid() {
            return Err(SceneError::ScaleOnRigidChain);
        }
        n.local = Transform { q: t.q.normalize(), ..t };
        Ok(())
    }

    pub fn set_status(&mut self, id: NodeId, s: Status, stamp: f64) {
        if let Some(n) = self.nodes.get_mut(id as usize) {
            n.status = s;
            n.stamp = stamp;
        }
    }

    /// Recompute every world transform from the local ones, parents first.
    pub fn update(&mut self) {
        for i in 0..self.order.len() {
            let id = self.order[i] as usize;
            let w = match self.nodes[id].parent {
                None => self.nodes[id].local,
                Some(p) => self.nodes[p as usize].world.compose(&self.nodes[id].local),
            };
            self.nodes[id].world = w;
        }
    }

    pub fn world(&self, id: NodeId) -> Option<Transform> {
        self.node(id).map(|n| n.world)
    }

    /// `T_a_b`: node b expressed in node a's frame (rigid).
    pub fn relative(&self, a: NodeId, b: NodeId) -> Option<Transform> {
        Some(self.world(a)?.inverse().compose(&self.world(b)?))
    }

    /// The local transform a node needs so that its world transform becomes `world`.
    pub fn local_for_world(&self, id: NodeId, world: &Transform) -> Option<Transform> {
        let n = self.node(id)?;
        Some(match n.parent {
            None => *world,
            Some(p) => self.world(p)?.inverse().compose(world),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{mul, mul_v, rodrigues};

    fn near(a: V3, b: V3, eps: f64) -> bool {
        (0..3).all(|i| (a[i] - b[i]).abs() < eps)
    }
    fn tnear(a: &Transform, b: &Transform, eps: f64) -> bool {
        near(a.p, b.p, eps) && a.q.angle_to(&b.q) < eps && near(a.s, b.s, eps)
    }

    /// deterministic pseudo-random transforms
    fn rnd(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }
    fn rand_t(seed: &mut u64) -> Transform {
        Transform::rigid([rnd(seed), rnd(seed), rnd(seed)], Quat::from_rotvec([rnd(seed) * 2.0, rnd(seed) * 2.0, rnd(seed) * 2.0]))
    }

    #[test]
    fn quaternion_matches_matrices() {
        let mut s = 7;
        for _ in 0..200 {
            let r = [rnd(&mut s) * 3.0, rnd(&mut s) * 3.0, rnd(&mut s) * 3.0];
            let q = Quat::from_rotvec(r);
            let m = rodrigues(r);
            let qm = q.to_matrix();
            assert!((0..9).all(|i| (qm[i] - m[i]).abs() < 1e-12));
            assert!(Quat::from_matrix(&m).angle_to(&q) < 1e-9);
            let v = [rnd(&mut s), rnd(&mut s), rnd(&mut s)];
            assert!(near(q.rotate(v), mul_v(&m, v), 1e-12));
            let back = Quat::from_rotvec(q.to_rotvec());
            assert!(back.angle_to(&q) < 1e-9);
        }
    }

    #[test]
    fn product_order_and_double_cover() {
        let a = Quat::from_axis_angle([0.0, 0.0, 1.0], 0.7);
        let b = Quat::from_axis_angle([1.0, 0.0, 0.0], -0.4);
        let v = [0.3, -0.2, 0.9];
        assert!(near(a.mul(&b).rotate(v), a.rotate(b.rotate(v)), 1e-12));
        assert!(near(mul_v(&mul(&a.to_matrix(), &b.to_matrix()), v), a.mul(&b).rotate(v), 1e-12));
        let neg = Quat::new(-a.w, -a.x, -a.y, -a.z);
        assert!(near(neg.rotate(v), a.rotate(v), 1e-12));
        assert!(neg.angle_to(&a) < 1e-9);
        assert!(neg.aligned_with(&a).dot(&a) > 0.0);
        let q = Quat::from_two_vectors([0.0, 0.0, 1.0], [0.3, -0.4, 0.5]);
        assert!(near(q.rotate([0.0, 0.0, 1.0]), norm3([0.3, -0.4, 0.5]), 1e-12));
        let opp = Quat::from_two_vectors([0.0, 0.0, 1.0], [0.0, 0.0, -1.0]);
        assert!(near(opp.rotate([0.0, 0.0, 1.0]), [0.0, 0.0, -1.0], 1e-12));
    }

    #[test]
    fn compose_matches_4x4_matrices_and_inverse_is_exact() {
        let mut s = 11;
        for _ in 0..200 {
            let a = rand_t(&mut s);
            let b = rand_t(&mut s);
            let ab = a.compose(&b);
            let (ma, mb, mab) = (a.to_matrix4(), b.to_matrix4(), ab.to_matrix4());
            for i in 0..4 {
                for j in 0..4 {
                    let v: f64 = (0..4).map(|k| ma[i * 4 + k] * mb[k * 4 + j]).sum();
                    assert!((v - mab[i * 4 + j]).abs() < 1e-12);
                }
            }
            assert!(tnear(&a.compose(&a.inverse()), &Transform::IDENTITY, 1e-12));
            let p = [rnd(&mut s), rnd(&mut s), rnd(&mut s)];
            assert!(near(a.inverse().apply_point(a.apply_point(p)), p, 1e-12));
        }
    }

    #[test]
    fn pose_round_trip() {
        let pose = crate::pose::Pose { r: rodrigues([0.2, -0.5, 0.1]), t: [0.01, 0.02, 0.3], rms: 0.0 };
        let t = Transform::from_pose(&pose);
        let p = [0.05, -0.03, 0.0];
        assert!(near(t.apply_point(p), pose.apply(p), 1e-12));
        let back = t.to_pose();
        assert!((0..9).all(|i| (back.r[i] - pose.r[i]).abs() < 1e-12));
    }

    #[test]
    fn world_transforms_follow_parents() {
        let mut g = SceneGraph::new();
        let a = g.add("a", ROOT, NodeKind::Reference, Transform::rigid([1.0, 0.0, 0.0], Quat::from_axis_angle([0.0, 0.0, 1.0], std::f64::consts::FRAC_PI_2))).unwrap();
        let b = g.add("b", a, NodeKind::Planned, Transform::rigid([1.0, 0.0, 0.0], Quat::IDENTITY)).unwrap();
        // b is 1 m along a's x, which points along world y
        assert!(near(g.world(b).unwrap().p, [1.0, 1.0, 0.0], 1e-12));
        g.set_local(a, Transform::rigid([0.0, 0.0, 2.0], Quat::IDENTITY)).unwrap();
        g.update();
        assert!(near(g.world(b).unwrap().p, [1.0, 0.0, 2.0], 1e-12));
        // relative: b in a
        assert!(tnear(&g.relative(a, b).unwrap(), &g.node(b).unwrap().local, 1e-12));
        assert!(tnear(&g.relative(a, b).unwrap().compose(&g.relative(b, a).unwrap()), &Transform::IDENTITY, 1e-12));
        assert_eq!(g.find("b"), Some(b));
        assert_eq!(g.order().first(), Some(&ROOT));
    }

    #[test]
    fn reparent_keeps_world_and_rejects_cycles() {
        let mut s = 3;
        let mut g = SceneGraph::new();
        let a = g.add("a", ROOT, NodeKind::Reference, rand_t(&mut s)).unwrap();
        let b = g.add("b", a, NodeKind::Reference, rand_t(&mut s)).unwrap();
        let c = g.add("c", b, NodeKind::Planned, rand_t(&mut s)).unwrap();
        let before = g.world(c).unwrap();
        g.reparent(c, ROOT, true).unwrap();
        assert!(tnear(&g.world(c).unwrap(), &before, 1e-12));
        assert_eq!(g.reparent(a, b, false), Err(SceneError::Cycle));
        assert_eq!(g.reparent(a, a, false), Err(SceneError::Cycle));
        assert_eq!(g.reparent(ROOT, a, false), Err(SceneError::RootIsFixed));
        // order still has parents first
        let pos = |id: NodeId| g.order().iter().position(|&x| x == id).unwrap();
        assert!(pos(a) < pos(b));
    }

    #[test]
    fn rules_on_names_and_scale() {
        let mut g = SceneGraph::new();
        g.add("tool", ROOT, NodeKind::Calibrated, Transform::IDENTITY).unwrap();
        assert_eq!(g.add("tool", ROOT, NodeKind::Planned, Transform::IDENTITY), Err(SceneError::NameTaken));
        let scaled = Transform { s: [2.0, 1.0, 1.0], ..Transform::IDENTITY };
        assert_eq!(g.add("bad", ROOT, NodeKind::Tracked, scaled), Err(SceneError::ScaleOnRigidChain));
        let m = g.add("mesh", ROOT, NodeKind::Display, scaled).unwrap();
        assert_eq!(g.node(m).unwrap().world.s, [2.0, 1.0, 1.0]);
        assert_eq!(g.add("orphan", 99, NodeKind::Planned, Transform::IDENTITY), Err(SceneError::UnknownNode));
        assert_eq!(g.node(g.find("tool").unwrap()).unwrap().status, Status::Uncalibrated);
    }

    #[test]
    fn a_still_scene_does_not_drift() {
        let mut s = 5;
        let mut g = SceneGraph::new();
        let mut parent = ROOT;
        for i in 0..8 {
            parent = g.add(&format!("n{i}"), parent, NodeKind::Reference, rand_t(&mut s)).unwrap();
        }
        let first = g.world(parent).unwrap();
        for _ in 0..1_000_000 {
            g.update();
        }
        assert_eq!(g.world(parent).unwrap(), first, "bit-identical after 10^6 updates");
    }
}
