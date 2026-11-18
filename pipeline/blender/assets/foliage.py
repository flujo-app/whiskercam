"""Plants: clipped hedges, trees, and the weeds that grow in every crack.

Hedges and tree crowns are clouds of small flat cards showing photographed leaf clumps
(see jobs/bake_sprites.py). Small plants near the ground are the real scanned models,
scattered as copies ("scatter"): the game draws those as instances.
"""
from __future__ import annotations

import math
import random

import bpy
import numpy as np
from mathutils import Vector
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient

from wc import geo, mat, paths, ph

SPRITES = paths.BUILD / "export" / "sprites"
HEDGE_DENSITY = 80.0     # cards per square metre of hedge surface
HEDGE_INSIDE = 34.0      # looser cards per cubic metre inside the hedge
HEDGE_STEMS = 9.0        # woody stems per square metre of hedge floor
UP = Vector((0.0, 0.0, 1.0))


def _card(verts, faces, uvs, normals, centre: Vector, normal: Vector, size: float, shade: Vector, rng: random.Random) -> None:
    """Append one square card. `normal` = which way the card faces, `shade` = the normal used for lighting."""
    n = normal.normalized()
    ref = UP if abs(n.z) < 0.92 else Vector((1.0, 0.0, 0.0))
    u = n.cross(ref).normalized()
    v = n.cross(u).normalized()
    spin = rng.uniform(0.0, math.tau)
    cu, su = math.cos(spin), math.sin(spin)
    u, v = u * cu + v * su, v * cu - u * su
    h = size / 2
    tx, ty = rng.randrange(2), rng.randrange(2)
    m = 0.012
    corners_uv = [(tx / 2 + m, ty / 2 + m), (tx / 2 + 0.5 - m, ty / 2 + m), (tx / 2 + 0.5 - m, ty / 2 + 0.5 - m), (tx / 2 + m, ty / 2 + 0.5 - m)]
    if rng.random() < 0.5:
        corners_uv = [corners_uv[1], corners_uv[0], corners_uv[3], corners_uv[2]]
    base = len(verts)
    for k, (a, b) in enumerate(((-h, -h), (h, -h), (h, h), (-h, h))):
        offset = u * a + v * b
        verts.append(centre + offset)
        normals.append((shade * 0.8 + offset.normalized() * 0.35 + UP * 0.2).normalized())
        uvs.append(corners_uv[k])
    faces.append((base, base + 1, base + 2, base + 3))


def _cards_object(name: str, verts, faces, uvs, normals, material, coll) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    uvl = mesh.uv_layers.new(name=geo.UV0)
    for loop in mesh.loops:
        uvl.data[loop.index].uv = uvs[loop.vertex_index]
    for p in mesh.polygons:
        p.use_smooth = True
    mesh.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
    mesh.materials.append(material)
    obj = geo.new_object(name, mesh, coll)
    geo.tag(obj, role="foliage", collide="none")
    return obj


# the leaf pictures come out brighter and yellower than real leaves in sunlight; these bring them back
LEAF_TINT = {"hedge": (0.6, 0.72, 0.55), "tree": (0.52, 0.66, 0.6)}


def leaf_material(kind: str) -> bpy.types.Material:
    return mat.leaf(f"{kind}_leaves", SPRITES / f"{kind}_leaves.png", LEAF_TINT.get(kind, (1.0, 1.0, 1.0)))


