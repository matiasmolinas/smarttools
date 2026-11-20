// Draws the app icons (PNG, no dependencies): the green ring of the logo with a crosshair, on the site's dark
// background. Run: node scripts/icons.mts  → public/icons/icon-{192,512}.png and a maskable 512.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const BG = [5, 8, 13], GREEN = [61, 255, 168], CYAN = [90, 216, 255];

function crc32(b: Uint8Array) {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(new Uint8Array(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
}
function png(size: number, px: (x: number, y: number) => number[]) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const c = px(x + 0.5, y + 0.5);
      raw.set(c.map((v) => Math.max(0, Math.min(255, Math.round(v)))), y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

/** coverage (0..1) of a band |d| < w/2, antialiased over one pixel */
const band = (d: number, w: number, aa: number) => Math.max(0, Math.min(1, (w / 2 - Math.abs(d)) / aa + 0.5));
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

function icon(size: number, scale = 1) {
  const c = size / 2, aa = 1;
  const R = size * 0.27 * scale, W = size * 0.075 * scale;
  return png(size, (x, y) => {
    const dx = x - c, dy = y - c, r = Math.hypot(dx, dy);
    let col = BG;
    // soft glow
    col = mix(col, GREEN, 0.18 * Math.exp(-(((r - R) / (size * 0.08 * scale)) ** 2)));
    col = mix(col, GREEN, band(r - R, W, aa));
    // crosshair ticks outside and inside the ring
    const tick = (u: number, v: number) => (Math.abs(u) > R - W * 2.6 && Math.abs(u) < R + W * 2.4 && Math.abs(u) > 0 ? band(v, W * 0.45, aa) : 0) * (Math.abs(u) > R + W * 0.9 || Math.abs(u) < R - W * 0.9 ? 1 : 0);
    col = mix(col, CYAN, Math.max(tick(dx, dy), tick(dy, dx)));
    // the tip: a dot at the centre
    col = mix(col, CYAN, band(r, W * 1.1, aa));
    return col;
  });
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", icon(192));
writeFileSync("public/icons/icon-512.png", icon(512));
writeFileSync("public/icons/icon-maskable-512.png", icon(512, 0.78));
console.log("public/icons: icon-192.png, icon-512.png, icon-maskable-512.png");
