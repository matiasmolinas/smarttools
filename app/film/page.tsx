import type { Metadata } from "next";
import NavDemo from "@/components/NavDemo";

export const metadata: Metadata = {
  title: "SmartTools · film",
  robots: { index: false, follow: false },
};

// Fixed 1920x1080 frame for video capture (scripts/record-film.mjs). Not linked from the site.
export default function FilmPage() {
  return (
    <div className="flex h-[1080px] w-[1920px] flex-col overflow-hidden bg-[#05080d] px-14 pb-12 pt-10">
      <header className="mb-7 flex items-end justify-between">
        <div>
          <div className="mb-2 flex items-center gap-3 font-mono text-[20px]">
            <span className="inline-block h-4 w-4 rounded-full border-2 border-[var(--green)] shadow-[0_0_12px_var(--green)]" />
            <span className="font-semibold tracking-tight text-white">SmartTools</span>
            <span className="text-white/40">/ smart 3D navigation for everyday power tools</span>
          </div>
          <h1 className="text-[52px] font-semibold leading-none tracking-tight text-white">
            A bicycle for humans in the <span className="text-[var(--green)]">real world</span>.
          </h1>
        </div>
        <div className="text-right font-mono text-[18px] leading-relaxed text-white/45">
          <div>smarttools-nav.vercel.app</div>
          <div>github.com/matiasmolinas/smarttools</div>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <NavDemo film />
      </div>
    </div>
  );
}
