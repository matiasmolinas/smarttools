//! Printable A4 marker sheet (`/markers`). Same geometry as `lib/board.ts`.

use crate::geom::P2;

/// Sheet size, metres.
pub const SHEET_W: f64 = 0.21;
pub const SHEET_H: f64 = 0.297;
/// ArUco dictionary used by the detector.
pub const DICTIONARY: &str = "ARUCO_MIP_36h12";
/// Black square edge, metres (8 x 5 mm cells).
pub const MARKER_SIZE: f64 = 0.04;

pub struct BoardMarker {
    pub id: u32,
    pub x: f64,
    pub y: f64,
}

pub const BOARD_MARKERS: [BoardMarker; 6] = [
    BoardMarker { id: 0, x: -0.07, y: 0.115 },
    BoardMarker { id: 1, x: 0.07, y: 0.115 },
    BoardMarker { id: 2, x: -0.07, y: 0.0 },
    BoardMarker { id: 3, x: 0.07, y: 0.0 },
    BoardMarker { id: 4, x: -0.07, y: -0.115 },
    BoardMarker { id: 5, x: 0.07, y: -0.115 },
];

pub struct Target {
    pub x: f64,
    pub y: f64,
    pub label: &'static str,
}

pub const BOARD_TARGETS: [Target; 3] = [
    Target { x: 0.0, y: 0.08, label: "A1" },
    Target { x: 0.0, y: 0.0, label: "A2" },
    Target { x: 0.0, y: -0.08, label: "A3" },
];

/// World corners of a marker in detector order (clockwise from the marker's top-left).
pub fn marker_corners(id: u32) -> Option<[P2; 4]> {
    let m = BOARD_MARKERS.iter().find(|b| b.id == id)?;
    let h = MARKER_SIZE / 2.0;
    Some([
        P2::new(m.x - h, m.y + h),
        P2::new(m.x + h, m.y + h),
        P2::new(m.x + h, m.y - h),
        P2::new(m.x - h, m.y - h),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_fit_on_the_sheet() {
        for m in &BOARD_MARKERS {
            for c in marker_corners(m.id).unwrap() {
                assert!(c.x.abs() < SHEET_W / 2.0 && c.y.abs() < SHEET_H / 2.0);
            }
        }
        assert!(marker_corners(99).is_none());
    }
}
