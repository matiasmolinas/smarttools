"use client";

// The phone app (/hud): only what is needed to work. A start screen (the browser needs a tap to turn on the
// camera), then the live camera with the GPS-style guide (lib/hudguide.ts), or the simple display (lib/hudsimple.ts:
// one number, shapes, five round buttons; chosen in the menu, kept per device). The guided setup opens by itself
// when the drill is not calibrated. One menu: Setup, Job, Tests, Record, Sound, Display, Full screen.
// Like the drill's trigger (lib/runstate.ts): Pause turns the camera and tracking off and keeps the calibration;
// Stop (held 1 s) turns everything off, and the next start asks what changed and redoes only that.
// Three loops run independently: camera frames (tracked in a worker), the engine clock (120 Hz), drawing.
// For development only, /hud?sim=1 replaces the camera with the scene simulator (no button for it); with
// &recipe=1 it works the sheet's holes from a recipe, so the live Checks can be seen; with &pilot=1 (simple
// display) the simulated person does the pilot job.
// A plan that came from a recipe (plan.recipe): each finished hole shows its Check answered by the engine (a card
// under the banner), and the steps that are not holes are confirmed by the person (the "Step" sheet).
// The pilot job (lib/pilot.ts; the simple display, the default, when no saved plan is active): three round phase
// buttons on the left (sheet, part, work), one text at the top, and the recipe guides by lighting the controls and
// the drawn guides that matter now (focus) and dimming the rest; its words only on a tap on the text.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BenchPanel from "./BenchPanel";
import SetupWizard, { type Step as WizardStep } from "./SetupWizard";
import type { SimState } from "@/lib/sim";
import { SoundGuide, toneFromHud } from "@/lib/audio";
import { CHANGES, ago, autoPauseReason, explainStartError, onStart, pausedFor, planFor, readRun, writeRun, type Change, type RunRecord, type StartStage } from "@/lib/runstate";
import type { Overlay } from "@/lib/hud";
import { drawGuide } from "@/lib/hudguide";
import { COL, captureHint, chipNumbers, controlLook, displaySetting, drawSimple, phaseButtons, pilotRuns, readUiPrefs, readout, textKey, wordsFor, type PhaseButton, type SimpleFocus, type UiKind } from "@/lib/hudsimple";
import { BrowserNav, isPilotPlan } from "@/lib/tracker";
import { currentStep, focus, pilotText, pilotWords, type Phase, type PilotState, type PilotText } from "@/lib/pilot";
import { AR } from "@/lib/aruco";
import { DICTIONARY } from "@/lib/board";
import { DEFAULT_DISTURBANCE, DEFAULT_RIG, RUN_TIME, disturb, dockRigAt, markerCodes, toolWorldFromHold, truthAt } from "@/lib/scene";
import { DEFAULT_PHONE_ID, phoneById } from "@/lib/phones";
import { BUILT_IN_PLANS, SHEET_PLAN, addHole, newPlan, removeLastHole, type Plan } from "@/lib/plan";
import { activePlanId, browserMemory, clearJobDraft, readJobDraft, setActivePlanId, writeJobDraft } from "@/lib/memory";
import { draftAction, resumableHoles, versionLine, type HoleRecord } from "@/lib/jobrecord";
import { harnessId, harnessLabel } from "@/lib/ledger";
import { holeLine } from "@/lib/report";
import { bindCheck, checkHole, dueManual, recipeOfPlan, simulatorRecipePlan, tallySoFar, tallyText, type Recipe, type Statement, type StepCheck } from "@/lib/recipe";
import { recordingFileName, sizeText } from "@/lib/recording";

type WakeLockSentinelLike = { release: () => Promise<void> };
type VideoFrameMeta = { captureTime?: number; expectedDisplayTime?: number };
type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: VideoFrameMeta) => void) => number; cancelVideoFrameCallback?: (id: number) => void };
type Status = "start" | "starting" | "running" | "paused" | "blocked";
/** A finished hole's Check on screen; words: what the person confirms ("" when the engine answers all of it) */
type CheckCardData = { hole: HoleRecord; check: StepCheck; words: string };
/** What the pilot shows in HTML (the top text, the phase buttons, the focus of every control), set from the draw
 * loop only when it changes. angle: the arrow's direction, deg, rounded */
type PilotUi = { st: PilotState; text: PilotText; angle: number; focus: SimpleFocus; buttons: PhaseButton[] };
/** the steps the phases answer themselves (lib/pilot.ts PILOT_STEPS): confirmed once the block's fit is ok */
const PILOT_MANUAL = ["sheet", "place", "register"];

/** A vibration (Android; nothing where the browser has none). */
const buzz = (p: number | number[]) => {
  try {
    navigator.vibrate?.(p);
  } catch {}
};

