# SmartTools Dock v0.3: universal phone mount for cordless drill/drivers

**English** · [Español](README.es.md)

An adjustable mount that holds a phone on a cordless drill/driver, with the camera facing the bit and the screen
facing the user. Designed for the Ingco CDLI20022 and the Xiaomi Redmi Note 13, but **adjustable** for other models.

![Dock preview](preview.png)

**What changed from v0.2.** The scene simulator showed that v0.2 put the camera 12–17 cm above the bit axis and
5–8 cm to the side. The bit tip was out of the image (39° below the optical axis, with a ±19.6° field) and mark A1 had
no marker in view. In v0.3:

- the phone hangs low behind the saddle, just above the drill body;
- the camera sits at the fixed-jaw end, on the bottom edge, right above the bit;
- the tip is 14° below the image centre with no tilt.

The software reads this geometry from `dock.py` (`rig.json`, `lib/dockgeom.ts`), so the simulator, the 3D view and
the end-to-end tests use the dock as designed. With it they pass 34/34 at 0° and at 10° of tilt
(`npm run test:e2e -- --rig dock`).

| Adjustment | Range |
|---|---|
| Phone length (landscape) | 140–175 mm (sliding jaw + M4 wing nut) |
| Phone thickness | up to 12 mm, slim case included |
| Drill body | approx. Ø 38–68 mm (split clamp: two facing 90° V-blocks, rubber pads and 2 M5 bolts with wing nuts) |
| Camera tilt | 0–20° down (M5 hinge with an arc slot). At 0° the bit tip is 14° below the image centre; at 10°, 6° |

The phone goes in **landscape, screen toward you, camera end against the fixed jaw, camera on the bottom edge**. On a
phone with the camera module at the top left of its back, that means rotating it so the camera ends up at the bottom.
The camera-side lip is low (8 mm) so it never covers the lens.

## Parts to print (1 of each)

| File | Approx. size | Solid volume | Suggested orientation |
|---|---|---|---|
| `saddle.stl` (upper V-block) | 60 × 94 × 70 mm | 123 cm³ | On its bottom face (V opening toward the bed). The 45° V needs no supports; the strap tunnels do (supports on the bed only) |
| `lower.stl` (lower V jaw) | 24 × 94 × 34 mm | 20 cm³ | V opening up, resting on the ears: no supports |
| `arm.stl` (arm + rail + fixed jaw) | 72 × 203 × 51 mm | 50 cm³ | Rail base on the bed. Supports for the upper beam and the tongue |
| `jaw.stl` (sliding jaw) | 19 × 21 × 40 mm | 3 cm³ | Phone contact face toward the bed |

**Material:** PETG (or ASA/ABS). Do not use PLA: it deforms with motor heat and sunlight.
**Settings:** 0.2 mm layers · 4 perimeters · 5 top and bottom layers · 30–40 % gyroid infill.
**Tolerances:** 0.3 mm clearance per side at the hinge and the jaw. Holes are Ø5.5 for M5 and Ø4.5 for M4.

## Hardware (not printed)

- 2 × M5 × 35 mm bolt + 2 washers + 2 M5 wing nuts (hinge and tilt lock)
- 2 × M5 × 80 mm bolt + 2 flat washers + 2 **lock washers** + 2 M5 wing nuts (clamp). For bodies up to Ø56 mm, M5 × 60 is enough
- 1 × M4 × 16 mm bolt + washer + M4 wing nut (jaw)
- Optional: 1 hook-and-loop strap, 20 mm × 300 mm, as a backup (runs through the saddle tunnels)
- 2 mm self-adhesive rubber or neoprene for **all 4** faces of the two V-blocks (grip and vibration damping)
- Optional: a 2 mm foam strip at the bottom of the rail, for thin phones

## Assembly

1. Stick the rubber on the 4 faces of the two V-blocks.
2. Set the saddle on the motor housing, behind the chuck and in front of the trigger. Put the lower jaw underneath,
   pass the 2 M5 × 80 bolts top-down through the ears and tighten the wing nuts (with lock washers) evenly, a little on
   each side, until the dock neither turns nor slides. Do not overtighten: the housing is plastic.
   Optional: run a strap through one tunnel as a backup.
