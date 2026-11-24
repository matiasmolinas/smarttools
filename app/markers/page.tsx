import type { Metadata } from "next";
import { AR } from "@/lib/aruco";
import { BOARD_MARKERS, BOARD_TARGETS, DICTIONARY, MARKERS_PER_SHEET, MARKER_SIZE, SHEET, SHEETS } from "@/lib/board";
import PrintButton from "./PrintButton";
import SheetPicker from "./SheetPicker";
import SiteNav from "@/components/site/SiteNav";

export const metadata: Metadata = {
  title: "SmartTools markers: printable A4 sheets",
  description: "Print at 100%, tape them flat, and the phone on the drill tracks its pose optically.",
};

const mm = (m: number) => +(m * 1000).toFixed(3);
const sx = (x: number) => mm(x + SHEET.w / 2);
const sy = (y: number) => mm(SHEET.h / 2 - y);

/** Sheet k (0..SHEETS-1, printed as k + 1): the same drawing for every sheet, with its own marker ids
 * (MARKERS_PER_SHEET * k + 0..27). Sheet 1 is the world frame and carries the crosshairs A1-A3 (the tool is
 * calibrated on A2); sheets 2-4 carry their number, large, in the right margin instead. */
function Sheet({ k }: { k: number }) {
  const dict = new AR.Dictionary(DICTIONARY);
  const cell = mm(MARKER_SIZE) / 8;
  const first = MARKERS_PER_SHEET * k;
  // the right margin: from the markers' edge plus a quiet zone of two cells, to the paper's edge minus 4 mm
  const marginX0 = sx(Math.max(...BOARD_MARKERS.map((m) => m.x)) + MARKER_SIZE / 2) + cell * 2;
  const marginX1 = mm(SHEET.w) - 4;
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
        const code = dict.codeList[m.id + first];
        return (
          <g key={m.id}>
            <rect x={x0} y={y0} width={mm(MARKER_SIZE)} height={mm(MARKER_SIZE)} fill="#000" />
            {Array.from({ length: 36 }, (_, i) =>
              code[i] === "1" ? (
                <rect key={i} x={x0 + cell * (1 + (i % 6))} y={y0 + cell * (1 + Math.floor(i / 6))} width={cell} height={cell} fill="#fff" />
              ) : null,
            )}
          </g>
        );
      })}
      {k === 0 && BOARD_TARGETS.map((t) => (
        <g key={t.label} stroke="#111" strokeWidth="0.3" fill="none">
          <circle cx={sx(t.x)} cy={sy(t.y)} r="3" />
          <line x1={sx(t.x) - 5.5} y1={sy(t.y)} x2={sx(t.x) + 5.5} y2={sy(t.y)} />
          <line x1={sx(t.x)} y1={sy(t.y) - 5.5} x2={sx(t.x)} y2={sy(t.y) + 5.5} />
          <text x={sx(t.x) + 3.2} y={sy(t.y) - 3.2} fontSize="2.6" fontFamily="sans-serif" fill="#111" stroke="none">
            {t.label}
          </text>
        </g>
      ))}
      {/* 50 mm scale check, in the left margin, clear of the markers' quiet zones */}
      <g stroke="#111" strokeWidth="0.3">
        <line x1="14" y1="123.5" x2="14" y2="173.5" />
        <line x1="11.5" y1="123.5" x2="16.5" y2="123.5" />
        <line x1="11.5" y1="173.5" x2="16.5" y2="173.5" />
      </g>
      <text x="0" y="0" fontSize="3" fontFamily="monospace" textAnchor="middle" fill="#111" transform="translate(9 148.5) rotate(-90)">
        50 mm: measure to check the print scale
      </text>
      {k > 0 && (
        <g fontFamily="sans-serif" textAnchor="middle" fill="#222">
          <text x={(marginX0 + marginX1) / 2} y="133" fontSize="4.5">
            SHEET
          </text>
          <text x={(marginX0 + marginX1) / 2} y="160" fontSize="26" fontWeight="700">
            {k + 1}
          </text>
        </g>
      )}
      <text x="105" y="8" fontSize="3.2" fontFamily="monospace" textAnchor="middle" fill="#666">
        SmartTools sheet v2{k > 0 ? ` · sheet ${k + 1} of ${SHEETS} (ids ${first}-${first + MARKERS_PER_SHEET - 1})` : ""} · {DICTIONARY} · {BOARD_MARKERS.length} markers of {MARKER_SIZE * 1000} mm · print at 100%
      </text>
    </svg>
  );
}

export default function MarkersPage() {
  return (
    <>
    <div className="no-print mx-auto w-full max-w-5xl px-4 sm:px-6">
      <SiteNav compact />
    </div>
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6 sm:px-6 lg:flex-row">
      <style>{`@media print { @page { size: A4; margin: 0 } body { background: #fff !important } .no-print { display: none !important } main { padding: 0 !important; max-width: none !important; display: block !important } .sheets { display: block !important; max-width: none !important } .sheet-wrap { box-shadow: none !important; border: 0 !important; border-radius: 0 !important; width: 210mm !important; max-width: none !important; break-after: page } .sheet-wrap:last-child { break-after: auto } .sheet { width: 210mm !important; height: 297mm !important } }`}</style>
      <section className="no-print flex max-w-sm flex-col gap-5">
        <h1 className="text-3xl font-semibold tracking-tight">Marker sheets</h1>
        <p className="text-white/65">
          The phone on the drill finds these printed markers and computes its own position and angle relative to the
          sheet. 100% optical, no other sensors.
        </p>
        <p className="text-sm text-white/65">
          Sheet 1 is the one the phone measures from. For a larger work area, print sheets 2 to 4 too (each has its own
          markers and its number in the margin) and tape them flat next to sheet 1: the phone maps them when it looks
          at them.
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-white/70">
          <li>Print on A4 at <b>100% / actual size</b> (no “fit to page”).</li>
          <li>Measure the 50 mm line in the left margin. If it is not 50 mm, print again.</li>
          <li>Tape the sheet flat on the wall or board. The crosshairs A1–A3 (on sheet 1) are where the holes go.</li>
          <li>
            Open <a className="underline" href="/hud">/hud</a> on the phone, tap <b>Start</b> and point at the sheet.
          </li>
          <li>
            The <b>Setup</b> guides you, one step at a time: the lens (once per phone), then the tip on <b>A2</b>
            (circle the drill around it, then twist it around the bit). It opens by itself the first time.
          </li>
        </ol>
        <PrintButton label="Print the sheets shown" />
        <p className="font-mono text-[11px] text-white/40">
          Sheet v2 · dictionary {DICTIONARY} · {BOARD_MARKERS.length} markers · {MARKER_SIZE * 1000} mm. Dense grid: the
          docked camera only sees a strip about 22 × 12 cm above the bit tip, so several markers stay in view on every
          mark. Sheets 2 to 4 use ids {MARKERS_PER_SHEET} to {MARKERS_PER_SHEET * SHEETS - 1}; the demo part&apos;s stickers use
          ids 40 to 65, so do not use sheets 2 and 3 with them.
        </p>
      </section>
      <SheetPicker count={SHEETS}>
        {Array.from({ length: SHEETS }, (_, k) => (
          <Sheet key={k} k={k} />
        ))}
      </SheetPicker>
    </main>
    </>
  );
}
