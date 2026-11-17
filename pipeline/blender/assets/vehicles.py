"""Parked vehicles seen from a cat's collar: small cars, a 50cc scooter and a city bike, all built by code.

Cars: a coarse control cage (stations along the car, a half profile mirrored) refined by Catmull-Clark
subdivision (applied), the wheel arches cut out with a boolean (the cut faces become the arch liner),
then shut lines, glass, lamps and grilles carved into the final mesh with plane cuts. Wheels (tread
blocks, sidewall, spoked rim, brake disc) share one mesh between the four corners.

  build_car(name, style, paint, coll=None, seed=0)     style: hatch | sedan | van | micro
  build_scooter(name, color_mat, coll=None, seed=0)
  build_bicycle(name, color_mat, coll=None, seed=0)
  demo(coll, name=None)                                 for jobs/stage.py

Every builder works around the origin, standing on z = 0, front towards +Y. Move with geo.place().
"""
from __future__ import annotations

import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

from wc import geo, mat

# ---------------------------------------------------------------- materials

_LOCAL = {
    # name: (colour, roughness, metalness)
    "veh_tyre": ((0.040, 0.040, 0.040), 0.82, 0.0),
    "veh_tread": ((0.066, 0.063, 0.058), 0.94, 0.0),
    "veh_shut": ((0.006, 0.006, 0.006), 0.75, 0.0),
    "veh_trim": ((0.016, 0.016, 0.017), 0.40, 0.0),
    "veh_seal": ((0.012, 0.012, 0.012), 0.6, 0.0),
    "veh_plastic": ((0.034, 0.034, 0.036), 0.74, 0.0),
    "veh_underseal": ((0.12, 0.115, 0.108), 0.92, 0.0),
    "veh_underseal2": ((0.24, 0.235, 0.225), 0.85, 0.0),
    "veh_headlamp": ((0.60, 0.62, 0.64), 0.10, 0.85),
    "veh_lens_dark": ((0.05, 0.055, 0.06), 0.05, 0.3),
    "veh_amber": ((0.62, 0.25, 0.02), 0.22, 0.0),
    "veh_reflector": ((0.30, 0.012, 0.010), 0.3, 0.0),
    "veh_plate_white": ((0.80, 0.80, 0.78), 0.32, 0.0),
    "veh_plate_yellow": ((0.82, 0.63, 0.05), 0.32, 0.0),
    "veh_disc": ((0.40, 0.39, 0.38), 0.40, 1.0),
    "veh_rust": ((0.20, 0.10, 0.05), 0.85, 0.0),
    "veh_caliper": ((0.11, 0.105, 0.10), 0.6, 0.5),
    "veh_alloy": ((0.56, 0.57, 0.58), 0.32, 1.0),
    "veh_alloy_dusty": ((0.42, 0.41, 0.39), 0.55, 0.7),
    "veh_cover": ((0.52, 0.53, 0.55), 0.38, 0.35),
    "veh_steelwheel": ((0.045, 0.045, 0.047), 0.45, 0.4),
    "veh_mirror": ((0.70, 0.72, 0.74), 0.03, 1.0),
    "veh_exhaust": ((0.17, 0.12, 0.09), 0.75, 0.6),
    "veh_heatshield": ((0.55, 0.55, 0.53), 0.45, 1.0),
    "veh_vinyl": ((0.028, 0.026, 0.025), 0.55, 0.0),
    "veh_grip": ((0.03, 0.03, 0.03), 0.9, 0.0),
    "veh_saddle": ((0.06, 0.04, 0.03), 0.6, 0.0),
    "veh_chain": ((0.12, 0.11, 0.10), 0.5, 0.9),
    "veh_reflect": ((0.30, 0.30, 0.30), 0.45, 0.0),
}


def M(name: str) -> bpy.types.Material:
    if name in _LOCAL:
        c, r, m = _LOCAL[name]
        return mat.flat(name, c, r, m)
    return mat.get(name)


class Mats:
    """Material slots for one mesh: index by name, attach in order at the end."""

    def __init__(self, *names):
        self.names: list[str] = []
        for n in names:
            self(n)

    def __call__(self, name: str) -> int:
        if name not in self.names:
            self.names.append(name)
        return self.names.index(name)

    def attach(self, obj: bpy.types.Object) -> None:
        # (materials.clear() would also wipe the per-face material indices)
        slots = obj.data.materials
        for i, n in enumerate(self.names):
            if i < len(slots):
                slots[i] = M(n)
            else:
                slots.append(M(n))


# ---------------------------------------------------------------- small mesh helpers (bmesh)

def _face(bm, verts, mi=0):
    f = bm.faces.new(verts)
    f.material_index = mi
    return f


def _revolve(bm, prof, angles, mis=0, closed=True):
    """Spin a profile [(a, r)] about the X axis (a = x).  Walk the profile with the outside on the LEFT
    (a to the right, r up) and the faces point outwards.  mis: one index or one per profile segment."""
    grid = [[bm.verts.new((a, r * math.sin(t), r * math.cos(t))) for t in angles] for a, r in prof]
    n = len(angles)
    for j in range(len(prof) - 1):
        mi = mis[j] if isinstance(mis, (list, tuple)) else mis
        for k in range(n if closed else n - 1):
            k2 = (k + 1) % n
            _face(bm, (grid[j][k], grid[j + 1][k], grid[j + 1][k2], grid[j][k2]), mi)
    return grid


def _ring_angles(n, start=0.0):
    return [start + 2 * math.pi * k / n for k in range(n)]


def _rbox(bm, centre, half, r, mi=0, xform: Matrix | None = None, ticks: int = 1):
    """Rounded box: half sizes (hx, hy, hz), corner radius r.  xform rotates about the box centre."""
    hx, hy, hz = half
    r = min(r, hx * 0.98, hy * 0.98, hz * 0.98)
    rot = xform.to_3x3() if xform is not None else Matrix.Identity(3)
    c = Vector(centre)

    def ticks_for(h):
        if ticks < 0:   # coarse: one chamfer-like step per rounded edge
            return [-h, -(h - r), h - r, h]
        t = [-h, -(h - r * 0.45), -(h - r)]
        mids = [(-(h - r)) + (2 * (h - r)) * (i + 1) / (ticks + 1) for i in range(ticks)] if ticks else []
        return t + mids + [h - r, h - r * 0.45, h]

    tx, ty, tz = ticks_for(hx), ticks_for(hy), ticks_for(hz)
    cache = {}

    def vert(q):
        key = tuple(round(v, 7) for v in q)
        v = cache.get(key)
        if v is None:
            core = Vector((max(-(hx - r), min(hx - r, q[0])), max(-(hy - r), min(hy - r, q[1])),
                           max(-(hz - r), min(hz - r, q[2]))))
            d = Vector(q) - core
            p = core + (d.normalized() * r if d.length > 1e-9 else d)
            v = bm.verts.new(c + rot @ p)
            cache[key] = v
        return v

    faces = []
    # each cube side: (axis, sign, u-ticks, v-ticks)
    for axis, sign in ((0, 1), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1)):
        ua, va = [(1, 2), (2, 0), (0, 1)][axis]
        tu, tv = [tx, ty, tz][ua], [tx, ty, tz][va]
        hval = [hx, hy, hz][axis] * sign
        for i in range(len(tu) - 1):
            for j in range(len(tv) - 1):
                quad = []
                for di, dj in ((0, 0), (1, 0), (1, 1), (0, 1)):
                    q = [0.0, 0.0, 0.0]
                    q[axis] = hval
                    q[ua] = tu[i + di]
                    q[va] = tv[j + dj]
                    quad.append(vert(q))
                if sign < 0:
                    quad.reverse()
                faces.append(_face(bm, quad, mi))
    return faces