def build_hedge(name: str, foot: Polygon, height: float, coll=None, seed: int = 0) -> bpy.types.Object | None:
    """Leaf cards over the top and sides of a clipped hedge standing on `foot`."""
    if foot.is_empty or foot.area < 0.15:
        return None
    rng = random.Random(seed * 7919 + int(foot.centroid.x * 13) + int(foot.centroid.y * 31))
    foot = orient(foot, 1.0)
    verts, faces, uvs, normals = [], [], [], []

    def place(p: Vector, n: Vector) -> None:
        low = p.z < 0.28
        if low and rng.random() < 0.55:
            return                      # thin and twiggy near the ground
        size = rng.uniform(0.2, 0.33)
        centre = p - n * rng.uniform(0.0, 0.11)
        if rng.random() < 0.62:
            tilt = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))) * 0.55
            face = (n + tilt).normalized()
        else:
            around = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
            face = (around - n * around.dot(n) + n * 0.25).normalized()   # edge-on to the surface: gives depth
        _card(verts, faces, uvs, normals, centre, face, size, n, rng)

    # sides
    for ring in [foot.exterior] + list(foot.interiors):
        pts = list(ring.coords)
        for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
            seg = math.hypot(bx - ax, by - ay)
            if seg < 1e-4:
                continue
            nx, ny = (by - ay) / seg, -(bx - ax) / seg      # outwards for a counter-clockwise outline
            for _ in range(int(seg * height * HEDGE_DENSITY + rng.random())):
                t = rng.random()
                z = rng.uniform(0.06, height - 0.02)
                # slightly rounded shoulder near the top
                inset = 0.06 * max(0.0, (z - (height - 0.18)) / 0.18) ** 2
                p = Vector((ax + (bx - ax) * t - nx * inset, ay + (by - ay) * t - ny * inset, z))
                place(p, Vector((nx, ny, 0.25 if z > height - 0.2 else 0.0)).normalized())
    # top
    x0, y0, x1, y1 = foot.bounds
    want = int(foot.area * HEDGE_DENSITY * 1.1)
    made = 0
    tries = 0
    while made < want and tries < want * 30:
        tries += 1
        x, y = rng.uniform(x0, x1), rng.uniform(y0, y1)
        if not foot.contains(Point(x, y)):
            continue
        made += 1
        bump = math.sin(x * 3.1) * math.cos(y * 2.7) * 0.025     # clipped, but not laser-flat
        place(Vector((x, y, height + bump)), UP)
    # the inside: a hedge is not hollow. Looser leaves all through it, and woody stems coming up from the ground.
    inner = foot.buffer(-0.1)
    if not inner.is_empty and height > 0.4:
        ix0, iy0, ix1, iy1 = inner.bounds
        want = int(inner.area * (height - 0.2) * HEDGE_INSIDE)
        made = tries = 0
        while made < want and tries < want * 30:
            tries += 1
            x, y = rng.uniform(ix0, ix1), rng.uniform(iy0, iy1)
            if not inner.contains(Point(x, y)):
                continue
            made += 1
            z = rng.uniform(0.1, height - 0.1)
            face = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.6, 1))).normalized()
            _card(verts, faces, uvs, normals, Vector((x, y, z)), face, rng.uniform(0.15, 0.27), UP, rng)
        _hedge_stems(name, inner, height, coll, rng)
    if not faces:
        return None
    return _cards_object(name, verts, faces, uvs, normals, leaf_material("hedge"), coll)


