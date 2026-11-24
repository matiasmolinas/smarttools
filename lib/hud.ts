// 2D guide shown on the phone docked behind the drill.
// Calm, minimal symbology that leaves the work area visible:
//   mark       = where the hole / screw goes (moves with the camera image)
//   tip ring   = the bit tip (fixed: the camera is rigid with the tool)
//   chuck ring = the back of the bit; its offset from the tip ring is the tilt
// Rings centred on the mark = on target and square. Only what the current Athos step needs is shown.

import {
  ANGLE_TOL_DEG,
  DEPTH_TARGET_MM,
  MARKERS,
  START_GAP,
  TARGETS,
  type SimState,
} from "./sim";
import { SURF, getSurface } from "./surfaces";
import type { PilotOverlay } from "./pilotnav";

const WHITE = "rgba(245,248,252,0.95)";
const SOFT = "rgba(245,248,252,0.6)";
const GREEN = "#3ee59b";
const AMBER = "#ffb84d";
const RED = "#ff5c50";
const SANS = '"Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export type HudBackground = "grid" | "wall" | "wood" | "camera";
export interface Overlay {
  lost: boolean;
  aim: { x: number; y: number } | null; // video px: where the bit axis meets the surface
  mark: { x: number; y: number } | null; // video px: the planned hole
  quads: { x: number; y: number }[][]; // video px: detected markers
  info: string;
  /** the engine's go / no-go gate (lib/navpipeline.ts) */
  gate?: { ready: boolean; message: string | null; locking?: boolean };
  /** a calibration capture in progress */
  calibrating?: { text: string; progress: number; count: number } | null;
  /** the engine's safety alarms (bits, lib/engine.ts ALARMS) */
  alarms?: number;
  /** guidance hints on the part (lib/guidance.ts): out of order, material left */
  hint?: string | null;
  /** markers used in the last pose (few = a weak pose: say so) */
  markers?: number;
  /** the angle tolerance in use, deg (the specification, or a wider practice setting) */
  tolDeg?: number;
  /** video px: where the calibrated tip falls in the image (fixed: the camera is fixed to the drill), and a point up the bit */
  tipPx?: { x: number; y: number } | null;
  bitPx?: { x: number; y: number } | null;
  /** the pilot job (lib/pilotnav.ts): the sheet, the block, its corners and the screws, in the same video px */
  pilot?: PilotOverlay;
}
export interface HudOptions {
  background?: HudBackground;
  /** live camera <video>, or a <canvas> with simulated camera frames */
  video?: HTMLVideoElement | HTMLCanvasElement | null;
  overlay?: Overlay | null;
}