export default function HudScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackerRef = useRef<BrowserNav | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const simRef = useRef(false);
  const simCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<Status>("start");
  const statusRef = useRef<Status>("start");
  const [toast, setToast] = useState<string | null>(null);
  // the tracker failed for good: shown on top of everything until the page is reloaded
  const [fault, setFault] = useState<string | null>(null);
  // why the last Start failed (status "blocked"), shown on the start screen
  const [startError, setStartError] = useState<{ title: string; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soundRef = useRef<SoundGuide | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const lastCue = useRef({ phase: "", alarms: 0 });
  const [phoneName, setPhoneName] = useState(phoneById(DEFAULT_PHONE_ID).name);
  // plans and jobs
  const [draft, setDraft] = useState<Plan | null>(null);
  const draftRef = useRef(false);
  useEffect(() => {
    draftRef.current = !!draft;
  }, [draft]);
  const [plan, setPlanState] = useState<Plan>(SHEET_PLAN);
  const planIdRef = useRef(SHEET_PLAN.id);
  useEffect(() => {
    planIdRef.current = plan.id;
  }, [plan]);
  const [done, setDone] = useState(0);
  const [tol, setTol] = useState(0.5);
  // sheets: one at a time
  const [sheet, setSheet] = useState<null | "menu" | "setup" | "job" | "bench" | "changed" | "resume" | "stop" | "recording" | "step">(null);
  // the recipe the plan came from (null: no Checks, no steps, nothing new on screen); read by the tracker's callbacks
  const recipeRef = useRef<Recipe | null>(null);
  const recipe = useMemo(() => recipeOfPlan(plan), [plan]);
  // the Check card (not a sheet: tracking and Pause / Stop go on under it), and the holes waiting for it while it
  // waits for a Yes / No answer
  const [card, setCardState] = useState<CheckCardData | null>(null);
  const cardRef = useRef<CheckCardData | null>(null);
  const cardQueue = useRef<HoleRecord[]>([]);
  const setCard = useCallback((c: CheckCardData | null) => {
    cardRef.current = c;
    setCardState(c);
  }, []);
  // the recipe step shown in the "step" sheet
  const [step, setStep] = useState<Statement | null>(null);
  // working / paused / stopped, kept per device (lib/runstate.ts)
  const runRef = useRef<RunRecord | null>(null);
  const [wizardStep, setWizardStep] = useState<WizardStep>("sheet");
  // after a stop: the drill calibration is not trusted until the person says what changed and it is checked
  const needCheckRef = useRef<{ since: string } | null>(null);
  const [stopped, setStopped] = useState(false);
  const [recNote, setRecNote] = useState<string | null>(null);
  // the recording in progress (its number; 0: none), and the last one made, kept until Done or Discard
  const recordingRef = useRef(0);
  const recSeq = useRef(0);
  const [recFile, setRecFile] = useState<{ file: File; canShare: boolean } | null>(null);
  const recFileRef = useRef(false);
  useEffect(() => {
    recFileRef.current = !!recFile;
  }, [recFile]);
  const recUrlRef = useRef<string | null>(null);
  const [pausedMin, setPausedMin] = useState(0);
  const [, tick] = useState(0);
  const setupDecided = useRef(false);
  const sheetRef = useRef<typeof sheet>(null);
  useEffect(() => {
    sheetRef.current = sheet;
  }, [sheet]);
  // the camera's resolution: 1080p, or 720p for slow phones (kept per device)
  const [camRes, setCamRes] = useState<720 | 1080>(1080);
  const camResRef = useRef<720 | 1080>(1080);
  // camera options to evaluate: 60 frames/s, focus and exposure locked (kept per device)
  const [camOpts, setCamOpts] = useState({ fps60: false, lock: false });
  const camOptsRef = useRef({ fps60: false, lock: false });
  const [camInfo, setCamInfo] = useState("");
  // the display: simple (default) or classic, and the simple one's video on / off (kept per device); the draw
  // loop reads the refs
  const [ui, setUiState] = useState<UiKind>("simple");
  const uiRef = useRef<UiKind>("simple");
  const [uiVideo, setUiVideoState] = useState(false);
  const uiVideoRef = useRef(false);
  // the simple display's buttons column: the readout is centred in what it leaves free
  const columnRef = useRef<HTMLDivElement>(null);
  // the pilot: ?pilot=1 in the simulator, the left column (the depth bar goes right of it), what HTML shows, and
  // the words of the current step on a tap on the text (3 s)
  const pilotParamRef = useRef(false);
  const leftRef = useRef<HTMLDivElement>(null);
  const [pilotUi, setPilotUiState] = useState<PilotUi | null>(null);
  const pilotKey = useRef("");
  const [words, setWords] = useState<string | null>(null);
  const wordsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tracker = useCallback(() => trackerRef.current, []);
  const simple = ui === "simple";
  /** the pilot's focus for the HTML controls (null outside the pilot: every control as it is) */
  const pf = simple ? (pilotUi?.focus ?? null) : null;

  const say = useCallback((t: string, ms = 2500) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  const setStatusBoth = (s: Status) => {
    statusRef.current = s;
    setStatus(s);
  };

  useEffect(() => {
    runRef.current = readRun();
    const iv = setInterval(() => tick((n) => n + 1), 15000); // the paused screen's minutes
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    simRef.current = q.get("sim") === "1";
    pilotParamRef.current = q.get("pilot") === "1";
    try {
      const o = { fps60: localStorage.getItem("st-cam-fps60") === "1", lock: localStorage.getItem("st-cam-lock") === "1" };
      camOptsRef.current = o;
      setCamOpts(o);
    } catch {}
    try {
      const p = readUiPrefs((k) => localStorage.getItem(k));
      uiRef.current = p.ui;
      uiVideoRef.current = p.video;
      setUiState(p.ui);
      setUiVideoState(p.video);
    } catch {}
    try {
      const v = Number(localStorage.getItem("st-cam-res"));
      if (v === 720 || v === 1080) {
        camResRef.current = v;
        setCamRes(v);
      }
    } catch {}
  }, []);

  /** What a job records about how it was made on this screen: the camera options and the display. */
  const syncTracker = (tr: BrowserNav | null) => {
    if (!tr) return;
    tr.cameraOpts = { ...camOptsRef.current };
    tr.display = displaySetting(uiRef.current, uiVideoRef.current);
    // the classic display hides the pilot: it is paused (no corner capture, no table mapping) until simple is back
    tr.pilotPaused = uiRef.current === "classic";
  };
  const setUi = (v: UiKind) => {
    uiRef.current = v;
    setUiState(v);
    syncTracker(trackerRef.current);
    try {
      localStorage.setItem("st-ui", v);
    } catch {}
    // to simple mid-work: the pilot starts when it should and is not running (classic leaves it as it is, hidden)
    const tr = trackerRef.current;
    if (tr && !tr.pilot && setupDecided.current && statusRef.current === "running" && pilotWanted()) tr.startPilot();
  };
  /** Does the simple display run the pilot job now (lib/hudsimple.ts pilotRuns)? */
  const pilotWanted = () => pilotRuns({ ui: uiRef.current, sim: simRef.current, pilotParam: pilotParamRef.current, activePlan: simRef.current ? null : activePlanId() });
  const setUiVideo = (v: boolean) => {
    uiVideoRef.current = v;
    setUiVideoState(v);
    syncTracker(trackerRef.current);
    try {
      localStorage.setItem("st-ui-video", v ? "1" : "0");
    } catch {}
  };
  /** The pilot: the words of the current step (and what a corner capture misses), in place of the top text, 3 s. */
  const showPilotWords = () => {
    const tr = trackerRef.current, st = tr?.pilotState();
    if (!tr || !st) return;
    const hint = st.phase === "part" && st.capture ? captureHint(st.capture.why) : "";
    const w = pilotWords(currentStep(st), tr.plan, st);
    setWords(hint ? `${w} · ${hint}` : w);
    if (wordsTimer.current) clearTimeout(wordsTimer.current);
    wordsTimer.current = setTimeout(() => setWords(null), 3000);
  };
  /** A phase button: refused (only a vibration) when the phase cannot be entered yet. */
  const enterPhase = (p: Phase) => {
    const tr = trackerRef.current;
    if (!tr?.setPhase(p)) return buzz(30);
    pilotKey.current = ""; // redraw the HTML now
  };
  /** The Sheet phase button held 1 s: forget the table map (every sheet but sheet 1 is mapped again) and go back to
   * the sheet phase. */
  const clearTable = () => {
    const tr = trackerRef.current;
    if (!tr) return;
    tr.clearTable();
    tr.setPhase("sheet");
    buzz([60, 90, 60]);
    pilotKey.current = "";
  };
  /** Simple display: the classic banner's words for now, on a tap on the readout. */
  const showWords = () => {
    const tr = trackerRef.current, view = tr?.view();
    if (!tr || !view) return;
    const w = wordsFor(view.state, view.overlay, { tipPx: view.overlay.tipPx ?? null, markPx: view.overlay.mark ?? null, calibrated: tr.calibrated.tool });
    say(w.sub ? `${w.title} · ${w.sub}` : w.title, 3000);
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => stopCamera, []);

  // the engine (WebAssembly) and the tracker, once
  async function ensureTracker(): Promise<BrowserNav> {
    if (trackerRef.current) return trackerRef.current;
    const tr = await BrowserNav.create();
    syncTracker(tr);
    tr.onMessage = say;
    tr.onFault = setFault;
    tr.onHoleDone = (h) => showCard(h);
    tr.onCorner = () => buzz(60);
    tr.onPilotFit = (f) => buzz(f.ok ? [60, 90, 60] : 400);
    if (simRef.current) {
      tr.onSimImage = (img) => {
        const c = (simCanvasRef.current ??= document.createElement("canvas"));
        if (c.width !== img.width || c.height !== img.height) {
          c.width = img.width;
          c.height = img.height;
        }
        c.getContext("2d")!.putImageData(img, 0, 0);
      };
      const rig = dockRigAt(undefined, DEFAULT_RIG, tr.phone);
      // simulated time: a frame takes far longer to render and track here than on a phone, so the scene plays in
      // slow motion on its own clock (lib/scene.ts SimClock) rather than dropping tracking between frames
      const t0 = performance.now() / 1000;
      tr.startSimClock(t0);
      tr.useCalibration(rig.camera, rig.tool, rig.width, rig.height, t0);
      // ?recipe=1: the sheet's holes from a recipe, recorded (never saved) so the Check cards and the steps show
      if (new URLSearchParams(window.location.search).get("recipe") === "1") {
        const p = simulatorRecipePlan();
        tr.recordInSimulator(p);
        recipeRef.current = recipeOfPlan(p);
        setPlanState(p);
      }
      // ?pilot=1: carry on with the pilot kept here, after the fixed calibration (before it, a pilot in "work"
      // would set its plan the phone's way and drop that calibration)
      if (pilotWanted()) tr.restorePilot();
    } else {
      setPhoneName(tr.phone.name);
      setTol(tr.tolDeg);
      const id = activePlanId();
      if (id) {
        const p = (await browserMemory().plan(id).catch(() => undefined)) ?? BUILT_IN_PLANS.find((b) => b.id === id);
        if (p) applyPlan(p, tr, false);
      }
      // no saved plan active, simple display: carry on with the pilot kept here (in "work" it sets its own plan,
      // with the same id, so its job's draft can be resumed below)
      if (pilotWanted()) tr.restorePilot();
      // after the plan: a draft left behind means the page died mid-job (never in the simulator)
      tr.onJobProgress = writeJobDraft;
      const draft = readJobDraft();
      const act = draftAction(draft, tr.plan);
      if (draft && act === "resume") {
        tr.resumeJob(draft);
        say(`Job recovered · ${resumableHoles(draft, tr.plan).length}/${tr.plan.holes.length} holes`);
      } else if (draft && act === "save") {
        try {
          await browserMemory().saveJob(draft);
          clearJobDraft();
          say("Unfinished job saved");
        } catch {
          say("The unfinished job could not be saved");
        }
      } else clearJobDraft();
    }
    trackerRef.current = tr;
    return tr;
  }

  /** Start from the start screen, or Continue from a pause: the camera on, then decide (setup / ask / resume). */
  async function start() {
    setupDecided.current = false;
    setStopped(false);
    await openCamera();
  }

  /** Keep the state; while "What did you change?" is unanswered it stays "stopped", so a pause, the phone
   * locking or the page closing can never skip the question. */
  const persist = (state: RunRecord["state"]) => (runRef.current = writeRun(needCheckRef.current ? "stopped" : state));

  /** Cancel a recording in progress. True if one was running (the caller says so). */
  function cancelRecording(): boolean {
    trackerRef.current?.cancelRecording();
    if (!recordingRef.current) return false;
    recordingRef.current = 0;
    setRecNote(null);
    return true;
  }

  function pause(reason?: string) {
    if (statusRef.current !== "running") return;
    trackerRef.current?.cancelCalibration();
    const recCancelled = cancelRecording();
    stopCamera();
    setStatusBoth("paused");
    // a finished recording stays: on iOS the share sheet itself sends the app to the background
    setSheet((s) => (s === "recording" ? s : null));
    persist("paused");
    soundRef.current?.vibrate("depth-reached");
    const note = [reason, recCancelled ? "Recording cancelled" : null].filter(Boolean).join(" · ");
    if (note) say(note);
  }

  /** Everything off. The job is saved or dropped; the next start asks what changed. */
  async function stop(save: boolean) {
    const tr = trackerRef.current;
    const recCancelled = cancelRecording();
    if (save) await finishJob();
    else if (!simRef.current) {
      clearJobDraft();
      tr?.resumeJob(null);
    }
    tr?.cancelCalibration();
    tr?.clearPilot();
    pilotKey.current = "none";
    setPilotUiState(null);
    stopCamera();
    if (!simRef.current) tr?.forgetCalibrationSilently(); // frees the engine and the worker; stored calibrations stay, but are asked about
    runRef.current = writeRun("stopped");
    setSheet(null);
    clearCards();
    setDraft(null);
    setDone(0);
    setStopped(true);
    setStatusBoth("start");
    if (recCancelled) say("Recording cancelled");
  }

  function answerChange(c: Change) {
    const tr = trackerRef.current;
    const p = planFor(c);
    if (p.forgetDrill && !simRef.current) tr?.forgetDrillCalibration(); // the simulator's calibration is fixed
    setWizardStep(p.step);
    setSheet("setup");
  }
  function closeSetup() {
    const n = needCheckRef.current, at = trackerRef.current?.toolCalibratedAt();
    if (n && at && at > n.since) needCheckRef.current = null; // calibrated again since the question
    if (!needCheckRef.current) persist("working");
    setSheet(needCheckRef.current ? "changed" : null);
  }

  /** Record 10 s of camera frames. The file is kept and offered in a sheet (Share, Download): a download started
   * by itself, seconds after the tap, may do nothing in an installed iOS app. */
  async function recordCamera() {
    const tr = trackerRef.current;
    if (!tr) return;
    if (recordingRef.current) return say("Already recording");
    setSheet(null);
    const id = ++recSeq.current;
    recordingRef.current = id;
    setRecNote("● Recording 10 s");
    const blob = await tr.record(10, "phone app");
    if (recordingRef.current !== id) return; // cancelled by a pause or a stop, which said so
    recordingRef.current = 0;
    setRecNote(null);
    if (!blob) return say("Nothing recorded: point at the sheet and try again");
    const file = new File([blob], recordingFileName(new Date()), { type: "application/octet-stream" });
    dropRecording();
    let canShare = false;
    try {
      canShare = !!navigator.canShare?.({ files: [file] });
    } catch {}
    setRecFile({ file, canShare });
    // the sheet opens now, or as soon as the sheet in use closes (see the effect below)
    if (sheetRef.current === null) setSheet("recording");
  }
  /** Share the recording (AirDrop to the laptop). navigator.share must be called straight from the tap. */
  function shareRecording() {
    const r = recFile;
    if (!r) return;
    let p: Promise<void>;
    try {
      p = navigator.share({ files: [r.file] });
    } catch (e) {
      p = Promise.reject(e);
    }
    p.catch((e: unknown) => {
      // closing the share sheet is not an error
      if ((e as { name?: string } | null)?.name !== "AbortError") say("Sharing failed: use Download");
    });
  }
  function downloadRecording() {
    const r = recFile;
    if (!r) return;
    recUrlRef.current ??= URL.createObjectURL(r.file);
    const a = document.createElement("a");
    a.href = recUrlRef.current;
    a.download = r.file.name;
    a.click();
  }
  /** Let the recording go (Done or Discard): its file and its download URL. */
  function dropRecording() {
    if (recUrlRef.current) URL.revokeObjectURL(recUrlRef.current);
    recUrlRef.current = null;
    setRecFile(null);
    setSheet((s) => (s === "recording" ? null : s));
  }

  async function openCamera() {
    setStatusBoth("starting");
    let stage: StartStage = "camera";
    try {
      if (!simRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: camResRef.current === 720 ? 1280 : 1920 },
            height: { ideal: camResRef.current },
            frameRate: { ideal: camOptsRef.current.fps60 ? 60 : 30 },
          },
          audio: false,
        });
        stopCamera();
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
        setCamInfo(await applyCameraLock(stream, camOptsRef.current.lock));
      }
      stage = "engine";
      syncTracker(await ensureTracker()); // a job's draft carries the camera options and the display in use
      setStartError(null);
      setStatusBoth("running");
    } catch (e) {
      if (stage === "engine") {
        console.error("engine", e);
        stopCamera(); // the camera must not stay on behind the error screen
      }
      setStartError(explainStartError(stage, e));
      setStatusBoth("blocked");
    }
  }

  function applyPlan(p: Plan, tr = trackerRef.current, announce = true) {
    if (!tr) return;
    // a plan change mid-job: the holes drilled so far are kept as an unfinished job
    if (!simRef.current && tr.recorder?.holes.length) {
      syncTracker(tr);
      const rec = tr.finishJob();
      if (rec)
        void browserMemory()
          .saveJob(rec)
          .then(() => (clearJobDraft(), say(announce ? `Unfinished job saved · Plan: ${p.name}` : "Unfinished job saved")))
          .catch(() => say("The unfinished job could not be saved"));
    }
    // a plan chosen by hand ends the pilot (the simple display then works that plan)
    if (!isPilotPlan(p)) {
      tr.clearPilot();
      pilotKey.current = "none";
      setPilotUiState(null);
    }
    tr.setPlan(p);
    recipeRef.current = recipeOfPlan(p);
    clearCards();
    setPlanState(p);
    setActivePlanId(p.id === SHEET_PLAN.id ? null : p.id);
    // back to no saved plan, in simple: the pilot starts again from its first phase
    if (p.id === SHEET_PLAN.id && setupDecided.current && pilotWanted()) tr.startPilot();
    if (announce) say(`Plan: ${p.name} · ${p.holes.length} holes`);
  }
  async function nextPlan() {
    const saved = (await browserMemory().plans().catch(() => [])).map((r) => r.value);
    const all = [...BUILT_IN_PLANS, ...saved];
    applyPlan(all[(all.findIndex((p) => p.id === plan.id) + 1) % all.length]);
  }
  function mark() {
    const tr = trackerRef.current;
    if (!tr || !draft) return;
    const m = tr.markHere();
    if (!m.ok) return say(m.reason);
    const r = addHole(draft, m);
    if (!r.ok) return say(r.reason);
    setDraft(r.plan);
    say(`${r.plan.holes[r.plan.holes.length - 1].label} marked`);
    soundRef.current?.vibrate("depth-reached");
  }
  async function savePlan() {
    if (!draft) return;
    if (!draft.holes.length) return say("Mark a hole first");
    const r = await browserMemory().savePlan(draft);
    if (!r.ok) return say(r.errors[0]);
    setDraft(null);
    applyPlan(r.plan, trackerRef.current, false);
    say(`Plan saved · ${r.plan.holes.length} holes`);
  }
  async function finishJob() {
    const tr = trackerRef.current;
    syncTracker(tr ?? null);
    const rec = tr?.finishJob();
    if (!rec) return say("No hole drilled yet");
    await browserMemory().saveJob(rec);
    if (!simRef.current) clearJobDraft();
    clearCards();
    setDone(0);
    say(`Job saved · ${rec.report.verdict}`);
  }

  // ---------------- the recipe's Checks (only when the plan came from a recipe) ----------------
  /** A finished hole's Check as a card, with the answers given so far; null when no step is that hole. */
  function cardFor(h: HoleRecord): CheckCardData | null {
    const r = recipeRef.current;
    if (!r) return null;
    const check = checkHole(r, h, trackerRef.current?.recorder?.confirmations);
    if (!check) return null;
    const s = r.statements.find((x) => x.id === check.id);
    return { hole: h, check, words: s ? bindCheck(s.check).manual : "" };
  }
  /** A hole was finished: its card replaces the one shown, unless that one waits for a Yes / No (then it queues). */
  function showCard(h: HoleRecord) {
    if (!recipeRef.current) return;
    if (cardRef.current?.check.outcome.status === "manual") return void cardQueue.current.push(h);
    const c = cardFor(h);
    if (!c) return;
    setCard(c);
    if (c.check.outcome.status === "fail") soundRef.current?.vibrate("alarm");
  }
  /** Yes / No on a card that asks: kept with the job, and the card shows the answered Check. */
  function answerCard(ok: boolean) {
    const cur = cardRef.current;
    if (!cur) return;
    trackerRef.current?.confirmStep(cur.check.id, ok);
    const answered = cardFor(cur.hole);
    setCard(answered);
    const queued = cardQueue.current.splice(0);
    if (queued.length && answered) say(`${answered.check.hole} ${answered.check.outcome.status === "pass" ? "✓" : "✗"}`); // the next hole's card replaces it
    for (const h of queued) showCard(h);
  }
  function clearCards() {
    cardQueue.current = [];
    setCard(null);
  }
  /** Done / Skip on a step: answered either way (Skip is "no"), so it is not asked again. */
  function answerStep(ok: boolean) {
    if (step) trackerRef.current?.confirmStep(step.id, ok);
    setStep(null);
    setSheet((s) => (s === "step" ? null : s));
  }

  // on each start or Continue, once the engine runs: the setup when the drill is not calibrated, "What did you
  // change?" after a stop, or straight back to work after a pause (with the 5 s check suggested after a long one)
  useEffect(() => {
    if (status !== "running") return;
    const iv = setInterval(() => {
      const tr = trackerRef.current;
      // a recording waiting to be shared keeps its sheet: the question comes once it is closed
      if (setupDecided.current || !tr?.session || sheetRef.current === "recording") return;
      setupDecided.current = true;
      const last = runRef.current;
      const d = onStart(last, tr.calibrated.tool);
      if (d === "setup") {
        setWizardStep("sheet");
        setSheet("setup");
      } else if (d === "ask") {
        needCheckRef.current = { since: new Date().toISOString() };
        setSheet("changed");
      } else {
        const p = pausedFor(last, Date.now());
        setPausedMin(Math.round(p.minutes));
        if (p.suggestCheck) setSheet("resume");
      }
      // simple display, no saved plan: the pilot job, from its first phase unless one was restored
      if (!tr.pilot && pilotWanted()) tr.startPilot();
      persist("working");
    }, 500);
    return () => clearInterval(iv);
  }, [status]);

  // pause by itself: the app in the background, or no marker for a minute (the drill was put down)
  useEffect(() => {
    if (status !== "running") return;
    let lastSeen = performance.now();
    const check = (hidden: boolean) => {
      const tr = trackerRef.current;
      if ((tr?.liveCheck().markers ?? 0) > 0) lastSeen = performance.now();
      const busy = sheetRef.current !== null || !!tr?.calStatus() || draftRef.current || recordingRef.current !== 0;
      const why = autoPauseReason({ hidden, noMarkersS: (performance.now() - lastSeen) / 1000, busy });
      if (why) pause(why);
    };
    const iv = setInterval(() => check(false), 1000);
    const onVis = () => document.visibilityState === "hidden" && check(true);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    const iv = setInterval(() => {
      const tr = trackerRef.current;
      setDone(tr?.recorder?.holes.length ?? 0);
      if (!tr) return;
      // the plan is the tracker's: the pilot sets its own on entering "work"
      if (tr.plan.id !== planIdRef.current) {
        planIdRef.current = tr.plan.id;
        recipeRef.current = recipeOfPlan(tr.plan);
        clearCards();
        setPlanState(tr.plan);
      }
      // the pilot's steps before the screws are answered by its phases: confirmed once the fit is ok
      const rec = tr.recorder;
      if (tr.pilot?.fit?.ok && isPilotPlan(tr.plan) && rec) {
        const have = rec.confirmations.map((c) => c.id);
        for (const id of PILOT_MANUAL) if (!have.includes(id)) tr.confirmStep(id, true);
      }
    }, 500);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a recipe step to confirm: decided from the job's data whenever nothing else is open (after the start decision,
  // after each hole, after a sheet closes), so it waits its turn behind every other sheet and is never lost
  useEffect(() => {
    if (status !== "running") return;
    const iv = setInterval(() => {
      const r = recipeRef.current, rec = trackerRef.current?.recorder;
      // the pilot's steps are its phases: no Step sheet
      if (isPilotPlan(trackerRef.current?.plan)) return;
      if (!r || !rec || !setupDecided.current || sheetRef.current !== null || draftRef.current || recFileRef.current || recordingRef.current) return;
      const due = dueManual(
        r,
        rec.holes.map((h) => h.name),
        rec.confirmations.map((c) => c.id),
      )[0];
      if (!due) return;
      setStep(due);
      setSheet((s) => (s === null ? "step" : s)); // never in place of another sheet
    }, 500);
    return () => clearInterval(iv);
  }, [status]);

  // a passed Check goes away after 5 s on screen (the time does not run in a pause or under a sheet)
  useEffect(() => {
    if (status !== "running" || sheet !== null || draft || card?.check.outcome.status !== "pass") return;
    const t = setTimeout(() => cardRef.current === card && setCard(null), 5000);
    return () => clearTimeout(t);
  }, [card, status, sheet, draft, setCard]);

  // a recording not yet shared comes back as soon as no other sheet is open (after a stop, a setup, a menu)
  useEffect(() => {
    if (recFile && sheet === null) setSheet("recording");
  }, [recFile, sheet]);
  useEffect(
    () => () => {
      if (recUrlRef.current) URL.revokeObjectURL(recUrlRef.current);
    },
    [],
  );

  // no tone left sounding in a pause or after a stop
  useEffect(() => {
    if (status !== "running") soundRef.current?.silence();
  }, [status]);

  // the loops: frames (camera rate), engine clock (120 Hz), drawing (display rate)
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    const now = () => performance.now() / 1000;
    const running = () => statusRef.current === "running";

    const v = videoRef.current as VideoWithRvfc;
    let rvfc = 0;
    let fallback: ReturnType<typeof setInterval> | null = null;
    const onVideoFrame = (t: number, meta: VideoFrameMeta) => {
      if (running() && !simRef.current) trackerRef.current?.frame(v, (meta.captureTime ?? t) / 1000);
      rvfc = v.requestVideoFrameCallback!(onVideoFrame);
    };
    if (v.requestVideoFrameCallback) rvfc = v.requestVideoFrameCallback(onVideoFrame);
    else fallback = setInterval(() => running() && !simRef.current && trackerRef.current?.frame(v, now()), 33);

    // development only (?sim=1): simulated camera frames of the scripted drilling run, on the simulator's clock: a
    // frame is captured every 1/15 s of simulated time, once the previous one has been tracked
    let simStart: number | null = null;
    const codes = markerCodes(new AR.Dictionary(DICTIONARY).codeList);
    const sim = setInterval(() => {
      const tr = trackerRef.current;
      const tc = tr?.simClock?.due();
      if (!simRef.current || !running() || !tr || tc == null) return;
      simStart ??= tc;
      const ts = (tc - simStart) % RUN_TIME;
      const st = truthAt(ts);
      const rig = dockRigAt(undefined, DEFAULT_RIG, tr.phone);
      const seed = 1 + Math.round(ts * 1000);
      // &pilot=1: the simulated person does the pilot's current phase; else the scripted drilling run
      if (!(pilotParamRef.current && tr.pilotSimFrame(rig, codes, tc, seed))) tr.simFrame(rig, codes, toolWorldFromHold(tr.core, rig, disturb(st.hold, ts, st.phase, DEFAULT_DISTURBANCE)), tc, seed);
    }, 4);

    // the engine's clock: the wall clock on the phone; in the simulator its own clock, one tick at a time, as far as
    // the frames tracked allow
    const clock = setInterval(() => {
      const tr = trackerRef.current;
      if (!running() || !tr) return;
      if (tr.simClock) tr.simClock.run(now(), (t) => tr.advance(t));
      else tr.advance(now());
    }, 4);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = canvas.width, h = canvas.height;
      if (w <= 0 || h <= 0 || !running()) return;
      const tr = trackerRef.current;
      const source = simRef.current ? simCanvasRef.current : v.readyState >= 2 ? v : null;
      const view = tr?.view();
      if (!tr || !source || !view) return;
      listen(view);
      // the banner (or the readout) hides under a sheet (setup, menu, job): it would show through it
      const top = sheetRef.current === null || sheetRef.current === "bench";
      if (uiRef.current === "simple") {
        // the buttons columns are HTML over the canvas: their edges in canvas px
        const col = columnRef.current, left = leftRef.current, cw = canvas.clientWidth, k = cw ? w / cw : 1;
        const rightInset = col && cw ? Math.max(0, (cw - col.getBoundingClientRect().left) * k) : 0;
        // the pilot: the text in HTML, the focus and the corner capture on the canvas too
        const st = tr.pilotState();
        const f = st ? focus(st) : null;
        const depthX = left ? left.getBoundingClientRect().right * k + Math.min(w, h) * 0.04 : undefined;
        drawSimple(ctx, view.state, w, h, { video: source, overlay: view.overlay, toolCalibrated: tr.calibrated.tool, showVideo: uiVideoRef.current, readout: top, rightInset, drawText: !st, focus: f, capture: st?.capture ?? null, depthX, phase: st?.phase ?? null });
        publishPilot(st, f, view, tr.calibrated.tool);
      } else {
        drawGuide(ctx, view.state, w, h, { video: source, overlay: view.overlay, toolCalibrated: tr.calibrated.tool, banner: top });
        publishPilot(null, null, view, false);
      }
    };
    /** Hand the pilot's text, buttons and focus to React, only when something shown changes. */
    const publishPilot = (st: PilotState | null, f: SimpleFocus | null, view: { state: SimState; overlay: Overlay }, calibrated: boolean) => {
      if (!st || !f) {
        if (pilotKey.current !== "none") (pilotKey.current = "none"), setPilotUiState(null);
        return;
      }
      const ov = view.overlay;
      const active = ov.pilot?.screwsPx.find((x) => x.state === "active");
      const ro = readout(view.state, ov, { tipPx: ov.tipPx ?? null, markPx: active?.p ?? null, calibrated });
      const text = pilotText(st, ro);
      const angle = text.icon === "arrow" ? Math.round(((ro.angle ?? 0) * 180) / Math.PI / 5) * 5 : 0;
      const buttons = phaseButtons(st);
      const key = JSON.stringify([text, angle, f, buttons]);
      if (key === pilotKey.current) return;
      pilotKey.current = key;
      setPilotUiState({ st, text, angle, focus: f, buttons });
    };
    const listen = (view: { state: SimState; overlay: Overlay }) => {
      const sg = soundRef.current;
      if (!sg) return;
      sg.play(toneFromHud(view.state, view.overlay));
      const al = view.overlay.alarms ?? 0;
      if (view.state.phase === "hold" && lastCue.current.phase !== "hold") sg.vibrate("depth-reached");
      if (al && !lastCue.current.alarms) sg.vibrate("alarm");
      lastCue.current = { phase: view.state.phase, alarms: al };
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(clock);
      clearInterval(sim);
      if (fallback) clearInterval(fallback);
      if (rvfc) v.cancelVideoFrameCallback?.(rvfc);
      ro.disconnect();
    };
  }, []);

  // keep the screen awake while working (in a pause it may sleep)
  useEffect(() => {
    if (status !== "running") return;
    let lock: WakeLockSentinelLike | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinelLike> } };
    const req = () => nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    req();
    const onVis = () => document.visibilityState === "visible" && req();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
    };
  }, [status]);

  const fullscreen = () => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else el.webkitRequestFullscreen?.();
  };
  const toggleSound = () => {
    if (soundRef.current) {
      soundRef.current.close();
      soundRef.current = null;
      setSoundOn(false);
    } else {
      soundRef.current = new SoundGuide();
      setSoundOn(true);
    }
  };
  const openBench = async () => {
    // iOS asks for permission to read the accelerometer, from a tap
    const DM = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (DM?.requestPermission) await DM.requestPermission().catch(() => "denied");
    setSheet("bench");
  };

  return (
    <div className="fixed inset-0 bg-black text-white">
      <canvas ref={canvasRef} className="block h-[100dvh] w-full touch-none" />
      <video ref={videoRef} playsInline muted className="hidden" />

      {/* start: one button (the browser needs a tap to turn the camera on) */}
      {(status === "start" || status === "starting" || status === "blocked") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-8 text-center">
          <span className="inline-block h-10 w-10 rounded-full border-4 border-[#3ee59b] shadow-[0_0_24px_#3ee59b]" />
          <h1 className="text-3xl font-semibold">SmartTools</h1>
          {status === "blocked" && startError && <h2 className="text-xl font-semibold text-[#ff6b6b]">{startError.title}</h2>}
          <p className="max-w-sm text-lg leading-snug text-white/75">
            {status === "blocked"
              ? (startError?.text ?? "Something went wrong. Try again.")
              : stopped
                ? "Stopped. When you start again, the app asks what you changed: the bit, the tip or the phone."
                : "Phone on the drill, printed sheet on the work. Tap Start and point the camera at the sheet."}
          </p>
          <button onClick={start} disabled={status === "starting"} className="h-16 w-full max-w-xs rounded-2xl bg-[#3ee59b] text-2xl font-semibold text-black disabled:opacity-50">
            {status === "starting" ? "Starting…" : status === "blocked" ? "Try again" : "Start"}
          </button>
          <div className="flex gap-6 text-base text-white/55">
            <a href="/markers" className="underline decoration-white/25">
              Print the sheet
            </a>
            <a href="/memory" className="underline decoration-white/25">
              Plans & jobs
            </a>
          </div>
          <VersionLine className="absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))]" />
        </div>
      )}

      {status === "paused" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-black/95 px-8 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-[#ffb547] text-2xl text-[#ffb547]">❚❚</span>
          <h1 className="text-4xl font-semibold text-[#ffb547]">Paused</h1>
          <p className="text-xl leading-snug text-white/80">
            Camera off · calibration kept
            <br />
            {Math.round(pausedFor(runRef.current, Date.now()).minutes)} min
          </p>
          <p className="max-w-sm text-base text-white/55">Nothing on the drill should change during a pause. If you change the bit or move the phone, use Stop.</p>
          <button onClick={start} className="h-20 w-full max-w-xs rounded-2xl bg-[#3ee59b] text-3xl font-semibold text-black active:scale-[0.99]">
            ▶ Continue
          </button>
          <button onClick={() => setSheet("stop")} className="h-14 w-full max-w-xs rounded-2xl border border-white/25 text-xl text-white/80">
            ■ Stop
          </button>
        </div>
      )}

      {sheet === "stop" && (
        <TopSheet title="Stop?" onClose={() => setSheet(null)}>
          <p className="text-lg leading-snug text-white/75">
            Camera and tracking off. When you start again, the app asks what you changed (the bit, the tip, the phone) and redoes only that.
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {done > 0 ? (
              <>
                <BigButton strong onClick={() => void stop(true)}>
                  Save the job ({done}/{plan.holes.length}) and stop
                </BigButton>
                <BigButton onClick={() => void stop(false)}>Stop without saving</BigButton>
              </>
            ) : (
              <BigButton strong onClick={() => void stop(false)}>
                Stop
              </BigButton>
            )}
            <BigButton onClick={() => setSheet(null)}>Cancel</BigButton>
          </div>
        </TopSheet>
      )}

      {/* a finished recording: shown in any status (running, paused, start), kept until Done or Discard */}
      {sheet === "recording" && recFile && (
        <TopSheet title={`Recording ready · ${sizeText(recFile.file.size)}`}>
          <p className="text-lg leading-snug text-white/75">Send it to the laptop: Share (AirDrop) or Download.</p>
          <div className="mt-4 flex flex-col gap-3">
            {recFile.canShare && (
              <BigButton strong onClick={shareRecording}>
                Share
              </BigButton>
            )}
            <BigButton strong={!recFile.canShare} onClick={downloadRecording}>
              Download
            </BigButton>
            <div className="grid grid-cols-2 gap-3">
              <BigButton onClick={() => (dropRecording(), say("Recording discarded"))}>Discard</BigButton>
              <BigButton onClick={dropRecording}>Done</BigButton>
            </div>
          </div>
        </TopSheet>
      )}

      {/* under the banner: the Check card (while working, nothing else open), and the toast below it. In simple: under
          the shorter readout, between the depth bar (left) and the buttons column (right), and a chip for pass / fail */}
      {(toast || card) && (
        <div
          className={
            simple
              ? "pointer-events-none absolute left-[max(13vmin,env(safe-area-inset-left))] right-[calc(max(0.75rem,env(safe-area-inset-right))+4.75rem)] top-[max(5.5rem,calc(22vmin+0.5rem),calc(env(safe-area-inset-top)+5rem))] z-40 flex flex-col items-center gap-2"
              : "pointer-events-none absolute inset-x-0 top-[max(8rem,calc(27vmin+0.5rem),calc(env(safe-area-inset-top)+7rem))] z-40 flex flex-col items-center gap-2 px-4"
          }
        >
          {card &&
            status === "running" &&
            sheet === null &&
            !draft &&
            (simple && card.check.outcome.status !== "manual" ? <CheckChip card={card} onOk={() => setCard(null)} /> : <CheckCard card={card} onOk={() => setCard(null)} onAnswer={answerCard} />)}
          {toast && <div className="rounded-2xl bg-black/75 px-5 py-2.5 text-lg font-medium text-white backdrop-blur-md">{toast}</div>}
        </div>
      )}

      {status === "running" && (
        <>
          {/* planning with the tool as a pointer: big buttons under the banner */}
          {draft && (
            <div className="absolute inset-x-3 top-[max(8rem,calc(env(safe-area-inset-top)+7rem))] z-10 rounded-2xl border border-white/20 bg-black/75 p-3 backdrop-blur-md">
              <div className="text-lg font-semibold">New plan · {draft.holes.length} holes</div>
              <div className="text-base text-white/70">Touch the surface with the tip, then tap Mark hole.</div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <BigButton onClick={mark} strong>
                  Mark hole
                </BigButton>
                <BigButton onClick={savePlan}>Save plan</BigButton>
                <BigButton onClick={() => draft.holes.length && setDraft(removeLastHole(draft))}>Undo</BigButton>
                <BigButton onClick={() => setDraft(null)}>Cancel</BigButton>
              </div>
            </div>
          )}

          {sheet === "setup" && (
            <SetupWizard
              tracker={tracker}
              initialStep={wizardStep}
              onChecked={() => {
                needCheckRef.current = null;
                persist("working");
              }}
              onClose={closeSetup}
              onOpenBench={() => void openBench()}
              phoneName={phoneName}
              onNextPhone={() => {
                const tr = trackerRef.current;
                if (tr) setPhoneName(tr.nextPhone().name);
              }}
            />
          )}

          {sheet === "bench" && (
            <BenchPanel
              tracker={tracker}
              say={say}
              onClose={() => setSheet(null)}
              realCamera={!simRef.current}
              cameraRes={camRes}
              cameraOpts={camOpts}
              cameraInfo={camInfo}
              onCameraOpts={(o) => {
                camOptsRef.current = o;
                setCamOpts(o);
                try {
                  localStorage.setItem("st-cam-fps60", o.fps60 ? "1" : "0");
                  localStorage.setItem("st-cam-lock", o.lock ? "1" : "0");
                } catch {}
                void openCamera();
              }}
              onCameraRes={(r) => {
                camResRef.current = r;
                setCamRes(r);
                try {
                  localStorage.setItem("st-cam-res", String(r));
                } catch {}
                void openCamera();
              }}
            />
          )}

          {sheet === "changed" && (
            <TopSheet title="What did you change?">
              <p className="text-lg text-white/70">
                Since the last stop. Drill calibrated {ago(trackerRef.current?.toolCalibratedAt() ?? null, Date.now()) ?? "some time ago"}.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-3">
                {CHANGES.map((c) => (
                  <button key={c.id} onClick={() => answerChange(c.id)} className={`rounded-2xl px-4 py-3 text-left active:scale-[0.99] ${c.id === "nothing" ? "bg-[#3ee59b] text-black" : "border border-white/25 text-white"}`}>
                    <div className="text-xl font-semibold">{c.label}</div>
                    <div className={`text-base ${c.id === "nothing" ? "text-black/70" : "text-white/60"}`}>{c.note}</div>
                  </button>
                ))}
              </div>
            </TopSheet>
          )}

          {sheet === "resume" && (
            <TopSheet title={`Paused ${pausedMin} min`} onClose={() => setSheet(null)}>
              <p className="text-lg text-white/75">If nothing moved on the drill, go on. To be sure, check the tip on A2 (5 s).</p>
              <div className="mt-4 flex flex-col gap-3">
                <BigButton strong onClick={() => setSheet(null)}>
                  Continue
                </BigButton>
                <BigButton
                  onClick={() => {
                    setWizardStep("check");
                    setSheet("setup");
                  }}
                >
                  Check on A2 · 5 s
                </BigButton>
              </div>
            </TopSheet>
          )}

          {sheet === "step" && step && (
            <TopSheet title="Step">
              <p className="text-2xl font-semibold leading-snug">{step.do}</p>
              {step.check && <p className="mt-2 text-xl leading-snug text-white/80">Check: {step.check}</p>}
              {step.because && <p className="mt-2 text-base text-white/50">{step.because}</p>}
              <div className="mt-4 grid grid-cols-2 gap-3">
                <BigButton strong onClick={() => answerStep(true)}>
                  Done
                </BigButton>
                <BigButton onClick={() => answerStep(false)}>Skip</BigButton>
              </div>
            </TopSheet>
          )}

          {sheet === "job" && !draft && (
            <TopSheet title="Job" onClose={() => setSheet(null)}>
              <p className="text-lg text-white/75">
                Plan: <b className="text-white">{plan.name}</b> · {done} of {plan.holes.length} holes done
              </p>
              {recipe && <JobChecks recipe={recipe} plan={plan} job={trackerRef.current?.jobSoFar() ?? null} />}
              <JobHoles job={trackerRef.current?.jobSoFar() ?? null} />
              <div className="mt-4 flex flex-col gap-3">
                <BigButton onClick={nextPlan}>Change plan</BigButton>
                <BigButton
                  onClick={() => {
                    const tr = trackerRef.current;
                    if (!tr) return;
                    const next = tr.tolDeg === 0.5 ? 2 : 0.5;
                    tr.setTolerance(next);
                    setTol(next);
                  }}
                >
                  Precision: ±{tol}° {tol === 0.5 ? "(spec)" : "(practice)"}
                </BigButton>
                <BigButton
                  onClick={() => {
                    setDraft(newPlan(`Plan ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`));
                    setSheet(null);
                  }}
                >
                  New plan with the tool
                </BigButton>
                <BigButton strong onClick={async () => (await finishJob(), setSheet(null))}>
                  Finish job and save
                </BigButton>
              </div>
            </TopSheet>
          )}

          {sheet === "menu" && (
            <TopSheet title="Menu" onClose={() => setSheet(null)}>
              <div className="grid grid-cols-2 gap-3">
                <BigButton
                  strong
                  onClick={() => {
                    setWizardStep("sheet");
                    setSheet("setup");
                  }}
                >
                  Setup
                </BigButton>
                <BigButton onClick={() => setSheet("job")}>
                  Job · {done}/{plan.holes.length}
                </BigButton>
                <BigButton onClick={() => void openBench()}>Tests</BigButton>
                <BigButton onClick={() => void recordCamera()}>Record 10 s</BigButton>
                <BigButton onClick={toggleSound}>Sound: {soundOn ? "on" : "off"}</BigButton>
                <BigButton onClick={() => setUi(simple ? "classic" : "simple")}>Display: {ui}</BigButton>
                <BigButton onClick={fullscreen}>Full screen</BigButton>
                <BigButton onClick={() => (window.location.href = "/memory")}>Plans & jobs</BigButton>
              </div>
              <VersionLine className="mt-4" />
            </TopSheet>
          )}

          {/* the menu button, top right, when nothing else is open (classic) */}
          {!simple && sheet === null && (
            <button
              onClick={() => setSheet("menu")}
              aria-label="Menu"
              className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-30 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/30 bg-black/60 text-3xl backdrop-blur-md"
            >
              ☰
            </button>
          )}

          {/* the trigger: Pause (big, in the thumb's reach, right side: the tip shows bottom left) and Stop (held) */}
          {!simple && sheet === null && !draft && (
            <div className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(0.75rem,env(safe-area-inset-right))] z-30 flex items-end gap-2">
              <HoldButton onHold={() => setSheet("stop")} onTap={() => say("Hold to stop")} label="■" aria="Stop (hold)" />
              <button
                onClick={() => pause()}
                aria-label="Pause"
                className="flex h-20 w-36 items-center justify-center gap-2 rounded-2xl border-2 border-[#ffb547] bg-black/60 text-2xl font-semibold text-[#ffb547] backdrop-blur-md active:scale-[0.98]"
              >
                ❚❚ Pause
              </button>
            </div>
          )}
          {/* simple: five round buttons at the right edge, icons only: Pause, Stop (held), Video, Sound, More. In the
              pilot each one glows when it is the one to press, or is dimmed when it does not matter now */}
          {simple && sheet === null && !draft && (
            <div ref={columnRef} className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-1/2 z-30 flex -translate-y-1/2 flex-col gap-3" style={{ color: COL.rest }}>
              <Lit look={controlLook(pf, "pause")}>
                <button onClick={() => pause()} aria-label="Pause" className={ROUND}>
                  <Glyph d="M9 5v14M15 5v14" />
                </button>
              </Lit>
              <Lit look={controlLook(pf, "stop")}>
                <HoldButton onHold={() => setSheet("stop")} onTap={() => buzz(30)} label={<Glyph d="M6.5 6.5h11v11h-11z" />} aria="Stop (hold)" className={ROUND} />
              </Lit>
              <Lit look={controlLook(pf, "video")}>
                <button onClick={() => setUiVideo(!uiVideo)} aria-label={uiVideo ? "Hide the video" : "Show the video"} aria-pressed={uiVideo} className={ROUND}>
                  <Glyph d={uiVideo ? EYE : `${EYE}M4 20L20 4`} />
                </button>
              </Lit>
              <Lit look={controlLook(pf, "sound")}>
                <button onClick={toggleSound} aria-label={soundOn ? "Sound off" : "Sound on"} aria-pressed={soundOn} className={ROUND}>
                  <Glyph d={soundOn ? `${SPEAKER}M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11` : `${SPEAKER}M16 9.5l5 5M21 9.5l-5 5`} />
                </button>
              </Lit>
              <Lit look={controlLook(pf, "more")}>
                <button onClick={() => setSheet("menu")} aria-label="More" className={ROUND}>
                  <Glyph d="M5.5 12h.01M12 12h.01M18.5 12h.01" width={4} />
                </button>
              </Lit>
            </div>
          )}
          {/* the pilot: the three phase buttons at the left edge (sheet, part, work), vertically centred */}
          {simple && pilotUi && sheet === null && !draft && (
            <div ref={leftRef} className="absolute left-[max(0.75rem,env(safe-area-inset-left))] top-1/2 z-30 flex -translate-y-1/2 flex-col gap-3" style={{ color: COL.rest }}>
              {pilotUi.buttons.map((b) => (
                <PhaseButtonView key={b.phase} b={b} look={controlLook(pf, `phase-${b.phase}`)} onEnter={() => enterPhase(b.phase)} onClear={b.phase === "sheet" ? clearTable : undefined} />
              ))}
            </div>
          )}
          {/* the pilot: the one text at the top (or the step's words for 3 s after a tap on it) */}
          {simple && pilotUi && sheet === null && !draft && (
            <PilotTopText text={pilotUi.text} angle={pilotUi.angle} words={words} look={controlLook(pf, "text")} onTap={showPilotWords} />
          )}
          {/* simple without the pilot: a tap on the readout says it in words (the classic banner's), for 3 s */}
          {simple && !pilotUi && sheet === null && !draft && (
            <button
              onClick={showWords}
              aria-label="Say it in words"
              className="absolute left-0 top-0 z-20 h-[max(22vmin,calc(env(safe-area-inset-top)+4rem))] right-[calc(max(0.75rem,env(safe-area-inset-right))+4.75rem)] bg-transparent"
            />
          )}
          {recNote && (
            <div className={`pointer-events-none absolute z-30 rounded-full bg-[#ff6b6b] px-4 py-1.5 text-lg font-semibold text-black ${simple ? "bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2" : "bottom-[calc(max(1rem,env(safe-area-inset-bottom))+6rem)] right-3"}`}>{recNote}</div>
          )}
        </>
      )}

      {/* a tracker failure: a phone has no console, so it is shown here, above every sheet, until reload */}
      {fault && (
        <div role="alert" className="absolute inset-x-0 top-0 z-50 border-b-4 border-white/40 bg-[#d62828] px-5 pb-5 pt-[max(1rem,env(safe-area-inset-top))] text-white shadow-2xl">
          <h2 className="text-3xl font-bold">Tracking stopped</h2>
          <p className="mt-2 break-words text-xl leading-snug">{fault}</p>
          <button onClick={() => location.reload()} className="mt-4 h-16 w-full rounded-2xl bg-white text-2xl font-semibold text-[#d62828] active:scale-[0.99]">
            Reload
          </button>
        </div>
      )}
    </div>
  );
}