3. Insert the arm's tongue between the ears: the front M5 is the hinge, the rear one goes through the arc slot (lock).
   The rail sits behind the saddle, just above the drill body, and extends to one side.
4. Put the phone in landscape on the rail, screen toward you, **camera end against the fixed jaw and camera on the
   bottom edge**. Slide the moving jaw in and tighten the M4 wing nut.
5. Set the tilt so that the bit tip appears in the lower half of the image (0–10° usually), and tighten the lock wing
   nut. It does not need to be parallel to the bit: the app measures the real angle.
6. In the app: print `/markers`, open `/hud` → **Cam**. Once per phone, tap **Lens** and move the phone over the sheet
   for 20 s. Then rest the tip on **A2**, tap **Calibrate**, circle the drill around the tip for 5 s and twist it
   around the bit for 5 s.

## Before printing: measure your drill

I don't have drawings of the Ingco CDLI20022, so the clamp uses two V-blocks that fit a range of diameters (the script
checks Ø38 to Ø68 mm with no collisions between parts). With calipers, check:

- [ ] The motor housing diameter, between the chuck and the trigger, is between 38 and 68 mm.
- [ ] There are at least 60 mm of free length on top for the saddle and 24 mm underneath for the lower jaw, in front of
      the trigger (clear of the torque collar and the LED light).
- [ ] The forward/reverse and speed selectors stay reachable with the saddle in place.
- [ ] Behind the saddle, the top of the drill body is no higher than the saddle's V apex minus 0.41 × its radius (the
      phone's bottom edge is 6 mm above the apex); a raised hump behind the motor needs a higher `PHONE_BOTTOM_Z`.

And measure your phone and drill, then set them in `dock.py` and regenerate:

| Parameter | Meaning | Reference |
|---|---|---|
| `PHONE_REF_LEN`, `PHONE_REF_H`, `PHONE_REF_T` | Phone length, height, thickness | Redmi Note 13: 162.2 × 75.4 × 8.0 mm |
| `CAM_FROM_END`, `CAM_FROM_EDGE` | Main lens centre from the short end and from the long edge | 15 and 14 mm (approximate) |
| `BODY_D_REF` | Motor housing diameter where the saddle sits | 56 mm |
| `TIP_X_REF` | Saddle centre to the bit tip, along the bit, with the bit you will use | 190 mm |

The software reads these from the generated `rig.json` / `lib/dockgeom.ts`. Run `npm run test:e2e -- --only rig` after
changing them: it checks that the tip is in the image and that at least 6 markers are in view on every mark.

## Regenerating the STLs

```bash
python3 -m venv .venv && .venv/bin/pip install manifold3d numpy matplotlib
.venv/bin/python dock.py
```

The script also:

- checks that the parts don't interfere with each other or with the drill body (0° and 20° tilt, Ø40 to Ø68 mm);
- computes the bolt length needed;
- writes `preview.png`, `rig.json` and `../../lib/dockgeom.ts` (the geometry for the software).

## Known limitations (v0.3)

- **Not physically tested yet.** Print one and test it before making more.
- **The phone is cantilevered to one side** (about 15 cm from the arm's leg) so that its camera sits above the bit. A
  gusset stiffens it, but check for vibration on the first print. If it shakes, add a second support or shorten
  `PHONE_LEN_MAX`.
- The camera position inside the phone (`CAM_FROM_END`, `CAM_FROM_EDGE`) is approximate: measure it.
- The camera does not need to be parallel to the bit: **Calibrate** measures the tip position (circling around the tip)
  and the bit axis (twisting around the bit). In the scene simulator both come out within 0.1 mm and 0.01°.
- Vibration can loosen wing nuts: use lock washers and check the clamp before each session. In the app, rest the tip on
  A2 to check the calibration: if the dock moved, recalibrate.

## License

Apache License 2.0, like the rest of the repository. See [LICENSE](../../LICENSE).
