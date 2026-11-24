// The build on screen (lib/jobrecord.ts): app version, commit and engine ABI in one line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_VERSION, versionLine } from "../lib/jobrecord.ts";
import { ENGINE_ABI } from "../lib/engine.ts";

test("the version line names the app, the build and the engine ABI", () => {
  assert.equal(versionLine("abc1234", 6, "0.0.13"), "SmartTools 0.0.13 · build abc1234 · engine ABI 6");
});

test("no build reads dev", () => {
  assert.equal(versionLine(undefined, 6, "0.0.13"), "SmartTools 0.0.13 · build dev · engine ABI 6");
  assert.equal(versionLine("  ", 6, "0.0.13"), "SmartTools 0.0.13 · build dev · engine ABI 6");
});

test("the defaults are the current app version and engine ABI", () => {
  assert.equal(APP_VERSION, "0.0.15");
  assert.equal(versionLine("x"), `SmartTools ${APP_VERSION} · build x · engine ABI ${ENGINE_ABI}`);
});