/** Which build runs, in small dim text: app version, commit, engine ABI. */
function VersionLine({ className = "" }: { className?: string }) {
  return <p className={`text-center text-xs text-white/35 ${className}`}>{versionLine(process.env.NEXT_PUBLIC_BUILD)}</p>;
}

/** Lock focus and exposure where the browser allows it (Chrome on Android; not Safari on iPhone), and say
 * what the camera actually runs at. */
async function applyCameraLock(stream: MediaStream, lock: boolean): Promise<string> {
  const track = stream.getVideoTracks()[0];
  if (!track) return "";
  type Caps = MediaTrackCapabilities & { focusMode?: string[]; exposureMode?: string[]; focusDistance?: { min: number } };
  type Sets = MediaTrackSettings & { focusMode?: string; exposureMode?: string; focusDistance?: number; exposureTime?: number };
  const caps = (track.getCapabilities?.() ?? {}) as Caps;
  let lockNote = "focus auto";
  if (lock) {
    const set = track.getSettings() as Sets;
    const adv: Record<string, unknown> = {};
    if (caps.focusMode?.includes("manual") && set.focusDistance != null) Object.assign(adv, { focusMode: "manual", focusDistance: set.focusDistance });
    else if (caps.focusMode?.includes("single-shot")) adv.focusMode = "single-shot";
    if (caps.exposureMode?.includes("manual") && set.exposureTime != null) Object.assign(adv, { exposureMode: "manual", exposureTime: set.exposureTime });
    if (Object.keys(adv).length) {
      try {
        await track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] });
        lockNote = `${adv.focusMode ? "focus locked" : "focus auto"} · ${adv.exposureMode ? "exposure locked" : "exposure auto"}`;
      } catch {
        lockNote = "lock refused by the camera";
      }
    } else lockNote = "lock not supported here";
  }
  const s = track.getSettings();
  return `${s.width}×${s.height} · ${Math.round(s.frameRate ?? 0)} fps · ${lockNote}`;
}

