"""
SmartTools universal phone dock for cordless drill/drivers (parametric).

Four printed parts + standard hardware:
  1. saddle.stl  - 90-degree V-block that sits on the drill's motor housing (fits ~40-68 mm),
                   clamped by the lower jaw (optional strap tunnels as backup); ears with an M5 pivot and a +/-15 deg tilt slot.
  1b. lower.stl  - lower V jaw: closes the split clamp with 2 x M5 through-bolts + wing nuts.
  2. arm.stl     - tongue (pivot) + column + U-channel rail that holds the phone in landscape,
                   with a fixed jaw at one end and a slot for the sliding jaw.
  3. jaw.stl     - sliding jaw, locked with an M4 bolt + wing nut. Phones 140-175 mm long, up to 12 mm thick.

Frame: X = toward the bit (camera looks +X), Y = lateral, Z = up. Units: mm.
Run:  python dock.py   ->  writes STL files and preview.png next to this script.
"""

import math
import os
import struct

import numpy as np
from manifold3d import Manifold

# ---------------- parameters ----------------
PHONE_LEN_MIN, PHONE_LEN_MAX = 140.0, 175.0  # long side of the phone (landscape width)
PHONE_THICK_MAX = 12.0  # including a slim case
SEG = 64

# saddle / V-block
SAD_X = 30.0  # half length along the bit
SAD_Y = 35.0  # half width
SAD_TOP = 17.0  # top surface above the V apex
SAD_BOT = -26.0  # bottom of the block (V opening = 2*26 = 52 mm wide)
STRAP_W, STRAP_H = 22.0, 5.0  # strap tunnels across the block (for 20 mm straps)
EAR_T = 6.0
TONGUE_T = 12.0
CLR = 0.3  # print clearance per side
PIVOT_Z = 32.0  # pivot height in saddle frame
M5 = 2.75  # hole radius for M5
M4 = 2.25  # hole radius for M4
LOCK_R = 14.0  # radius of the tilt-lock hole/slot from the pivot
TILT = 15.0  # +/- degrees

# split clamp: lower V jaw + 2 through-bolts M5 with wing nuts
BOLT_Y = 41.0  # bolt centre, each side (clear of a 68 mm body)
WING_X = 11.0  # half length of the bolt wings along X
WING_T = 10.0  # wing thickness
LOW_X = 12.0  # half length of the lower jaw along X (narrow, fits ahead of the trigger)
LOW_SHELL = 6.0  # shell thickness of the lower V
LOW_TOP = 26.0  # lower jaw top above its V apex

# rail (arm frame: pivot at origin)
CH_IN = PHONE_THICK_MAX + 0.6  # channel inner width (X)
CH_WALL = 3.0
CH_X = -24.0  # channel centre X (behind the pivot, toward the user)
BASE_Z0, BASE_Z1 = 30.0, 35.0  # channel base (phone rests on z = 35)
FRONT_H, BACK_H = 5.0, 8.0  # wall heights above the base (front = screen side, -X)
JAW_H = 40.0  # jaw height above the base
LIP = 4.0  # how far the lips reach over the phone edge (Y)
BACK_LIP_H = 12.0  # camera-side lip is short so the camera is never covered
FIX_FACE = 93.0  # inner face of the fixed jaw (Y)
RAIL_Y0 = -100.0


def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])


def cyl_y(x, z, r, y0, y1):
    return Manifold.cylinder(y1 - y0, r, r, SEG, True).rotate([90, 0, 0]).translate([x, (y0 + y1) / 2, z])


def cyl_z(x, y, r, z0, z1):
    return Manifold.cylinder(z1 - z0, r, r, SEG).translate([x, y, z0])


def union(parts):
    out = parts[0]
    for p in parts[1:]:
        out = out + p
    return out


