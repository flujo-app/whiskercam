"""Apartment blocks, a row of terraced houses and a gatehouse, built by code.

    build_block(name, rect, floors, style, front, coll=None, seed=0, grade=GRADE) -> list[Object]
    demo(coll, name=None) -> dict          (for jobs/stage.py)

How a building is put together
  * Every wall is built in its own "facade frame": x runs along the wall (left to right seen
    from outside), y points INTO the building (the outer wall face is y = 0, outside is y < 0),
    z is up. One matrix per facade moves the pieces into the world.
  * Walls are real skins with holes: every window or door sits 12 to 15 cm deep in its opening,
    with reveals all round. Building corners are rounded (12 mm).
  * Repeated parts (windows, doors, air conditioners, lanterns ...) are built once as plain
    vertex/face lists and copied with a matrix.
  * Everything is sorted into height bands so the light map can spend its detail near the ground:
    below about 3.3 m lm = 1.0, above lm = 0.3, roof surfaces lm = 0.15.

The cat sees these walls from 10 to 30 cm, so the bottom two metres carry the detail:
plinth with drip edge, steps, entrance doors, cellar windows, grilles, downpipes into gullies,
taps, meter boxes, lanterns, air conditioners on brackets.
"""
from __future__ import annotations

import math
import random
import zlib
from functools import lru_cache

import bmesh
import bpy
from mathutils import Matrix, Vector
from shapely.geometry import Polygon
from shapely.geometry import box as sbox
from shapely.ops import unary_union

from wc import geo, mat, ph

GRADE = 0.12          # typical ground height next to the buildings (beds 0.10, pavement 0.14)
FLOOR = 3.0
CORNER = 0.012        # radius of the rounded building corners

STYLES = {
    "tiles": dict(wall="facade_tiles", reveal="plaster_white", plinth="concrete_wall", panel="panel_white",
                  panel_alt="panel_slate", accent="plaster_white", frame="window_frame", canopy="concrete_wall"),
    "plaster": dict(wall="plaster_white", reveal="plaster_white", plinth="plaster_grey", panel="panel_slate",
                    panel_alt="panel_white", accent="plaster_painted", frame="window_frame", canopy="plaster_painted"),
    "plaster_yellow": dict(wall="plaster_yellow", reveal="plaster_white", plinth="plaster_grey", panel="panel_white",
                           panel_alt="panel_ochre", accent="plaster_white", frame="window_frame", canopy="plaster_painted"),
    "terrace": dict(wall="plaster_white", reveal="plaster_white", plinth="plaster_grey", frame="window_frame",
                    canopy="plaster_white"),
    "gatehouse": dict(wall="plaster_white", reveal="plaster_white", plinth="plaster_grey", frame="window_frame_dark",
                      canopy="plaster_grey"),
}

# semantic keys -> library material names (style keys are added per building)
KEYS = {
    "frame_dark": "window_frame_dark", "frame_cellar": "steel_dark", "steel": "steel", "steel_dark": "steel_dark", "black": "plastic_black",
    "label": "plastic_white", "galv": "galvanised", "pipe": "galvanised", "dark": "interior_dark",
    "concrete": "concrete_brushed", "slab": "concrete_wall", "ac_white": "plastic_white", "insul": "plastic_white",
    "lamp_glass": "light_clear", "lamp_body": "paint_black", "rail": "galvanised", "alu": "aluminium",
    "shutter": "shutter_roll", "sill": "sill_alu", "profile": "sill_alu", "brass": "brass", "doormat": "doormat", "red": "paint_red",
    "roof": "bitumen", "tiles_roof": "roof_tiles", "fascia": "fascia_white", "gutter": "pvc_pipe",
    "bricks": "bricks_red", "terracotta": "terracotta", "duct": "plastic_white", "rubber": "rubber",
    "blue": "paint_blue", "green": "plastic_green", "canvas": "fabric_canopy", "grate": "steel_dark",
}

CUSTOM = {
    "panel_white": lambda: mat.flat("panel_white", (0.66, 0.67, 0.65), 0.55),
    "panel_slate": lambda: mat.flat("panel_slate", (0.20, 0.25, 0.30), 0.5),
    "panel_ochre": lambda: mat.flat("panel_ochre", (0.55, 0.36, 0.16), 0.55),
    "sill_alu": lambda: mat.flat("sill_alu", (0.58, 0.59, 0.60), 0.42, 1.0),
    "brass": lambda: mat.flat("brass", (0.60, 0.45, 0.21), 0.35, 1.0),
    "fascia_white": lambda: mat.flat("fascia_white", (0.76, 0.76, 0.74), 0.5),
    "doormat": lambda: mat.tile("doormat", "rough_linen", size=0.3, tint=(0.62, 0.36, 0.14)),
    "shutter_roll": lambda: mat.tile("shutter_roll", "painted_metal_shutter", size=1.0),
}

GLASS_MIX = (("glass_window", 0.52), ("glass_curtain_cream", 0.16), ("glass_curtain_white", 0.16),
             ("glass_blind_grey", 0.16))

# Plan-specific: the terraced houses line up with the garden plots of sets/plan.py (fences every
# 10 m starting at x = -48), so party walls and downpipes sit where the garden fences meet the row.
TERRACE_GRID_X0 = -48.0


def _material(name: str):
    if name in CUSTOM:
        return CUSTOM[name]()
    if name.startswith("plaster_tint_"):
        return bpy.data.materials[name]
    return mat.get(name)


# =====================================================================================================
# plain vertex / face lists


class G:
    """Vertices plus faces with a material key per face. Cheap to copy with a matrix."""

    __slots__ = ("v", "f")

    def __init__(self):
        self.v: list[Vector] = []
        self.f: list[tuple[tuple[int, ...], str]] = []

    def add(self, o: "G", m: Matrix | None = None, remap: dict | None = None) -> "G":
        b0 = len(self.v)
        if m is None:
            self.v.extend(c.copy() for c in o.v)
            flip = False
        else:
            self.v.extend(m @ c for c in o.v)
            flip = m.to_3x3().determinant() < 0
        for idx, k in o.f:
            idx = tuple(i + b0 for i in idx)
            if flip:
                idx = idx[::-1]
            if remap:
                k = remap.get(k, k)
            self.f.append((idx, k))
        return self

    def poly(self, pts, k: str, nrm=None) -> None:
        vs = [Vector(p) for p in pts]
        if nrm is not None and _newell(vs).dot(Vector(nrm)) < 0:
            vs.reverse()
        b0 = len(self.v)
        self.v.extend(vs)
        self.f.append((tuple(range(b0, b0 + len(vs))), k))

    def tris(self) -> int:
        return sum(len(i) - 2 for i, _ in self.f)


def _newell(vs) -> Vector:
    n = Vector((0.0, 0.0, 0.0))
    for i in range(len(vs)):
        a, b = vs[i], vs[(i + 1) % len(vs)]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n


def _from_bm(bm, keys) -> G:
    g = G()
    bm.verts.index_update()
    g.v = [v.co.copy() for v in bm.verts]
    for f in bm.faces:
        k = keys if isinstance(keys, str) else keys[min(f.material_index, len(keys) - 1)]
        g.f.append((tuple(v.index for v in f.verts), k))
    bm.free()
    return g


_BOXF = (("-z", (3, 2, 1, 0)), ("+z", (4, 5, 6, 7)), ("-y", (0, 1, 5, 4)), ("+x", (1, 2, 6, 5)),
         ("+y", (2, 3, 7, 6)), ("-x", (3, 0, 4, 7)))


def box(p0, p1, k, bev: float = 0.0, segs: int = 1, skip=()) -> G:
    """Axis-aligned box; k is a key or {face: key, "*": default}; bev > 0 rounds every edge."""
    x0, y0, z0 = (min(a, b) for a, b in zip(p0, p1))
    x1, y1, z1 = (max(a, b) for a, b in zip(p0, p1))
    cs = ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))
    keyof = (lambda n: k.get(n, k.get("*"))) if isinstance(k, dict) else (lambda n: k)
    if bev <= 0:
        g = G()
        g.v = [Vector(c) for c in cs]
        g.f = [(idx, keyof(n)) for n, idx in _BOXF if n not in skip]
        return g
    bm = bmesh.new()
    vs = [bm.verts.new(c) for c in cs]
    keys: list[str] = []
    for n, idx in _BOXF:
        f = bm.faces.new([vs[i] for i in idx])
        kk = keyof(n)
        if kk not in keys:
            keys.append(kk)
        f.material_index = keys.index(kk)
    w = min(bev, 0.45 * min(x1 - x0, y1 - y0, z1 - z0))
    bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges), offset=w, offset_type="OFFSET", segments=segs,
                    profile=0.5, affect="EDGES", clamp_overlap=True)
    return _from_bm(bm, keys)


def _perp(a: Vector):
    a = a.normalized()
    u = a.cross(Vector((0, 0, 1))) if abs(a.z) < 0.9 else a.cross(Vector((1, 0, 0)))
    u.normalize()
    return u, a.cross(u)


def cyl(p0, p1, r, k, segs=12, caps=(True, True), r1=None, kcap=None) -> G:
    p0, p1 = Vector(p0), Vector(p1)
    u, v = _perp(p1 - p0)
    r1 = r if r1 is None else r1
    g = G()
    for rad, c in ((r, p0), (r1, p1)):
        for i in range(segs):
            a = 2 * math.pi * i / segs
            g.v.append(c + (u * math.cos(a) + v * math.sin(a)) * rad)
    for i in range(segs):
        j = (i + 1) % segs
        g.f.append(((i, j, segs + j, segs + i), k))
    if caps[0]:
        g.f.append((tuple(range(segs))[::-1], kcap or k))
    if caps[1]:
        g.f.append((tuple(range(segs, 2 * segs)), kcap or k))
    return g


def fillet(pts, rad: float, n: int = 4):
    """Round the corners of a 3D polyline."""
    P = [Vector(p) for p in pts]
    out = [P[0]]
    for i in range(1, len(P) - 1):
        a, b, c = P[i - 1], P[i], P[i + 1]
        d1, d2 = (a - b), (c - b)
        l1, l2 = d1.length, d2.length
        d1.normalize()
        d2.normalize()
        ang = d1.angle(d2, math.pi)
        if ang > math.pi - 1e-3:
            out.append(b)
            continue
        dist = min(rad / math.tan(ang / 2), 0.45 * l1, 0.45 * l2)
        q0, q1 = b + d1 * dist, b + d2 * dist
        for s in range(n + 1):
            t = s / n
            out.append(q0 * (1 - t) ** 2 + b * 2 * t * (1 - t) + q1 * t * t)
    out.append(P[-1])
    return out


def tube(pts, r, k, segs=10, caps=(True, True), kcap=None) -> G:
    P = [Vector(p) for p in pts]
    n = len(P)
    T = []
    for i in range(n):
        if i == 0:
            t = P[1] - P[0]
        elif i == n - 1:
            t = P[-1] - P[-2]
        else:
            t = (P[i] - P[i - 1]).normalized() + (P[i + 1] - P[i]).normalized()
            if t.length < 1e-6:
                t = P[i + 1] - P[i]
        T.append(t.normalized())
    u, _ = _perp(T[0])
    g = G()
    for i in range(n):
        if i > 0:
            u = T[i - 1].rotation_difference(T[i]) @ u
            u = (u - T[i] * u.dot(T[i])).normalized()
        v = T[i].cross(u)
        for s in range(segs):
            a = 2 * math.pi * s / segs
            g.v.append(P[i] + (u * math.cos(a) + v * math.sin(a)) * r)
    for i in range(n - 1):
        for s in range(segs):
            s1 = (s + 1) % segs
            g.f.append(((i * segs + s, i * segs + s1, (i + 1) * segs + s1, (i + 1) * segs + s), k))
    if caps[0]:
        g.f.append((tuple(range(segs))[::-1], kcap or k))
    if caps[1]:
        g.f.append((tuple(range((n - 1) * segs, n * segs)), kcap or k))
    return g


