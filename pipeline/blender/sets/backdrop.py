"""What you see beyond the estate: the street outside the gate, treetops over the walls, far tower blocks.

None of it can be reached. The street and the trees get baked light like everything else; the far blocks
are tagged role="far" and are lit by plain sun and sky in the game (no light map, no bake time).
"""
from __future__ import annotations

import random

import bpy
from shapely.geometry import box

from wc import geo, mat

from . import plan as P

FLOOR_H = 2.85


# ---------------------------------------------------------------- far tower blocks

# (x, y, width, depth, floors, style, turn in degrees). Width runs along local X; the balconies face local -Y.
FAR_BLOCKS = [
    (-78.0, 96.0, 40.0, 13.0, 12, "white", 186.0),
    (6.0, 124.0, 48.0, 13.0, 15, "tile", 175.0),
    (88.0, 92.0, 36.0, 13.0, 11, "yellow", 204.0),
    (128.0, 18.0, 44.0, 13.0, 14, "white", 262.0),
    (112.0, -58.0, 36.0, 13.0, 10, "tile", 300.0),
    (48.0, -112.0, 50.0, 13.0, 16, "white", -8.0),
    (-36.0, -98.0, 42.0, 13.0, 13, "yellow", 5.0),
    (-4.0, -168.0, 46.0, 13.0, 18, "tile", 0.0),
    (-124.0, -34.0, 40.0, 13.0, 12, "tile", 96.0),
    (-110.0, 52.0, 44.0, 13.0, 14, "white", 78.0),
    (-150.0, 128.0, 40.0, 13.0, 17, "yellow", 135.0),
    (160.0, 120.0, 40.0, 13.0, 16, "tile", 225.0),
]

_FAR_STYLE = {
    "white": ("plaster_white", "paint_grey"),
    "yellow": ("plaster_yellow", "paint_white"),
    "tile": ("facade_tiles", "paint_white"),
}


