// 3D renderer (three.js): one Object3D per scene node with `visual3d`, placed every frame from the
// engine snapshot's world transforms. Primitives and STL meshes, with surface properties. The engine
// never depends on this module; it can be dropped (headless) or replaced.

import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { BOARD_MARKERS, MARKER_SIZE, SHEET } from "../board.ts";
import type { EngineSnapshot } from "../engine.ts";
import type { Material, SceneDef, Visual3D } from "../scenedef.ts";
import { toXf } from "../scenedef.ts";
import { toMatrix4ColumnMajor } from "../xform.ts";

export type MeshLoader = (url: string) => Promise<THREE.BufferGeometry>;

/** Default STL loader (browser fetch). Tests pass their own. */
export const fetchStl: MeshLoader = async (url) => {
  const buf = await (await fetch(url)).arrayBuffer();
  return new STLLoader().parse(buf);
};

export interface Scene3DOptions {
  loadMesh?: MeshLoader;
  /** marker codes (36 bits per id, scene.markerCodes) to draw the real patterns on the sheet */
  markerCodes?: Uint8Array;
}

export class Scene3D {
  readonly root = new THREE.Group();
  /** node name -> its object (world transform from the snapshot) */
  readonly objects = new Map<string, THREE.Object3D>();
  /** resolves when every mesh has loaded */
  readonly ready: Promise<void>;
  private def: SceneDef;

  constructor(def: SceneDef, o: Scene3DOptions = {}) {
    this.def = def;
    const loads: Promise<void>[] = [];
    for (const n of def.nodes) {
      if (!n.visual3d?.length) continue;
      const obj = new THREE.Group();
      obj.name = n.name;
      obj.matrixAutoUpdate = false;
      for (const v of n.visual3d) {
        const holder = new THREE.Group();
        const off = toXf(v.offset);
        holder.matrix.fromArray(toMatrix4ColumnMajor(off));
        holder.matrixAutoUpdate = false;
        obj.add(holder);
        const made = buildVisual(v, o, holder);
        if (made) loads.push(made);
      }
      this.objects.set(n.name, obj);
      this.root.add(obj);
    }
    this.ready = Promise.all(loads).then(() => undefined);
  }

  /** Place every node from a snapshot. Nodes that are lost are faded. */
  update(s: EngineSnapshot, ids: Record<string, number>) {
    for (const [name, obj] of this.objects) {
      const st = s.nodes.find((n) => n.id === ids[name]);
      if (!st) {
        obj.visible = false;
        continue;
      }
      obj.visible = true;
      obj.matrix.fromArray(toMatrix4ColumnMajor(st.world));
      obj.matrixWorldNeedsUpdate = true;
      const faded = st.status === "lost" || st.status === "stale";
      obj.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.Material | undefined;
        if (m && "opacity" in m) {
          const base = (m.userData.baseOpacity as number | undefined) ?? 1;
          m.opacity = faded ? base * 0.3 : base;
          m.transparent = m.opacity < 1;
        }
      });
    }
    this.root.updateMatrixWorld(true);
  }

  dispose() {
    this.root.traverse((c) => {
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }

  get definition() {
    return this.def;
  }
}

function material(m: Material): THREE.Material {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(m.color),
    metalness: m.metalness ?? 0.1,
    roughness: m.roughness ?? 0.6,
    emissive: m.emissive ? new THREE.Color(m.emissive) : new THREE.Color(0x000000),
    wireframe: !!m.wireframe,
    transparent: (m.opacity ?? 1) < 1,
    opacity: m.opacity ?? 1,
  });
  mat.userData.baseOpacity = m.opacity ?? 1;
  return mat;
}

function withEdges(mesh: THREE.Mesh, m: Material, into: THREE.Object3D) {
  into.add(mesh);
  if (m.edges) {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), new THREE.LineBasicMaterial({ color: 0x5ad8ff, transparent: true, opacity: 0.55 }));
    e.material.userData.baseOpacity = 0.55;
    e.matrix.copy(mesh.matrix);
    e.matrixAutoUpdate = mesh.matrixAutoUpdate;
    e.position.copy(mesh.position);
    e.quaternion.copy(mesh.quaternion);
    into.add(e);
  }
}

function buildVisual(v: Visual3D, o: Scene3DOptions, into: THREE.Object3D): Promise<void> | null {
  switch (v.kind) {
    case "box":
      withEdges(new THREE.Mesh(new THREE.BoxGeometry(...v.size), material(v.material)), v.material, into);
      return null;
    case "sphere":
      withEdges(new THREE.Mesh(new THREE.SphereGeometry(v.radius, 24, 16), material(v.material)), v.material, into);
      return null;
    case "plane":
      withEdges(new THREE.Mesh(new THREE.PlaneGeometry(...v.size), material(v.material)), v.material, into);
      return null;
    case "cylinder": {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(v.radius, v.radius, v.length, 32), material(v.material));
      // three.js cylinders run along Y
      if ((v.axis ?? "y") === "z") mesh.rotation.x = Math.PI / 2;
      if (v.axis === "x") mesh.rotation.z = Math.PI / 2;
      withEdges(mesh, v.material, into);
      return null;
    }
    case "axes":
      into.add(new THREE.AxesHelper(v.length));
      return null;
    case "line": {
      const g = new THREE.BufferGeometry().setFromPoints(v.points.map((p) => new THREE.Vector3(...p)));
      const m = v.dashed
        ? new THREE.LineDashedMaterial({ color: v.material.color, dashSize: 0.004, gapSize: 0.003, transparent: true, opacity: v.material.opacity ?? 1 })
        : new THREE.LineBasicMaterial({ color: v.material.color, transparent: true, opacity: v.material.opacity ?? 1 });
      m.userData.baseOpacity = v.material.opacity ?? 1;
      const l = new THREE.Line(g, m);
      if (v.dashed) l.computeLineDistances();
      into.add(l);
      return null;
    }
    case "markerSheet": {
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(SHEET.w, SHEET.h), material({ color: "#f4f6f8", roughness: 0.9 }));
      into.add(paper);
      const black = material({ color: "#111418", roughness: 0.8 });
      const white = material({ color: "#f4f6f8", roughness: 0.9 });
      const cell = MARKER_SIZE / 8;
      const sq = new THREE.PlaneGeometry(MARKER_SIZE, MARKER_SIZE);
      const cellG = new THREE.PlaneGeometry(cell, cell);
      for (const m of BOARD_MARKERS) {
        const b = new THREE.Mesh(sq, black);
        b.position.set(m.x, m.y, 0.0002);
        into.add(b);
        if (!o.markerCodes) continue;
        for (let i = 0; i < 36; i++) {
          if (o.markerCodes[m.id * 36 + i] !== 1) continue;
          const c = new THREE.Mesh(cellG, white);
          c.position.set(m.x - MARKER_SIZE / 2 + cell * (1.5 + (i % 6)), m.y + MARKER_SIZE / 2 - cell * (1.5 + Math.floor(i / 6)), 0.0004);
          into.add(c);
        }
      }
      return null;
    }
    case "mesh": {
      const loader = o.loadMesh ?? fetchStl;
      return loader(v.url).then((g) => {
        g.computeVertexNormals();
        withEdges(new THREE.Mesh(g, material(v.material)), { ...v.material, edges: false }, into);
      });
    }
  }
}