def disc(c, r, k, segs=16, axis="-y") -> G:
    """Flat round plate facing `axis` (in a facade frame: -y = outwards)."""
    cx, cy, cz = c
    g = G()
    pts = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        if axis in ("-y", "+y"):
            pts.append((cx + r * math.cos(a), cy, cz + r * math.sin(a)))
        else:
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a), cz))
    g.poly(pts, k, nrm={"-y": (0, -1, 0), "+y": (0, 1, 0), "+z": (0, 0, 1), "-z": (0, 0, -1)}[axis])
    return g


def run(prof, x0, x1, mit0=False, mit1=False, caps=True, kcap=None) -> G:
    """A profile pushed along a facade's x axis.

    prof: closed loop of (o, z, key): o = distance OUT of the wall (local y = -o), key = material of the
    edge that starts at this point. mit0/mit1: the run turns an outside building corner at that end.
    """
    n = len(prof)
    co = [(p[0], p[1]) for p in prof]
    ks = [p[2] for p in prof]
    area = sum(co[i][0] * co[(i + 1) % n][1] - co[(i + 1) % n][0] * co[i][1] for i in range(n))
    if area < 0:
        co = co[::-1]
        ks = [ks[(n - 2 - j) % n] for j in range(n)]
    g = G()
    g.v = [Vector((x0 - (o if mit0 else 0.0), -o, z)) for o, z in co] + \
          [Vector((x1 + (o if mit1 else 0.0), -o, z)) for o, z in co]
    for i in range(n):
        j = (i + 1) % n
        g.f.append(((i, n + i, n + j, j), ks[i]))
    if caps and not mit0:
        g.f.append((tuple(range(n)), kcap or ks[0]))
    if caps and not mit1:
        g.f.append((tuple(range(n, 2 * n))[::-1], kcap or ks[0]))
    return g


def _dedupe(ring):
    out = []
    for p in ring:
        if not out or abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) > 1e-7:
            out.append(p)
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) + abs(out[0][1] - out[-1][1]) < 1e-7:
        out.pop()
    return out


def _tri(geom):
    """Fill a 2D area (holes allowed). Returns (verts2d, faces) with faces counter-clockwise."""
    vs, fs = [], []
    for p in geo.polygons_of(geom):
        if p.is_empty or p.area < 1e-6:
            continue
        for pp in geo.polygons_of(p.buffer(0)):
            bm = bmesh.new()
            edges = []
            for ring in geo._rings(pp):
                ring = _dedupe(ring)
                if len(ring) < 3:
                    continue
                vv = [bm.verts.new((x, y, 0.0)) for x, y in ring]
                for i in range(len(vv)):
                    edges.append(bm.edges.new((vv[i], vv[(i + 1) % len(vv)])))
            bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
            bm.verts.index_update()
            b0 = len(vs)
            vs.extend((v.co.x, v.co.y) for v in bm.verts)
            for f in bm.faces:
                f.normal_update()
                idx = [b0 + v.index for v in f.verts]
                if f.normal.z < 0:
                    idx.reverse()
                fs.append(tuple(idx))
            bm.free()
    return vs, fs


# =====================================================================================================
# facades


class Fac:
    """One side of the footprint: x along the wall (seen from outside, left to right), y inwards."""

    def __init__(self, side: str, rect):
        x0, y0, x1, y1 = rect
        org, th, L, D = {"S": ((x0, y0), 0, x1 - x0, y1 - y0), "E": ((x1, y0), 90, y1 - y0, x1 - x0),
                         "N": ((x1, y1), 180, x1 - x0, y1 - y0), "W": ((x0, y1), 270, y1 - y0, x1 - x0)}[side]
        self.side, self.L, self.D, self.th = side, L, D, th
        self.m = Matrix.Translation((org[0], org[1], 0.0)) @ Matrix.Rotation(math.radians(th), 4, "Z")
        self.holes: list[tuple[float, float, float, float]] = []

    def hole(self, x0, z0, x1, z1, gap=0.12) -> bool:
        """Claim an opening; refused (False) if it would cut into the corner or another opening."""
        if x0 < 0.25 or x1 > self.L - 0.25:
            return False
        for h in self.holes:
            if x0 < h[2] + gap and h[0] - gap < x1 and z0 < h[3] + gap and h[1] - gap < z1:
                return False
        self.holes.append((x0, z0, x1, z1))
        return True

    def at(self, x=0.0, y=0.0, z=0.0, rot=0.0) -> Matrix:
        m = self.m @ Matrix.Translation((x, y, z))
        return m @ Matrix.Rotation(math.radians(rot), 4, "Z") if rot else m

    def world(self, x, y, z) -> Vector:
        return self.m @ Vector((x, y, z))


SIDES = ("S", "E", "N", "W")


def wall_layer(g: G, L, d, z0, z1, holes, kface, krev, depth=0.24, c=CORNER, shape=None, xmats=None, arc_z=None):
    """Outer skin of one facade between z0 and z1, set back by d, with holes (x0, z0, x1, z1) and reveals.
    The rounded building corner at the facade's start (x = 0) is added here too."""
    base = shape.intersection(sbox(-1.0, z0, L + 1.0, z1)) if shape is not None else sbox(d + c, z0, L - d - c, z1)
    hs = [h for h in holes if h[3] > z0 + 1e-6 and h[1] < z1 - 1e-6]
    face = base.difference(unary_union([sbox(*h) for h in hs])) if hs else base
    parts = [(face, kface)] if not xmats else [(face.intersection(sbox(a, z0 - 1, b, z1 + 1)), k) for a, b, k in xmats]
    for poly, k in parts:
        vs, fs = _tri(poly)
        b0 = len(g.v)
        g.v.extend(Vector((x, d, z)) for x, z in vs)
        g.f.extend((tuple(b0 + i for i in f), k) for f in fs)
    y0, y1 = d, d + depth
    for hx0, hz0, hx1, hz1 in hs:
        a, b = max(hz0, z0), min(hz1, z1)
        g.poly([(hx0, y0, a), (hx0, y1, a), (hx0, y1, b), (hx0, y0, b)], krev, nrm=(1, 0, 0))
        g.poly([(hx1, y0, a), (hx1, y1, a), (hx1, y1, b), (hx1, y0, b)], krev, nrm=(-1, 0, 0))
        if z0 <= hz0 < z1:
            g.poly([(hx0, y0, hz0), (hx1, y0, hz0), (hx1, y1, hz0), (hx0, y1, hz0)], krev, nrm=(0, 0, 1))
        if z0 < hz1 <= z1:
            g.poly([(hx0, y0, hz1), (hx1, y0, hz1), (hx1, y1, hz1), (hx0, y1, hz1)], krev, nrm=(0, 0, -1))
    if c > 0:
        za, zb = arc_z or (z0, z1)
        if zb > za:
            n = 3
            kc = xmats[0][2] if xmats else kface
            cx = cy = d + c
            ring = [(cx + c * math.cos(math.pi + 0.5 * math.pi * i / n), cy + c * math.sin(math.pi + 0.5 * math.pi * i / n))
                    for i in range(n + 1)]
            for i in range(n):
                (ax, ay), (bx, by) = ring[i], ring[i + 1]
                mid = Vector(((ax + bx) / 2 - cx, (ay + by) / 2 - cy, 0.0))
                g.poly([(ax, ay, za), (bx, by, za), (bx, by, zb), (ax, ay, zb)], kc, nrm=mid)


def layer(B: "Bld", band: str, fac: Fac, *args, **kw) -> None:
    """wall_layer() for one facade, moved into the world and filed under a height band."""
    t = G()
    wall_layer(t, fac.L, *args, **kw)
    B.g[band].add(t, fac.m)


# =====================================================================================================
# repeated parts (built once, copied).  All in "opening" frames: origin at the bottom-left corner of
# the hole on the outer wall face, x along the wall, y inwards, z up.


@lru_cache(None)
def p_window(w, h, n=2, detail=False, sill=True, R=0.12, t=0.065, kf="frame", tilt=False) -> G:
    """Window in its opening: frame, mullion, sashes with glass ("GLASS"), handle, outside sill.
    tilt: the first sash stands tilted open at the top, with a dark room behind the gap."""
    g = G()
    bev = 0.0          # frames stay crisp boxes (seen from 1.7 m up at the least); the sill below is rounded
    depth = 0.07
    yf, yb = R, R + depth

    def member(x0, z0, x1, z1, y0, y1, skip, key=kf, b=bev, to=None):
        (to or g).add(box((x0, y0, z0), (x1, y1, z1), key, bev=b, skip=() if b else skip))

    member(0, 0, t, h, yf, yb, ("+y", "-x"))
    member(w - t, 0, w, h, yf, yb, ("+y", "+x"))
    member(t, h - t, w - t, h, yf, yb, ("+y", "+z", "-x", "+x"))
    member(t, 0, w - t, t, yf, yb, ("+y", "-z", "-x", "+x"))
    mull = 0.075
    ix0, ix1, iz0, iz1 = t, w - t, t, h - t
    cw = (ix1 - ix0 - mull * (n - 1)) / n
    spans = []
    for i in range(n):
        a = ix0 + i * (cw + mull)
        spans.append((a, a + cw))
        if i < n - 1:
            member(a + cw, iz0, a + cw + mull, iz1, yf, yb, ("+y", "-z", "+z"))
    st = 0.058
    sf, sb = yf + 0.012, yf + 0.055
    gy = yf + 0.034
    for i, (a, b) in enumerate(spans):
        tilted = tilt and i == 0
        sg = G() if tilted else g
        for (x0, z0, x1, z1), sk in (((a, iz0, a + st, iz1), ("+y", "-x", "-z", "+z")),
                                     ((b - st, iz0, b, iz1), ("+y", "+x", "-z", "+z")),
                                     ((a + st, iz1 - st, b - st, iz1), ("+y", "+z", "-x", "+x")),
                                     ((a + st, iz0, b - st, iz0 + st), ("+y", "-z", "-x", "+x"))):
            member(x0, z0, x1, z1, sf, sb, () if tilted else sk, to=sg)
        sg.poly([(a + st, gy, iz0 + st), (b - st, gy, iz0 + st), (b - st, gy, iz1 - st), (a + st, gy, iz1 - st)], "GLASS",
                nrm=(0, -1, 0))
        if detail:
            hx = b - st / 2 if i == 0 else a + st / 2
            zc = (iz0 + iz1) / 2
            sg.add(box((hx - 0.014, sf - 0.012, zc - 0.035), (hx + 0.014, sf, zc + 0.035), "alu", skip=("+y",)))
            sg.add(box((hx - 0.009, sf - 0.03, zc - 0.13), (hx + 0.009, sf - 0.012, zc + 0.01), "alu", skip=("+y",)))
        if tilted:
            piv = Vector((0.0, sf, iz0))
            g.add(sg, Matrix.Translation(piv) @ Matrix.Rotation(-math.radians(6.5), 4, "X") @ Matrix.Translation(-piv))
            room = box((a, yb, iz0), (b, yb + 0.2, iz1), "dark", skip=("-y",))
            room.f = [(idx[::-1], k) for idx, k in room.f]      # seen from inside
            g.add(room)
    if sill:
        if detail:
            g.add(box((-0.035, -0.055, -0.032), (w + 0.035, R + 0.02, 0.004), "sill", bev=0.003))
            g.add(box((-0.035, -0.06, -0.055), (w + 0.035, -0.047, -0.02), "sill", bev=0.002))
        else:
            g.add(box((-0.035, -0.055, -0.035), (w + 0.035, R + 0.02, 0.004), "sill", skip=("+y",)))
    return g


@lru_cache(None)
def p_shutter(w, h, drop) -> G:
    """Roller shutter partly let down inside the reveal, with its guide rails."""
    g = G()
    zb = h - drop
    g.add(box((0.02, 0.066, zb), (w - 0.02, 0.08, h), "shutter", skip=("+y", "+z")))
    g.add(box((0.02, 0.06, zb - 0.035), (w - 0.02, 0.085, zb), "alu", skip=("+y",)))
    for x0 in (0.0, w - 0.03):
        g.add(box((x0, 0.055, 0.0), (x0 + 0.03, 0.095, h), "alu", skip=("+y", "-z", "+z")))
    return g