def far_block(name: str, w: float, d: float, floors: int, style: str, coll, rng: random.Random) -> list:
    """A plain slab block seen from far away: body, window panes, balconies, roof clutter. Centred on the origin."""
    wall, panel = _FAR_STYLE[style]
    h = floors * FLOOR_H + 0.6
    parts = [geo.box(f"{name}_body", (-w / 2, -d / 2, -1.0), (w / 2, d / 2, h), mat.get(wall), coll)]
    bays = max(3, int(w // 3.4))
    bay = w / bays
    glass = {"a": [], "b": [], "c": []}
    slabs, fronts, frames = [], [], []
    for f in range(floors):
        zf = 0.6 + f * FLOOR_H
        for b in range(bays):
            xc = -w / 2 + (b + 0.5) * bay
            key = rng.choice("aabbc")
            # front: wide glazing behind a balcony on most bays, a plain window on the stair bays
            stair = b % 4 == 2
            if stair:
                glass["b"].append(((xc - 0.55, -d / 2 - 0.03, zf + 1.2), (xc + 0.55, -d / 2, zf + 2.3)))
            else:
                glass[key].append(((xc - bay * 0.36, -d / 2 - 0.03, zf + 0.25), (xc + bay * 0.36, -d / 2, zf + 2.35)))
                slabs.append(((xc - bay / 2 + 0.06, -d / 2 - 1.3, zf - 0.14), (xc + bay / 2 - 0.06, -d / 2, zf)))
                fronts.append(((xc - bay / 2 + 0.06, -d / 2 - 1.3, zf), (xc + bay / 2 - 0.06, -d / 2 - 1.24, zf + 1.02)))
            # back: ordinary windows
            ww = 0.7 if stair else 1.5
            glass[rng.choice("aabbc")].append(((xc - ww / 2, d / 2, zf + 0.95), (xc + ww / 2, d / 2 + 0.03, zf + 2.3)))
            frames.append(((xc - ww / 2 - 0.06, d / 2, zf + 0.87), (xc + ww / 2 + 0.06, d / 2 + 0.05, zf + 0.95)))
    # the two end walls: one column of small windows
    for f in range(floors):
        zf = 0.6 + f * FLOOR_H
        for sx in (-1, 1):
            x = sx * w / 2
            glass["b"].append(((min(x, x + sx * 0.03), -0.5, zf + 1.1), (max(x, x + sx * 0.03), 0.5, zf + 2.3)))
    for key, material in (("a", "glass_window"), ("b", "glass_blind_grey"), ("c", "glass_curtain_cream")):
        if glass[key]:
            parts.append(geo.boxes(f"{name}_glass_{key}", glass[key], mat.get(material), coll))
    if slabs:
        parts.append(geo.boxes(f"{name}_slabs", slabs, mat.get("concrete_brushed"), coll))
        parts.append(geo.boxes(f"{name}_fronts", fronts, mat.get(panel), coll))
    parts.append(geo.boxes(f"{name}_sills", frames, mat.get("concrete_brushed"), coll))
    # roof: rim, lift houses, a water tank
    t = 0.25
    rim = [((-w / 2, -d / 2, h), (w / 2, -d / 2 + t, h + 0.9)), ((-w / 2, d / 2 - t, h), (w / 2, d / 2, h + 0.9)),
           ((-w / 2, -d / 2, h), (-w / 2 + t, d / 2, h + 0.9)), ((w / 2 - t, -d / 2, h), (w / 2, d / 2, h + 0.9))]
    parts.append(geo.boxes(f"{name}_rim", rim, mat.get(wall), coll))
    huts = []
    for k in range(max(1, bays // 4)):
        xc = -w / 2 + (k * 4 + 2.5) * bay
        if xc + 2.5 < w / 2:
            huts.append(((xc - 2.4, -2.0, h), (xc + 2.4, 2.6, h + 2.7)))
    parts.append(geo.boxes(f"{name}_huts", huts, mat.get("concrete_wall"), coll))
    tx = rng.uniform(-w / 2 + 4, w / 2 - 4)
    parts.append(geo.cylinder(f"{name}_tank", 1.1, (tx, 3.4, h), (tx, 3.4, h + 2.2), mat.get("galvanised"), coll, segments=14))
    return parts


def far_blocks(coll) -> None:
    rng = random.Random(41)
    for i, (x, y, w, d, floors, style, turn) in enumerate(FAR_BLOCKS):
        parts = far_block(f"far{i}", w, d, floors, style, coll, rng)
        geo.place(parts, (x, y, 0.0), turn)
        geo.tag(parts, role="far", collide="none")


# ---------------------------------------------------------------- treetops over the walls

def outer_trees(coll) -> None:
    from assets import foliage

    rng = random.Random(23)
    x0, y0, x1, y1 = P.EST
    spots = []
    x = x0 + 6.0
    while x < x1 - 2:                       # north, just behind the wall
        spots.append((x + rng.uniform(-2, 2), y1 + rng.uniform(3.0, 6.5)))
        x += rng.uniform(11.0, 16.0)
    y = y0 + 8.0
    while y < y1 - 2:                       # east
        spots.append((x1 + rng.uniform(3.0, 6.5), y + rng.uniform(-2, 2)))
        y += rng.uniform(12.0, 17.0)
    x = x0 + 3.0
    while x < x1:                           # south, behind the row of houses
        spots.append((x + rng.uniform(-2, 2), y0 - rng.uniform(4.0, 8.0)))
        x += rng.uniform(13.0, 19.0)
    for y in (-58.0, -41.0, -27.0, -12.0, 13.0, 29.0, 46.0, 62.0):   # west, behind the wall across the street
        spots.append((STREET_X0 - rng.uniform(3.0, 6.0), y + rng.uniform(-2, 2)))
    for i, (x, y) in enumerate(spots):
        wood, crown, trunk = foliage.build_tree(f"otree{i}", (x, y, 0.0), rng.uniform(9.5, 13.5), rng.uniform(0, 360), coll,
                                                seed=100 + i, cards=1500)
        # only the crowns show over the walls: no trunk, no collision
        bpy.data.objects.remove(wood, do_unlink=True)
        bpy.data.objects.remove(trunk, do_unlink=True)


# ---------------------------------------------------------------- the street outside the gate

STREET_X0 = -65.0        # far kerb line of the street (the estate wall is at EST x0 = -52)
STREET_Y = 78.0          # the street runs this far north and south


def street(coll) -> None:
    ex = P.EST[0]
    lm = 0.3
    road = box(STREET_X0 + 2.0, -STREET_Y, ex - 2.0, STREET_Y).union(box(ex - 2.0, -3.6, ex, 3.6))
    r = geo.flat_polygon("out_road", road, 0.0, mat.get("asphalt_old"), coll)
    near = box(ex - 2.0, -STREET_Y, ex - 0.12, STREET_Y).difference(box(ex - 2.5, -3.6, ex, 3.6))
    far = box(STREET_X0, -STREET_Y, STREET_X0 + 2.0, STREET_Y)
    made = [r]
    for i, poly in enumerate(geo.polygons_of(near) + [far]):
        made.append(geo.extrude_polygon(f"out_pave_{i}", poly, 0.0, P.Z_PAVE, mat.get("pavers"), coll, cap_top=True))
    # the wall across the street, and the two ends of the street
    made.append(geo.box("out_wall", (STREET_X0 - 0.25, -STREET_Y, -0.1), (STREET_X0, STREET_Y, 2.7), mat.get("block_wall"), coll))
    made.append(geo.box("out_wall_cap", (STREET_X0 - 0.3, -STREET_Y, 2.7), (STREET_X0 + 0.05, STREET_Y, 2.78), mat.get("concrete_brushed"), coll))
    for sy in (-1, 1):
        made.append(geo.box(f"out_end_{sy}", (STREET_X0, sy * STREET_Y, -0.1), (ex, sy * (STREET_Y + 0.3), 3.2), mat.get("plaster_painted"), coll))
    # centre line dashes
    xc = (STREET_X0 + 2.0 + ex - 2.0) / 2
    dashes = [((xc - 0.06, y, 0.0), (xc + 0.06, y + 2.0, 0.004)) for y in range(-int(STREET_Y) + 2, int(STREET_Y) - 2, 6)]
    made.append(geo.boxes("out_dashes", dashes, mat.get("paint_white"), coll))
    geo.tag([m for m in made if m is not None], role="prop", collide="none", lm=lm)
    # street lamps and a few parked cars, seen through the gate bars
    from wc import ph

    for y in (-30.0, 6.0, 42.0):
        objs = ph.place("street_lamp_01", (STREET_X0 + 0.9, y, P.Z_PAVE), 0.0, 1.0, coll, name=f"out_lamp_{int(y)}")
        geo.tag(objs, role="prop", collide="none", lm=lm)
    try:
        from assets import vehicles
    except Exception as err:                                  # the cars are optional scenery here
        print("[build] no cars outside:", err)
        return
    parked = [("hatch", "car_silver", STREET_X0 + 3.05, -7.5, 180.0), ("sedan", "car_black", STREET_X0 + 3.05, 9.0, 180.0),
              ("van", "car_white", ex - 3.1, 14.5, 0.0), ("micro", "car_red", ex - 3.0, -12.0, 0.0)]
    for i, (style, paint, x, y, turn) in enumerate(parked):
        parts = vehicles.build_car(f"out_car{i}", style, paint, coll, seed=50 + i)
        geo.place(parts, (x, y, 0.0), turn)
        for o in parts:
            if o.get("wc_role") == "collider":
                o["wc_collide"] = "none"
            else:
                o["wc_lm"] = lm


def build(coll) -> None:
    street(coll)
    outer_trees(coll)
    far_blocks(coll)
    print("[build] backdrop: street, trees over the walls, far blocks")
