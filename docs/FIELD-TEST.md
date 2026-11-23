# Field test: the phone on a real drill

A guide to the first physical test of SmartTools: an INGCO 20V drill/driver, a provisional mount and a Redmi 15.
It measures three things and keeps a record of each:

1. **Accuracy at one point.** With the tip resting on the printed target A2, how many millimetres from A2 does the
   app place it?
2. **Stability, motor off and motor on.** With the drill held still, how much does the measured direction of the
   bit shake? Measured without the filter (each frame as it is) and with it (the pose the go/no-go gate decides
   with).
3. **A complete 4-hole job.** What the app recorded, against what a caliper measures.

The app records everything and exports it as files. The runs are published on
[/benchmarks](https://smarttools-nav.vercel.app/benchmarks), next to the **simulated** reference run, for comparison.

> **Precision is not accuracy.** Test 2 measures how much the measurement shakes (precision); it does not say whether
> the bit points where the app thinks it does. That is what test 1 (a known point) and test 3 (the caliper) are for.
> In the results, each one is named for what it is.

Estimated time: 2 hours, including the mount.

---

## 0. Before you start

### Materials

- [ ] The INGCO 20V drill/driver with a charged battery, and a **6 mm wood drill bit**.
- [ ] The **Redmi 15**, charged, in the case you will use.
- [ ] **The marker sheet** (https://smarttools-nav.vercel.app/markers) printed on A4 at **100 %**. Measure the
      50 mm line in the margin: if it is not 50 mm, print it again.
- [ ] **A wooden board at least 30 mm thick** (pine is fine), about 30 × 40 cm, and masking tape to stick the sheet
      down flat.
- [ ] **For the provisional mount:** 2 or 3 hose clamps or heavy cable ties, a wooden block, rubber or double-sided
      foam tape, and duct tape.
- [ ] **To hold the drill still in test 2:** a vise, or 2 clamps holding it by the grip to the edge of a table.
- [ ] **To measure:** a caliper with a depth rod, a square or a squared block, and a ruler.
- [ ] **A second phone** to film (for the video).
- [ ] **Safety:** safety glasses, and the board firmly clamped before drilling.

### On the phone

1. Open https://smarttools-nav.vercel.app/hud in Chrome and add it to the home screen (⋮ → *Install app*). Open it
   from the icon: it runs full screen and works offline.
2. Tap **Start** and allow the camera. The **Setup** opens by itself the first time; on its first screen, tap
   *Phone: … (tap to change)* to pick your phone.
3. Everything else is in the **menu ☰** (top right): **Setup**, **Job**, **Tests**, **Record 10 s**, **Sound**,
   **Full screen**.
4. **Pause and Stop**, bottom right, work like the drill's trigger:
   - **Pause** turns the camera and tracking off and keeps the calibration. Use it between holes or tests.
     **Continue** goes straight back to work. After more than 30 min, it offers a 5 s check on A2.
   - **■ Stop**: hold it 1 s. Everything turns off and the job is saved or dropped. Use it when you change the bit
     or the tip, or take the phone out of the dock.
   - After a Stop, the next **Start** asks **What did you change?** and redoes only what that affects:

     | Answer | What it redoes |
     |---|---|
     | Nothing | The 5 s check on A2 |
     | The bit or the tip | The drill calibration (10 s) |
     | I took the phone out | The drill calibration (10 s) |
     | Another phone | Lens and drill |

   - The app also pauses by itself when it goes to the background, or after a minute with no markers in view.
5. Screen brightness high. Turn on **Do not disturb**, so no notification interrupts a recording.

### The sheet

Tape the sheet flat on the board, with no wrinkles or bubbles, taped along all four edges. The light must be even:
no glare on the sheet, and no shadow of the drill covering many markers.

---

## 1. Calibrate the lens (before mounting the phone)

Done once per phone, with the phone in your hand.

1. In the **Setup**, step **Lens**, tap **Start** (if the lens was calibrated before, it says so and you can go on,
   or tap *Calibrate again*).
2. For 20 s, move the phone over the sheet as in the animation: near and far, tilting it towards all four sides,
   always with many markers in view.
3. When it ends, the setup shows the error in px. **Write it down.** Below 1 px is very good. Above 2 px, repeat with
   better light.

---

## 2. The provisional mount

The printed dock is not ready yet. A provisional mount works for today's measurements if it meets three conditions:

1. **Rigid.** The phone cannot move relative to the drill: not when you touch the screen, not with the motor
   running. If it moves, every measurement is of the mount, not of the system. Test it by pushing the phone with a
   finger: it must not give.
2. **The bit tip in view**, in the lower half of the image. The phone goes **landscape**, screen towards you, with the
   camera looking forward and down along the bit, tilted about 15°.
3. **The markers in view.** The mount must not cover the camera.

One way that works:
- **The block:** a wooden block strapped to the drill's body, behind the torque collar, with 2 hose clamps or heavy
  cable ties, tightened hard.
- **The phone:** stuck to the block with double-sided foam tape plus duct tape, with rubber between the phone and the
  block.
- **Before going on:** look at the screen. The bit tip must appear low in the image, with the sheet and many markers
  around it.

> In the app's bench lab, the mount button must say **provisional mount**. It is saved with every run, because a
> provisional mount vibrates differently from the printed dock.

---

## 3. Calibrate the tip and the bit's axis

Every time you mount or move the phone:

1. **Make a small dent in the centre of A2** with a nail or a punch, so the tip cannot slide while you move the drill.
   It is what improves this calibration the most.
2. In the **Setup** (menu ☰ → Setup), step **Tip**: rest the tip in the dent and tap **Start**:
   - **first 5 s:** circle the drill around the tip, keeping the tip in the dent, tilting it about 10–15° to every
     side;
   - **next 5 s:** with the tip in the same place, twist the drill around its own bit, from one side to the other.
3. Step **Check**: the **blue TIP cross** is where the app thinks the tip is. It is fixed in the image (the camera
   is fixed to the drill) and **must sit on the real bit tip**. If it does not, tap *No: calibrate the tip again*.
   The number is the tip's distance to A2 with the tip resting on it: below 1 mm is very good.
4. If something fails, the setup says why: repeat with more markers in view and slower movements.

---

## 4. Test 1: accuracy at A2

Open the lab with **menu ☰ → Tests**. The panel shows live:
- how many markers it sees;
- the bit's angle to the sheet;
- the tip's distance to A2;
- the shake over the last second, raw and filtered;
- the accelerometer.

1. Motor off. Rest the tip on the centre of A2, with the drill as square as you can (you can rest it against the
   square).
2. Tap **Check on A2 5s**. A 3 s countdown runs, then it records for 5 s: stay still.
3. The panel's table shows `A2 x.xx`: the tip's mean distance to A2, in mm.
4. **Repeat 3 times**, lifting the drill and setting it down again each time. Each take replaces the previous one in
   the panel, so **write down each value** in the results table.

What to look for: the design target is **under 1 mm**. The `bit vs sheet` line tells you how square you held it.

---

## 5. Test 2: motor off and motor on (stability)

To measure the motor's vibration and not your hand's tremor, **the drill must be held fixed**.

1. **Fix it:** hold it in the vise, or with two clamps from the grip to the edge of the table, with the bit vertical,
   pointing at A2, and the **tip 3–5 mm above the sheet, not touching it**. The board with the sheet goes underneath,
   also fixed.
2. In the Bench panel, check that it sees many markers (more than 8) and that the shake over the last second is
   small.
3. **Motor off 10s:** tap it and touch nothing during the countdown and the 10 s.
4. **Motor on (free spin) 10s:** tap it and, during the countdown, pull the trigger **all the way**, with the speed
   selector on **2** (high). Hold it until it ends. The bit spins in the air.
5. Repeat step 4 at **speed 1** if you want to compare, saving one run per speed (see below).
6. Look at the panel's table: `angle σ raw/filt`. Expect the raw value to rise with the motor on, and the filtered one
   to rise less.
7. **The `filter on/off` switch only changes what the screen shows.** Both signals, raw and filtered, are always
   recorded. Use it in the video to show the difference to the eye.
8. Tap **save run**. The run is kept on the phone (in `/memory` and on `/benchmarks`), and a file
   `smarttools-bench-….json` is downloaded too.

If you want, also repeat motor off and motor on with the drill in your hand (not fixed), and save it as another run.
In your notes, tell me it was handheld: the difference from the fixed run shows how much is hand tremor.

> While the Bench panel is open, the app does not extrapolate the pose ("prediction off"). So what is measured as
> "filtered" is exactly what the gate uses to decide.

---

## 6. Test 3: a 4-hole job

1. **The plan:** **menu ☰ → Job → Change plan** until it says
   **Demo: 4 holes, 40 mm square, 20 mm deep**. Four Ø6 mm holes, 20 mm deep, on a 40 × 40 mm square (D1 to D4), in
   the gaps between markers. **A2 stays free**, so you can recalibrate afterwards.
2. **Menu ☰ → Sound: on** for the guiding tone. Follow the banner at the top: the arrow to the mark, *Touch down*,
   *Tilt* (bring the dot into the small circle), *Drill*.
3. **Optional:** with the Bench panel open, tap **Drilling 10s** just before starting D1, and drill during the
   recording. That measures the vibration under real load.
4. **For each hole:**
   - bring the tip to the ring the screen shows;
   - line up until the gate turns green (square and centred);
   - drill until the screen shows the depth;
   - pull out.
   The app records the hole by itself.
   If the plan came from a recipe, a card under the banner shows the hole's Check: green passes by itself, red
   stays until **OK**, amber asks **Yes** / **No** for what the engine cannot measure. The recipe's steps that are
   not holes (clamping, for example) come up as a **Step** sheet before the hole they precede: tap **Done** or **Skip**.
5. When all 4 are done, **menu ☰ → Job → Finish job and save**. You will see *Job saved* with the verdict.
   The job in progress is kept after every hole: if the app closes before you save, the next **Start** carries on
   with it (*Job recovered*). Changing the plan mid-job saves the holes drilled so far as an unfinished job.
6. **Measure with the caliper** and write down:
   - each hole's real **depth**, with the caliper's depth rod;
   - the **spacing** between centres: D1–D2 and D4–D3 (horizontal), D2–D3 and D1–D4 (vertical). They should all be
     40.0 mm.
   - whether the hole came out **square**: put the bit (or a screw) in the hole and measure its lean with the square.

---

## 7. Optional: plan with the drill as a pointer

1. **Menu ☰ → Job → New plan with the tool.** Rest the tip on a free spot of the sheet (between markers) and tap
   **Mark hole**. Repeat at a second spot and tap **Save plan**.
2. Drill those two holes as in test 3 and finish the job from **menu ☰ → Job**.

---

## 8. Export and send me the files

On the phone, open https://smarttools-nav.vercel.app/memory:

- **Bench runs → Download run**, for each run;
- **Jobs → Job record (JSON)**, **agentvcs ledger** and **Report (HTML)**, for the 4-hole job.

Move them to the laptop (WhatsApp, Drive or a cable), into a folder `~/Downloads/smarttools-field/`. Add a text file
with your notes: the mount, whether the drill was fixed or handheld, the speed, and your caliper measurements.

With that, I:
1. publish the real runs on `/benchmarks`, labelled as measured, next to the simulated one;
2. add what we found, with the numbers, to the build log;
3. compare what the app recorded with your caliper measurements.

---

## 9. The video

With the second phone, landscape, in good light. Shots, in order:

1. **The mount** (5 s): the drill with the phone, turned to show the mount.
2. **The calibration** (10 s): the circle and the twist on A2.
3. **Motor off and on** (20 s): the phone's screen with the Bench panel, and the filter switch toggling while the
   motor spins.
4. **One hole, start to finish** (15 s): the ring, the green, the drilling, the depth.
5. **The caliper** measuring a hole (5 s).

No background music, or just the app's tone. I can edit the final cut if you send me the clips.

---

## 10. Alternatives to evaluate (menu ☰ → Tests)

The defaults stay as they are; each of these is a switch, kept on the phone until you change it back.

| Switch | What it changes | What to compare |
|---|---|---|
| **detector js / rust** | The marker detector: js-aruco2 (default) or the one written in Rust (WebAssembly). In simulation the Rust one is ~3× faster, finds no false markers, and the pose is as accurate | Latency (TRACKER SPEED), markers seen, steadiness in Motor off / on |
| **compare on** | Runs the other detector on the same frames: its time, its markers, and how far its corners are | Leave it on for a minute on each phone, then off (it costs time) |
| **filter at camera / tip** | Where the engine smooths the pose. In simulation, filtering at the tip halves the motor's shake at the tip (0.16 vs 0.32 mm) | Motor on: the filtered tip jitter in the table |
| **60 fps** | Asks the camera for 60 frames/s (the line "camera runs at" says what it gives) | Latency, and the shake while moving |
| **lock focus** | Locks focus and exposure (Chrome on Android; Safari on iPhone does not allow it, and says so) | Steadiness with the motor on: autofocus hunting adds jitter |
| **record camera 10 s** | Records 10 s of the frames the tracker sees, with the calibration, as a `.strec` file. When it is ready, a sheet offers **Share** (AirDrop it to the laptop) and **Download** | Send it to me: I replay it on the laptop with both detectors and both filters (`node scripts/replay.mts file.strec`) |

A good order, with the drill fixed as in test 2:
1. **record camera 10 s** with the motor off, and again with the motor on (two files);
2. Motor off / on with **detector js**, then with **detector rust**, saving a run each time;
3. the same with **filter at tip**;
4. on the Redmi: **detector rust** and **detect 640**, to see the latency drop.

---

## 11. If something goes wrong

| Symptom | What to do |
|---|---|
| Few markers (under 6) | More even light, no glare. Move the camera back a little (more tilt) or move the sheet |
| The tip does not show in the image | Tilt further down. The tip must be in the lower half |
| `TIP OK` above 1 mm | Repeat: the tip must not leave A2, and the movement must be slow and wide |
| The accelerometer says "no data" | Close the Bench panel and open it again. The browser needs a tap to enable it |
| The gate does not turn green | Read the message: "Hold steady", "Line up the rings", "Tip to the mark" or "Show more markers" |
| The phone heats up and the image lags | Lower the brightness and close other apps; let it cool for 5 min |
| Something looks off after moving the mount | Recalibrate the tip (section 3) |

---

## 12. Results table

| Measure | Value |
|---|---|
| Lens: calibration error (px) | |
| Tip: calibration error (mm) | |
| A2, take 1 / 2 / 3 (mm) | |
| Motor off: angle σ raw / filtered (°) | |
| Motor on (speed 2): angle σ raw / filtered (°) | |
| Motor on (speed 1): angle σ raw / filtered (°) | |
| Accelerometer off / on (m/s²) | |
| D1–D4: depth recorded by the app (mm) | |
| D1–D4: depth measured with the caliper (mm) | |
| Spacings D1–D2, D2–D3, D3–D4, D4–D1 (mm) | |
| Lean of the holes (°) | |
| Notes (mount, fixed / handheld, light) | |
