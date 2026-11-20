# The website: who it is for, and why it is laid out this way

The 3D scenes were strong, but the old home page told several stories at once:
- surgery;
- robots;
- AI agents;
- a $20 dock;
- three open-source repos;
- 19 demos in one flat list.

It had no clear next step for a visitor, and the pages a visitor can use (`/hud`, `/markers`, `/engine`) were not
linked from the navigation.

We reviewed the site through three product lenses. The first two are inspired by publicly known ways of thinking of
two product builders. They are review lenses for us, not people quoted or named on the site.

## The three lenses

### 1. The focus lens (inspired by Steve Jobs' public approach to products)

*Simplicity, one message, say no to most things, make people feel it before explaining it.*

What it criticised:
- **The headline was a metaphor.** "A bicycle for humans in the real world" did not say what the product does.
- **The first paragraph mixed five ideas:** robots, surgery, the phone, the dock and AI.
- **"On the part" listed eight features at the same weight.**

What it asked for:
- **A headline about the outcome:** *Every hole in its place. Every screw square.*
- **Show before telling:** the whole job, start to finish, right under the headline.
- **Three things, not eight:** Locate, Guide, Protect. Every feature lives under one of them.
- **One action, repeated:** *Try it on your phone.*

### 2. The builder lens (inspired by Steve Wozniak's public approach to engineering)

*Show how it really works, be honest about what is real, let people build it themselves, make it fun.*

What it criticised:
- **The numbers were buried.** The end-to-end test results were only in the README.
- **"AI plans the job" was claimed but not shown,** while the deterministic engine, which is real, was undersold.
- **Nothing on the page said how to build it:** no dock STL link, no marker sheet link.

What it asked for:
- **A "How it works" section with the real numbers,** labelled as simulated, and links to the engine lab and the spec.
- **"Get started" with the three things you need,** and a link to each: the phone, the printed dock (STL), the sheet.
- **"Honest status":** what works today, what comes next, what comes after.

### 3. The workshop lens (a product lead for professional users: installers, cabinet makers, assembly lines)

*What do I need, how long until the first good hole, can I trust it, what happens when it is wrong.*

What it criticised:
- **The demos read as features, not as jobs.**
- **The platform scenarios sat between the drilling ones.** athos, gatekeeper and agentvcs are integrations a
  workshop does not need on day one.
- **Safety was spread across the page.**

What it asked for:
- **Demos grouped by job:** 3D assembly, drilling & safety, platform.
- **Each of the three things links straight to the demos that prove it** (`#scenario-<id>`).
- **Safety as a first-class idea:** Protect, "it says no before you get it wrong".

## Two audiences, two pages (November 2026)

The one-story home page still served two readers at once: someone who wants to put a phone on a drill tonight, and
someone who wants to build on the engine. Now each one gets a page and a menu, with a switch between them in the top
bar (`components/site/SiteNav.tsx`, `audience`).

### `/`, for makers: print, mount, work

| Section | The visitor's question |
|---|---|
| Hero | What is it? |
| How it works: 1 Print (dock, sheet, markers for parts) · 2 Mount it on your screwdriver (more tools coming) · 3 Work (register the area, the parts and the tool, plan with the tool as a pointer, operate with your plan or an expert's) | What do I do? |
| One job, start to finish | Show me |
| Demos: 3D assembly, drilling & safety | Does it really work? |
| Honest status, and a way to the developer page | Can I trust it? |

What is not built yet is marked "coming with the app" in place, not hidden:
- the printable part stickers;
- planning with the tool as a pointer;
- tools other than the drill.

### `/developers`: four things

| Section | Contents |
|---|---|
| 1 · The engine | Navigation (Rust → WebAssembly), the 3D and 2D views, augmented reality on the camera view, the numbers, links to the code, the lab and the spec |
| 2 · athos | What it is, what it does in SmartTools, and how it should be integrated |
| 3 · contract-gatekeeper | Same |
| 4 · agentvcs | Same |
| All demos | Including the platform illustrations |
| Honest status | |

For each project, the integration (used from its repository, or migrated here) is decided in
[INTEGRATIONS.md](INTEGRATIONS.md).

## Rules for future changes

- **One headline idea per section.** For makers, a new feature goes under Print, Mount or Work; for developers, under one of the four things. Not in a new list.
- **Every number on the page comes from a test,** and says whether it is simulated.
- **Every section ends in something to do:** watch, open, print, read.
- **The top bar is the same on every page except the phone app (`/hud`):** `components/site/SiteNav.tsx`. Its
  menu follows the audience: makers or developers.
- **Makers never need to read about the engine or the projects to get started;** developers find everything on
  `/developers`.
