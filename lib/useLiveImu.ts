"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveTilt } from "./sim";

// Direction of the phone's rear-camera axis in the world frame, from W3C deviceorientation (Z-X'-Y'').
// Using the axis (not raw beta/gamma) keeps it stable with the phone upright, as when docked behind a drill.
function cameraAxis(alpha: number, beta: number, gamma: number) {
  const d = Math.PI / 180;
  const cA = Math.cos(alpha * d), sA = Math.sin(alpha * d);
  const cB = Math.cos(beta * d), sB = Math.sin(beta * d);
  const cG = Math.cos(gamma * d), sG = Math.sin(gamma * d);
  // device +z in world; the rear camera looks along -z
  const x = cA * sG + sA * sB * cG;
  const y = sA * sG - cA * sB * cG;
  const z = cB * cG;
  return { x: -x, y: -y, z: -z };
}

const wrap = (a: number) => ((a + 540) % 360) - 180;

export function useLiveImu() {
  const tiltRef = useRef<LiveTilt | null>(null);
  const zeroRef = useRef<{ heading: number; elev: number } | null>(null);
  const [live, setLive] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!live) {
      tiltRef.current = null;
      return;
    }
    zeroRef.current = null;
    const onOri = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      const a = cameraAxis(e.alpha, e.beta, e.gamma);
      const heading = (Math.atan2(a.x, a.y) * 180) / Math.PI;
      const elev = (Math.asin(Math.max(-1, Math.min(1, a.z))) * 180) / Math.PI;
      if (!zeroRef.current) zeroRef.current = { heading, elev };
      tiltRef.current = {
        yaw: Math.max(-20, Math.min(20, wrap(heading - zeroRef.current.heading))),
        pitch: Math.max(-20, Math.min(20, elev - zeroRef.current.elev)),
      };
    };
    window.addEventListener("deviceorientation", onOri);
    return () => window.removeEventListener("deviceorientation", onOri);
  }, [live]);

  const rezero = useCallback(() => {
    zeroRef.current = null;
  }, []);

  const toggle = useCallback(async () => {
    if (live) {
      setLive(false);
      setMsg(null);
      return;
    }
    const DOE = (typeof window !== "undefined" ? window.DeviceOrientationEvent : undefined) as
      | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> })
      | undefined;
    if (!DOE) {
      setMsg("No orientation sensor here. Open this page on a phone.");
      return;
    }
    try {
      if (typeof DOE.requestPermission === "function") {
        const r = await DOE.requestPermission();
        if (r !== "granted") {
          setMsg("Motion permission denied.");
          return;
        }
      }
      setLive(true);
      setMsg("Point the rear camera at the wall and hold still: that pose is 90°. Tilt to move the chuck ring.");
    } catch {
      setMsg("Could not access motion sensors.");
    }
  }, [live]);

  return { live, msg, toggle, rezero, tiltRef };
}
