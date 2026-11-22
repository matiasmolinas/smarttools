"use client";

// The guided setup on the phone (/hud → Setup). One step per screen, large text, a 3D animation of the
// movement to make, one big button, and a live check in colour:
//   1 sheet  point the camera at the printed sheet (markers seen)
//   2 lens   20 s over the sheet, near and far, tilted (skipped if the lens is already calibrated)
//   3 tip    the tip on A2: circle around it (5 s), then twist around the bit (5 s)
//   4 check  the tip on A2 again: how far the app puts it from A2
//   5 ready  drill, or run the tests

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { BrowserNav, CalResult } from "@/lib/tracker";
import type { SceneFocus } from "./CalibrationScene";

const CalibrationScene = dynamic(() => import("./CalibrationScene"), { ssr: false, loading: () => <div className="h-40 rounded-2xl bg-black/30 sm:h-56" /> });

type Step = "sheet" | "lens" | "tip" | "check" | "ready";
const ORDER: Step[] = ["sheet", "lens", "tip", "check", "ready"];
const DOTS: { s: Step; label: string }[] = [
  { s: "sheet", label: "Sheet" },
  { s: "lens", label: "Lens" },
  { s: "tip", label: "Tip" },
  { s: "check", label: "Check" },
];

const GOOD = "#3ee59b", WARN = "#ffb547", BAD = "#ff6b6b";

