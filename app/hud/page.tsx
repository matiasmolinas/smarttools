import type { Metadata, Viewport } from "next";
import HudScreen from "@/components/HudScreen";

export const metadata: Metadata = {
  title: "SmartTools HUD: drill navigation screen",
  description: "The 2D navigation screen shown on the phone mounted behind the drill.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  viewportFit: "cover",
};

export default function HudPage() {
  return <HudScreen />;
}
