// The phone screen over the live camera, made to be read at a glance while holding a drill (/hud, camera views).
//   - one banner at the TOP, like a GPS: a big arrow and one instruction ("A2 · 121 mm", "Touch down",
//     "Tilt · 1.8°", "Drill · 12 mm left"); the bottom of the screen, where the tip is, stays clear
//   - the calibrated TIP drawn where it falls in the image: it never moves (the camera is fixed to the drill),
//     so it must sit on the real tip: the best check of the calibration
//   - markers the camera reads are covered in white: you know they are seen, and they stop cluttering
//   - thick lines; a big arrow from the tip to the mark; a bubble level for the tilt near the mark
//   - the video zooms in around the tip as it gets close to the mark
// The gallery and the simulated surfaces keep lib/hud.ts.

import type { SimState } from "./sim";
import type { Overlay } from "./hud";
import { DEPTH_TARGET_MM } from "./sim";

type P = { x: number; y: number };

const GREEN = "#3ee59b", AMBER = "#ffb547", RED = "#ff5a5a", WHITE = "#f5f8fc", CYAN = "#5ad8ff";
const SANS = "Geist, system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, monospace";

const zooms = new WeakMap<CanvasRenderingContext2D, { z: number; c: P | null; last: number }>();

export interface GuideOptions {
  video: HTMLVideoElement | HTMLCanvasElement;
  overlay: Overlay;
  /** the tool is calibrated (the tip can be drawn) */
  toolCalibrated: boolean;
  /** false while a sheet (setup, menu, job) covers the top: the banner would show through it */
  banner?: boolean;
}

