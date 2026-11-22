// Camera recordings (.strec): the frames the tracker analysed on the phone (JPEG, at the detection size) with
// their capture times, and everything needed to analyse them again on a laptop (camera model, tool
// calibration, phone, settings). Real data to compare detectors and filters without repeating a test.
//
//   "STREC1\n" · u32 header length · header JSON (UTF-8) · per frame: u32 length · JPEG bytes
//
// Replay: node scripts/replay.mts <file.strec> [--detector js|rust|both]

import type { Camera, ToolCalib } from "./engine.ts";

export const MAGIC = "STREC1\n";

export interface RecordingHeader {
  kind: "smarttools-recording";
  v: 1;
  created: string;
  phone: { id: string; name: string };
  /** the detection image size (what the frames are) */
  width: number;
  height: number;
  /** the camera's own size (px), before scaling to the detection size */
  video: { w: number; h: number };
  camera: Camera;
  cameraCalibrated: boolean;
  tool: ToolCalib;
  toolCalibrated: boolean;
  detector: string;
  notes: string;
  /** capture time of each frame, s */
  times: number[];
}

export function encodeRecording(h: RecordingHeader, frames: ArrayBuffer[]): Blob {
  const head = new TextEncoder().encode(JSON.stringify(h));
  const parts: BlobPart[] = [new TextEncoder().encode(MAGIC), u32(head.length), head];
  for (const f of frames) parts.push(u32(f.byteLength), new Uint8Array(f));
  return new Blob(parts, { type: "application/octet-stream" });
}

export function decodeRecording(buf: Uint8Array): { header: RecordingHeader; frames: Uint8Array[] } {
  const magic = new TextDecoder().decode(buf.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error("not a SmartTools recording (.strec)");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = MAGIC.length;
  const hl = dv.getUint32(o, true);
  o += 4;
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(o, o + hl))) as RecordingHeader;
  o += hl;
  const frames: Uint8Array[] = [];
  while (o + 4 <= buf.length) {
    const n = dv.getUint32(o, true);
    o += 4;
    frames.push(buf.subarray(o, o + n));
    o += n;
  }
  return { header, frames };
}

function u32(n: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
