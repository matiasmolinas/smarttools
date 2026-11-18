// 2D navigation HUD shown on the phone docked behind the drill.
// Symbology borrowed from fighter-aircraft HUDs, sized for a job site:
//   boresight reticle (fixed) = where the bit tip is
//   TD box (moves)            = the pencil mark / target
//   wing marker + ASE circle  = tool tilt; inside the circle = square to the surface
//   lock: diamond flashes while acquiring, then holds steady
//   side tapes                = range to wall (left), drilling depth (right)
//   break X                   = abort (tilted while drilling)
// One short command word at the bottom, readable at arm's length.

import {
  ANGLE_TOL_DEG,
  DEPTH_TARGET_MM,
  MARKERS,
  START_GAP,
  TARGETS,
  type SimState,
} from "./sim";
import { SURF, getSurface } from "./surfaces";

const G = "#4dff88"; // HUD phosphor green
const G_DIM = "rgba(77,255,136,0.5)";
const AMB = "#ffc247";
const RED = "#ff5247";
const FONT = 'ui-monospace, "Geist Mono", SFMono-Regular, Menlo, monospace';

export type HudBackground = "grid" | "wall" | "wood" | "camera";
export interface HudOptions {
  background?: HudBackground;
  video?: HTMLVideoElement | null;
}

const LOCK_TIME = 0.7; // s of continuous on-target + square before LOCKED
const DEG_GAIN = 14; // layout units per degree of tilt for the wing marker
const locks = new WeakMap<CanvasRenderingContext2D, { since: number | null; lastT: number }>();