# ---------------- 1. saddle ----------------
def saddle():
    body = box(-SAD_X, SAD_X, -SAD_Y, SAD_Y, SAD_BOT, SAD_TOP)
    # inverted 90-degree V along X, apex at z = 0
    a = 90.0
    v = Manifold.cube([2 * SAD_X + 2, a, a], True).rotate([45, 0, 0]).translate([0, 0, -a / math.sqrt(2)])
    body = body - v
    # strap channels across the top, clear of the ears
    # lightening pockets through the side cheeks (keeps >= 5 mm walls)
    for s in (-1, 1):
        body = body - box(-SAD_X - 1, SAD_X + 1, min(s * 24, s * 30.5), max(s * 24, s * 30.5), -15, 7)
    # strap tunnels across Y, under the ears, above the V apex
    for xc in (-18.0, 18.0):
        body = body - box(xc - STRAP_W / 2, xc + STRAP_W / 2, -SAD_Y - 1, SAD_Y + 1, 5.0, 5.0 + STRAP_H)
    # ears (pivot + tilt slot)
    ears = []
    for s in (-1, 1):
        y0 = s * (TONGUE_T / 2 + CLR)
        y1 = s * (TONGUE_T / 2 + CLR + EAR_T)
        ya, yb = min(y0, y1), max(y0, y1)
        ear = box(-24, 12, ya, yb, SAD_TOP - 1, PIVOT_Z) + cyl_y(0, PIVOT_Z, 12, ya, yb) + cyl_y(-LOCK_R, PIVOT_Z, 10, ya, yb)
        ear = ear + box(-LOCK_R, 0, ya, yb, PIVOT_Z, PIVOT_Z + 10)
        ears.append(ear)
    body = body + union(ears)
    # pivot hole
    body = body - cyl_y(0, PIVOT_Z, M5, -SAD_Y, SAD_Y)
    # tilt-lock arc slot behind the pivot
    pts = [180 - TILT + i * (2 * TILT) / 12 for i in range(13)]
    for i in range(len(pts) - 1):
        a0, a1 = math.radians(pts[i]), math.radians(pts[i + 1])
        c0 = cyl_y(LOCK_R * math.cos(a0), PIVOT_Z + LOCK_R * math.sin(a0), M5, -SAD_Y, SAD_Y)
        c1 = cyl_y(LOCK_R * math.cos(a1), PIVOT_Z + LOCK_R * math.sin(a1), M5, -SAD_Y, SAD_Y)
        body = body - Manifold.batch_hull([c0, c1])
    # clamp wings with vertical M5 holes for the through-bolts
    for sy in (-1, 1):
        wing = box(-WING_X, WING_X, min(sy * (SAD_Y - 5), sy * (BOLT_Y + 6)), max(sy * (SAD_Y - 5), sy * (BOLT_Y + 6)),
                   SAD_BOT, SAD_BOT + WING_T)
        body = body + wing
        body = body - cyl_z(0, sy * BOLT_Y, M5, SAD_BOT - 1, SAD_BOT + WING_T + 1)
    return body


# ---------------- 1b. lower jaw (V opening upward, apex at z = 0) ----------------
def lower():
    a = 120.0
    # outer V offset by the shell thickness (vertical offset = t * sqrt(2))
    off = LOW_SHELL * math.sqrt(2)
    outer = Manifold.cube([2 * LOW_X, a, a], True).rotate([45, 0, 0]).translate([0, 0, a / math.sqrt(2) - off])
    inner = Manifold.cube([2 * LOW_X + 2, a, a], True).rotate([45, 0, 0]).translate([0, 0, a / math.sqrt(2)])
    bound = box(-LOW_X, LOW_X, -(BOLT_Y + 6), BOLT_Y + 6, -off, LOW_TOP)
    body = (outer ^ bound) - inner
    for sy in (-1, 1):
        y0, y1 = sy * (BOLT_Y - 12), sy * (BOLT_Y + 6)
        wing = box(-LOW_X, LOW_X, min(y0, y1), max(y0, y1), LOW_TOP - WING_T, LOW_TOP)
        body = (body + wing) - inner
        body = body - cyl_z(0, sy * BOLT_Y, M5, LOW_TOP - WING_T - 1, LOW_TOP + 1)
    return body


