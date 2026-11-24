// The simple display for /hud: one colour on black, like an old monitor, read at arm's length on a drill.
//   - no words on the working screen: one number with its unit at the top, plus one icon
//   - meaning by shape, fill, thickness and blinking, never by hue; red only for STOP
//   - the video is optional; the geometry (mark, tip, bit, level, markers) sits on the same pixels either way,
//     because it is placed with the classic display's frame (lib/hudguide.ts)
//   - a depth bar on the left: the middle is the surface, the tip's height above, the hole's depth below
// The classic display stays in lib/hudguide.ts.

import type { SimState } from "./sim.ts";
import type { Overlay } from "./hud.ts";
import { DEPTH_TARGET_MM } from "./sim.ts";
import { banner, frame, icon, type Icon, type P } from "./hudguide.ts";

export const SIMPLE_GREEN = "#3ee59b";
export const SIMPLE_AMBER = "#ffb547";
const RED = "#ff5a5a";
const MONO = "'Geist Mono', ui-monospace, monospace";

/** gap at which the depth bar's top is reached, mm (higher: the pointer becomes an arrowhead at the top) */
export const ABOVE_FULL_MM = 60;
/** where the planned depth sits on the bar: three quarters of the way down */
const TARGET_AT = -0.75;

export type Level = "guide" | "ok" | "warn" | "stop";
export interface Readout {
  icon: Icon;
  /** the number shown, already formatted ("12.4", "0.8", "31"), or "" for none */
  value: string;
  unit: "mm" | "°" | "%" | "";
  /** direction of the arrow icon, rad (image axes) */
  angle?: number;
  level: Level;
}

/** Tip and mark in image or screen px (the same uniform scale, so the angle is the same), and the tool calibration. */
export interface ReadoutContext {
  tipPx: P | null;
  markPx: P | null;
  calibrated: boolean;
}

/** The same conditions as the classic banner (lib/hudguide.ts): one place, so both displays agree. */
function conditions(s: SimState, ov: Overlay) {
  const tol = ov.tolDeg ?? 0.5;
  return {
    tol,
    square: s.angleErrDeg <= tol,
    onMark: s.offsetMm < 1.0,
    touching: s.gapMm < 0.6,
    drilling: s.phase === "drill" || s.phase === "hold",
  };
}

/** The one icon, number and level shown at the top, in the same order as the classic banner. */
export function readout(s: SimState, ov: Overlay, c: ReadoutContext): Readout {
  const k = conditions(s, ov);
  const D = s.depthTargetMm ?? DEPTH_TARGET_MM;
  const tilt = s.angleErrDeg.toFixed(1);
  if (ov.calibrating) return { icon: "setup", value: String(Math.round(ov.calibrating.progress * 100)), unit: "%", level: "guide" };
  if (ov.alarms && ov.alarms & (16 | 8)) return { icon: "stop", value: "", unit: "", level: "stop" };
  if (ov.lost) return { icon: "search", value: "", unit: "", level: "warn" };
  if (!c.calibrated) return { icon: "setup", value: "", unit: "", level: "warn" };
  if ((ov.markers ?? 0) < 4) return { icon: "search", value: String(ov.markers ?? 0), unit: "", level: "warn" };
  if (s.phase === "hold") return { icon: "check", value: s.depthMm.toFixed(1), unit: "mm", level: "ok" };
  if (s.phase === "retract") return { icon: "check", value: "", unit: "", level: "ok" };
  if (k.drilling) {
    if (!k.square) return { icon: "level", value: tilt, unit: "°", level: "warn" };
    return { icon: "drill", value: Math.max(0, D - s.depthMm).toFixed(0), unit: "mm", level: "guide" };
  }
  if (!k.onMark) {
    const angle = c.tipPx && c.markPx ? Math.atan2(c.markPx.y - c.tipPx.y, c.markPx.x - c.tipPx.x) : -Math.PI / 2;
    const dist = Math.hypot(s.offsetMm, Math.max(0, s.gapMm));
    return { icon: "arrow", value: dist < 10 ? dist.toFixed(1) : dist.toFixed(0), unit: "mm", angle, level: "guide" };
  }
  if (!k.touching) return { icon: "down", value: s.gapMm.toFixed(0), unit: "mm", level: "guide" };
  if (!k.square) return { icon: "level", value: tilt, unit: "°", level: "guide" };
  if (ov.gate && !ov.gate.ready) return { icon: "level", value: tilt, unit: "°", level: "guide" };
  return { icon: "check", value: tilt, unit: "°", level: "ok" };
}

