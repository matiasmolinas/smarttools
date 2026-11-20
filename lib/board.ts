// Printable A4 marker sheet (v2). World frame = the sheet: origin at its centre, X right, Y up, Z out of
// the surface toward the user (metres). Holes are planned relative to the printed markers.
//
// Why a dense grid: with the phone in the dock, the camera sits ~17 cm behind the bit tip and ~6 cm
// above it, looking along the bit. With the tip on the surface it only sees a strip about 22 x 12 cm
// that starts at the tip and extends upward. The scene simulator (scripts/scene-test.mts) showed that
// the first sheet (6 markers of 40 mm) left no complete marker in view on A2. A 4 x 7 grid of 24 mm
// markers keeps 8-12 complete markers in view on every target. The same layout is in engine/src/board.rs.

export const SHEET = { w: 0.21, h: 0.297 };
export const DICTIONARY = "ARUCO_MIP_36h12";
export const MARKER_SIZE = 0.024; // black square edge, metres (8 x 3 mm cells)
export const GRID_COLS = [-0.06, -0.02, 0.02, 0.06];
export const GRID_ROWS = [0.12, 0.08, 0.04, 0, -0.04, -0.08, -0.12];

/** id = row * 4 + column, row 0 at the top */
export const BOARD_MARKERS: { id: number; x: number; y: number }[] = GRID_ROWS.flatMap((y, r) =>
  GRID_COLS.map((x, c) => ({ id: r * GRID_COLS.length + c, x, y })),
);

/** Planned holes, in the 16 mm clear gaps between markers. */
export const BOARD_TARGETS = [
  { x: 0, y: 0.06, label: "A1" },
  { x: 0, y: -0.02, label: "A2" },
  { x: 0, y: -0.1, label: "A3" },
];

/** World corners of a marker in js-aruco2 order (clockwise from the marker's top-left). */
export function markerCorners(id: number): { x: number; y: number }[] | null {
  const m = BOARD_MARKERS[id];
  if (!m || m.id !== id) return null;
  const h = MARKER_SIZE / 2;
  return [
    { x: m.x - h, y: m.y + h },
    { x: m.x + h, y: m.y + h },
    { x: m.x + h, y: m.y - h },
    { x: m.x - h, y: m.y - h },
  ];
}
