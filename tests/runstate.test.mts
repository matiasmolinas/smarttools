// Working, paused, stopped (lib/runstate.ts): a pause keeps the calibration, a stop asks what changed and redoes
// only what that affects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_PAUSE_NO_MARKERS_S, CHANGES, ago, autoPauseReason, onStart, pausedFor, planFor } from "../lib/runstate.ts";

const T = Date.UTC(2026, 10, 23, 15);
const at = (minAgo: number) => new Date(T - minAgo * 60000).toISOString();

test("a fresh start: setup when not calibrated, straight back after a pause, a question after a stop", () => {
  assert.equal(onStart(null, false), "setup");
  assert.equal(onStart({ state: "paused", at: at(5) }, false), "setup");
  assert.equal(onStart({ state: "paused", at: at(5) }, true), "resume");
  assert.equal(onStart({ state: "working", at: at(5) }, true), "resume"); // the page closed while working
  assert.equal(onStart({ state: "stopped", at: at(5) }, true), "ask");
  assert.equal(onStart(null, true), "ask"); // nothing known: a stored calibration may be stale
});

test("a long pause suggests the 5 s check; a short one does not", () => {
  assert.deepEqual(pausedFor({ state: "paused", at: at(10) }, T), { minutes: 10, suggestCheck: false });
  assert.equal(pausedFor({ state: "paused", at: at(45) }, T).suggestCheck, true);
  assert.equal(pausedFor({ state: "stopped", at: at(45) }, T).suggestCheck, false);
});

test("each answer redoes only what it affects, and a changed bit never keeps the old calibration", () => {
  assert.deepEqual(planFor("nothing"), { forgetDrill: false, step: "check" });
  assert.deepEqual(planFor("bit"), { forgetDrill: true, step: "tip" });
  assert.deepEqual(planFor("phone-moved"), { forgetDrill: true, step: "tip" });
  assert.deepEqual(planFor("other-phone"), { forgetDrill: false, step: "sheet" });
  assert.deepEqual(CHANGES.map((c) => c.id), ["nothing", "bit", "phone-moved", "other-phone"]);
});

test("it pauses by itself in the background or after a minute without markers, never mid-calibration", () => {
  assert.match(autoPauseReason({ hidden: true, noMarkersS: 0, busy: true })!, /background/);
  assert.equal(autoPauseReason({ hidden: false, noMarkersS: AUTO_PAUSE_NO_MARKERS_S - 1, busy: false }), null);
  assert.match(autoPauseReason({ hidden: false, noMarkersS: AUTO_PAUSE_NO_MARKERS_S, busy: false })!, /no markers/);
  assert.equal(autoPauseReason({ hidden: false, noMarkersS: 600, busy: true }), null);
});

test("calibration age in words", () => {
  assert.equal(ago(null, T), null);
  assert.equal(ago(at(0.2), T), "just now");
  assert.equal(ago(at(12), T), "12 min ago");
  assert.equal(ago(at(150), T), "3 h ago");
  assert.equal(ago(at(3 * 1440), T), "3 days ago");
});