const LOCK_TIME = 0.75; // s of continuous on-mark + square before "ready"
const TILT_GAIN = 7; // layout units of chuck-ring offset per degree
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
  const cx = landscape ? w * 0.44 : w / 2;
  const cy = landscape ? h * 0.44 : h * 0.42;

  // view follows the tool (camera rigid with the drill); closer = more zoom
  const k = 1 - Math.min(1, s.gapMm / 1000 / START_GAP);
  const scale = (Math.min(w, h) / 0.5) * (1 + 5 * k * k);
  const toX = (x: number) => cx + (x - s.tip.x) * scale;
  const toY = (y: number) => cy - (y - s.tip.y) * scale;

  // ---------- background ----------
  const bg = opts.background ?? "grid";
  const video = opts.video;
  const isVideo = typeof HTMLVideoElement !== "undefined" && video instanceof HTMLVideoElement;
  const srcW = !video ? 0 : isVideo ? (video as HTMLVideoElement).videoWidth : video.width;
  const srcH = !video ? 0 : isVideo ? (video as HTMLVideoElement).videoHeight : video.height;
  const camLive = bg === "camera" && !!video && (!isVideo || (video as HTMLVideoElement).readyState >= 2) && srcW > 0;
  let vmap: ((p: { x: number; y: number }) => { x: number; y: number }) | null = null;
  if (camLive) {
    const vw = srcW;
    const vh = srcH;
    const sc = Math.max(w / vw, h / vh);
    const offX = (w - vw * sc) / 2;
    const offY = (h - vh * sc) / 2;
    ctx.drawImage(video!, offX, offY, vw * sc, vh * sc);
    vmap = (p) => ({ x: offX + p.x * sc, y: offY + p.y * sc });
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
  const ov = vmap && opts.overlay ? opts.overlay : null;
  // light vignette only: keep the work area visible
  const vg = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.35, cx, cy, Math.max(w, h) * 0.85);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

  // ---------- state ----------
  let L = locks.get(ctx);
  if (!L) {
    L = { since: null, lastT: s.t };
    locks.set(ctx, L);
  }
  if (s.t < L.lastT) L.since = null;
  L.lastT = s.t;
  const onMark = s.onTarget && s.gapMm < 0.5;
  const square = s.aligned;
  // with the engine, "ready" also needs its gate (calibrated, enough markers, good fit, steady)
  const gateOk = !ov?.gate || ov.gate.ready;
  if (onMark && square && gateOk) L.since ??= s.t;
  else L.since = null;
  const lockAge = L.since == null ? -1 : s.t - L.since;
  // with the engine, the lock timer lives in the engine: the HUD only shows its decision
  const engineGate = ov?.gate && ov.gate.locking !== undefined ? ov.gate : null;
  const ready = engineGate ? engineGate.ready : lockAge >= LOCK_TIME;
  const locking = engineGate ? !!engineGate.locking : lockAge >= 0 && !ready;
  const drilling = s.phase === "drill" || s.phase === "hold";
  const broken = drilling && s.depthMm > 0.3 && !square;

  const lw = Math.max(1.2, u * 0.32);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = u * 0.9;

  // ---------- the mark (where the hole goes) ----------
  // tracked markers: thin outlines, so the user sees what the camera locks onto
  if (ov && vmap) {
    for (const q of ov.quads) {
      const m = q.map(vmap);
      line(ctx, () => {
        ctx.moveTo(m[0].x, m[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(m[i].x, m[i].y);
        ctx.closePath();
      }, "rgba(62,229,155,0.7)", Math.max(1, lw * 0.7));
    }
  }
  const tracked = !!(ov && !ov.lost && ov.aim);
  const rc = tracked ? vmap!(ov!.aim!) : { x: cx, y: cy };
  const mk = ov ? (ov.mark && !ov.lost ? vmap!(ov.mark) : null) : { x: toX(s.target.x), y: toY(s.target.y) };
  const mx = mk ? mk.x : -1e4;
  const my = mk ? mk.y : -1e4;
  const inView = !!mk && mx > u * 6 && mx < w - u * 6 && my > u * 6 && my < h - u * 6;
  const showMark = s.phase !== "hold";
  if (showMark && !(ov && ov.lost)) {
    if (inView) {
      const r = u * 2;
      line(ctx, () => {
        ctx.arc(mx, my, r, 0, Math.PI * 2);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.moveTo(mx + dx * r * 1.6, my + dy * r * 1.6);
          ctx.lineTo(mx + dx * r * 2.8, my + dy * r * 2.8);
        }
      }, WHITE, lw);
      if (!onMark && s.phase !== "drill" && s.offsetMm > 3) {
        label(ctx, `${s.label} · ${s.offsetMm.toFixed(0)} mm`, mx + r * 3.4, my - r * 2.2, u * 4, WHITE, "left");
      }
    } else {
      // off-screen: a small chevron on the edge pointing to it
      const a = Math.atan2(my - rc.y, mx - rc.x);
      const ex = Math.min(w - u * 6, Math.max(u * 6, cx + Math.cos(a) * w));
      const ey = Math.min(h - u * 6, Math.max(u * 6, cy + Math.sin(a) * h));
      chevron(ctx, ex, ey, a, u * 2.4, WHITE, lw * 1.4);
    }
  }

  // ---------- tip ring (fixed) and chuck ring (tilt) ----------
  let ox = -s.yawDeg * TILT_GAIN * u;
  let oy = s.pitchDeg * TILT_GAIN * u;
  const oMax = u * 26;
  const oLen = Math.hypot(ox, oy);
  if (oLen > oMax) {
    ox = (ox / oLen) * oMax;
    oy = (oy / oLen) * oMax;
  }
  const chX = rc.x + ox;
  const chY = rc.y + oy;

  let col = AMBER;
  if (broken) col = RED;
  else if (ready || drilling) col = GREEN;
  else if (onMark && square) col = GREEN;
  // gentle blink while locking (3 pulses), then steady
  const pulse = locking ? 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(lockAge * Math.PI * 2 * (3 / LOCK_TIME))) : 1;

  ctx.globalAlpha = ov && ov.lost ? 0.25 : pulse;
  const tipR = u * 4;
  const chuckR = u * 8.5;
  // axis line: chuck -> tip
  if (Math.hypot(ox, oy) > u * 1.5) {
    line(ctx, () => {
      ctx.moveTo(chX, chY);
      ctx.lineTo(rc.x, rc.y);
    }, col, lw * 0.8, [u * 1, u * 1]);
  }
  line(ctx, () => ctx.arc(chX, chY, chuckR, 0, Math.PI * 2), square && !broken ? col : AMBER, lw * 1.1);
  line(ctx, () => ctx.arc(rc.x, rc.y, tipR, 0, Math.PI * 2), onMark || drilling ? col : WHITE, lw * 1.4);
  dot(ctx, rc.x, rc.y, u * 0.7, onMark || drilling ? col : WHITE);
  ctx.globalAlpha = 1;

  // depth progress: thin arc around the tip while drilling
  if (drilling || s.depthMm > 0.05) {
    const frac = Math.min(1, s.depthMm / (s.depthTargetMm ?? DEPTH_TARGET_MM));
    const r = u * 12.5;
    line(ctx, () => ctx.arc(rc.x, rc.y, r, 0, Math.PI * 2), "rgba(245,248,252,0.22)", lw * 2.2);
    line(ctx, () => ctx.arc(rc.x, rc.y, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2), frac >= 0.998 ? RED : GREEN, lw * 2.4);
    label(ctx, `${s.depthMm.toFixed(1)}`, rc.x + r + u * 2.5, rc.y - u * 1.6, u * 6, WHITE, "left", MONO, 600);
    label(ctx, `/ ${s.depthTargetMm ?? DEPTH_TARGET_MM} mm`, rc.x + r + u * 2.5, rc.y + u * 4, u * 3.6, SOFT, "left", MONO, 500);
  } else if (onMark || s.phase === "align") {
    // angle readout beside the chuck ring, only while squaring up
    label(ctx, `${s.angleErrDeg.toFixed(1)}°`, chX + chuckR + u * 2, chY, u * 6, square ? GREEN : AMBER, "left", MONO, 600);
  }

  ctx.restore();

  // ---------- Athos card: one step, one instruction ----------
  const cue = ov?.calibrating
    ? {
        text: ov.calibrating.text,
        color: AMBER,
        step: "CAL",
        pass: false,
        check: `${Math.round(ov.calibrating.progress * 100)} % · ${ov.calibrating.count} samples`,
      }
    : ov?.alarms && ov.alarms & 16
      ? { text: "STOP · no-go zone", color: RED, step: "!", pass: false, check: "the tip is close to a pipe or cable: back out" }
      : ov?.alarms && ov.alarms & 8
      ? { text: "STOP · the part moved", color: RED, step: "!", pass: false, check: "it slipped under the tool: re-clamp, back out, re-check" }
      : ov && !ov.lost && ov.markers != null && ov.markers < 4 && !ov.calibrating
        ? { text: "Show more of the sheet", color: AMBER, step: "!", pass: false, check: `only ${ov.markers} markers seen: keep more markers in front of the bit` }
        : instruction(s, { onMark, square, ready, locking, broken, lost: !!(ov && ov.lost), gate: ov?.gate?.message ?? null, tol: ov?.tolDeg ?? ANGLE_TOL_DEG });
  if (ov?.hint && cue.color !== RED && !ov.calibrating) cue.check = ov.hint;
  const panelW = landscape ? Math.min(w * 0.62, u * 130) : w - u * 8;
  const pad = u * 3.4;
  const titleSize = u * (compact ? 6 : landscape ? 5.4 : 6.6);
  const smallSize = u * (compact ? 3.4 : landscape ? 3.2 : 4.1);
  const panelH = pad * 2 + smallSize * 1.3 + titleSize * 1.35 + (compact ? 0 : smallSize * 1.5);
  const px = landscape ? u * 4 : u * 4;
  // the docked camera sees the tip near the bottom of the image: keep the card off the rings
  const ringLow = tracked && rc.y > h * 0.5;
  const py = ringLow ? u * 9 : h - panelH - u * 4;
  ctx.fillStyle = "rgba(10,12,16,0.62)";
  roundRect(ctx, px, py, panelW, panelH, u * 2.6);
  ctx.fill();
  // status bar on the left edge of the card
  ctx.fillStyle = cue.color;
  roundRect(ctx, px, py, u * 0.9, panelH, u * 0.45);
  ctx.fill();

  const tx = px + pad + u * 0.6;
  let ty = py + pad + smallSize * 0.6;
  label(ctx, `ATHOS · STEP ${cue.step}`, tx, ty, smallSize, SOFT, "left", MONO, 500);
  ty += smallSize * 0.7 + titleSize * 0.85;
  label(ctx, cue.text, tx, ty, titleSize, cue.color === RED ? RED : WHITE, "left", SANS, 600, panelW - pad * 2);
  if (!compact) {
    ty += titleSize * 0.65 + smallSize * 1.1;
    const pass = cue.pass;
    label(ctx, `${pass ? "✓" : "○"}  ${cue.check}`, tx, ty, smallSize, pass ? GREEN : SOFT, "left", MONO, 400, panelW - pad * 2);
  }

  // tiny mode tag
  label(ctx, ov ? `OPTICAL · ${ov.info}` : "OPTICAL · SIM", u * 4, u * 5, u * (landscape ? 2.6 : 3.3), ov && !ov.lost ? GREEN : SOFT, "left", MONO, 500);
}

