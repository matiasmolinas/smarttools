import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // the commit shown on screen (Vercel sets the SHA; a local build says "dev")
  env: { NEXT_PUBLIC_BUILD: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || "dev" },
  // the service worker (public/sw.js) must never be cached by the browser, or updates would not reach phones
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
