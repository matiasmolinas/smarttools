// The simple display for /hud: the 2D twin of the 3D simulation (lib/render/guidance3d.ts, render3d.ts), drawn
// over black or over the darkened video, read at arm's length on a drill.
//   - the same colours as the 3D: cyan = the tool and the model of the part (a ghost: translucent fill, bright
//     edges), amber = the next thing to do (glowing, pulsing), green = done / ready, grey-white = the rest
//     (the numbers of the other holes), red = stop only
//   - no words on the working screen: one number with its unit at the top (or drawn by the screen in HTML)
//   - the geometry (mark, tip, bit, level, markers) sits on the same pixels as the classic display, video or not,
//     because it is placed with the classic display's frame (lib/hudguide.ts)
//   - a depth bar: the middle is the surface, the tip's height above, the hole's depth below
//   - focus: what matters for the current step glows, what does not is dimmed (lib/pilot.ts focus)
// The classic display stays in lib/hudguide.ts.

import type { SimState } from "./sim.ts";
import type { Overlay } from "./hud.ts";
import { DEPTH_TARGET_MM } from "./sim.ts";
import { banner, frame, icon, type Icon, type P } from "./hudguide.ts";
import { PHASES, canEnter, type CaptureWhy, type Phase, type PilotState, type PilotText } from "./pilot.ts";

/** The 3D simulation's palette (lib/render/guidance3d.ts): tool and part ghost, next, done, the rest, stop. */
export const COL = { tool: "#5ad8ff", next: "#ffb547", ok: "#3dffa8", rest: "#e8eef5", stop: "#ff5a6a" } as const;
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

/** What to light up now (lib/pilot.ts focus): ids as lib/pilot.ts FocusId. */
export interface SimpleFocus {
  glow: readonly string[];
  dim: readonly string[];
}

export interface SimpleOptions {
  /** always given: its size places everything */
  video: HTMLVideoElement | HTMLCanvasElement;
  overlay: Overlay;
  toolCalibrated: boolean;
  /** draw the camera image behind (false: black) */
  showVideo: boolean;
  /** false while a sheet covers the top: hide the readout */
  readout?: boolean;
  /** px at the right kept free for the buttons column (the readout is centred in what is left) */
  rightInset?: number;
  /** false: the canvas does not draw the top readout (the screen draws the text in HTML). STOP still blinks the frame. */
  drawText?: boolean;
  /** ids in `glow` get a soft glow and a slow pulse, ids in `dim` are drawn at 30 % (dim wins over glow) */
  focus?: SimpleFocus | null;
  /** the corner being captured (lib/pilot.ts PilotState.capture): a ring around the tip fills with its progress */
  capture?: { progress: number } | null;
  /** the depth bar's x, canvas px (default: 6 % of the short side) */
  depthX?: number;
  /** the pilot's phase: in "sheet" the mapped sheets' outlines are green (else grey-white) */
  phase?: Phase | null;
}

/** alpha of a dimmed item */
export const DIM_ALPHA = 0.3;
/** the active screw's pulse (Hz, radius ± 15 %) and the focus glow's pulse (Hz, alpha 0.75..1) */
const SCREW_HZ = 1.2;
const GLOW_HZ = 0.8;
const INK = "#05080d";

/** How an item with this id is drawn now: its alpha factor and whether it glows. */
export function focusLook(f: SimpleFocus | null | undefined, id: string, t: number): { alpha: number; glow: boolean } {
  if (!f) return { alpha: 1, glow: false };
  if (f.dim.includes(id)) return { alpha: DIM_ALPHA, glow: false };
  if (f.glow.includes(id)) return { alpha: 0.875 + 0.125 * Math.sin(t * 2 * Math.PI * GLOW_HZ), glow: true };
  return { alpha: 1, glow: false };
}

/** The digits of a screw's label ("S2" -> "2"), or the label itself when it has none. */
export const screwNumber = (label: string) => label.replace(/\D/g, "") || label;

