---
id: drill-a-bracket-pattern
title: Drill a bracket pattern
when: "hanging a four-hole bracket on a board with the SmartTools sheet taped on it"
projects: [smarttools]
visibility: project
status: candidate
risk: normal
confidence: 0.5
created: 2026-11-23
origin:
  platform: claude-code
version: 1
---

## #clamp
**When:** Before the first hole
**Do:** Clamp the board to the bench
**Check:** the board does not move when pushed
**Because:** a board that moves under the bit
  moves every hole with it
**Links:** [[#d1]]

## #d1
**When:** The tip is on hole D1
**Do:** Drill D1: Ø6 mm at (0, 60) mm, 20 mm deep
**Check:** depth within 0.5 mm and angle under 1°
**Because:** the bracket's screws seat at 20 mm
**Links:** [[#d2]]

## #d2
**When:** The tip is on hole D2
**Do:** Drill D2: Ø6 mm at (40, 60) mm, 20 mm deep
**Check:** flush with the surface
**Because:** the second screw must line up with the first
**Links:** [[#clamp]] [[other-piece#step]]

## History
- v1 2026-11-23: written as a test fixture