@lru_cache(None)
def p_entrance_door(w=1.9, h=2.35) -> G:
    """Steel-and-glass entrance: door leaf, side panel with letterboxes, fanlight."""
    g = G()
    R, d, t, b = 0.14, 0.08, 0.07, 0.004
    kf = "frame_dark"

    def bx(p0, p1, k=kf, bev=b):
        g.add(box(p0, p1, k, bev=bev))

    bx((0, R, 0.0), (t, R + d, h))
    bx((w - t, R, 0.0), (w, R + d, h))
    bx((t, R, h - t), (w - t, R + d, h))
    bx((-0.01, R - 0.035, -0.012), (w + 0.01, R + d, 0.018), "sill", 0.003)
    xm = 1.16
    bx((xm, R, 0.018), (xm + 0.07, R + d, 2.08))
    bx((t, R, 2.08), (w - t, R + d, 2.15))
    # door leaf: glass nearly down to the floor (a cat on the landing can see itself in it), a rail at push height
    lx0, lx1, lz0, lz1 = t + 0.005, xm - 0.005, 0.022, 2.075
    ly0, ly1 = R + 0.006, R + 0.066
    st, top, bot = 0.1, 0.1, 0.11
    mid0, mid1 = 0.98, 1.05
    bx((lx0, ly0, lz0), (lx0 + st, ly1, lz1))
    bx((lx1 - st, ly0, lz0), (lx1, ly1, lz1))
    bx((lx0 + st, ly0, lz1 - top), (lx1 - st, ly1, lz1))
    bx((lx0 + st, ly0, lz0), (lx1 - st, ly1, lz0 + bot))
    bx((lx0 + st, ly0, mid0), (lx1 - st, ly1, mid1))
    gy = ly0 + 0.03
    for za, zb in ((lz0 + bot, mid0), (mid1, lz1 - top)):
        g.poly([(lx0 + st, gy, za), (lx1 - st, gy, za), (lx1 - st, gy, zb), (lx0 + st, gy, zb)], "GLASS_DOOR", nrm=(0, -1, 0))
    # kick strip on the bottom rail
    bx((lx0 + 0.012, ly0 - 0.003, lz0 + 0.012), (lx1 - 0.012, ly0, lz0 + 0.095), "steel", 0.0012)
    # pull handle with two stand-offs, lock rosette
    hx = lx1 - 0.08
    g.add(cyl((hx, ly0 - 0.068, 0.78), (hx, ly0 - 0.068, 1.6), 0.016, "steel", segs=10))
    for zz in (0.9, 1.48):
        g.add(cyl((hx, ly0, zz), (hx, ly0 - 0.068, zz), 0.0105, "steel", segs=8, caps=(False, False)))
    g.add(cyl((hx - 0.0, ly0, 1.12), (hx, ly0 - 0.01, 1.12), 0.021, "steel", segs=10, caps=(False, True)))
    # side panel: letterboxes below, glass above
    sx0, sx1 = xm + 0.07, w - t
    bx((sx0, R + 0.03, 0.018), (sx1, R + 0.06, 1.0), "steel_dark", 0.002)
    bx((sx0, R, 0.98), (sx1, R + d, 1.045))
    cw = (sx1 - sx0 - 0.08) / 2
    rh = (0.84 - 0.04) / 3
    for c in range(2):
        for r in range(3):
            fx0 = sx0 + 0.03 + c * (cw + 0.02)
            fz0 = 0.11 + r * (rh + 0.02)
            bx((fx0, R + 0.012, fz0), (fx0 + cw, R + 0.03, fz0 + rh), "steel", 0.002)
            bx((fx0 + 0.03, R + 0.009, fz0 + rh - 0.065), (fx0 + cw - 0.03, R + 0.012, fz0 + rh - 0.048), "black", 0.0)
            bx((fx0 + 0.04, R + 0.0105, fz0 + 0.035), (fx0 + 0.12, R + 0.012, fz0 + 0.06), "label", 0.0)
    gy = R + 0.04
    g.poly([(sx0, gy, 1.045), (sx1, gy, 1.045), (sx1, gy, 2.08), (sx0, gy, 2.08)], "GLASS_DOOR", nrm=(0, -1, 0))
    g.poly([(t, gy, 2.15), (w - t, gy, 2.15), (w - t, gy, h - t), (t, gy, h - t)], "GLASS_DOOR", nrm=(0, -1, 0))
    return g


@lru_cache(None)
def p_plain_door(w=1.0, h=2.1, R=0.12, kf="frame_dark", glass=True, detail=True) -> G:
    """Single door (gatehouse, terraced house front doors): frame, leaf with a glass strip, lever handle."""
    g = G()
    t, b = 0.065, (0.004 if detail else 0.0)
    for p0, p1 in (((0, R, 0), (t, R + 0.07, h)), ((w - t, R, 0), (w, R + 0.07, h)), ((t, R, h - t), (w - t, R + 0.07, h))):
        g.add(box(p0, p1, kf, bev=b))
    g.add(box((-0.01, R - 0.03, -0.012), (w + 0.01, R + 0.07, 0.015), "sill", bev=b * 0.7))
    ly = R + 0.012
    g.add(box((t + 0.004, ly, 0.015), (w - t - 0.004, ly + 0.05, h - t - 0.004),
              {"*": kf, "-y": kf}, bev=b))
    if glass:
        gx0, gx1 = w * 0.5 - 0.11, w * 0.5 + 0.11
        g.add(box((gx0 - 0.02, ly - 0.006, 0.95), (gx1 + 0.02, ly, 1.85), kf, bev=b * 0.5))
        g.poly([(gx0, ly - 0.0065, 1.0), (gx1, ly - 0.0065, 1.0), (gx1, ly - 0.0065, 1.8), (gx0, ly - 0.0065, 1.8)],
               "GLASS_DOOR", nrm=(0, -1, 0))
    hx = w - t - 0.09
    g.add(box((hx - 0.018, ly - 0.008, 0.98), (hx + 0.018, ly, 1.2), "steel", bev=0.002 if detail else 0))
    g.add(cyl((hx, ly - 0.008, 1.07), (hx, ly - 0.055, 1.07), 0.009, "steel", segs=8))
    g.add(cyl((hx, ly - 0.055, 1.07), (hx - 0.13, ly - 0.055, 1.07), 0.01, "steel", segs=8))
    g.add(box((t + 0.03, ly - 0.003, 0.03), (w - t - 0.03, ly, 0.24), "steel", bev=0.001 if detail else 0))
    return g


@lru_cache(None)
def p_basement(w=0.8, h=0.32) -> G:
    """Cellar window low in the plinth, with a bar grille in front (frame built at the plinth face)."""
    g = G()
    t, R = 0.05, 0.075
    for (p0, p1), sk in zip((((0, R, 0), (t, R + 0.06, h)), ((w - t, R, 0), (w, R + 0.06, h)),
                             ((t, R, h - t), (w - t, R + 0.06, h)), ((t, R, 0), (w - t, R + 0.06, t))),
                            (("+y", "-x"), ("+y", "+x"), ("+y", "+z", "-x", "+x"), ("+y", "-z", "-x", "+x"))):
        g.add(box(p0, p1, "frame_cellar", skip=sk))
    g.poly([(t, R + 0.03, t), (w - t, R + 0.03, t), (w - t, R + 0.03, h - t), (t, R + 0.03, h - t)], "GLASS_DIRTY",
           nrm=(0, -1, 0))
    for zz in (0.045, h - 0.06):
        g.add(box((0.0, 0.018, zz), (w, 0.034, zz + 0.016), "galv", skip=("-x", "+x")))
    nb = 7
    for i in range(nb):
        x = w * (i + 0.5) / nb
        g.add(cyl((x, 0.026, 0.0), (x, 0.026, h), 0.0075, "galv", segs=6, caps=(False, False)))
    return g


@lru_cache(None)
def p_vent(w=0.3, h=0.18) -> G:
    """Louvred ventilation grille screwed onto a wall (back at y = 0)."""
    g = G()
    f = 0.018
    g.add(box((0, -0.012, 0), (w, 0, f), "alu", bev=0.003))
    g.add(box((0, -0.012, h - f), (w, 0, h), "alu", bev=0.003))
    g.add(box((0, -0.012, f), (f, 0, h - f), "alu", bev=0.003))
    g.add(box((w - f, -0.012, f), (w, 0, h - f), "alu", bev=0.003))
    g.poly([(f, -0.002, f), (w - f, -0.002, f), (w - f, -0.002, h - f), (f, -0.002, h - f)], "black", nrm=(0, -1, 0))
    n = 5
    for i in range(n):
        z = f + (h - 2 * f) * (i + 0.5) / n
        s = Matrix.Translation((w / 2, -0.006, z)) @ Matrix.Rotation(math.radians(35), 4, "X")
        g.add(box((-w / 2 + f, -0.004, -0.011), (w / 2 - f, 0.004, 0.011), "alu", skip=("-x", "+x")), s)
    return g


@lru_cache(None)
def p_ac(bracket=True, detail=True) -> G:
    """Split air-conditioner outdoor unit; with wall brackets (origin: wall face, unit bottom) or feet."""
    g = G()
    W, H, D = 0.80, 0.55, 0.29
    y1 = -0.10
    y0 = y1 - D
    zb = 0.012 if bracket else 0.04
    g.add(box((-W / 2, y0, zb), (W / 2, y1, zb + H), "ac_white", bev=0.012, segs=2 if detail else 1))
    cx, cz, r = -0.1, zb + H / 2, 0.205
    g.add(disc((cx, y0 - 0.0015, cz), r, "black", segs=20))
    g.add(cyl((cx, y0 - 0.001, cz), (cx, y0 - 0.012, cz), r + 0.012, "ac_white", segs=20, r1=r + 0.004,
              caps=(False, False)))
    nbar = 7 if detail else 4
    for i in range(nbar):
        zz = cz - r + (i + 0.5) * (2 * r / nbar)
        half = math.sqrt(max(r * r - (zz - cz) ** 2, 0.0))
        g.add(box((cx - half, y0 - 0.008, zz - 0.003), (cx + half, y0 - 0.002, zz + 0.003), "ac_white",
                  skip=("+y", "-x", "+x")))
    g.add(box((cx - 0.004, y0 - 0.01, cz - r), (cx + 0.004, y0 - 0.002, cz + r), "ac_white", skip=("+y",)))
    g.add(disc((cx, y0 - 0.011, cz), 0.04, "ac_white", segs=10))
    # louvres on the right of the front, valve cover on the side
    for i in range(6 if detail else 0):
        zz = zb + 0.12 + i * 0.055
        g.add(box((0.17, y0 - 0.006, zz), (0.36, y0, zz + 0.012), "ac_white", skip=("+y",)))
    g.add(box((W / 2, -0.31, zb + 0.04), (W / 2 + 0.028, -0.17, zb + 0.26), "ac_white", bev=0.005))
    # refrigerant pipes in white insulation, running into the wall
    for i, (yy, zz) in enumerate(((-0.27, zb + 0.09), (-0.21, zb + 0.15))):
        xo = W / 2 + 0.1 + 0.055 * i
        pts = [(W / 2 + 0.02, yy, zz), (xo, yy, zz), (xo, -0.035, zz), (xo, -0.035, zz + 0.32), (xo, 0.03, zz + 0.32)]
        g.add(tube(fillet(pts, 0.05, 3 if detail else 1), 0.021, "insul", segs=8 if detail else 6))
    g.add(tube(fillet([(W / 2 - 0.12, -0.2, zb), (W / 2 - 0.12, -0.2, zb - 0.12), (W / 2 - 0.12, -0.06, zb - 0.3),
                       (W / 2 - 0.12, -0.05, zb - 0.38)], 0.05, 3 if detail else 1), 0.008, "black",
               segs=6 if detail else 4))
    if bracket:
        bb = 0.002 if detail else 0.0
        for bx in (-0.28, 0.28):
            g.add(box((bx - 0.02, -0.48, -0.035), (bx + 0.02, 0.0, 0.0), "galv", bev=bb, skip=("+y",)))
            g.add(box((bx - 0.02, -0.035, -0.42), (bx + 0.02, 0.0, 0.0), "galv", bev=bb, skip=("+y",)))
            g.add(cyl((bx, -0.03, -0.39), (bx, -0.43, -0.03), 0.011, "galv", segs=6, caps=(False, False)))
            g.add(box((bx - 0.035, -0.37, 0.0), (bx + 0.035, -0.13, zb), "rubber", bev=bb, skip=("-z",)))
            if detail:
                g.add(box((bx - 0.045, -0.004, -0.44), (bx + 0.045, 0.0, -0.33), "galv", bev=0.0015))
    else:
        for bx in (-0.3, 0.3):
            g.add(box((bx - 0.04, -0.37, 0.0), (bx + 0.04, -0.12, zb), "rubber", skip=("-z",)))
    return g