export function drawHud(
  ctx: CanvasRenderingContext2D,
  s: SimState,
  w: number,
  h: number,
  compact = false,
  opts: HudOptions = {},
) {
  const u = Math.min(w, h) / 100;
  const landscape = w > h * 1.15;
  const cx = w / 2;
  const cy = landscape ? h * 0.47 : h * 0.43;

  // zoom: farther = wider view, closer = more px per metre. View is centred on the bit tip.
  const k = 1 - Math.min(1, s.gapMm / 1000 / START_GAP);
  const scale = (Math.min(w, h) / 0.5) * (1 + 5 * k * k);
  const toX = (x: number) => cx + (x - s.tip.x) * scale;
  const toY = (y: number) => cy - (y - s.tip.y) * scale;

  // ---------------- background ----------------
  const bg = opts.background ?? "grid";
  const video = opts.video;
  const camLive = bg === "camera" && !!video && video.readyState >= 2 && video.videoWidth > 0;
  if (camLive) {
    const vw = video!.videoWidth;
    const vh = video!.videoHeight;
    const sc = Math.max(w / vw, h / vh);
    ctx.drawImage(video!, (w - vw * sc) / 2, (h - vh * sc) / 2, vw * sc, vh * sc);
  } else if (bg === "wall" || bg === "wood") {
    const tex = getSurface(bg);
    ctx.fillStyle = bg === "wall" ? "#bdb8ad" : "#8a6440";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    const k2 = scale / SURF.ppm;
    ctx.drawImage(tex, toX(SURF.x0), toY(SURF.y1), tex.width * k2, tex.height * k2);
    drawHoles(ctx, s, toX, toY, scale, true);
  } else {
    drawGridFeed(ctx, s, w, h, u, cx, cy, toX, toY, scale);
  }
  // darken a little so the green symbology pops on any surface
  const vg = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.2, cx, cy, Math.max(w, h) * 0.8);
  vg.addColorStop(0, "rgba(0,0,0,0.15)");
  vg.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
  if (bg === "camera" && !camLive) text(ctx, "NO CAMERA", cx, cy - u * 30, u * 4, AMB, u);

  // ---------------- state ----------------
  let L = locks.get(ctx);
  if (!L) {
    L = { since: null, lastT: s.t };
    locks.set(ctx, L);
  }
  if (s.t < L.lastT) L.since = null;
  L.lastT = s.t;
  const onMark = s.onTarget && s.gapMm < 0.5;
  const square = s.aligned;
  const ok = onMark && square;
  if (ok) L.since ??= s.t;
  else L.since = null;
  const lockAge = L.since == null ? -1 : s.t - L.since;
  const locked = lockAge >= LOCK_TIME;
  const locking = lockAge >= 0 && !locked;
  const blink = Math.floor(s.t * 7) % 2 === 0;
  const breakX = (s.phase === "drill" || s.phase === "hold") && s.depthMm > 0.3 && !square;

  const lw = Math.max(1.5, u * 0.55);

  // ---------------- boresight reticle (fixed = bit tip) ----------------
  const R = u * 15;
  const aseR = ANGLE_TOL_DEG * DEG_GAIN * u;
  const retCol = breakX ? RED : G;
  stroke(ctx, () => {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const long = i % 3 === 0;
      const r0 = R;
      const r1 = R + u * (long ? 3.2 : 1.6);
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
  }, retCol, lw, u);
  // reticle ring: segmented while searching, solid when locked
  stroke(ctx, () => {
    if (locked) ctx.arc(cx, cy, R, 0, Math.PI * 2);
    else
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2 + 0.08;
        const a1 = ((i + 1) / 12) * Math.PI * 2 - 0.08;
        ctx.moveTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
        ctx.arc(cx, cy, R, a0, a1);
      }
  }, retCol, locked ? lw * 1.8 : lw, u);
  // ASE circle (allowed tilt)
  ctx.setLineDash([u * 1.2, u * 1.2]);
  stroke(ctx, () => ctx.arc(cx, cy, aseR, 0, Math.PI * 2), G_DIM, lw * 0.8, u);
  ctx.setLineDash([]);
  // pipper
  fillDot(ctx, cx, cy, u * 1.1, retCol, u);

  // ---------------- TD box (target designator) ----------------
  const tx = toX(s.target.x);
  const ty = toY(s.target.y);
  const margin = u * 12;
  const inView = tx > margin && tx < w - margin && ty > u * 22 && ty < h - u * 30;
  const offPx = Math.hypot(tx - cx, ty - cy);
  if (!onMark) {
    if (inView) {
      const b = u * 5.5;
      stroke(ctx, () => ctx.rect(tx - b, ty - b, b * 2, b * 2), G, lw * 1.2, u);
      // target locator line from reticle to box
      if (offPx > R + b) {
        const a = Math.atan2(ty - cy, tx - cx);
        ctx.setLineDash([u * 1.5, u * 1.5]);
        stroke(ctx, () => {
          ctx.moveTo(cx + Math.cos(a) * (R + u * 3.5), cy + Math.sin(a) * (R + u * 3.5));
          ctx.lineTo(tx - Math.cos(a) * b * 1.3, ty - Math.sin(a) * b * 1.3);
        }, G_DIM, lw * 0.8, u);
        ctx.setLineDash([]);
      }
      text(ctx, TARGETS[s.targetIndex].label, tx + b + u * 1.5, ty - b, u * 3.6, G, u, "left");
    } else {
      // off-screen: clamp to the edge with an arrow
      const a = Math.atan2(ty - cy, tx - cx);
      const ex = Math.min(w - margin, Math.max(margin, cx + Math.cos(a) * w));
      const ey = Math.min(h - u * 30, Math.max(u * 22, cy + Math.sin(a) * h));
      arrow(ctx, ex, ey, a, u * 5, G, u);
    }
  } else if (!breakX) {
    // lock diamond around the pipper: flashes while locking, steady when locked
    if (locked || (locking && blink)) {
      const d = u * 7.5;
      stroke(ctx, () => {
        ctx.moveTo(cx, cy - d);
        ctx.lineTo(cx + d, cy);
        ctx.lineTo(cx, cy + d);
        ctx.lineTo(cx - d, cy);
        ctx.closePath();
      }, G, lw * 1.5, u);
    }
  }

  // ---------------- tilt marker (wing symbol) ----------------
  const maxOff = R * 1.9;
  let mx = -s.yawDeg * DEG_GAIN * u;
  let my = s.pitchDeg * DEG_GAIN * u;
  const mOff = Math.hypot(mx, my);
  const clamped = mOff > maxOff;
  if (clamped) {
    mx = (mx / mOff) * maxOff;
    my = (my / mOff) * maxOff;
  }
  const fx = cx + mx;
  const fy = cy + my;
  const fCol = breakX ? RED : square ? G : AMB;
  const fr = u * 2.4;
  stroke(ctx, () => {
    ctx.moveTo(fx + fr, fy);
    ctx.arc(fx, fy, fr, 0, Math.PI * 2);
    ctx.moveTo(fx - fr, fy);
    ctx.lineTo(fx - fr - u * 4, fy);
    ctx.moveTo(fx + fr, fy);
    ctx.lineTo(fx + fr + u * 4, fy);
    ctx.moveTo(fx, fy - fr);
    ctx.lineTo(fx, fy - fr - u * 2.6);
  }, fCol, lw * 1.2, u);
  if (clamped && blink) text(ctx, "×", fx, fy + u * 5.5, u * 4, fCol, u);

  // break X
  if (breakX) {
    const x = R * 1.25;
    stroke(ctx, () => {
      ctx.moveTo(cx - x, cy - x);
      ctx.lineTo(cx + x, cy + x);
      ctx.moveTo(cx + x, cy - x);
      ctx.lineTo(cx - x, cy + x);
    }, RED, lw * 3, u);
  }

  // ---------------- top: angle box ----------------
  const angle = 90 - s.angleErrDeg;
  const topY = u * (landscape ? 9 : 10);
  const angCol = breakX ? RED : square ? G : AMB;
  const boxW = u * 30;
  const boxH = u * 10;
  stroke(ctx, () => ctx.rect(cx - boxW / 2, topY - boxH / 2, boxW, boxH), angCol, lw, u);
  text(ctx, `${angle.toFixed(1)}°`, cx, topY, u * 7.5, angCol, u);
  text(ctx, `Δ ${s.angleErrDeg.toFixed(1)}°`, cx, topY + boxH / 2 + u * 3.6, u * 3.6, G_DIM, u);

  // corner status
  text(ctx, s.live ? "IMU" : "SIM", u * 4, u * 5, u * 3.4, s.live ? G : G_DIM, u, "left");
  text(ctx, `TGT ${TARGETS[s.targetIndex].label}`, w - u * 4, u * 5, u * 3.4, G_DIM, u, "right");

  // ---------------- side tapes ----------------
  const tapeTop = cy - u * 24;
  const tapeBot = cy + u * 24;
  const tapeL = landscape ? u * 10 : u * 7;
  const tapeR = w - tapeL;
  // left: range to wall (0..START_GAP mm, 0 at bottom)
  const gapMax = START_GAP * 1000;
  const gapFrac = Math.min(1, s.gapMm / gapMax);
  stroke(ctx, () => {
    ctx.moveTo(tapeL, tapeTop);
    ctx.lineTo(tapeL, tapeBot);
    for (let i = 0; i <= 10; i++) {
      const y = tapeBot - ((tapeBot - tapeTop) * i) / 10;
      ctx.moveTo(tapeL, y);
      ctx.lineTo(tapeL + u * (i % 5 === 0 ? 3 : 1.6), y);
    }
  }, G_DIM, lw * 0.8, u);
  const gy = tapeBot - (tapeBot - tapeTop) * gapFrac;
  caret(ctx, tapeL + u * 3.5, gy, 1, G, u);
  text(ctx, "RNG", tapeL, tapeTop - u * 4, u * 3.2, G_DIM, u, "left");
  text(ctx, s.gapMm > 0.5 ? `${s.gapMm.toFixed(0)}` : "0", tapeL + u * 7, gy, u * 4.4, G, u, "left");

  // right: depth (0 at top, grows down) with staple at target
  const dMax = DEPTH_TARGET_MM * 1.15;
  const dy = (mm: number) => tapeTop + ((tapeBot - tapeTop) * Math.min(mm, dMax)) / dMax;
  stroke(ctx, () => {
    ctx.moveTo(tapeR, tapeTop);
    ctx.lineTo(tapeR, tapeBot);
    for (let mm = 0; mm <= dMax; mm += 5) {
      ctx.moveTo(tapeR, dy(mm));
      ctx.lineTo(tapeR - u * (mm % 10 === 0 ? 3 : 1.6), dy(mm));
    }
  }, G_DIM, lw * 0.8, u);
  // target staple
  const sy = dy(DEPTH_TARGET_MM);
  stroke(ctx, () => {
    ctx.moveTo(tapeR + u * 1, sy - u * 2);
    ctx.lineTo(tapeR + u * 2.5, sy - u * 2);
    ctx.lineTo(tapeR + u * 2.5, sy + u * 2);
    ctx.lineTo(tapeR + u * 1, sy + u * 2);
  }, G, lw, u);
  // fill + caret
  const depthCol = s.depthMm >= DEPTH_TARGET_MM - 0.05 ? RED : G;
  if (s.depthMm > 0.05) {
    ctx.fillStyle = depthCol === RED ? "rgba(255,82,71,0.45)" : "rgba(77,255,136,0.35)";
    ctx.fillRect(tapeR - u * 1.2, tapeTop, u * 1.2, dy(s.depthMm) - tapeTop);
  }
  caret(ctx, tapeR - u * 3.5, dy(s.depthMm), -1, depthCol, u);
  text(ctx, "DEPTH", tapeR, tapeTop - u * 4, u * 3.2, G_DIM, u, "right");
  text(ctx, s.depthMm.toFixed(1), tapeR - u * 7, dy(s.depthMm), u * 4.4, depthCol, u, "right");
  text(ctx, `${DEPTH_TARGET_MM}`, tapeR - u * 4, sy + u * 4.5, u * 3, G_DIM, u, "right");

  // ---------------- command cue ----------------
  const cmd = command(s, { onMark, square, locked, locking, breakX, tx, ty, cx, cy, fx, fy });
  const cmdY = h - u * (landscape ? 14 : 17);
  const cmdSize = u * (compact ? 10 : 11);
  const show = !cmd.blink || blink;
  if (show) {
    ctx.font = `800 ${cmdSize}px ${FONT}`;
    const tw = ctx.measureText(cmd.word).width;
    const aw = cmd.arrow != null ? cmdSize * 0.9 : 0;
    const startX = cx - (tw + aw) / 2;
    text(ctx, cmd.word, startX + tw / 2, cmdY, cmdSize, cmd.color, u, "center", 800);
    if (cmd.arrow != null) arrow(ctx, startX + tw + aw * 0.6, cmdY, cmd.arrow, cmdSize * 0.38, cmd.color, u);
  }
  if (cmd.sub) text(ctx, cmd.sub, cx, cmdY + cmdSize * 0.85, u * 4.6, cmd.subColor ?? G, u);
  text(ctx, cmd.step, cx, cmdY - cmdSize * 0.95, u * 3.4, G_DIM, u);
}

