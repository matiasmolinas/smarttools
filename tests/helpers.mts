import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NavCore } from "../lib/engine.ts";

export const core = await NavCore.load(readFileSync(new URL("../public/engine/nav_core.wasm", import.meta.url)));
const require = createRequire(import.meta.url);
export const { AR } = require("js-aruco2");
export const detector = () => new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" });
export const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
export const nearV = (a: number[], b: number[], eps = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
