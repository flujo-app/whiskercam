"""Turn the ground plan (sets/plan.py) into meshes."""
from __future__ import annotations

import json
import math
import random

import bpy
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from assets import foliage
from wc import bake, geo, mat, ph

from . import plan as P


def _clip(geom, window):
    return geom if window is None else geom.intersection(window)


def _tag(obj, **props):
    if obj is not None:
        for key, val in props.items():
            obj[f"wc_{key}"] = val
    return obj


# ---------------------------------------------------------------- ground

def build_ground(plan: P.Plan, coll, window=None) -> None:
    for reg in plan.regions:
        geom = _clip(reg.geom, window)
        if geom.is_empty:
            continue
        # cut into light-map tiles (see wc.bake): each piece knows which tile it belongs to
        x0, y0, x1, y1 = geom.bounds
        ex0, ey0 = P.EST[0], P.EST[1]
        for ix in range(int((x0 - ex0) // bake.TILE), int((x1 - ex0) // bake.TILE) + 1):
            for iy in range(int((y0 - ey0) // bake.TILE), int((y1 - ey0) // bake.TILE) + 1):
                cell = box(ex0 + ix * bake.TILE, ey0 + iy * bake.TILE, ex0 + (ix + 1) * bake.TILE, ey0 + (iy + 1) * bake.TILE)
                top = geo.flat_polygon(f"g_{reg.name}_{ix}_{iy}", geom.intersection(cell), reg.z, mat.get(reg.mat), coll)
                _tag(top, role="ground", collide="mesh", surface=reg.mat, tile=f"{ix}_{iy}")
        if reg.z > 0.02:
            skirt = geo.extrude_polygon(f"gs_{reg.name}", geom, reg.z - 0.3, reg.z, mat.get(reg.mat), coll, cap_top=False)
            _tag(skirt, role="skirt", collide="none")


def build_kerbs(plan: P.Plan, coll, window=None) -> None:
    kerb = _clip(plan.kerb, window)
    yellow = kerb.intersection(plan.kerb_yellow)
    plain = kerb.difference(plan.kerb_yellow)
    for name, geom, material in (("kerb", plain, "concrete_brushed"), ("kerb_yellow", yellow, "kerb_yellow")):
        if geom.is_empty:
            continue
        obj = geo.extrude_polygon(name, geom, -0.2, P.KERB_H, _kerb_mat(material), coll, bevel_w=0.012)
        _tag(obj, role="kerb", collide="mesh", surface="concrete")


def _kerb_mat(name: str):
    if name != "kerb_yellow":
        return mat.get(name)
    m = bpy.data.materials.get(name)
    if m is None:
        m = mat.flat(name, (0.78, 0.56, 0.05), 0.6)
        m["wc"] = '{"kind": "tile", "ph": "brushed_concrete", "size": 2.0, "paint": [0.80, 0.58, 0.06], "paint_wear": 0.45}'
    return m


def build_lines(plan: P.Plan, coll, window=None) -> None:
    for i, (geom, kind) in enumerate(plan.lines):
        geom = _clip(geom, window)
        if geom.is_empty:
            continue
        m = bpy.data.materials.get(kind)
        if m is None:
            color = (0.80, 0.80, 0.78) if kind == "line_white" else (0.80, 0.58, 0.06)
            m = mat.flat(kind, color, 0.55)
            m["wc"] = '{"kind": "roadpaint", "color": [%.2f, %.2f, %.2f], "wear": 0.5}' % color
        obj = geo.flat_polygon(f"line_{i}", geom, 0.003, m, coll)
        _tag(obj, role="decal", collide="none")


# ---------------------------------------------------------------- walls, fences, hedges

def build_walls(plan: P.Plan, coll, window=None) -> None:
    for i, (line, height, thick, material) in enumerate(plan.walls):
        body = _clip(line.buffer(thick / 2, cap_style="flat", join_style="mitre"), window)
        if body.is_empty:
            continue
        wall = geo.extrude_polygon(f"wall_{i}", body, -0.1, height, mat.get(material), coll, cap_top=True)
        _tag(wall, role="wall", collide="mesh")
        cap = _clip(line.buffer(thick / 2 + 0.035, cap_style="flat", join_style="mitre"), window)
        coping = geo.extrude_polygon(f"wall_cap_{i}", cap, height, height + 0.07, mat.get("concrete_brushed"), coll,
                                     cap_bottom=True, bevel_w=0.008)
        _tag(coping, role="wall", collide="none")


def build_fences(plan: P.Plan, coll, window=None) -> None:
    rng = random.Random(7)
    for i, (line, height, style) in enumerate(plan.fences):
        if window is not None and not line.intersects(window):
            continue
        (ax, ay), (bx, by) = line.coords[0], line.coords[-1]
        length = math.hypot(bx - ax, by - ay)
        ux, uy = (bx - ax) / length, (by - ay) / length
        horizontal = abs(ux) > abs(uy)
        n_span = max(1, round(length / 1.9))
        span = length / n_span
        posts, slats = [], []
        for k in range(n_span + 1):
            px, py = ax + ux * span * k, ay + uy * span * k
            posts.append(((px - 0.045, py - 0.045, -0.05), (px + 0.045, py + 0.045, height + 0.04)))
        z = 0.12
        while z < height - 0.02:
            gap = 0.018 + rng.random() * 0.004
            if horizontal:
                slats.append(((min(ax, bx), ay - 0.07, z), (max(ax, bx), ay - 0.05, z + 0.092)))
            else:
                slats.append(((ax - 0.07, min(ay, by), z), (ax - 0.05, max(ay, by), z + 0.092)))
            z += 0.092 + gap
        _tag(geo.boxes(f"fence_posts_{i}", posts, mat.get("planks_grey"), coll), role="fence", collide="none")
        _tag(geo.boxes(f"fence_slats_{i}", slats, mat.get("planks_weathered"), coll), role="fence", collide="none")
        _tag(geo.oriented_box(f"fence_col_{i}", (ax, ay), (bx, by), 0.1, 0.0, height, None, coll), role="collider", collide="mesh")


def build_hedges(plan: P.Plan, coll, window=None) -> list[tuple[Polygon, float]]:
    """Each hedge = a dark inner volume, a cloud of leaf cards around it, and a soft collider."""
    out = []
    for i, (foot, height) in enumerate(plan.hedges):
        foot = _clip(foot, window)
        if foot.is_empty or foot.area < 0.2:
            continue
        core = foot.buffer(-0.16, join_style="round")
        if not core.is_empty:
            obj = geo.extrude_polygon(f"hedge_core_{i}", core, 0.05, height - 0.16, mat.get("hedge_core"), coll)
            _tag(obj, role="hedge_core", collide="none")
        _tag(geo.extrude_polygon(f"hedge_col_{i}", foot.buffer(-0.08), 0.0, height - 0.05, None, coll),
             role="collider", collide="mesh", soft=1)
        for k, piece in enumerate(geo.polygons_of(foot)):
            foliage.build_hedge(f"hedge_{i}_{k}", piece, height, coll, seed=i)
        out.append((foot, height))
    return out


# ---------------------------------------------------------------- trees

def build_trees(plan: P.Plan, coll, window=None) -> None:
    h = height_lookup(plan)
    for i, (x, y, height, turn) in enumerate(plan.trees):
        if window is not None and not window.buffer(8).contains(Point(x, y)):
            continue
        foliage.build_tree(f"tree_{i}", (x, y, h(x, y) - 0.05), height, turn, coll, seed=i)


# ---------------------------------------------------------------- weeds

def height_lookup(plan: P.Plan):
    """Function (x, y) -> ground height, from the plan's areas."""
    from shapely.strtree import STRtree

    geoms = [r.geom for r in plan.regions]
    tree = STRtree(geoms)

    def height_at(x: float, y: float) -> float:
        pt = Point(x, y)
        for idx in tree.query(pt):
            if geoms[idx].contains(pt):
                return plan.regions[idx].z
        return 0.0

    return height_at


def build_weeds(plan: P.Plan, coll, window=None) -> None:
    """Tufts in the kerb joints, weeds along walls and fences, a few loose ones on the lawns."""
    rng = random.Random(11)
    h = height_lookup(plan)
    kerb_edges = geo.lines_of(plan.kerb.boundary)
    n = foliage.scatter_along(kerb_edges, 0.16, "crack", h, coll, rng, 0.02, window)
    wall_lines = [w[0].parallel_offset(w[2] / 2 + 0.03, side) for w in plan.walls for side in ("left", "right")]
    n += foliage.scatter_along([ln for g in wall_lines for ln in geo.lines_of(g)], 0.45, "edge", h, coll, rng, 0.04, window)
    fence_lines = [f[0].parallel_offset(0.09, side) for f in plan.fences for side in ("left", "right")]
    n += foliage.scatter_along([ln for g in fence_lines for ln in geo.lines_of(g)], 0.5, "edge", h, coll, rng, 0.05, window)
    block_edges = [box(*b.rect).buffer(0.05).exterior for b in plan.buildings]
    n += foliage.scatter_along(block_edges, 0.3, "edge", h, coll, rng, 0.04, window)
    hedge_edges = [p.exterior for foot, _ in plan.hedges for p in geo.polygons_of(foot.buffer(0.06))]
    n += foliage.scatter_along(hedge_edges, 0.35, "shade", h, coll, rng, 0.05, window)
    for reg in plan.regions:
        if reg.kind == "lawn":
            n += foliage.scatter_area(reg.geom, 0.045, "lawn", h, coll, rng, window)
    print(f"[build] {n} weeds")


# ---------------------------------------------------------------- stand-in buildings (replaced by assets/building.py)

def build_block_placeholders(plan: P.Plan, coll, window=None) -> None:
    styles = {"tiles": "facade_tiles", "plaster": "plaster_white", "plaster_yellow": "plaster_yellow",
              "terrace": "bricks_white"}
    for b in plan.buildings:
        rect = box(*b.rect)
        if window is not None and not rect.intersects(window.buffer(30)):
            continue
        height = b.floors * P.FLOOR_H + 0.9
        obj = geo.extrude_polygon(f"block_{b.name}", rect, -0.1, height, mat.get(styles[b.style]), coll)
        _tag(obj, role="building", collide="mesh")


def build_blocks(plan: P.Plan, coll, window=None) -> None:
    """The real houses (assets/buildings.py)."""
    from assets import buildings

    for i, b in enumerate(plan.buildings):
        rect = box(*b.rect)
        if window is not None and not rect.intersects(window.buffer(30)):
            continue
        buildings.build_block(b.name, b.rect, b.floors, b.style, b.front, coll, seed=i, grade=0.12)


def build(sc, window=None, placeholders: bool = False) -> P.Plan:
    plan = P.make_plan()
    win = None if window is None else box(*window)
    coll = geo.collection("estate")
    build_ground(plan, geo.collection("ground", coll), win)
    build_kerbs(plan, geo.collection("kerbs", coll), win)
    build_lines(plan, geo.collection("lines", coll), win)
    build_walls(plan, geo.collection("walls", coll), win)
    build_fences(plan, geo.collection("fences", coll), win)
    build_hedges(plan, geo.collection("hedges", coll), win)
    build_trees(plan, geo.collection("trees", coll), win)
    build_weeds(plan, geo.collection("weeds", coll), win)
    if placeholders:
        build_block_placeholders(plan, geo.collection("blocks", coll), win)
    else:
        build_blocks(plan, geo.collection("blocks", coll), win)
    from . import dressing

    loose = dressing.Dresser(plan, geo.collection("props", coll), win).all()
    sc["wc_loose"] = json.dumps(loose)
    if win is None:
        from . import backdrop

        backdrop.build(geo.collection("backdrop", coll))
    print(f"[build] {len(loose)} loose things")
    # collider-only helpers never render
    for obj in bpy.data.objects:
        if obj.get("wc_role") == "collider":
            obj.hide_render = True
    return plan
