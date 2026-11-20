import { test } from "node:test";
import assert from "node:assert/strict";
import { PHONES, phoneById, phoneFits, DEFAULT_PHONE_ID } from "../lib/phones.ts";
import { DOCK, checkCalibration, dockRig, tipInView } from "../lib/dockrig.ts";

test("every phone profile fits the dock's rail", () => {
  for (const p of PHONES) assert.deepEqual(phoneFits(p, DOCK.rail), [], p.id);
  assert.match(phoneFits({ ...PHONES[0], length: 190 }, DOCK.rail).join(), /outside 140-175/);
  assert.equal(phoneById("nope").id, DEFAULT_PHONE_ID);
});

test("the reference phone reproduces the dock's exported camera", () => {
  const ref = dockRig();
  const viaProfile = dockRig({ phone: { ...phoneById("redmi-note-13"), camFromTop: DOCK.phone.camFromEnd, camFromLeft: DOCK.phone.camFromEdge } });
  assert.ok(ref.tool.tipCam.every((v, i) => Math.abs(v - viaProfile.tool.tipCam[i]) < 1e-12));
});

test("a phone with its lens further from the end shows the tip off-centre, still in view", () => {
  const a = tipInView(dockRig({ phone: "redmi-note-13" }).tool);
  const b = tipInView(dockRig({ phone: { ...phoneById("redmi-15"), camFromTop: 35 } }).tool);
  assert.ok(Math.abs(a.sideDeg) < 0.01 && b.sideDeg > 4, `side ${a.sideDeg} -> ${b.sideDeg}`);
  assert.ok(b.downDeg < 19.6 - 2);
});

test("the calibration sanity check finds the tilt and flags a wrong profile", () => {
  const measured = dockRig({ phone: "redmi-15", tiltDeg: 12 }).tool;
  const ok = checkCalibration(measured, { phone: "redmi-15" });
  assert.ok(ok.distanceMm < 0.5 && Math.abs(ok.tiltDeg - 12) < 0.6, JSON.stringify(ok));
  // the phone turned the other way round: the lens ends up at the far end, at the top
  const p = phoneById("redmi-15");
  const turned = dockRig({ phone: { ...p, camFromTop: p.length - p.camFromTop, camFromLeft: p.width - p.camFromLeft }, tiltDeg: 12 }).tool;
  assert.ok(checkCalibration(turned, { phone: "redmi-15" }).distanceMm > 15, "phone inserted the wrong way round");
});
