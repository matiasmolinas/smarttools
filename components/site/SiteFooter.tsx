export default function SiteFooter() {
  const col = "flex flex-col gap-2";
  const a = "text-white/55 hover:text-white";
  return (
    <footer className="mt-10 grid gap-8 border-t border-white/10 py-10 text-sm sm:grid-cols-4">
      <div className="sm:col-span-2">
        <div className="flex items-center gap-2 font-mono text-sm">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--green)]" />
          <span className="font-semibold">SmartTools</span>
        </div>
        <p className="mt-3 max-w-sm text-white/45">
          A phone and a printed dock that guide the drill you already own. Open source, Apache 2.0. This site is a demo:
          the 3D jobs are simulations running on the real navigation engine.
        </p>
      </div>
      <div className={col}>
        <span className="font-mono text-[11px] uppercase tracking-wider text-white/35">Try</span>
        <a className={a} href="/hud">The phone app (/hud)</a>
        <a className={a} href="/markers">Print the marker sheet</a>
        <a className={a} href="/engine">Engine lab</a>
        <a className={a} href="/#scenarios">All demos</a>
      </div>
      <div className={col}>
        <span className="font-mono text-[11px] uppercase tracking-wider text-white/35">Build</span>
        <a className={a} href="https://github.com/matiasmolinas/smarttools">Source code ↗</a>
        <a className={a} href="https://github.com/matiasmolinas/smarttools/tree/main/hardware/dock">Print the dock (STL) ↗</a>
        <a className={a} href="https://github.com/matiasmolinas/smarttools/blob/main/docs/ENGINE_SPEC.md">Engine spec ↗</a>
      </div>
    </footer>
  );
}