/** The Job sheet's recipe lines: who wrote it, and its Checks so far (holes not drilled yet are to do, not fails). */
function JobChecks({ recipe, plan, job }: { recipe: Recipe; plan: Plan; job: ReturnType<BrowserNav["jobSoFar"]> }) {
  const by = { ai: "an AI", expert: "an expert", manual: "hand", pointer: "the tool as a pointer" }[plan.author.kind];
  return (
    <>
      <p className="mt-1 text-lg text-white/75">
        Recipe by {by}
        {plan.reviewed ? " · reviewed" : ""}
      </p>
      {job && <p className="mt-1 text-lg text-white/75">Checks: {tallyText(tallySoFar(recipe, job))}</p>}
    </>
  );
}

/** The Job sheet's holes so far (depth, angle, how far from the mark) and what produced the numbers. */
function JobHoles({ job }: { job: ReturnType<BrowserNav["jobSoFar"]> }) {
  if (!job) return null;
  return (
    <>
      {job.holes.length > 0 && (
        <p className="mt-1 font-mono text-base text-white/65">
          {job.holes.map(holeLine).join(" · ")}
        </p>
      )}
      <p className="mt-1 font-mono text-sm text-white/40" title={harnessId(job)}>
        {harnessLabel(job)}
      </p>
    </>
  );
}

