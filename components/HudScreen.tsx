"use client";

// The phone app (/hud): only what is needed to work. A start screen (the browser needs a tap to turn on the
// camera), then the live camera with the GPS-style guide (lib/hudguide.ts). The guided setup opens by itself
// when the drill is not calibrated. One menu: Setup, Job, Tests, Record, Sound, Full screen.
// Like the drill's trigger (lib/runstate.ts): Pause turns the camera and tracking off and keeps the calibration;
// Stop (held 1 s) turns everything off, and the next start asks what changed and redoes only that.
// Three loops run independently: camera frames (tracked in a worker), the engine clock (120 Hz), drawing.
// For development only, /hud?sim=1 replaces the camera with the scene simulator (no button for it); with
// &recipe=1 it works the sheet's holes from a recipe, so the live Checks can be seen.
// A plan that came from a recipe (plan.recipe): each finished hole shows its Check answered by the engine (a card
// under the banner), and the steps that are not holes are confirmed by the person (the "Step" sheet).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BenchPanel from "./BenchPanel";
import SetupWizard, { type Step as WizardStep } from "./SetupWizard";
import type { SimState } from "@/lib/sim";
import { SoundGuide, toneFromHud } from "@/lib/audio";
import { CHANGES, ago, autoPauseReason, explainStartError, onStart, pausedFor, planFor, readRun, writeRun, type Change, type RunRecord, type StartStage } from "@/lib/runstate";
import type { Overlay } from "@/lib/hud";
import { drawGuide } from "@/lib/hudguide";
import { BrowserNav } from "@/lib/tracker";
import { AR } from "@/lib/aruco";
import { DICTIONARY } from "@/lib/board";
import { DEFAULT_DISTURBANCE, DEFAULT_RIG, RUN_TIME, disturb, dockRigAt, markerCodes, toolWorldFromHold, truthAt } from "@/lib/scene";
import { DEFAULT_PHONE_ID, phoneById } from "@/lib/phones";
import { BUILT_IN_PLANS, SHEET_PLAN, addHole, newPlan, removeLastHole, type Plan } from "@/lib/plan";
import { activePlanId, browserMemory, clearJobDraft, readJobDraft, setActivePlanId, writeJobDraft } from "@/lib/memory";
import { draftAction, resumableHoles, versionLine, type HoleRecord } from "@/lib/jobrecord";
import { bindCheck, checkHole, dueManual, recipeOfPlan, simulatorRecipePlan, tallySoFar, tallyText, type Recipe, type Statement, type StepCheck } from "@/lib/recipe";
import { recordingFileName, sizeText } from "@/lib/recording";

