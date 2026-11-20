"use client";

// The architecture in 3D (three.js), drawn from lib/architecture.ts. Left: the phone, with the real-time loop
// (camera → tracker → engine → HUD) circulating at its top. Middle: the rule, a wall the loop never crosses.
// Right: the cloud's services. Files (plan, recipe, job record) are the only things that travel across.
// The phase buttons light up what each phase brings; hover or tap a block to read what it does.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { BLOCKS, FILE_KINDS, FLOWS, PHASES, block, type Block, type Phase } from "@/lib/architecture";

const GREEN = 0x3dffa8, CYAN = 0x5ad8ff, AMBER = 0xffb547, DIM = 0x2a3a4a;
const sideColor = (b: Block) => (b.realtime ? GREEN : b.side === "ci" ? 0x9fb0c0 : CYAN);

type Built = { b: Block; group: THREE.Group; mats: THREE.Material[]; label: HTMLDivElement };

export default function ArchitectureScene() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(1);
  const [hover, setHover] = useState<string | null>(null);
  const phaseRef = useRef<Phase>(1);
  const hoverRef = useRef<string | null>(null);
  useEffect(() => {
    phaseRef.current = phase;
    hoverRef.current = hover;
  }, [phase, hover]);

  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.display = "block";
    mount.appendChild(renderer.domElement);
    const css = new CSS2DRenderer();
    css.domElement.style.position = "absolute";
    css.domElement.style.inset = "0";
    css.domElement.style.pointerEvents = "none";
    mount.appendChild(css.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x05080d, 9, 18);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    camera.position.set(0.4, 0.9, 10.5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, -0.2, 0);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.minAzimuthAngle = -0.9;
    controls.maxAzimuthAngle = 0.9;
    controls.minPolarAngle = 1.0;
    controls.maxPolarAngle = 2.0;

    const world = new THREE.Group();
    scene.add(world);
    const disposables: { dispose: () => void }[] = [];
    const track = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
    const lineMat = (color: number, opacity: number) => track(new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    const edges = (g: THREE.BufferGeometry, color: number, opacity: number) => new THREE.LineSegments(track(new THREE.EdgesGeometry(g)), lineMat(color, opacity));
    const label = (text: string, cls: string, at: THREE.Vector3, parent: THREE.Object3D = world) => {
      const d = document.createElement("div");
      d.className = cls;
      d.textContent = text;
      const o = new CSS2DObject(d);
      o.position.copy(at);
      parent.add(o);
      return d;
    };

    // ---- the phone: a slab around its blocks ----
    const phoneG = track(new THREE.BoxGeometry(2.0, 4.8, 0.28));
    const phone = edges(phoneG, CYAN, 0.45);
    phone.position.set(-2.2, -0.25, -0.22);
    world.add(phone);
    const glass = new THREE.Mesh(phoneG, track(new THREE.MeshBasicMaterial({ color: 0x0b1622, transparent: true, opacity: 0.55, depthWrite: false })));
    glass.position.copy(phone.position);
    world.add(glass);
    label("PHONE · PWA + WebAssembly · offline", "font-mono text-[10px] tracking-wider text-[#5ad8ff]/80 whitespace-nowrap", new THREE.Vector3(-2.2, 2.45, 0));

    // ---- the cloud: a platform ----
    const disc = edges(track(new THREE.CylinderGeometry(2.0, 2.0, 0.02, 48, 1, true)), CYAN, 0.25);
    disc.position.set(2.2, -1.85, 0);
    world.add(disc);
    const ring = new THREE.LineLoop(track(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2) * 2.0, 0, Math.sin((i / 64) * Math.PI * 2) * 2.0)))), lineMat(CYAN, 0.35));
    ring.position.set(2.2, -1.85, 0);
    world.add(ring);
    const cloudLabel = label("CLOUD · private service · never on the real-time path", "font-mono text-[10px] tracking-wider text-[#5ad8ff]/80 whitespace-nowrap", new THREE.Vector3(2.2, 2.45, 0));

    // ---- the rule: a wall between them ----
    // a fence of vertical amber lines across the depth, so it reads from the front and from the side
    const fence: THREE.Vector3[] = [];
    for (let z = -1.6; z <= 1.601; z += 0.2) fence.push(new THREE.Vector3(-0.45, -2.75, z), new THREE.Vector3(-0.45, 2.25, z));
    for (const y of [-2.75, 2.25]) fence.push(new THREE.Vector3(-0.45, y, -1.6), new THREE.Vector3(-0.45, y, 1.6));
    const fenceLines = new THREE.LineSegments(track(new THREE.BufferGeometry().setFromPoints(fence)), lineMat(AMBER, 0.35));
    world.add(fenceLines);
    const wall = new THREE.Mesh(track(new THREE.PlaneGeometry(3.2, 5.0)), track(new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false })));
    wall.rotation.y = Math.PI / 2;
    wall.position.set(-0.45, -0.25, 0);
    world.add(wall);
    label("THE RULE · the cloud is never between the camera and the trigger", "max-w-[200px] text-center font-mono text-[10px] leading-tight text-[#ffb547]", new THREE.Vector3(-0.45, -3.15, 0));

    // ---- blocks ----
    const built: Built[] = [];
    const pickables: THREE.Object3D[] = [];
    for (const b of BLOCKS) {
      const g = new THREE.Group();
      g.position.set(...b.at);
      const color = sideColor(b);
      const geo = b.side === "phone" ? track(new THREE.BoxGeometry(1.55, 0.42, 0.14)) : b.side === "ci" ? track(new THREE.BoxGeometry(1.2, 0.3, 0.3)) : track(new THREE.CylinderGeometry(0.42, 0.42, 0.34, 6));
      const fill = track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, depthWrite: false }));
      const mesh = new THREE.Mesh(geo, fill);
      mesh.userData.id = b.id;
      g.add(mesh);
      const e = edges(geo, color, 0.9);
      g.add(e);
      pickables.push(mesh);
      const lbl = label(
        b.label,
        `whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] transition-opacity ${b.realtime ? "text-[#3dffa8]" : b.side === "ci" ? "text-white/60" : "text-white"}`,
        new THREE.Vector3(0, b.side === "phone" ? 0 : 0.42, b.side === "phone" ? 0.1 : 0),
        g,
      );
      world.add(g);
      built.push({ b, group: g, mats: [fill, e.material as THREE.Material], label: lbl });
    }

    // ---- the real-time loop: a ring through camera → tracker → engine → HUD, and back ----
    const rt = ["camera", "tracker", "engine", "hud"].map((id) => new THREE.Vector3(...block(id).at));
    const loopPts = [...rt.map((p) => p.clone().add(new THREE.Vector3(0.95, 0, 0.2))), ...[...rt].reverse().map((p) => p.clone().add(new THREE.Vector3(-0.95, 0, 0.2)))];
    const loop = new THREE.CatmullRomCurve3(loopPts, true, "centripetal");
    world.add(new THREE.Line(track(new THREE.BufferGeometry().setFromPoints(loop.getPoints(160))), lineMat(GREEN, 0.55)));
    const pulses = [0, 1, 2].map(() => {
      const m = new THREE.Mesh(track(new THREE.SphereGeometry(0.06, 12, 8)), track(new THREE.MeshBasicMaterial({ color: GREEN })));
      world.add(m);
      return m;
    });
    label("120 Hz · on the phone only", "whitespace-nowrap font-mono text-[10px] text-[#3dffa8]/80", new THREE.Vector3(-2.2, 2.0, 0.25));

    // ---- files: the only things that cross ----
    const flows = FLOWS.map((f) => {
      const a = new THREE.Vector3(...block(f.from).at), b = new THREE.Vector3(...block(f.to).at);
      const local = block(f.from).side === block(f.to).side;
      const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(local ? 1.25 : 0, local ? 0 : 0.9, local ? 0.35 : 0.6));
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const color = new THREE.Color(FILE_KINDS[f.kind].color).getHex();
      const mat = new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.6 });
      track(mat);
      const line = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints(curve.getPoints(60))), mat);
      line.computeLineDistances();
      world.add(line);
      const packet = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, 0.2, 0.03)), track(new THREE.MeshBasicMaterial({ color })));
      const pe = edges(packet.geometry, 0xffffff, 0.7);
      packet.add(pe);
      world.add(packet);
      return { f, curve, line, mat, packet, offset: Math.random() };
    });

    // ---- picking ----
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pick = (ev: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(pickables, false)[0];
      const id = (hit?.object.userData.id as string | undefined) ?? null;
      if (ev.type === "pointerdown" || id !== hoverRef.current) setHover(id);
      renderer.domElement.style.cursor = id ? "pointer" : "grab";
    };
    renderer.domElement.addEventListener("pointermove", pick);
    renderer.domElement.addEventListener("pointerdown", pick);

    // ---- size, visibility, loop ----
    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      renderer.setSize(w, h);
      css.setSize(w, h);
      camera.aspect = w / h;
      // narrow screens: step back so both sides fit
      camera.position.setLength(w < 640 ? 14 : 9.4);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();
    let visible = true;
    const io = new IntersectionObserver((e) => (visible = e[0].isIntersecting));
    io.observe(mount);

    let raf = 0;
    const t0 = performance.now();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!visible) return;
      const t = (performance.now() - t0) / 1000;
      const ph = phaseRef.current, hv = hoverRef.current;
      world.rotation.y = Math.sin(t * 0.15) * 0.12;
      pulses.forEach((p, i) => p.position.copy(loop.getPointAt((t * 0.8 + i / 3) % 1)));
      for (const x of built) {
        const on = x.b.phase <= ph;
        const hot = hv === x.b.id;
        (x.mats[0] as THREE.MeshBasicMaterial).opacity = hot ? 0.35 : on ? 0.12 : 0.02;
        (x.mats[1] as THREE.LineBasicMaterial).opacity = on ? (hot ? 1 : 0.85) : 0.15;
        x.label.style.opacity = on ? "1" : "0.25";
        x.group.scale.setScalar(hot ? 1.08 : 1);
      }
      cloudLabel.style.opacity = ph >= 2 ? "1" : "0.4";
      for (const fl of flows) {
        const on = fl.f.phase <= ph;
        fl.line.visible = on;
        fl.packet.visible = on;
        if (on) {
          const u = (t * 0.22 + fl.offset) % 1;
          fl.packet.position.copy(fl.curve.getPoint(u));
          fl.packet.lookAt(camera.position);
        }
      }
      controls.update();
      renderer.render(scene, camera);
      css.render(scene, camera);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      renderer.domElement.removeEventListener("pointermove", pick);
      renderer.domElement.removeEventListener("pointerdown", pick);
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      mount.removeChild(css.domElement);
    };
  }, []);

  const info = hover ? BLOCKS.find((b) => b.id === hover) : null;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {PHASES.map((p) => (
          <button
            key={p.n}
            onClick={() => setPhase(p.n)}
            className={`rounded-full border px-4 py-1.5 text-sm transition ${p.n === phase ? "border-[var(--green)]/60 bg-[var(--green)]/10 text-white" : "border-white/15 text-white/60 hover:border-white/35 hover:text-white"}`}
          >
            <span className="font-mono">{p.label}</span> <span className="text-white/50">· {p.goal}</span>
          </button>
        ))}
      </div>
      <div className="relative">
        <div ref={mountRef} className="relative h-[460px] w-full cursor-grab overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(ellipse_at_center,#0b1622_0%,#05080d_70%)] sm:h-[580px]" />
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex flex-wrap items-end justify-between gap-3">
          <div className="max-w-md rounded-xl border border-white/10 bg-black/60 p-3 text-sm backdrop-blur-md">
            {info ? (
              <>
                <div className="font-mono text-[10px] uppercase tracking-wider text-white/45">
                  {info.side === "phone" ? "phone" : info.side === "cloud" ? "cloud" : "development"} · F{info.phase}
                  {info.realtime ? " · real-time loop" : ""}
                </div>
                <div className="mt-1 font-semibold">{info.label}</div>
                <p className="mt-1 text-white/65">{info.what}</p>
              </>
            ) : (
              <p className="text-white/55">Hover or tap a block. Drag to orbit.</p>
            )}
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-white/10 bg-black/60 p-3 font-mono text-[10px] backdrop-blur-md">
            {Object.values(FILE_KINDS).map((k) => (
              <span key={k.label} className="flex items-center gap-2 text-white/70">
                <span className="inline-block h-2.5 w-2 rounded-[1px]" style={{ background: k.color }} />
                {k.label}
              </span>
            ))}
            <span className="flex items-center gap-2 text-white/70">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--green)]" />
              real-time loop
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