def _hedge_stems(name: str, inner: Polygon, height: float, coll, rng: random.Random) -> None:
    """Thin woody stems inside a hedge: what a cat sees when it pushes in."""
    import bmesh

    x0, y0, x1, y1 = inner.bounds
    want = int(inner.area * HEDGE_STEMS)
    bm = bmesh.new()

    def stem(a: Vector, b: Vector, ra: float, rb: float) -> None:
        axis = (b - a).normalized()
        ref = UP if abs(axis.z) < 0.9 else Vector((1.0, 0.0, 0.0))
        u = axis.cross(ref).normalized()
        v = axis.cross(u)
        lo = [bm.verts.new(a + (u * math.cos(k * math.tau / 4) + v * math.sin(k * math.tau / 4)) * ra) for k in range(4)]
        hi = [bm.verts.new(b + (u * math.cos(k * math.tau / 4) + v * math.sin(k * math.tau / 4)) * rb) for k in range(4)]
        for k in range(4):
            bm.faces.new((lo[k], lo[(k + 1) % 4], hi[(k + 1) % 4], hi[k]))
        bm.faces.new(hi[::-1])

    made = tries = 0
    while made < want and tries < want * 30:
        tries += 1
        x, y = rng.uniform(x0, x1), rng.uniform(y0, y1)
        if not inner.contains(Point(x, y)):
            continue
        made += 1
        r = rng.uniform(0.006, 0.014)
        top = height * rng.uniform(0.55, 0.92)
        lean = Vector((rng.uniform(-0.16, 0.16), rng.uniform(-0.16, 0.16), 1.0)).normalized()
        foot_p = Vector((x, y, 0.02))
        mid = foot_p + lean * (top * rng.uniform(0.35, 0.6))
        tip = foot_p + lean * top + Vector((rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), 0.0))
        stem(foot_p, mid, r, r * 0.8)
        stem(mid, tip, r * 0.8, r * 0.4)
        side = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0.4, 1.0))).normalized()
        stem(mid, mid + side * rng.uniform(0.18, 0.36), r * 0.6, r * 0.3)
    if not bm.faces:
        bm.free()
        return
    obj = geo.bm_to_object(bm, f"{name}_stems", mat.get("bark"), coll)
    geo.uv_box(obj)
    geo.shade_auto(obj, 60.0)
    geo.tag(obj, role="foliage", collide="none")


# ---------------------------------------------------------------- trees

_WOOD: bpy.types.Object | None = None


def _tree_wood() -> bpy.types.Object:
    """The scanned tree's trunk and branches, thinned out (made by jobs/bake_sprites.py)."""
    global _WOOD
    try:
        if _WOOD is not None and _WOOD.name:
            return _WOOD
    except ReferenceError:
        pass
    lib = geo.collection("_library")
    lib.hide_render = True
    with bpy.data.libraries.load(str(paths.BUILD / "cache" / "tree.blend")) as (src, dst):
        dst.objects = [n for n in src.objects if n == "tree_wood"]
    _WOOD = dst.objects[0]
    lib.objects.link(_WOOD)
    if _WOOD.data.uv_layers:
        _WOOD.data.uv_layers[0].name = geo.UV0
    for slot in _WOOD.material_slots:
        if slot.material is not None:
            mat.register_imported(slot.material, "jacaranda_tree")
    return _WOOD


