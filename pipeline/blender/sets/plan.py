"""The estate ground plan ("Sunny Court"), as 2D shapes. X = east, Y = north, metres.

Nothing here touches Blender; it only decides where things are. sets/estate.py turns
the plan into meshes, and the game reads the same numbers through world.json.

Rough picture:
        +--------------------------------------------------------------+  y = +34
        |  N1 block            N2 block              scooter shelter   |
        |  ..........................................................  |
        |  :  ring road (6 m wide), one-way loop                    :  |
  gate ==== :   +-----------+  alley  +--------------------------+ :P |
        |  :   | C1 block  |=========|   garden plaza: lawn,    | :a |
        |  :   +-----------+         |   trees, paved square    | :r |
        |  :   | C2 block  |         +--------------------------+ :k |
        |  ..........................................................  |
        |  garden | garden | HOME  | garden | garden | garden          |
        +--------------------------------------------------------------+  y = -34
      x = -52                                                      x = +52
"""
from __future__ import annotations

from dataclasses import dataclass, field

from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

# ---------------------------------------------------------------- key numbers
EST = (-52.0, -34.0, 52.0, 34.0)          # outer boundary (x0, y0, x1, y1)
RING_OUT = (-39.0, -21.0, 39.0, 21.0)     # outer kerb of the ring road
RING_IN = (-33.0, -15.0, 33.0, 15.0)      # inner kerb (edge of the middle island)
R_OUT, R_IN = 11.0, 5.0                   # corner radii
KERB_W, KERB_H = 0.15, 0.15
Z_ROAD, Z_PAVE, Z_LAWN, Z_BED, Z_DECK = 0.0, 0.14, 0.11, 0.10, 0.32
FLOOR_H = 3.0

HOME = (-8.0, -33.2, 2.0, -23.6)          # the player's garden plot
START = (-3.4, -30.4, 0.0)                # where the cat wakes up (on the deck)
START_HEADING = 10.0                      # degrees, 0 = north, clockwise


def rrect(x0: float, y0: float, x1: float, y1: float, r: float) -> Polygon:
    return box(x0 + r, y0 + r, x1 - r, y1 - r).buffer(r, quad_segs=8)


def strip(points, width: float) -> Polygon:
    return LineString(points).buffer(width / 2, cap_style="flat", join_style="round")


@dataclass
class Region:
    name: str
    geom: Polygon
    z: float
    mat: str
    kind: str = "ground"      # ground | bed (soil that hedges grow from) | lawn


@dataclass
class Building:
    name: str
    rect: tuple[float, float, float, float]
    floors: int
    style: str
    front: str                # side with the entrance: N, S, E or W


@dataclass
class Plan:
    regions: list[Region] = field(default_factory=list)
    buildings: list[Building] = field(default_factory=list)
    hedges: list[tuple[Polygon, float]] = field(default_factory=list)      # (footprint, height)
    walls: list[tuple[LineString, float, float, str]] = field(default_factory=list)  # (line, height, thickness, material)
    fences: list[tuple[LineString, float, str]] = field(default_factory=list)       # (line, height, style)
    kerb: Polygon | None = None
    kerb_yellow: Polygon | None = None
    lines: list[tuple[Polygon, str]] = field(default_factory=list)          # painted markings
    taken: Polygon = field(default_factory=Polygon)

    def claim(self, name: str, geom, z: float, mat: str, kind: str = "ground") -> Polygon:
        """Add an area; anything already claimed is cut away."""
        geom = geom.difference(self.taken).buffer(0)
        if geom.is_empty:
            return geom
        self.regions.append(Region(name, geom, z, mat, kind))
        self.taken = unary_union([self.taken, geom])
        return geom

    def reserve(self, geom) -> None:
        self.taken = unary_union([self.taken, geom])


