"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MARKERS, TARGETS, simulate, type SimState } from "@/lib/sim";
import { useLiveImu } from "@/lib/useLiveImu";
import { drawHud } from "@/lib/hud";

const C_CYAN = 0x5ad8ff;
const C_WHITE = 0xe9f2ff;
const C_AMBER = 0xffb547;
const C_GREEN = 0x3dffa8;
const C_DIM = 0x2a4a63;

type Pts = number[];

function seg(p: Pts, a: number[], b: number[]) {
  p.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/** cylinder wireframe along local +z */
function cylinder(p: Pts, r0: number, r1: number, z0: number, z1: number, n = 28, longs = 8, rings = 2) {
  for (let ri = 0; ri <= rings; ri++) {
    const k = ri / rings;
    const r = r0 + (r1 - r0) * k;
    const z = z0 + (z1 - z0) * k;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      seg(p, [Math.cos(a0) * r, Math.sin(a0) * r, z], [Math.cos(a1) * r, Math.sin(a1) * r, z]);
    }
  }
  for (let i = 0; i < longs; i++) {
    const a = (i / longs) * Math.PI * 2;
    seg(p, [Math.cos(a) * r0, Math.sin(a) * r0, z0], [Math.cos(a) * r1, Math.sin(a) * r1, z1]);
  }
}

function box(p: Pts, min: number[], max: number[]) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [a, b] of e) seg(p, c[a], c[b]);
}

function circleXY(p: Pts, cx: number, cy: number, z: number, r: number, n = 48) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    seg(p, [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z], [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z]);
  }
}

function lines(p: Pts, color: number, opacity = 1) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  return new THREE.LineSegments(g, m);
}

function ringMesh(r: number, color: number, opacity = 1) {
  const p: Pts = [];
  circleXY(p, 0, 0, 0, r);
  return lines(p, color, opacity);
}

const LABELS = [
  { key: "phone", text: "Phone in 3D-printed dock · screen → user" },
  { key: "lens", text: "Rear camera → wall markers" },
  { key: "chuck", text: "Chuck" },
  { key: "tip", text: "Bit tip" },
  { key: "marker", text: "Fiducial marker" },
] as const;