type WakeLockSentinelLike = { release: () => Promise<void> };
type VideoFrameMeta = { captureTime?: number; expectedDisplayTime?: number };
type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: VideoFrameMeta) => void) => number; cancelVideoFrameCallback?: (id: number) => void };
type Status = "start" | "starting" | "running" | "paused" | "blocked";
/** A finished hole's Check on screen; words: what the person confirms ("" when the engine answers all of it) */
type CheckCardData = { hole: HoleRecord; check: StepCheck; words: string };

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
  const tracker = useCallback(() => trackerRef.current, []);

  const say = useCallback((t: string) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
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
    simRef.current = new URLSearchParams(window.location.search).get("sim") === "1";
    try {
      const o = { fps60: localStorage.getItem("st-cam-fps60") === "1", lock: localStorage.getItem("st-cam-lock") === "1" };
      camOptsRef.current = o;
      setCamOpts(o);
    } catch {}
    try {
      const v = Number(localStorage.getItem("st-cam-res"));
      if (v === 720 || v === 1080) {
        camResRef.current = v;
        setCamRes(v);
      }
    } catch {}
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => stopCamera, []);

  // the engine (WebAssembly) and the tracker, once
  async function ensureTracker(): Promise<BrowserNav> {
    if (trackerRef.current) return trackerRef.current;
    const tr = await BrowserNav.create();
    tr.onMessage = say;
    tr.onFault = setFault;
    tr.onHoleDone = (h) => showCard(h);
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
      tr.useCalibration(rig.camera, rig.tool, rig.width, rig.height, performance.now() / 1000);
      // ?recipe=1: the sheet's holes from a recipe, recorded (never saved) so the Check cards and the steps show
      if (new URLSearchParams(window.location.search).get("recipe") === "1") {
        const p = simulatorRecipePlan();
        tr.recordInSimulator(p);
        recipeRef.current = recipeOfPlan(p);
        setPlanState(p);
      }
    } else {
      setPhoneName(tr.phone.name);
      setTol(tr.tolDeg);
      const id = activePlanId();
      if (id) {
        const p = (await browserMemory().plan(id).catch(() => undefined)) ?? BUILT_IN_PLANS.find((b) => b.id === id);
        if (p) applyPlan(p, tr, false);
      }
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
      (await ensureTracker()).cameraOpts = { ...camOptsRef.current }; // a job's draft carries the camera options in use
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
      tr.cameraOpts = { ...camOptsRef.current };
      const rec = tr.finishJob();
      if (rec)
        void browserMemory()
          .saveJob(rec)
          .then(() => (clearJobDraft(), say(announce ? `Unfinished job saved · Plan: ${p.name}` : "Unfinished job saved")))
          .catch(() => say("The unfinished job could not be saved"));
    }
    tr.setPlan(p);
    recipeRef.current = recipeOfPlan(p);
    clearCards();
    setPlanState(p);
    setActivePlanId(p.id === SHEET_PLAN.id ? null : p.id);
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
    if (tr) tr.cameraOpts = { ...camOptsRef.current };
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
    const iv = setInterval(() => setDone(trackerRef.current?.recorder?.holes.length ?? 0), 500);
    return () => clearInterval(iv);
  }, []);

  // a recipe step to confirm: decided from the job's data whenever nothing else is open (after the start decision,
  // after each hole, after a sheet closes), so it waits its turn behind every other sheet and is never lost
  useEffect(() => {
    if (status !== "running") return;
    const iv = setInterval(() => {
      const r = recipeRef.current, rec = trackerRef.current?.recorder;
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

    // development only (?sim=1): simulated camera frames of the scripted drilling run
    let simStart = now();
    const codes = markerCodes(new AR.Dictionary(DICTIONARY).codeList);
    const sim = setInterval(() => {
      const tr = trackerRef.current;
      if (!simRef.current || !running() || !tr) return;
      const ts = (now() - simStart) % RUN_TIME;
      if (ts < 0.07) simStart = now() - ts;
      const st = truthAt(ts);
      const rig = dockRigAt(undefined, DEFAULT_RIG, tr.phone);
      tr.simFrame(rig, codes, toolWorldFromHold(tr.core, rig, disturb(st.hold, ts, st.phase, DEFAULT_DISTURBANCE)), now(), 1 + Math.round(ts * 1000));
    }, 1000 / 15);

    const clock = setInterval(() => running() && trackerRef.current?.advance(now()), 4);

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
      // the banner hides under a sheet (setup, menu, job): it would show through it
      drawGuide(ctx, view.state, w, h, { video: source, overlay: view.overlay, toolCalibrated: tr.calibrated.tool, banner: sheetRef.current === null || sheetRef.current === "bench" });
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

      {/* under the banner: the Check card (while working, nothing else open), and the toast below it */}
      {(toast || card) && (
        <div className="pointer-events-none absolute inset-x-0 top-[max(8rem,calc(27vmin+0.5rem),calc(env(safe-area-inset-top)+7rem))] z-40 flex flex-col items-center gap-2 px-4">
          {card && status === "running" && sheet === null && !draft && <CheckCard card={card} onOk={() => setCard(null)} onAnswer={answerCard} />}
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
                <BigButton onClick={fullscreen}>Full screen</BigButton>
                <BigButton onClick={() => (window.location.href = "/memory")}>Plans & jobs</BigButton>
              </div>
              <VersionLine className="mt-4" />
            </TopSheet>
          )}

          {/* the menu button, top right, when nothing else is open */}
          {sheet === null && (
            <button
              onClick={() => setSheet("menu")}
              aria-label="Menu"
              className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-30 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/30 bg-black/60 text-3xl backdrop-blur-md"
            >
              ☰
            </button>
          )}

          {/* the trigger: Pause (big, in the thumb's reach, right side: the tip shows bottom left) and Stop (held) */}
          {sheet === null && !draft && (
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
          {recNote && (
            <div className="pointer-events-none absolute bottom-[calc(max(1rem,env(safe-area-inset-bottom))+6rem)] right-3 z-30 rounded-full bg-[#ff6b6b] px-4 py-1.5 text-lg font-semibold text-black">{recNote}</div>
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

/** Acts only when held (1 s), like a guarded switch: a tap just says so. The ring fills while held. */
function HoldButton({ onHold, onTap, label, aria }: { onHold: () => void; onTap: () => void; label: string; aria: string }) {
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
      className="relative flex h-16 w-16 select-none items-center justify-center overflow-hidden rounded-2xl border border-white/30 bg-black/60 text-2xl text-white/85 backdrop-blur-md"
    >
      <span className="absolute inset-x-0 bottom-0 bg-[#ff6b6b]/70" style={{ height: held ? "100%" : "0%", transition: held ? "height 1s linear" : "none" }} />
      <span className="relative">{label}</span>
    </button>
  );
}
