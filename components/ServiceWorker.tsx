"use client";

// Registers public/sw.js (offline app, docs/ARCHITECTURE.md F1). Production only: in development it would cache
// pages that are being edited.

import { useEffect } from "react";

export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  return null;
}