# ---------------- 2. arm with rail and fixed jaw ----------------
def arm():
    t = TONGUE_T / 2
    tongue = cyl_y(0, 0, 11, -t, t) + cyl_y(-LOCK_R, 0, 8, -t, t) + box(-LOCK_R, 0, -t, t, -8, 8)
    column = box(CH_X - CH_IN / 2 - CH_WALL, -6, -t, t, 0, BASE_Z0) + box(-12, -2, -t, t, 0, 12)
    x_front0 = CH_X - CH_IN / 2 - CH_WALL
    x_front1 = CH_X - CH_IN / 2
    x_back0 = CH_X + CH_IN / 2
    x_back1 = CH_X + CH_IN / 2 + CH_WALL
    base = box(x_front0, x_back1, RAIL_Y0, FIX_FACE + 3, BASE_Z0, BASE_Z1)
    front = box(x_front0, x_front1, RAIL_Y0, FIX_FACE, BASE_Z1, BASE_Z1 + FRONT_H)
    back = box(x_back0, x_back1, RAIL_Y0, FIX_FACE, BASE_Z1, BASE_Z1 + BACK_H)
    rib = box(CH_X - 3, CH_X + 3, -50, 60, BASE_Z0 - 6, BASE_Z0)
    # fixed jaw
    jaw = box(x_front0, x_back1, FIX_FACE, FIX_FACE + 3, BASE_Z0, BASE_Z1 + JAW_H)
    jaw = jaw + box(x_front0, x_front1, FIX_FACE - LIP, FIX_FACE, BASE_Z1, BASE_Z1 + JAW_H)
    jaw = jaw + box(x_back0, x_back1, FIX_FACE - LIP, FIX_FACE, BASE_Z1, BASE_Z1 + BACK_LIP_H)
    body = union([tongue, column, base, front, back, rib, jaw])
    # holes: pivot + lock
    body = body - cyl_y(0, 0, M5, -t - 1, t + 1) - cyl_y(-LOCK_R, 0, M5, -t - 1, t + 1)
    # slot for the sliding-jaw bolt
    y_hi = FIX_FACE - PHONE_LEN_MIN - 10
    y_lo = FIX_FACE - PHONE_LEN_MAX - 10
    slot = Manifold.batch_hull([cyl_z(CH_X, y_lo - 2, M4, BASE_Z0 - 1, BASE_Z1 + 1), cyl_z(CH_X, y_hi + 2, M4, BASE_Z0 - 1, BASE_Z1 + 1)])
    body = body - slot
    return body


# ---------------- 3. sliding jaw (modelled with its face at y = 0, facing +Y) ----------------
def jaw():
    x_front0 = CH_X - CH_IN / 2 - CH_WALL
    x_front1 = CH_X - CH_IN / 2
    x_back0 = CH_X + CH_IN / 2
    x_back1 = CH_X + CH_IN / 2 + CH_WALL
    top = BASE_Z1 + max(FRONT_H, BACK_H) + 0.4  # plate clears the channel walls
    plate = box(x_front0, x_back1, -3, 0, top, BASE_Z1 + JAW_H)
    inner = box(x_front1 + CLR, x_back0 - CLR, -3, 0, BASE_Z1 + 0.2, top + 0.01)
    foot = box(x_front1 + CLR, x_back0 - CLR, -17, -3, BASE_Z1 + 0.2, BASE_Z1 + 4.2)
    lip_f = box(x_front0, x_front1, 0, LIP, top, BASE_Z1 + JAW_H)
    lip_b = box(x_back0, x_back1, 0, LIP, top, BASE_Z1 + BACK_LIP_H + 2)
    body = union([plate, inner, foot, lip_f, lip_b])
    body = body - cyl_z(CH_X, -10, M4, BASE_Z1 - 1, BASE_Z1 + 6)
    return body


# ---------------- export ----------------
def write_stl(m: Manifold, path: str):
    mesh = m.to_mesh()
    v = np.asarray(mesh.vert_properties)[:, :3]
    f = np.asarray(mesh.tri_verts)
    with open(path, "wb") as fh:
        fh.write(b"SmartTools dock".ljust(80, b" "))
        fh.write(struct.pack("<I", len(f)))
        for tri in f:
            a, b, c = v[tri[0]], v[tri[1]], v[tri[2]]
            n = np.cross(b - a, c - a)
            ln = np.linalg.norm(n)
            n = n / ln if ln > 0 else n
            fh.write(struct.pack("<12fH", *n, *a, *b, *c, 0))


def report(name, m):
    bb = m.bounding_box()
    dims = [bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]]
    print(f"{name:8s} tris {m.num_tri():6d}  genus {m.genus():2d}  volume {m.volume() / 1000:6.1f} cm3  "
          f"size {dims[0]:.0f} x {dims[1]:.0f} x {dims[2]:.0f} mm")


