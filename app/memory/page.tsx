// /memory: the plans and jobs this phone keeps (F1, docs/ARCHITECTURE.md). Works offline.

import type { Metadata } from "next";
import SiteNav from "@/components/site/SiteNav";
import MemoryScreen from "@/components/MemoryScreen";

export const metadata: Metadata = {
  title: "SmartTools memory: your plans and jobs, on this phone",
  description: "The plans and jobs this phone keeps: use a plan, download a report or an agentvcs ledger. Works offline.",
};

export default function MemoryPage() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6">
      <SiteNav audience="makers" compact />
      <header className="pb-8 pt-8">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cyan)]">On this phone</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Your plans and jobs.</h1>
        <p className="mt-3 max-w-2xl text-white/60">
          Kept in this browser, with no account and no network. Plan on the phone with the tool as a pointer, drill, and
          every job lands here with its report and its agentvcs ledger.
        </p>
      </header>
      <MemoryScreen />
    </main>
  );
}