const CARD_STYLE = {
  pass: { box: "border-[#3ee59b]", text: "text-[#3ee59b]", mark: "✓" },
  fail: { box: "border-[#ff6b6b]", text: "text-[#ff6b6b]", mark: "✗" },
  manual: { box: "border-[#ffb547]", text: "text-[#ffb547]", mark: "· confirm" },
} as const;

/** A finished hole's Check, readable at arm's length: pass (goes by itself), fail (until OK), or words for the
 * person to confirm (until Yes / No). */
function CheckCard({ card, onOk, onAnswer }: { card: CheckCardData; onOk: () => void; onAnswer: (ok: boolean) => void }) {
  const { status, detail } = card.check.outcome;
  const st = CARD_STYLE[status];
  const measured = detail
    .split(" · ")
    .filter((p) => !p.startsWith("confirm: "))
    .join(" · ");
  return (
    <div role="status" className={`pointer-events-auto w-full max-w-md rounded-2xl border-2 bg-black/85 px-5 py-3 backdrop-blur-md ${st.box}`}>
      <div className={`text-2xl font-semibold ${st.text}`}>
        {card.check.hole ?? card.check.id} {st.mark}
      </div>
      {status === "manual" ? (
        <>
          <p className="mt-1 text-xl leading-snug text-white">{card.words}</p>
          {measured && <p className="mt-1 text-base text-white/55">{measured}</p>}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <BigButton strong onClick={() => onAnswer(true)}>
              Yes
            </BigButton>
            <BigButton onClick={() => onAnswer(false)}>No</BigButton>
          </div>
        </>
      ) : (
        <p className="mt-1 text-xl leading-snug text-white/85">{detail}</p>
      )}
      {status === "fail" && (
        <div className="mt-3 flex">
          <BigButton onClick={onOk}>OK</BigButton>
        </div>
      )}
    </div>
  );
}

