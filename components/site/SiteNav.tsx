// The site's top bar. Three pages, three menus: makers (the home page: print, mount, work), developers
// (/developers: the engine and the three open-source projects) and the architecture (/architecture: what runs
// on the phone, what runs in the cloud). The switch between them is always visible.

const MENUS = {
  makers: [
    { href: "/#steps", label: "How it works" },
    { href: "/#build", label: "Watch a job" },
    { href: "/#scenarios", label: "Demos" },
    { href: "/markers", label: "Print the sheet" },
  ],
  developers: [
    { href: "/developers#engine", label: "Engine" },
    { href: "/developers#athos", label: "athos" },
    { href: "/developers#gatekeeper", label: "gatekeeper" },
    { href: "/developers#agentvcs", label: "agentvcs" },
    { href: "/benchmarks", label: "Benchmarks" },
  ],
  architecture: [
    { href: "/architecture#diagram", label: "In 3D" },
    { href: "/architecture#where", label: "What runs where" },
    { href: "/architecture#files", label: "The files" },
    { href: "/architecture#phases", label: "Phases" },
  ],
} as const;

export type Audience = keyof typeof MENUS;

export default function SiteNav({ compact = false, audience = "makers" }: { compact?: boolean; audience?: Audience }) {
  const tab = (a: Audience, href: string, label: string) => (
    <a
      href={href}
      aria-current={a === audience ? "page" : undefined}
      className={`rounded-full px-3 py-1 transition ${a === audience ? "bg-white text-black" : "text-white/60 hover:text-white"}`}
    >
      {label}
    </a>
  );
  return (
    <nav className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-3 ${compact ? "py-3" : "py-5"}`}>
      <div className="flex items-center gap-4">
        <a href="/" className="flex items-center gap-2 font-mono text-sm">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--green)] shadow-[0_0_10px_var(--green)]" />
          <span className="font-semibold tracking-tight">SmartTools</span>
        </a>
        <div className="flex items-center rounded-full border border-white/15 p-0.5 text-xs font-medium">
          {tab("makers", "/", "Makers")}
          {tab("developers", "/developers", "Developers")}
          {tab("architecture", "/architecture", "Architecture")}
        </div>
      </div>
      <div className="hidden items-center gap-5 text-sm text-white/60 lg:flex">
        {MENUS[audience].map((l) => (
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