/** The classic banner's words for the current state, shown on demand (a tap on the readout). */
export function wordsFor(s: SimState, ov: Overlay, c: ReadoutContext): { title: string; sub: string } {
  const k = conditions(s, ov);
  const b = banner(s, ov, { tip: c.tipPx, mark: c.markPx, ...k, calibrated: c.calibrated });
  return { title: b.title, sub: b.sub };
}

/** Where things sit on the depth bar, in -1..1 (0 = the surface, +1 = top, -1 = bottom). */
export function depthBar(gapMm: number, depthMm: number, targetMm: number): { above: number; below: number; target: number; over: boolean; beyond: boolean } {
  const inMaterial = depthMm > 0;
  const above = inMaterial ? 0 : Math.min(1, Math.max(0, gapMm / ABOVE_FULL_MM));
  const beyond = !inMaterial && gapMm > ABOVE_FULL_MM;
  const below = inMaterial ? Math.max(-1, (TARGET_AT * depthMm) / Math.max(targetMm, 1e-6)) : 0;
  return { above, below, target: TARGET_AT, over: depthMm > targetMm + 0.5, beyond };
}

export interface SimpleOptions {
  /** always given: its size places everything */
  video: HTMLVideoElement | HTMLCanvasElement;
  overlay: Overlay;
  toolCalibrated: boolean;
  /** draw the camera image behind (false: black) */
  showVideo: boolean;
  /** the one colour: "#3ee59b" or "#ffb547" */
  color: string;
  /** false while a sheet covers the top: hide the readout */
  readout?: boolean;
  /** px at the right kept free for the buttons column (the readout is centred in what is left) */
  rightInset?: number;
}

