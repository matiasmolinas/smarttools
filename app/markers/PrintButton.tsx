"use client";

export default function PrintButton({ label = "Print sheet" }: { label?: string }) {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-full border border-white/30 bg-white/10 px-5 py-2 font-mono text-sm text-white hover:bg-white/20"
    >
      {label}
    </button>
  );
}