@lru_cache(None)
def p_lantern() -> G:
    """Wall lantern: back plate, arm, glass cylinder under a cap. Origin: wall face at the glass centre height."""
    g = G()
    g.add(box((-0.055, -0.022, -0.13), (0.055, 0.0, 0.07), "lamp_body", bev=0.005))
    g.add(box((-0.013, -0.15, -0.015), (0.013, -0.02, 0.013), "lamp_body", bev=0.004))
    c = (0.0, -0.17)
    g.add(cyl((c[0], c[1], -0.1), (c[0], c[1], 0.07), 0.062, "lamp_glass", segs=14, caps=(False, False)))
    g.add(cyl((c[0], c[1], 0.07), (c[0], c[1], 0.115), 0.085, "lamp_body", segs=14, r1=0.03))
    g.add(cyl((c[0], c[1], -0.125), (c[0], c[1], -0.1), 0.07, "lamp_body", segs=14))
    g.add(cyl((c[0], c[1], -0.15), (c[0], c[1], -0.125), 0.02, "lamp_body", segs=8))
    return g


@lru_cache(None)
def p_tap() -> G:
    """Outside tap: wall rosette, body, down-turned spout with a hose connector, red lever."""
    g = G()
    g.add(cyl((0, 0.0, 0), (0, -0.012, 0), 0.036, "brass", segs=12))
    g.add(cyl((0, -0.012, 0), (0, -0.06, 0), 0.012, "brass", segs=10, caps=(False, False)))
    g.add(box((-0.022, -0.1, -0.026), (0.022, -0.055, 0.026), "brass", bev=0.006))
    g.add(cyl((0, -0.088, -0.026), (0, -0.088, -0.075), 0.011, "brass", segs=10))
    g.add(cyl((0, -0.088, -0.075), (0, -0.088, -0.1), 0.0145, "green", segs=10))
    g.add(cyl((0, -0.078, 0.026), (0, -0.078, 0.045), 0.006, "brass", segs=6))
    g.add(box((-0.05, -0.088, 0.044), (0.05, -0.068, 0.056), "red", bev=0.004))
    return g


@lru_cache(None)
def p_bell_panel() -> G:
    """Door-entry panel: steel plate with a speaker grille, camera and two rows of bell buttons."""
    g = G()
    g.add(box((0.0, -0.012, 0.0), (0.17, 0.0, 0.42), "steel", bev=0.003))
    g.add(disc((0.085, -0.0125, 0.35), 0.03, "black", segs=12))
    g.add(cyl((0.085, -0.012, 0.29), (0.085, -0.02, 0.29), 0.01, "black", segs=8))
    for r in range(5):
        for c in range(2):
            x = 0.035 + c * 0.075
            z = 0.04 + r * 0.045
            g.add(box((x, -0.0135, z), (x + 0.025, -0.012, z + 0.022), "label"))
            g.add(cyl((x + 0.045, -0.012, z + 0.011), (x + 0.045, -0.018, z + 0.011), 0.008, "steel_dark", segs=8))
    return g


@lru_cache(None)
def p_number_plate() -> G:
    g = G()
    g.add(box((0.0, -0.01, 0.0), (0.2, 0.0, 0.2), "blue", bev=0.006))
    g.add(box((0.06, -0.0115, 0.04), (0.085, -0.01, 0.16), "label"))
    g.add(box((0.11, -0.0115, 0.04), (0.145, -0.01, 0.16), "label"))
    return g


@lru_cache(None)
def p_dish() -> G:
    """Satellite dish clamped to a balcony rail (origin: rail top, front face)."""
    g = G()
    R, sag, segs = 0.3, 0.06, 14
    m = Matrix.Translation((0.0, -0.32, 0.25)) @ Matrix.Rotation(math.radians(-25), 4, "X")
    d = G()
    d.v.append(Vector((0, sag, 0)))
    for ring, rr in ((1, 0.55), (2, 1.0)):
        for i in range(segs):
            a = 2 * math.pi * i / segs
            d.v.append(Vector((R * rr * math.cos(a), sag * (1 - rr * rr), R * rr * math.sin(a))))
    for i in range(segs):
        j = (i + 1) % segs
        d.f.append(((0, 1 + j, 1 + i), "ac_white"))
        d.f.append(((1 + i, 1 + j, 1 + segs + j, 1 + segs + i), "ac_white"))
    # back side (the dish is a shell; give it a thickness so the back is never missing)
    back = G()
    back.add(d, Matrix.Translation((0, 0.012, 0)))
    back.f = [(idx[::-1], "ac_white") for idx, _ in back.f]
    d.add(back)
    g.add(d, m)
    lnb = m @ Vector((0, -0.38, -0.05))
    rim = m @ Vector((0, 0.02, -R))
    g.add(tube([rim, lnb], 0.009, "steel_dark", segs=6))
    g.add(box(lnb - Vector((0.03, 0.04, 0.03)), lnb + Vector((0.03, 0.03, 0.03)), "black", bev=0.005))
    back_c = m @ Vector((0, sag + 0.03, 0))
    g.add(tube([back_c, Vector((0, -0.03, 0.12)), Vector((0, -0.03, -0.12))], 0.02, "steel_dark", segs=8))
    return g


# =====================================================================================================
# the builder: height bands, colliders, scanned props


class Bld:
    BANDS = (("low_wall", 1.0, "lo_wall"), ("low", 1.0, "lo_detail"), ("up_wall", 0.3, "up_wall"),
             ("up", 0.3, "up_detail"), ("roof", 0.15, "roof"))

    def __init__(self, name, rect, style, coll, split, grade, seed):
        self.name, self.rect, self.coll, self.split, self.grade = name, rect, coll, split, grade
        self.g = {b: G() for b, _, _ in self.BANDS}
        self.col = G()
        self.ph: list[tuple] = []
        self.keys = dict(KEYS)
        self.keys.update(STYLES[style])
        self.rng = random.Random(zlib.crc32(name.encode()) * 31 + seed)

    def glass(self) -> str:
        r = self.rng.random()
        for name, w in GLASS_MIX:
            if r < w:
                return name
            r -= w
        return GLASS_MIX[0][0]

    def put(self, g: G, m: Matrix, z: float, remap=None, wall=False) -> None:
        band = ("low" if z < self.split else "up")
        self.g[band + ("_wall" if wall else "")].add(g, m, remap)

    def collide(self, fac: Fac | None, p0, p1) -> None:
        """Invisible collision box (given in a facade frame, or in world coordinates when fac is None)."""
        if fac is not None:
            cs = [fac.world(x, y, z) for x in (p0[0], p1[0]) for y in (p0[1], p1[1]) for z in (p0[2], p1[2])]
            p0 = [min(c[i] for c in cs) for i in range(3)]
            p1 = [max(c[i] for c in cs) for i in range(3)]
        self.col.add(box(p0, p1, "col"))

    def collide_bump(self, fac: Fac, x0: float, x1: float, depth: float, z0: float, z1: float, top_slope: float = 0.0) -> None:
        """Invisible collision for something small that stands off a wall (a pipe, a tap): a wedge with
        sloping sides, so a cat sliding along the wall is steered round it instead of running into a flat face.
        `depth` is how far it stands out; `top_slope` > 0 also slopes the top down towards the front."""
        c = depth                      # 45 degree sides
        foot = [(x0 - c, 0.0), (x1 + c, 0.0), (x1, -depth), (x0, -depth)]
        zt = [z1, z1, z1 - top_slope, z1 - top_slope]
        g = G()
        lo = [fac.world(x, y, z0) for x, y in foot]
        hi = [fac.world(x, y, z) for (x, y), z in zip(foot, zt)]
        g.poly(hi, "col")
        g.poly(lo[::-1], "col")
        for i in range(4):
            j = (i + 1) % 4
            g.poly([lo[i], lo[j], hi[j], hi[i]], "col")
        self.col.add(g)
        mid = fac.world((x0 + x1) / 2, 0.0, z0)
        out = fac.world((x0 + x1) / 2, -1.0, z0) - mid
        geo.poi("pipe", mid.x, mid.y, out.x, out.y)

    def place_ph(self, ph_id, fac: Fac, x, y, z, rot=0.0) -> None:
        self.ph.append((ph_id, fac.world(x, y, z), fac.th + rot))

    def finish(self, footprint_top: float) -> list:
        out = []
        lo = None
        for band, lm, suffix in self.BANDS:
            o = self.emit(f"{self.name}_{suffix}", self.g[band], lm)
            if o is not None:
                out.append(o)
                if band == "low":
                    lo = o
        if self.ph and lo is not None:
            parts = []
            for ph_id, loc, rot in self.ph:
                parts += ph.place(ph_id, tuple(loc), rot, coll=self.coll)
            joined = geo.join([lo] + parts, lo.name)
            geo.tag(joined, role="building", collide="none", lm=1.0)
        x0, y0, x1, y1 = self.rect
        cols = [geo.box(f"{self.name}_col", (x0, y0, self.grade - 0.3), (x1, y1, footprint_top), None, self.coll)]
        if self.col.f:
            cols.append(self.emit(f"{self.name}_col_parts", self.col, 1.0, collider=True))
        for o in cols:
            geo.tag(o, role="collider", collide="mesh")
            o.hide_render = True
        return out + cols

    def emit(self, name, g: G, lm, collider=False):
        if not g.f:
            return None
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([tuple(v) for v in g.v], [], [list(i) for i, _ in g.f])
        if not collider:
            order, idx = [], {}
            for _, k in g.f:
                if k not in idx:
                    idx[k] = len(order)
                    order.append(k)
            for k in order:
                mesh.materials.append(_material(self.keys.get(k, k)))
            mesh.polygons.foreach_set("material_index", [idx[k] for _, k in g.f])
        mesh.validate(clean_customdata=False)
        mesh.update()
        obj = geo.new_object(name, mesh, self.coll)
        geo.uv_box(obj)
        if not collider:
            _uv_slopes(obj)
            geo.shade_auto(obj, 35.0)
            geo.tag(obj, role="building", collide="none", lm=lm)
        return obj


def _uv_slopes(obj) -> None:
    """Pitched surfaces: UVs in metres along and up the slope (box projection would stretch roof tiles)."""
    mesh = obj.data
    uvl = mesh.uv_layers[geo.UV0]
    for poly in mesh.polygons:
        n = poly.normal
        if not (0.2 < abs(n.z) < 0.97):
            continue
        e1 = Vector((-n.y, n.x, 0.0)).normalized()
        e2 = n.cross(e1).normalized()
        for li in poly.loop_indices:
            p = mesh.vertices[mesh.loops[li].vertex_index].co
            uvl.data[li].uv = (p.dot(e1), p.dot(e2))


# =====================================================================================================
# shared pieces placed in facade frames