def _tube(bm, path, radius, mi=0, segs=8, caps=True, twist=0.0):
    """Round tube along a 3D polyline; radius is a number or one value per point."""
    pts = [Vector(p) for p in path]
    n_pts = len(pts)
    t0 = (pts[1] - pts[0]).normalized()
    ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    nrm = t0.cross(ref).normalized()
    rings = []
    for i, p in enumerate(pts):
        if i == 0:
            t = (pts[1] - pts[0]).normalized()
        elif i == n_pts - 1:
            t = (pts[-1] - pts[-2]).normalized()
        else:
            t = ((pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized())
            t = t.normalized() if t.length > 1e-6 else (pts[i + 1] - pts[i]).normalized()
        nrm = (nrm - t * nrm.dot(t)).normalized()
        bi = t.cross(nrm)
        rr = radius[i] if isinstance(radius, (list, tuple)) else radius
        ring = []
        for k in range(segs):
            a = 2 * math.pi * k / segs + twist
            ring.append(bm.verts.new(p + (nrm * math.cos(a) + bi * math.sin(a)) * rr))
        rings.append(ring)
    faces = []
    for i in range(n_pts - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            faces.append(_face(bm, (rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]), mi))
    if caps:
        faces.append(_face(bm, list(reversed(rings[0])), mi))
        faces.append(_face(bm, rings[-1], mi))
    # make the winding point outwards (tube: compare with the axis)
    for f in faces[: (n_pts - 1) * segs]:
        f.normal_update()
        i = faces.index(f) // segs
        centre = (pts[i] + pts[i + 1]) / 2
        if f.normal.dot(f.calc_center_median() - centre) < 0:
            f.normal_flip()
    if caps:
        for f, out in ((faces[-2], pts[0] - pts[1]), (faces[-1], pts[-1] - pts[-2])):
            f.normal_update()
            if f.normal.dot(out) < 0:
                f.normal_flip()
    return faces


def _prism(bm, outline, z0, z1, mi=0, xform: Matrix | None = None):
    """Closed prism from a convex-ish 2D outline (x, y) between z0 and z1, then transformed."""
    xf = xform or Matrix.Identity(4)
    lo = [bm.verts.new(xf @ Vector((x, y, z0))) for x, y in outline]
    hi = [bm.verts.new(xf @ Vector((x, y, z1))) for x, y in outline]
    n = len(outline)
    faces = [_face(bm, list(reversed(lo)), mi), _face(bm, hi, mi)]
    for i in range(n):
        j = (i + 1) % n
        faces.append(_face(bm, (lo[i], lo[j], hi[j], hi[i]), mi))
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    return faces


def _finish(bm, name, mats: Mats, coll, angle=40.0, keep_bm=False):
    """bmesh -> object with smooth shading, hard edges above `angle` and between materials."""
    bm.normal_update()
    lim = math.radians(angle)
    for e in bm.edges:
        if len(e.link_faces) != 2:
            e.smooth = False
            continue
        f1, f2 = e.link_faces
        e.smooth = f1.material_index == f2.material_index and f1.normal.angle(f2.normal, 0.0) < lim
    for f in bm.faces:
        f.smooth = True
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    if not keep_bm:
        bm.free()
    obj = geo.new_object(name, mesh, coll)
    mats.attach(obj)
    geo.uv_box(obj)
    return obj


# ---------------------------------------------------------------- carving shapes into a finished surface

_AX = {"x": 0, "y": 1, "z": 2}


def _plane2d(axes, a, b, inside):
    """Plane through the 2D line a-b of a projection ('yz' side, 'xz' front, 'xy' top); normal towards `inside`."""
    i, j = _AX[axes[0]], _AX[axes[1]]
    n = Vector((0.0, 0.0, 0.0))
    n[i], n[j] = -(b[1] - a[1]), b[0] - a[0]
    n.normalize()
    co = Vector((0.0, 0.0, 0.0))
    co[i], co[j] = a[0], a[1]
    p = Vector((0.0, 0.0, 0.0))
    p[i], p[j] = inside[0], inside[1]
    if (p - co).dot(n) < 0:
        n.negate()
    return co, n


def _cut(bm, co, no, pred, mats=None):
    """Bisect the faces that cross the plane and satisfy pred(centre, normal) (and carry one of `mats`)."""
    faces = []
    for f in bm.faces:
        if mats is not None and f.material_index not in mats:
            continue
        ds = [(v.co - co).dot(no) for v in f.verts]
        if min(ds) < -1e-6 and max(ds) > 1e-6 and pred(f.calc_center_median(), f.normal):
            faces.append(f)
    if not faces:
        return
    geom = set(faces)
    for f in faces:
        geom.update(f.edges)
        geom.update(f.verts)
    bmesh.ops.bisect_plane(bm, geom=list(geom), plane_co=co, plane_no=no, dist=1e-6)


def _mirror_pts(pts):
    return [(-u, v) for u, v in pts]


def carve(bm, axes, poly, pred, mi_ring, mi_in=None, inset=0.0, push=0.0, mirror=False, margin=0.04, mats=None):
    """Paint a convex 2D polygon (seen along one axis) onto the surface.

    Faces inside get mi_ring; with mi_in, faces more than `inset` inside get mi_in and are pushed
    `push` metres into the surface (a recessed glass, lens or grille with a sloped seal around it)."""
    polys = [poly, _mirror_pts(poly)] if mirror else [poly]
    i, j = _AX[axes[0]], _AX[axes[1]]
    for pts in polys:
        pts = [p for k, p in enumerate(pts) if math.dist(p, pts[(k + 1) % len(pts)]) > 1e-4]
        bm.normal_update()
        cu = sum(p[0] for p in pts) / len(pts)
        cv = sum(p[1] for p in pts) / len(pts)
        planes = [_plane2d(axes, pts[k], pts[(k + 1) % len(pts)], (cu, cv)) for k in range(len(pts))]
        u0, u1 = min(p[0] for p in pts) - margin, max(p[0] for p in pts) + margin
        v0, v1 = min(p[1] for p in pts) - margin, max(p[1] for p in pts) + margin

        def inbox(c, n, pred=pred):
            return u0 <= c[i] <= u1 and v0 <= c[j] <= v1 and pred(c, n)

        for co, no in planes:
            _cut(bm, co, no, inbox, mats)
        if mi_in is not None and inset > 0:
            for co, no in planes:
                _cut(bm, co + no * inset, no, inbox, mats)
        bm.normal_update()
        inner = set()
        for f in bm.faces:
            if mats is not None and f.material_index not in mats:
                continue
            c = f.calc_center_median()
            if not inbox(c, f.normal):
                continue
            d = min((c - co).dot(no) for co, no in planes)
            if d <= 0:
                continue
            f.material_index = mi_ring
            if mi_in is not None and d > inset:
                f.material_index = mi_in
                inner.update(f.verts)
        if push:
            moves = [(v, v.normal.copy()) for v in inner]
            for v, n in moves:
                v.co -= n * push


def groove(bm, axes, a, b, pred, mi, width=0.0045, depth=0.0, mirror=False, mats=None):
    """A shut line: a thin dark slot along the 2D segment a-b of a projection."""
    segs = [(a, b), ((-a[0], a[1]), (-b[0], b[1]))] if mirror else [(a, b)]
    i, j = _AX[axes[0]], _AX[axes[1]]
    for pa, pb in segs:
        bm.normal_update()
        co, no = _plane2d(axes, pa, pb, (pa[0] + 1.0, pa[1] + 1.0))
        tdir = Vector((0.0, 0.0, 0.0))
        tdir[i], tdir[j] = pb[0] - pa[0], pb[1] - pa[1]
        length = tdir.length
        tdir.normalize()

        def near(c, n, co=co, no=no, tdir=tdir, length=length):
            t = (c - co).dot(tdir)
            return -0.004 <= t <= length + 0.004 and abs((c - co).dot(no)) < 0.15 and pred(c, n)

        for off in ((-width / 2, 0.0, width / 2) if depth > 0 else (-width / 2, width / 2)):
            _cut(bm, co + no * off, no, near, mats)
        bm.normal_update()
        centre = set()
        for f in bm.faces:
            if mats is not None and f.material_index not in mats:
                continue
            c = f.calc_center_median()
            if abs((c - co).dot(no)) < width / 2 and near(c, f.normal):
                f.material_index = mi
                centre.update(v for v in f.verts if abs((v.co - co).dot(no)) < 1e-5)
        moves = [(v, v.normal.copy()) for v in centre]
        for v, n in moves:
            v.co -= n * depth


# ---------------------------------------------------------------- wheels

WHEELS = {
    # Ro outer tyre radius, Rr rim radius (bead seat), Wt tyre width, rim design
    "hatch": {"Ro": 0.300, "Rr": 0.1905, "Wt": 0.185, "rim": "alloy5"},
    "sedan": {"Ro": 0.316, "Rr": 0.2032, "Wt": 0.205, "rim": "alloy10"},
    "van": {"Ro": 0.318, "Rr": 0.1905, "Wt": 0.195, "rim": "steel"},
    "micro": {"Ro": 0.279, "Rr": 0.1778, "Wt": 0.155, "rim": "cover"},
}
FLAT = 0.010   # tyre squash under a parked car
FLOOR = 0.045  # floor pan above the sill bottoms


def _tyre(bm, W, mi_side, mi_tread, pitches=24):
    """Tread band with two grooves and notched shoulder blocks; sidewalls on one line per pitch."""
    Ro, Rr, Wt = W["Ro"], W["Rr"], W["Wt"]
    h, sw = Wt / 2, Ro - Rr
    g, gw, gd = 0.30 * Wt, 0.005, 0.008
    half = [  # (a, r, kind) from the centre rib outwards
        (g - gw, Ro, "c"), (g, Ro - gd, "g"), (g + gw, Ro, "s"), (h - 0.020, Ro - 0.0018, "s"),
        (h - 0.0065, Ro - 0.0115, "s2"), (h + 0.0015, Ro - 0.030, "s3"),
    ]
    prof = [(-a, r, k) for a, r, k in reversed(half)] + list(half)
    pitch = 2 * math.pi / pitches
    angles, groove_line = [], []
    for p in range(pitches):
        t0 = p * pitch
        angles += [t0, t0 + 0.83 * pitch, t0 + 0.915 * pitch]
        groove_line += [False, False, True]
    first = len(bm.verts)
    grid = _revolve(bm, [(a, r) for a, r, _ in prof], angles, mi_tread)
    push = {"s": gd * 0.8, "s2": gd * 0.6, "s3": gd * 0.18}
    for j, (a, r, kind) in enumerate(prof):
        if kind not in push:
            continue
        for k, is_groove in enumerate(groove_line):
            if is_groove:
                v = grid[j][k]
                scale = (r - push[kind]) / r
                v.co.y *= scale
                v.co.z *= scale
    # sidewalls: bulge, rim protector, bead; bridged to the shoulder row with quads
    side = [(h + 0.0055, Rr + 0.56 * sw), (h + 0.003, Rr + 0.17 * sw), (h - 0.006, Rr + 0.022), (h - 0.012, Rr - 0.004)]
    sa = [p * pitch for p in range(pitches)]
    n = len(angles)
    for sgn, row in ((1, grid[-1]), (-1, grid[0])):
        prof_s = [(sgn * a, r) for a, r in side]
        sgrid = _revolve(bm, prof_s if sgn > 0 else list(reversed(prof_s)), sa, mi_side)
        top = sgrid[0] if sgn > 0 else sgrid[-1]
        for p in range(pitches):
            a0, a1, a2, a3 = row[3 * p], row[3 * p + 1], row[3 * p + 2], row[(3 * p + 3) % n]
            w0, w1 = top[p], top[(p + 1) % pitches]
            for quad in ((w0, a0, a1, a2), (w0, a2, a3, w1)):
                f = _face(bm, quad, mi_side)
                f.normal_update()
                if f.normal.x * sgn < 0:
                    f.normal_flip()
    bm.verts.ensure_lookup_table()
    # parked: the contact patch is flat and the sidewall bulges a little there
    lim = -(Ro - FLAT)
    for v in [bm.verts[i] for i in range(first, len(bm.verts))]:
        if v.co.z < lim:
            v.co.z = lim
        if v.co.z < -0.6 * Ro and abs(v.co.x) > 0.45 * Wt:
            v.co.x *= 1.0 + 0.05 * (-(v.co.z) - 0.6 * Ro) / (0.4 * Ro)


def _rim(bm, W, mm: Mats):
    Rr, Wt, style = W["Rr"], W["Wt"], W["rim"]
    h = Wt / 2
    Rb = Rr - 0.016
    # barrel and flanges (seen through the spokes)
    if style in ("steel", "cover"):
        m_rim = mm("veh_steelwheel")
    else:
        m_rim = mm("veh_alloy")
    barrel = [(h - 0.002, Rr + 0.017), (h + 0.005, Rr + 0.015), (h + 0.007, Rr + 0.004), (h + 0.003, Rr - 0.008),
              (h - 0.006, Rb), (-h + 0.010, Rb), (-h + 0.002, Rr - 0.002)]
    _revolve(bm, barrel, _ring_angles(24), m_rim)

    # spoked face on a polar grid, windows open (alloys, steel) or recessed (plastic cover)
    ncol = 4
    if style == "alloy5":
        n_sp, rings, ncol = 5, [0.030, 0.056, 0.076, 0.104, 0.134, Rb - 0.020, Rb + 0.003], 6
        w_in, w_out, a_hub, a_out, depth, opened = 0.036, 0.044, h - 0.058, h - 0.006, 0.026, True
        m_face, m_win = m_rim, None
        iw0, iw1 = 2, 5
    elif style == "alloy10":
        n_sp, rings = 10, [0.030, 0.056, 0.082, 0.130, Rb - 0.018, Rb + 0.003]
        w_in, w_out, a_hub, a_out, depth, opened = 0.019, 0.024, h - 0.050, h - 0.006, 0.024, True
        m_face, m_win = m_rim, None
        iw0, iw1 = 2, 4
    elif style == "steel":
        n_sp, rings = 8, [0.034, 0.055, 0.090, 0.124, 0.150, Rb + 0.003]
        w_in, w_out, a_hub, a_out, depth, opened = 0.068, 0.070, h - 0.046, h - 0.008, 0.010, True
        m_face, m_win = mm("veh_steelwheel"), None
        iw0, iw1 = 3, 4
    else:  # plastic wheel cover over a steel wheel
        n_sp, rings = 8, [0.034, 0.055, 0.082, 0.112, 0.140, Rb - 0.014, Rb + 0.003]
        w_in, w_out, a_hub, a_out, depth, opened = 0.024, 0.034, h - 0.030, h - 0.004, 0.014, False
        m_face, m_win = mm("veh_cover"), mm("veh_steelwheel")
        iw0, iw1 = 2, 5
    sector = 2 * math.pi / n_sp

    def spoke_half_angle(i):
        r = rings[i]
        t = min(1.0, max(0.0, (r - rings[iw0]) / (rings[iw1] - rings[iw0])))
        return (w_in + (w_out - w_in) * t) / 2 / max(r, 0.03)

    def axial(i, col):
        r = rings[i]
        t = min(1.0, max(0.0, (r - rings[2]) / (rings[-1] - rings[2])))
        a = a_hub + (a_out - a_hub) * (1 - (1 - t) ** 1.6)
        if col == 0 and iw0 <= i <= iw1:
            a += 0.003   # spokes are crowned
        return a

    cols_per = []
    for i in range(len(rings)):
        ha = min(spoke_half_angle(i), sector * 0.42)
        win = sector - 2 * ha
        cols_per.append([0.0, ha] + [ha + win * q / (ncol - 2) for q in range(1, ncol - 2)] + [sector - ha])
    F = []
    for i, r in enumerate(rings):
        row = []
        for s in range(n_sp):
            for c in range(ncol):
                t = s * sector + cols_per[i][c]
                row.append(bm.verts.new((axial(i, c), r * math.sin(t), r * math.cos(t))))
        F.append(row)
    N = n_sp * ncol
    is_win = lambda i, k: iw0 <= i < iw1 and 1 <= (k % ncol) <= ncol - 2
    back = {}

    def B(i, k):
        key = (i, k)
        if key not in back:
            v = F[i][k]
            back[key] = bm.verts.new((v.co.x - depth, v.co.y, v.co.z))
        return back[key]

    for i in range(len(rings) - 1):
        for k in range(N):
            k2 = (k + 1) % N
            quad = (F[i][k], F[i][k2], F[i + 1][k2], F[i + 1][k])
            if not is_win(i, k):
                _face(bm, quad, m_face).normal_update()
                continue
            if not opened:
                _face(bm, (B(i, k), B(i, k2), B(i + 1, k2), B(i + 1, k)), m_win)
            # walls on edges shared with a solid cell
            for (va, ka), (vb, kb), (ni, nk) in (((i, k), (i, k2), (i - 1, k)), ((i + 1, k2), (i + 1, k), (i + 1, k)),
                                               ((i, k2), (i + 1, k2), (i, k2)), ((i + 1, k), (i, k), (i, (k - 1) % N))):
                if 0 <= ni < len(rings) - 1 and is_win(ni, nk):
                    continue
                _face(bm, (F[va][ka], F[vb][kb], B(vb, kb), B(va, ka)), m_face if opened else m_win)
    # centre cap
    cap_m = mm("veh_plastic") if style != "steel" else mm("veh_steelwheel")
    tip = bm.verts.new((a_hub + 0.010, 0.0, 0.0))
    for k in range(N):
        _face(bm, (tip, F[0][(k + 1) % N], F[0][k]), cap_m)
    # wheel nuts
    if style != "cover":
        nuts = 4 if style != "steel" else 5
        for q in range(nuts):
            t = q * 2 * math.pi / nuts + (sector / 2 if style == "alloy5" else 0.0)
            c = Vector((axial(1, 1), 0.052 * math.sin(t), 0.052 * math.cos(t)))
            hexo = [(0.0105 * math.cos(math.pi / 3 * u), 0.0105 * math.sin(math.pi / 3 * u)) for u in range(6)]
            xf = Matrix.Translation(c) @ Matrix.Rotation(math.pi / 2, 4, "Y")
            _prism(bm, hexo, -0.014, 0.004, mm("chrome"), xf)
    # make every face of the face grid point outwards (+x side)
    return a_hub


def _brake(bm, W, a_hub, mm: Mats):
    a_d = a_hub - 0.047
    ro = min(0.135, W["Rr"] - 0.045)
    m_disc, m_rust = mm("veh_disc"), mm("veh_rust")
    prof = [(a_d - 0.032, 0.058), (a_d - 0.011, 0.074), (a_d - 0.011, ro), (a_d + 0.011, ro),
            (a_d + 0.011, 0.074), (a_hub - 0.026, 0.074), (a_hub - 0.026, 0.020)]
    _revolve(bm, prof, _ring_angles(20), [m_rust, m_disc, m_rust, m_disc, m_rust, m_rust])
    # dust shield behind the disc
    _revolve(bm, [(a_d - 0.036, ro + 0.012), (a_d - 0.040, 0.050)], _ring_angles(18), mm("steel_dark"))
    # caliper at the top, trailing slightly
    ang = math.radians(-28)
    rc = ro - 0.012
    xf = Matrix.Rotation(-ang, 4, "X")
    c = Vector((a_d + 0.002, rc * math.sin(ang), rc * math.cos(ang)))
    _rbox(bm, c, (0.024, 0.052, 0.024), 0.010, mm("veh_caliper"), xf, ticks=-1)


def wheel_mesh(key: str, W: dict) -> bpy.types.Mesh:
    """One wheel around the origin: axle along X, outer face towards +X, contact patch at z = -(Ro - FLAT)."""
    name = f"veh_wheel_{key}"
    mesh = bpy.data.meshes.get(name)
    if mesh is not None:
        return mesh
    bm = bmesh.new()
    mm = Mats("veh_tyre", "veh_tread")
    _tyre(bm, W, mm("veh_tyre"), mm("veh_tread"))
    a_hub = _rim(bm, W, mm)
    _brake(bm, W, a_hub, mm)
    bm.normal_update()
    obj = _finish(bm, name, mm, None, angle=42.0)
    mesh = obj.data
    bpy.data.objects.remove(obj)
    return mesh


# ---------------------------------------------------------------- car shapes
#
# rows: control-cage stations from the rear to the front:
#   (y, bottom z, belt (shoulder) z, top-centre z, half width, half width at the roof rail / bonnet edge)
# The first and last rows are the end caps (rear and front faces).  Subdivision pulls the surface a
# little inside the cage at convex places, so the cage is slightly bigger than the car.

STYLES = {
    "hatch": {
        "wheel": "hatch", "yf": 1.17, "yr": -1.31, "track": 0.735, "arch": 0.029,
        "rows": [
            (-1.96, 0.36, 1.000, 1.020, 0.70, 0.56),
            (-1.93, 0.28, 1.005, 1.130, 0.80, 0.60),
            (-1.86, 0.22, 1.005, 1.280, 0.855, 0.62),
            (-1.70, 0.19, 1.000, 1.415, 0.878, 0.635),
            (-1.40, 0.18, 0.993, 1.452, 0.882, 0.650),
            (-0.45, 0.176, 0.972, 1.466, 0.882, 0.660),
            (0.10, 0.177, 0.958, 1.445, 0.882, 0.660),
            (0.52, 0.178, 0.948, 1.200, 0.882, 0.700),
            (0.92, 0.180, 0.935, 0.965, 0.882, 0.760),
            (1.17, 0.185, 0.905, 0.930, 0.880, 0.770),
            (1.55, 0.20, 0.835, 0.865, 0.868, 0.750),
            (1.80, 0.22, 0.770, 0.795, 0.835, 0.710),
            (1.92, 0.245, 0.715, 0.735, 0.765, 0.640),
            (1.96, 0.28, 0.665, 0.685, 0.665, 0.550),
        ],
        "cap_f": (0.035, -0.012), "cap_r": (0.03, 0.02),
        "dlo": [(0.86, 0.952), (0.14, 1.37), (-1.05, 1.375), (-1.42, 1.01)],
        "panes": [(-0.27, 9.0), (-1.00, -0.36), (-9.0, -1.07)],
        "ws": (0.90, 0.14, 0.70, 0.585),
        "rs": ([(-0.56, 1.07), (0.56, 1.07), (0.47, 1.37), (-0.47, 1.37)], -1.6, "rear"),
        "head": [(0.40, 0.615), (0.95, 0.645), (0.95, 0.712), (0.44, 0.712)],
        "grille": [(-0.30, 0.575), (0.30, 0.575), (0.33, 0.69), (-0.33, 0.69)],
        "intake": [(-0.52, 0.30), (0.52, 0.30), (0.48, 0.45), (-0.48, 0.45)],
        "tail": [(0.50, 0.88), (0.95, 0.88), (0.95, 1.01), (0.58, 1.01)],
        "bumper_f": 0.595, "bumper_r": 0.62,
        "doors": [[(0.86, 0.30), (0.86, 0.95)], [(0.89, 0.965), (0.16, 1.385)], [(-0.315, 0.30), (-0.315, 0.97)],
                  [(-1.08, 0.988), (-1.08, 0.70), (-0.94, 0.45), (-0.93, 0.30)], [(0.86, 0.30), (-0.93, 0.30)]],
        "bonnet": (0.96, 0.68, 0.725), "tailgate": (0.70, 0.62, -1.72), "fuel": (-1.25, -1.42, 0.80, 0.91),
        "plate_f": 0.50, "plate_r": 0.74, "cladding": None, "handles": [-0.20, -0.95],
    },
    "sedan": {
        "wheel": "sedan", "yf": 1.35, "yr": -1.35, "track": 0.765, "arch": 0.030,
        "rows": [
            (-2.30, 0.36, 0.950, 0.970, 0.74, 0.62),
            (-2.26, 0.29, 0.965, 1.005, 0.84, 0.72),
            (-2.12, 0.23, 0.980, 1.025, 0.90, 0.76),
            (-1.75, 0.20, 0.985, 1.035, 0.915, 0.76),
            (-1.48, 0.19, 0.982, 1.050, 0.918, 0.70),
            (-1.10, 0.185, 0.975, 1.310, 0.918, 0.665),
            (-0.65, 0.18, 0.966, 1.440, 0.918, 0.66),
            (0.15, 0.178, 0.952, 1.425, 0.918, 0.665),
            (0.58, 0.18, 0.940, 1.170, 0.918, 0.71),
            (1.00, 0.182, 0.928, 0.955, 0.918, 0.78),
            (1.35, 0.188, 0.895, 0.925, 0.915, 0.795),
            (1.80, 0.205, 0.820, 0.850, 0.90, 0.78),
            (2.12, 0.225, 0.755, 0.780, 0.86, 0.73),
            (2.26, 0.25, 0.700, 0.720, 0.78, 0.65),
            (2.30, 0.29, 0.650, 0.670, 0.68, 0.56),
        ],
        "cap_f": (0.035, -0.012), "cap_r": (0.03, 0.01),
        "dlo": [(0.94, 0.95), (0.18, 1.35), (-0.55, 1.355), (-1.30, 1.00)],
        "panes": [(-0.34, 9.0), (-0.95, -0.42), (-9.0, -1.01)],
        "ws": (0.97, 0.19, 0.74, 0.60),
        "rs": ([(-0.60, 1.08), (0.60, 1.08), (0.52, 1.38), (-0.52, 1.38)], -0.7, "slope"),
        "head": [(0.42, 0.620), (0.98, 0.650), (0.98, 0.715), (0.46, 0.712)],
        "grille": [(-0.36, 0.565), (0.36, 0.565), (0.38, 0.69), (-0.38, 0.69)],
        "intake": [(-0.55, 0.28), (0.55, 0.28), (0.50, 0.42), (-0.50, 0.42)],
        "tail": [(0.52, 0.82), (0.98, 0.82), (0.98, 0.975), (0.58, 0.975)],
        "bumper_f": 0.58, "bumper_r": 0.70,
        "doors": [[(0.94, 0.31), (0.94, 0.94)], [(0.97, 0.955), (0.20, 1.37)], [(-0.38, 0.31), (-0.38, 0.968)],
                  [(-1.13, 0.978), (-1.13, 0.72), (-0.98, 0.45), (-0.97, 0.31)], [(0.94, 0.31), (-0.97, 0.31)]],
        "bonnet": (1.03, 0.72, 0.725), "boot": (-1.50, 0.72, 0.86), "fuel": (-1.42, -1.60, 0.80, 0.91),
        "plate_f": 0.45, "plate_r": 0.62, "cladding": None, "handles": [-0.26, -1.00],
    },
    "van": {
        "wheel": "van", "yf": 1.32, "yr": -1.43, "track": 0.745, "arch": 0.032,
        "rows": [
            (-2.20, 0.37, 1.070, 1.740, 0.80, 0.70),
            (-2.17, 0.30, 1.075, 1.800, 0.86, 0.76),
            (-2.08, 0.245, 1.080, 1.840, 0.89, 0.785),
            (-1.43, 0.21, 1.080, 1.855, 0.893, 0.79),
            (-0.55, 0.205, 1.075, 1.862, 0.893, 0.79),
            (0.20, 0.205, 1.070, 1.860, 0.893, 0.79),
            (0.55, 0.205, 1.066, 1.800, 0.893, 0.785),
            (0.95, 0.205, 1.060, 1.430, 0.893, 0.80),
            (1.30, 0.21, 1.050, 1.100, 0.893, 0.82),
            (1.62, 0.215, 1.000, 1.035, 0.886, 0.80),
            (1.95, 0.235, 0.920, 0.950, 0.86, 0.76),
            (2.14, 0.265, 0.850, 0.875, 0.80, 0.70),
            (2.20, 0.30, 0.800, 0.820, 0.70, 0.60),
        ],
        "cap_f": (0.03, -0.015), "cap_r": (0.015, 0.0),
        "dlo": [(1.20, 1.08), (0.62, 1.74), (0.0, 1.745), (0.0, 1.075)],
        "panes": [(0.05, 9.0)],
        "ws": (1.27, 0.60, 0.80, 0.72),
        "rs": ([(0.05, 1.20), (0.66, 1.20), (0.64, 1.62), (0.05, 1.62)], -2.0, "rear_pair"),
        "head": [(0.40, 0.700), (0.93, 0.730), (0.93, 0.830), (0.45, 0.810)],
        "grille": [(-0.36, 0.62), (0.36, 0.62), (0.38, 0.78), (-0.38, 0.78)],
        "intake": [(-0.60, 0.30), (0.60, 0.30), (0.56, 0.46), (-0.56, 0.46)],
        "tail": [(0.70, 0.75), (0.95, 0.75), (0.95, 1.20), (0.72, 1.20)],
        "bumper_f": 0.60, "bumper_r": 0.58,
        "doors": [[(0.91, 0.33), (0.91, 1.055)], [(1.23, 1.09), (0.64, 1.76)], [(0.0, 0.33), (0.0, 1.08)],
                  [(-0.07, 0.33), (-0.07, 1.76)], [(-1.02, 0.33), (-1.02, 1.76)], [(0.91, 0.33), (-1.02, 0.33)],
                  [(-1.02, 1.40), (-2.05, 1.40)]],
        "bonnet": (1.34, 0.70, 0.835), "reardoors": 0.58, "fuel": (-1.15, -1.30, 0.86, 0.97),
        "plate_f": 0.50, "plate_r": 0.66, "cladding": (0.12, 0.47, 0.50), "handles": [0.12, -0.20], "mudflaps": True,
    },
    "micro": {
        "wheel": "micro", "yf": 0.95, "yr": -1.05, "track": 0.640, "arch": 0.028,
        "rows": [
            (-1.50, 0.33, 0.950, 0.980, 0.62, 0.50),
            (-1.47, 0.26, 0.955, 1.120, 0.70, 0.56),
            (-1.41, 0.21, 0.955, 1.330, 0.745, 0.60),
            (-1.28, 0.19, 0.950, 1.535, 0.765, 0.615),
            (-1.05, 0.18, 0.945, 1.550, 0.766, 0.62),
            (-0.45, 0.175, 0.937, 1.555, 0.766, 0.62),
            (-0.05, 0.175, 0.930, 1.540, 0.766, 0.615),
            (0.25, 0.177, 0.922, 1.270, 0.766, 0.65),
            (0.55, 0.18, 0.912, 0.960, 0.766, 0.68),
            (0.95, 0.185, 0.870, 0.900, 0.764, 0.68),
            (1.25, 0.20, 0.820, 0.850, 0.75, 0.66),
            (1.43, 0.225, 0.770, 0.790, 0.70, 0.60),
            (1.50, 0.26, 0.720, 0.740, 0.60, 0.50),
        ],
        "cap_f": (0.03, -0.01), "cap_r": (0.025, 0.02),
        "dlo": [(0.50, 0.915), (-0.02, 1.48), (-1.18, 1.49), (-1.36, 0.955)],
        "panes": [(-0.40, 9.0), (-9.0, -0.50)],
        "ws": (0.52, -0.01, 0.60, 0.52),
        "rs": ([(-0.50, 1.02), (0.50, 1.02), (0.46, 1.46), (-0.46, 1.46)], -1.25, "rear"),
        "head": [(0.30, 0.660), (0.80, 0.690), (0.80, 0.760), (0.34, 0.750)],
        "grille": [(-0.24, 0.60), (0.24, 0.60), (0.26, 0.68), (-0.26, 0.68)],
        "intake": [(-0.42, 0.28), (0.42, 0.28), (0.38, 0.40), (-0.38, 0.40)],
        "tail": [(0.50, 0.80), (0.80, 0.80), (0.80, 1.10), (0.54, 1.10)],
        "bumper_f": 0.58, "bumper_r": 0.62,
        "doors": [[(0.58, 0.30), (0.58, 0.91)], [(0.61, 0.925), (0.01, 1.49)], [(-0.45, 0.30), (-0.45, 0.94)],
                  [(-0.88, 0.945), (-0.88, 0.63), (-0.72, 0.40), (-0.71, 0.30)], [(0.58, 0.30), (-0.71, 0.30)]],
        "bonnet": (0.58, 0.58, 0.76), "tailgate": (0.60, 0.62, -1.30), "fuel": (-1.02, -1.15, 0.72, 0.82),
        "plate_f": 0.46, "plate_r": 0.70, "cladding": (0.10, 0.30, 0.33), "handles": [-0.33, -0.76],
    },
}


def _interp(rows, y, col):
    if y <= rows[0][0]:
        return rows[0][col]
    for a, b in zip(rows[:-1], rows[1:]):
        if a[0] <= y <= b[0]:
            t = (y - a[0]) / (b[0] - a[0])
            return a[col] + (b[col] - a[col]) * t
    return rows[-1][col]


def _half_profile(zb, belt, zt, hw, hwr):
    """Half cross-section from the bottom centre round the right side to the top centre."""
    gh = max(zt - belt, 0.02)
    side = belt - zb
    return [
        (0.0, zb + FLOOR + 0.012),       # the floor sits higher than the sills, with a tunnel
        (0.78 * hw, zb + FLOOR),
        (0.955 * hw, zb),
        (1.00 * hw, zb + 0.36 * side),
        (0.962 * hw, belt),
        (0.928 * hw, belt + min(0.03, 0.2 * gh)),
        (hwr, belt + 0.84 * gh),
        (0.80 * hwr, belt + 0.985 * gh),
        (0.0, zt),
    ]


def _cage(S) -> bmesh.types.BMesh:
    bm = bmesh.new()
    rows = S["rows"]
    rings, halves = [], []
    for y, zb, belt, zt, hw, hwr in rows:
        half = _half_profile(zb, belt, zt, hw, hwr)
        ring = half + [(-x, z) for x, z in reversed(half[1:-1])]
        rings.append([bm.verts.new((x, y, z)) for x, z in ring])
        halves.append(half)
    m = len(rings[0])
    nh = len(halves[0]) - 1          # top centre index
    for s in range(len(rings) - 1):
        for k in range(m):
            k2 = (k + 1) % m
            bm.faces.new((rings[s][k], rings[s + 1][k], rings[s + 1][k2], rings[s][k2]))
    # end caps: a small grid across each end face, bulging outwards
    fracs = [1.0, 0.0, -1.0]
    for idx, (b_low, b_high), sign in ((0, S["cap_r"], -1.0), (len(rings) - 1, S["cap_f"], 1.0)):
        ring, half, row = rings[idx], halves[idx], rows[idx]
        zb, zt = row[1], row[3]
        grid = {}
        for i in range(1, nh):
            x, z = half[i]
            t = (z - zb) / max(zt - zb, 1e-3)
            bulge = (b_low + (b_high - b_low) * t) * sign
            for c, f in enumerate(fracs):
                if c == 0:
                    grid[(i, c)] = ring[i]
                elif c == len(fracs) - 1:
                    grid[(i, c)] = ring[m - i]
                else:
                    grid[(i, c)] = bm.verts.new((x * f, row[0] + bulge * (1 - f * f), z))
        for i in range(1, nh - 1):
            for c in range(len(fracs) - 1):
                bm.faces.new((grid[(i, c)], grid[(i, c + 1)], grid[(i + 1, c + 1)], grid[(i + 1, c)]))
        for edge_row, pole in ((1, ring[0]), (nh - 1, ring[nh])):
            for c in range(0, len(fracs) - 1, 2):
                bm.faces.new((pole, grid[(edge_row, c)], grid[(edge_row, c + 1)], grid[(edge_row, c + 2)]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def _arch_cutters(S, W, coll):
    """Closed cylinders (one per wheel) whose surface becomes the wheel-arch liner."""
    bm = bmesh.new()
    ra = W["Ro"] + S["arch"]
    zc = W["Ro"] - FLAT + 0.006
    for y in (S["yf"], S["yr"]):
        for sx in (1, -1):
            bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=40, radius1=ra, radius2=ra,
                                  depth=0.9, matrix=Matrix.Translation((sx * 0.86, y, zc)) @
                                  Matrix.Rotation(math.pi / 2, 4, "Y"))
    return geo.bm_to_object(bm, "arch_cutter", M("veh_plastic"), coll)


def _body_shell(name, S, W, paint, coll):
    """Smooth closed shell with the wheel arches cut out (modifiers applied)."""
    obj = geo.bm_to_object(_cage(S), name, M(paint), coll)
    mod = obj.modifiers.new("subd", "SUBSURF")
    mod.levels = mod.render_levels = 2
    mod.quality = 3
    geo.apply_modifiers(obj)
    # flared wheel arches: push the side out a little round each arch
    ra = W["Ro"] + S["arch"]
    zc = W["Ro"] - FLAT + 0.006
    for v in obj.data.vertices:
        x, y, z = v.co
        if abs(x) < 0.45 * S["track"]:
            continue
        for ya in (S["yf"], S["yr"]):
            d = math.hypot(y - ya, z - zc)
            if d < ra + 0.16 and z > zc - 0.18:
                t = max(0.0, min(1.0, (ra + 0.16 - d) / 0.12))
                t = t * t * (3 - 2 * t)
                v.co.x += math.copysign(0.016 * t, x)
    obj.data.update()
    obj.data.materials.append(M("veh_plastic"))
    cutter = _arch_cutters(S, W, coll)
    mod = obj.modifiers.new("arches", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    mod.object = cutter
    try:
        mod.material_mode = "TRANSFER"
    except (AttributeError, TypeError):
        pass
    geo.apply_modifiers(obj)
    bpy.data.objects.remove(cutter)
    return obj


def _carve_body(bm, S, W, mm: Mats):
    from shapely.geometry import Polygon, box as sbox

    rows = S["rows"]
    yf, yr = S["yf"], S["yr"]
    ra = W["Ro"] + S["arch"]
    y_front, y_rear = rows[-1][0], rows[0][0]

    def zb(y):
        return _interp(rows, y, 1)

    def belt(y):
        return _interp(rows, y, 2)

    PAINT, PLAST = 0, mm("veh_plastic")
    UNDER, SHUT, TRIM, GLASS = mm("veh_underseal"), mm("veh_shut"), mm("veh_trim"), mm("glass_car")
    LAMP, RED = mm("veh_headlamp"), mm("light_red")
    ok = {PAINT, PLAST}
    hw = max(r[4] for r in rows)
    # underseal on the floor between the sills, cut along straight lines
    carve(bm, "xy", [(-0.86 * hw, y_rear + 0.14), (0.86 * hw, y_rear + 0.14), (0.86 * hw, y_front - 0.12),
                     (-0.86 * hw, y_front - 0.12)], lambda c, n: n.z < -0.4, UNDER, mats={PAINT})
    clad = S.get("cladding")
    if clad:   # black plastic sills and lower bumpers
        zs, zfb, zrb = clad
        carve(bm, "yz", [(yr + ra * 0.9, -1.0), (yf - ra * 0.9, -1.0), (yf - ra * 0.9, zb(0.0) + zs),
                         (yr + ra * 0.9, zb(0.0) + zs)], lambda c, n: abs(n.x) > 0.15, PLAST, mats={PAINT})
        carve(bm, "xz", [(-3.0, -1.0), (3.0, -1.0), (3.0, zfb), (-3.0, zfb)],
              lambda c, n: c.y > yf + ra * 0.9 and n.z < 0.7, PLAST, mats={PAINT})
        carve(bm, "xz", [(-3.0, -1.0), (3.0, -1.0), (3.0, zrb), (-3.0, zrb)],
              lambda c, n: c.y < yr - ra * 0.9 and n.z < 0.7, PLAST, mats={PAINT})

    # shut lines
    def side(c, n):
        return abs(n.x) > 0.3 and abs(c.x) > 0.3

    for seg in S["doors"]:
        for a, b in zip(seg[:-1], seg[1:]):
            groove(bm, "yz", a, b, side, SHUT, mats=ok)
    groove(bm, "xz", (-2.0, S["bumper_f"]), (2.0, S["bumper_f"]), lambda c, n: c.y > yf + ra + 0.03, SHUT, mats=ok)
    groove(bm, "xz", (-2.0, S["bumper_r"]), (2.0, S["bumper_r"]), lambda c, n: c.y < yr - ra - 0.03, SHUT, mats=ok)
    yb, xs, zfr = S["bonnet"]
    groove(bm, "xy", (-xs - 0.04, yb), (xs + 0.04, yb), lambda c, n: n.z > 0.3, SHUT, mats=ok)
    groove(bm, "xy", (xs, yb), (xs, y_front + 0.1), lambda c, n: n.z > 0.2, SHUT, mirror=True, mats=ok)
    groove(bm, "xz", (-xs, zfr), (xs, zfr), lambda c, n: n.y > 0.25 and c.y > y_front - 0.3, SHUT, mats=ok)
    rear = lambda c, n: n.y < -0.3 and c.y < y_rear + 0.35
    if "tailgate" in S:
        xs, zbot, ytop = S["tailgate"]
        groove(bm, "xz", (xs, zbot), (xs, 2.0), rear, SHUT, mirror=True, mats=ok)
        groove(bm, "xy", (-xs, ytop), (xs, ytop), lambda c, n: n.z > 0.4, SHUT, mats=ok)
    if "boot" in S:
        yb2, xs, zr = S["boot"]
        groove(bm, "xy", (-xs, yb2), (xs, yb2), lambda c, n: n.z > 0.4, SHUT, mats=ok)
        groove(bm, "xy", (xs, yb2), (xs, y_rear - 0.1), lambda c, n: n.z > 0.25, SHUT, mirror=True, mats=ok)
        groove(bm, "xz", (-xs, zr), (xs, zr), rear, SHUT, mats=ok)
    if "reardoors" in S:
        groove(bm, "xz", (0.0, S["reardoors"]), (0.0, 2.0), rear, SHUT, mats=ok)
    y0, y1, z0, z1 = S["fuel"]
    right = lambda c, n: n.x > 0.3 and c.x > 0.3
    for a, b in (((y0, z0), (y1, z0)), ((y1, z0), (y1, z1)), ((y1, z1), (y0, z1)), ((y0, z1), (y0, z0))):
        groove(bm, "yz", a, b, right, SHUT, width=0.0035, mats=ok)
    # tow-eye cover: a small lid in the front bumper
    ix, iz = 0.62 * hw, S["intake"][0][1] + 0.06
    tow = lambda c, n: n.y > 0.2 and c.y > y_front - 0.35
    for a, b in (((ix - 0.03, iz - 0.03), (ix + 0.03, iz - 0.03)), ((ix + 0.03, iz - 0.03), (ix + 0.03, iz + 0.03)),
                 ((ix + 0.03, iz + 0.03), (ix - 0.03, iz + 0.03)), ((ix - 0.03, iz + 0.03), (ix - 0.03, iz - 0.03))):
        groove(bm, "xz", a, b, tow, SHUT, width=0.003, mats=ok)

    # side glass: black surround (daylight opening), panes recessed inside it
    upper = lambda c, n: abs(n.x) > 0.22 and abs(c.x) > 0.3 and c.z > belt(c.y) - 0.08
    carve(bm, "yz", S["dlo"], upper, TRIM, mats=ok)
    dlo = Polygon(S["dlo"]).buffer(-0.016, join_style=2)
    for ya, yb_ in S["panes"]:
        pane = dlo.intersection(sbox(ya, -9.0, yb_, 9.0)).simplify(0.001)
        if pane.is_empty or pane.area < 0.01:
            continue
        carve(bm, "yz", list(pane.exterior.coords)[:-1], upper, TRIM, GLASS, push=0.006, mats={TRIM})
    # windscreen with its black frit border
    wb, wt, xb, xt = S["ws"]
    wpred = lambda c, n: (n.z > 0.2 or n.y > 0.3) and abs(n.x) < 0.75 and c.z > belt(c.y) - 0.03
    carve(bm, "xy", [(-xb, wb), (xb, wb), (xt, wt), (-xt, wt)], wpred, TRIM, GLASS, inset=0.03, push=0.005, mats=ok)
    poly, ylim, kind = S["rs"]
    if kind == "slope":
        rp = lambda c, n: n.z > 0.15 and n.y < -0.05 and c.y < ylim and c.z > belt(c.y)
    else:
        rp = lambda c, n: n.y < -0.2 and c.y < ylim and c.z > belt(c.y) - 0.06
    carve(bm, "xz", poly, rp, TRIM, GLASS, inset=0.025, push=0.005, mirror=kind == "rear_pair", mats=ok)
    # lamps, grille, intake
    front_face = lambda c, n: n.y > 0.05 and c.y > y_front - 0.30 and c.z > zb(c.y) + 0.1
    carve(bm, "xz", S["head"], front_face, TRIM, LAMP, push=0.004, mirror=True, mats=ok)
    rear_face = lambda c, n: n.y < -0.05 and c.y < y_rear + 0.30
    carve(bm, "xz", S["tail"], rear_face, TRIM, RED, push=0.003, mirror=True, mats=ok)
    nose = lambda c, n: n.y > 0.3 and c.y > yf + ra
    carve(bm, "xz", S["grille"], nose, TRIM, PLAST, push=0.012, mats=ok)
    carve(bm, "xz", S["intake"], nose, PLAST, SHUT, push=0.02, mats=ok)
    # the flat floor pan does not need the subdivision's density
    floor = [f for f in bm.faces if f.material_index == UNDER and f.normal.z < -0.95]
    if floor:
        bmesh.ops.dissolve_faces(bm, faces=floor, use_verts=True)


def _shade_bm(bm, angle):
    bm.normal_update()
    lim = math.radians(angle)
    for e in bm.edges:
        if len(e.link_faces) != 2:
            e.smooth = False
            continue
        f1, f2 = e.link_faces
        e.smooth = f1.material_index == f2.material_index and f1.normal.angle(f2.normal, 0.0) < lim
    for f in bm.faces:
        f.smooth = True


def _build_body(name, S, W, paint, coll):
    obj = _body_shell(name, S, W, paint, coll)
    mm = Mats(*[m.name for m in obj.data.materials])
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    _carve_body(bm, S, W, mm)
    _shade_bm(bm, 48.0)
    bvh = BVHTree.FromBMesh(bm)
    bm.to_mesh(obj.data)
    bm.free()
    mm.attach(obj)
    geo.uv_box(obj)
    return obj, bvh


# ---------------------------------------------------------------- small parts

def _basis(fwd, up=(0.0, 0.0, 1.0)) -> Matrix:
    """Rotation whose local Y points along `fwd` and local Z as close to `up` as possible."""
    f = Vector(fwd).normalized()
    r = f.cross(Vector(up))
    if r.length < 1e-6:
        r = f.cross(Vector((1.0, 0.0, 0.0)))
    r.normalize()
    u = r.cross(f).normalized()
    return Matrix((r, f, u)).transposed()


def _bar(bm, p0, p1, w, h, mi=0, up=(0.0, 0.0, 1.0)):
    """Box with its long axis from p0 to p1 (w across, h along `up`)."""
    p0, p1 = Vector(p0), Vector(p1)
    t = (p1 - p0).normalized()
    u = Vector(up)
    u = (u - t * u.dot(t))
    u = u.normalized() if u.length > 1e-6 else t.orthogonal().normalized()
    s = t.cross(u)
    vs = [bm.verts.new(p + s * a * w / 2 + u * b * h / 2) for p in (p0, p1)
          for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    idx = ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7))
    faces = [_face(bm, [vs[i] for i in q], mi) for q in idx]
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    return faces


def _helix(bm, base, radius, height, turns, wire, mi, per_turn=8):
    n = int(turns * per_turn)
    pts = [(base[0] + radius * math.cos(2 * math.pi * k / per_turn), base[1] + radius * math.sin(2 * math.pi * k / per_turn),
            base[2] + height * k / n) for k in range(n + 1)]
    _tube(bm, pts, wire, mi, segs=4)


def _details(name, S, W, paint, bvh, coll):
    bm = bmesh.new()
    mm = Mats(paint)
    rows = S["rows"]
    y_front, y_rear = rows[-1][0], rows[0][0]
    yf, yr = S["yf"], S["yr"]
    ra = W["Ro"] + S["arch"]

    def belt(y):
        return _interp(rows, y, 2)

    def hit(o, d):
        loc, nrm, _, _ = bvh.ray_cast(Vector(o), Vector(d).normalized())
        return (loc, nrm) if loc is not None else (None, None)

    PAINT = 0
    BLACK, TRIM = mm("veh_plastic"), mm("veh_trim")
    shell = BLACK if S["cladding"] else PAINT
    # door mirrors
    y_m = S["dlo"][0][0] - 0.07
    z_m = belt(y_m) + 0.05
    for s in (1, -1):
        p, n = hit((s * 2.0, y_m, z_m), (-s, 0.0, 0.0))
        if p is None:
            continue
        rot = Matrix.Rotation(math.radians(-7 * s), 3, "Z")
        c = p + Vector((s * 0.125, -0.012, 0.02))
        _rbox(bm, c, (0.088, 0.048, 0.062), 0.032, shell, rot, ticks=0)
        gl = c + rot @ Vector((0.0, -0.047, 0.0))
        _bar(bm, gl - rot.col[0] * 0.074, gl + rot.col[0] * 0.074, 0.007, 0.096, mm("veh_mirror"))
        _rbox(bm, p + Vector((s * 0.03, -0.004, 0.0)), (0.055, 0.032, 0.024), 0.012, BLACK, rot, ticks=-1)
        # side repeater just behind the front wheel arch
        ang = math.radians(-38)
        yq, zq = yf + ra * math.sin(ang) - 0.06, W["Ro"] + ra * math.cos(ang) + 0.07
        p2, n2 = hit((s * 2.0, yq, zq), (-s, 0.0, 0.0))
        if p2 is not None:
            _bar(bm, p2 + Vector((0, -0.022, 0)), p2 + Vector((0, 0.022, 0)), 0.006, 0.016, mm("veh_amber"))
    # door handles
    for y_h in S["handles"]:
        z_h = belt(y_h) - 0.085
        for s in (1, -1):
            p, n = hit((s * 2.0, y_h, z_h), (-s, 0.0, 0.0))
            if p is not None:
                _rbox(bm, p + n * 0.009, (0.062, 0.012, 0.0135), 0.009, shell, _basis(n), ticks=-1)
    # wipers resting at the bottom of the windscreen
    wb = S["ws"][0]
    for x0, x1, pivot in ((-0.64, -0.06, -0.38), (-0.03, 0.50, 0.24)):
        pts = []
        for t in (0.0, 0.33, 0.66, 1.0):
            x = x0 + (x1 - x0) * t
            p, n = hit((x, wb - 0.075 + 0.02 * t, 4.0), (0.0, 0.0, -1.0))
            if p is not None:
                pts.append(p + n * 0.011)
        if len(pts) >= 2:
            _tube(bm, pts, 0.0065, TRIM, segs=4)
            p, n = hit((pivot, wb + 0.03, 4.0), (0.0, 0.0, -1.0))
            if p is not None:
                mid = pts[len(pts) // 2]
                _tube(bm, [p + n * 0.012, mid + n * 0.006], 0.006, TRIM, segs=4)
                _tube(bm, [p - n * 0.01, p + n * 0.02], 0.014, TRIM, segs=8)
    # number plates (blank) in black holders
    for front in (True, False):
        z = S["plate_f"] if front else S["plate_r"]
        p, n = hit((0.0, (y_front + 1.0) if front else (y_rear - 1.0), z), (0.0, -1.0 if front else 1.0, 0.0))
        if p is None:
            continue
        fwd = Vector((0.0, n.y, n.z)).normalized()
        B = _basis(fwd)
        _rbox(bm, p + fwd * 0.004, (0.266, 0.008, 0.060), 0.006, BLACK, B, ticks=-1)
        _bar(bm, p + fwd * 0.0125 - B.col[0] * 0.258, p + fwd * 0.0125 + B.col[0] * 0.258, 0.006, 0.111,
             mm("veh_plate_white" if front else "veh_plate_yellow"), up=B.col[2])
    # rear reflectors low on the bumper corners
    for s in (1, -1):
        p, n = hit((s * 0.60, y_rear - 1.0, S["bumper_r"] - 0.15), (0.0, 1.0, 0.0))
        if p is not None:
            _bar(bm, p + Vector((-0.055, 0.0, 0.0)), p + Vector((0.055, 0.0, 0.0)), 0.006, 0.026, mm("veh_reflector"))
    # grille slats and headlamp projectors
    g = S["grille"]
    gx = min(abs(p[0]) for p in g) * 0.92
    gz0, gz1 = min(p[1] for p in g), max(p[1] for p in g)
    for t in (0.34, 0.67):
        z = gz0 + (gz1 - gz0) * t
        pts = []
        for k in range(5):
            x = -gx + 2 * gx * k / 4
            p, n = hit((x, y_front + 1.0, z), (0.0, -1.0, 0.0))
            if p is not None:
                pts.append(p + n * 0.004)
        if len(pts) >= 2:
            _tube(bm, pts, 0.0055, mm("chrome") if S["wheel"] == "sedan" else TRIM, segs=4)
    hx = sum(p[0] for p in S["head"]) / 4
    hz = sum(p[1] for p in S["head"]) / 4
    hx1 = max(p[0] for p in S["head"])
    hz0 = min(p[1] for p in S["head"])
    tx0, tx1 = min(p[0] for p in S["tail"]), max(p[0] for p in S["tail"])
    tz0, tz1 = min(p[1] for p in S["tail"]), max(p[1] for p in S["tail"])
    X = Vector((1.0, 0.0, 0.0))

    def lamp_bar(origin, direction, half, h, m, lift=0.0015):
        p, n = hit(origin, direction)
        if p is not None:
            u = (X - n * n.dot(X)).normalized()
            _bar(bm, p + n * lift - u * half, p + n * lift + u * half, 0.004, h, m, up=n.cross(u))

    for s in (1, -1):
        p, n = hit((s * (hx - 0.06), y_front + 1.0, hz), (0.0, -1.0, 0.0))
        if p is not None:
            _tube(bm, [p - n * 0.004, p + n * 0.003], 0.024, mm("veh_lens_dark"), segs=12)
        # daytime running strip and indicator in the headlamp, reversing lamp and indicator in the tail lamp
        lamp_bar((s * (hx + 0.02), y_front + 1.0, hz0 + 0.012), (0.0, -1.0, 0.0), 0.11, 0.008, mm("light_clear"))
        lamp_bar((s * min(hx1 - 0.10, 0.80), y_front + 1.0, hz + 0.008), (0.0, -1.0, 0.0), 0.035, 0.022, mm("veh_amber"))
        lamp_bar((s * (tx0 + 0.07), y_rear - 1.0, tz0 + 0.025), (0.0, 1.0, 0.0), 0.045, 0.026, mm("light_clear"))
        lamp_bar((s * (tx0 + 0.18), y_rear - 1.0, tz1 - 0.028), (0.0, 1.0, 0.0), 0.05, 0.022, mm("veh_amber"))
    # roof aerial
    if S["wheel"] in ("hatch", "micro", "sedan"):
        ya = S["dlo"][2][0] - 0.06
        p, n = hit((0.0, ya, 4.0), (0.0, 0.0, -1.0))
        if p is not None:
            _rbox(bm, p + n * 0.012, (0.018, 0.05, 0.016), 0.012, BLACK, ticks=-1)
            _tube(bm, [p + Vector((0, -0.01, 0.02)), p + Vector((0, -0.16, 0.20))], [0.004, 0.0025], BLACK, segs=5)
    obj = _finish(bm, name, mm, coll, angle=40.0)
    return obj


def _underbody(name, S, W, coll):
    """Floor-pan hardware: subframe, arms, shafts, springs, tank, exhaust. Dark and simple."""
    bm = bmesh.new()
    mm = Mats("steel_dark")
    rows = S["rows"]
    yf, yr, tr = S["yf"], S["yr"], S["track"]
    zf = rows[len(rows) // 2][1] + FLOOR       # floor-pan height
    zc = W["Ro"] - FLAT
    y_rear = rows[0][0]
    DARK, PL, EX, RUB, CHR, HS = (mm("steel_dark"), mm("veh_plastic"), mm("veh_exhaust"), mm("rubber"),
                                  mm("chrome"), mm("veh_heatshield"))
    # front: subframe, wishbones, drive shafts with boots, struts with springs (seen inside the arches)
    _rbox(bm, (0.0, yf - 0.16, zf - 0.012), (0.46, 0.05, 0.035), 0.015, DARK, ticks=-1)
    for s in (1, -1):
        hub = Vector((s * (tr - 0.10), yf, zc - 0.07))
        _bar(bm, (s * 0.40, yf - 0.20, zf - 0.03), hub, 0.035, 0.025, DARK)
        _bar(bm, (s * 0.40, yf + 0.08, zf - 0.02), hub, 0.030, 0.025, DARK)
        _tube(bm, [(s * 0.18, yf + 0.02, zc + 0.02), (s * (tr - 0.15), yf, zc)], 0.014, DARK, segs=6)
        _tube(bm, [(s * (tr - 0.20), yf + 0.005, zc + 0.005), (s * (tr - 0.12), yf, zc)], [0.016, 0.034], RUB, segs=8)
        _tube(bm, [(s * (tr - 0.13), yf - 0.01, zc + 0.04), (s * (tr - 0.17), yf - 0.05, zc + 0.44)], 0.023, DARK, segs=8)
        _helix(bm, (s * (tr - 0.16), yf - 0.04, zc + 0.20), 0.068, 0.26, 3.0, 0.0075, DARK, per_turn=7)
    # rear: twist beam, trailing arms, springs, dampers
    yb = yr + 0.10
    _rbox(bm, (0.0, yb, zf + 0.02), (tr - 0.20, 0.045, 0.035), 0.012, DARK, ticks=-1)
    for s in (1, -1):
        _bar(bm, (s * (tr - 0.22), yb + 0.40, zf + 0.01), (s * (tr - 0.13), yr, zc - 0.01), 0.05, 0.045, DARK)
        _tube(bm, [(s * (tr - 0.16), yr, zc), (s * (tr - 0.09), yr, zc)], 0.034, DARK, segs=8)
        _helix(bm, (s * (tr - 0.30), yr - 0.07, zf + 0.0), 0.055, 0.22, 2.5, 0.0075, DARK, per_turn=6)
        _tube(bm, [(s * (tr - 0.20), yr - 0.13, zc - 0.03), (s * (tr - 0.24), yr - 0.22, zc + 0.30)], 0.02, DARK, segs=6)
    # fuel tank under the rear seat
    tx = min(0.38, tr - 0.40)
    _rbox(bm, (-0.05, yr + 0.62, zf - 0.025), (tx, 0.27, 0.042), 0.03, PL, ticks=-1)
    # exhaust: down pipe, catalyst, centre pipe, beside the tank, under the beam, silencer, tail pipe
    zp = zf - 0.045
    px = min(0.45, tr - 0.33)
    sy = max(yr - 0.40, y_rear + 0.25)          # silencer stays inside short cars
    sx = min(0.40, tr - 0.40)
    path = [(0.05, yf + 0.06, zf + 0.06), (0.05, yf - 0.10, zp + 0.012), (0.04, yf - 0.40, zp), (0.03, yr + 1.12, zp),
            (px - 0.02, yr + 0.86, zp), (px, yr + 0.30, zp), (px - 0.03, yr - 0.08, zp - 0.004),
            (sx - 0.08, sy + 0.12, zp + 0.01)]
    _tube(bm, path, 0.024, EX, segs=8)
    _tube(bm, [(0.04, yf - 0.46, zp), (0.04, yf - 0.86, zp)], 0.056, HS, segs=12)
    _rbox(bm, (0.0, sy, zf - 0.012), (sx, 0.12, 0.062), 0.05, EX, ticks=-1)
    ex = -(sx - 0.02)
    tail = [(ex + 0.06, sy - 0.04, zf - 0.02), (ex, y_rear + 0.20, zf + 0.0), (ex - 0.01, y_rear + 0.04, zf + 0.008)]
    _tube(bm, tail, 0.022, EX, segs=8)
    _tube(bm, [(ex - 0.01, y_rear + 0.08, zf + 0.008), (ex - 0.01, y_rear - 0.025, zf + 0.008)], 0.028, CHR, segs=12)
    # small air deflectors ahead of the front tyres, mud flaps behind the van's wheels
    ra = W["Ro"] + S["arch"]
    for s in (1, -1):
        x = s * tr
        _bar(bm, (x - 0.07, yf + ra - 0.02, zf - 0.035), (x + 0.07, yf + ra - 0.02, zf - 0.035), 0.012, 0.07, PL)
        if S.get("mudflaps"):
            for y in (yf, yr):
                zm = _interp(rows, y - ra, 1) - 0.035
                _bar(bm, (x - 0.085, y - ra - 0.014, zm), (x + 0.085, y - ra - 0.014, zm), 0.006, 0.17, RUB)
    # brake and fuel lines along the floor
    for x in (0.30, 0.335):
        _tube(bm, [(x, yf - 0.10, zf - 0.006), (x, yr + 0.30, zf - 0.006)], 0.0045, DARK, segs=4)
    # floor structure: cross members, front chassis legs, plastic engine undertray, tunnel heat shield
    for y in (yr + 1.02, (yf + yr) / 2 + 0.45):
        _bar(bm, (-0.64, y, zf - 0.012), (0.64, y, zf - 0.012), 0.07, 0.04, mm("veh_underseal2"))
    for s in (1, -1):
        _bar(bm, (s * 0.43, yf + 0.32, zf - 0.012), (s * 0.43, yf - 0.60, zf - 0.012), 0.06, 0.045, mm("veh_underseal2"))
    _bar(bm, (0.0, yf + 0.40, zf - 0.026), (0.0, yf - 0.30, zf - 0.026), 0.70, 0.012, mm("plastic_grey"))
    _bar(bm, (0.04, yf - 0.36, zf - 0.006), (0.03, yr + 1.10, zf - 0.006), 0.15, 0.008, HS)
    return _finish(bm, name, mm, coll, angle=40.0)


def _colliders(name, S, W, coll):
    rows = S["rows"]
    hw = max(r[4] for r in rows) - 0.01
    zb = min(r[1] for r in rows)
    belt = max(r[2] for r in rows)
    roof = max(r[3] for r in rows) - 0.01
    cab = [r for r in rows if r[3] > r[2] + 0.25]
    out = [geo.boxes(f"{name}_col_body", [((-hw, rows[0][0], zb), (hw, rows[-1][0], belt + 0.03)),
                                          ((-hw * 0.82, cab[0][0], belt), (hw * 0.82, cab[-1][0], roof))], None, coll)]
    zc = W["Ro"] - FLAT
    for i, (y, s) in enumerate(((S["yf"], 1), (S["yf"], -1), (S["yr"], 1), (S["yr"], -1))):
        x = s * S["track"]
        out.append(geo.cylinder(f"{name}_col_wheel{i}", W["Ro"], (x - W["Wt"] / 2, y, zc), (x + W["Wt"] / 2, y, zc),
                                None, coll, segments=12))
    for o in out:
        o.hide_render = True
    geo.tag(out, role="collider", collide="mesh")
    return out


def build_car(name: str, style: str, paint: str, coll=None, seed: int = 0) -> list[bpy.types.Object]:
    """A parked car (hatch | sedan | van | micro) centred on the origin, front towards +Y."""
    S, W = STYLES[style], WHEELS[STYLES[style]["wheel"]]
    rng = random.Random(seed)
    body, bvh = _build_body(f"{name}_body", S, W, paint, coll)
    parts = [body, _details(f"{name}_details", S, W, paint, bvh, coll), _underbody(f"{name}_under", S, W, coll)]
    mesh = wheel_mesh(style, W)
    zc = W["Ro"] - FLAT
    steer = rng.choice([0.0, 0.0, 5.0, -8.0, 12.0, -14.0])
    for label, y, turn in (("f", S["yf"], steer), ("r", S["yr"], 0.0)):
        for side, sx in (("r", 1), ("l", -1)):
            o = bpy.data.objects.new(f"{name}_wheel_{label}{side}", mesh)
            (coll or bpy.context.scene.collection).objects.link(o)
            # left wheels are the same mesh turned round; the steering angle turns both fronts alike
            o.matrix_world = (Matrix.Translation((sx * S["track"], y, zc)) @
                              Matrix.Rotation(math.radians((0.0 if sx > 0 else 180.0) + turn), 4, "Z"))
            parts.append(o)
    geo.tag(parts, role="vehicle", collide="none", lm=1.0)
    return parts + _colliders(name, S, W, coll)


# ---------------------------------------------------------------- two-wheelers: shared helpers

def _cc(cage: bmesh.types.BMesh, levels: int = 1) -> bmesh.types.BMesh:
    """Catmull-Clark refine a closed cage (through a temporary subdivision modifier)."""
    me = bpy.data.meshes.new("_cc")
    cage.to_mesh(me)
    cage.free()
    ob = bpy.data.objects.new("_cc", me)
    bpy.context.scene.collection.objects.link(ob)
    mod = ob.modifiers.new("subd", "SUBSURF")
    mod.levels = mod.render_levels = levels
    mod.quality = 3
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    out = bmesh.new()
    out.from_mesh(ev.to_mesh())
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    return out


def _merge(dst: bmesh.types.BMesh, src: bmesh.types.BMesh) -> None:
    """Append src into dst (material indices are kept as they are)."""
    me = bpy.data.meshes.new("_merge")
    src.to_mesh(me)
    src.free()
    dst.from_mesh(me)
    bpy.data.meshes.remove(me)


def _pod(stations, mi=0, n=10, axis="y", e=3.0, levels=1, bulge=0.0) -> bmesh.types.BMesh:
    """Rounded lofted solid.  stations: (s, c, lo, hi, w_lo, w_hi): position along `axis` ('y' or 'z'),
    x centre, lower/upper bound of the section (z for axis y, y for axis z), half widths at bottom/top."""
    cage = bmesh.new()

    def pt(u, v, s):
        return (u, s, v) if axis == "y" else (u, v, s)

    rings, vs = [], []
    for s, c, lo, hi, w0, w1 in stations:
        mid, hh = (lo + hi) / 2, (hi - lo) / 2
        ring, vv = [], []
        for k in range(n):
            t = -math.pi / 2 + 2 * math.pi * k / n
            ct, st = math.cos(t), math.sin(t)
            w = w0 + (w1 - w0) * (st + 1) / 2
            u = c + w * math.copysign(abs(ct) ** (2 / e), ct)
            v = mid + hh * math.copysign(abs(st) ** (2 / e), st)
            ring.append(cage.verts.new(pt(u, v, s)))
            vv.append(v)
        rings.append(ring)
        vs.append(vv)
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(n):
            k2 = (k + 1) % n
            _face(cage, (a[k], b[k], b[k2], a[k2]), mi)
    h = n // 2
    for idx, sign in ((0, -1.0), (len(rings) - 1, 1.0)):
        ring, s, c = rings[idx], stations[idx][0], stations[idx][1]
        C = {i: cage.verts.new(pt(c, vs[idx][i], s + sign * bulge)) for i in range(1, h)}
        R = {i: ring[i] for i in range(1, h)}
        L = {i: ring[n - i] for i in range(1, h)}
        _face(cage, (ring[0], R[1], C[1], L[1]), mi)
        for i in range(1, h - 1):
            _face(cage, (R[i], R[i + 1], C[i + 1], C[i]), mi)
            _face(cage, (C[i], C[i + 1], L[i + 1], L[i]), mi)
        _face(cage, (ring[h], L[h - 1], C[h - 1], R[h - 1]), mi)
    bmesh.ops.recalc_face_normals(cage, faces=cage.faces[:])
    return _cc(cage, levels) if levels else cage


def _arc_band(bm, centre_y, centre_z, r, half_w, t0, t1, steps, mi, thick=0.004, rim=0.02):
    """Mudguard: a shallow U-section band bent round an axle (angles from the top, + towards +Y)."""
    prof = [(-half_w, r + 0.2 * rim), (-half_w * 0.75, r + 0.8 * rim), (0.0, r + rim), (half_w * 0.75, r + 0.8 * rim),
            (half_w, r + 0.2 * rim)]
    inner = [(a * (1 - thick / half_w), rr - thick) for a, rr in reversed(prof)]
    loop = prof + inner + [prof[0]]
    angles = [t0 + (t1 - t0) * k / steps for k in range(steps + 1)]
    grid = _revolve(bm, loop, angles, mi, closed=False)
    for row in grid:
        for v in row:
            v.co.y += centre_y
            v.co.z += centre_z
    return grid


def _moto_wheel(mm: Mats, Ro, Rr, Wt, flat=0.0, disc_side=0, pitches=20) -> bmesh.types.BMesh:
    """Scooter wheel around the origin (axle along X): round-crown tyre, cast 5-spoke rim seen from both sides."""
    bm = bmesh.new()
    h = Wt / 2
    rc = 0.75 * h
    crown_deg = (-72, -48, -24, 0, 24, 48, 72)
    crown = [(rc * math.sin(math.radians(p)), Ro - rc + rc * math.cos(math.radians(p))) for p in crown_deg]
    side = [(h + 0.001, Ro - 0.045), (h - 0.004, Rr + 0.022), (h - 0.010, Rr + 0.006), (h - 0.014, Rr - 0.004)]
    prof = [(-a, r) for a, r in reversed(side)] + crown + side
    c0 = len(side)
    mis = [mm("veh_tread") if c0 <= j < c0 + len(crown) - 1 else mm("veh_tyre") for j in range(len(prof) - 1)]
    pitch = 2 * math.pi / pitches
    angles = [p * pitch + q * pitch / 3 for p in range(pitches) for q in range(3)]
    grid = _revolve(bm, prof, angles, mis)
    for p in range(pitches):
        sgn = 1 if p % 2 == 0 else -1
        for line, picks in ((3 * p + 1, (24, 48)), (3 * p + 2, (48, 72))):
            for deg in picks:
                j = c0 + crown_deg.index(sgn * deg)
                v = grid[j][line]
                r = math.hypot(v.co.y, v.co.z)
                v.co.y *= (r - 0.0035) / r
                v.co.z *= (r - 0.0035) / r
    if flat:
        for row in grid:
            for v in row:
                v.co.z = max(v.co.z, -(Ro - flat))
    # rim: symmetric barrel and a spoked web, walls closing each window
    rim = mm("veh_alloy_dusty" if disc_side else "veh_alloy")
    Rb = Rr - 0.012
    barrel = [(h - 0.008, Rr + 0.012), (h - 0.002, Rr + 0.010), (h - 0.001, Rr), (h - 0.010, Rb), (-h + 0.010, Rb),
              (-h + 0.001, Rr), (-h + 0.002, Rr + 0.010), (-h + 0.008, Rr + 0.012)]
    _revolve(bm, barrel, _ring_angles(20), rim)
    rings = [0.022, 0.040, 0.058, 0.085, 0.112, Rb - 0.012, Rb + 0.002]
    n_sp, ncol, iw0, iw1 = 5, 4, 2, 5
    sector = 2 * math.pi / n_sp

    def axial(i):
        r = rings[i]
        t = min(1.0, max(0.0, (r - 0.040) / 0.035))
        return 0.036 + (0.010 - 0.036) * t

    for sgn in (1, -1):
        F = []
        for i, r in enumerate(rings):
            t_in = min(1.0, max(0.0, (r - rings[iw0]) / (rings[iw1] - rings[iw0])))
            ha = min((0.030 + 0.008 * t_in) / 2 / r, sector * 0.42)
            cols = [0.0, ha, sector / 2, sector - ha]
            F.append([bm.verts.new((sgn * axial(i), r * math.sin(s * sector + c), r * math.cos(s * sector + c)))
                      for s in range(n_sp) for c in cols])
        N = n_sp * ncol
        is_win = lambda i, k: iw0 <= i < iw1 and 1 <= (k % ncol) <= 2
        mid = {}

        def B(i, k, F=F, mid=mid):
            if (i, k) not in mid:
                v = F[i][k]
                mid[(i, k)] = bm.verts.new((0.0, v.co.y, v.co.z))
            return mid[(i, k)]

        def quad(vs, sgn=sgn):
            _face(bm, vs if sgn > 0 else list(reversed(vs)), rim)

        for i in range(len(rings) - 1):
            for k in range(N):
                k2 = (k + 1) % N
                if not is_win(i, k):
                    quad((F[i][k], F[i][k2], F[i + 1][k2], F[i + 1][k]))
                    continue
                for (va, ka), (vb, kb), (ni, nk) in (((i, k), (i, k2), (i - 1, k)), ((i + 1, k2), (i + 1, k), (i + 1, k)),
                                                   ((i, k2), (i + 1, k2), (i, k2)), ((i + 1, k), (i, k), (i, (k - 1) % N))):
                    if 0 <= ni < len(rings) - 1 and is_win(ni, nk):
                        continue
                    quad((F[va][ka], F[vb][kb], B(vb, kb), B(va, ka)))
        tip = bm.verts.new((sgn * (axial(0) + 0.012), 0.0, 0.0))
        for k in range(N):
            quad((tip, F[0][(k + 1) % N], F[0][k]))
    if disc_side:
        a0, a1 = disc_side * (h + 0.020), disc_side * (h + 0.024)
        lo, hi = (a0, a1) if a0 < a1 else (a1, a0)
        _revolve(bm, [(lo, 0.052), (lo, 0.098), (hi, 0.098), (hi, 0.052), (lo, 0.052)], _ring_angles(20), mm("veh_disc"))
    return bm


def build_scooter(name: str, color_mat: str, coll=None, seed: int = 0) -> list[bpy.types.Object]:
    """A 50cc step-through scooter on its centre stand, about 1.8 m long, front towards +Y."""
    Ro, Rr, Wt = 0.235, 0.1524, 0.11
    yfa, yra = 0.64, -0.62
    zfa, zra = Ro - 0.006, Ro + 0.012          # on the centre stand the rear wheel just clears the ground
    mm = Mats(color_mat)
    P, BL, MAT = 0, mm("veh_plastic"), mm("veh_grip")
    body = bmesh.new()
    # bodywork: rear body under the seat, floorboard, leg shield, handlebar cover
    _merge(body, _pod([(-0.935, 0.0, 0.56, 0.66, 0.05, 0.04), (-0.88, 0.0, 0.50, 0.70, 0.10, 0.09),
                       (-0.72, 0.0, 0.455, 0.735, 0.155, 0.14), (-0.45, 0.0, 0.40, 0.745, 0.175, 0.152),
                       (-0.20, 0.0, 0.32, 0.735, 0.175, 0.15), (-0.07, 0.0, 0.29, 0.70, 0.165, 0.138),
                       (-0.015, 0.0, 0.29, 0.60, 0.14, 0.115)], P, n=10, e=3.6, levels=2, bulge=0.02))
    _merge(body, _pod([(-0.10, 0.0, 0.165, 0.30, 0.135, 0.155), (-0.03, 0.0, 0.145, 0.305, 0.165, 0.17),
                       (0.22, 0.0, 0.145, 0.305, 0.165, 0.17), (0.36, 0.0, 0.16, 0.305, 0.155, 0.165),
                       (0.42, 0.0, 0.20, 0.30, 0.13, 0.15)], P, n=12, e=6.0, levels=1))
    _merge(body, _pod([(0.24, 0.0, 0.30, 0.52, 0.17, 0.19), (0.38, 0.0, 0.36, 0.565, 0.205, 0.225),
                       (0.60, 0.0, 0.385, 0.555, 0.215, 0.225), (0.80, 0.0, 0.375, 0.53, 0.205, 0.21),
                       (0.92, 0.0, 0.37, 0.50, 0.17, 0.175), (0.965, 0.0, 0.37, 0.465, 0.11, 0.115)],
                      P, n=10, axis="z", e=2.8, levels=2, bulge=0.01))
    _merge(body, _pod([(0.34, 0.0, 0.93, 1.00, 0.10, 0.08), (0.42, 0.0, 0.915, 1.05, 0.20, 0.17),
                       (0.53, 0.0, 0.925, 1.05, 0.21, 0.16), (0.61, 0.0, 0.95, 1.02, 0.15, 0.12)], P, n=10, levels=1,
                      bulge=0.01))
    body.normal_update()
    for f in body.faces:
        c, n = f.calc_center_median(), f.normal
        if n.z > 0.8 and 0.29 < c.z < 0.32 and -0.08 < c.y < 0.40:
            f.material_index = MAT                 # rubber floor mat
        elif n.y < -0.55 and 0.32 < c.z < 0.92 and 0.33 < c.y < 0.50:
            f.material_index = BL                  # inner leg shield in black plastic
        elif c.z < 0.222 and -0.12 < c.y < 0.45 and n.z < 0.5:
            f.material_index = BL                  # floorboard skirt
        elif c.z < 0.345 and c.y < -0.10 and n.z < 0.2:
            f.material_index = BL                  # lower edge of the side covers
    sh = mm("veh_shut")
    side = lambda c, n: abs(n.x) > 0.5
    groove(body, "yz", (-0.86, 0.545), (-0.12, 0.47), side, sh, width=0.004)       # side cover seam
    groove(body, "yz", (-0.12, 0.47), (-0.06, 0.36), side, sh, width=0.004)
    groove(body, "xz", (-0.3, 0.43), (0.3, 0.43), lambda c, n: n.y > 0.3 and c.y > 0.45, sh, width=0.004)
    # seat, grab rail, lights, plate
    _merge(body, _pod([(-0.865, 0.0, 0.715, 0.745, 0.075, 0.065), (-0.80, 0.0, 0.70, 0.79, 0.13, 0.12),
                       (-0.55, 0.0, 0.70, 0.80, 0.16, 0.15), (-0.25, 0.0, 0.70, 0.785, 0.16, 0.15),
                       (-0.08, 0.0, 0.69, 0.76, 0.15, 0.13), (-0.025, 0.0, 0.69, 0.73, 0.12, 0.10)],
                      mm("veh_vinyl"), n=10, e=2.6, levels=1, bulge=0.01))
    _tube(body, [(0.11, -0.80, 0.74), (0.11, -0.93, 0.745), (-0.11, -0.93, 0.745), (-0.11, -0.80, 0.74)], 0.011, BL, segs=6)
    _rbox(body, (0.0, -0.928, 0.605), (0.075, 0.02, 0.032), 0.012, mm("light_red"), ticks=-1)
    _rbox(body, (0.0, 0.615, 0.985), (0.095, 0.02, 0.032), 0.014, mm("veh_headlamp"), ticks=-1)
    for s in (1, -1):
        _rbox(body, (s * 0.105, -0.905, 0.635), (0.022, 0.016, 0.012), 0.006, mm("veh_amber"), ticks=-1)
        _rbox(body, (s * 0.19, 0.555, 0.985), (0.02, 0.026, 0.014), 0.006, mm("veh_amber"), ticks=-1)
    _bar(body, (0.0, -0.87, 0.53), (0.0, -0.985, 0.42), 0.12, 0.012, BL, up=(0.0, 1.0, 0.0))
    _bar(body, (-0.095, -0.995, 0.40), (0.095, -0.995, 0.40), 0.006, 0.14, mm("veh_plate_yellow"))
    _bar(body, (-0.04, 0.546, 0.80), (0.04, 0.546, 0.80), 0.012, 0.028, mm("veh_shut"))   # horn grille
    # handlebar ends, levers, mirrors
    for s in (1, -1):
        _tube(body, [(s * 0.20, 0.47, 1.01), (s * 0.255, 0.47, 1.01)], 0.012, mm("steel"), segs=8)
        _tube(body, [(s * 0.255, 0.47, 1.01), (s * 0.37, 0.47, 1.01)], 0.018, MAT, segs=8)
        _bar(body, (s * 0.21, 0.495, 1.025), (s * 0.35, 0.525, 1.005), 0.012, 0.008, mm("aluminium"))
        _tube(body, [(s * 0.18, 0.455, 1.045), (s * 0.235, 0.435, 1.165)], 0.0085, BL, segs=6)
        hc = Vector((s * 0.262, 0.43, 1.20))
        _rbox(body, hc, (0.066, 0.018, 0.043), 0.016, BL, ticks=-1)
        _bar(body, hc + Vector((-0.058, -0.019, 0.0)), hc + Vector((0.058, -0.019, 0.0)), 0.003, 0.074, mm("veh_mirror"))
    # front mudguard, rear hugger
    _arc_band(body, yfa, zfa, Ro + 0.012, 0.068, math.radians(-30), math.radians(98), 14, P, rim=0.035)
    _arc_band(body, yra, zra, Ro + 0.014, 0.06, math.radians(-112), math.radians(-25), 9, BL, rim=0.02)
    body_obj = _finish(body, f"{name}_body", mm, coll, angle=40.0)

    # running gear: wheels, fork, engine case, exhaust, shock, centre stand
    rm = Mats("veh_tyre")
    run = bmesh.new()
    for y, z, flat, disc in ((yfa, zfa, 0.006, -1), (yra, zra, 0.0, 0)):
        w = _moto_wheel(rm, Ro, Rr, Wt, flat, disc)
        bmesh.ops.translate(w, vec=(0.0, y, z), verts=w.verts[:])
        _merge(run, w)
    DK, AL = rm("steel_dark"), rm("veh_alloy_dusty")
    for s in (1, -1):
        _tube(run, [(s * 0.072, yfa, zfa), (s * 0.072, yfa - 0.07, zfa + 0.26), (s * 0.068, yfa - 0.13, 0.72)],
              [0.021, 0.021, 0.019], AL, segs=8)
    _rbox(run, (-0.052, yfa - 0.06, zfa + 0.065), (0.016, 0.034, 0.026), 0.008, rm("veh_caliper"), ticks=-1)
    _tube(run, [(-0.072, yfa, zfa), (0.072, yfa, zfa)], 0.008, rm("steel"), segs=6)
    _rbox(run, (-0.105, -0.36, 0.265), (0.046, 0.30, 0.085), 0.04, AL)                       # belt case / swing arm
    _rbox(run, (-0.105, -0.11, 0.28), (0.05, 0.075, 0.08), 0.035, rm("veh_plastic"), ticks=-1)   # fan cover
    _rbox(run, (0.0, -0.18, 0.24), (0.07, 0.10, 0.07), 0.03, DK, ticks=-1)                   # engine block
    _tube(run, [(0.02, -0.08, 0.20), (0.06, -0.16, 0.15), (0.11, -0.28, 0.17), (0.13, -0.40, 0.225)], 0.016, DK, segs=6)
    _tube(run, [(0.135, -0.39, 0.233), (0.135, -0.42, 0.236), (0.145, -0.78, 0.298), (0.146, -0.80, 0.30)],
          [0.030, 0.048, 0.048, 0.040], rm("paint_black"), segs=10)
    _rbox(run, (0.172, -0.58, 0.272), (0.014, 0.15, 0.042), 0.012, rm("aluminium"), ticks=-1)    # heat shield
    _tube(run, [(0.145, -0.79, 0.30), (0.15, -0.85, 0.31)], 0.014, rm("chrome"), segs=8)
    _tube(run, [(-0.12, yra + 0.01, 0.30), (-0.12, yra + 0.10, 0.56)], 0.016, DK, segs=6)
    _helix(run, (-0.12, yra + 0.035, 0.36), 0.026, 0.13, 6.0, 0.0045, rm("paint_red"), per_turn=6)
    for s in (1, -1):    # centre stand legs down to the ground
        _tube(run, [(s * 0.105, -0.20, 0.18), (s * 0.125, -0.28, 0.012)], 0.012, DK, segs=6)
        _bar(run, (s * 0.10, -0.29, 0.006), (s * 0.15, -0.29, 0.006), 0.035, 0.012, DK)
    _tube(run, [(-0.11, -0.20, 0.18), (0.11, -0.20, 0.18)], 0.011, DK, segs=6)
    for s in (1, -1):    # passenger foot pegs (folded)
        _bar(run, (s * 0.165, -0.20, 0.33), (s * 0.20, -0.32, 0.34), 0.025, 0.015, rm("veh_plastic"))
    run_obj = _finish(run, f"{name}_running", rm, coll, angle=42.0)
    parts = [body_obj, run_obj]
    geo.tag(parts, role="vehicle", collide="none", lm=1.0)
    cols = [geo.boxes(f"{name}_col", [((-0.17, -0.94, 0.0), (0.17, 0.88, 0.80)),
                                      ((-0.23, 0.33, 0.30), (0.23, 0.63, 1.08))], None, coll)]
    for o in cols:
        o.hide_render = True
    geo.tag(cols, role="collider", collide="mesh")
    return parts + cols


def _bike_wheel(mm: Mats, R=0.350, Rr=0.311, hub_w=0.033, segs=40) -> bmesh.types.BMesh:
    """700C city-bike wheel around the origin (axle along X): tyre with reflective band, box rim, 36 spokes."""
    bm = bmesh.new()
    th = R - Rr
    half = [(0.0, R), (0.008, R - 0.001), (0.016, Rr + 0.83 * th), (0.0205, Rr + 0.55 * th), (0.019, Rr + 0.28 * th),
            (0.012, Rr)]
    prof = [(-a, r) for a, r in reversed(half[1:])] + half
    T, S, BAND = mm("veh_tread"), mm("veh_tyre"), mm("veh_reflect")
    mis = [S, BAND, S, T, T, T, T, S, BAND, S]
    _revolve(bm, prof, _ring_angles(segs), mis)
    rim = [(0.0115, Rr + 0.006), (0.0115, Rr - 0.012), (0.008, Rr - 0.018), (0.0, Rr - 0.020), (-0.008, Rr - 0.018),
           (-0.0115, Rr - 0.012), (-0.0115, Rr + 0.006)]
    _revolve(bm, rim, _ring_angles(segs), mm("aluminium"))
    hub = [(-0.050, 0.006), (-0.045, 0.012), (-hub_w - 0.002, 0.013), (-hub_w - 0.001, 0.027), (-hub_w + 0.002, 0.027),
           (-hub_w + 0.003, 0.018), (hub_w - 0.003, 0.018), (hub_w - 0.002, 0.027), (hub_w + 0.001, 0.027),
           (hub_w + 0.002, 0.013), (0.045, 0.012), (0.050, 0.006)]
    # walk the hub so its outside is on the left: from +a to -a over the top
    _revolve(bm, list(reversed([(-a, r) for a, r in hub])), _ring_angles(12), mm("aluminium"))
    sp = mm("steel")
    for k in range(36):
        side = 1 if k % 2 == 0 else -1
        th_h = 2 * math.pi * k / 36
        th_r = th_h + (0.42 if (k // 2) % 2 == 0 else -0.42)
        a = Vector((side * hub_w, 0.025 * math.sin(th_h), 0.025 * math.cos(th_h)))
        b = Vector((side * 0.003, (Rr - 0.019) * math.sin(th_r), (Rr - 0.019) * math.cos(th_r)))
        _tube(bm, [a, b], 0.0011, sp, segs=3)
    return bm


def build_bicycle(name: str, color_mat: str, coll=None, seed: int = 0) -> list[bpy.types.Object]:
    """An ordinary city bike leaning on its kickstand (front towards +Y)."""
    R = 0.350
    RA, FA = Vector((0.0, -0.56, R)), Vector((0.0, 0.62, R))
    BB, SC = Vector((0.0, -0.10, 0.285)), Vector((0.0, -0.27, 0.82))
    HT, HB = Vector((0.0, 0.355, 0.945)), Vector((0.0, 0.43, 0.745))
    mm = Mats(color_mat)
    P, BL, ST = 0, mm("veh_plastic"), mm("steel")
    frame, front = bmesh.new(), bmesh.new()
    # frame
    _tube(frame, [(0.0, -0.262, 0.80), (0.0, 0.37, 0.905)], 0.0145, P, segs=8)
    _tube(frame, [(0.0, -0.09, 0.30), (0.0, 0.415, 0.78)], 0.019, P, segs=8)
    _tube(frame, [BB, SC], 0.016, P, segs=8)
    _tube(frame, [(0.0, 0.43, 0.745), (0.0, 0.355, 0.945)], 0.020, P, segs=10)
    _tube(frame, [(-0.036, -0.10, 0.285), (0.036, -0.10, 0.285)], 0.021, P, segs=10)
    for s in (1, -1):
        _tube(frame, [(s * 0.03, -0.10, 0.285), (s * 0.062, -0.555, 0.348)], 0.0095, P, segs=6)
        _tube(frame, [(s * 0.02, -0.262, 0.80), (s * 0.062, -0.552, 0.36)], 0.008, P, segs=6)
    # seat post and sprung saddle
    _tube(frame, [(0.0, -0.268, 0.83), (0.0, -0.305, 0.985)], 0.0135, ST, segs=8)
    _merge(frame, _pod([(-0.435, 0.0, 1.005, 1.035, 0.07, 0.06), (-0.405, 0.0, 0.99, 1.06, 0.11, 0.10),
                        (-0.33, 0.0, 0.99, 1.066, 0.118, 0.105), (-0.24, 0.0, 0.998, 1.052, 0.07, 0.06),
                        (-0.16, 0.0, 1.006, 1.046, 0.036, 0.03), (-0.125, 0.0, 1.01, 1.04, 0.022, 0.02)],
                       mm("veh_saddle"), n=10, e=2.6, levels=1, bulge=0.008))
    _bar(frame, (0.0, -0.30, 0.985), (0.0, -0.17, 1.005), 0.03, 0.008, ST)
    for s in (1, -1):
        _helix(frame, (s * 0.055, -0.39, 0.94), 0.013, 0.05, 5.0, 0.0022, ST, per_turn=6)
        _bar(frame, (0.0, -0.30, 0.94), (s * 0.055, -0.39, 0.94), 0.012, 0.006, ST)
    # rear rack, rear light, chain guard, chainring, cranks, pedals, chain
    rk = 0.005
    for s in (1, -1):
        _tube(frame, [(s * 0.065, -0.29, 0.785), (s * 0.065, -0.83, 0.785)], rk, ST, segs=4)
        _tube(frame, [(s * 0.065, -0.80, 0.785), (s * 0.068, -0.565, 0.355)], rk, ST, segs=4)
        _tube(frame, [(s * 0.065, -0.66, 0.785), (s * 0.068, -0.555, 0.36)], rk, ST, segs=4)
        _tube(frame, [(s * 0.065, -0.29, 0.785), (s * 0.024, -0.275, 0.80)], rk, ST, segs=4)
    for y in (-0.45, -0.62, -0.83):
        _tube(frame, [(-0.065, y, 0.785), (0.065, y, 0.785)], rk, ST, segs=4)
    _rbox(frame, (0.0, -0.845, 0.765), (0.04, 0.012, 0.022), 0.006, mm("light_red"), ticks=-1)
    # chain guard: a ring over the chainring and a strip over the top run of the chain
    g = bmesh.new()
    _arc_band(g, 0.0, 0.0, 0.106, 0.016, math.radians(-75), math.radians(95), 10, P, thick=0.002, rim=0.006)
    bmesh.ops.translate(g, vec=BB + Vector((0.062, 0.0, 0.0)), verts=g.verts[:])
    _merge(frame, g)
    top0 = BB + Vector((0.062, -0.012, 0.112))
    top1 = RA + Vector((0.062, 0.05, 0.048))
    _bar(frame, top0, top1, 0.032, 0.004, P)
    _bar(frame, top0 + Vector((0.016, 0, -0.022)), top1 + Vector((0.016, 0, -0.02)), 0.003, 0.044, P)
    ring = [(0.050, 0.083), (0.050, 0.098), (0.054, 0.098), (0.054, 0.083), (0.050, 0.083)]
    g = bmesh.new()
    _revolve(g, ring, _ring_angles(24), ST)
    bmesh.ops.translate(g, vec=BB, verts=g.verts[:])
    _merge(frame, g)
    ca = math.radians(-38)
    off = Vector((0.0, 0.17 * math.cos(ca), 0.17 * math.sin(ca)))
    for s, sign in ((1, 1), (-1, -1)):
        tip = BB + off * sign + Vector((s * 0.07, 0.0, 0.0))
        _bar(frame, BB + Vector((s * 0.058, 0.0, 0.0)), tip, 0.022, 0.011, mm("aluminium"))
        _rbox(frame, tip + Vector((s * 0.05, 0.0, 0.0)), (0.045, 0.034, 0.011), 0.005, BL, ticks=-1)
    _bar(frame, BB + Vector((0.052, 0.0, -0.09)), RA + Vector((0.045, 0.0, -0.036)), 0.006, 0.008, mm("veh_chain"))
    g = bmesh.new()
    _revolve(g, [(0.038, 0.020), (0.038, 0.042), (0.041, 0.042), (0.041, 0.020), (0.038, 0.020)], _ring_angles(16), ST)
    bmesh.ops.translate(g, vec=RA, verts=g.verts[:])
    _merge(frame, g)
    # rear mudguard with stays
    _arc_band(frame, RA.y, RA.z, R + 0.012, 0.027, math.radians(-165), math.radians(12), 18, P, rim=0.016)
    for t in (-150, -105):
        q = Vector((0.0, RA.y + (R + 0.03) * math.sin(math.radians(t)), RA.z + (R + 0.03) * math.cos(math.radians(t))))
        for s in (1, -1):
            _tube(frame, [RA + Vector((s * 0.06, 0, 0)), q + Vector((s * 0.026, 0, 0))], 0.0022, ST, segs=3)
    # wheels
    wm = Mats("veh_tyre")
    wheels = bmesh.new()
    rw = _bike_wheel(wm, R, hub_w=0.038)
    bmesh.ops.translate(rw, vec=RA, verts=rw.verts[:])
    _merge(wheels, rw)
    fw = _bike_wheel(wm, R)
    bmesh.ops.translate(fw, vec=FA, verts=fw.verts[:])

    # steered part: fork, front mudguard, stem, bars, lamp (front wheel turned with it)
    for s in (1, -1):
        _tube(front, [(s * 0.046, 0.437, 0.728), (s * 0.048, 0.49, 0.585), (s * 0.05, 0.545, 0.46),
                      (s * 0.05, 0.59, 0.39), (s * 0.05, FA.y, FA.z)], [0.013, 0.012, 0.011, 0.010, 0.009], P, segs=8)
    _tube(front, [(-0.05, 0.437, 0.73), (0.05, 0.437, 0.73)], 0.016, P, segs=8)
    _tube(front, [(0.0, 0.355, 0.945), (0.0, 0.345, 1.02), (0.0, 0.40, 1.04)], 0.0125, ST, segs=8)
    bar = [(-0.30, 0.20, 1.065), (-0.22, 0.28, 1.055), (-0.10, 0.38, 1.042), (0.0, 0.40, 1.04), (0.10, 0.38, 1.042),
           (0.22, 0.28, 1.055), (0.30, 0.20, 1.065)]
    _tube(front, bar, 0.011, mm("chrome"), segs=8)
    for s in (1, -1):
        _tube(front, [(s * 0.215, 0.285, 1.055), (s * 0.31, 0.19, 1.066)], 0.017, mm("veh_grip"), segs=8)
        _bar(front, (s * 0.19, 0.335, 1.05), (s * 0.28, 0.27, 1.032), 0.012, 0.006, mm("aluminium"))
    _tube(front, [(0.0, 0.47, 0.785), (0.0, 0.535, 0.785)], 0.031, mm("chrome"), segs=12)
    _tube(front, [(0.0, 0.535, 0.785), (0.0, 0.541, 0.785)], 0.027, mm("light_clear"), segs=12)
    _arc_band(front, FA.y, FA.z, R + 0.012, 0.027, math.radians(-80), math.radians(38), 13, P, rim=0.016)
    for t in (-70, 32):
        q = Vector((0.0, FA.y + (R + 0.03) * math.sin(math.radians(t)), FA.z + (R + 0.03) * math.cos(math.radians(t))))
        for s in (1, -1):
            _tube(front, [FA + Vector((s * 0.052, 0, 0)), q + Vector((s * 0.026, 0, 0))], 0.0022, ST, segs=3)
    steer = Matrix.Translation(HB) @ Matrix.Rotation(math.radians(18), 4, (HT - HB).normalized()) @ Matrix.Translation(-HB)
    for bmx in (front, fw):
        bmx.transform(steer)
    _merge(frame, front)
    _merge(wheels, fw)

    # lean onto the kickstand (left side), then the stand itself down to the ground
    lean = Matrix.Rotation(math.radians(-8.0), 4, "Y")
    frame.transform(lean)
    wheels.transform(lean)
    a = lean @ Vector((-0.045, -0.17, 0.30))
    foot = Vector((a.x - 0.11, a.y - 0.13, 0.012))
    _tube(frame, [a, foot], 0.0085, ST, segs=6)
    _bar(frame, foot + Vector((0.0, -0.02, -0.006)), foot + Vector((0.0, 0.03, -0.006)), 0.03, 0.012, ST)
    parts = [_finish(frame, f"{name}_frame", mm, coll, angle=40.0), _finish(wheels, f"{name}_wheels", wm, coll, angle=40.0)]
    geo.tag(parts, role="vehicle", collide="none", lm=1.0)
    cb = bmesh.new()
    _bar(cb, (0.0, -0.93, 0.52), (0.0, 0.99, 0.52), 0.09, 1.04)
    _bar(cb, (-0.33, 0.29, 1.05), (0.33, 0.29, 1.05), 0.22, 0.12)
    cb.transform(lean)
    col = geo.bm_to_object(cb, f"{name}_col", None, coll)
    col.hide_render = True
    geo.tag(col, role="collider", collide="mesh")
    return parts + [col]


# ---------------------------------------------------------------- stage demo

_DEMO_PAINT = {"hatch": "car_red", "sedan": "car_silver", "van": "car_white", "micro": "car_blue"}


def _car_cats(S, W, x0, yc):
    """Collar-camera spots round a car parked along the kerb (front towards +X, right side to the road)."""
    rows = S["rows"]
    hw, tr = max(r[4] for r in rows), S["track"]
    yf, yr = x0 + S["yf"], x0 + S["yr"]
    side = yc - tr
    return [
        (yf + 0.30, side - 0.50, math.degrees(math.atan2(-0.30, 0.50))),       # front wheel from half a metre
        (x0 + rows[0][0] - 0.45, yc - hw - 0.22, 84.0),                         # along the sill from the rear corner
        (yr + 0.25, yc + 0.05, 90.0),                                            # under the car, looking forward
        (x0 + rows[-1][0] + 1.0, yc - hw - 0.9, -52.0),                          # front corner from the road
        (yr - 0.25, side - 0.45, math.degrees(math.atan2(0.25, 0.45))),         # rear wheel
    ]


def demo(coll, name=None) -> dict:
    if name in STYLES:
        S, W = STYLES[name], WHEELS[STYLES[name]["wheel"]]
        hw = max(r[4] for r in S["rows"])
        yc = -(hw + 0.20)
        geo.place(build_car(name, name, _DEMO_PAINT[name], coll, seed=3), (0.0, yc, 0.0), -90.0)
        length = S["rows"][-1][0] - S["rows"][0][0]
        return {"focus": (0.0, yc, 0.65), "radius": length * 0.62, "cat": _car_cats(S, W, 0.0, yc)}
    if name == "scooter":
        geo.place(build_scooter("scooter", "car_white", coll), (0.0, -0.8, 0.0), -90.0)
        return {"focus": (0.0, -0.8, 0.55), "radius": 1.3,
                "cat": [(0.5, -1.6, -32.0), (-1.3, -1.1, 75.0), (0.0, -1.9, 0.0), (1.3, -0.9, -95.0)]}
    if name == "bike":
        geo.place(build_bicycle("bike", "paint_green", coll), (0.0, -0.8, 0.0), -90.0)
        return {"focus": (0.0, -0.8, 0.55), "radius": 1.2,
                "cat": [(0.4, -1.5, -30.0), (-1.2, -1.1, 72.0), (0.0, -1.8, 0.0)]}
    # everything along the kerb: four cars on the road, the two-wheelers on the pavement
    x = -11.0
    cats = []
    for style in ("hatch", "sedan", "van", "micro"):
        S, W = STYLES[style], WHEELS[STYLES[style]["wheel"]]
        hw = max(r[4] for r in S["rows"])
        yc = -(hw + 0.20)
        x += -S["rows"][0][0] + 0.6
        geo.place(build_car(style, style, _DEMO_PAINT[style], coll, seed=len(cats)), (x, yc, 0.0), -90.0)
        if style in ("hatch", "van"):
            cats += _car_cats(S, W, x, yc)[:3:2]
        x += S["rows"][-1][0] + 0.6
    geo.place(build_scooter("scooter", "car_white", coll), (x + 1.0, 0.75, 0.14), -60.0)
    geo.place(build_bicycle("bike", "paint_green", coll), (x + 2.6, 0.65, 0.14), -90.0)
    return {"focus": (0.0, -0.6, 0.7), "radius": 7.5, "cat": cats}