export default function SetupWizard({
  tracker,
  onClose,
  onOpenBench,
  phoneName,
  onNextPhone,
}: {
  tracker: () => BrowserNav | null;
  onClose: () => void;
  onOpenBench: () => void;
  phoneName: string;
  onNextPhone: () => void;
}) {
  const [step, setStep] = useState<Step>("sheet");
  const [live, setLive] = useState<ReturnType<BrowserNav["liveCheck"]> | null>(null);
  const [cal, setCal] = useState<ReturnType<BrowserNav["calStatus"]>>(null);
  const [calibrated, setCalibrated] = useState({ camera: false, tool: false });
  const [result, setResult] = useState<CalResult | null>(null);
  const [tipResult, setTipResult] = useState<CalResult | null>(null);
  const [lensRedo, setLensRedo] = useState(false);
  const running = !!cal;
  const hooked = useRef<BrowserNav | null>(null);

  // poll the tracker; take calibration results as they come
  useEffect(() => {
    const iv = setInterval(() => {
      const tr = tracker();
      if (!tr) return;
      if (hooked.current !== tr) {
        hooked.current = tr;
        tr.onCalResult = (r) => {
          if (r.kind === "camera") setResult(r);
          else if (r.kind === "pivot" && !r.ok) setTipResult(r);
          else if (r.kind === "roll") setTipResult(r);
        };
      }
      setLive(tr.liveCheck());
      setCal(tr.calStatus());
      setCalibrated(tr.calibrated);
    }, 150);
    return () => {
      clearInterval(iv);
      if (hooked.current) hooked.current.onCalResult = () => {};
    };
  }, [tracker]);

  const go = (s: Step) => {
    setResult(null);
    setTipResult(null);
    setLensRedo(false);
    setStep(s);
  };
  const next = () => go(ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(step) + 1)]);
  const now = () => performance.now() / 1000;

  const markers = live?.markers ?? 0;
  const markersColor = markers >= 6 ? GOOD : markers >= 3 ? WARN : BAD;

  // ---- what each step shows ----
  let focus: SceneFocus | null = null;
  let title = "", body = "";
  let main: React.ReactNode = null;
  let primary: { label: string; onClick: () => void; disabled?: boolean } | null = null;
  let secondary: { label: string; onClick: () => void } | null = null;

  if (step === "sheet") {
    title = "Point the camera at the sheet";
    body = "Hold the drill so the screen shows the printed sheet, with many black squares in view.";
    main = <Big value={`${markers}`} unit="markers seen" color={markersColor} note={markers >= 6 ? "Good" : "Show more of the sheet"} />;
    primary = { label: "Next", onClick: next, disabled: markers < 3 };
  } else if (step === "lens") {
    focus = "lens";
    if (running) {
      title = "Keep moving slowly";
      body = "Over the sheet: closer, farther, tilted to every side. Keep many markers in view.";
      main = <Progress p={cal!.progress} seconds={20} color={markersColor} extra={`${markers} markers`} />;
    } else if (result?.kind === "camera") {
      if (result.ok) {
        const c = result.rmsPx < 1 ? GOOD : result.rmsPx < 2 ? WARN : BAD;
        title = result.rmsPx < 2 ? "Lens calibrated ✓" : "Lens: not precise enough";
        body = result.rmsPx < 2 ? "Done once for this phone." : "Try again with more even light and slower movements.";
        main = <Big value={result.rmsPx.toFixed(2)} unit="px error" color={c} note={result.rmsPx < 1 ? "Very good" : result.rmsPx < 2 ? "OK" : "Too high"} />;
        primary = result.rmsPx < 2 ? { label: "Next", onClick: next } : { label: "Try again", onClick: () => (setResult(null), tracker()?.startCameraCalibration(now())) };
        if (result.rmsPx < 2) secondary = { label: "Calibrate again", onClick: () => (setResult(null), tracker()?.startCameraCalibration(now())) };
      } else {
        title = "That did not work";
        body = sentence(result.error);
        main = <Big value="✕" unit="" color={BAD} note="Try again" />;
        primary = { label: "Try again", onClick: () => (setResult(null), tracker()?.startCameraCalibration(now())) };
      }
    } else if (calibrated.camera && !lensRedo) {
      title = "Lens already calibrated ✓";
      body = "This phone's lens was calibrated before. You can go on.";
      main = <Big value="✓" unit="" color={GOOD} note="Calibrated" />;
      primary = { label: "Next", onClick: next };
      secondary = { label: "Calibrate again", onClick: () => setLensRedo(true) };
    } else {
      title = "Calibrate the lens · 20 s";
      body = "Tap Start, then move the drill slowly over the sheet like in the animation: closer, farther, tilted to every side.";
      primary = { label: "Start", onClick: () => tracker()?.startCameraCalibration(now()), disabled: markers < 3 };
    }
  } else if (step === "tip") {
    focus = cal?.step === "roll" ? "roll" : cal?.step === "pivot" ? "pivot" : tipResult ? null : "check";
    if (running && cal!.step === "pivot") {
      title = "Circle around the tip";
      body = "Keep the tip on A2. Tilt the drill a little and draw a circle with it.";
      main = <Progress p={cal!.progress} seconds={5} color={markersColor} extra={`${markers} markers`} />;
    } else if (running && cal!.step === "roll") {
      title = "Now twist around the bit";
      body = "Tip still on A2. Turn the drill left and right around its own bit.";
      main = <Progress p={cal!.progress} seconds={5} color={markersColor} extra={`${markers} markers`} />;
    } else if (tipResult) {
      if (tipResult.ok) {
        title = "Tip and bit found ✓";
        body = "Now let's check it.";
        main = <Big value="✓" unit="" color={GOOD} note={`tilt ≈ ${tipResult.kind === "roll" ? tipResult.tiltDeg.toFixed(0) : "–"}°`} />;
        primary = { label: "Next", onClick: next };
        secondary = { label: "Do it again", onClick: () => (setTipResult(null), tracker()?.startToolCalibration(now())) };
      } else {
        title = "That did not work";
        body = sentence(tipResult.error);
        main = <Big value="✕" unit="" color={BAD} note="Try again" />;
        primary = { label: "Try again", onClick: () => (setTipResult(null), tracker()?.startToolCalibration(now())) };
      }
    } else {
      title = "Put the tip on A2";
      body = "Motor off. Rest the bit tip on the centre of the A2 cross, then tap Start. You will circle around it, then twist (10 s).";
      main = <Big value={`${markers}`} unit="markers seen" color={markersColor} note={markers >= 6 ? "Good" : "Show more of the sheet"} />;
      primary = { label: "Start", onClick: () => tracker()?.startToolCalibration(now()), disabled: markers < 3 };
    }
  } else if (step === "check") {
    focus = "check";
    const d = live?.tipToA2Mm ?? null;
    const c = d == null ? BAD : d < 1 ? GOOD : d < 2 ? WARN : BAD;
    title = "Check: tip on A2";
    body = "Rest the tip on the centre of A2 again. This is how far the app puts the tip from A2.";
    main = (
      <Big
        value={d == null ? "–" : d.toFixed(1)}
        unit="mm from A2"
        color={markers < 4 ? WARN : c}
        note={markers < 4 ? `Only ${markers} markers: turn the sheet so more markers are in front of the bit` : d == null ? "Show the sheet" : d < 1 ? "Very good" : d < 2 ? "OK" : "Too far: calibrate the tip again"}
      />
    );
    primary = { label: "Done", onClick: next };
    secondary = { label: "Calibrate the tip again", onClick: () => go("tip") };
  } else {
    title = "Ready ✓";
    body = "The app knows where the tip is and which way the bit points, for this mount. If the phone moves on the drill, run the setup again.";
    main = <Big value="✓" unit="" color={GOOD} note="Calibrated" />;
    primary = { label: "Start drilling", onClick: onClose };
    secondary = { label: "Run the tests (Bench)", onClick: () => (onClose(), onOpenBench()) };
  }

  const dot = ORDER.indexOf(step);
  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 max-h-[72dvh] overflow-y-auto rounded-t-3xl border-t border-white/15 bg-black/45 px-5 [text-shadow:0_1px_3px_rgba(0,0,0,0.9)] pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 text-white">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {DOTS.map((d, i) => (
            <span key={d.s} className={`rounded-full px-3 py-1 text-sm ${i === dot ? "bg-[#3ee59b] font-semibold text-black" : i < dot ? "bg-white/15 text-white/80" : "border border-white/20 text-white/45"}`}>
              {i < dot ? "✓ " : ""}
              {d.label}
            </span>
          ))}
        </div>
        <button onClick={onClose} className="rounded-full px-3 py-1 text-2xl leading-none text-white/60" aria-label="Close setup">
          ✕
        </button>
      </div>

      <h2 className="mt-4 text-[1.7rem] font-semibold leading-tight">{title}</h2>
      <p className="mt-2 text-lg leading-snug text-white/75">{body}</p>

      <div className={`mt-3 grid items-center gap-3 ${focus && main ? "grid-cols-[1.5fr_1fr]" : ""}`}>
        {focus && <CalibrationScene focus={focus} compact className="h-40 bg-black/30 sm:h-56" />}
        {main && <div className="flex items-center justify-center">{main}</div>}
      </div>

      {/* the buttons stay at the bottom of the sheet, always in reach */}
      <div className="sticky bottom-0 -mx-5 mt-4 flex flex-col gap-3 border-t border-white/10 bg-black/55 px-5 pb-1 pt-3 backdrop-blur-sm">
        {primary && (
          <button onClick={primary.onClick} disabled={primary.disabled || running} className="h-14 rounded-2xl bg-[#3ee59b] text-xl font-semibold text-black active:scale-[0.99] disabled:opacity-35">
            {running ? "Recording…" : primary.label}
          </button>
        )}
        {secondary && !running && (
          <button onClick={secondary.onClick} className="h-12 rounded-2xl border border-white/25 text-lg text-white/85">
            {secondary.label}
          </button>
        )}
      </div>

      {step === "sheet" && (
        <button onClick={onNextPhone} className="mt-4 text-base text-white/55 underline decoration-white/25">
          Phone: {phoneName} (tap to change)
        </button>
      )}
    </div>
  );
}

function Big({ value, unit, color, note }: { value: string; unit: string; color: string; note: string }) {
  return (
    <div className="text-center">
      <div className="font-mono text-5xl font-semibold leading-none sm:text-6xl" style={{ color }}>
        {value}
      </div>
      {unit && <div className="mt-1 text-lg text-white/70">{unit}</div>}
      <div className="mt-1 text-lg font-medium" style={{ color }}>
        {note}
      </div>
    </div>
  );
}

function Progress({ p, seconds, color, extra }: { p: number; seconds: number; color: string; extra: string }) {
  const r = 46, c = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 110 110" className="h-36 w-36">
        <circle cx="55" cy="55" r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="9" />
        <circle cx="55" cy="55" r={r} fill="none" stroke="#3ee59b" strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 55 55)" />
        <text x="55" y="64" textAnchor="middle" fill="white" fontSize="28" fontWeight="600" fontFamily="monospace">
          {Math.max(0, Math.ceil(seconds * (1 - p)))}
        </text>
      </svg>
      <div className="mt-1 text-lg font-medium" style={{ color }}>
        {extra}
      </div>
    </div>
  );
}

/** "twist the drill more around the bit" → "Twist the drill more around the bit." */
const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) + (s.endsWith(".") ? "" : ".") : "");
