// js-aruco2 is legacy CommonJS that assigns `this.AR`; resolve it whichever way the bundler wraps it.
import * as aruco from "js-aruco2";

type ArNs = typeof import("js-aruco2").AR;
const mod = aruco as unknown as { AR?: ArNs; default?: { AR?: ArNs } };
export const AR: ArNs = (mod.AR ?? mod.default?.AR)!;