export function drawSimple(ctx: CanvasRenderingContext2D, s: SimState, w: number, h: number, o: SimpleOptions) {
  const ov = o.overlay;
  const u = Math.min(w, h) / 100;
  const lw = Math.max(3, u * 0.9); // the same thick lines as classic
  const thin = Math.max(1.5, u * 0.35);
  const now = performance.now() / 1000;
  /** on for the first half of each period */
  const blink = (hz: number) => Math.floor(now * hz * 2) % 2 === 0;
  const stopAlarm = !!(ov.alarms && ov.alarms & (16 | 8));
  /** draw an item under its focus id: dimmed, or glowing in its colour, or as it is */
  const focused = (id: string, color: string, draw: () => void, canGlow = true) => {
    const k = focusLook(o.focus, id, now);
    if (k.alpha === 1 && !k.glow) return draw();
    ctx.save();
    ctx.globalAlpha *= k.alpha;
    if (k.glow && canGlow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = u * 3;
    }
    draw();
    ctx.restore();
  };

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const isVideo = typeof HTMLVideoElement !== "undefined" && o.video instanceof HTMLVideoElement;
  const vw = isVideo ? (o.video as HTMLVideoElement).videoWidth : o.video.width;
  const vh = isVideo ? (o.video as HTMLVideoElement).videoHeight : o.video.height;
  const tracking = !ov.lost;
  let tip: P | null = null, target: P | null = null;

  if (vw && vh) {
    // the frame always runs, video or not, so the zoom and every position match the classic display
    const { map, tl, size } = frame(ctx, s, ov, w, h, vw, vh, o.toolCalibrated);
    if (o.showVideo) {
      ctx.drawImage(o.video, tl.x, tl.y, size.w, size.h);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, w, h);
    }
    tip = ov.tipPx ? map(ov.tipPx) : null;
    const pl = ov.pilot;
    // in the pilot the target is its active screw; outside it, the plan's mark
    const active = pl && tracking ? pl.screwsPx.find((x) => x.state === "active") : undefined;
    target = pl ? (active ? map(active.p) : null) : ov.mark && tracking ? map(ov.mark) : null;
    const { tol, square, onMark, drilling } = conditions(s, ov);
    const mark = target;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // ---------- markers it reads: thin grey-white outlines, so you know the sheet is tracked ----------
    focused("sheet-outline", COL.rest, () => {
      for (const q of ov.quads) {
        const m = q.map(map);
        stroke(ctx, thin, COL.rest, () => poly(ctx, m), 0.25);
      }
    }, false);

    if (pl && tracking) {
      // ---------- the sheets' outlines: in the sheet phase a mapped sheet has a green edge (grey-white after it); one
      // being mapped is amber with a ring at its centre that fills with its observations; a sheet that moved or is
      // not flat is amber dashed, in any phase ----------
      for (const sh of pl.sheetsPx) {
        if (sh.px.length < 3) continue;
        const m = sh.px.map(map);
        const ew = Math.max(1.5, u * 0.4);
        if (sh.state === "mapped") {
          const col = o.phase === "sheet" ? COL.ok : COL.rest;
          focused("sheet-outline", col, () => stroke(ctx, o.phase === "sheet" ? ew * 1.5 : ew, col, () => poly(ctx, m), o.phase === "sheet" ? 0.9 : 0.5));
        } else if (sh.state === "seen") {
          const c = { x: m.reduce((a, p) => a + p.x, 0) / m.length, y: m.reduce((a, p) => a + p.y, 0) / m.length };
          const R = u * 4.5, p = Math.min(1, Math.max(0, sh.progress));
          focused("sheet-outline", COL.next, () => {
            stroke(ctx, ew * 1.5, COL.next, () => poly(ctx, m), 0.9);
            stroke(ctx, lw, COL.rest, () => ctx.arc(c.x, c.y, R, 0, Math.PI * 2), 0.25);
            if (p > 0) stroke(ctx, lw * 1.3, COL.next, () => ctx.arc(c.x, c.y, R, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2));
          });
        } else {
          focused("sheet-outline", COL.next, () => {
            ctx.setLineDash([u * 2.2, u * 1.6]);
            stroke(ctx, ew * 1.5, COL.next, () => poly(ctx, m), 0.9);
            ctx.setLineDash([]);
          });
        }
      }

      // ---------- the block: a cyan ghost, its bottom dashed, the four vertical edges ----------
      if (pl.partPx && pl.partPx.length > 2) {
        const top = pl.partPx.map(map);
        const bot = pl.bottomPx ? pl.bottomPx.map(map) : null;
        // the faces come clipped to what is in front of the camera (3 or more points each, not always as many on
        // both), so the vertical edges come on their own; without them, the faces' points pair up only when they match
        const edges = pl.edgesPx ? pl.edgesPx.map(([a, b]) => [map(a), map(b)] as const) : bot && bot.length === top.length ? top.map((p, i) => [bot[i], p] as const) : [];
        focused("part", COL.tool, () => {
          if (bot && bot.length > 2) {
            ctx.setLineDash([u * 1.6, u * 1.2]);
            stroke(ctx, thin, COL.tool, () => poly(ctx, bot), 0.4);
            ctx.setLineDash([]);
          }
          if (edges.length) {
            stroke(ctx, thin, COL.tool, () => {
              for (const [a, b] of edges) (ctx.moveTo(a.x, a.y), ctx.lineTo(b.x, b.y));
            }, 0.4);
          }
          const a = ctx.globalAlpha;
          ctx.globalAlpha = a * 0.16;
          ctx.fillStyle = COL.tool;
          ctx.beginPath();
          poly(ctx, top);
          ctx.fill();
          ctx.globalAlpha = a;
          stroke(ctx, Math.max(2, u * 0.5), COL.tool, () => poly(ctx, top));
        });
      }

      // ---------- the corners captured: small green squares ----------
      if (pl.cornersPx.length) {
        const half = u * 1.2;
        focused("corners", COL.ok, () => {
          ctx.fillStyle = COL.ok;
          for (const c of pl.cornersPx) {
            const p = map(c.p);
            ctx.fillRect(p.x - half, p.y - half, half * 2, half * 2);
          }
        });
      }

      // ---------- the screws: done green with a check, the others grey-white with their number, the active one
      // amber, pulsing, with its approach tunnel ----------
      if (pl.screwsPx.length) {
        const r = u * 3.2;
        focused("screws", COL.next, () => {
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `600 ${u * 3.4}px ${MONO}`;
          for (const sc of pl.screwsPx) {
            if (sc.state === "active") continue;
            const p = map(sc.p);
            if (sc.state === "done") {
              disc(ctx, p, r * 0.85, COL.ok);
              icon(ctx, "check", p, r * 0.8, INK, 0, Math.max(2, lw * 0.7));
            } else {
              stroke(ctx, Math.max(2, u * 0.5), COL.rest, () => ctx.arc(p.x, p.y, r, 0, Math.PI * 2), 0.6);
              const a = ctx.globalAlpha;
              ctx.globalAlpha = a * 0.85;
              ctx.fillStyle = COL.rest;
              ctx.fillText(screwNumber(sc.label), p.x, p.y);
              ctx.globalAlpha = a;
            }
          }
          if (mark) {
            const k = 1 + 0.15 * Math.sin(now * 2 * Math.PI * SCREW_HZ);
            // the tunnel: three rings that close in on the hole as the tip comes down to it
            if (!drilling && s.phase !== "hold" && s.phase !== "retract") {
              const f = Math.min(1, Math.max(0, s.gapMm / ABOVE_FULL_MM));
              for (let i = 0; i < 3; i++) {
                const rr = r * (1 + (i + 1) * (0.2 + 0.6 * f));
                stroke(ctx, Math.max(1.5, u * 0.45), COL.next, () => ctx.arc(mark.x, mark.y, rr, 0, Math.PI * 2), 0.6 - i * 0.15);
              }
            }
            const sb = ctx.shadowBlur, sh = ctx.shadowColor;
            ctx.shadowColor = COL.next;
            ctx.shadowBlur = u * 2.5;
            stroke(ctx, lw, COL.next, () => ctx.arc(mark.x, mark.y, r * k, 0, Math.PI * 2));
            ctx.shadowBlur = sb;
            ctx.shadowColor = sh;
            if (onMark) disc(ctx, mark, r * 0.55, COL.ok);
          }
        });
      }
    } else if (mark && s.phase !== "hold") {
      // ---------- the mark (a plan outside the pilot): a circle with four ticks; a filled disc once on it ----------
      const r = u * 3.2;
      focused("screws", COL.next, () => {
        stroke(ctx, lw, onMark ? COL.ok : COL.next, () => {
          ctx.arc(mark.x, mark.y, r, 0, Math.PI * 2);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            ctx.moveTo(mark.x + dx * r * 1.5, mark.y + dy * r * 1.5);
            ctx.lineTo(mark.x + dx * r * 2.6, mark.y + dy * r * 2.6);
          }
        });
        if (onMark) disc(ctx, mark, r * 0.55, COL.ok);
      });
    }

    // ---------- the calibrated bit and tip ----------
    if (tip && o.toolCalibrated) {
      const t = tip;
      const bit = ov.bitPx ? map(ov.bitPx) : null;
      const r = u * 2.4;
      focused("tip", COL.tool, () => {
        if (bit) stroke(ctx, lw * 1.2, COL.tool, () => (ctx.moveTo(bit.x, bit.y), ctx.lineTo(t.x, t.y)), 0.8);
        stroke(ctx, lw, COL.tool, () => {
          ctx.moveTo(t.x - r * 2.2, t.y);
          ctx.lineTo(t.x - r * 0.6, t.y);
          ctx.moveTo(t.x + r * 0.6, t.y);
          ctx.lineTo(t.x + r * 2.2, t.y);
          ctx.moveTo(t.x, t.y - r * 2.2);
          ctx.lineTo(t.x, t.y - r * 0.6);
          ctx.moveTo(t.x, t.y + r * 0.6);
          ctx.lineTo(t.x, t.y + r * 2.2);
        });
      });

      // the corner being captured: a ring around the tip that fills with the progress
      if (pl && tracking && o.capture) {
        const R = u * 6.5;
        const p = Math.min(1, Math.max(0, o.capture.progress));
        focused("corners", COL.next, () => {
          stroke(ctx, lw, COL.rest, () => ctx.arc(t.x, t.y, R, 0, Math.PI * 2), 0.25);
          if (p > 0) stroke(ctx, lw * 1.3, COL.next, () => ctx.arc(t.x, t.y, R, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2));
        });
      }

      // the arrow from the tip to the target
      if (mark && !onMark && !drilling) {
        const d = Math.hypot(mark.x - t.x, mark.y - t.y);
        if (d > u * 8) focused("screws", COL.next, () => arrow(ctx, t, mark, lw * 1.6, COL.next, u * 4, u * 5));
      }

      // the tilt level around the tip: same radius and gain as classic, so the dot sits where it did
      const hasTarget = pl ? !!mark : true;
      if (tracking && hasTarget && (onMark || drilling) && s.phase !== "hold") {
        const R = u * 11;
        const gain = R / Math.max(4 * tol, 2);
        let dx = -s.yawDeg * gain, dy = s.pitchDeg * gain;
        const l = Math.hypot(dx, dy);
        if (l > R) (dx *= R / l), (dy *= R / l);
        const col = stopAlarm ? COL.stop : square ? COL.ok : COL.next;
        focused("level", col, () => {
          stroke(ctx, lw, col, () => ctx.arc(t.x, t.y, R, 0, Math.PI * 2), 0.4);
          stroke(ctx, square ? lw * 1.8 : lw, col, () => ctx.arc(t.x, t.y, (R * tol) / Math.max(4 * tol, 2), 0, Math.PI * 2));
          const dot = { x: t.x + dx, y: t.y + dy };
          if (square) disc(ctx, dot, u * 2.4, col);
          else if (!drilling || blink(4)) stroke(ctx, lw, col, () => ctx.arc(dot.x, dot.y, u * 2.4, 0, Math.PI * 2));
        });
      }
    }

    // ---------- the depth bar ----------
    if (tracking && o.toolCalibrated && (pl ? !!mark : true)) {
      const D = s.depthTargetMm ?? DEPTH_TARGET_MM;
      const b = depthBar(s.gapMm, s.depthMm, D);
      const atDepth = s.phase === "hold" || (s.depthMm > 0 && Math.abs(s.depthMm - D) <= 0.5);
      const col = stopAlarm ? COL.stop : atDepth ? COL.ok : COL.next;
      const x = o.depthX ?? u * 6, top = h * 0.24, bottom = h * 0.82;
      const mid = (top + bottom) / 2, half = (bottom - top) / 2;
      const y = (v: number) => mid - v * half;
      const bw = u * 2.4;
      focused("depth", col, () => {
        stroke(ctx, Math.max(2, u * 0.5), COL.rest, () => (ctx.moveTo(x, top), ctx.lineTo(x, bottom)), 0.4);
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
      });
    }
    ctx.restore();
  }

  // ---------- the readout at the top, or STOP ----------
  const text = o.readout !== false && o.drawText !== false;
  const ro = readout(s, ov, { tipPx: tip, markPx: target, calibrated: o.toolCalibrated });
  if (ro.level === "stop") {
    if (blink(3)) {
      const fw = u * 2.5;
      stroke(ctx, fw, COL.stop, () => ctx.rect(fw / 2, fw / 2, w - fw, h - fw));
    }
    if (text) icon(ctx, "stop", { x: (w - (o.rightInset ?? 0)) / 2, y: u * 14 }, u * 11, COL.stop, 0, lw * 1.8);
    return;
  }
  if (!text) return;
  const col = ro.level === "ok" ? COL.ok : COL.next;
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
  let ink: string = col;
  if (ro.level === "ok") {
    // inverse video: a filled block of the colour with dark glyphs
    const pad = u * 2.5;
    ctx.fillStyle = col;
    roundRect(ctx, x - pad, cy - vSize * 0.5 - pad * 0.6, total + pad * 2, vSize + pad * 1.2, u * 2.5);
    ctx.fill();
    ink = INK;
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

function poly(ctx: CanvasRenderingContext2D, m: P[]) {
  ctx.moveTo(m[0].x, m[0].y);
  for (let i = 1; i < m.length; i++) ctx.lineTo(m[i].x, m[i].y);
  ctx.closePath();
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
export interface UiPrefs {
  ui: UiKind;
  video: boolean;
}

/** The display settings kept per device (localStorage: st-ui, st-ui-video). The simple display is the default;
 * anything unknown is the default. */
export function readUiPrefs(get: (key: string) => string | null): UiPrefs {
  return {
    ui: get("st-ui") === "classic" ? "classic" : "simple",
    video: get("st-ui-video") === "1",
  };
}

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

// ---------- the pilot's controls on the screen (pure: used by components/HudScreen.tsx) ----------

/** Controls that must stay findable whatever the focus says: never dimmed under STAY_FINDABLE. */
export const ALWAYS_FINDABLE: readonly string[] = ["stop", "pause"];
export const STAY_FINDABLE = 0.5;

/** How an HTML control with this focus id looks now: a pulsing ring when it glows, its opacity (dim: DIM_ALPHA;
 * Stop and Pause never under STAY_FINDABLE). Without a focus (outside the pilot) every control is as it is. */
export function controlLook(f: SimpleFocus | null | undefined, id: string): { glow: boolean; opacity: number } {
  if (!f) return { glow: false, opacity: 1 };
  const dim = f.dim.includes(id);
  const opacity = dim ? (ALWAYS_FINDABLE.includes(id) ? Math.max(DIM_ALPHA, STAY_FINDABLE) : DIM_ALPHA) : 1;
  return { glow: !dim && f.glow.includes(id), opacity };
}

/** One of the three phase buttons. enabled: the phase can be entered now (else it is dimmed and a tap only
 * vibrates); completed: it shows a small tick; hold: entering it would throw away corners or a fit already taken,
 * so it acts only when held 1 s, like Stop. */
export interface PhaseButton {
  phase: Phase;
  current: boolean;
  enabled: boolean;
  completed: boolean;
  hold: boolean;
}

/** The phase buttons for a pilot state, in order (sheet, part, work). Completed: sheet when it is seen well and
 * the pilot is past it; part when the fit is ok; work when every screw is done. */
export function phaseButtons(s: PilotState): PhaseButton[] {
  const at = PHASES.indexOf(s.phase);
  return PHASES.map((phase, i) => ({
    phase,
    current: phase === s.phase,
    enabled: canEnter(phase, s),
    completed: phase === "sheet" ? s.sheetOk && at > i : phase === "part" ? !!s.fit?.ok : s.total > 0 && s.done >= s.total,
    hold: phase === "part" && (s.corners > 0 || !!s.fit),
  }));
}

/** What kind of thing the top text shows: when it changes the old text fades out and the new one in; a number
 * that only changes value (or colour) updates in place. */
export const textKey = (t: Pick<PilotText, "icon" | "unit">) => `${t.icon}|${t.unit}`;

/** What is missing for a corner capture, in words, added to the step's words on a tap on the text. */
export function captureHint(why: CaptureWhy | string | null | undefined): string {
  if (why === "low") return "the tip is on the bench: rest it on a top corner of the block";
  if (why === "moving") return "keep the tip still on the corner";
  if (why === "near-taken") return "that corner is done: go to another one";
  if (why === "pivot") return "pivot the drill a little, the tip still on the corner";
  return "";
}

/** Does the simple display run the pilot job? Only in the simple display; on the phone when no saved plan is
 * active (a plan chosen in /memory is worked as before), in the simulator only with &pilot=1. */
export function pilotRuns(i: { ui: UiKind; sim: boolean; pilotParam: boolean; activePlan: string | null }): boolean {
  if (i.ui !== "simple") return false;
  return i.sim ? i.pilotParam : !i.activePlan;
}
