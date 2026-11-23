// A calibration can never hang (lib/trackerclient.ts): every wait for the worker's answer is settled, by the answer
// or, if the tracker stops first, by an error of the same kind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureWaits, RecordWait, TRACKER_STOPPED, type RecordedFrames } from "../lib/trackerclient.ts";
import type { CaptureResult } from "../lib/markertracker.ts";

test("the worker's answer settles its own wait, once", () => {
  const w = new CaptureWaits();
  const got: CaptureResult[] = [];
  w.add(1, "pivot", (r) => got.push(r));
  w.add(2, "roll", (r) => got.push(r));
  const r: CaptureResult = { kind: "pivot", error: "too few frames" };
  assert.equal(w.settle(1, r), true);
  assert.equal(w.settle(1, r), false); // already settled
  assert.equal(w.settle(9, r), false); // never asked
  assert.deepEqual(got, [r]);
  assert.equal(w.size, 1);
});

test("when the tracker stops, every pending wait gets an error of its own kind", () => {
  const w = new CaptureWaits();
  const got: CaptureResult[] = [];
  w.add(1, "camera", (r) => got.push(r));
  w.add(2, "roll", (r) => got.push(r));
  assert.equal(w.failAll(TRACKER_STOPPED), 2);
  assert.deepEqual(got, [
    { kind: "camera", error: TRACKER_STOPPED },
    { kind: "roll", error: TRACKER_STOPPED },
  ]);
  assert.equal(w.size, 0);
  assert.equal(w.failAll(TRACKER_STOPPED), 0); // nothing left to settle twice
  assert.equal(w.settle(1, { kind: "camera", error: "late" }), false); // a late answer is ignored
  assert.equal(got.length, 2);
});

test("a wait settled by the stop resolves its promise, so the caller's finally runs", async () => {
  const w = new CaptureWaits();
  let done = false;
  const p = new Promise<CaptureResult>((res) => w.add(1, "pivot", res)).finally(() => (done = true));
  w.failAll(TRACKER_STOPPED);
  assert.deepEqual(await p, { kind: "pivot", error: TRACKER_STOPPED });
  assert.equal(done, true);
});

// A recording always settles too: with its frames, or null when it is cancelled or the tracker stops.
const frames = (n: number): RecordedFrames => ({ times: Array.from({ length: n }, (_, i) => i / 30), frames: [], width: 540, height: 960 });

test("a recording resolves with its own frames; a late or unknown answer is ignored", () => {
  const w = new RecordWait();
  const got: (RecordedFrames | null)[] = [];
  w.start(4, (r) => got.push(r));
  assert.equal(w.pending, true);
  assert.equal(w.done(3, frames(1)), false); // an older recording's answer
  assert.equal(w.done(4, frames(2)), true);
  assert.equal(w.done(4, frames(2)), false); // already settled
  assert.equal(w.pending, false);
  assert.deepEqual(got, [frames(2)]);
});

test("a cancelled recording resolves null, once; a newer one settles the old with null", async () => {
  const w = new RecordWait();
  const got: (RecordedFrames | null)[] = [];
  w.start(1, (r) => got.push(r));
  w.start(2, (r) => got.push(r)); // replaces the first
  assert.deepEqual(got, [null]);
  assert.equal(w.cancel(), true);
  assert.equal(w.cancel(), false); // nothing left
  assert.equal(w.done(2, frames(1)), false); // the worker's late answer
  assert.deepEqual(got, [null, null]);
  let done = false;
  const p = new Promise<RecordedFrames | null>((res) => w.start(3, res)).finally(() => (done = true));
  w.cancel();
  assert.equal(await p, null);
  assert.equal(done, true);
});