def build_tree(name: str, loc, height: float = 9.0, rot_z_deg: float = 0.0, coll=None, seed: int = 0,
               cards: int = 2300, keep=None) -> list[bpy.types.Object]:
    """A tree: real scanned trunk and branches, crown made of leaf cards where the scan had leaves.

    keep: optional test `keep(point) -> bool`; leaf cards whose centre fails it are left out (used to stop the
    crowns of trees outside the estate from poking through its walls)."""
    from mathutils import Matrix

    rng = random.Random(seed * 131 + 7)
    wood_src = _tree_wood()
    lo_hi = list(wood_src["wc_tree_bounds"])
    full_h = lo_hi[5]
    s = height / full_h
    # trunk foot: average of the lowest wood vertices
    co = np.empty(len(wood_src.data.vertices) * 3, dtype=np.float32)
    wood_src.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    foot = co[co[:, 2] < 0.6]
    fx, fy = float(foot[:, 0].mean()), float(foot[:, 1].mean())
    trunk_r = float(np.percentile(np.hypot(foot[:, 0] - fx, foot[:, 1] - fy), 90)) * s
    xform = (Matrix.Translation(Vector(loc)) @ Matrix.Rotation(math.radians(rot_z_deg), 4, "Z") @ Matrix.Scale(s, 4)
             @ Matrix.Translation(Vector((-fx, -fy, 0.0))))
    wood = wood_src.copy()
    (coll or bpy.context.scene.collection).objects.link(wood)
    wood.matrix_world = xform
    wood.name = f"{name}_wood"
    # the wood is drawn as copies of one mesh (like the weeds), lit from the ground light picture
    geo.tag(wood, role="scatter", collide="none", src="tree|wood", solid=1)

    pts = np.load(paths.BUILD / "cache" / "tree_leaf_points.npy")
    pick = np.random.default_rng(seed + 1).choice(len(pts), size=min(cards, len(pts)), replace=False)
    centre_local = Vector(pts.mean(axis=0).tolist())
    verts, faces, uvs, normals = [], [], [], []
    for i in pick:
        p_local = Vector(pts[i].tolist())
        out = (p_local - Vector((centre_local.x, centre_local.y, centre_local.z * 0.75))).normalized()
        world_p = xform @ p_local
        if keep is not None and not keep(world_p):
            continue
        world_n = (xform.to_3x3() @ out).normalized()
        tilt = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.3, 1.2)))
        face = (world_n * 0.5 + tilt.normalized() * 0.8).normalized()
        _card(verts, faces, uvs, normals, world_p, face, rng.uniform(1.25, 1.9) * s, world_n, rng)
    crown = _cards_object(f"{name}_crown", verts, faces, uvs, normals, leaf_material("tree"), coll)
    # The trunk itself, measured above the spreading roots (the collision shape used to be as wide as the
    # roots: an invisible half-metre drum round every tree).
    low = co[(co[:, 2] >= 0.45) & (co[:, 2] < 1.1)]
    if len(low) >= 3:
        tx, ty = float(low[:, 0].mean()), float(low[:, 1].mean())
        trunk_local = float(np.percentile(np.hypot(low[:, 0] - tx, low[:, 1] - ty), 90))
    else:
        tx, ty, trunk_local = fx, fy, 0.2
    trunk_local = min(max(trunk_local, 0.16), 0.4)
    # How far up is it one clean trunk? Up to there the cat can climb it; where the first big branches leave,
    # a small invisible ledge lets it sit in the fork.
    rad = np.hypot(co[:, 0] - tx, co[:, 1] - ty)
    near = rad < 1.3
    fork = full_h * 0.22
    for zc in np.arange(1.2, full_h * 0.5, 0.2):
        sel = near & (co[:, 2] >= zc) & (co[:, 2] < zc + 0.2)
        if sel.sum() >= 3 and float(rad[sel].max()) > 0.55:
            fork = float(zc)
            break
    top = min(max(fork * s, 1.5), 5.5)
    base = xform @ Vector((tx, ty, 0.0))
    base.z = Vector(loc).z
    r_col = max(0.07, trunk_local * s * 1.05)
    trunk = geo.cylinder(f"{name}_col", r_col, base, base + Vector((0, 0, top)), None, coll, segments=10)
    perch = geo.cylinder(f"{name}_perch", max(0.28, r_col + 0.16), base + Vector((0, 0, top - 0.04)), base + Vector((0, 0, top)),
                         None, coll, segments=10)
    for o in (trunk, perch):
        geo.tag(o, role="collider", collide="mesh", surface="wood")
        o.hide_render = True
    trunk["wc_perch"] = round(top, 2)
    trunk["wc_trunk"] = [round(base.x, 3), round(base.y, 3), round(r_col, 3)]
    return [wood, crown, trunk, perch]


# ---------------------------------------------------------------- weeds and tufts

# (model id, part name fragment, weight, scale range, where it likes to grow)
WEEDS = [
    ("grass_medium_02", "_a", 3.0, (0.8, 1.5), "crack"),
    ("grass_medium_02", "_b", 3.0, (0.8, 1.5), "crack"),
    ("grass_medium_02", "_c", 2.0, (0.8, 1.6), "crack"),
    ("grass_medium_02", "_d", 2.0, (0.9, 1.6), "edge"),
    ("grass_medium_02", "_e", 2.0, (0.9, 1.7), "edge"),
    ("weed_plant_02", "_a", 1.2, (0.6, 1.1), "edge"),
    ("weed_plant_02", "_c", 1.2, (0.6, 1.1), "edge"),
    ("weed_plant_02", "_e", 1.0, (0.6, 1.0), "crack"),
    ("shrub_sorrel_01", None, 1.5, (0.9, 1.6), "lawn"),
    ("fern_02", None, 0.5, (0.35, 0.6), "shade"),
]