export default function NavDemo() {
  const mountRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLCanvasElement>(null);
  const labelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const { live, msg: imuMsg, toggle: toggleLive, tiltRef: liveRef } = useLiveImu();
  const [phaseText, setPhaseText] = useState("approach");

  // ---------- three.js scene ----------
  useEffect(() => {
    const mount = mountRef.current!;
    const hud = hudRef.current!;
    const hudCtx = hud.getContext("2d")!;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x05080d, 1.4, 3.2);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10);
    camera.position.set(0.5, 0.22, 0.62);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.02, 0.12);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.minAzimuthAngle = -1.2;
    controls.maxAzimuthAngle = 1.15;
    controls.minPolarAngle = 0.7;
    controls.maxPolarAngle = 1.9;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.55;

    // ---- wall ----
    const wall = new THREE.Group();
    scene.add(wall);
    const grid: Pts = [];
    for (let x = -0.6; x <= 0.601; x += 0.05) seg(grid, [x, -0.38, 0], [x, 0.4, 0]);
    for (let y = -0.38; y <= 0.401; y += 0.05) seg(grid, [-0.6, y, 0], [0.6, y, 0]);
    wall.add(lines(grid, C_DIM, 0.35));
    const frame: Pts = [];
    box(frame, [-0.6, -0.38, -0.02], [0.6, 0.4, 0]);
    wall.add(lines(frame, C_CYAN, 0.5));

    // fiducial markers (filled cells)
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xdfe8f0, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const darkMat = new THREE.MeshBasicMaterial({ color: 0x05080d, side: THREE.DoubleSide });
    const pattern = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0];
    for (const m of MARKERS) {
      const g = new THREE.Group();
      g.position.set(m.x, m.y, 0.001);
      const sq = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06), markerMat);
      g.add(sq);
      const c = 0.01;
      pattern.forEach((on, i) => {
        if (!on) return;
        const cell = new THREE.Mesh(new THREE.PlaneGeometry(c, c), darkMat);
        cell.position.set(-0.03 + c * (1.5 + (i % 4)), 0.03 - c * (1.5 + Math.floor(i / 4)), 0.0005);
        g.add(cell);
      });
      const outline: Pts = [];
      box(outline, [-0.036, -0.036, 0], [0.036, 0.036, 0.001]);
      g.add(lines(outline, C_CYAN, 0.9));
      wall.add(g);
    }

    // targets + holes
    const targetGroups = TARGETS.map((t) => {
      const g = new THREE.Group();
      g.position.set(t.x, t.y, 0.0015);
      const p: Pts = [];
      seg(p, [-0.02, 0, 0], [-0.008, 0, 0]);
      seg(p, [0.008, 0, 0], [0.02, 0, 0]);
      seg(p, [0, -0.02, 0], [0, -0.008, 0]);
      seg(p, [0, 0.008, 0], [0, 0.02, 0]);
      circleXY(p, 0, 0, 0, 0.012, 32);
      const cross = lines(p, C_WHITE, 0.55);
      g.add(cross);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.005, 24), new THREE.MeshBasicMaterial({ color: 0x000000 }));
      hole.position.z = 0.0005;
      hole.visible = false;
      g.add(hole);
      const holeRing = ringMesh(0.007, C_GREEN, 0.9);
      holeRing.visible = false;
      g.add(holeRing);
      wall.add(g);
      return { g, cross, hole, holeRing };
    });

    // projected 2D nav on the wall plane ("2D inside 3D")
    const projTip = ringMesh(0.008, C_AMBER);
    const projChuck = ringMesh(0.02, C_AMBER);
    projTip.position.z = projChuck.position.z = 0.003;
    scene.add(projTip, projChuck);
    const projLinkGeo = new THREE.BufferGeometry();
    projLinkGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Array(6).fill(0), 3));
    const projLink = new THREE.LineSegments(projLinkGeo, new THREE.LineBasicMaterial({ color: C_AMBER, transparent: true, opacity: 0.6 }));
    scene.add(projLink);

    // ideal axis (wall normal at active target)
    const idealGeo = new THREE.BufferGeometry();
    idealGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0.45], 3));
    const ideal = new THREE.Line(idealGeo, new THREE.LineDashedMaterial({ color: C_GREEN, dashSize: 0.01, gapSize: 0.008, transparent: true, opacity: 0.55 }));
    ideal.computeLineDistances();
    scene.add(ideal);

    // ---- drill (local frame: tip at origin, body toward +z) ----
    const drill = new THREE.Group();
    scene.add(drill);
    const spin = new THREE.Group();
    drill.add(spin);

    // bit with helical flutes
    const bitP: Pts = [];
    seg(bitP, [0, 0, 0], [0, 0, 0.11]);
    for (const off of [0, Math.PI]) {
      let prev: number[] | null = null;
      for (let i = 0; i <= 80; i++) {
        const z = 0.004 + (i / 80) * 0.075;
        const a = off + z * 260;
        const cur = [Math.cos(a) * 0.0035, Math.sin(a) * 0.0035, z];
        if (prev) seg(bitP, prev, cur);
        prev = cur;
      }
    }
    seg(bitP, [0.0035, 0, 0.079], [0.0035, 0, 0.11]);
    seg(bitP, [-0.0035, 0, 0.079], [-0.0035, 0, 0.11]);
    spin.add(lines(bitP, C_WHITE));
    const chuckP: Pts = [];
    cylinder(chuckP, 0.012, 0.021, 0.11, 0.15, 28, 12, 3);
    cylinder(chuckP, 0.026, 0.026, 0.15, 0.168, 32, 16, 1);
    spin.add(lines(chuckP, C_CYAN));

    const bodyP: Pts = [];
    cylinder(bodyP, 0.031, 0.034, 0.168, 0.33, 32, 10, 4);
    circleXY(bodyP, 0, 0, 0.33, 0.02, 24);
    // vents
    for (let i = 0; i < 5; i++) seg(bodyP, [0.034, 0.008, 0.29 + i * 0.006], [0.034, -0.008, 0.29 + i * 0.006]);
    drill.add(lines(bodyP, C_CYAN));

    const handle = new THREE.Group();
    const handleP: Pts = [];
    box(handleP, [-0.018, -0.15, -0.024], [0.018, 0, 0.024]);
    seg(handleP, [-0.018, -0.03, -0.024], [0.018, -0.03, -0.024]);
    handle.add(lines(handleP, C_CYAN));
    // trigger
    const trigP: Pts = [];
    box(trigP, [-0.006, -0.05, -0.034], [0.006, -0.025, -0.024]);
    handle.add(lines(trigP, C_AMBER));
    handle.position.set(0, -0.028, 0.265);
    handle.rotation.x = -0.22;
    drill.add(handle);

    const battP: Pts = [];
    box(battP, [-0.038, -0.225, 0.215], [0.038, -0.175, 0.355]);
    box(battP, [-0.03, -0.182, 0.235], [0.03, -0.172, 0.335]);
    drill.add(lines(battP, C_CYAN, 0.85));

    // dock (3D printed) - amber
    const dockP: Pts = [];
    cylinder(dockP, 0.037, 0.037, 0.255, 0.285, 32, 12, 1);
    box(dockP, [-0.012, 0.035, 0.258], [0.012, 0.075, 0.282]);
    box(dockP, [-0.012, 0.062, 0.27], [0.012, 0.075, 0.365]);
    drill.add(lines(dockP, C_AMBER));

    // phone (landscape), screen faces the user (+z), camera faces the wall (-z)
    const phone = new THREE.Group();
    phone.position.set(0, 0.112, 0.37);
    phone.rotation.x = -0.38;
    drill.add(phone);
    const phP: Pts = [];
    box(phP, [-0.078, -0.038, -0.0045], [0.078, 0.038, 0.0045]);
    phone.add(lines(phP, C_WHITE, 0.9));
    const cradle: Pts = [];
    box(cradle, [-0.082, -0.042, -0.011], [-0.07, 0.042, -0.0045]);
    box(cradle, [0.07, -0.042, -0.011], [0.082, 0.042, -0.0045]);
    box(cradle, [-0.082, -0.046, -0.011], [0.082, -0.038, 0.006]);
    phone.add(lines(cradle, C_AMBER));
    const lens = new THREE.Group();
    lens.position.set(0.058, 0.022, -0.0055);
    const lensP: Pts = [];
    circleXY(lensP, 0, 0, 0, 0.006, 20);
    circleXY(lensP, 0, 0, 0, 0.003, 16);
    lens.add(lines(lensP, C_CYAN));
    phone.add(lens);

    const screenCanvas = document.createElement("canvas");
    screenCanvas.width = 640;
    screenCanvas.height = 312;
    const screenCtx = screenCanvas.getContext("2d")!;
    const screenTex = new THREE.CanvasTexture(screenCanvas);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.148, 0.072),
      new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }),
    );
    screen.position.z = 0.0047;
    phone.add(screen);

    // camera frustum from lens to wall
    const frustGeo = new THREE.BufferGeometry();
    frustGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Array(8 * 6).fill(0), 3));
    const frust = new THREE.LineSegments(frustGeo, new THREE.LineBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.22 }));
    scene.add(frust);

    // drill axis extension (chuck -> wall)
    const axisGeo = new THREE.BufferGeometry();
    axisGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Array(6).fill(0), 3));
    const axisLine = new THREE.Line(axisGeo, new THREE.LineDashedMaterial({ color: C_AMBER, dashSize: 0.008, gapSize: 0.006 }));
    scene.add(axisLine);

    // ---- sizing ----
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      camera.fov = w < 520 ? 52 : 38;
      camera.updateProjectionMatrix();
      const dpr = Math.min(window.devicePixelRatio, 2);
      hud.width = Math.round(hud.clientWidth * dpr);
      hud.height = Math.round(hud.clientHeight * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    ro.observe(hud);
    resize();

    // pause when off-screen
    let visible = true;
    const io = new IntersectionObserver((e) => (visible = e[0].isIntersecting));
    io.observe(mount);

    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const fwd = new THREE.Vector3(0, 0, -1);
    const colA = new THREE.Color(C_AMBER);
    const colG = new THREE.Color(C_GREEN);
    const clock = new THREE.Clock();
    let simT = 0;
    let raf = 0;
    let lastPhase = "";

    const setLabel = (key: string, v: THREE.Vector3) => {
      const el = labelRefs.current[key];
      if (!el) return;
      tmp2.copy(v).project(camera);
      const x = (tmp2.x * 0.5 + 0.5) * mount.clientWidth;
      const y = (-tmp2.y * 0.5 + 0.5) * mount.clientHeight;
      const hidden = tmp2.z > 1 || x < 0 || x > mount.clientWidth || y < 0 || y > mount.clientHeight;
      el.style.opacity = hidden ? "0" : "1";
      el.style.transform = `translate(${x}px, ${y}px)`;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (!visible) return;
      simT += dt;
      const s: SimState = simulate(simT, liveRef.current);

      // drill pose
      drill.position.set(s.tip.x, s.tip.y, s.tip.z);
      q.setFromUnitVectors(fwd, tmp.set(s.axis.x, s.axis.y, s.axis.z));
      drill.quaternion.copy(q);
      spin.rotation.z = s.bitSpin;

      const ok = s.aligned && s.onTarget;
      const col = ok ? colG : colA;

      // projections on wall
      projTip.position.set(s.tip.x, s.tip.y, 0.003);
      projChuck.position.set(s.chuck.x, s.chuck.y, 0.003);
      (projTip.material as THREE.LineBasicMaterial).color.copy(col);
      (projChuck.material as THREE.LineBasicMaterial).color.copy(col);
      const pl = projLinkGeo.attributes.position as THREE.BufferAttribute;
      pl.setXYZ(0, s.chuck.x, s.chuck.y, 0.003);
      pl.setXYZ(1, s.tip.x, s.tip.y, 0.003);
      pl.needsUpdate = true;
      (projLink.material as THREE.LineBasicMaterial).color.copy(col);

      ideal.position.set(s.target.x, s.target.y, 0);

      // axis line: from chuck nose to wall intersection
      const tWall = s.chuck.z / -s.axis.z;
      const ag = axisGeo.attributes.position as THREE.BufferAttribute;
      ag.setXYZ(0, s.chuck.x, s.chuck.y, s.chuck.z);
      ag.setXYZ(1, s.chuck.x + s.axis.x * tWall, s.chuck.y + s.axis.y * tWall, 0);
      ag.needsUpdate = true;
      axisLine.computeLineDistances();
      (axisLine.material as THREE.LineDashedMaterial).color.copy(col);

      targetGroups.forEach((tg, i) => {
        tg.hole.visible = s.drilled[i];
        tg.holeRing.visible = s.drilled[i];
        const m = tg.cross.material as THREE.LineBasicMaterial;
        m.opacity = i === s.targetIndex ? 1 : 0.35;
        m.color.set(i === s.targetIndex ? C_WHITE : C_DIM);
      });

      // frustum
      drill.updateMatrixWorld();
      const lensW = lens.getWorldPosition(new THREE.Vector3());
      const cxw = lensW.x + s.axis.x * (lensW.z / -s.axis.z);
      const cyw = lensW.y + s.axis.y * (lensW.z / -s.axis.z) - 0.02;
      const hw = 0.12 + lensW.z * 0.35;
      const hh = hw * 0.55;
      const corners = [
        [cxw - hw, cyw - hh], [cxw + hw, cyw - hh], [cxw + hw, cyw + hh], [cxw - hw, cyw + hh],
      ];
      const fg = frustGeo.attributes.position as THREE.BufferAttribute;
      corners.forEach(([x, y], i) => {
        fg.setXYZ(i * 2, lensW.x, lensW.y, lensW.z);
        fg.setXYZ(i * 2 + 1, x, y, 0.002);
        const [nx, ny] = corners[(i + 1) % 4];
        fg.setXYZ(8 + i * 2, x, y, 0.002);
        fg.setXYZ(8 + i * 2 + 1, nx, ny, 0.002);
      });
      fg.needsUpdate = true;

      // 2D HUD: in-scene phone screen (compact) + side panel
      drawHud(screenCtx, s, screenCanvas.width, screenCanvas.height, true);
      screenTex.needsUpdate = true;
      if (hud.width > 0) drawHud(hudCtx, s, hud.width, hud.height, false, { background: "wall" });

      // follow the drill smoothly
      controls.target.lerp(tmp.set(s.tip.x * 0.8 + 0.02, s.tip.y * 0.8 + 0.01, 0.16), 0.03);
      // camera sway between limits
      const az = controls.getAzimuthalAngle();
      if (az > 0.95) controls.autoRotateSpeed = -Math.abs(controls.autoRotateSpeed);
      if (az < -0.25) controls.autoRotateSpeed = Math.abs(controls.autoRotateSpeed);
      controls.update();
      renderer.render(scene, camera);

      // labels
      setLabel("phone", phone.getWorldPosition(tmp).add(tmp2.set(0, 0.05, 0)));
      setLabel("lens", lensW);
      setLabel("chuck", tmp.set(s.chuck.x, s.chuck.y, s.chuck.z));
      setLabel("tip", tmp.set(s.tip.x, s.tip.y, Math.max(s.tip.z, 0)));
      setLabel("marker", tmp.set(MARKERS[0].x, MARKERS[0].y + 0.04, 0));

      if (s.phase !== lastPhase) {
        lastPhase = s.phase;
        setPhaseText(s.phase);
      }
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      screenTex.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* 3D scene */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#05080d]">
        <div ref={mountRef} className="h-[420px] w-full cursor-grab active:cursor-grabbing sm:h-[560px]" />
        <div className="pointer-events-none absolute inset-0">
          {LABELS.map((l) => (
            <div
              key={l.key}
              ref={(el) => {
                labelRefs.current[l.key] = el;
              }}
              className="absolute left-0 top-0 transition-opacity duration-300"
            >
              <div className="-translate-x-1/2 -translate-y-[calc(100%+10px)] whitespace-nowrap rounded border border-white/15 bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/80 backdrop-blur-sm">
                {l.text}
              </div>
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute left-4 top-4 flex flex-wrap gap-2 font-mono text-[11px]">
          <span className="rounded-full border border-cyan-300/30 bg-black/50 px-2.5 py-1 text-cyan-200">3D · world frame</span>
          <span className="rounded-full border border-white/15 bg-black/50 px-2.5 py-1 uppercase text-white/70">phase: {phaseText}</span>
        </div>
        <div className="pointer-events-none absolute bottom-3 left-4 right-4 flex justify-between font-mono text-[10px] text-white/40">
          <span>drag to orbit · simulation</span>
          <span>phone screen = the 2D guide the user sees</span>
        </div>
      </div>

      {/* 2D phone HUD */}
      <div className="flex flex-col items-center gap-3">
        <div className="w-full max-w-[340px] rounded-[2.2rem] border border-white/15 bg-[#0b0f14] p-2.5 shadow-[0_0_60px_-20px_rgba(90,216,255,0.45)]">
          <div className="relative overflow-hidden rounded-[1.7rem] bg-black">
            <canvas ref={hudRef} className="block aspect-[9/15] w-full" />
          </div>
        </div>
        <div className="flex w-full max-w-[340px] flex-col gap-2">
          <button
            onClick={toggleLive}
            className="rounded-full border border-cyan-300/40 bg-cyan-300/10 px-4 py-2 font-mono text-xs text-cyan-100 transition hover:bg-cyan-300/20"
          >
            {live ? "Stop live IMU" : "Tilt the chuck ring with your phone's IMU"}
          </button>
          {imuMsg && <p className="text-center font-mono text-[11px] text-white/50">{imuMsg}</p>}
          <a
            href="/hud"
            className="rounded-full border border-[var(--green)]/50 bg-[var(--green)]/10 px-4 py-2 text-center font-mono text-xs text-[var(--green)] transition hover:bg-[var(--green)]/20"
          >
            Open the phone screen only (for the dock) →
          </a>
        </div>
      </div>
    </div>
  );
}