export function drawSimple(ctx: CanvasRenderingContext2D, s: SimState, w: number, h: number, o: SimpleOptions) {
  const ov = o.overlay;
  const col = o.color;
  const u = Math.min(w, h) / 100;
  const lw = Math.max(3, u * 0.9); // the same thick lines as classic
  const now = performance.now() / 1000;
  /** on for the first half of each period */
  const blink = (hz: number) => Math.floor(now * hz * 2) % 2 === 0;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const isVideo = typeof HTMLVideoElement !== "undefined" && o.video instanceof HTMLVideoElement;
  const vw = isVideo ? (o.video as HTMLVideoElement).videoWidth : o.video.width;
  const vh = isVideo ? (o.video as HTMLVideoElement).videoHeight : o.video.height;
  const tracking = !ov.lost;
  let tip: P | null = null, mark: P | null = null;

  if (vw && vh) {
    // the frame always runs, video or not, so the zoom and every position match the classic display
    const { map, tl, size } = frame(ctx, s, ov, w, h, vw, vh, o.toolCalibrated);
    if (o.showVideo) {
      ctx.drawImage(o.video, tl.x, tl.y, size.w, size.h);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, w, h);
    }
    tip = ov.tipPx ? map(ov.tipPx) : null;
    mark = ov.mark && tracking ? map(ov.mark) : null;
    const { tol, square, onMark, drilling } = conditions(s, ov);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // ---------- markers it reads: thin outlines, so you know the sheet is tracked ----------
    for (const q of ov.quads) {
      const m = q.map(map);
      stroke(ctx, Math.max(1.5, u * 0.35), col, () => {
        ctx.moveTo(m[0].x, m[0].y);
        for (let i = 1; i < m.length; i++) ctx.lineTo(m[i].x, m[i].y);
        ctx.closePath();
      }, 0.3);
    }

    // ---------- the mark: a circle with four ticks; a filled disc once on it ----------
    if (mark && s.phase !== "hold") {
      const r = u * 3.2;
      stroke(ctx, lw, col, () => {
        ctx.arc(mark!.x, mark!.y, r, 0, Math.PI * 2);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.moveTo(mark!.x + dx * r * 1.5, mark!.y + dy * r * 1.5);
          ctx.lineTo(mark!.x + dx * r * 2.6, mark!.y + dy * r * 2.6);
        }
      });
      if (onMark) disc(ctx, mark, r * 0.55, col);
    }

    // ---------- the calibrated bit and tip ----------
    if (tip && o.toolCalibrated) {
      const t = tip;
      const bit = ov.bitPx ? map(ov.bitPx) : null;
      if (bit) stroke(ctx, lw * 1.2, col, () => (ctx.moveTo(bit.x, bit.y), ctx.lineTo(t.x, t.y)), 0.8);
      const r = u * 2.4;
      stroke(ctx, lw, col, () => {
        ctx.moveTo(t.x - r * 2.2, t.y);
        ctx.lineTo(t.x - r * 0.6, t.y);
        ctx.moveTo(t.x + r * 0.6, t.y);
        ctx.lineTo(t.x + r * 2.2, t.y);
        ctx.moveTo(t.x, t.y - r * 2.2);
        ctx.lineTo(t.x, t.y - r * 0.6);
        ctx.moveTo(t.x, t.y + r * 0.6);
        ctx.lineTo(t.x, t.y + r * 2.2);
      });

      // the arrow from the tip to the mark
      if (mark && !onMark && !drilling) {
        const d = Math.hypot(mark.x - t.x, mark.y - t.y);
        if (d > u * 8) arrow(ctx, t, mark, lw * 1.6, col, u * 4, u * 5);
      }

      // the tilt level around the tip: same radius and gain as classic, so the dot sits where it did
      if (tracking && (onMark || drilling) && s.phase !== "hold") {
        const R = u * 11;
        const gain = R / Math.max(4 * tol, 2);
        let dx = -s.yawDeg * gain, dy = s.pitchDeg * gain;
        const l = Math.hypot(dx, dy);
        if (l > R) (dx *= R / l), (dy *= R / l);
        stroke(ctx, lw, col, () => ctx.arc(t.x, t.y, R, 0, Math.PI * 2), 0.4);
        stroke(ctx, square ? lw * 1.8 : lw, col, () => ctx.arc(t.x, t.y, (R * tol) / Math.max(4 * tol, 2), 0, Math.PI * 2));
        const dot = { x: t.x + dx, y: t.y + dy };
        if (square) disc(ctx, dot, u * 2.4, col);
        else if (!drilling || blink(4)) stroke(ctx, lw, col, () => ctx.arc(dot.x, dot.y, u * 2.4, 0, Math.PI * 2));
      }
    }

    // ---------- the depth bar on the left ----------
    if (tracking && o.toolCalibrated) {
      const D = s.depthTargetMm ?? DEPTH_TARGET_MM;
      const b = depthBar(s.gapMm, s.depthMm, D);
      const x = u * 6, top = h * 0.24, bottom = h * 0.82;
      const mid = (top + bottom) / 2, half = (bottom - top) / 2;
      const y = (v: number) => mid - v * half;
      const bw = u * 2.4;
      stroke(ctx, Math.max(2, u * 0.5), col, () => (ctx.moveTo(x, top), ctx.lineTo(x, bottom)), 0.4);
      stroke(ctx, lw, col, () => (ctx.moveTo(x - bw * 1.2, mid), ctx.lineTo(x + bw * 1.2, mid)));
      stroke(ctx, Math.max(2, u * 0.5), col, () => (ctx.moveTo(x - bw * 0.8, y(b.target)), ctx.lineTo(x + bw * 0.8, y(b.target))));
      if (b.below < 0) {
        if (!b.over || blink(4)) {
          ctx.fillStyle = col;
          ctx.fillRect(x - bw / 2, mid, bw, y(b.below) - mid);
        }
      } else if (b.beyond) {
        // past the top: a hollow arrowhead pointing up
        stroke(ctx, lw, col, () => {
          ctx.moveTo(x - bw, top + bw);
          ctx.lineTo(x, top - bw * 0.2);
          ctx.lineTo(x + bw, top + bw);
          ctx.closePath();
        });
      } else {
        // the tip's height: a hollow pointer at the bar's right, pointing at it
        const py = y(b.above);
        stroke(ctx, lw * 0.8, col, () => {
          ctx.moveTo(x + bw * 0.6, py);
          ctx.lineTo(x + bw * 2, py - bw * 0.8);
          ctx.lineTo(x + bw * 2, py + bw * 0.8);
          ctx.closePath();
        });
      }
    }
    ctx.restore();
  }

  // ---------- the readout at the top, or STOP ----------
  const ro = readout(s, ov, { tipPx: tip, markPx: mark, calibrated: o.toolCalibrated });
  if (ro.level === "stop") {
    if (blink(3)) {
      const fw = u * 2.5;
      stroke(ctx, fw, RED, () => ctx.rect(fw / 2, fw / 2, w - fw, h - fw));
    }
    if (o.readout !== false) icon(ctx, "stop", { x: (w - (o.rightInset ?? 0)) / 2, y: u * 14 }, u * 11, RED, 0, lw * 1.8);
    return;
  }
  if (o.readout === false) return;
  const aw = w - (o.rightInset ?? 0);
  const cy = u * 12;
  const ir = u * 6; // icon radius
  const vSize = u * 13, uSize = u * 6;
  ctx.save();
  ctx.font = `700 ${vSize}px ${MONO}`;
  const vW = ro.value ? ctx.measureText(ro.value).width : 0;
  ctx.font = `600 ${uSize}px ${MONO}`;
  const uW = ro.unit && ro.value ? ctx.measureText(ro.unit).width : 0;
  const gap = u * 3;
  const total = ir * 2 + (vW ? gap + vW : 0) + (uW ? u * 1.5 + uW : 0);
  let x = aw / 2 - total / 2;
  if (ro.level === "warn" && !blink(2)) ctx.globalAlpha = 0.35;
  let ink = col;
  if (ro.level === "ok") {
    // inverse video: a filled block of the colour with black glyphs
    const pad = u * 2.5;
    ctx.fillStyle = col;
    roundRect(ctx, x - pad, cy - vSize * 0.5 - pad * 0.6, total + pad * 2, vSize + pad * 1.2, u * 2.5);
    ctx.fill();
    ink = "#000";
  }
  icon(ctx, ro.icon, { x: x + ir, y: cy }, ir, ink, ro.angle ?? 0, lw * 1.4);
  x += ir * 2;
  ctx.fillStyle = ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (vW) {
    x += gap;
    ctx.font = `700 ${vSize}px ${MONO}`;
    ctx.fillText(ro.value, x, cy);
    x += vW;
  }
  if (uW) {
    x += u * 1.5;
    ctx.font = `600 ${uSize}px ${MONO}`;
    ctx.fillText(ro.unit, x, cy + vSize * 0.18);
  }
  ctx.restore();
}

