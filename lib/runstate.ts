// Working, paused, stopped: the phone app runs like the drill's trigger (/hud).
//
//   working   camera on, tracking at 30 fps, engine at 120 Hz, screen kept awake
//   paused    camera off, nothing runs, the screen may sleep. The mount is assumed unchanged: the calibration,
//             the plan and the job in progress are kept, and Continue goes straight back to work.
//   stopped   everything off, the job saved or dropped. Something may have changed (the bit, the tip, the phone
//             taken out of the dock), so the next start asks what changed and redoes only what that affects.
//
// The three calibrations depend on different things, so a change never means "calibrate everything":
//   lens   the phone's own camera: once per phone model
//   drill  where the tip is and which way the bit points, from the phone: the bit and the phone's seat in the dock
//   check  the tip on A2, 5 s: confirms the drill calibration still holds

export type RunState = "working" | "paused" | "stopped";
export interface RunRecord {
  state: RunState;
  /** ISO time it entered that state */
  at: string;
}

/** After this long in a pause, Continue suggests the 5 s check (it does not force it). */
export const SUGGEST_CHECK_MIN = 30;
/** No marker seen for this long while working: the drill was put down, pause to save the battery. */
export const AUTO_PAUSE_NO_MARKERS_S = 60;

/** What a fresh start (the app opened, the camera turned on) does with the drill calibration. */
export function onStart(last: RunRecord | null, toolCalibrated: boolean): "setup" | "ask" | "resume" {
  if (!toolCalibrated) return "setup";
  // a pause (or the page closed while working, e.g. the phone locked) keeps the mount: no question
  if (last && (last.state === "paused" || last.state === "working")) return "resume";
  // stopped, or nothing known (a first run, an older version): the calibration may be stale, ask
  return "ask";
}

export function pausedFor(last: RunRecord | null, nowMs: number): { minutes: number; suggestCheck: boolean } {
  if (!last || last.state === "stopped") return { minutes: 0, suggestCheck: false };
  const minutes = Math.max(0, (nowMs - Date.parse(last.at)) / 60000);
  return { minutes, suggestCheck: minutes >= SUGGEST_CHECK_MIN };
}

export type Change = "nothing" | "bit" | "phone-moved" | "other-phone";

export const CHANGES: { id: Change; label: string; note: string }[] = [
  { id: "nothing", label: "Nothing", note: "Tip on A2 for 5 s to check" },
  { id: "bit", label: "The bit or the tip", note: "Calibrate the drill again · 10 s" },
  { id: "phone-moved", label: "I took the phone out", note: "Calibrate the drill again · 10 s" },
  { id: "other-phone", label: "Another phone", note: "Choose it, then lens and drill · 1-2 min" },
];

/** What an answer to "What did you change?" redoes: the setup step to open, and whether the stored drill
 * calibration must be dropped first (so a stale one can never guide a hole). */
export function planFor(c: Change): { forgetDrill: boolean; step: "check" | "tip" | "sheet" } {
  if (c === "nothing") return { forgetDrill: false, step: "check" };
  if (c === "other-phone") return { forgetDrill: false, step: "sheet" }; // another phone has its own calibrations
  return { forgetDrill: true, step: "tip" };
}

/** Why to pause by itself now, or null. busy: a calibration, the setup, planning or a sheet is open. */
export function autoPauseReason(o: { hidden: boolean; noMarkersS: number; busy: boolean }): string | null {
  if (o.hidden) return "Paused: the app went to the background";
  if (!o.busy && o.noMarkersS >= AUTO_PAUSE_NO_MARKERS_S) return "Paused: no markers for a minute";
  return null;
}

/** "3 min", "2 h", "5 days" */
export function ago(fromIso: string | null, nowMs: number): string | null {
  if (!fromIso) return null;
  const m = Math.max(0, (nowMs - Date.parse(fromIso)) / 60000);
  if (!Number.isFinite(m)) return null;
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

// ---------------- kept per device ----------------

const KEY = "st-run";
export function readRun(): RunRecord | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? "null") as RunRecord | null;
    return r && ["working", "paused", "stopped"].includes(r.state) && !Number.isNaN(Date.parse(r.at)) ? r : null;
  } catch {
    return null;
  }
}
export function writeRun(state: RunState, at = new Date().toISOString()): RunRecord {
  const r = { state, at };
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {}
  return r;
}

// ---------------- a failed start ----------------

export type StartStage = "camera" | "engine";

/** Why Start failed, in words for the start screen. stage: the camera (getUserMedia) or the engine (the tracker). */
export function explainStartError(stage: StartStage, err: unknown): { title: string; text: string } {
  const name = typeof err === "object" && err !== null && typeof (err as { name?: unknown }).name === "string" ? (err as { name: string }).name : "";
  const raw = err instanceof Error || (typeof err === "object" && err !== null && "message" in err) ? String((err as { message?: unknown }).message ?? "") : err == null ? "" : String(err);
  const message = raw.trim();
  if (stage === "engine") {
    return { title: "The engine did not load", text: `${message ? `${message}${/[.!?]$/.test(message) ? "" : "."} ` : ""}Check the connection, then close the app and open it again.` };
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return { title: "The camera is blocked", text: "Allow the camera for this site in the browser's settings, then try again." };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return { title: "No usable camera", text: "This phone has no back camera the app can use." };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return { title: "The camera is in use", text: "Another app is using the camera. Close it and try again." };
  }
  return { title: "The camera did not start", text: message || "Try again." };
}