def _pick(rng: random.Random, where: str):
    pool = [w for w in WEEDS if w[4] == where or (where == "edge" and w[4] == "crack")]
    total = sum(w[2] for w in pool)
    r = rng.uniform(0, total)
    for w in pool:
        r -= w[2]
        if r <= 0:
            return w
    return pool[-1]


def scatter_along(lines, per_metre: float, where: str, height_at, coll, rng: random.Random, jitter: float = 0.03,
                  window=None) -> int:
    """Drop weeds along lines (kerb joints, wall feet, fence lines)."""
    count = 0
    for line in lines:
        if line.length < 0.3:
            continue
        d = rng.uniform(0, 1 / per_metre)
        while d < line.length:
            p = line.interpolate(d)
            d += rng.expovariate(per_metre)
            x, y = p.x + rng.uniform(-jitter, jitter), p.y + rng.uniform(-jitter, jitter)
            if window is not None and not window.contains(Point(x, y)):
                continue
            model, part, _, (s0, s1), _ = _pick(rng, where)
            parts = ph.parts(model)
            name = part if part else rng.choice(parts)
            objs = ph.place(model, (x, y, height_at(x, y) - 0.004), rng.uniform(0, 360), rng.uniform(s0, s1), coll, part=name,
                            name=f"sc_{model}")
            for o in objs:
                geo.tag(o, role="scatter", collide="none", src=f"{model}|{o.data.name}")
            count += 1
    return count


def scatter_area(poly, per_m2: float, where: str, height_at, coll, rng: random.Random, window=None) -> int:
    count = 0
    for part in geo.polygons_of(poly):
        x0, y0, x1, y1 = part.bounds
        for _ in range(int(part.area * per_m2 + rng.random())):
            for _try in range(12):
                x, y = rng.uniform(x0, x1), rng.uniform(y0, y1)
                if part.contains(Point(x, y)) and (window is None or window.contains(Point(x, y))):
                    model, pname, _, (s0, s1), _ = _pick(rng, where)
                    name = pname if pname else rng.choice(ph.parts(model))
                    objs = ph.place(model, (x, y, height_at(x, y) - 0.004), rng.uniform(0, 360), rng.uniform(s0, s1), coll,
                                    part=name, name=f"sc_{model}")
                    for o in objs:
                        geo.tag(o, role="scatter", collide="none", src=f"{model}|{o.data.name}")
                    count += 1
                    break
    return count


def demo(coll, name=None):
    from shapely.geometry import box

    build_hedge("hedge_demo", box(-3.0, 1.2, 3.0, 2.1), 1.25, coll, seed=1)
    core = geo.extrude_polygon("hedge_demo_core", box(-3.0, 1.2, 3.0, 2.1).buffer(-0.16), 0.05, 1.09, mat.get("hedge_core"), coll)
    geo.tag(core, role="hedge_core", collide="none")
    if name == "tree":
        build_tree("tree_demo", (0.0, 4.0, 0.14), 9.0, 30.0, coll, seed=2)
        return {"focus": (0, 4, 4.0), "radius": 7.0, "cat": [(-3.0, -2.0, 25.0), (1.0, 2.5, 10.0), (4.0, 1.0, -60.0)]}
    rng = random.Random(4)
    scatter_along([LineString([(-4, 0.16), (4, 0.16)])], 1.2, "crack", lambda x, y: 0.14, coll, rng)
    scatter_along([LineString([(-4, 1.15), (4, 1.15)])], 2.0, "edge", lambda x, y: 0.14, coll, rng)
    return {"focus": (0, 1.6, 0.6), "radius": 2.6, "cat": [(-2.2, -0.9, 55.0), (0.6, 0.6, 20.0), (1.5, 0.9, -80.0)]}
