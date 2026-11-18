// Printable A4 marker sheet. World frame = the sheet: origin at its centre, X right, Y up, Z out of the
// surface toward the user (metres). Holes are planned relative to the printed markers.

export const SHEET = { w: 0.21, h: 0.297 };
export const DICTIONARY = "ARUCO_MIP_36h12";
export const MARKER_SIZE = 0.04; // black square edge, metres (8 x 5 mm cells)

export const BOARD_MARKERS: { id: number; x: number; y: number }[] = [
  { id: 0, x: -0.07, y: 0.115 },
  { id: 1, x: 0.07, y: 0.115 },
  { id: 2, x: -0.07, y: 0 },
  { id: 3, x: 0.07, y: 0 },
  { id: 4, x: -0.07, y: -0.115 },
  { id: 5, x: 0.07, y: -0.115 },
];

export const BOARD_TARGETS = [
  { x: 0, y: 0.08, label: "A1" },
  { x: 0, y: 0, label: "A2" },
  { x: 0, y: -0.08, label: "A3" },
];

/** World corners of a marker in js-aruco2 order (clockwise from the marker's top-left). */
export function markerCorners(id: number): { x: number; y: number }[] | null {
  const m = BOARD_MARKERS.find((b) => b.id === id);
  if (!m) return null;
  const h = MARKER_SIZE / 2;
  return [
    { x: m.x - h, y: m.y + h },
    { x: m.x + h, y: m.y + h },
    { x: m.x + h, y: m.y - h },
    { x: m.x - h, y: m.y - h },
  ];
}