def render(parts, path):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    fig = plt.figure(figsize=(14, 5), dpi=110)
    views = [(20, -60, "3/4 view"), (0, 0, "from the bit (camera side)"), (0, -90, "side")]
    colors = {"saddle": "#f0a640", "arm": "#5ad8ff", "jaw": "#3ee59b", "lower": "#f0a640", "phone": "#cccccc"}
    for i, (el, az, title) in enumerate(views):
        ax = fig.add_subplot(1, 3, i + 1, projection="3d")
        for name, m in parts:
            mesh = m.to_mesh()
            v = np.asarray(mesh.vert_properties)[:, :3]
            f = np.asarray(mesh.tri_verts)
            pc = Poly3DCollection(v[f], alpha=0.35 if name == "phone" else 0.9, linewidths=0.05,
                                  edgecolors="#222", facecolors=colors[name])
            ax.add_collection3d(pc)
        ax.set_xlim(-110, 60); ax.set_ylim(-110, 110); ax.set_zlim(-90, 130)
        ax.set_box_aspect((170, 220, 220))
        ax.view_init(el, az)
        ax.set_title(title, fontsize=9)
        ax.set_axis_off()
    fig.tight_layout()
    fig.savefig(path)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    s, a, j, lo = saddle(), arm(), jaw(), lower()
    for name, m in (("saddle", s), ("arm", a), ("jaw", j), ("lower", lo)):
        report(name, m)
        write_stl(m, os.path.join(here, f"{name}.stl"))
    # assembly preview with a 162 x 75 x 8 mm phone (Redmi Note 13) and a 56 mm drill body
    phone_len = 162.2
    a_asm = a.translate([0, 0, PIVOT_Z])
    j_asm = j.translate([0, FIX_FACE - phone_len, PIVOT_Z])
    phone = box(CH_X - 4, CH_X + 4, FIX_FACE - phone_len, FIX_FACE, BASE_Z1, BASE_Z1 + 75).translate([0, 0, PIVOT_Z])
    R0 = 28.0
    drill = Manifold.cylinder(160, R0, R0, SEG, True).rotate([0, 90, 0]).translate([10, 0, -R0 * math.sqrt(2)])
    lo_asm = lo.translate([0, 0, -2 * R0 * math.sqrt(2)])
    asm = [("saddle", s), ("arm", a_asm), ("jaw", j_asm), ("lower", lo_asm), ("phone", phone), ("phone", drill)]
    # clamp range: body radius -> clearance between the two jaws and the bolt length needed
    print("clamp range (body Ø, gap between jaws, overlap jaws, overlap jaws/body, bolt length):")
    for r in (19.0, 22.0, 28.0, 34.0):
        cyl = Manifold.cylinder(160, r - 0.05, r - 0.05, SEG, True).rotate([0, 90, 0]).translate([0, 0, -r * math.sqrt(2)])
        l_r = lo.translate([0, 0, -2 * r * math.sqrt(2)])
        gap = SAD_BOT - (LOW_TOP - 2 * r * math.sqrt(2))
        bolt = WING_T + gap + WING_T + 8  # + washer and wing nut
        ov = (l_r ^ s).volume() / 1000
        ovb = ((l_r + s) ^ cyl).volume() / 1000
        print(f"  Ø{2 * r:4.0f} mm  gap {gap:5.1f} mm  overlap {ov:.3f} cm3  body {ovb:.3f} cm3  bolt >= {bolt:4.0f} mm")
    # interference check (should be ~0)
    print("overlap arm/saddle  cm3:", round((a_asm ^ s).volume() / 1000, 3))
    print("overlap jaw/arm     cm3:", round((j_asm ^ a_asm).volume() / 1000, 3))
    for deg in (-TILT, TILT):
        tilted = a.rotate([0, deg, 0]).translate([0, 0, PIVOT_Z])
        print(f"overlap at tilt {deg:+.0f}° cm3:", round((tilted ^ s).volume() / 1000, 3))
    render(asm, os.path.join(here, "preview.png"))
    print("wrote saddle.stl arm.stl jaw.stl lower.stl preview.png")
