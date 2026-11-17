"""Everything that stands around on the estate: lamps, bins, benches, garden clutter, the car port, the gate.

Fixed things are built into the world and get baked light. Loose things the cat can knock about
("dynamic") are only listed here; the game creates them as physical objects.
"""
from __future__ import annotations

import math
import random

from shapely.geometry import MultiPoint, Point

from wc import geo, mat, ph

from . import plan as P


def _off(loc, rot_deg: float, dx: float, dy: float, dz: float = 0.0):
    a = math.radians(rot_deg)
    return (loc[0] + dx * math.cos(a) - dy * math.sin(a), loc[1] + dx * math.sin(a) + dy * math.cos(a), loc[2] + dz)


def _solid(name: str, objs, coll, pad: float = 0.0, surface: str = "metal", z_top: float | None = None) -> None:
    """Invisible collision shape: the outline of the objects seen from above, pushed up to their height."""
    pts, z0, z1 = [], 1e9, -1e9
    for o in objs:
        mw = o.matrix_world
        step = max(1, len(o.data.vertices) // 400)
        for vi in range(0, len(o.data.vertices), step):
            p = mw @ o.data.vertices[vi].co
            pts.append((p.x, p.y))
            z0, z1 = min(z0, p.z), max(z1, p.z)
    hull = MultiPoint(pts).convex_hull.buffer(pad)
    if hull.geom_type != "Polygon" or hull.area < 1e-4:
        return
    col = geo.extrude_polygon(f"{name}_col", hull.simplify(0.01), z0, z_top if z_top is not None else z1, None, coll,
                              cap_top=True, cap_bottom=True)
    geo.tag(col, role="collider", collide="mesh", surface=surface)
    col.hide_render = True


def _prop(objs, lm: float = 1.0) -> None:
    geo.tag(objs, role="prop", collide="none", lm=lm)


class Dresser:
    def __init__(self, plan: P.Plan, coll, window=None, seed: int = 5):
        self.plan = plan
        self.coll = coll
        self.window = window
        self.rng = random.Random(seed)
        self.dynamic: list[dict] = []
        from .estate import height_lookup

        self.h = height_lookup(plan)

    def inside(self, x: float, y: float) -> bool:
        return self.window is None or self.window.contains(Point(x, y))

    # ---- helpers
    def put(self, ph_id: str, x: float, y: float, rot: float = 0.0, part: str | None = None, scale: float = 1.0,
            solid: bool = True, lm: float = 1.0, dz: float = 0.0, surface: str = "metal", name: str | None = None):
        if not self.inside(x, y):
            return []
        objs = ph.place(ph_id, (x, y, self.h(x, y) + dz), rot, scale, self.coll, part=part, name=name or ph_id)
        _prop(objs, lm)
        if solid:
            _solid(f"{name or ph_id}_{len(self.coll.objects)}", objs, self.coll, surface=surface)
        return objs

    def loose(self, model: str, x: float, y: float, z: float | None = None, rot: float = 0.0, part: str | None = None,
              scale: float = 1.0, mass: float = 0.5, kind: str = "thing") -> None:
        """Something the cat can knock over. z = height of its underside (default: on the ground)."""
        if not self.inside(x, y):
            return
        self.dynamic.append({"model": model, "part": part, "pos": [x, y, self.h(x, y) if z is None else z], "rot": rot,
                             "scale": scale, "mass": mass, "kind": kind})

    # ---- street furniture
    def lamps(self) -> None:
        spots = [(-30, -23.9, 0), (-8, -23.9, 0), (14, -23.9, 0), (34, -23.4, 20), (41.6, -8, 90), (41.6, 8, 90),
                 (34, 23.4, 160), (12, 23.9, 180), (-12, 23.9, 180), (-34, 23.4, 200), (-41.6, 10, 270), (-41.6, -10, 270),
                 (16.2, 2.2, 0), (-17, 2.0, 90)]
        for i, (x, y, rot) in enumerate(spots):
            self.put("street_lamp_01", x, y, rot, lm=0.6, name=f"lamp{i}")

    def road_details(self) -> None:
        rng = self.rng
        for x, y in [(-22, -18.2), (5, -17.4), (30, -16.8), (36.8, 3), (10, 18.4), (-20, 17.6), (-36.6, -6), (-45, 0.6)]:
            if not self.inside(x, y):
                continue
            objs = ph.place("water_manhole_cover", (x, y, -0.062), rng.uniform(0, 360), 1.0, self.coll, name="manhole")
            _prop(objs, 1.0)
        # drain grates in the gutter: a steel frame with a dark slot pattern
        for x, y, rot in [(-14, -20.72, 0), (12, -20.72, 0), (-28, 20.72, 0), (22, 20.72, 0), (38.72, -12, 90), (-38.72, 14, 90)]:
            if not self.inside(x, y):
                continue
            w, d = (0.5, 0.3) if rot == 0 else (0.3, 0.5)
            grate = geo.box("drain", (x - w / 2, y - d / 2, -0.03), (x + w / 2, y + d / 2, 0.004), mat.get("metal_grate"), self.coll)
            _prop(grate)

    def utilities(self) -> None:
        self.put("fire_hydrant", -44.2, 15.2, 40, part="fire_hydrant_aged", name="hydrant")
        self.put("utility_box_02", -51.3, 16.5, 90, name="ubox_a")
        self.put("utility_box_01", -51.3, 18.2, 90, name="ubox_b")
        self.put("utility_box_01", 51.3, -22.0, 270, name="ubox_c")
        self.put("utility_box_02", 20.5, 33.2, 180, name="ubox_d")
        self.put("concrete_road_barrier", -49.5, 4.3, 5, name="barrier_a")
        self.put("concrete_road_barrier", -49.4, -4.3, 178, name="barrier_b")

    def bin_store(self) -> None:
        rng = self.rng
        for i, (x, y) in enumerate([(-50.0, 7.3), (-48.6, 7.2), (-50.1, 11.8), (-48.7, 12.0)]):
            # "..._rust" = one dented can with its handles and lid
            self.put("metal_trash_can", x, y, rng.uniform(0, 360), part="metal_trash_can_rust", name=f"bin{i}")
        for x, y, rot in [(-47.4, 7.4, 20), (-47.0, 12.1, 200), (-46.3, 11.6, 80), (-45.6, 7.0, 310)]:
            self.put("trashbag", x, y, rot, solid=True, surface="hedge", name="bag")
        self.put("old_tyre", -44.6, 12.3, 30, solid=True, dz=0.0, surface="hedge", name="tyre")
        self.put("plastic_crate_02", -45.4, 8.1, 15, name="crate_a")
        self.put("plastic_crate_02", -45.3, 8.15, 60, dz=0.25, solid=False, name="crate_b")
        self.loose("can_rusted", -46.6, 8.6, kind="can", mass=0.08)
        self.loose("can_rusted", -47.9, 9.9, kind="can", mass=0.08, rot=40)
        self.loose("plastic_bottle_gallon", -48.6, 10.6, kind="bottle", mass=0.12)
        self.loose("metal_trash_can", -49.0, 9.4, part="metal_trash_can_lid", kind="lid", mass=0.6)

    def plaza(self) -> None:
        # four benches around the paved square, planters at its corners
        # (kept clear of the footpaths, which the other cats run along)
        for x, y, rot in [(9.5, 6.9, 0), (18.5, -6.9, 180), (5.1, 3.4, 90), (22.9, -3.2, 270)]:
            if not self.inside(x, y):
                continue
            loc = (x, y, self.h(x, y))
            parts = []
            for dx in (-0.72, 0.72):
                parts += ph.place("modular_street_seating", _off(loc, rot, dx, 0.0), rot + 90, 1.0, self.coll, part="legs_double", name="bench_leg")
            parts += ph.place("modular_street_seating", _off(loc, rot, 0.0, 0.0, 0.44), rot, 1.0, self.coll, part="seat_bench", name="bench_seat")
            _prop(parts)
            _solid("bench", parts, self.coll, surface="wood")
        for x, y in [(6.6, 5.4), (21.4, 5.4), (6.6, -5.4), (21.4, -5.4)]:
            box_objs = self.put("planter_box_02", x, y, 0 if abs(y) > 5 else 90, surface="wood", name="planter")
            if box_objs:
                for dx in (-0.35, 0.0, 0.35):
                    pl = ph.place("potted_plant_01", (x + dx, y, self.h(x, y) + 0.2), self.rng.uniform(0, 360), 0.55, self.coll,
                                  part="potted_plant_01_leaves", name="planter_plant", ground=False)
                    _prop(pl)
        self.put("metal_trash_can", 23.3, 6.3, 0, part="metal_trash_can_rust", name="plaza_bin")
        self.loose("WetFloorSign_01", -5.6, 2.2, rot=25, kind="sign", mass=0.5)
        self.loose("football", 12.0, 2.0, part="football_inflated", kind="ball", mass=0.35)

    def gardens(self) -> None:
        """Clutter in the garden plots along the south side; the player's plot is the one at HOME."""
        rng = self.rng
        x = -48.0
        i = 0
        while x + 10.0 <= 43.0:
            x0, x1 = x, x + 10.0
            y_house, y_front = -33.6, -23.6
            home = abs(x0 - P.HOME[0]) < 0.1
            # pots along the house wall and on the patio
            self.put("potted_plant_02", x0 + 1.4, y_house + 0.6, rng.uniform(0, 360), surface="plaster", name="pot_big")
            self.put("potted_plant_01", x1 - 1.3, y_house + 0.7, rng.uniform(0, 360), surface="plaster", name="pot_tree")
            self.put("planter_box_01", x0 + 3.2, y_house + 3.9, 0, surface="wood", name="planter")
            # loose pots lined up on the planter edge and patio edge: perfect for a paw
            self.loose("potted_plant_04", x0 + 2.9, y_house + 3.9, z=self.h(x0 + 3.2, y_house + 3.9) + 0.42, kind="pot", mass=0.35)
            self.loose("planter_pot_clay", x0 + 3.5, y_house + 3.9, z=self.h(x0 + 3.2, y_house + 3.9) + 0.42, kind="pot", mass=0.45)
            if i % 2 == 0 or home:
                self.put("plastic_monobloc_chair_01", x0 + 6.3, y_house + 1.6, rng.uniform(150, 210), solid=True,
                         surface="hedge", name="chair")
                self.loose("watering_can_metal_01", x0 + 7.4, y_house + 2.9, rot=rng.uniform(0, 360), kind="can", mass=0.5)
            if i % 3 == 1:
                self.put("compost_bags", x1 - 1.6, y_front - 2.2, rng.uniform(0, 360), part="compost_bags_standing",
                         surface="hedge", name="compost")
                self.loose("garden_gnome", x0 + 5.0, y_front - 2.6, rot=rng.uniform(140, 220), kind="gnome", mass=1.2)
            if i % 3 == 2:
                self.loose("football", x0 + 4.5, y_front - 4.0, part="football_deflated", kind="ball", mass=0.25)
                self.put("concrete_cat_statue", x1 - 2.2, y_front - 1.6, rng.uniform(160, 200), surface="concrete", name="statue")
            if home:
                self.loose("ceramic_vase_03", x0 + 8.3, y_house + 3.2, kind="vase", mass=0.6)
                self.loose("football", x0 + 6.0, y_front - 3.4, part="football_inflated", kind="ball", mass=0.35)
            x += 10.0
            i += 1

    # ---- built structures
    def car_port(self) -> None:
        """Steel roof over the parking bays on the east side."""
        if not self.inside(42, 0):
            return
        steel = mat.get("galvanised")
        parts = []
        y = -13.6
        while y <= 13.7:
            parts.append(geo.box("port_post", (44.22, y - 0.06, 0.0), (44.34, y + 0.06, 2.55), steel, self.coll, bevel_w=0.006))
            beam = geo.box("port_beam", (39.7, y - 0.05, 2.38), (44.4, y + 0.05, 2.52), steel, self.coll, bevel_w=0.005)
            parts.append(beam)
            y += 27.2 / 5
        for yy in (-13.9, 0.0, 13.9):
            parts.append(geo.box("port_purlin", (39.75, yy - 0.04, 2.52), (39.83, yy + 0.04, 2.6), steel, self.coll))
        parts.append(geo.box("port_rail_a", (39.72, -14.0, 2.52), (39.8, 14.0, 2.58), steel, self.coll))
        parts.append(geo.box("port_rail_b", (44.3, -14.0, 2.52), (44.38, 14.0, 2.58), steel, self.coll))
        roof = geo.box("port_roof", (39.5, -14.2, 2.58), (44.6, 14.2, 2.62), mat.get("corrugated"), self.coll)
        _prop(parts, 0.7)
        _prop(roof, 0.25)
        col = geo.boxes("port_col", [((44.2, -13.66 + k * 27.2 / 5, 0.0), (44.36, -13.54 + k * 27.2 / 5, 2.5)) for k in range(6)], None, self.coll)
        geo.tag(col, role="collider", collide="mesh", surface="metal")
        col.hide_render = True

    def gate(self) -> None:
        """Closed sliding gate on the west side, between two piers."""
        if not self.inside(-51.5, 0):
            return
        x = P.EST[0]
        for y in (-3.65, 3.65):
            pier = geo.box("gate_pier", (x - 0.3, y - 0.3, -0.1), (x + 0.3, y + 0.3, 2.7), mat.get("plaster_painted"), self.coll, bevel_w=0.012)
            cap = geo.box("gate_pier_cap", (x - 0.36, y - 0.36, 2.7), (x + 0.36, y + 0.36, 2.78), mat.get("concrete_brushed"), self.coll, bevel_w=0.01)
            _prop([pier, cap])
            geo.tag(pier, collide="mesh")
        bars = []
        yy = -3.3
        while yy <= 3.31:
            bars.append(((x + 0.05, yy - 0.011, 0.09), (x + 0.072, yy + 0.011, 2.1)))
            yy += 0.115
        for z in (0.08, 1.1, 2.08):
            bars.append(((x + 0.04, -3.35, z), (x + 0.085, 3.35, z + 0.05)))
        g = geo.boxes("gate_bars", bars, mat.get("paint_green"), self.coll)
        _prop(g)
        track = geo.box("gate_track", (x + 0.03, -3.4, 0.0), (x + 0.1, 3.4, 0.02), mat.get("steel_dark"), self.coll)
        _prop(track)
        col = geo.box("gate_col", (x - 0.02, -3.4, 0.0), (x + 0.12, 3.4, 2.2), None, self.coll)
        geo.tag(col, role="collider", collide="mesh", surface="metal")
        col.hide_render = True

    def bike_racks(self) -> None:
        """Steel hoops on the pad in the north-east corner."""
        steel = mat.get("galvanised")
        for k in range(7):
            x = 27.0 + k * 1.1
            y = 26.0
            if not self.inside(x, y):
                continue
            z = self.h(x, y)
            hoop = [
                geo.cylinder("rack", 0.022, (x, y - 0.35, z), (x, y - 0.35, z + 0.78), steel, self.coll, segments=10),
                geo.cylinder("rack", 0.022, (x, y + 0.35, z), (x, y + 0.35, z + 0.78), steel, self.coll, segments=10),
                geo.cylinder("rack", 0.022, (x, y - 0.36, z + 0.78), (x, y + 0.36, z + 0.78), steel, self.coll, segments=10),
            ]
            _prop(hoop)
            col = geo.box("rack_col", (x - 0.03, y - 0.38, z), (x + 0.03, y + 0.38, z + 0.8), None, self.coll)
            geo.tag(col, role="collider", collide="mesh", surface="metal")
            col.hide_render = True

    def speed_bumps(self) -> None:
        for x in (-24.0, 20.0):
            for y0, y1 in ((-21.0, -15.0), (15.0, 21.0)):
                yc = (y0 + y1) / 2
                if not self.inside(x, yc):
                    continue
                profile = [(-0.22, 0.0), (0.22, 0.0), (0.16, 0.035), (0.06, 0.05), (-0.06, 0.05), (-0.16, 0.035)]
                bump = geo.sweep("speed_bump", profile, [(x, y0 + 0.2), (x, y1 - 0.2)], mat.get("rubber"), self.coll)
                geo.uv_box(bump)
                _prop(bump)
                geo.tag(bump, collide="mesh", surface="asphalt")

    def covered_cars(self) -> None:
        for k, y in ((1, -14.0 + 1.5 * 28 / 11), (6, -14.0 + 6.5 * 28 / 11)):
            x = 42.1
            if not self.inside(x, y):
                continue
            objs = ph.place("covered_car", (x, y, 0.0), 90 + self.rng.uniform(-3, 3), 1.0, self.coll, name=f"covered{k}")
            geo.tag(objs, role="vehicle", collide="none", lm=1.0)
            body = [o for o in objs if "wheel" not in o.data.name]
            _solid(f"covered{k}", body, self.coll, pad=-0.05, surface="hedge")

    def vehicles(self) -> None:
        """Parked cars under the car port and along the kerb, scooters, bikes at the racks."""
        from assets import vehicles

        def park(kind: str, key: str, colour: str, x: float, y: float, rot: float, seed: int) -> None:
            if not self.inside(x, y):
                return
            name = f"{kind}_{key}"
            if kind == "car":
                parts = vehicles.build_car(name, key.split("_")[0], colour, self.coll, seed=seed)
            elif kind == "scooter":
                parts = vehicles.build_scooter(name, colour, self.coll, seed=seed)
            else:
                parts = vehicles.build_bicycle(name, colour, self.coll, seed=seed)
            geo.place(parts, (x, y, self.h(x, y)), rot + self.rng.uniform(-2.5, 2.5))
            for o in parts:
                if o.get("wc_role") == "collider":
                    o["wc_surface"] = "metal"

        bay = 28.0 / 11
        # car port: nose to the road. Bays 1 and 6 hold the covered cars; 2, 7 and 9 stay free (cat paths, Duchess)
        for k, style, paint in ((0, "hatch", "car_red"), (3, "sedan", "car_silver"), (4, "van", "car_white"),
                                (5, "micro", "car_blue"), (8, "hatch", "car_grey"), (10, "sedan", "car_black")):
            park("car", f"{style}_port{k}", paint, 42.15 + self.rng.uniform(-0.2, 0.25), -14.0 + (k + 0.5) * bay, 90.0, k)
        # along the kerb of the ring road, well clear of its centre line
        park("car", "sedan_south", "car_blue", -19.5, -20.05, -90.0, 21)
        park("car", "micro_south", "car_white", 12.5, -20.2, 90.0, 22)
        park("car", "van_north", "car_grey", -9.0, 20.0, 90.0, 23)
        park("car", "hatch_west", "car_silver", -38.05, 9.5, 0.0, 24)
        # scooters on the pavement and by the racks, bikes at the racks
        park("scooter", "south", "paint_red", 9.2, -22.75, 96.0, 31)
        park("scooter", "pad_a", "paint_white", 24.6, 26.1, 172.0, 32)
        park("scooter", "pad_b", "paint_blue", 25.6, 26.25, 187.0, 33)
        for k, colour in ((0, "paint_green"), (2, "paint_black"), (3, "paint_blue"), (5, "paint_red")):
            park("bike", f"rack{k}", colour, 27.0 + k * 1.1 + 0.22, 26.05, 4.0 if k % 2 else 184.0, 40 + k)

    def all(self) -> list[dict]:
        self.lamps()
        self.road_details()
        self.utilities()
        self.bin_store()
        self.plaza()
        self.gardens()
        self.car_port()
        self.gate()
        self.bike_racks()
        self.speed_bumps()
        self.covered_cars()
        self.vehicles()
        return self.dynamic