def downpipe(B: Bld, fac: Fac, x, z_top, grade, hopper=True, r=0.05) -> None:
    """Rain-water downpipe: optional hopper head at the top, clips every 2 m, a shoe over a gully."""
    yp = -(0.035 + r)
    split = B.split
    zs = grade + 0.17
    shoe_end = Vector((x, yp - 0.15, grade + 0.09))
    low_top = min(split, z_top)
    pts = fillet([(x, yp, low_top), (x, yp, zs + 0.05), shoe_end], 0.09, 5)
    B.put(tube(pts, r, "pipe", segs=12, caps=(False, True), kcap="dark"), fac.m, 0.0)
    if z_top > split:
        B.put(cyl((x, yp, split), (x, yp, z_top), r, "pipe", segs=12, caps=(False, False)), fac.m, split + 0.01)
    if hopper:
        hh = G()
        hh.add(box((x - 0.15, yp - 0.12, z_top), (x + 0.15, -0.012, z_top + 0.3), "pipe", bev=0.006))
        hh.add(cyl((x, yp, z_top), (x, yp, z_top - 0.05), r * 1.35, "pipe", segs=12, r1=r * 1.02, caps=(False, False)))
        B.put(hh, fac.m, z_top)
    z = grade + 0.75
    while z < z_top - 0.4:
        clip = G()
        clip.add(cyl((x, yp, z - 0.016), (x, yp, z + 0.016), r + 0.006, "pipe", segs=10, caps=(False, False)))
        clip.add(box((x - 0.006, yp + r, z - 0.006), (x + 0.006, 0.01, z + 0.006), "pipe"))
        B.put(clip, fac.m, z)
        z += 2.0
    # gully under the shoe
    gc = Vector((x, shoe_end.y - 0.02, grade))
    gg = G()
    gg.add(box((gc.x - 0.19, gc.y - 0.19, grade - 0.12), (gc.x + 0.19, gc.y + 0.19, grade + 0.018), "concrete", bev=0.01))
    gg.poly([(gc.x - 0.13, gc.y - 0.13, grade + 0.019), (gc.x + 0.13, gc.y - 0.13, grade + 0.019),
             (gc.x + 0.13, gc.y + 0.13, grade + 0.019), (gc.x - 0.13, gc.y + 0.13, grade + 0.019)], "black", nrm=(0, 0, 1))
    for i in range(6):
        xx = gc.x - 0.115 + i * 0.046
        gg.add(box((xx - 0.007, gc.y - 0.13, grade + 0.019), (xx + 0.007, gc.y + 0.13, grade + 0.03), "grate",
                   skip=("-z",)))
    B.put(gg, fac.m, 0.0)
    # the pipe itself, and lower down the shoe that sticks out further (low enough to step over)
    B.collide_bump(fac, x - r, x + r, -yp + r + 0.01, grade - 0.1, grade + 2.4)
    B.collide_bump(fac, x - r - 0.01, x + r + 0.01, -(shoe_end.y - r) + 0.01, grade - 0.1, grade + 0.2, top_slope=0.1)


def cable_duct(B: Bld, fac: Fac, x, z0, z1, into_wall=True) -> None:
    w, d = 0.06, 0.04
    zs = [z0, z1] if not (z0 < B.split < z1) else [z0, B.split, z1]
    for a, b in zip(zs[:-1], zs[1:]):
        B.put(box((x - w / 2, -d, a), (x + w / 2, 0.0, b), "duct", bev=0.004 if a < B.split else 0.0), fac.m, a)


def ac_unit(B: Bld, fac: Fac, x, z, bracket=True, y=0.0, collide=True) -> None:
    B.put(p_ac(bracket, z < B.split), fac.at(x, y, z), z)
    if collide and z < 1.5:
        B.collide(fac, (x - 0.45, y - 0.5, z - 0.45 if bracket else z), (x + 0.6, y, z + 0.6))


# =====================================================================================================
# apartment blocks


def _flats(name, rect, floors, style, front, coll, seed, grade) -> list:
    FFL = grade + 0.78                 # raised ground floor ("Hochparterre")
    PT = FFL - 0.06                    # top of the plinth / drip edge
    DZ = grade + 0.33                  # entrance threshold (two steps up)
    split = FFL + 2.35
    top = FFL + floors * FLOOR - 0.15  # roof surface
    par = top + 0.7                    # parapet top
    B = Bld(name, rect, style, coll, split, grade, seed)
    rng = B.rng
    fi = SIDES.index(front)
    facs = [Fac(SIDES[(fi + i) % 4], rect) for i in range(4)]   # front, right gable, back, left gable
    F, G1, BK, G2 = facs

    def win(fac, x0, z0, w, h, n, shutter_p=0.18, sill=True, glass=None):
        if not fac.hole(x0, z0, x0 + w, z0 + h):
            return
        detail = z0 < split
        m = fac.at(x0, 0.0, z0)
        shut = rng.random() < shutter_p
        tilt = (not shut) and h > 0.8 and rng.random() < 0.1
        B.put(p_window(round(w, 3), round(h, 3), n, detail, sill, tilt=tilt), m, z0, {"GLASS": glass or B.glass()})
        if shut:
            drop = round(h * rng.choice((0.25, 0.4, 0.55, 0.8, 1.0)), 2)
            B.put(p_shutter(round(w, 3), round(h, 3), drop), m, z0)

    # ---------------------------------------------------------------- front: entrances + stair windows
    L = F.L
    ne = 1 if L < 16 else (2 if L < 40 else 3)
    ents = [L * (i + 0.5) / ne for i in range(ne)]
    segs, prev = [], 0.0
    for ex in ents:
        segs.append((prev, ex - 1.35))
        prev = ex + 1.35
    segs.append((prev, L))
    fbays = []
    for a, b in segs:
        nb = max(1, round((b - a) / 3.0))
        bw = (b - a) / nb
        fbays += [(a + i * bw, a + (i + 1) * bw) for i in range(nb)]
    for i, (a, b) in enumerate(fbays):
        bw = b - a
        kind = "bath" if (i % 3 == 1 and bw > 2.0) else "kitchen"
        for k in range(floors):
            zf = FFL + k * FLOOR
            if kind == "bath":
                win(F, (a + b) / 2 - 0.32, zf + 1.35, 0.64, 0.85, 1, shutter_p=0.05,
                    glass=rng.choice(("glass_blind_grey", "glass_curtain_white")))
            else:
                w = min(1.3, bw - 0.9)
                win(F, (a + b) / 2 - w / 2, zf + 0.95, w, 1.3, 2 if w > 1.0 else 1)
    for ex in ents:
        _entrance(B, F, ex, DZ, grade, FFL, floors, split, top, rng)
        for k in range(1, floors):
            win(F, ex - 0.5, FFL + k * FLOOR - 0.6, 1.0, 1.25, 1, shutter_p=0.0, glass="glass_window")
    # ---------------------------------------------------------------- back: living rooms and balconies
    Lb = BK.L
    nb = max(2, round(Lb / 3.0))
    bw = Lb / nb
    balc = [i for i in range(nb) if i % 4 in (1, 2) and 0 < i < nb - 1]
    panel_alt = rng.random() < 0.5
    for i in range(nb):
        a, b = i * bw, (i + 1) * bw
        for k in range(floors):
            zf = FFL + k * FLOOR
            if k >= 1 and i in balc:
                dw = 0.9
                BK.holes.append((a + 0.3, zf, a + 0.3 + dw, zf + 2.2))
                B.put(p_window(dw, 2.2, 1, False, False), BK.at(a + 0.3, 0, zf), zf, {"GLASS": B.glass()})
                ww = min(1.3, bw - dw - 0.75)
                win(BK, a + 0.3 + dw + 0.3, zf + 0.95, ww, 1.3, 2 if ww > 1.0 else 1)
                _balcony(B, BK, a + 0.12, b - 0.12, zf, 1.35, rng, alt=panel_alt and (i % 2 == 0))
            else:
                w = min(1.6, bw - 0.9)
                win(BK, (a + b) / 2 - w / 2, zf + 0.9, w, 1.35, 2)
    # ---------------------------------------------------------------- gables
    for gi, Gf in enumerate((G1, G2)):
        Lg = Gf.L
        xs = (Lg * 0.3, Lg * 0.7) if Lg > 7 else (Lg * 0.5,)
        for k in range(floors):
            zf = FFL + k * FLOOR
            for j, xc in enumerate(xs):
                if gi == 0 and k == 0 and j == 1:
                    continue          # meter box and ducts go here
                win(Gf, xc - 0.35, zf + 1.25, 0.7, 0.95, 1, shutter_p=0.1)
    # ---------------------------------------------------------------- plinth: cellar windows and grilles
    def cellar(fac, xc, vent=False):
        if vent:
            B.put(p_vent(), fac.at(xc - 0.15, 0.03, grade + 0.3), 0.0)
        else:
            w, h = 0.8, 0.32
            z0 = grade + 0.17
            if not fac.hole(xc - w / 2, z0, xc + w / 2, z0 + h):
                return
            B.put(p_basement(w, h), fac.at(xc - w / 2, 0.03, z0), 0.0, {"GLASS_DIRTY": "glass_blind_grey"})

    for i, (a, b) in enumerate(fbays):
        cellar(F, (a + b) / 2 + (0.6 if i % 2 else -0.6), vent=(i % 2 == 1))
    for i in range(nb):
        cellar(BK, (i + 0.5) * bw + 0.35, vent=(i % 3 == 2))
    cellar(G1, G1.L * 0.3)
    cellar(G2, G2.L * 0.5, vent=True)
    # ---------------------------------------------------------------- pipes, boxes, taps, ducts, air conditioners
    for fac in (F, BK):
        for x in (0.28, fac.L - 0.28):
            downpipe(B, fac, x, top - 0.35, grade)
    if Lb > 20:
        downpipe(B, BK, bw * round(nb / 2), top - 0.35, grade)
    B.put(p_tap(), BK.at(bw * 1.0 - 0.45, 0.03, grade + 0.5), 0.0)
    xb = G1.L * 0.7
    B.place_ph("utility_box_01", G1, xb, -0.245, grade - 0.02)
    B.collide(G1, (xb - 0.28, -0.47, grade - 0.1), (xb + 0.28, 0.0, grade + 1.12))
    cable_duct(B, G1, xb + 0.15, grade + 1.1, FFL + 1.9)
    cable_duct(B, G2, G2.L - 1.2, grade + 0.25, par - 0.05)
    # one air conditioner at cat height on the back, one higher on a gable, a few on the front wall
    acx = [i for i in range(nb) if i not in balc]
    if acx:
        i = rng.choice(acx)
        ac_unit(B, BK, (i + 0.5) * bw - 0.75, grade + 0.68)
    ac_unit(B, G2, G2.L * 0.28, FFL + 0.35)
    for i, (a, b) in enumerate(fbays):
        if rng.random() < 0.2 and floors > 1:
            k = rng.randrange(1, floors)
            ac_unit(B, F, (a + b) / 2, FFL + k * FLOOR + 0.25)
    B.put(p_lantern(), BK.at(Lb * 0.5 + 0.05, 0.0, FFL + 1.85), FFL)
    # ---------------------------------------------------------------- walls
    for fac in facs:
        kf = fac.holes
        xm = None
        if fac is F:
            # the stairwell above each entrance is rendered in a second colour, ground to roof
            xm, a = [], 0.0
            for ex in ents:
                xm += [(a, ex - 1.05, "wall"), (ex - 1.05, ex + 1.05, "accent")]
                a = ex + 1.05
            xm.append((a, fac.L, "wall"))
        layer(B, "low_wall", fac, 0.03, grade - 0.35, PT, kf, "plinth", "plinth")
        layer(B, "low_wall", fac, 0.0, PT, split, kf, "wall", "reveal", arc_z=(PT, split), xmats=xm)
        layer(B, "up_wall", fac, 0.0, split, par, kf, "wall", "reveal", xmats=xm)
        _drip(B, fac, PT, kf)
        # parapet coping and inner face
        cop = [(-0.33, par - 0.04, "profile"), (-0.325, par - 0.04, "profile"), (-0.325, par, "profile"), (0.035, par, "profile"),
               (0.035, par - 0.07, "profile"), (0.042, par - 0.07, "profile"), (0.042, par + 0.03, "profile"), (-0.33, par + 0.03, "profile")]
        B.put(run(cop, 0.0, fac.L, True, True), fac.m, par)
        q = G()
        q.poly([(0.3, 0.3, top), (fac.L - 0.3, 0.3, top), (fac.L - 0.3, 0.3, par), (0.3, 0.3, par)], "wall", nrm=(0, 1, 0))
        q.add(box((0.3, 0.3, top), (fac.L - 0.3, 0.36, top + 0.18), "roof", skip=("-y", "-z", "-x", "+x")))
        B.g["roof"].add(q, fac.m)
    x0, y0, x1, y1 = rect
    r = G()
    r.poly([(x0 + 0.3, y0 + 0.3, top), (x1 - 0.3, y0 + 0.3, top), (x1 - 0.3, y1 - 0.3, top), (x0 + 0.3, y1 - 0.3, top)],
           "roof", nrm=(0, 0, 1))
    B.g["roof"].add(r)
    # stair housings on the roof above each entrance, vent pipes, an aerial
    for i, ex in enumerate(ents):
        h = G()
        h.add(box((ex - 1.4, 0.6, top), (ex + 1.4, 3.6, top + 2.3), {"*": "wall", "+z": "roof", "-z": "roof"}, skip=("-z",)))
        h.add(box((ex - 1.45, 0.55, top + 2.3), (ex + 1.45, 3.65, top + 2.36), "alu"))
        h.add(box((ex - 0.45, 0.58, top + 0.02), (ex + 0.45, 0.6, top + 2.05), "steel_dark"))
        if i == 0:
            h.add(cyl((ex + 0.9, 2.5, top + 2.36), (ex + 0.9, 2.5, top + 5.0), 0.025, "steel", segs=6))
            h.add(box((ex + 0.3, 2.47, top + 4.4), (ex + 1.5, 2.53, top + 4.43), "steel"))
            h.add(box((ex + 0.4, 2.47, top + 4.7), (ex + 1.4, 2.53, top + 4.73), "steel"))
        B.g["roof"].add(h, F.m)
    for k in range(3):
        px = x0 + (x1 - x0) * (0.2 + 0.3 * k)
        py = (y0 + y1) / 2 + (1.2 if k % 2 else -1.2)
        B.g["roof"].add(cyl((px, py, top), (px, py, top + 0.55), 0.055, "pipe", segs=10))
    return B.finish(par + 0.05)


