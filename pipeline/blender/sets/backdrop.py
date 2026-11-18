"""What you see beyond the estate: the street outside the gate, treetops over the walls, far tower blocks.

None of it can be reached. The street and the trees get baked light like everything else; the far blocks
are tagged role="far" and are lit by plain sun and sky in the game (no light map, no bake time).
"""
from __future__ import annotations

import random

import bpy
from shapely.geometry import box

from assets import farblocks
from wc import geo, mat

from . import plan as P


# ---------------------------------------------------------------- far tower blocks

# The blocks themselves (places, sizes, how they are built) live in assets/farblocks.py so the stage job can
# show them on their own: run.py -- stage farblocks.
FAR_BLOCKS = farblocks.FAR_BLOCKS


def far_blocks(coll) -> None:
    farblocks.build_far_blocks(coll)


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
    def outside(p) -> bool:
        # leaves that would reach in over the wall (or through it) are left out
        return not (x0 - 0.6 < p.x < x1 + 0.6 and y0 - 0.6 < p.y < y1 + 0.6)

    for i, (x, y) in enumerate(spots):
        wood, crown, trunk, perch = foliage.build_tree(f"otree{i}", (x, y, 0.0), rng.uniform(9.5, 13.5), rng.uniform(0, 360), coll,
                                                       seed=100 + i, cards=1500, keep=outside)
        # only the crowns show over the walls: no trunk, no collision
        for o in (wood, trunk, perch):
            bpy.data.objects.remove(o, do_unlink=True)


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