// ---------------- command logic ----------------
interface Cue {
  word: string;
  arrow?: number;
  sub?: string;
  subColor?: string;
  color: string;
  blink?: boolean;
  step: string;
}

function command(
  s: SimState,
  c: { onMark: boolean; square: boolean; locked: boolean; locking: boolean; breakX: boolean; tx: number; ty: number; cx: number; cy: number; fx: number; fy: number },
): Cue {
  const label = TARGETS[s.targetIndex].label;
  if (c.breakX) return { word: "BREAK", color: RED, blink: true, sub: "STOP · SQUARE UP", subColor: RED, step: "3/3 DRILL" };
  if (s.phase === "hold") return { word: "STOP", color: RED, sub: `${s.depthMm.toFixed(1)} MM ✓`, step: "3/3 DRILL" };
  if (s.phase === "retract") return { word: "NEXT", color: G, sub: `→ ${label}`, step: "DONE ✓" };
  if (s.phase === "drill" || (c.locked && s.depthMm > 0)) {
    const left = DEPTH_TARGET_MM - s.depthMm;
    if (left < 3) return { word: "SLOW", color: AMB, sub: `${left.toFixed(1)} MM`, step: "3/3 DRILL" };
    return { word: "DRILL", color: G, sub: `${left.toFixed(0)} MM TO GO`, step: "3/3 DRILL" };
  }
  if (!c.onMark) {
    if (s.offsetMm > 1) {
      return { word: "AIM", color: AMB, arrow: Math.atan2(c.ty - c.cy, c.tx - c.cx), sub: `${s.offsetMm.toFixed(0)} MM`, step: "1/3 AIM" };
    }
    return { word: "TOUCH", color: AMB, sub: `${s.gapMm.toFixed(0)} MM`, step: "1/3 AIM" };
  }
  if (!c.square) {
    // move the handle so the wing marker goes into the circle
    return { word: "HANDLE", color: AMB, arrow: Math.atan2(c.cy - c.fy, c.cx - c.fx), sub: `${s.angleErrDeg.toFixed(1)}°`, step: "2/3 SQUARE" };
  }
  if (c.locking) return { word: "HOLD", color: G, blink: true, sub: "LOCKING", step: "2/3 SQUARE" };
  return { word: "LOCKED", color: G, sub: "PULL TRIGGER", step: "2/3 SQUARE" };
}

