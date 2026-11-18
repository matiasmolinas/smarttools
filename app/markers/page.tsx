import type { Metadata } from "next";
import { AR } from "@/lib/aruco";
import { BOARD_MARKERS, BOARD_TARGETS, DICTIONARY, MARKER_SIZE, SHEET } from "@/lib/board";
import PrintButton from "./PrintButton";

export const metadata: Metadata = {
  title: "SmartTools markers: printable A4 sheet",
  description: "Print at 100%, tape it flat, and the phone on the drill tracks its pose optically.",
};

const mm = (m: number) => +(m * 1000).toFixed(3);
const sx = (x: number) => mm(x + SHEET.w / 2);
const sy = (y: number) => mm(SHEET.h / 2 - y);

function Sheet() {
  const dict = new AR.Dictionary(DICTIONARY);
  const cell = mm(MARKER_SIZE) / 8;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="210mm"
      height="297mm"
      viewBox={`0 0 ${mm(SHEET.w)} ${mm(SHEET.h)}`}
      className="sheet block bg-white"
    >
      <rect width={mm(SHEET.w)} height={mm(SHEET.h)} fill="#fff" />
      {BOARD_MARKERS.map((m) => {
        const x0 = sx(m.x) - mm(MARKER_SIZE) / 2;
        const y0 = sy(m.y) - mm(MARKER_SIZE) / 2;
        const code = dict.codeList[m.id];
        return (
          <g key={m.id}>
            <rect x={x0} y={y0} width={mm(MARKER_SIZE)} height={mm(MARKER_SIZE)} fill="#000" />
            {Array.from({ length: 36 }, (_, i) =>
              code[i] === "1" ? (
                <rect key={i} x={x0 + cell * (1 + (i % 6))} y={y0 + cell * (1 + Math.floor(i / 6))} width={cell} height={cell} fill="#fff" />
              ) : null,
            )}
            <text x={x0} y={y0 + mm(MARKER_SIZE) + 4} fontSize="2.6" fontFamily="monospace" fill="#888">
              id {m.id}
            </text>
          </g>
        );
      })}
      {BOARD_TARGETS.map((t) => (
        <g key={t.label} stroke="#111" strokeWidth="0.3" fill="none">
          <circle cx={sx(t.x)} cy={sy(t.y)} r="4" />
          <line x1={sx(t.x) - 9} y1={sy(t.y)} x2={sx(t.x) + 9} y2={sy(t.y)} />
          <line x1={sx(t.x)} y1={sy(t.y) - 9} x2={sx(t.x)} y2={sy(t.y) + 9} />
          <text x={sx(t.x) + 6} y={sy(t.y) - 5} fontSize="4" fontFamily="sans-serif" fill="#111" stroke="none">
            {t.label}
          </text>
        </g>
      ))}
      {/* 50 mm scale check */}
      <g stroke="#111" strokeWidth="0.3">
        <line x1="80" y1="288" x2="130" y2="288" />
        <line x1="80" y1="285.5" x2="80" y2="290.5" />
        <line x1="130" y1="285.5" x2="130" y2="290.5" />
      </g>
      <text x="105" y="284" fontSize="3" fontFamily="monospace" textAnchor="middle" fill="#111">
        50 mm — measure to check the print scale
      </text>
      <text x="105" y="8" fontSize="3.2" fontFamily="monospace" textAnchor="middle" fill="#666">
        SmartTools · {DICTIONARY} · markers {MARKER_SIZE * 1000} mm · print at 100%
      </text>
    </svg>
  );
}

export default function MarkersPage() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6 lg:flex-row">
      <style>{`@media print { @page { size: A4; margin: 0 } body { background: #fff !important } .no-print { display: none !important } main { padding: 0 !important; max-width: none !important; display: block !important } .sheet-wrap { box-shadow: none !important; border: 0 !important; width: 210mm !important } .sheet { width: 210mm !important; height: 297mm !important } }`}</style>
      <section className="no-print flex max-w-sm flex-col gap-5">
        <a href="/hud" className="font-mono text-xs text-white/50 hover:text-white">
          ← HUD
        </a>
        <h1 className="text-3xl font-semibold tracking-tight">Marker sheet</h1>
        <p className="text-white/65">
          The phone on the drill finds these printed markers and computes its own position and angle relative to the
          sheet. 100% optical, no other sensors.
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-white/70">
          <li>Print on A4 at <b>100% / actual size</b> (no “fit to page”).</li>
          <li>Measure the 50 mm line at the bottom. If it is not 50 mm, print again.</li>
          <li>Tape the sheet flat on the wall or board. The crosshairs A1–A3 are where the holes go.</li>
          <li>
            Open <a className="underline" href="/hud">/hud</a> on the phone, tap <b>View</b> until <b>Cam</b>, and
            point at the sheet.
          </li>
          <li>
            With the phone in the dock, rest the bit tip on <b>A2</b> and tap <b>Calibrate</b> once.
          </li>
        </ol>
        <PrintButton />
        <p className="font-mono text-[11px] text-white/40">
          Dictionary {DICTIONARY} · {BOARD_MARKERS.length} markers · {MARKER_SIZE * 1000} mm
        </p>
      </section>
      <div className="sheet-wrap w-full max-w-[520px] shrink-0 overflow-hidden rounded-md border border-white/10 shadow-2xl [&_.sheet]:h-auto [&_.sheet]:w-full">
        <Sheet />
      </div>
    </main>
  );
}
