// 2D navigation HUD: what the user sees on the phone mounted behind the drill.
// Target-stabilised view: the target crosshair stays centred, the TIP ring and the
// CHUCK ring move. Concentric rings on the crosshair = on target and square to the wall.

import {
  ANGLE_TOL_DEG,
  DEPTH_TARGET_MM,
  MARKERS,
  OFFSET_TOL_MM,
  START_GAP,
  TARGETS,
  athosStep,
  type SimState,
} from "./sim";

const GREEN = "#3dffa8";
const AMBER = "#ffb547";
const CYAN = "#5ad8ff";
const WHITE = "#e9f2ff";

export function drawHud(ctx: CanvasRenderingContext2D, s: SimState, w: number, h: number, compact = false) {
  const u = Math.min(w, h) / 100; // layout unit
  const cx = w / 2;
  const cy = compact ? h / 2 : h * 0.4;

  // zoom: farther = wider view, closer = more px per metre
  const k = 1 - Math.min(1, s.gapMm / 1000 / START_GAP);
  const scale = (Math.min(w, h) / 0.5) * (1 + 5 * k * k); // px per metre
  const toX = (x: number) => cx + (x - s.target.x) * scale;
  const toY = (y: number) => cy - (y - s.target.y) * scale;

  // ---- simulated camera feed (wall) ----
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
  g.addColorStop(0, "#2a2f36");
  g.addColorStop(1, "#0d1014");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // wall grid (5 cm)
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

  // fiducial markers
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
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = Math.max(1, u * 0.35);
    ctx.strokeRect(X - sz / 2 - 3, Y - sz / 2 - 3, sz + 6, sz + 6);
  }

  // pencil marks of other targets + drilled holes
  TARGETS.forEach((t, i) => {
    const X = toX(t.x);
    const Y = toY(t.y);
    if (s.drilled[i]) {
      ctx.fillStyle = "#050607";
      ctx.beginPath();
      ctx.arc(X, Y, Math.max(2, 0.004 * scale), 0, Math.PI * 2);
      ctx.fill();
    } else if (i !== s.targetIndex) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X - 6, Y);
      ctx.lineTo(X + 6, Y);
      ctx.moveTo(X, Y - 6);
      ctx.lineTo(X, Y + 6);
      ctx.stroke();
    }
  });

  ctx.fillStyle = "rgba(4,8,12,0.25)";
  ctx.fillRect(0, 0, w, h);

  // ---- navigation overlay ----
  const ok = s.aligned && s.onTarget;
  const col = ok ? GREEN : AMBER;

  // target: crosshair + tolerance ring
  const tolR = Math.max(u * 3.2, (OFFSET_TOL_MM / 1000) * scale);
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = Math.max(1, u * 0.3);
  ctx.setLineDash([u, u]);
  ctx.beginPath();
  ctx.arc(cx, cy, tolR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(cx - u * 9, cy);
  ctx.lineTo(cx - u * 4.5, cy);
  ctx.moveTo(cx + u * 4.5, cy);
  ctx.lineTo(cx + u * 9, cy);
  ctx.moveTo(cx, cy - u * 9);
  ctx.lineTo(cx, cy - u * 4.5);
  ctx.moveTo(cx, cy + u * 4.5);
  ctx.lineTo(cx, cy + u * 9);
  ctx.stroke();

  // tip and chuck projections (chuck offset amplified 2.5x so 0.5° is visible)
  const tipX = toX(s.tip.x);
  const tipY = toY(s.tip.y);
  const amp = 2.5;
  const chX = tipX + (s.chuck.x - s.tip.x) * scale * amp;
  const chY = tipY - (s.chuck.y - s.tip.y) * scale * amp;
  const chuckR = u * 10;
  const tipR = u * 4;

  // axis line chuck -> tip
  ctx.strokeStyle = col;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = Math.max(1, u * 0.35);
  ctx.beginPath();
  ctx.moveTo(chX, chY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // chuck ring
  ctx.shadowColor = col;
  ctx.shadowBlur = u * 3;
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1.5, u * 0.8);
  ctx.beginPath();
  ctx.arc(chX, chY, chuckR, 0, Math.PI * 2);
  ctx.stroke();
  // tip ring + dot
  ctx.lineWidth = Math.max(1.5, u * 0.7);
  ctx.beginPath();
  ctx.arc(tipX, tipY, tipR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(tipX, tipY, u * 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // direction hint arrow if chuck ring is far from tip
  const dx = tipX - chX;
  const dy = tipY - chY;
  const dl = Math.hypot(dx, dy);
  if (dl > u * 3 && !compact) {
    ctx.fillStyle = col;
    const ang = Math.atan2(dy, dx);
    const ax = chX + Math.cos(ang) * (chuckR + u * 2.5);
    const ay = chY + Math.sin(ang) * (chuckR + u * 2.5);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(u * 2.5, 0);
    ctx.lineTo(-u * 1.2, -u * 1.6);
    ctx.lineTo(-u * 1.2, u * 1.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ---- text ----
  const mono = (px: number, weight = 500) => `${weight} ${px}px ui-monospace, "Geist Mono", SFMono-Regular, Menlo, monospace`;
  const pad = u * 4;

  // top bar
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, w, u * (compact ? 9 : 8));
  ctx.font = mono(u * (compact ? 4 : 3.2), 600);
  ctx.fillStyle = WHITE;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(s.live ? "● LIVE IMU" : "DRILL NAV", pad, u * (compact ? 4.5 : 4));
  ctx.textAlign = "right";
  ctx.fillStyle = CYAN;
  ctx.fillText("0 tokens · 60 fps", w - pad, u * (compact ? 4.5 : 4));

  // readouts
  const angle = 90 - s.angleErrDeg;
  const rowY = u * (compact ? 15 : 13);
  ctx.textAlign = "left";
  ctx.font = mono(u * (compact ? 5.5 : 4.6), 700);
  ctx.fillStyle = s.aligned ? GREEN : AMBER;
  ctx.fillText(`∠ ${angle.toFixed(1)}°`, pad, rowY);
  ctx.textAlign = "right";
  ctx.fillStyle = s.onTarget ? GREEN : AMBER;
  ctx.fillText(s.gapMm > 0.5 ? `↧ ${s.gapMm.toFixed(0)} mm` : `⊕ ${s.offsetMm.toFixed(1)} mm`, w - pad, rowY);
  ctx.font = mono(u * (compact ? 3.4 : 2.7));
  ctx.fillStyle = "rgba(233,242,255,0.6)";
  ctx.textAlign = "left";
  ctx.fillText(`err ${s.angleErrDeg.toFixed(2)}° / ±${ANGLE_TOL_DEG}°`, pad, rowY + u * (compact ? 5.5 : 4.5));
  ctx.textAlign = "right";
  ctx.fillText(s.gapMm > 0.5 ? "gap to wall" : "tip → target", w - pad, rowY + u * (compact ? 5.5 : 4.5));

  // depth gauge (right edge)
  const gx = w - pad - u * 2;
  const gTop = compact ? h * 0.35 : h * 0.24;
  const gBot = compact ? h * 0.85 : h * 0.58;
  ctx.strokeStyle = "rgba(233,242,255,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(gx - u, gTop, u * 2, gBot - gTop);
  const frac = Math.min(1, s.depthMm / DEPTH_TARGET_MM);
  ctx.fillStyle = frac >= 0.998 ? GREEN : CYAN;
  ctx.fillRect(gx - u, gTop, u * 2, (gBot - gTop) * frac);
  ctx.textAlign = "right";
  ctx.font = mono(u * (compact ? 3.4 : 2.6), 600);
  ctx.fillStyle = WHITE;
  ctx.fillText(`${s.depthMm.toFixed(1)}`, gx - u * 2, gTop + (gBot - gTop) * frac);
  ctx.fillStyle = "rgba(233,242,255,0.5)";
  ctx.fillText(`/${DEPTH_TARGET_MM}mm`, gx + u, gBot + u * 3);

  if (compact) {
    // a single status line at the bottom for the small in-scene screen
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, h - u * 11, w, u * 11);
    const st = athosStep(s);
    ctx.textAlign = "left";
    ctx.font = mono(u * 4, 600);
    ctx.fillStyle = st.pass ? GREEN : AMBER;
    ctx.fillText(`${st.pass ? "✓" : "▸"} ${st.do}`, pad, h - u * 5.5);
    return;
  }

  // ---- Athos step card ----
  const st = athosStep(s);
  const cardY = h * 0.7;
  const cardH = h - cardY - pad;
  ctx.fillStyle = "rgba(6,10,16,0.82)";
  roundRect(ctx, pad, cardY, w - pad * 2, cardH, u * 2.5);
  ctx.fill();
  ctx.strokeStyle = st.pass ? GREEN : "rgba(90,216,255,0.4)";
  ctx.lineWidth = Math.max(1, u * 0.3);
  ctx.stroke();

  const lx = pad * 2;
  let ly = cardY + u * 5;
  const lh = (cardH - u * 6) / 4.4;
  ctx.textAlign = "left";
  ctx.font = mono(u * 2.6, 600);
  ctx.fillStyle = CYAN;
  ctx.fillText(`athos · navigate-drill${st.id}`, lx, ly);
  ly += lh;
  const rows: [string, string, string][] = [
    ["When", st.when, "rgba(233,242,255,0.75)"],
    ["Do", st.do, WHITE],
    ["Check", st.check, st.pass ? GREEN : AMBER],
  ];
  for (const [k, v, c] of rows) {
    ctx.font = mono(u * 3, 700);
    ctx.fillStyle = "rgba(233,242,255,0.45)";
    ctx.fillText(k, lx, ly);
    ctx.font = mono(u * 3, 500);
    ctx.fillStyle = c;
    ctx.fillText(fit(ctx, v, w - lx - pad * 2 - u * 13), lx + u * 13, ly);
    ly += lh;
  }
  ctx.font = mono(u * 3.2, 700);
  ctx.fillStyle = st.pass ? GREEN : "rgba(233,242,255,0.4)";
  ctx.fillText(st.pass ? "✓ CHECK PASSED" : "… verifying", lx, ly);
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 3 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
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