// ---------------- drawing helpers ----------------
function stroke(ctx: CanvasRenderingContext2D, path: () => void, color: string, width: number, u: number) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.lineWidth = width + u * 0.9;
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.shadowColor = color;
  ctx.shadowBlur = u * 1.2;
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function fillDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, u: number) {
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.beginPath();
  ctx.arc(x, y, r + u * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function text(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  size: number,
  color: string,
  u: number,
  align: CanvasTextAlign = "center",
  weight = 700,
) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.lineWidth = Math.max(2, size * 0.2);
  ctx.strokeText(str, x, y);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = u * 0.8;
  ctx.fillText(str, x, y);
  ctx.shadowBlur = 0;
}

function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, size: number, color: string, u: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.7, -size * 0.8);
  ctx.lineTo(-size * 0.3, 0);
  ctx.lineTo(-size * 0.7, size * 0.8);
  ctx.closePath();
  ctx.lineWidth = u * 0.9;
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = u;
  ctx.fill();
  ctx.restore();
}

function caret(ctx: CanvasRenderingContext2D, x: number, y: number, dir: 1 | -1, color: string, u: number) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + dir * u * 2.6, y - u * 1.8);
  ctx.lineTo(x + dir * u * 2.6, y + u * 1.8);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawHoles(
  ctx: CanvasRenderingContext2D,
  s: SimState,
  toX: (x: number) => number,
  toY: (y: number) => number,
  scale: number,
  real: boolean,
) {
  TARGETS.forEach((t, i) => {
    if (!s.drilled[i]) return;
    const X = toX(t.x);
    const Y = toY(t.y);
    const r = Math.max(2, 0.004 * scale);
    if (real) {
      ctx.fillStyle = "rgba(225,200,160,0.55)";
      ctx.beginPath();
      ctx.arc(X, Y, r * 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
    const g = ctx.createRadialGradient(X, Y, 0, X, Y, r);
    g.addColorStop(0, "#000");
    g.addColorStop(1, real ? "#2a1d12" : "#050607");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(X, Y, r, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawGridFeed(
  ctx: CanvasRenderingContext2D,
  s: SimState,
  w: number,
  h: number,
  u: number,
  cx: number,
  cy: number,
  toX: (x: number) => number,
  toY: (y: number) => number,
  scale: number,
) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
  g.addColorStop(0, "#1c2420");
  g.addColorStop(1, "#070a09");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(77,255,136,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = -1; gx <= 1.001; gx += 0.05) {
    const X = toX(gx);
    if (X < -2 || X > w + 2) continue;
    ctx.moveTo(X, 0);
    ctx.lineTo(X, h);
  }
  for (let gy = -1; gy <= 1.001; gy += 0.05) {
    const Y = toY(gy);
    if (Y < -2 || Y > h + 2) continue;
    ctx.moveTo(0, Y);
    ctx.lineTo(w, Y);
  }
  ctx.stroke();

  for (const m of MARKERS) {
    const X = toX(m.x);
    const Y = toY(m.y);
    const sz = 0.06 * scale;
    if (X < -sz || X > w + sz || Y < -sz || Y > h + sz) continue;
    ctx.fillStyle = "rgba(240,240,240,0.85)";
    ctx.fillRect(X - sz / 2, Y - sz / 2, sz, sz);
    ctx.fillStyle = "#111";
    const c = sz / 6;
    const pattern = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0];
    for (let i = 0; i < 16; i++) {
      if (pattern[i]) ctx.fillRect(X - sz / 2 + c * (1 + (i % 4)), Y - sz / 2 + c * (1 + Math.floor(i / 4)), c, c);
    }
  }

  TARGETS.forEach((t, i) => {
    if (s.drilled[i]) return;
    const X = toX(t.x);
    const Y = toY(t.y);
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = Math.max(1, u * 0.3);
    ctx.beginPath();
    ctx.moveTo(X - u * 2, Y);
    ctx.lineTo(X + u * 2, Y);
    ctx.moveTo(X, Y - u * 2);
    ctx.lineTo(X, Y + u * 2);
    ctx.stroke();
  });
  drawHoles(ctx, s, toX, toY, scale, false);
}
