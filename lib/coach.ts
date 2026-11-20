// Learning from an expert: the expert's run is recorded (tool poses over time, from the engine), and
// replayed as a ghost tool for a learner to follow, like a racing game's ghost car. Each screw gets a
// score from what the engine measured: how square, how centred, how steady, and how long it took.
// Pure functions (tested); the gallery draws the ghost and the scores.

export interface ScrewSample {
  t: number;
  phase: string;
  angleDeg: number;
  offsetMm: number;
  depthMm: number;
}
export interface ScrewScore {
  /** 0-100 */
  score: number;
  /** while driving */
  maxAngleDeg: number;
  /** where the tip was when driving started */
  startOffsetMm: number;
  /** from first "align" to seated, s */
  timeS: number;
  /** angle wobble while driving (std, deg) */
  wobbleDeg: number;
}

/** Score one screw from the engine's samples of it (approach to seated). */
export function scoreScrew(samples: ScrewSample[]): ScrewScore | null {
  const drive = samples.filter((s) => (s.phase === "drill" || s.phase === "hold") && s.depthMm > 0.5);
  if (!drive.length) return null;
  const firstAlign = samples.find((s) => s.phase === "align") ?? samples[0];
  const seated = samples.find((s) => s.phase === "hold") ?? drive[drive.length - 1];
  const maxAngleDeg = Math.max(...drive.map((s) => s.angleDeg));
  const startOffsetMm = drive[0].offsetMm;
  const mean = drive.reduce((a, s) => a + s.angleDeg, 0) / drive.length;
  const wobbleDeg = Math.sqrt(drive.reduce((a, s) => a + (s.angleDeg - mean) ** 2, 0) / drive.length);
  const timeS = Math.max(0, seated.t - firstAlign.t);
  // each part costs points past a "good" value; 100 = expert-like
  const over = (x: number, good: number, bad: number) => Math.min(1, Math.max(0, (x - good) / (bad - good)));
  const penalty = 40 * over(maxAngleDeg, 0.2, 1.0) + 25 * over(startOffsetMm, 0.2, 1.0) + 15 * over(wobbleDeg, 0.03, 0.3) + 20 * over(timeS, 3, 10);
  return { score: Math.round(100 - penalty), maxAngleDeg, startOffsetMm, timeS, wobbleDeg };
}

/** Collects samples per screw from engine snapshots (by the active target's name). */
export class ScrewRecorder {
  readonly samples = new Map<string, ScrewSample[]>();
  add(name: string | null, s: ScrewSample) {
    if (!name) return;
    const l = this.samples.get(name) ?? [];
    l.push(s);
    this.samples.set(name, l);
  }
  score(name: string) {
    return scoreScrew(this.samples.get(name) ?? []);
  }
}