export function drawGuide(ctx: CanvasRenderingContext2D, s: SimState, w: number, h: number, o: GuideOptions) {
  const ov = o.overlay;
  const u = Math.min(w, h) / 100;
  const lw = Math.max(3, u * 0.9); // thick lines
  const now = performance.now() / 1000;

  // ---------- video, zoomed around the tip near the mark ----------
  const isVideo = typeof HTMLVideoElement !== "undefined" && o.video instanceof HTMLVideoElement;
  const vw = isVideo ? (o.video as HTMLVideoElement).videoWidth : o.video.width;
  const vh = isVideo ? (o.video as HTMLVideoElement).videoHeight : o.video.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  if (!vw || !vh) return;
  const sc0 = Math.max(w / vw, h / vh);
  const offX0 = (w - vw * sc0) / 2, offY0 = (h - vh * sc0) / 2;
  const base = (p: P): P => ({ x: offX0 + p.x * sc0, y: offY0 + p.y * sc0 });
  const tracking = !ov.lost;
  const near = tracking && o.toolCalibrated && s.offsetMm < 25 && s.gapMm < 25 && s.phase !== "retract";
  const zs = zooms.get(ctx) ?? { z: 1, c: null, last: now };
  const dt = Math.min(0.1, now - zs.last);
  zs.last = now;
  const zTarget = near ? (s.offsetMm < 6 && s.gapMm < 6 ? 2.6 : 1.8) : 1;
  zs.z += (zTarget - zs.z) * Math.min(1, dt * 3);
  const tip0 = ov.tipPx ? base(ov.tipPx) : null;
  if (tip0) zs.c = tip0;
  zooms.set(ctx, zs);
  // scale about the tip, and bring it up towards 60 % of the height as it zooms (it sits low in the image),
  // so the area all around the tip is in view
  const zc = zs.c ?? { x: w / 2, y: h * 0.7 };
  const Z = zs.z;
  const k = Math.min(1, Math.max(0, (Z - 1) / 1.6));
  const goal = { x: zc.x + (w / 2 - zc.x) * k, y: zc.y + (h * 0.6 - zc.y) * k };
  // never past the video's edges: the image always covers the screen
  const edge = (p: P) => ({ x: goal.x + (base(p).x - zc.x) * Z, y: goal.y + (base(p).y - zc.y) * Z });
  const tl0 = edge({ x: 0, y: 0 }), br0 = edge({ x: vw, y: vh });
  if (tl0.x > 0) goal.x -= tl0.x;
  else if (br0.x < w) goal.x += w - br0.x;
  if (tl0.y > 0) goal.y -= tl0.y;
  else if (br0.y < h) goal.y += h - br0.y;
  const map = (p: P): P => {
    const b = base(p);
    return { x: goal.x + (b.x - zc.x) * Z, y: goal.y + (b.y - zc.y) * Z };
  };
  const tl = map({ x: 0, y: 0 });
  ctx.drawImage(o.video, tl.x, tl.y, vw * sc0 * Z, vh * sc0 * Z);

  // ---------- markers it reads: covered in white ----------
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  for (const q of ov.quads) {
    const m = q.map(map);
    ctx.beginPath();
    ctx.moveTo(m[0].x, m[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(m[i].x, m[i].y);
    ctx.closePath();
    ctx.fill();
  }

  const tip = ov.tipPx ? map(ov.tipPx) : null;
  const mark = ov.mark && tracking ? map(ov.mark) : null;
  const drilling = s.phase === "drill" || s.phase === "hold";
  const tol = ov.tolDeg ?? 0.5;
  const square = s.angleErrDeg <= tol;
  const onMark = s.offsetMm < 1.0;
  const touching = s.gapMm < 0.6;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(0,0,0,0.7)";
  ctx.shadowBlur = u * 1.2;

  // ---------- the mark (where the hole goes) ----------
  if (mark && s.phase !== "hold") {
    const r = u * 3.2;
    stroke(ctx, lw, onMark ? GREEN : WHITE, () => {
      ctx.arc(mark.x, mark.y, r, 0, Math.PI * 2);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(mark.x + dx * r * 1.5, mark.y + dy * r * 1.5);
        ctx.lineTo(mark.x + dx * r * 2.6, mark.y + dy * r * 2.6);
      }
    });
    if (!onMark) text(ctx, s.label, mark.x + r * 2.9, mark.y - r * 1.6, u * 5.5, WHITE, "left", 700);
  }

  // ---------- the calibrated bit and TIP: fixed in the image ----------
  if (tip && o.toolCalibrated) {
    const bit = ov.bitPx ? map(ov.bitPx) : null;
    if (bit) stroke(ctx, lw * 1.2, CYAN, () => (ctx.moveTo(bit.x, bit.y), ctx.lineTo(tip.x, tip.y)), 0.8);
    const r = u * 2.4;
    stroke(ctx, lw, CYAN, () => {
      ctx.moveTo(tip.x - r * 2.2, tip.y);
      ctx.lineTo(tip.x - r * 0.6, tip.y);
      ctx.moveTo(tip.x + r * 0.6, tip.y);
      ctx.lineTo(tip.x + r * 2.2, tip.y);
      ctx.moveTo(tip.x, tip.y - r * 2.2);
      ctx.lineTo(tip.x, tip.y - r * 0.6);
      ctx.moveTo(tip.x, tip.y + r * 0.6);
      ctx.lineTo(tip.x, tip.y + r * 2.2);
    });
    if (!near) text(ctx, "TIP", tip.x + r * 2.6, tip.y + u * 1.6, u * 3.6, CYAN, "left", 700);

    // ---------- arrow from the tip to the mark ----------
    if (mark && !onMark && !drilling) {
      const d = Math.hypot(mark.x - tip.x, mark.y - tip.y);
      if (d > u * 8) arrow(ctx, tip, mark, lw * 1.6, AMBER, u * 4, u * 5);
    }

    // ---------- the tilt, as a bubble level around the tip ----------
    if (tracking && (onMark || drilling) && s.phase !== "hold") {
      const R = u * 11;
      const gain = R / Math.max(4 * tol, 2);
      let dx = -s.yawDeg * gain, dy = s.pitchDeg * gain;
      const l = Math.hypot(dx, dy);
      if (l > R) (dx *= R / l), (dy *= R / l);
      const col = square ? GREEN : drilling ? RED : AMBER;
      stroke(ctx, lw, "rgba(255,255,255,0.75)", () => ctx.arc(tip.x, tip.y, R, 0, Math.PI * 2));
      stroke(ctx, lw, col, () => ctx.arc(tip.x, tip.y, (R * tol) / Math.max(4 * tol, 2), 0, Math.PI * 2));
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(tip.x + dx, tip.y + dy, u * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---------- depth while drilling ----------
    if (drilling) {
      const D = s.depthTargetMm ?? DEPTH_TARGET_MM;
      const frac = Math.max(0, Math.min(1, s.depthMm / D));
      const R = u * 14.5;
      stroke(ctx, lw * 1.4, "rgba(255,255,255,0.25)", () => ctx.arc(tip.x, tip.y, R, 0, Math.PI * 2));
      stroke(ctx, lw * 1.6, frac > 0.97 ? RED : GREEN, () => ctx.arc(tip.x, tip.y, R, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2));
    }
  }
  ctx.restore();

  // ---------- the banner: one instruction, at the top ----------
  if (o.banner === false) return;
  const b = banner(s, ov, { tip, mark, onMark, touching, square, drilling, tol, calibrated: o.toolCalibrated });
  const bx = u * 3, by = u * 3, bw = w - u * 6 - u * 15, bh = u * 23;
  ctx.fillStyle = "rgba(6,9,13,0.72)";
  roundRect(ctx, bx, by, bw, bh, u * 3.5);
  ctx.fill();
  ctx.fillStyle = b.color;
  roundRect(ctx, bx, by, u * 1.4, bh, u * 0.7);
  ctx.fill();
  // the icon: an arrow (direction), a down arrow, a level, a check or a stop
  const ic = { x: bx + u * 12.5, y: by + bh / 2 };
  icon(ctx, b.icon, ic, u * 7.5, b.color, b.angle ?? 0, lw * 1.4);
  const tx = bx + u * 23;
  text(ctx, b.title, tx, by + bh * 0.44, u * 6.8, WHITE, "left", 700, bw - u * 25);
  text(ctx, b.sub, tx, by + bh * 0.78, u * 4.4, "rgba(245,248,252,0.8)", "left", 500, bw - u * 25);
  // a small status dot in the banner's corner: green when the pose is good
  ctx.fillStyle = !tracking ? RED : (ov.markers ?? 0) < 4 ? AMBER : GREEN;
  ctx.beginPath();
  ctx.arc(bx + bw - u * 2.6, by + u * 2.6, u * 1.1, 0, Math.PI * 2);
  ctx.fill();
}

type Icon = "arrow" | "down" | "level" | "drill" | "check" | "stop" | "search" | "setup";

function banner(
  s: SimState,
  ov: Overlay,
  c: { tip: P | null; mark: P | null; onMark: boolean; touching: boolean; square: boolean; drilling: boolean; tol: number; calibrated: boolean },
): { title: string; sub: string; color: string; icon: Icon; angle?: number } {
  const D = s.depthTargetMm ?? DEPTH_TARGET_MM;
  if (ov.calibrating) return { title: "Calibrating", sub: `${ov.calibrating.text} · ${Math.round(ov.calibrating.progress * 100)} %`, color: AMBER, icon: "setup" };
  if (ov.alarms && ov.alarms & 16) return { title: "STOP · no-go", sub: "a pipe or cable is close: back out", color: RED, icon: "stop" };
  if (ov.alarms && ov.alarms & 8) return { title: "STOP · moved", sub: "the part moved: re-clamp, back out", color: RED, icon: "stop" };
  if (ov.lost) return { title: "Find the sheet", sub: "point the camera at the markers", color: AMBER, icon: "search" };
  if (!c.calibrated) return { title: "Run Setup", sub: "menu ☰ → Setup: lens, tip, check", color: AMBER, icon: "setup" };
  if ((ov.markers ?? 0) < 4) return { title: "More markers", sub: `only ${ov.markers ?? 0} seen: more sheet in front of the bit`, color: AMBER, icon: "search" };
  if (s.phase === "hold") return { title: `Stop · ${D} mm ✓`, sub: `${s.depthMm.toFixed(1)} mm · ${s.angleErrDeg.toFixed(1)}° off`, color: GREEN, icon: "check" };
  if (s.phase === "retract") return { title: "Done ✓", sub: `pull out · hole ${s.label} saved`, color: GREEN, icon: "check" };
  if (c.drilling) {
    if (!c.square) return { title: `Tilt · ${s.angleErrDeg.toFixed(1)}°`, sub: "straighten: dot into the small circle", color: RED, icon: "level" };
    const left = D - s.depthMm;
    if (left < 3) return { title: "Ease off", sub: `stop at ${D} mm`, color: AMBER, icon: "drill" };
    return { title: `Drill · ${Math.max(0, left).toFixed(0)} mm`, sub: `to go · ${s.depthMm.toFixed(1)} of ${D} mm`, color: GREEN, icon: "drill" };
  }
  if (!c.onMark) {
    const angle = c.tip && c.mark ? Math.atan2(c.mark.y - c.tip.y, c.mark.x - c.tip.x) : -Math.PI / 2;
    const dist = Math.hypot(s.offsetMm, Math.max(0, s.gapMm));
    return { title: `${s.label} · ${dist < 10 ? dist.toFixed(1) : dist.toFixed(0)} mm`, sub: "move the tip to the cross", color: AMBER, icon: "arrow", angle };
  }
  if (!c.touching) return { title: "Touch down", sub: `${s.gapMm.toFixed(0)} mm above: rest the tip on the cross`, color: AMBER, icon: "down" };
  if (!c.square) return { title: `Tilt · ${s.angleErrDeg.toFixed(1)}°`, sub: "bring the dot into the small circle", color: AMBER, icon: "level" };
  if (ov.gate && !ov.gate.ready) return { title: "Hold still", sub: ov.gate.message ?? "", color: AMBER, icon: "level" };
  return { title: "Drill ✓", sub: `square ±${c.tol}° · on the mark`, color: GREEN, icon: "check" };
}

// ---------- drawing helpers ----------

function stroke(ctx: CanvasRenderingContext2D, width: number, color: string, path: () => void, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function text(ctx: CanvasRenderingContext2D, t: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign, weight = 600, maxW?: number) {
  ctx.font = `${weight} ${size}px ${SANS}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = size * 0.25;
  let s = t;
  if (maxW) while (s.length > 3 && ctx.measureText(s).width > maxW) s = s.slice(0, -2) + "…";
  ctx.fillText(s, x, y);
  ctx.shadowBlur = 0;
}

function arrow(ctx: CanvasRenderingContext2D, a: P, b: P, width: number, color: string, gapA: number, gapB: number) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const s = { x: a.x + Math.cos(ang) * gapA * 2, y: a.y + Math.sin(ang) * gapA * 2 };
  const e = { x: b.x - Math.cos(ang) * gapB * 1.6, y: b.y - Math.sin(ang) * gapB * 1.6 };
  const head = width * 3;
  stroke(ctx, width, color, () => {
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
    ctx.moveTo(e.x - Math.cos(ang - 0.5) * head, e.y - Math.sin(ang - 0.5) * head);
    ctx.lineTo(e.x, e.y);
    ctx.lineTo(e.x - Math.cos(ang + 0.5) * head, e.y - Math.sin(ang + 0.5) * head);
  });
}

function icon(ctx: CanvasRenderingContext2D, kind: Icon, c: P, r: number, color: string, angle: number, lw: number) {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  if (kind === "arrow") {
    // a GPS turn arrow pointing the way to go
    ctx.rotate(angle);
    ctx.moveTo(-r * 0.8, 0);
    ctx.lineTo(r * 0.7, 0);
    ctx.moveTo(r * 0.15, -r * 0.55);
    ctx.lineTo(r * 0.75, 0);
    ctx.lineTo(r * 0.15, r * 0.55);
  } else if (kind === "down") {
    ctx.moveTo(0, -r * 0.8);
    ctx.lineTo(0, r * 0.5);
    ctx.moveTo(-r * 0.5, 0);
    ctx.lineTo(0, r * 0.55);
    ctx.lineTo(r * 0.5, 0);
    ctx.moveTo(-r * 0.7, r * 0.85);
    ctx.lineTo(r * 0.7, r * 0.85);
  } else if (kind === "level") {
    ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
    ctx.moveTo(r * 0.3, 0);
    ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
  } else if (kind === "check") {
    ctx.moveTo(-r * 0.6, 0);
    ctx.lineTo(-r * 0.15, r * 0.45);
    ctx.lineTo(r * 0.65, -r * 0.45);
  } else if (kind === "stop") {
    ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
    ctx.moveTo(-r * 0.4, -r * 0.4);
    ctx.lineTo(r * 0.4, r * 0.4);
    ctx.moveTo(r * 0.4, -r * 0.4);
    ctx.lineTo(-r * 0.4, r * 0.4);
  } else if (kind === "drill") {
    ctx.moveTo(0, -r * 0.85);
    ctx.lineTo(0, r * 0.85);
    ctx.moveTo(-r * 0.35, r * 0.4);
    ctx.lineTo(0, r * 0.85);
    ctx.lineTo(r * 0.35, r * 0.4);
  } else if (kind === "search") {
    ctx.arc(-r * 0.15, -r * 0.15, r * 0.5, 0, Math.PI * 2);
    ctx.moveTo(r * 0.22, r * 0.22);
    ctx.lineTo(r * 0.75, r * 0.75);
  } else {
    // setup: a crosshair
    ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(dx * r * 0.6, dy * r * 0.6);
      ctx.lineTo(dx * r * 0.95, dy * r * 0.95);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
