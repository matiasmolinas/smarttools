// Procedural work surfaces for the HUD background, rendered once in world units
// so they pan and zoom with the simulated camera like a real surface would.

import { MARKERS, TARGETS } from "./sim";

export type SurfaceKind = "wall" | "wood";

// world extent covered by the texture (metres)
export const SURF = { x0: -0.7, x1: 0.7, y0: -0.5, y1: 0.5, ppm: 1600 };

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<SurfaceKind, HTMLCanvasElement>();

export function getSurface(kind: SurfaceKind): HTMLCanvasElement {
  const hit = cache.get(kind);
  if (hit) return hit;
  const W = Math.round((SURF.x1 - SURF.x0) * SURF.ppm);
  const H = Math.round((SURF.y1 - SURF.y0) * SURF.ppm);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const px = (x: number) => (x - SURF.x0) * SURF.ppm;
  const py = (y: number) => (SURF.y1 - y) * SURF.ppm;

  if (kind === "wall") paintWall(ctx, W, H);
  else paintWood(ctx, W, H);

  // printed fiducial stickers
  const pattern = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0];
  for (const m of MARKERS) {
    const s = 0.06 * SURF.ppm;
    const X = px(m.x) - s / 2;
    const Y = py(m.y) - s / 2;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#f6f6f2";
    ctx.fillRect(X - s * 0.12, Y - s * 0.12, s * 1.24, s * 1.24);
    ctx.restore();
    ctx.fillStyle = "#141414";
    ctx.fillRect(X, Y, s, s);
    const cell = s / 6;
    ctx.fillStyle = "#f6f6f2";
    for (let i = 0; i < 16; i++) {
      if (!pattern[i]) ctx.fillRect(X + cell * (1 + (i % 4)), Y + cell * (1 + Math.floor(i / 4)), cell, cell);
    }
  }

  // pencil marks for each hole
  const r = rng(7);
  for (const t of TARGETS) {
    const X = px(t.x);
    const Y = py(t.y);
    ctx.strokeStyle = kind === "wall" ? "rgba(60,60,66,0.75)" : "rgba(40,30,25,0.75)";
    ctx.lineCap = "round";
    ctx.lineWidth = 2.2;
    const L = 0.014 * SURF.ppm;
    for (let k = 0; k < 2; k++) {
      ctx.beginPath();
      ctx.moveTo(X - L + r() * 3, Y + (r() - 0.5) * 3);
      ctx.lineTo(X + L + r() * 3, Y + (r() - 0.5) * 3);
      ctx.moveTo(X + (r() - 0.5) * 3, Y - L + r() * 3);
      ctx.lineTo(X + (r() - 0.5) * 3, Y + L + r() * 3);
      ctx.stroke();
    }
  }

  cache.set(kind, c);
  return c;
}

function paintWall(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const r = rng(42);
  ctx.fillStyle = "#d8d3c8";
  ctx.fillRect(0, 0, W, H);
  // soft blotches (uneven paint)
  for (let i = 0; i < 260; i++) {
    const x = r() * W, y = r() * H, rad = 40 + r() * 220;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.025 + r() * 0.04;
    g.addColorStop(0, r() > 0.5 ? `rgba(255,255,250,${a})` : `rgba(120,110,95,${a})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // roller stipple
  for (let i = 0; i < 60000; i++) {
    const x = r() * W, y = r() * H;
    ctx.fillStyle = r() > 0.5 ? "rgba(255,255,255,0.18)" : "rgba(80,72,60,0.12)";
    ctx.fillRect(x, y, 1 + r() * 2, 1 + r() * 2);
  }
  // faint vertical roller streaks
  for (let i = 0; i < 40; i++) {
    const x = r() * W;
    ctx.fillStyle = `rgba(255,255,255,${0.02 + r() * 0.03})`;
    ctx.fillRect(x, 0, 30 + r() * 80, H);
  }
}

function paintWood(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const r = rng(11);
  const plankH = 0.18 * SURF.ppm;
  const planks = Math.ceil(H / plankH);
  for (let p = 0; p < planks; p++) {
    const y0 = p * plankH;
    const base = [190 + r() * 25, 140 + r() * 25, 90 + r() * 20];
    ctx.fillStyle = `rgb(${base[0] | 0},${base[1] | 0},${base[2] | 0})`;
    ctx.fillRect(0, y0, W, plankH);
    // knots
    const knots = Array.from({ length: 1 + Math.floor(r() * 2) }, () => ({ x: r() * W, y: y0 + plankH * (0.25 + r() * 0.5), s: 14 + r() * 22 }));
    // grain lines
    const lines = 70;
    for (let i = 0; i < lines; i++) {
      const yy = y0 + (i / lines) * plankH;
      const amp = 2 + r() * 6;
      const freq = 0.002 + r() * 0.004;
      const ph = r() * 10;
      ctx.strokeStyle = `rgba(${90 + r() * 30},${55 + r() * 20},${25 + r() * 15},${0.12 + r() * 0.28})`;
      ctx.lineWidth = 0.6 + r() * 2.2;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 12) {
        let y = yy + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 3.7 + ph) * amp * 0.3;
        for (const k of knots) {
          const dx = x - k.x;
          const dy = y - k.y;
          const d2 = dx * dx * 0.08 + dy * dy;
          const push = (k.s * k.s * 9) / (d2 + k.s * k.s);
          y += Math.sign(dy || 1) * push;
        }
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (const k of knots) {
      for (let ring = 6; ring >= 1; ring--) {
        ctx.strokeStyle = `rgba(80,45,20,${0.15 + (6 - ring) * 0.08})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(k.x, k.y, k.s * ring * 0.45 * 2.2, k.s * ring * 0.45, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(70,38,15,0.75)";
      ctx.beginPath();
      ctx.ellipse(k.x, k.y, k.s * 0.9, k.s * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // pores
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = `rgba(70,40,15,${0.08 + r() * 0.12})`;
      ctx.fillRect(r() * W, y0 + r() * plankH, 3 + r() * 6, 1);
    }
    // seam
    ctx.fillStyle = "rgba(40,22,10,0.55)";
    ctx.fillRect(0, y0, W, 3);
  }
}
