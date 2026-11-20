// The installable app (F1, docs/ARCHITECTURE.md): added to the home screen, it opens straight on the phone
// screen (/hud) and works offline through public/sw.js.

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SmartTools",
    short_name: "SmartTools",
    description: "Your phone on your drill: every hole in its place, every screw square. Works offline.",
    id: "/hud",
    start_url: "/hud",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#05080d",
    theme_color: "#05080d",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Phone screen", url: "/hud" },
      { name: "My plans and jobs", url: "/memory" },
      { name: "Print the sheet", url: "/markers" },
    ],
  };
}