// ---------- what to say at each moment ----------
function instruction(
  s: SimState,
  c: { onMark: boolean; square: boolean; ready: boolean; locking: boolean; broken: boolean; lost: boolean; gate: string | null; tol: number },
): { text: string; color: string; step: string; pass: boolean; check: string } {
  if (c.lost) return { text: "Point at the markers", color: AMBER, step: "0/3", pass: false, check: "at least two markers in view" };
  if (c.gate === "Calibrate first" && (s.phase === "approach" || s.phase === "align"))
    return { text: "Calibrate first", color: AMBER, step: "0/3", pass: false, check: "tap Calibrate with the tip on A2" };
  if (c.gate === "No-go zone: not here" && (s.phase === "approach" || s.phase === "align"))
    return { text: "No-go zone", color: RED, step: "0/3", pass: false, check: "a pipe or cable runs behind this mark: pick another" };
  if (c.gate === "Locate the part first" && (s.phase === "approach" || s.phase === "align"))
    return { text: "Locate the part", color: AMBER, step: "0/3", pass: false, check: "touch its reference points with the tip" };
  if (c.broken) return { text: `Straighten · ${s.angleErrDeg.toFixed(1)}° off`, color: RED, step: "3/3", pass: false, check: `move the big circle onto the small one (±${c.tol}°)` };
  const D = s.depthTargetMm ?? DEPTH_TARGET_MM;
  const drive = s.action === "drive";
  if (s.phase === "hold")
    return drive
      ? { text: `Seated · ${s.label}`, color: GREEN, step: "3/3", pass: true, check: `${s.depthMm.toFixed(1)} mm · ${s.angleErrDeg.toFixed(2)}° off its axis` }
      : { text: `Stop · ${D} mm`, color: GREEN, step: "3/3", pass: true, check: `depth ${s.depthMm.toFixed(1)} mm · err ${s.angleErrDeg.toFixed(2)}°` };
  if (s.phase === "retract") return { text: `Done · next ${s.label}`, color: GREEN, step: "1/3", pass: true, check: "hole logged" };
  if (s.phase === "drill") {
    const left = D - s.depthMm;
    if (left < 3) return { text: drive ? "Slow · seating" : "Ease off", color: AMBER, step: "3/3", pass: false, check: `stop at ${D} mm` };
    return { text: `${drive ? "Drive" : "Drill"} · ${left.toFixed(0)} mm left`, color: GREEN, step: "3/3", pass: false, check: `stop at ${D} mm · keep the circles together` };
  }
  if (!c.onMark) {
    if (s.offsetMm > 1) return { text: "Tip to the mark", color: AMBER, step: "1/3", pass: false, check: "tip within 1.0 mm of the mark" };
    return { text: "Rest on the mark", color: AMBER, step: "1/3", pass: false, check: "tip touching the surface" };
  }
  if (!c.square) return { text: `Line up · ${s.angleErrDeg.toFixed(1)}° off`, color: AMBER, step: "2/3", pass: false, check: `move the big circle onto the small one (±${c.tol}°)` };
  if (c.gate && !c.locking && !c.ready) return { text: c.gate, color: AMBER, step: "2/3", pass: false, check: "the engine's go / no-go check" };
  if (c.locking) return { text: "Hold steady", color: GREEN, step: "2/3", pass: false, check: "hold 0.75 s" };
  return { text: "Ready · drill", color: GREEN, step: "2/3", pass: true, check: `square ±${c.tol}° · on the mark` };
}

// ---------- drawing helpers ----------
function line(ctx: CanvasRenderingContext2D, path: () => void, color: string, width: number, dash?: number[]) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash ?? []);
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.setLineDash([]);
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function chevron(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, size: number, color: string, width: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  line(ctx, () => {
    ctx.moveTo(-size * 0.6, -size);
    ctx.lineTo(size * 0.6, 0);
    ctx.lineTo(-size * 0.6, size);
  }, color, width);
  ctx.restore();
}

function label(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = "center",
  family = MONO,
  weight = 500,
  maxW?: number,
) {
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  let t = str;
  if (maxW && ctx.measureText(t).width > maxW) {
    while (t.length > 3 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    t += "…";
  }
  ctx.fillText(t, x, y);
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
  g.addColorStop(0, "#22262b");
  g.addColorStop(1, "#0b0d10");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
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
