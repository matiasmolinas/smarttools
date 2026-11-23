// Camera recordings (.strec): what the phone writes is what the laptop reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRecording, encodeRecording, recordingFileName, sizeText, type RecordingHeader } from "../lib/recording.ts";
import { DEFAULT_RIG } from "../lib/scene.ts";

test("a recording round-trips: header and every frame, byte for byte", async () => {
  const header: RecordingHeader = {
    kind: "smarttools-recording",
    v: 1,
    created: "2026-11-22T00:00:00.000Z",
    phone: { id: "iphone-15", name: "iPhone 15" },
    width: 540,
    height: 960,
    video: { w: 1080, h: 1920 },
    camera: DEFAULT_RIG.camera,
    cameraCalibrated: true,
    tool: DEFAULT_RIG.tool,
    toolCalibrated: true,
    detector: "rust",
    notes: "provisional mount",
    times: [0.1, 0.133, 0.166],
  };
  const frames = [new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array(1000).fill(7)].map((a) => a.buffer as ArrayBuffer);
  const blob = encodeRecording(header, frames);
  const back = decodeRecording(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(back.header, header);
  assert.equal(back.frames.length, 3);
  assert.deepEqual([...back.frames[0]], [1, 2, 3]);
  assert.equal(back.frames[1].length, 0);
  assert.equal(back.frames[2].length, 1000);
  assert.throws(() => decodeRecording(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a SmartTools recording/);
});

test("a recording's file name sorts by time, and its size reads in MB", () => {
  assert.equal(recordingFileName(new Date("2026-11-23T14:05:59.000Z")), "smarttools-2026-11-23-14-05.strec");
  assert.equal(sizeText(12_345_678), "12.3 MB");
  assert.equal(sizeText(0), "0.0 MB");
});