def _drip(B: Bld, fac: Fac, PT, holes) -> None:
    """Aluminium plinth profile with a drip nose, interrupted at door openings."""
    prof = [(-0.032, PT - 0.003, "profile"), (0.017, PT - 0.003, "profile"), (0.017, PT - 0.022, "profile"), (0.021, PT - 0.022, "profile"),
            (0.021, PT + 0.008, "profile"), (0.017, PT + 0.008, "profile"), (0.017, PT, "profile"), (-0.032, PT, "profile")]
    cuts = sorted((h[0], h[2]) for h in holes if h[1] < PT < h[3])
    xs, a = [], 0.0
    for c0, c1 in cuts:
        xs.append((a, c0, a == 0.0, False))
        a = c1
    xs.append((a, fac.L, a == 0.0, True))
    for x0, x1, m0, m1 in xs:
        if x1 - x0 > 0.01:
            B.put(run(prof, x0, x1, m0, m1), fac.m, 0.0)


def _entrance(B: Bld, F: Fac, ex, DZ, grade, FFL, floors, split, top, rng) -> None:
    """Steps with a landing, door mat, entrance door, canopy, lantern, bell panel, handrail."""
    w, h = 1.9, 2.35
    F.holes.append((ex - w / 2, DZ, ex + w / 2, DZ + h))
    B.put(p_entrance_door(w, h), F.at(ex - w / 2, 0.0, DZ), 0.0, {"GLASS_DOOR": "glass_window"})
    g = G()
    LD, SW = 1.55, 1.35        # landing depth, half width
    g.add(box((ex - SW, -LD, grade - 0.3), (ex + SW, 0.03, DZ), "concrete", bev=0.012, segs=2))
    nst = max(1, round((DZ - grade) / 0.165))
    rise = (DZ - grade) / nst
    for i in range(1, nst):
        g.add(box((ex - SW, -LD - i * 0.32, grade - 0.3), (ex + SW, -LD - (i - 1) * 0.32 + 0.02, DZ - i * rise), "concrete",
                  bev=0.012, segs=2))
    yfront = -LD - (nst - 1) * 0.32
    # door mat in front of the leaf
    g.add(box((ex - w / 2 + 0.08, -0.77, DZ), (ex - w / 2 + 1.12, -0.08, DZ + 0.008), "rubber", bev=0.003))
    g.add(box((ex - w / 2 + 0.11, -0.74, DZ + 0.004), (ex - w / 2 + 1.09, -0.11, DZ + 0.02), "doormat", bev=0.004))
    # canopy
    cz = DZ + h + 0.12
    g.add(box((ex - 1.45, -1.4, cz), (ex + 1.45, 0.02, cz + 0.16), "canopy", bev=0.01, segs=2))
    g.add(box((ex - 1.47, -1.42, cz + 0.16), (ex + 1.47, 0.02, cz + 0.2), "alu", bev=0.004))
    g.add(cyl((ex, -0.7, cz), (ex, -0.7, cz - 0.02), 0.07, "lamp_glass", segs=12))
    # handrail on the right of the steps
    hx = ex + SW - 0.1
    ya, yb = -0.25, yfront - 0.05
    za, zb = DZ + 0.9, grade + 0.9 + 0.05
    for yy, zt in ((ya, za), ((ya + yb) / 2, (za + zb) / 2), (yb, zb)):
        zg = DZ if yy > -LD else grade
        g.add(cyl((hx, yy, zg - 0.05), (hx, yy, zt), 0.022, "rail", segs=10))
    g.add(tube(fillet([(hx, 0.0, za), (hx, ya, za), (hx, -LD, za), (hx, yb, zb), (hx, yb - 0.25, zb)], 0.08, 4), 0.021,
               "rail", segs=10))
    B.put(g, F.m, 0.0)
    B.put(p_bell_panel(), F.at(ex - w / 2 - 0.32, 0.0, DZ + 1.12), 0.0)
    B.put(p_lantern(), F.at(ex + w / 2 + 0.28, 0.0, DZ + 1.95), 0.0)
    B.put(p_number_plate(), F.at(ex + w / 2 + 0.18, 0.0, DZ + 2.25), 0.0)
    B.collide(F, (ex - SW, -LD, grade - 0.2), (ex + SW, 0.0, DZ))
    for i in range(1, nst):
        B.collide(F, (ex - SW, -LD - i * 0.32, grade - 0.2), (ex + SW, -LD, DZ - i * rise))
    top_of_steps = F.world(ex - 0.5, -LD + 0.4, DZ)
    down = F.world(ex - 0.5, -LD - 1.0, DZ) - F.world(ex - 0.5, -LD, DZ)
    geo.poi("steps", top_of_steps.x, top_of_steps.y, down.x, down.y)
    for yy, zt in ((ya, za), ((ya + yb) / 2, (za + zb) / 2), (yb, zb)):
        B.collide(F, (hx - 0.03, yy - 0.03, grade - 0.1), (hx + 0.03, yy + 0.03, zt))


def _balcony(B: Bld, fac: Fac, bx0, bx1, zf, D, rng, alt=False) -> None:
    g = G()
    g.add(box((bx0, -D, zf - 0.2), (bx1, 0.05, zf - 0.02), "slab", bev=0.008))
    pk = "panel_alt" if alt else "panel"
    pz0, pz1 = zf - 0.17, zf + 0.95
    g.add(box((bx0, -D - 0.035, pz0), (bx1, -D - 0.008, pz1), pk))
    g.add(box((bx0 - 0.035, -D - 0.035, pz0), (bx0 - 0.008, 0.0, pz1), pk))
    g.add(box((bx1 + 0.008, -D - 0.035, pz0), (bx1 + 0.035, 0.0, pz1), pk))
    g.add(box((bx0 - 0.05, -D - 0.05, pz1), (bx1 + 0.05, -D + 0.01, pz1 + 0.045), "rail"))
    g.add(box((bx0 - 0.05, -D + 0.01, pz1), (bx0 + 0.01, 0.0, pz1 + 0.045), "rail"))
    g.add(box((bx1 - 0.01, -D + 0.01, pz1), (bx1 + 0.05, 0.0, pz1 + 0.045), "rail"))
    g.add(cyl((bx0 + 0.25, -D + 0.1, zf - 0.13), (bx0 + 0.25, -D - 0.13, zf - 0.13), 0.016, "pipe", segs=6,
              caps=(False, True), kcap="dark"))
    B.put(g, fac.m, zf)
    r = rng.random()
    if r < 0.3:
        B.put(p_ac(False, False), fac.at(bx1 - 0.6, -D + 0.45, zf - 0.02), zf)
    elif r < 0.55:
        B.put(p_dish(), fac.at(bx0 + 0.55 + rng.random() * 0.8, -D - 0.02, pz1 + 0.045), zf)


# =====================================================================================================
# terraced houses


_TINTS = ((1.0, 0.97, 0.9), (0.95, 0.95, 0.94), (1.0, 0.92, 0.78), (0.98, 0.88, 0.8), (0.88, 0.9, 0.86),
          (1.0, 0.95, 0.84), (0.9, 0.9, 0.92))


def _tint_mat(i: int) -> str:
    name = f"plaster_tint_{i}"
    if bpy.data.materials.get(name) is None:
        mat.tile(name, "white_plaster_02", tint=_TINTS[i % len(_TINTS)])
    return name