function TopSheet({ title, onClose, children }: { title: string; onClose?: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute inset-x-0 top-0 z-20 rounded-b-3xl border-b border-white/15 bg-black/85 px-5 pb-5 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-md">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-2xl font-semibold">{title}</h2>
        {onClose && (
          <button onClick={onClose} className="px-3 text-3xl text-white/70" aria-label="Close">
            ✕
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function BigButton({ children, onClick, strong }: { children: React.ReactNode; onClick: () => void; strong?: boolean }) {
  return (
    <button onClick={onClick} className={`h-14 rounded-2xl px-4 text-lg font-semibold active:scale-[0.99] ${strong ? "bg-[#3ee59b] text-black" : "border border-white/25 text-white"}`}>
      {children}
    </button>
  );
}

/** Acts only when held (1 s), like a guarded switch: a tap just says so. The ring fills while held, in red (it is the
 * stop) whatever the look. */
function HoldButton({ onHold, onTap, label, aria, className = HOLD_CLASSIC }: { onHold: () => void; onTap: () => void; label: React.ReactNode; aria: string; className?: string }) {
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const down = () => {
    fired.current = false;
    setHeld(true);
    timer.current = setTimeout(() => {
      fired.current = true;
      setHeld(false);
      onHold();
    }, 1000);
  };
  const up = () => {
    if (timer.current) clearTimeout(timer.current);
    if (held && !fired.current) onTap();
    setHeld(false);
  };
  return (
    <button
      aria-label={aria}
      onPointerDown={down}
      onPointerUp={up}
      onPointerLeave={() => (timer.current && clearTimeout(timer.current), setHeld(false))}
      onPointerCancel={() => (timer.current && clearTimeout(timer.current), setHeld(false))}
      onContextMenu={(e) => e.preventDefault()}
      className={`relative select-none overflow-hidden ${className}`}
    >
      <span className="absolute inset-x-0 bottom-0 bg-[#ff6b6b]/70" style={{ height: held ? "100%" : "0%", transition: held ? "height 1s linear" : "none" }} />
      <span className="relative">{label}</span>
    </button>
  );
}
const HOLD_CLASSIC = "flex h-16 w-16 items-center justify-center rounded-2xl border border-white/30 bg-black/60 text-2xl text-white/85 backdrop-blur-md";

/** The simple display's round button: the colour comes from the column (currentColor). */
const ROUND = "flex h-16 w-16 items-center justify-center rounded-full border-2 border-current bg-black/60 backdrop-blur-md active:scale-95";
const EYE = "M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z";
const SPEAKER = "M4 9.5h3.5L12 5.5v13l-4.5-4H4z";

/** An icon of the simple display: one stroked path in the current colour. */
function Glyph({ d, width = 2.5 }: { d: string; width?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={30} height={30} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** A finished hole's Check in the simple display: the hole, ✓ or ✗, and the numbers. Pass: a green outline (goes
 * by itself); fail: filled red, until tapped. */
function CheckChip({ card, onOk }: { card: CheckCardData; onOk: () => void }) {
  const { status, detail } = card.check.outcome;
  const fail = status === "fail";
  const color = fail ? COL.stop : COL.ok;
  const name = card.check.hole ?? card.check.id;
  // the numbers only; words (not drilled, the person said no) when there are none
  const nums = chipNumbers(detail);
  const body = (
    <>
      <span className="text-2xl font-semibold">{name}</span>
      <span className="text-4xl font-bold leading-none">{fail ? "✗" : "✓"}</span>
      {/* one number per line: the chip sits in a narrow slot between the depth bar and the buttons */}
      <span className="flex min-w-0 flex-col font-mono text-lg leading-tight tabular-nums">
        {nums.split(" · ").map((n, i) => (
          <span key={i} className={nums !== detail ? "whitespace-nowrap" : "break-words"}>
            {n}
          </span>
        ))}
      </span>
    </>
  );
  const cls = "pointer-events-auto flex max-w-full items-center gap-3 rounded-full border-2 px-5 py-2 text-left";
  return fail ? (
    <button onClick={onOk} aria-label={`${name} failed: ${detail}. Tap to close`} className={cls} style={{ background: color, borderColor: color, color: "#000" }}>
      {body}
    </button>
  ) : (
    <div role="status" aria-label={`${name} passed: ${detail}`} className={`${cls} bg-black/70 backdrop-blur-md`} style={{ borderColor: color, color }}>
      {body}
    </div>
  );
}

// ---------------- the pilot's controls (simple display) ----------------

/** A control under the pilot's focus: a pulsing amber ring when it is the one to press, dimmed when it does not
 * matter now (still usable). */
function Lit({ look, children, shape = "rounded-full" }: { look: { glow: boolean; opacity: number }; children: React.ReactNode; shape?: string }) {
  return (
    <div className="relative" style={{ opacity: look.opacity, transition: "opacity 200ms" }}>
      {children}
      {look.glow && <span aria-hidden className={`st-glow pointer-events-none absolute -inset-1.5 border-[3px] ${shape}`} style={{ borderColor: COL.next, boxShadow: `0 0 16px ${COL.next}` }} />}
    </div>
  );
}

const PHASE_ICON: Record<Phase, React.ReactNode> = {
  // a grid of squares: the marker sheet
  sheet: <path d="M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z" />,
  // a square with its corners: the block registered on its corners
  part: (
    <>
      <path d="M6 6h12v12H6z" strokeWidth={2} />
      <path d="M6 6h.01M18 6h.01M18 18h.01M6 18h.01" strokeWidth={5.5} />
    </>
  ),
  // a target: the screws
  work: <path d="M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM12 2v4M12 18v4M2 12h4M18 12h4M12 11.9v.2" />,
};
const PHASE_LABEL: Record<Phase, string> = { sheet: "Sheet: map the sheets on the table", part: "Part: touch the block's four corners", work: "Work: the four screws" };

/** A phase button: filled when it is the current phase, dimmed (a tap only vibrates) when it cannot be entered
 * yet, a small green tick when it is done; held 1 s when entering it would throw away corners already taken.
 * With `onClear` (the Sheet button) a tap enters the phase and holding it 1 s calls onClear (the table map). */
function PhaseButtonView({ b, look, onEnter, onClear }: { b: PhaseButton; look: { glow: boolean; opacity: number }; onEnter: () => void; onClear?: () => void }) {
  const cls = `${ROUND} ${b.current ? "!bg-[#e8eef5] text-black" : ""}`;
  const icon = (
    <svg viewBox="0 0 24 24" width={30} height={30} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PHASE_ICON[b.phase]}
    </svg>
  );
  const aria = `${PHASE_LABEL[b.phase]}${b.current ? " (now)" : ""}${b.completed ? ", done" : ""}${b.enabled ? "" : ", not yet"}${b.hold ? ", hold to start again" : ""}${onClear ? ", hold to map the table again" : ""}`;
  return (
    <Lit look={{ glow: look.glow && b.enabled, opacity: Math.min(look.opacity, b.enabled ? 1 : 0.3) }}>
      {onClear && b.enabled ? (
        <HoldButton onHold={onClear} onTap={onEnter} label={icon} aria={aria} className={cls} />
      ) : b.hold && b.enabled ? (
        <HoldButton onHold={onEnter} onTap={() => buzz(30)} label={icon} aria={aria} className={cls} />
      ) : (
        <button onClick={b.enabled ? onEnter : () => buzz(30)} aria-label={aria} aria-current={b.current ? "step" : undefined} aria-disabled={!b.enabled} className={cls}>
          {icon}
        </button>
      )}
      {b.completed && (
        <span aria-hidden className="pointer-events-none absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-black" style={{ background: COL.ok }}>
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="#000" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
      )}
    </Lit>
  );
}

const TONE_COLOR: Record<PilotText["tone"], string> = { next: COL.next, ok: COL.ok, stop: COL.stop, plain: "#ffffff" };
const TEXT_SHADOW = "0 2px 6px rgba(0,0,0,0.95), 0 0 2px #000, 0 0 18px rgba(0,0,0,0.8)";

/** The icons of the top text, stroked like the buttons' (the canvas draws the same shapes: lib/hudguide.ts icon). */
function TextIcon({ icon, angle, color }: { icon: PilotText["icon"]; angle: number; color: string }) {
  let body: React.ReactNode;
  if (icon === "arrow") body = <path d="M4 12h15M13.5 6.5L19.5 12l-6 5.5" transform={`rotate(${angle} 12 12)`} />;
  else if (icon === "down") body = <path d="M12 4v13M7 12l5 5.5 5-5.5M5 20.5h14" />;
  else if (icon === "level") body = <path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />;
  else if (icon === "check") body = <path d="M6 12l4.5 4.5 8-9" />;
  else if (icon === "stop") body = <path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM8 8l8 8M16 8l-8 8" />;
  else if (icon === "drill") body = <path d="M12 3.5v17M8.5 16l3.5 4.5 3.5-4.5" />;
  else if (icon === "search") body = <path d="M10.5 5.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM14.2 14.2l5.3 5.3" />;
  else if (icon === "corner") body = <path d="M5 19.5V5h14.5M5 5h.01" />;
  else if (icon === "sheet") body = PHASE_ICON.sheet;
  else body = <path d="M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM18 12h3.5M2.5 12H6M12 18v3.5M12 2.5V6" />; // setup: a crosshair
  return (
    <svg viewBox="0 0 24 24" className="h-14 w-14 shrink-0" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.9))" }}>
      {icon === "corner" ? (
        <>
          {body}
          <path d="M5 5h.01" strokeWidth={6} />
        </>
      ) : (
        body
      )}
    </svg>
  );
}

/** The pilot's one text, top centre, no box: icon, value and unit in the tone's colour. When what it shows changes
 * kind (textKey) the old one fades out as the new one fades in; a value that changes updates in place. A tap shows
 * the step's words in the same place for 3 s. Nothing is drawn around it: under the focus glow the text itself
 * pulses with a soft glow in its own colour; dimmed, it fades. */
function PilotTopText({ text, angle, words, look, onTap }: { text: PilotText; angle: number; words: string | null; look: { glow: boolean; opacity: number }; onTap: () => void }) {
  const color = TONE_COLOR[text.tone];
  const id = words ? `words|${words}` : textKey(text);
  return (
    <div className="pointer-events-none absolute inset-x-[max(0.75rem,env(safe-area-inset-left))] top-[max(0.75rem,env(safe-area-inset-top))] z-20 flex justify-center landscape:inset-x-[calc(max(0.75rem,env(safe-area-inset-left),env(safe-area-inset-right))+5rem)]">
      <div className={look.glow ? "st-text-glow" : undefined} style={{ opacity: look.opacity, transition: "opacity 200ms", color: words ? "#ffffff" : color }}>
        <button onClick={onTap} aria-label={words ?? (`${text.value} ${text.unit}`.trim() || "Say it in words")} className="pointer-events-auto block min-h-16 min-w-40 max-w-full px-3 py-1">
          <CrossFade id={id}>
            {words ? (
              <span className="block max-w-[22rem] text-center text-2xl font-semibold leading-snug text-white" style={{ textShadow: TEXT_SHADOW }}>
                {words}
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2 whitespace-nowrap" style={{ color, textShadow: TEXT_SHADOW }}>
                <TextIcon icon={text.icon} angle={angle} color={color} />
                {text.value && <span className="text-6xl font-bold leading-none tabular-nums">{text.value}</span>}
                {text.unit && text.value && <span className="self-end pb-1 text-3xl font-semibold leading-none">{text.unit}</span>}
              </span>
            )}
          </CrossFade>
        </button>
      </div>
    </div>
  );
}

/** Children keyed by `id`: when `id` changes, the old content stays mounted, fading out (200 ms), stacked under
 * the new one fading in. The same `id` with new children updates in place, without a fade. */
function CrossFade({ id, children }: { id: string; children: React.ReactNode }) {
  const [st, setSt] = useState<{ cur: string; out: { id: string; node: React.ReactNode }[] }>({ cur: id, out: [] });
  const last = useRef<React.ReactNode>(children);
  if (st.cur !== id) setSt({ cur: id, out: [...st.out.filter((o) => o.id !== id && o.id !== st.cur), { id: st.cur, node: last.current }] });
  useEffect(() => {
    last.current = children;
  });
  useEffect(() => {
    if (!st.out.length) return;
    const t = setTimeout(() => setSt((s) => ({ ...s, out: [] })), 220);
    return () => clearTimeout(t);
  }, [st.out]);
  return (
    <div className="grid place-items-center">
      {st.out.map((o) => (
        <div key={o.id} className="st-fade-out [grid-area:1/1]">
          {o.node}
        </div>
      ))}
      <div key={id} className="st-fade-in [grid-area:1/1]">
        {children}
      </div>
    </div>
  );
}