// ---------- drawing helpers ----------

function stroke(ctx: CanvasRenderingContext2D, width: number, color: string, path: () => void, alpha = 1) {
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.globalAlpha = a;
}

function disc(ctx: CanvasRenderingContext2D, c: P, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fill();
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- the screen's settings and the check chip (pure: used by components/HudScreen.tsx) ----------

export type UiKind = "classic" | "simple";
export type UiColor = "green" | "amber";
export interface UiPrefs {
  ui: UiKind;
  video: boolean;
  color: UiColor;
}

/** The display settings kept per device (localStorage: st-ui, st-ui-video, st-ui-color). Anything unknown is the default. */
export function readUiPrefs(get: (key: string) => string | null): UiPrefs {
  return {
    ui: get("st-ui") === "simple" ? "simple" : "classic",
    video: get("st-ui-video") === "1",
    color: get("st-ui-color") === "amber" ? "amber" : "green",
  };
}

/** The colour to draw with. */
export const uiColorHex = (c: UiColor) => (c === "amber" ? SIMPLE_AMBER : SIMPLE_GREEN);

/** The display as a job records it (TrackingSettings.display), so /memory can compare the two. */
export function displaySetting(ui: UiKind, video: boolean): "classic" | "simple" | "simple+video" {
  return ui === "classic" ? "classic" : video ? "simple+video" : "simple";
}

/** A Check's detail cut down to its numbers for the simple display's chip ("depth -0.07 mm (±0.5) · angle 0.30° (≤ 0.5°)"
 *  -> "−0.07 mm · 0.30°"). When no part is a measurement, the detail is kept as it is. */
export function chipNumbers(detail: string): string {
  const nums: string[] = [];
  for (const part of detail.split(" · ")) {
    const m = /^(?:depth|angle|score) ([+-]?[\d.]+|–)( ?(?:mm|°))?/.exec(part.trim());
    if (m) nums.push(`${m[1].replace(/^-/, "−")}${m[2] ?? ""}`);
  }
  return nums.length ? nums.join(" · ") : detail;
}
