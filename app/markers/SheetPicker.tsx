"use client";

import { Children, useEffect, useState } from "react";

/** Which sheets to show and print: one of them, or all. `?sheet=2` opens on sheet 2 (read in the browser). */
export default function SheetPicker({ count, children }: { count: number; children: React.ReactNode }) {
  const sheets = Children.toArray(children);
  const [shown, setShown] = useState<number | "all">(0);
  useEffect(() => {
    const n = Number(new URLSearchParams(window.location.search).get("sheet"));
    if (Number.isInteger(n) && n >= 1 && n <= count) setShown(n - 1);
  }, [count]);
  const pick = (v: number | "all") => {
    setShown(v);
    const u = new URL(window.location.href);
    if (v === "all" || v === 0) u.searchParams.delete("sheet");
    else u.searchParams.set("sheet", String(v + 1));
    window.history.replaceState(null, "", u);
  };
  const tab = (v: number | "all", label: string) => (
    <button
      key={label}
      onClick={() => pick(v)}
      aria-pressed={shown === v}
      className={`rounded-full border px-4 py-1.5 font-mono text-sm ${shown === v ? "border-white bg-white text-black" : "border-white/30 bg-white/10 text-white hover:bg-white/20"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="sheets flex w-full max-w-[520px] shrink-0 flex-col gap-4">
      <div className="no-print flex flex-wrap gap-2" role="group" aria-label="Sheet to show and print">
        {Array.from({ length: count }, (_, k) => tab(k, `Sheet ${k + 1}`))}
        {tab("all", `All ${count}`)}
      </div>
      {sheets.map((s, k) =>
        shown === "all" || shown === k ? (
          <div key={k} className="sheet-wrap w-full overflow-hidden rounded-md border border-white/10 shadow-2xl [&_.sheet]:h-auto [&_.sheet]:w-full">
            {s}
          </div>
        ) : null,
      )}
    </div>
  );
}
