"use client";

// The landing page's main animation: the whole 3D-assembly job on the real engine, looping.

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { HERO } from "@/lib/gallery";

const ScenarioPlayer = dynamic(() => import("./ScenarioPlayer"), { ssr: false, loading: () => <div className="h-[380px] rounded-2xl border border-white/10 sm:h-[560px]" /> });

export default function AssemblyHero() {
  const ref = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    const io = new IntersectionObserver((e) => setPlaying(e[0].isIntersecting));
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref}>
      <ScenarioPlayer scenario={HERO} playing={playing} onEnd={() => {}} variant="hero" />
      <p className="mt-3 font-mono text-[11px] text-white/40">
        A simulation on the real navigation engine: scripted motion, real decisions. Drag to orbit.{" "}
        <a href="#what" className="text-white/60 underline decoration-white/20 hover:text-white">
          What it does ↓
        </a>
      </p>
    </div>
  );
}
