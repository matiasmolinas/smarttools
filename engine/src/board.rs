//! Printable A4 marker sheet v2 (`/markers`). Same geometry as `lib/board.ts`: a 4 x 7 grid of 24 mm
//! markers (id = row * 4 + column, row 0 at the top) with the holes A1-A3 in the gaps. Dense because
//! the docked camera only sees a ~22 x 12 cm strip above the bit tip.

use crate::geom::P2;

/// Sheet size, metres.
pub const SHEET_W: f64 = 0.21;
pub const SHEET_H: f64 = 0.297;
/// ArUco dictionary used by the detector.
pub const DICTIONARY: &str = "ARUCO_MIP_36h12";
/// Black square edge, metres (8 x 3 mm cells).
pub const MARKER_SIZE: f64 = 0.024;
pub const GRID_COLS: [f64; 4] = [-0.06, -0.02, 0.02, 0.06];
pub const GRID_ROWS: [f64; 7] = [0.12, 0.08, 0.04, 0.0, -0.04, -0.08, -0.12];
pub const MARKER_COUNT: usize = GRID_COLS.len() * GRID_ROWS.len();

pub struct Target {
    pub x: f64,
    pub y: f64,
    pub label: &'static str,
}

pub const BOARD_TARGETS: [Target; 3] = [
    Target { x: 0.0, y: 0.06, label: "A1" },
    Target { x: 0.0, y: -0.02, label: "A2" },
    Target { x: 0.0, y: -0.1, label: "A3" },
];

/// Centre of marker `id`.
pub fn marker_center(id: u32) -> Option<P2> {
    let id = id as usize;
    (id < MARKER_COUNT).then(|| P2::new(GRID_COLS[id % GRID_COLS.len()], GRID_ROWS[id / GRID_COLS.len()]))
}

/// World corners of a marker in detector order (clockwise from the marker's top-left).
pub fn marker_corners(id: u32) -> Option<[P2; 4]> {
    let m = marker_center(id)?;
    let h = MARKER_SIZE / 2.0;
    Some([
        P2::new(m.x - h, m.y + h),
        P2::new(m.x + h, m.y + h),
        P2::new(m.x + h, m.y - h),
        P2::new(m.x - h, m.y - h),
    ])
}

/// The marker whose square contains (x, y), if any (constant time).
pub fn marker_at(x: f64, y: f64) -> Option<u32> {
    let pitch_x = GRID_COLS[1] - GRID_COLS[0];
    let pitch_y = GRID_ROWS[0] - GRID_ROWS[1];
    let c = ((x - GRID_COLS[0]) / pitch_x).round();
    let r = ((GRID_ROWS[0] - y) / pitch_y).round();
    if c < 0.0 || r < 0.0 || c as usize >= GRID_COLS.len() || r as usize >= GRID_ROWS.len() {
        return None;
    }
    let id = r as usize * GRID_COLS.len() + c as usize;
    let m = marker_center(id as u32)?;
    let h = MARKER_SIZE / 2.0;
    (x >= m.x - h && x < m.x + h && y > m.y - h && y <= m.y + h).then_some(id as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_fit_on_the_sheet_with_quiet_zones() {
        for id in 0..MARKER_COUNT as u32 {
            for c in marker_corners(id).unwrap() {
                // >= 15 mm from the paper edge (printer margins)
                assert!(c.x.abs() < SHEET_W / 2.0 - 0.015 && c.y.abs() < SHEET_H / 2.0 - 0.015);
            }
        }
        assert!(marker_corners(MARKER_COUNT as u32).is_none());
    }

    #[test]
    fn targets_sit_in_clear_gaps() {
        for t in &BOARD_TARGETS {
            for id in 0..MARKER_COUNT as u32 {
                let m = marker_center(id).unwrap();
                let gap = ((t.x - m.x).abs() - MARKER_SIZE / 2.0).max((t.y - m.y).abs() - MARKER_SIZE / 2.0);
                assert!(gap >= 0.008 - 1e-12, "{} too close to marker {id}", t.label);
            }
        }
    }

    #[test]
    fn marker_lookup() {
        assert_eq!(marker_at(0.06, 0.12), Some(3));
        assert_eq!(marker_at(-0.06, -0.12), Some(24));
        assert_eq!(marker_at(0.0, 0.06), None);
        assert_eq!(marker_at(0.2, 0.0), None);
    }
}
