import type { Metadata } from "next";
import EngineLab from "@/components/EngineLab";

export const metadata: Metadata = {
  title: "SmartTools engine lab",
  description: "The navigation engine (Rust/WASM, 120 Hz) on simulated camera frames, drawn in 3D, as a 2D plan and as the phone HUD.",
};

export default function EnginePage() {
  return <EngineLab />;
}
