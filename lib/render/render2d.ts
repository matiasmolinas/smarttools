// 2D plan renderer: draws every node's `visual2d` in the XY plane of a chosen frame (the sheet, or the
// active target). It reads only a SceneDef and an engine snapshot, so it can draw any job, and the
// engine never depends on it.

import { BOARD_MARKERS, MARKER_SIZE, SHEET } from "../board.ts";
import type { EngineSnapshot } from "../engine.ts";
import type { SceneDef, Visual2D } from "../scenedef.ts";
import { applyPoint, inverse, compose, type Xf } from "../xform.ts";
import type { V3 } from "../pose.ts";

/** The subset of CanvasRenderingContext2D the renderer uses (easy to mock in tests). */
export interface Ctx2D {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  closePath(): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(t: string, x: number, y: number): void;
  setLineDash(d: number[]): void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  font: string;
}

export interface PlanView {
  /** node whose XY plane is the drawing plane (e.g. "sheet") */
  frame: string;
  /** node to keep centred (e.g. "tool"); otherwise the frame origin */
  follow?: string;
  pxPerM: number;
  width: number;
  height: number;
}

export interface PlanColors {
  ink: string;
  dim: string;
  ok: string;
  warn: string;
  active: string;
  paper: string;
}
export const PLAN_COLORS: PlanColors = { ink: "#e8eef5", dim: "rgba(232,238,245,0.35)", ok: "#3dffa8", warn: "#ffb547", active: "#5ad8ff", paper: "rgba(232,238,245,0.06)" };

type NodeIds = Record<string, number>;

/** Draw the plan. Returns the screen position of each drawn node origin (for tests and hit-testing). */
export function drawPlan(ctx: Ctx2D, def: SceneDef, ids: NodeIds, s: EngineSnapshot, view: PlanView, colors: PlanColors = PLAN_COLORS) {
  const worldOf = (name: string): Xf | null => s.nodes.find((n) => n.id === ids[name])?.world ?? null;
  const statusOf = (name: string) => s.nodes.find((n) => n.id === ids[name])?.status ?? "lost";
  const frameW = worldOf(view.frame);
  if (!frameW) return {};
  const toFrame = inverse(frameW);
  let cx = 0, cy = 0;
  if (view.follow) {
    const f = worldOf(view.follow);
    if (f) {
      const p = applyPoint(toFrame, f.p);
      cx = p[0];
      cy = p[1];
    }
  }
  const k = view.pxPerM;
  const scr = (p: V3) => ({ x: view.width / 2 + (p[0] - cx) * k, y: view.height / 2 - (p[1] - cy) * k });
  /** a point given in a node's frame -> screen */
  const at = (nodeW: Xf, local: V3) => scr(applyPoint(compose(toFrame, nodeW), local));

  const activeId = s.active >= 0 ? s.targets[s.active]?.id : -1;
  const drawn: Record<string, { x: number; y: number }> = {};
  for (const node of def.nodes) {
    const w = worldOf(node.name);
    if (!w || !node.visual2d?.length) continue;
    const st = statusOf(node.name);
    ctx.save();
    ctx.globalAlpha = st === "lost" || st === "stale" ? 0.3 : 1;
    for (const v of node.visual2d) drawVisual(ctx, v, w, at, k, colors, { active: ids[node.name] === activeId, drilled: isDrilled(s, ids[node.name]), ready: s.ready, locking: s.locking });
    ctx.restore();
    drawn[node.name] = at(w, [0, 0, 0]);
  }
  return drawn;
}

function isDrilled(s: EngineSnapshot, id: number) {
  return s.targets.find((t) => t.id === id)?.drilled ?? false;
}

function drawVisual(
  ctx: Ctx2D,
  v: Visual2D,
  w: Xf,
  at: (w: Xf, p: V3) => { x: number; y: number },
  k: number,
  c: PlanColors,
  st: { active: boolean; drilled: boolean; ready: boolean; locking: boolean },
) {
  const line = (pts: { x: number; y: number }[], color: string, width = 1.5, close = false) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (close) ctx.closePath();
    ctx.stroke();
  };
  switch (v.kind) {
    case "markerSheet": {
      const hw = SHEET.w / 2, hh = SHEET.h / 2;
      const corners = [at(w, [-hw, -hh, 0]), at(w, [hw, -hh, 0]), at(w, [hw, hh, 0]), at(w, [-hw, hh, 0])];
      ctx.fillStyle = c.paper;
      ctx.beginPath();
      corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      line(corners, c.dim, 1, true);
      const h = MARKER_SIZE / 2;
      ctx.fillStyle = c.dim;
      for (const m of BOARD_MARKERS) {
        const q = [at(w, [m.x - h, m.y - h, 0]), at(w, [m.x + h, m.y - h, 0]), at(w, [m.x + h, m.y + h, 0]), at(w, [m.x - h, m.y + h, 0])];
        ctx.beginPath();
        q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "crosshair": {
      const color = v.color ?? (st.drilled ? c.ok : st.active ? c.active : c.ink);
      const s = v.size;
      line([at(w, [-s, 0, 0]), at(w, [s, 0, 0])], color, st.active ? 2 : 1.2);
      line([at(w, [0, -s, 0]), at(w, [0, s, 0])], color, st.active ? 2 : 1.2);
      const o = at(w, [0, 0, 0]);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(o.x, o.y, Math.max(2, s * 0.5 * k), 0, Math.PI * 2);
      ctx.stroke();
      if (st.drilled) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(o.x, o.y, Math.max(2, s * 0.4 * k), 0, Math.PI * 2);
        ctx.fill();
      }
      // planned drilling direction: where the hole ends (35 mm along +Z), drawn dashed
      const end = at(w, [0, 0, 0.035]);
      if (Math.hypot(end.x - o.x, end.y - o.y) > 1) {
        ctx.setLineDash([4, 3]);
        line([o, end], color, 1);
        ctx.setLineDash([]);
      }
      if (v.label) {
        ctx.fillStyle = color;
        ctx.font = "11px ui-monospace, monospace";
        ctx.fillText(v.label, o.x + s * k + 4, o.y - s * k - 2);
      }
      break;
    }
    case "rings": {
      const color = v.color && !st.ready ? v.color : st.ready ? c.ok : c.warn;
      const tip = at(w, [0, 0, 0]);
      const chuck = at(w, [0, 0, -v.chuckOffset]);
      ctx.setLineDash([3, 3]);
      line([chuck, tip], color, 1);
      ctx.setLineDash([]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(chuck.x, chuck.y, Math.max(3, v.chuckRadius * k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, Math.max(2, v.tipRadius * k), 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "dot": {
      const o = at(w, [0, 0, 0]);
      ctx.fillStyle = v.color ?? c.ink;
      ctx.beginPath();
      ctx.arc(o.x, o.y, Math.max(2, v.radius * k), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "label": {
      const o = at(w, [0, 0, 0]);
      ctx.fillStyle = v.color ?? c.ink;
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText(v.text, o.x + 4, o.y - 4);
      break;
    }
    case "rect": {
      const [hw, hh] = [v.size[0] / 2, v.size[1] / 2];
      line([at(w, [-hw, -hh, 0]), at(w, [hw, -hh, 0]), at(w, [hw, hh, 0]), at(w, [-hw, hh, 0])], v.color ?? c.dim, 1, true);
      break;
    }
  }
}
