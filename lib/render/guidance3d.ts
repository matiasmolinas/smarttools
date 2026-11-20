// Guidance on the part, in three.js (lib/guidance.ts is the model): the next hole glows and pulses, done
// screws turn green, the others carry their number; an approach tunnel rises from the active hole along
// its axis; x-ray shows the screw's path through the part (drawn over it), how far it has gone and the
// material left beyond its tip. Everything is on layer 0, so the phone's camera view shows it too.

import * as THREE from "three";
import type { Guidance } from "../guidance.ts";
import { toMatrix4ColumnMajor, type Xf } from "../xform.ts";

const COL = { ok: 0x3dffa8, warn: 0xffb547, bad: 0xff5a6a, cyan: 0x5ad8ff, grey: 0x8a98a8, white: 0xe8eef5 };

function label(text: string, color = "#e8eef5", bg = "rgba(5,8,13,0.72)") {
  const c = document.createElement("canvas");
  const font = "600 30px ui-monospace, monospace";
  const probe = c.getContext("2d")!;
  probe.font = font;
  c.width = Math.max(128, Math.ceil(probe.measureText(text).width) + 40);
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(4, 8, c.width - 8, 48, 14);
  g.fill();
  g.font = font;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(text, c.width / 2, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.renderOrder = 20;
  s.userData.aspect = c.width / c.height;
  return s;
}
/** Sprite height in metres, width from its text. */
function size(s: THREE.Sprite, h: number) {
  s.scale.set(h * ((s.userData.aspect as number) ?? 2), h, 1);
}

const glowMat = (color: number, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

/** A group placed at a frame (hole frame: +Z into the part). */
function placed(): THREE.Group {
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  return g;
}
const place = (g: THREE.Object3D, w: Xf) => {
  g.matrix.fromArray(toMatrix4ColumnMajor(w));
  g.matrixWorldNeedsUpdate = true;
};

interface HoleObj {
  g: THREE.Group;
  ring: THREE.Mesh;
  halo: THREE.Mesh;
  tag: THREE.Sprite;
  state: string;
}

export class GuidanceLayer {
  readonly root = new THREE.Group();
  private holes = new Map<string, HoleObj>();
  private tunnel = placed();
  private tunnelTube: THREE.Mesh;
  private tunnelRings: THREE.Mesh[] = [];
  private xray = placed();
  private xPlanned: THREE.Mesh;
  private xDriven: THREE.Mesh;
  private xLeft: THREE.Mesh;
  private xTag: THREE.Sprite | null = null;
  private xText = "";
  /** turn parts of the layer on and off */
  show = { glow: true, tunnel: true, xray: true };
  private ghost = placed();

  constructor() {
    this.root.renderOrder = 10;
    // tunnel: an open tube out of the hole (-Z), and rings every 12 mm
    const tube = new THREE.CylinderGeometry(0.0032, 0.0032, 1, 32, 1, true);
    tube.rotateX(Math.PI / 2);
    this.tunnelTube = new THREE.Mesh(tube, glowMat(COL.cyan, 0.18));
    this.tunnel.add(this.tunnelTube);
    for (let i = 0; i < 5; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.0045 + i * 0.0009, 0.00045, 8, 48), glowMat(COL.cyan, 0.7 - i * 0.1));
      this.tunnelRings.push(r);
      this.tunnel.add(r);
    }
    this.root.add(this.tunnel);
    // x-ray: drawn over the part (no depth test)
    const shaft = (r: number, color: number, op: number) => {
      const geo = new THREE.CylinderGeometry(r, r, 1, 20);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, 0, 0.5);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, depthTest: false, depthWrite: false }));
      m.renderOrder = 15;
      return m;
    };
    this.xPlanned = shaft(0.0026, COL.cyan, 0.35);
    this.xDriven = shaft(0.0021, COL.ok, 0.95);
    this.xLeft = shaft(0.0009, COL.warn, 0.6);
    this.xray.add(this.xPlanned, this.xDriven, this.xLeft);
    this.root.add(this.xray);
    // a ghost tool (an expert's run to follow): the bit and the chuck, translucent
    const bit = new THREE.CylinderGeometry(0.0032, 0.0032, 0.06, 16);
    bit.rotateX(Math.PI / 2);
    bit.translate(0, 0, -0.03);
    const chuck = new THREE.CylinderGeometry(0.014, 0.011, 0.05, 24);
    chuck.rotateX(Math.PI / 2);
    chuck.translate(0, 0, -0.085);
    const body = new THREE.CylinderGeometry(0.026, 0.026, 0.12, 24);
    body.rotateX(Math.PI / 2);
    body.translate(0, 0, -0.17);
    for (const g of [bit, chuck, body]) this.ghost.add(new THREE.Mesh(g, glowMat(COL.cyan, 0.22)));
    this.ghost.visible = false;
    this.root.add(this.ghost);
  }

  /** Show a ghost tool at a world pose (+Z along the bit, origin at the tip), or hide it. */
  setGhostTool(w: Xf | null) {
    this.ghost.visible = !!w;
    if (w) place(this.ghost, w);
  }

  private hole(name: string): HoleObj {
    let h = this.holes.get(name);
    if (h) return h;
    const g = placed();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0052, 0.0007, 10, 48), glowMat(COL.grey, 0.8));
    ring.position.z = -0.0006;
    const halo = new THREE.Mesh(new THREE.CircleGeometry(0.011, 48), glowMat(COL.ok, 0.0));
    halo.position.z = -0.0008;
    g.add(ring, halo);
    const tag = label(name);
    size(tag, 0.008);
    tag.position.set(0, 0, -0.012);
    g.add(tag);
    this.root.add(g);
    h = { g, ring, halo, tag, state: "" };
    this.holes.set(name, h);
    return h;
  }

  /** Update from the guidance model at time t (seconds, for the pulse). */
  update(m: Guidance, t: number) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    const seen = new Set<string>();
    for (const hm of m.holes) {
      const h = this.hole(hm.name);
      seen.add(hm.name);
      place(h.g, hm.world);
      h.g.visible = this.show.glow;
      const ringM = h.ring.material as THREE.MeshBasicMaterial;
      const haloM = h.halo.material as THREE.MeshBasicMaterial;
      if (hm.state !== h.state) {
        h.state = hm.state;
        h.tag.material.map?.dispose();
        const txt = hm.state === "done" ? "✓" : `${hm.order}`;
        const color = hm.state === "done" ? "#3dffa8" : hm.state === "active" || hm.state === "next" ? "#ffb547" : "#c8d2dc";
        const nl = label(txt, color);
        h.tag.material = nl.material;
        h.tag.userData.aspect = nl.userData.aspect;
      }
      // focus: close to a hole, the others fade
      const focus = m.tunnel && m.tunnel.gapMm < 25 && hm.state !== "active" ? 0.25 : 1;
      h.tag.material.opacity = focus;
      if (hm.state === "done") {
        // heat map: the grade of the finished screw
        const q = hm.quality === "redo" ? COL.bad : hm.quality === "fair" ? COL.warn : COL.ok;
        ringM.color.setHex(q);
        ringM.opacity = 0.9 * focus;
        haloM.color.setHex(q);
        haloM.opacity = hm.quality === "redo" ? 0.25 : 0;
        size(h.tag, 0.006);
      } else if (hm.state === "active" || hm.state === "next") {
        const c = hm.state === "active" ? COL.ok : COL.warn;
        ringM.color.setHex(c);
        ringM.opacity = 0.75 + 0.25 * pulse;
        haloM.color.setHex(c);
        haloM.opacity = 0.12 + 0.28 * pulse;
        const s = 1 + 0.35 * pulse;
        h.halo.scale.set(s, s, 1);
        size(h.tag, 0.008);
      } else {
        ringM.color.setHex(COL.grey);
        ringM.opacity = 0.45 * focus;
        haloM.opacity = 0;
        size(h.tag, 0.006);
      }
    }
    for (const [name, h] of this.holes) if (!seen.has(name)) h.g.visible = false;

    // tunnel
    const tu = m.tunnel;
    this.tunnel.visible = !!tu && this.show.tunnel && !(m.xray && m.xray.drivenMm > 0.5);
    if (tu) {
      place(this.tunnel, tu.world);
      const c = COL[tu.state];
      this.tunnelTube.scale.set(1, 1, tu.length);
      this.tunnelTube.position.z = -tu.length / 2;
      (this.tunnelTube.material as THREE.MeshBasicMaterial).color.setHex(c);
      this.tunnelRings.forEach((r, i) => {
        // rings flow toward the hole
        const k = ((i + (t * 0.8) % 1) / this.tunnelRings.length) % 1;
        r.position.z = -tu.length * (1 - k);
        const mm = r.material as THREE.MeshBasicMaterial;
        mm.color.setHex(c);
        mm.opacity = 0.15 + 0.7 * k;
      });
    }

    // x-ray
    const x = m.xray;
    this.xray.visible = !!x && this.show.xray;
    if (x) {
      place(this.xray, x.world);
      const mm = 0.001;
      this.xPlanned.scale.set(1, 1, Math.max(1e-4, x.plannedMm * mm));
      this.xDriven.scale.set(1, 1, Math.max(1e-4, x.drivenMm * mm));
      this.xDriven.visible = x.drivenMm > 0.05;
      const left = Number.isFinite(x.materialMm) ? Math.max(0, x.leftMm) : 0;
      this.xLeft.position.z = x.plannedMm * mm;
      this.xLeft.scale.set(1, 1, Math.max(1e-4, left * mm));
      this.xLeft.visible = left > 0.2;
      (this.xLeft.material as THREE.MeshBasicMaterial).color.setHex(x.breakthrough ? COL.bad : COL.warn);
      const text = x.breakthrough ? "breaks through!" : Number.isFinite(x.leftMm) ? `${x.leftMm.toFixed(0)} mm left` : "";
      if (text !== this.xText) {
        this.xText = text;
        if (this.xTag) {
          this.xray.remove(this.xTag);
          this.xTag.material.map?.dispose();
          this.xTag.material.dispose();
        }
        this.xTag = text ? label(text, x.breakthrough ? "#ff8a96" : "#ffcf87") : null;
        if (this.xTag) {
          size(this.xTag, 0.0085);
          this.xTag.center.set(0, 0.5);
          this.xray.add(this.xTag);
        }
      }
      if (this.xTag) this.xTag.position.set(0.008, 0, (x.plannedMm + left) * mm);
    }
    this.root.updateMatrixWorld(true);
  }

  dispose() {
    this.root.traverse((c) => {
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat && "map" in mat) (mat as THREE.SpriteMaterial).map?.dispose();
      mat?.dispose();
    });
  }
}
