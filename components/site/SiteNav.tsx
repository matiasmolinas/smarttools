// The site's top bar: the same on the home page, the engine lab and the marker sheet.

const LINKS = [
  { href: "/#what", label: "What it does" },
  { href: "/#scenarios", label: "Demos" },
  { href: "/#start", label: "Get started" },
  { href: "/#inside", label: "How it works" },
];

export default function SiteNav({ compact = false }: { compact?: boolean }) {
  return (
    <nav className={`flex items-center justify-between gap-4 ${compact ? "py-3" : "py-5"}`}>
      <a href="/" className="flex items-center gap-2 font-mono text-sm">
        <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--green)] shadow-[0_0_10px_var(--green)]" />
        <span className="font-semibold tracking-tight">SmartTools</span>
      </a>
      <div className="hidden items-center gap-6 text-sm text-white/60 md:flex">
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} className="hover:text-white">
            {l.label}
          </a>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <a href="https://github.com/matiasmolinas/smarttools" className="hidden rounded-full px-3 py-1.5 font-mono text-xs text-white/60 hover:text-white sm:inline">
          GitHub ↗
        </a>
        <a href="/hud" className="rounded-full bg-[var(--green)] px-3.5 py-1.5 text-xs font-semibold text-black hover:brightness-110">
          Try it on your phone
        </a>
      </div>
    </nav>
  );
}