def _terrace(name, rect, floors, style, front, coll, seed, grade) -> list:
    FFL = grade + 0.23
    PT = FFL - 0.04
    split = FFL + 2.42
    ZE = FFL + floors * FLOOR - 0.45     # top of the eaves walls
    pitch = math.radians(37.0)
    tp = math.tan(pitch)
    B = Bld(name, rect, style, coll, split, grade, seed)
    rng = B.rng
    fi = SIDES.index(front)
    F, G1, BK, G2 = [Fac(SIDES[(fi + i) % 4], rect) for i in range(4)]
    L, D = F.L, F.D
    # ---------------------------------------------------------------- houses along the front
    # party walls on the plan's 10 m garden grid (world coordinates), houses at least 6 m wide
    origin = F.world(0, 0, 0)
    along = F.world(1, 0, 0) - origin
    axis = 0 if abs(along.x) > 0.5 else 1
    sgn = along[axis]
    cuts = []
    k0 = math.floor((min(origin[axis], origin[axis] + sgn * L) - TERRACE_GRID_X0) / 10.0)
    for k in range(k0 - 1, k0 + int(L / 10) + 3):
        u = (TERRACE_GRID_X0 + 10.0 * k - origin[axis]) * sgn
        if 0.0 < u < L:
            cuts.append(u)
    cuts = sorted(cuts)
    bounds = [0.0]
    for u in cuts:
        if u - bounds[-1] >= 6.0 and L - u >= 6.0:
            bounds.append(u)
    bounds.append(L)
    houses = list(zip(bounds[:-1], bounds[1:]))
    tints = [_tint_mat(zlib.crc32(f"{name}{i}".encode()) % len(_TINTS)) for i in range(len(houses))]
    xm_front = [(a, b, tints[i]) for i, (a, b) in enumerate(houses)]
    xm_back = [(L - b, L - a, tints[i]) for i, (a, b) in enumerate(houses)]

    def win(fac, x0, z0, w, h, n, sill=True, shutter_p=0.15, glass=None):
        if not fac.hole(x0, z0, x0 + w, z0 + h):
            return
        detail = z0 < split
        m = fac.at(x0, 0.0, z0)
        shut = rng.random() < shutter_p
        tilt = (not shut) and rng.random() < 0.1
        B.put(p_window(round(w, 3), round(h, 3), n, detail, sill, tilt=tilt), m, z0, {"GLASS": glass or B.glass()})
        if shut:
            B.put(p_shutter(round(w, 3), round(h, 3), round(h * rng.choice((0.3, 0.5, 1.0)), 2)), m, z0)

    for i, (a, b) in enumerate(houses):
        hw = b - a
        mid = (a + b) / 2
        flip = i % 2 == 1                      # mirror every other house, as real terraces do
        def X(u, w=0.0):
            return (b - u - w) if flip else (a + u)
        # garden side, ground floor: patio door + window, upper floor: two or three windows
        up = max(1.0, 0.12 * hw)
        pdx = X(up, 2.1)
        F.holes.append((pdx, FFL, pdx + 2.1, FFL + 2.15))
        B.put(p_window(2.1, 2.15, 2, True, False), F.at(pdx, 0, FFL), 0.0, {"GLASS": B.glass()})
        g = G()
        g.add(box((pdx - 0.03, -0.06, FFL - 0.012), (pdx + 2.13, 0.14, FFL + 0.006), "sill", bev=0.003))
        g.add(box((pdx - 0.2, -0.5, grade - 0.25), (pdx + 2.3, 0.0, FFL - 0.04), "concrete", bev=0.012, segs=2))
        B.put(g, F.m, 0.0)
        B.collide(F, (pdx - 0.2, -0.5, grade - 0.2), (pdx + 2.3, 0.0, FFL - 0.04))
        gw = max(0.42 * hw, up + 2.1 + 0.7)
        win(F, X(gw, 1.4), FFL + 0.85, 1.4, 1.3, 2)
        if hw > 9.0:
            win(F, X(hw - 1.6, 0.6), FFL + 1.3, 0.6, 0.85, 1, glass="glass_blind_grey")
        if hw > 11.5:
            win(F, X(0.64 * hw, 1.4), FFL + 0.85, 1.4, 1.3, 2)
        zf = FFL + FLOOR
        win(F, X(up + 0.35, 1.4), zf + 0.85, 1.4, 1.3, 2)
        win(F, X(gw + 0.1, 1.2), zf + 0.85, 1.2, 1.3, 2)
        if hw > 8.0:
            win(F, X(hw - 2.2, 0.8), zf + 1.1, 0.8, 1.05, 1)
        if hw > 11.5:
            win(F, X(0.64 * hw + 0.1, 1.2), zf + 0.85, 1.2, 1.3, 2)
        # details at the foot of the wall
        tx = X(up - 0.45)
        B.put(p_tap(), F.at(tx, 0.03, grade + 0.48), 0.0)
        B.put(p_lantern(), F.at(X(up + 2.45), 0.0, FFL + 1.95), 0.0)
        B.put(p_vent(0.22, 0.15), F.at(X(0.58 * hw), 0.03, grade + 0.06), 0.0)
        if i % 3 == 1:
            # roll-out awning cassette above the patio door
            aw = G()
            aw.add(box((pdx - 0.3, -0.24, FFL + 2.42), (pdx + 2.4, 0.0, FFL + 2.6), "fascia", bev=0.01))
            aw.add(box((pdx - 0.25, -0.05, FFL + 2.35), (pdx - 0.15, 0.0, FFL + 2.62), "alu", bev=0.004))
            aw.add(box((pdx + 2.25, -0.05, FFL + 2.35), (pdx + 2.35, 0.0, FFL + 2.62), "alu", bev=0.004))
            B.put(aw, F.m, 0.0)
        if i % 4 == 2:
            ac_unit(B, F, X(0.58 * hw + 0.6), grade + 0.38, bracket=True)
        # back (street) side: front door with a small canopy, windows
        bx = L - X(0.2 * hw, 1.0)
        BK.holes.append((bx - 1.0, FFL, bx, FFL + 2.1))
        B.put(p_plain_door(1.0, 2.1, 0.12, "frame_dark", True, False), BK.at(bx - 1.0, 0, FFL), 0.0,
              {"GLASS_DOOR": "glass_curtain_white"})
        B.put(box((bx - 1.3, -0.9, FFL + 2.3), (bx + 0.3, 0.0, FFL + 2.42), "canopy"), BK.m, 0.0)
        B.put(box((bx - 1.3, -1.0, grade - 0.2), (bx + 0.3, 0.0, FFL - 0.02), "concrete"), BK.m, 0.0)
        backs = [(0.4 * hw, 1.2, FFL + 0.9, 1.25), (0.18 * hw, 1.2, zf + 0.9, 1.25), (0.5 * hw, 1.2, zf + 0.9, 1.25)]
        if hw > 11.5:
            backs += [(0.75 * hw, 1.2, FFL + 0.9, 1.25), (0.75 * hw, 1.2, zf + 0.9, 1.25)]
        for (u, w, zz, hh) in backs:
            xx = L - X(u, w) - w
            if not BK.hole(xx, zz, xx + w, zz + hh):
                continue
            B.put(p_window(w, hh, 2, False, True), BK.at(xx, 0, zz), zz, {"GLASS": B.glass()})
    # downpipes from the gutters at every party wall and at both ends
    pipes_f = [0.3] + [b for _, b in houses[:-1]] + [L - 0.3]
    for j, u in enumerate(pipes_f):
        x = u + (0.3 if 0 < j < len(pipes_f) - 1 else 0.0)   # beside the garden fence on the party wall line
        _gutter_pipe(B, F, x, ZE, grade)
    for u in (0.3, L - 0.3):
        _gutter_pipe(B, BK, u, ZE, grade)
    # ---------------------------------------------------------------- walls
    for fac, xm in ((F, xm_front), (BK, xm_back)):
        layer(B, "low_wall", fac, 0.02, grade - 0.3, PT, fac.holes, "plinth", "plinth")
        layer(B, "low_wall", fac, 0.0, PT, split, fac.holes, "wall", "reveal", xmats=xm)
        layer(B, "up_wall", fac, 0.0, split, ZE + 0.05, fac.holes, "wall", "reveal", xmats=xm)
        _drip(B, fac, PT, fac.holes)
    rbase = ZE + 0.06                      # gable walls run up under the roof slab
    for gi, fac in enumerate((G1, G2)):
        Lg = fac.L
        apex = rbase + (Lg / 2) * tp
        shape = Polygon([(CORNER, grade - 0.3), (Lg - CORNER, grade - 0.3), (Lg - CORNER, rbase), (Lg / 2, apex),
                         (CORNER, rbase)])
        tint = tints[-1] if gi == 0 else tints[0]
        for zf in (FFL + 1.2, FFL + FLOOR + 1.2):
            win(fac, Lg / 2 - 0.35, zf, 0.7, 0.95, 1)
        layer(B, "low_wall", fac, 0.02, grade - 0.3, PT, fac.holes, "plinth", "plinth")
        layer(B, "low_wall", fac, 0.0, PT, split, fac.holes, tint, "reveal",
                   shape=shape, arc_z=(PT, split))
        layer(B, "up_wall", fac, 0.0, split, apex + 0.1, fac.holes, tint, "reveal",
                   shape=shape, arc_z=(split, ZE + 0.05))
        _drip(B, fac, PT, fac.holes)
    # ---------------------------------------------------------------- roof
    ov, ovv, th = 0.38, 0.25, 0.14
    zt0 = ZE + 0.25                        # roof top surface right above the eaves walls
    def zt(y):
        return zt0 + (y if y <= D / 2 else D - y) * tp
    ze = zt0 - ov * tp
    zr = zt0 + (D / 2) * tp
    tb = th / math.cos(pitch)
    prof = [(ov, ze - tb, "fascia"), (ov, ze, "tiles_roof"), (-D / 2, zr, "tiles_roof"), (-(D + ov), ze, "fascia"),
            (-(D + ov), ze - tb, "fascia"), (-D / 2, zr - tb, "fascia")]
    B.g["roof"].add(run(prof, -ovv, L + ovv, kcap="fascia"), F.m)
    # ridge tiles, chimneys, roof windows
    rg = G()
    rg.add(cyl((-ovv, D / 2, zr + 0.02), (L + ovv, D / 2, zr + 0.02), 0.09, "tiles_roof", segs=8))
    for j, u in enumerate([b for _, b in houses[:-1]]):
        if j % 2 == 0:
            cz0 = zr - 0.9
            rg.add(box((u - 0.36, D / 2 - 0.32, cz0), (u + 0.36, D / 2 + 0.32, zr + 0.95), "bricks"))
            rg.add(box((u - 0.42, D / 2 - 0.38, zr + 0.95), (u + 0.42, D / 2 + 0.38, zr + 1.05), "concrete"))
            for dx in (-0.16, 0.16):
                rg.add(cyl((u + dx, D / 2, zr + 1.05), (u + dx, D / 2, zr + 1.35), 0.08, "terracotta", segs=10))
    for i, (a, b) in enumerate(houses):
        if i % 3 != 2:
            continue
        s = 1.4
        y = s * math.cos(pitch)
        z = zt(y)
        m = Matrix.Translation((a + (b - a) * 0.55, y, z)) @ Matrix.Rotation(pitch, 4, "X")
        rw = G()
        rw.add(box((-0.39, -0.0, -0.01), (0.39, 1.0, 0.07), "frame_dark", skip=("-z",)))
        rw.poly([(-0.33, 0.06, 0.071), (0.33, 0.06, 0.071), (0.33, 0.94, 0.071), (-0.33, 0.94, 0.071)], "glass_window",
                nrm=(0, 0, 1))
        rg.add(rw, m)
    B.g["roof"].add(rg, F.m)
    # eaves: fascia board, soffit, half-round gutter on both long sides
    for fac in (F, BK):
        e = G()
        e.add(box((-ovv, -ov - 0.025, ze - 0.24), (fac.L + ovv, -ov, ze - tb + 0.01), "fascia"))
        e.add(box((-ovv, -ov, ZE - 0.06), (fac.L + ovv, 0.0, ZE - 0.04), "fascia", skip=("+y",)))
        gr, gt = 0.065, 0.004
        gy = -ov - 0.025 - gr
        gz = ze - 0.06
        pr = []
        for s in range(9):
            a = math.pi * s / 8
            pr.append((-gy + gr * math.cos(a), gz - gr * math.sin(a), "gutter"))
        for s in range(8, -1, -1):
            a = math.pi * s / 8
            pr.append((-gy + (gr - gt) * math.cos(a), gz - (gr - gt) * math.sin(a), "gutter"))
        e.add(run(pr, -ovv + 0.02, fac.L + ovv - 0.02, kcap="gutter"))
        B.put(e, fac.m, ze)
        # stop the eaves boxes at the verge with an end board
        for x in (-ovv, fac.L + ovv):
            eb = G()
            eb.poly([(x, -ov, ZE - 0.06), (x, 0.0, ZE - 0.06), (x, 0.0, zt0 - tb), (x, -ov, ze - tb)], "fascia",
                    nrm=(-1 if x < 0 else 1, 0, 0))
            B.put(eb, fac.m, ze)
    return B.finish(zr + 0.2)


