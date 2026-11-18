// Sub-pixel marker corners: fit a line to each side of the black square (50% intensity crossing
// between black border and white quiet zone), then intersect adjacent sides.

export interface Gray {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

function sample(img: Gray, x: number, y: number): number {
  const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5);
  const fx = x - 0.5 - x0, fy = y - 0.5 - y0;
  const g = (xx: number, yy: number) => {
    const cx = Math.min(img.width - 1, Math.max(0, xx));
    const cy = Math.min(img.height - 1, Math.max(0, yy));
    const i = (cy * img.width + cx) * 4;
    return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  };
  return (
    g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy
  );
}

type P = { x: number; y: number };

export function refineCorners(img: Gray, corners: P[]): P[] {
  // js-aruco2 corners are indices of the boundary black pixels: use pixel centres
  const c = corners.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
  const mx = c.reduce((s, p) => s + p.x, 0) / 4;
  const my = c.reduce((s, p) => s + p.y, 0) / 4;
  const side = (Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) + Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y)) / 2;
  const reach = Math.max(1.5, Math.min(4, side / 8 * 0.45)); // stay inside the 1-cell black border
  const lines: { px: number; py: number; dx: number; dy: number }[] = [];
  for (let s = 0; s < 4; s++) {
    const a = c[s], b = c[(s + 1) % 4];
    let dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 4) return corners;
    dx /= L; dy /= L;
    let nx = -dy, ny = dx;
    const midx = (a.x + b.x) / 2, midy = (a.y + b.y) / 2;
    if ((midx - mx) * nx + (midy - my) * ny < 0) { nx = -nx; ny = -ny; } // outward
    const pts: P[] = [];
    for (let k = 0; k < 14; k++) {
      const tt = 0.18 + (0.64 * k) / 13;
      const ox = a.x + (b.x - a.x) * tt, oy = a.y + (b.y - a.y) * tt;
      const inV = sample(img, ox - nx * reach, oy - ny * reach);
      const outV = sample(img, ox + nx * reach, oy + ny * reach);
      if (outV - inV < 25) continue; // weak edge
      const mid = (inV + outV) / 2;
      let prevS = -reach, prevV = inV, found: number | null = null;
      for (let sd = -reach + 0.1; sd <= reach + 1e-9; sd += 0.1) {
        const v = sample(img, ox + nx * sd, oy + ny * sd);
        if (prevV < mid && v >= mid) {
          found = prevS + ((mid - prevV) / (v - prevV)) * (sd - prevS);
          break;
        }
        prevS = sd; prevV = v;
      }
      if (found != null) pts.push({ x: ox + nx * found, y: oy + ny * found });
    }
    if (pts.length < 5) return corners;
    // least-squares line through pts (PCA)
    const qx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const qy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { sxx += (p.x - qx) ** 2; sxy += (p.x - qx) * (p.y - qy); syy += (p.y - qy) ** 2; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push({ px: qx, py: qy, dx: Math.cos(th), dy: Math.sin(th) });
  }
  const out: P[] = [];
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4], l2 = lines[i]; // corner i joins side i-1 and side i
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-6) return corners;
    const tt = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
    const p = { x: l1.px + l1.dx * tt, y: l1.py + l1.dy * tt };
    if (Math.hypot(p.x - c[i].x, p.y - c[i].y) > 3) return corners; // sanity
    out.push(p);
  }
  return out;
}