def make_plan() -> Plan:
    p = Plan()
    estate = box(*EST)
    ring_out = rrect(*RING_OUT, R_OUT)
    island = rrect(*RING_IN, R_IN)

    # ---- buildings (their footprints are kept free of ground)
    p.buildings += [
        Building("C1", (-29.0, 3.0, -5.0, 12.0), 6, "tiles", "S"),
        Building("C2", (-29.0, -12.0, -5.0, -3.0), 6, "plaster", "N"),
        Building("N1", (-46.0, 25.2, -18.0, 33.4), 6, "plaster_yellow", "S"),
        Building("N2", (-10.0, 25.2, 18.0, 33.4), 5, "tiles", "S"),
        Building("GATEHOUSE", (-50.8, -12.5, -45.8, -6.5), 1, "plaster", "E"),
        Building("ROW", (-51.6, -39.5, 51.6, -33.6), 2, "terrace", "N"),  # terraced houses behind the gardens
    ]
    for b in p.buildings:
        p.reserve(box(*b.rect))

    # ---- asphalt
    ring = ring_out.difference(island)
    gate_road = box(EST[0], -3.0, RING_OUT[0] + 1.0, 3.0)
    bays = box(RING_OUT[2] - 0.5, -14.0, 44.5, 14.0)
    road = p.claim("road", unary_union([ring, gate_road]), Z_ROAD, "asphalt")
    bays = p.claim("bays", bays, Z_ROAD, "asphalt_old")
    asphalt = unary_union([road, bays])

    # ---- kerb stones wherever asphalt meets raised ground
    kerb = asphalt.buffer(KERB_W, join_style="mitre").difference(asphalt).intersection(estate)
    kerb = kerb.difference(unary_union([box(*b.rect) for b in p.buildings]))
    p.kerb = kerb
    p.kerb_yellow = unary_union([
        box(-20.0, -22.0, 6.0, -20.5),      # outer kerb in front of the gardens
        box(-40.0, 2.5, -38.0, 8.0),        # by the gate
        box(8.0, 14.0, 26.0, 16.0),         # inner kerb north of the plaza
    ])
    p.reserve(kerb)

    # ---- middle island
    p.claim("island_pave", island.difference(island.buffer(-1.8, join_style="round")), Z_PAVE, "pavers")
    p.claim("alley_lane", box(-31.3, -1.2, -4.0, 1.2), Z_PAVE, "concrete_floor")
    p.claim("alley_gravel", unary_union([box(-29.0, -3.0, -5.0, -1.2), box(-29.0, 1.2, -5.0, 3.0)]), 0.12, "gravel")
    square = p.claim("plaza_square", rrect(6.0, -6.0, 22.0, 6.0, 1.2), Z_PAVE, "pavers_square")
    paths = unary_union([
        strip([(-4.0, 0.0), (6.5, 0.0)], 1.6),                 # alley -> square
        strip([(21.5, 5.5), (27.5, 11.5), (31.5, 12.5)], 1.4),  # square -> north-east corner
        strip([(21.5, -5.5), (28.0, -11.0), (31.5, -12.5)], 1.4),
        strip([(14.0, 6.0), (14.0, 13.5)], 1.4),               # square -> north pavement
        strip([(14.0, -6.0), (14.0, -13.5)], 1.4),
        strip([(-3.0, -1.0), (-1.0, -13.5)], 1.2),             # alley mouth -> south pavement
    ])
    p.claim("plaza_paths", paths.intersection(island), Z_PAVE, "pavers")
    # planting strips against the two middle blocks
    around = unary_union([box(-29.0, 3.0, -5.0, 12.0), box(-29.0, -12.0, -5.0, -3.0)]).buffer(1.1, join_style="mitre")
    p.claim("block_beds", around.intersection(island.buffer(-1.8)), Z_BED, "wood_chips", "bed")
    # hedge line just inside the island pavement, with gaps where paths cross
    hedge_band = island.buffer(-1.8).difference(island.buffer(-2.75))
    gaps = unary_union([
        box(-33.0, -2.0, -30.0, 2.0),      # alley mouth, west
        box(12.6, 11.0, 15.4, 15.0), box(12.6, -15.0, 15.4, -11.0),
        Point(31.5, 12.5).buffer(2.0), Point(31.5, -12.5).buffer(2.0),
        box(-2.4, -15.0, 0.6, -11.0),
        box(-12.0, -15.0, -10.6, -11.0),   # a cat-sized hole in the hedge
        box(24.0, 11.0, 24.9, 15.0),
        box(-33.0, 6.5, -30.0, 8.0), box(-33.0, -8.0, -30.0, -6.5),
    ])
    hedge_band = hedge_band.difference(gaps).intersection(box(-33, -15, 33, 15))
    hedge_bed = p.claim("island_hedge_bed", hedge_band.buffer(0.12), Z_BED, "wood_chips", "bed")
    for part in getattr(hedge_band, "geoms", [hedge_band]):
        if part.area > 0.4:
            p.hedges.append((part.buffer(-0.05), 1.25))
    p.claim("plaza_lawn", island.buffer(-1.8), Z_LAWN, "grass", "lawn")

    # ---- outside the ring
    outer = estate.difference(ring_out)
    pave_out = ring_out.buffer(2.3, join_style="round").difference(ring_out).intersection(estate)
    p.claim("outer_pave", pave_out, Z_PAVE, "pavers")

    # north: entrance paths and lawn in front of the blocks
    for bx in (-39.0, -25.0, -3.0, 11.0):
        p.claim(f"entry_{bx:.0f}", box(bx - 1.2, 23.0, bx + 1.2, 25.2), Z_PAVE, "pavers_interlock")
    p.claim("shelter_pad", box(24.0, 24.2, 46.0, 32.0), Z_PAVE, "concrete_brushed")
    p.claim("north_beds", unary_union([box(-46.0, 24.2, -18.0, 25.2), box(-10.0, 24.2, 18.0, 25.2)]), Z_BED, "wood_chips", "bed")

    # south: garden plots between the pavement and the terraced houses
    plot_w = 10.0
    plots = []
    x = -48.0
    while x + plot_w <= 43.0:
        plots.append((x, -33.6, x + plot_w, -23.6))
        x += plot_w
    for i, (x0, y0, x1, y1) in enumerate(plots):
        home = abs(x0 - HOME[0]) < 0.1
        patio_mat = "deck" if home or i % 3 == 0 else ("pavers_red" if i % 3 == 1 else "pavers_interlock")
        patio_z = Z_DECK if patio_mat == "deck" else Z_PAVE
        p.claim(f"plot{i}_patio", box(x0 + 0.6, y0, x1 - 0.6, y0 + 3.6), patio_z, patio_mat)
        p.claim(f"plot{i}_bed", box(x0 + 0.15, y1 - 1.0, x1 - 0.15, y1 - 0.1), Z_BED, "wood_chips", "bed")
        p.claim(f"plot{i}_lawn", box(x0, y0, x1, y1), Z_LAWN, "grass", "lawn")
        # side fence between plots, front hedge or fence towards the pavement
        p.fences.append((LineString([(x1, y0), (x1, y1)]), 1.5, "slats"))
        gap_x = x0 + (4.6 if home else 7.5)
        if home or i % 2 == 0:
            front = box(x0 + 0.2, y1 - 0.95, x1 - 0.2, y1 - 0.15).difference(box(gap_x - 0.45, y1 - 2, gap_x + 0.45, y1 + 1))
            for part in getattr(front, "geoms", [front]):
                p.hedges.append((part, 1.15 if home else 1.35))
        else:
            p.fences.append((LineString([(x0, y1 - 0.2), (gap_x - 0.5, y1 - 0.2)]), 1.2, "slats"))
            p.fences.append((LineString([(gap_x + 0.5, y1 - 0.2), (x1, y1 - 0.2)]), 1.2, "slats"))
    p.fences.append((LineString([(plots[0][0], -33.6), (plots[0][0], -23.6)]), 1.5, "slats"))

    # east: lawn behind the parking bays;  west: bin store pad and gatehouse surroundings
    p.claim("bin_pad", box(-51.0, 6.0, -43.5, 13.0), Z_PAVE, "concrete_dirty")
    p.claim("gate_pave", unary_union([box(-52.0, 3.15, -41.0, 5.2), box(-52.0, -5.2, -41.0, -3.15)]), Z_PAVE, "pavers")
    p.claim("outer_lawn", outer, Z_LAWN, "grass", "lawn")

    # ---- walls: estate boundary (north, east, west; the south side is the row of houses)
    x0, y0, x1, y1 = EST
    p.walls += [
        (LineString([(x0, -33.6), (x0, -3.4)]), 2.4, 0.24, "plaster_painted"),
        (LineString([(x0, 3.4), (x0, y1), (x1, y1), (x1, -33.6)]), 2.4, 0.24, "plaster_painted"),
        # bin store: three low walls, open towards the road
        (LineString([(-43.5, 13.0), (-51.0, 13.0), (-51.0, 6.0), (-43.5, 6.0)]), 1.7, 0.2, "block_wall"),
    ]

    # ---- painted markings
    for k in range(1, 11):
        yb = -14.0 + k * (28.0 / 11.0)
        p.lines.append((box(39.6, yb - 0.05, 44.4, yb + 0.05), "line_white"))
    p.lines.append((box(39.45, -14.0, 39.57, 14.0), "line_white"))
    return p


if __name__ == "__main__":
    plan = make_plan()
    print(len(plan.regions), "regions;", len(plan.hedges), "hedges;", len(plan.fences), "fences")