def _gutter_pipe(B: Bld, fac: Fac, x, ZE, grade) -> None:
    """Downpipe from the eaves gutter: outlet, swan neck back to the wall, then down to a shoe."""
    ov = 0.38
    r = 0.04
    gy = -ov - 0.025 - 0.065
    tp = math.tan(math.radians(37.0))
    zg = ZE + 0.25 - ov * tp - 0.06 - 0.06
    yp = -(0.03 + r)
    neck = fillet([(x, gy, zg), (x, gy, zg - 0.18), (x, yp, zg - 0.55), (x, yp, zg - 0.9)], 0.12, 5)
    B.put(tube(neck, r, "gutter", segs=10, caps=(False, False)), fac.m, zg)
    zs = grade + 0.17
    shoe_end = (x, yp - 0.14, grade + 0.09)
    low_top = min(B.split, zg - 0.9)
    B.put(tube(fillet([(x, yp, low_top), (x, yp, zs + 0.05), shoe_end], 0.08, 5), r, "gutter", segs=10,
               caps=(False, True), kcap="dark"), fac.m, 0.0)
    if zg - 0.9 > B.split:
        B.put(cyl((x, yp, B.split), (x, yp, zg - 0.9), r, "gutter", segs=10, caps=(False, False)), fac.m, B.split + 0.01)
    z = grade + 0.8
    while z < zg - 1.0:
        c = G()
        c.add(cyl((x, yp, z - 0.014), (x, yp, z + 0.014), r + 0.006, "gutter", segs=10, caps=(False, False)))
        c.add(box((x - 0.005, yp + r, z - 0.005), (x + 0.005, 0.005, z + 0.005), "steel"))
        B.put(c, fac.m, z)
        z += 1.9
    gg = G()
    gc = (x, shoe_end[1] - 0.02)
    gg.add(box((gc[0] - 0.16, gc[1] - 0.16, grade - 0.12), (gc[0] + 0.16, gc[1] + 0.16, grade + 0.02), "concrete", bev=0.01))
    gg.poly([(gc[0] - 0.11, gc[1] - 0.11, grade + 0.021), (gc[0] + 0.11, gc[1] - 0.11, grade + 0.021),
             (gc[0] + 0.11, gc[1] + 0.11, grade + 0.021), (gc[0] - 0.11, gc[1] + 0.11, grade + 0.021)], "black", nrm=(0, 0, 1))
    for i in range(5):
        xx = gc[0] - 0.09 + i * 0.045
        gg.add(box((xx - 0.006, gc[1] - 0.11, grade + 0.021), (xx + 0.006, gc[1] + 0.11, grade + 0.031), "grate",
                   skip=("-z",)))
    B.put(gg, fac.m, 0.0)
    B.collide_bump(fac, x - r, x + r, -yp + r + 0.01, grade - 0.1, grade + 2.4)
    B.collide_bump(fac, x - r - 0.01, x + r + 0.01, -yp + r + 0.16, grade - 0.1, grade + 0.2, top_slope=0.1)


# =====================================================================================================
# gatehouse


def _gatehouse(name, rect, floors, style, front, coll, seed, grade) -> list:
    FFL = grade + 0.16
    PT = FFL - 0.03
    ZW = FFL + 2.85
    split = ZW + 1.0                       # all of it is near the ground
    B = Bld(name, rect, style, coll, split, grade, seed)
    fi = SIDES.index(front)
    F, R, BK, Lf = [Fac(SIDES[(fi + i) % 4], rect) for i in range(4)]

    def win(fac, x0, z0, w, h, n, glass=None):
        if not fac.hole(x0, z0, x0 + w, z0 + h):
            return
        B.put(p_window(round(w, 3), round(h, 3), n, True, True, 0.12, 0.065, "frame_dark"), fac.at(x0, 0, z0), 0.0,
              {"GLASS": glass or B.glass()})

    L = F.L
    dx = 0.7
    F.holes.append((dx, FFL, dx + 1.0, FFL + 2.12))
    B.put(p_plain_door(1.0, 2.12, 0.12, "frame_dark", True, True), F.at(dx, 0, FFL), 0.0, {"GLASS_DOOR": "glass_window"})
    win(F, dx + 1.55, FFL + 0.8, min(2.6, L - dx - 2.1), 1.45, 3, glass="glass_window")
    win(R, R.L / 2 - 1.3, FFL + 0.8, 2.6, 1.45, 3, glass="glass_window")
    win(BK, BK.L / 2 - 0.45, FFL + 1.15, 0.9, 1.05, 1)
    win(Lf, Lf.L * 0.35 - 0.45, FFL + 1.15, 0.9, 1.05, 1, glass="glass_blind_grey")
    # step, mat, lantern, bell, meter cabinet, air conditioner, tap, vent
    g = G()
    g.add(box((dx - 0.25, -0.75, grade - 0.25), (dx + 1.25, 0.0, FFL - 0.01), "concrete", bev=0.012, segs=2))
    g.add(box((dx + 0.1, -0.62, FFL - 0.01), (dx + 0.9, -0.12, FFL + 0.004), "doormat", bev=0.003))
    B.put(g, F.m, 0.0)
    B.collide(F, (dx - 0.25, -0.75, grade - 0.2), (dx + 1.25, 0.0, FFL))
    B.put(p_lantern(), F.at(dx - 0.3, 0, FFL + 2.0), 0.0)
    B.put(p_bell_panel(), F.at(dx + 1.12, 0, FFL + 1.0), 0.0)
    mb = G()
    mx = BK.L * 0.2
    mb.add(box((mx - 0.3, -0.26, grade - 0.02), (mx + 0.3, -0.02, grade + 0.95), "panel_grey", bev=0.01, segs=2))
    mb.add(box((mx - 0.27, -0.265, grade + 0.06), (mx + 0.27, -0.26, grade + 0.9), "panel_grey", bev=0.002))
    mb.add(box((mx + 0.2, -0.28, grade + 0.45), (mx + 0.24, -0.265, grade + 0.55), "black", bev=0.003))
    mb.add(box((mx - 0.34, -0.3, grade + 0.95), (mx + 0.34, 0.0, grade + 1.0), "panel_grey", bev=0.006))
    B.put(mb, BK.m, 0.0)
    B.collide(BK, (mx - 0.3, -0.3, grade - 0.1), (mx + 0.3, 0.0, grade + 1.0))
    ac_unit(B, BK, BK.L * 0.72, grade + 0.55)
    B.put(p_tap(), Lf.at(Lf.L * 0.75, 0.03, grade + 0.45), 0.0)
    B.put(p_vent(), R.at(0.6, 0.03, grade + 0.02), 0.0)
    cable_duct(B, BK, mx, grade + 1.0, ZW - 0.1)
    # roof slab with a deep overhang, metal edge, downpipe at one corner
    for fac in (F, R, BK, Lf):
        layer(B, "low_wall", fac, 0.02, grade - 0.3, PT, fac.holes, "plinth", "plinth")
        layer(B, "low_wall", fac, 0.0, PT, ZW + 0.05, fac.holes, "wall", "reveal")
        _drip(B, fac, PT, fac.holes)
    x0, y0, x1, y1 = rect
    ov = 0.6
    slab = G()
    slab.add(box((x0 - ov, y0 - ov, ZW), (x1 + ov, y1 + ov, ZW + 0.26), {"*": "fascia", "-z": "canopy", "+z": "roof"},
                 skip=("+z",)))
    B.g["low"].add(slab)
    big = (x0 - ov, y0 - ov, x1 + ov, y1 + ov)
    edge = [(0.0, ZW + 0.2, "profile"), (0.03, ZW + 0.2, "profile"), (0.03, ZW + 0.33, "profile"), (-0.06, ZW + 0.33, "profile"),
            (-0.06, ZW + 0.30, "profile"), (0.0, ZW + 0.30, "profile")]
    for s in SIDES:
        bf = Fac(s, big)
        B.g["low"].add(run(edge, 0.0, bf.L, True, True), bf.m)
    top = G()
    top.poly([(x0 - ov, y0 - ov, ZW + 0.26), (x1 + ov, y0 - ov, ZW + 0.26), (x1 + ov, y1 + ov, ZW + 0.26),
              (x0 - ov, y1 + ov, ZW + 0.26)], "roof", nrm=(0, 0, 1))
    B.g["roof"].add(top)
    # downpipe from a spout through the slab edge at the back-right corner
    px = BK.L - 0.25
    yp = -0.09
    sp = G()
    sp.add(tube(fillet([(px, -ov - 0.05, ZW + 0.12), (px, -ov + 0.15, ZW - 0.05), (px, yp, ZW - 0.35)], 0.1, 4) +
                [Vector((px, yp, grade + 0.25))], 0.04, "pipe", segs=10, caps=(True, False)))
    sp.add(tube(fillet([(px, yp, grade + 0.25), (px, yp, grade + 0.2), (px, yp - 0.15, grade + 0.09)], 0.06, 4), 0.04,
                "pipe", segs=10, caps=(False, True), kcap="dark"))
    B.put(sp, BK.m, 0.0)
    B.keys["panel_grey"] = "paint_grey"
    return B.finish(ZW + 0.35)


# =====================================================================================================


def build_block(name: str, rect, floors: int, style: str, front: str, coll=None, seed: int = 0,
                grade: float = GRADE) -> list:
    """Build one building in place. rect = (x0, y0, x1, y1) footprint in metres; front = side with the entrances.
    grade = ground height next to the walls (the estate's beds and paths are 0.10 to 0.14)."""
    coll = coll or bpy.context.scene.collection
    if style == "terrace":
        return _terrace(name, rect, floors, style, front, coll, seed, grade)
    if style not in STYLES:
        raise KeyError(f"unknown building style {style!r}")
    if style == "gatehouse" or floors <= 1:
        # a single storey is never a block of flats: build the hut, rendered in the style's finish
        # (sets/plan.py lists the gatehouse as a one-floor "plaster" building)
        return _gatehouse(name, rect, floors, style, front, coll, seed, grade)
    return _flats(name, rect, floors, style, front, coll, seed, grade)


def triangles(objs) -> int:
    return sum(len(p.vertices) - 2 for o in objs if o.type == "MESH" and not o.hide_render for p in o.data.polygons)


def demo(coll, name=None) -> dict:
    """Stage demo. name: tiles | plaster | plaster_yellow | terrace | gatehouse | all (the real estate buildings)."""
    name = name or "tiles"
    # the stage camera sits 11 cm above z = 0; drop the stage pavement to z = 0 so the cat walks on it
    pave = bpy.data.objects.get("stage_pave")
    if pave is not None:
        pave.location.z = -0.14
    if name == "all":
        from sets import plan as P
        total = 0
        for b in P.make_plan().buildings:
            objs = build_block(b.name, b.rect, b.floors, b.style, b.front, coll, seed=1)
            t = triangles(objs)
            total += t
            vis = [o for o in objs if not o.hide_render]
            print(f"[stage] building {b.name}: {b.style}, {b.floors} floors, {t} triangles, {len(vis)} visible objects, "
                  f"{len(objs) - len(vis)} colliders")
        print(f"[stage] all buildings: {total} triangles")
        return {"focus": (-20.0, 0.0, 6.0), "radius": 30.0,
                "cat": [(-17.0, 2.2, -95.0), (-25.0, 1.0, 10.0), (-29.45, 6.0, 4.0)]}
    if name == "terrace":
        objs = build_block("demo_terrace", (-15.0, 3.0, 15.0, 8.9), 2, "terrace", "S", coll, grade=0.0)
        print(f"[stage] demo_terrace: {triangles(objs)} triangles")
        return {"focus": (0.0, 6.0, 3.5), "radius": 10.0,
                "cat": [(-3.5, 2.4, 80.0), (-6.0, 1.2, 15.0), (4.4, 2.3, -95.0), (11.5, 1.6, -30.0)]}
    if name == "gatehouse":
        objs = build_block("demo_gate", (-3.0, 2.5, 3.0, 7.5), 1, "gatehouse", "S", coll, grade=0.0)
        print(f"[stage] demo_gate: {triangles(objs)} triangles")
        return {"focus": (0.0, 5.0, 1.6), "radius": 5.0,
                "cat": [(1.8, 1.0, -20.0), (-4.2, 1.3, 40.0), (0.0, 1.9, 60.0)]}
    style, _, view = name.partition("@")
    if view == "back":
        # turned round: the garden side with the balconies, the tap and the low air conditioner faces the road
        objs = build_block(f"demo_{style}", (-7.5, 3.5, 7.5, 12.5), 3, style, "N", coll, grade=0.0)
        print(f"[stage] demo_{style}: {triangles(objs)} triangles")
        return {"focus": (0.0, 8.0, 3.6), "radius": 10.5,
                "cat": [(-7.0, 2.95, 80.0), (-2.2, 2.3, 25.0), (3.6, 2.8, -70.0), (7.9, 2.7, -20.0)]}
    objs = build_block(f"demo_{style}", (-7.5, 3.5, 7.5, 12.5), 3, style, "S", coll, grade=0.0)
    print(f"[stage] demo_{style}: {triangles(objs)} triangles")
    return {"focus": (0.0, 8.0, 3.6), "radius": 10.5,
            "cat": [(5.2, 3.2, 92.0), (0.7, 0.55, -12.0), (-3.6, 2.0, 30.0), (8.05, 6.2, 8.0), (-6.4, 12.95, 98.0)]}
