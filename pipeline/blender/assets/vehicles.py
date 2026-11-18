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
    # lamp units behind the clear covers
    "veh_housing": ((0.020, 0.020, 0.021), 0.55, 0.0),
    "veh_bulb": ((0.80, 0.80, 0.78), 0.08, 0.0),
    # cabin (seen through the tinted glass)
    "veh_headliner": ((0.56, 0.55, 0.52), 0.92, 0.0),
    "veh_pillar": ((0.36, 0.36, 0.35), 0.70, 0.0),
    "veh_dash": ((0.046, 0.046, 0.049), 0.66, 0.0),
    "veh_doorcard": ((0.085, 0.085, 0.090), 0.62, 0.0),
    "veh_carpet": ((0.052, 0.050, 0.048), 0.98, 0.0),
    "veh_leather": ((0.026, 0.025, 0.024), 0.45, 0.0),
    "veh_gauge": ((0.008, 0.008, 0.009), 0.22, 0.0),
    "veh_dial": ((0.62, 0.62, 0.60), 0.35, 0.0),
    "veh_belt": ((0.030, 0.030, 0.034), 0.80, 0.0),
    "veh_ply": ((0.36, 0.27, 0.16), 0.80, 0.0),
    "veh_cardboard": ((0.40, 0.28, 0.15), 0.90, 0.0),
    "veh_disc_blue": ((0.06, 0.16, 0.42), 0.45, 0.0),
    "veh_cushion_red": ((0.32, 0.06, 0.05), 0.95, 0.0),
    "veh_cushion_ochre": ((0.45, 0.32, 0.10), 0.95, 0.0),
    "veh_tree": ((0.10, 0.35, 0.10), 0.70, 0.0),
    # seat fabrics: main cloth and the centre panels, one pair per interior colour
    "veh_seat_dark": ((0.075, 0.075, 0.080), 0.95, 0.0),
    "veh_seat_dark_in": ((0.115, 0.115, 0.125), 0.97, 0.0),
    "veh_seat_grey": ((0.20, 0.20, 0.205), 0.95, 0.0),
    "veh_seat_grey_in": ((0.12, 0.125, 0.145), 0.97, 0.0),
    "veh_seat_beige": ((0.38, 0.32, 0.24), 0.95, 0.0),
    "veh_seat_beige_in": ((0.30, 0.25, 0.19), 0.97, 0.0),
    "veh_seat_blue": ((0.07, 0.085, 0.12), 0.95, 0.0),
    "veh_seat_blue_in": ((0.11, 0.14, 0.22), 0.97, 0.0),
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


def _loft(bm, rings, mis=0, closed=True, caps=True, cap_mi=None, fix=True):
    """Skin consecutive rings of points (same count each) with quads; mis is one index or one per ring segment
    (point k to k + 1).  The two end rings are closed with n-gons, normals point out of the solid."""
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    per = isinstance(mis, (list, tuple))
    faces = []
    for a, b in zip(vs[:-1], vs[1:]):
        for k in range(n if closed else n - 1):
            k2 = (k + 1) % n
            faces.append(_face(bm, (a[k], a[k2], b[k2], b[k]), mis[k] if per else mis))
    if caps:
        cm = cap_mi if cap_mi is not None else (mis[0] if per else mis)
        faces.append(_face(bm, list(reversed(vs[0])), cm))
        faces.append(_face(bm, vs[-1], cm))
    if fix:
        bmesh.ops.recalc_face_normals(bm, faces=faces)
    return faces


def _disc(bm, centre, normal, r, mi, segs=10, up=(0.0, 0.0, 1.0)):
    """Flat round face (an n-gon) facing `normal`."""
    nrm = Vector(normal).normalized()
    u = Vector(up)
    u = (u - nrm * u.dot(nrm))
    u = u.normalized() if u.length > 1e-6 else nrm.orthogonal().normalized()
    v = nrm.cross(u)
    vs = [bm.verts.new(Vector(centre) + (u * math.cos(a) + v * math.sin(a)) * r) for a in _ring_angles(segs)]
    f = _face(bm, vs, mi)
    f.normal_update()
    if f.normal.dot(nrm) < 0:
        f.normal_flip()
    return f


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


def _round_rect(u0, u1, v0, v1, r, n=3):
    """Convex 2D outline of a rectangle with rounded corners (counter-clockwise)."""
    r = min(r, (u1 - u0) / 2 * 0.99, (v1 - v0) / 2 * 0.99)
    pts = []
    for cu, cv, a0 in ((u1 - r, v0 + r, -90.0), (u1 - r, v1 - r, 0.0), (u0 + r, v1 - r, 90.0), (u0 + r, v0 + r, 180.0)):
        for k in range(n + 1):
            a = math.radians(a0 + 90.0 * k / n)
            pts.append((cu + r * math.cos(a), cv + r * math.sin(a)))
    return pts


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
    """A shut line: a thin dark slot along the 2D segment a-b of a projection (a negative depth raises a
    crease instead).  Returns the vertices on its centre line."""
    segs = [(a, b), ((-a[0], a[1]), (-b[0], b[1]))] if mirror else [(a, b)]
    i, j = _AX[axes[0]], _AX[axes[1]]
    moved = set()
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
        moved |= centre
    return moved


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
    LAMPGLASS = mm("glass_lamp")
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
    # fuel flap: a lid sitting a touch below the skin in a thin dark gap
    y0, y1, z0, z1 = S["fuel"]
    right = lambda c, n: n.x > 0.3 and c.x > 0.3
    carve(bm, "yz", _round_rect(min(y0, y1), max(y0, y1), z0, z1, 0.0, n=1), right, SHUT, PAINT, inset=0.0035,
          push=0.0015, margin=0.025, mats=ok)
    # finger pockets behind the door pulls
    for y_h in S["handles"]:
        z_h = belt(y_h) - 0.085
        carve(bm, "yz", _round_rect(y_h - 0.07, y_h + 0.07, z_h - 0.034, z_h + 0.010, 0.0, n=1), side, PAINT, PAINT,
              inset=0.005, push=0.011, margin=0.025, mats=ok)
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
    # lamps: a clear cover set a touch into the skin (the lamp units behind it are added in _lamp_units), grille, intake
    front_face = lambda c, n: n.y > 0.05 and c.y > y_front - 0.30 and c.z > zb(c.y) + 0.1
    carve(bm, "xz", S["head"], front_face, TRIM, LAMPGLASS, push=0.003, mirror=True, mats=ok)
    rear_face = lambda c, n: n.y < -0.05 and c.y < y_rear + 0.30
    carve(bm, "xz", S["tail"], rear_face, TRIM, LAMPGLASS, push=0.003, mirror=True, mats=ok)
    nose = lambda c, n: n.y > 0.3 and c.y > yf + ra
    carve(bm, "xz", S["grille"], nose, TRIM, PLAST, push=0.012, mats=ok)
    carve(bm, "xz", S["intake"], nose, PLAST, SHUT, push=0.02, mats=ok)
    # the flat floor pan does not need the subdivision's density
    floor = [f for f in bm.faces if f.material_index == UNDER and f.normal.z < -0.95]
    if floor:
        bmesh.ops.dissolve_faces(bm, faces=floor, use_verts=True)


def _crease(bm, S, W):
    """A character line along the doors at no cost in triangles: the row of skin vertices nearest to 15 cm
    under the window line is pushed out 6 mm (its edges are made sharp in _build_body).  Run on the plain
    subdivided skin, before anything is cut into it."""
    rows = S["rows"]
    ra = W["Ro"] + S["arch"]
    y_lo, y_hi = S["yr"] + ra + 0.06, S["yf"] - ra - 0.02
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    out = set()
    for s in (1.0, -1.0):
        z_aim = _interp(rows, 0.0, 2) - 0.15
        side = [v for v in bm.verts if v.co.x * s > 0.6 and abs(v.normal.x) > 0.8 and abs(v.co.y) < 0.12]
        if not side:
            continue
        start = min(side, key=lambda v: abs(v.co.z - z_aim))
        line = {start}
        for direction in (1.0, -1.0):
            v = start
            while True:
                best, best_dot = None, 0.9
                for e in v.link_edges:
                    w = e.other_vert(v)
                    d = (w.co - v.co).normalized()
                    if d.y * direction > best_dot:
                        best, best_dot = w, d.y * direction
                if best is None or not (y_lo <= best.co.y <= y_hi) or best in line:
                    break
                line.add(best)
                v = best
        out |= line
    moves = [(v, v.normal.copy()) for v in out]
    for v, n in moves:
        v.co += n * 0.006
    return out


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


class _Shell:
    """Ray queries against the outer skin of a car body (car-local coordinates), taken before the lamp units
    go in behind the covers.  Rays hit faces from either side, so it answers from inside the car too."""

    def __init__(self, bm, glass: set, lamp: set):
        bm.normal_update()
        self.bvh = BVHTree.FromBMesh(bm)
        self.glass = [f.material_index in glass for f in bm.faces]
        self.lamp = [f.material_index in lamp for f in bm.faces]

    def ray(self, o, d):
        """First hit along a ray: (location, face normal, hit is car glass) or (None, None, False)."""
        loc, nrm, idx, _ = self.bvh.ray_cast(Vector(o), Vector(d).normalized())
        if loc is None:
            return None, None, False
        return loc, nrm, self.glass[idx]

    def lamp_hit(self, o, d):
        loc, nrm, idx, _ = self.bvh.ray_cast(Vector(o), Vector(d).normalized())
        if loc is None or not self.lamp[idx]:
            return None, None
        return loc, nrm

    def x(self, y, z, fallback=0.8):
        """Inner side of the skin (right-hand side) at (y, z), looking out from beside the floor tunnel."""
        loc, _, _ = self.ray((0.3, y, z), (1.0, 0.0, 0.0))
        return loc.x if loc is not None else fallback

    def z_up(self, x, y, z0):
        loc, _, _ = self.ray((x, y, z0), (0.0, 0.0, 1.0))
        return loc.z if loc is not None else z0 + 0.5

    def z_down(self, x, y, z0):
        loc, _, _ = self.ray((x, y, z0), (0.0, 0.0, -1.0))
        return loc.z if loc is not None else 0.2


def _build_body(name, S, W, paint, coll):
    obj = _body_shell(name, S, W, paint, coll)
    mm = Mats(*[m.name for m in obj.data.materials])
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    crease = _crease(bm, S, W)
    _carve_body(bm, S, W, mm)
    crease = {v for v in crease if v.is_valid}
    shell = _Shell(bm, {mm("glass_car")}, {mm("glass_lamp")})
    _lamp_units(bm, S, mm, shell)
    _shade_bm(bm, 48.0)
    for e in bm.edges:
        if e.verts[0] in crease and e.verts[1] in crease:
            e.smooth = False
    bm.to_mesh(obj.data)
    bm.free()
    mm.attach(obj)
    geo.uv_box(obj)
    return obj, shell


# ---------------------------------------------------------------- lamp units behind the clear covers

def _face_groups(faces):
    """Split faces into edge-connected groups."""
    left = set(faces)
    out = []
    while left:
        f0 = left.pop()
        group, stack = [f0], [f0]
        while stack:
            f = stack.pop()
            for e in f.edges:
                for g in e.link_faces:
                    if g in left:
                        left.remove(g)
                        group.append(g)
                        stack.append(g)
        out.append(group)
    return out


def _outline(faces):
    """Ordered outer boundary vertices of a disc-shaped group of faces."""
    fs = set(faces)
    nxt = {}
    for f in faces:
        for loop in f.loops:
            if sum(1 for g in loop.edge.link_faces if g in fs) == 1:
                nxt[loop.vert] = loop.link_loop_next.vert
    best, seen = [], set()
    for start in nxt:
        if start in seen:
            continue
        cyc, v = [start], nxt[start]
        seen.add(start)
        while v is not start and v not in seen and v in nxt:
            cyc.append(v)
            seen.add(v)
            v = nxt[v]
        if len(cyc) > len(best):
            best = cyc
    return best


def _cup(bm, rim_c, axis, r, depth, mi, mi_back, segs=7):
    """Reflector bowl: rim centred on rim_c, opening against `axis` (axis points into the lamp)."""
    a = Vector(axis).normalized()
    u = a.orthogonal().normalized()
    v = a.cross(u)
    angs = _ring_angles(segs)
    rings = [[bm.verts.new(rim_c + a * (depth * t) + (u * math.cos(q) + v * math.sin(q)) * (r * k)) for q in angs]
             for t, k in ((0.0, 1.0), (0.62, 0.70), (1.0, 0.2))]
    focus = rim_c + a * (depth * 0.45)
    for r0, r1 in zip(rings[:-1], rings[1:]):
        for i in range(segs):
            f = _face(bm, (r0[i], r0[(i + 1) % segs], r1[(i + 1) % segs], r1[i]), mi)
            f.normal_update()
            if f.normal.dot(focus - f.calc_center_median()) < 0:
                f.normal_flip()
    f = _face(bm, rings[-1], mi_back)
    f.normal_update()
    if f.normal.dot(-a) < 0:
        f.normal_flip()
    return rim_c + a * depth


def _bulb(bm, base, axis, length, mi, r=0.0085):
    a = Vector(axis).normalized()
    _tube(bm, [base, base + a * (length * 0.55), base + a * length], [r * 0.75, r, r * 0.7], mi, segs=4)


def _fitted(bm, shell, tries):
    """Build the first of `tries` (functions that fill a bmesh) that stays clear of the skin, into bm."""
    for make in tries:
        tmp = bmesh.new()
        make(tmp)
        tmp.normal_update()
        if not shell.bvh.overlap(BVHTree.FromBMesh(tmp)):
            _merge(bm, tmp)
            return True
        tmp.free()
    return False


def _housing(bm, pts, nrms, c0, back, mi_wall, mi_plate):
    """Lamp housing: walls from the cover's edge (just inside the skin) in towards `back`, closed by a plate."""
    n = len(pts)
    m = 12 if n >= 24 else 8
    near = [bm.verts.new(p - vn * 0.0015) for p, vn in zip(pts, nrms)]
    far = [bm.verts.new(pts[i * n // m] + (back - pts[i * n // m]) * 0.6) for i in range(m)]
    walls = []
    for k in range(n):
        ca, cb = k * m // n, ((k + 1) * m // n) % m
        quad = (near[k], near[(k + 1) % n], far[cb], far[ca]) if ca != cb else (near[k], near[(k + 1) % n], far[ca])
        walls.append(_face(bm, quad, mi_wall))
    plate = _face(bm, far, mi_plate)
    axis = back - c0
    for f in walls:
        f.normal_update()
        p = f.calc_center_median()
        t = max(0.0, min(1.0, (p - c0).dot(axis) / axis.length_squared))
        if f.normal.dot(c0 + axis * t - p) < 0:
            f.normal_flip()
    plate.normal_update()
    if plate.normal.dot(c0 - plate.calc_center_median()) < 0:
        plate.normal_flip()


def _lamp_units(bm, S, mm, shell):
    """Behind each clear lamp cover: a housing running back from the cover's edge, reflector bowls with
    bulbs in them, and (tail lamps) red ribs in front of a red reflector.  Each piece is tried at a few
    sizes and only the first one that stays clear of the skin is kept."""
    LG = mm("glass_lamp")
    HOUSE, REFL, BULB = mm("veh_housing"), mm("veh_headlamp"), mm("veh_bulb")
    AMBER, RED = mm("veh_amber"), mm("light_red")
    bm.normal_update()
    y_front, y_rear = S["rows"][-1][0], S["rows"][0][0]
    for group in _face_groups([f for f in bm.faces if f.material_index == LG]):
        ring = _outline(group)
        n = len(ring)
        if n < 8:
            continue
        front = sum(f.calc_center_median().y for f in group) > 0
        pts = [v.co.copy() for v in ring]
        c0 = sum(pts, Vector()) / n
        nrm = sum((f.normal * f.calc_area() for f in group), Vector()).normalized()
        # the edge is thinned where it runs nearly straight (chords on the curved skin stay behind the cover)
        keep = [0]
        for i in range(1, n):
            a, b, c = pts[keep[-1]], pts[i], pts[(i + 1) % n]
            if i - keep[-1] >= 3 or (b - a).normalized().dot((c - b).normalized()) < 0.985:
                keep.append(i)
        inner = REFL if front else RED

        def housing(depth, idx):
            back = c0 - nrm * depth
            back.x *= 0.9
            pe, ne = [pts[i] for i in idx], [ring[i].normal.copy() for i in idx]
            return lambda t: _housing(t, pe, ne, c0, back, inner, inner)

        def lens(t, gap=0.01):
            """Fallback where no housing fits: a second skin just behind the cover."""
            vs = {}
            for f in group:
                for v in f.verts:
                    if v not in vs:
                        vs[v] = t.verts.new(v.co - v.normal * gap)
                _face(t, [vs[v] for v in f.verts], inner)

        depths = [d * (0.10 if front else 0.07) for d in (1.0, 0.75, 0.55, 0.4, 0.28)]
        _fitted(bm, shell, [housing(d, keep) for d in depths] + [housing(d, range(n)) for d in depths[2:]] + [lens])
        # bowls and bulbs, placed by their spot on the cover (x across, z up)
        side = 1.0 if c0.x > 0 else -1.0
        xs = [abs(p.x) for p in pts]
        zs = [p.z for p in pts]
        x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
        zm, h = (z0 + z1) / 2, z1 - z0
        y_out = (y_front + 1.0) if front else (y_rear - 1.0)
        look = Vector((0.0, -1.0 if front else 1.0, 0.0))

        def on_cover(fx, fz):
            loc, cn = shell.lamp_hit((side * (x0 + (x1 - x0) * fx), y_out, fz), look)
            return (loc, cn) if loc is not None else (None, None)

        r_b = min(0.036, 0.36 * h)
        wide = x1 - x0
        # (spot across, spot up, bowl radius or 0 for a bare bulb, bulb); a lamp split by a shut line gets
        # fewer cells in each part
        if front:
            cells = [(0.28, zm, r_b, BULB), (0.58, zm, r_b * 0.9, BULB), (0.88, zm, 0.0, AMBER)]
        elif wide >= 0.24:
            cells = [(0.14, zm, r_b * 0.7, BULB), (0.46, zm, r_b * 0.85, RED), (0.78, zm, 0.0, AMBER)]
        elif wide >= 0.12:
            cells = [(0.26, zm, r_b * 0.7, BULB), (0.70, zm, r_b * 0.8, RED)]
        else:
            cells = [(0.5, zm, 0.0, AMBER)]
        def cell(loc, cn, r, gap, bulb_mi):
            def make(t):
                if r:
                    base = _cup(t, loc - cn * gap, -cn, r, r * 0.95, REFL, HOUSE)
                    _bulb(t, base, cn, r * 0.75, bulb_mi)
                else:                       # a bare bulb standing out of the reflector plate
                    _bulb(t, loc - cn * 0.075, cn, 0.055, bulb_mi, r=0.008)
            return make

        for fx, fz, r, bulb_mi in cells:
            loc, cn = on_cover(fx, fz)
            if loc is not None:
                _fitted(bm, shell, [cell(loc, cn, r * k, g, bulb_mi) for k, g in ((1.0, 0.008), (0.8, 0.012), (0.6, 0.016))])
        if not front and wide >= 0.12:
            # horizontal red ribs in front of the reflector plate: the lens optics seen through the cover
            for dz in (-0.36 * h, 0.36 * h):
                ends = [on_cover(fx, zm + dz)[0] for fx in (0.08, 0.66)]
                if None not in ends:
                    a, b = (e + Vector((0.0, 0.014, 0.0)) for e in ends)
                    _fitted(bm, shell, [lambda t, a=a, b=b: _bar(t, a, b, 0.009, 0.007, RED)])


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


def _box(bm, centre, half, turn, mi):
    """Plain box (cardboard and the like have sharp edges) turned about Z."""
    rot = Matrix.Rotation(turn, 3, "Z")
    c, (hx, hy, hz) = Vector(centre), half
    a, b = c - rot @ Vector((hx, 0.0, 0.0)), c + rot @ Vector((hx, 0.0, 0.0))
    return _bar(bm, a, b, 2 * hy, 2 * hz, mi)


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
    Z = Vector((0.0, 0.0, 1.0))
    # door mirrors: a black foot on the door skin, a short arm, a housing with a painted cap and a black back
    # that frames the glass
    y_m = S["dlo"][0][0] - 0.07
    z_m = belt(y_m) + 0.05
    sec = [(-0.030, 0.050), (0.004, 0.060), (0.032, 0.050), (0.044, 0.022), (0.046, -0.008), (0.036, -0.036),
           (0.012, -0.052), (-0.030, -0.048)]
    for s in (1, -1):
        p, n = hit((s * 2.0, y_m, z_m), (-s, 0.0, 0.0))
        if p is None:
            continue
        ty = Vector((0.0, 1.0, 0.0))
        ty = (ty - n * n.dot(ty)).normalized()
        tz = n.cross(ty).normalized()
        if tz.z < 0:
            tz.negate()
        foot = Matrix(((ty.x, tz.x, n.x, p.x), (ty.y, tz.y, n.y, p.y), (ty.z, tz.z, n.z, p.z), (0.0, 0.0, 0.0, 1.0)))
        _prism(bm, _round_rect(-0.048, 0.040, -0.030, 0.028, 0.013), -0.010, 0.008, BLACK, foot)
        rot = Matrix.Rotation(math.radians(-7 * s), 3, "Z")
        X, Yd = rot @ Vector((s, 0.0, 0.0)), rot @ Vector((0.0, 1.0, 0.0))
        hb = p + n * 0.05 + Vector((0.0, -0.012, 0.03))
        rings = [[hb + X * t + Yd * (y * k) + Z * (z * k) for y, z in sec]
                 for t, k in ((0.0, 0.72), (0.025, 0.95), (0.15, 1.0), (0.172, 0.84))]
        _loft(bm, rings, [shell] * 7 + [BLACK], cap_mi=shell)
        gl = hb + Yd * -0.0312 + Z * 0.001
        _bar(bm, gl + X * 0.032, gl + X * 0.154, 0.004, 0.082, mm("veh_mirror"))
        _bar(bm, p - n * 0.004 + Z * 0.004, hb + X * 0.014 + Z * -0.012, 0.024, 0.020, BLACK)
        # side repeater just behind the front wheel arch
        ang = math.radians(-38)
        yq, zq = yf + ra * math.sin(ang) - 0.06, W["Ro"] + ra * math.cos(ang) + 0.07
        p2, n2 = hit((s * 2.0, yq, zq), (-s, 0.0, 0.0))
        if p2 is not None:
            _bar(bm, p2 + Vector((0, -0.022, 0)), p2 + Vector((0, 0.022, 0)), 0.006, 0.016, mm("veh_amber"))
    # door pulls standing over their finger pockets (carved into the skin in _carve_body)
    for y_h in S["handles"]:
        z_h = belt(y_h) - 0.085
        for s in (1, -1):
            pa, na = hit((s * 2.0, y_h + 0.085, z_h), (-s, 0.0, 0.0))
            pb, nb = hit((s * 2.0, y_h - 0.085, z_h), (-s, 0.0, 0.0))
            if pa is None or pb is None:
                continue
            nn = (na + nb).normalized()
            path = [pa + (pb - pa) * t + nn * off for t, off in
                    ((0.09, -0.004), (0.16, 0.010), (0.29, 0.0145), (0.71, 0.0145), (0.84, 0.010), (0.91, -0.004))]
            _tube(bm, path, [0.0062, 0.0072, 0.0078, 0.0078, 0.0072, 0.0062], shell, segs=5)
    # rubbing strips along the doors (not on cars with black sills), broken at the shut lines
    z_r = {"hatch": 0.50, "sedan": 0.49, "van": 0.57}.get(S["wheel"])
    if z_r:
        y_a, y_b = yf - ra - 0.07, yr + ra + 0.07
        cuts = []
        for seg in S["doors"]:
            for (ya_, za_), (yb_, zb_) in zip(seg[:-1], seg[1:]):
                if abs(za_ - zb_) > 1e-6 and min(za_, zb_) <= z_r <= max(za_, zb_):
                    cuts.append(ya_ + (yb_ - ya_) * (z_r - za_) / (zb_ - za_))
        ends = sorted({y_a, y_b, *[c for c in cuts if y_b + 0.05 < c < y_a - 0.05]}, reverse=True)
        for s in (1, -1):
            for k, (ya_, yb_) in enumerate(zip(ends[:-1], ends[1:])):
                ya_ -= 0.004 if k > 0 else 0.0
                yb_ += 0.004 if k < len(ends) - 2 else 0.0
                steps = max(2, int(math.ceil((ya_ - yb_) / 0.26)))
                rings = []
                for q in range(steps + 1):
                    p, n = hit((s * 2.0, ya_ + (yb_ - ya_) * q / steps, z_r), (-s, 0.0, 0.0))
                    if p is None:
                        break
                    zt = (Z - n * n.z).normalized()
                    rings.append([p - n * 0.003 - zt * 0.017, p + n * 0.006 - zt * 0.010, p + n * 0.006 + zt * 0.010,
                                  p - n * 0.003 + zt * 0.017])
                if len(rings) >= 2:
                    _loft(bm, rings, TRIM, closed=False)
    # rubber seal along the bottom of the side windows
    (d0y, d0z), (d1y, d1z) = S["dlo"][0], S["dlo"][-1]
    steps = max(2, int(math.ceil(abs(d0y - d1y) / 0.35)))
    for s in (1, -1):
        rings = []
        for q in range(steps + 1):
            t = 0.01 + 0.98 * q / steps
            p, n = hit((s * 2.0, d0y + (d1y - d0y) * t, d0z + (d1z - d0z) * t + 0.003), (-s, 0.0, 0.0))
            if p is None:
                break
            zt = (Z - n * n.z).normalized()
            rings.append([p - n * 0.002 - zt * 0.0065, p + n * 0.0035, p - n * 0.002 + zt * 0.0065])
        if len(rings) >= 2:
            _loft(bm, rings, mm("veh_seal"), closed=False)
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
    # (the lamps' insides are part of the body: see _lamp_units)
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
    # The body you see is this cage smoothed twice; smoothed once it sits just outside the paintwork everywhere.
    # So the cat (and its camera) is stopped at the real shape: it can walk up the bonnet and over the roof,
    # and can no longer push its lens inside the cabin, which two plain boxes allowed.
    shell = geo.bm_to_object(_cc(_cage(S), 1), f"{name}_col_body", None, coll)
    out = [shell]
    # The wheels only need a shape where they stick out below the body. (Solid shapes that overlap confuse the
    # game's test for "is this point inside something", and the body shell already covers the rest of the wheel.)
    low = min(v.co.z for v in shell.data.vertices) + 0.012
    half = W["Ro"] * 0.86
    for i, (y, s) in enumerate(((S["yf"], 1), (S["yf"], -1), (S["yr"], 1), (S["yr"], -1))):
        x = s * S["track"]
        out.append(geo.box(f"{name}_col_wheel{i}", (x - W["Wt"] / 2, y - half, 0.0), (x + W["Wt"] / 2, y + half, low), None, coll))
    for o in out:
        o.hide_render = True
    geo.tag(out, role="collider", collide="mesh")
    return out


# ---------------------------------------------------------------- cabin
#
# Everything behind the glass is one object.  The cat sees it mostly from below (roof lining, seat tops,
# headrests, the top of the steering wheel) and from the bonnet or the roof (dashboard, wheel, seats).
# Right-hand drive, like the plates.  Every piece is placed with rays cast against the finished skin
# (see _Shell), so nothing reaches through it or through the glass:
#   lining  22 mm inside the skin from one window sill over the roof to the other, closed at both ends
#           (firewall, back panel or bulkhead), the windows cut out exactly and a rubber reveal run from
#           each opening out to its glass
#   trims   door cards (sill, armrest, pocket, handle) and side panels down to the floor, clear of the arches
#   floor   carpet stepping in past the wheel arches, tunnel, console with gear lever and handbrake
#   dash    dashboard, instrument hood with two dials, centre stack, glovebox, wheel on its column
#   seats   front seats with headrests, a rear bench (the van: a bulkhead and a plywood load bay instead)
#   bits    parcel shelf, mirror, belts and, by the seed, a few things left in the car

CABIN = {
    # front, back: ends of the lining; pillar: B-pillar y; arm: armrest height
    # dash: (top lip y, top z, knee y, knee z); wheel: (centre y, centre z, tilt from upright)
    # seat: (x, cushion front y, cushion back y, cushion top z, half width, back height, recline)
    # bench: (cushion front y, cushion back y, top z, half width, back height, recline, headrests)
    # panels: side trims from the front back, (y front, y back, kind); None = the end of the lining
    "hatch": {"front": 0.83, "back": -1.88, "pillar": -0.315, "arm": 0.62, "shelf": 0.975,
              "dash": (0.52, 0.995, 0.61, 0.62), "wheel": (0.32, 0.885, 25.0),
              "seat": (0.355, 0.22, -0.24, 0.50, 0.255, 0.60, 17.0),
              "bench": (-0.62, -1.02, 0.515, 0.70, 0.50, 22.0, 2),
              "panels": [(0.86, -0.315, "front"), (-0.315, -1.08, "rear"), (-1.08, None, "plain")]},
    "sedan": {"front": 0.93, "back": -1.47, "pillar": -0.38, "arm": 0.61, "shelf": 0.972,
              "dash": (0.58, 0.990, 0.67, 0.62), "wheel": (0.38, 0.885, 25.0),
              "seat": (0.37, 0.28, -0.18, 0.50, 0.26, 0.61, 17.0),
              "bench": (-0.56, -0.98, 0.51, 0.72, 0.52, 24.0, 2),
              "panels": [(0.94, -0.38, "front"), (-0.38, -1.13, "rear"), (-1.13, None, "plain")]},
    "van": {"front": 1.24, "back": -0.08, "pillar": 0.0, "arm": 0.70, "load": (-0.11, -2.10),
            "dash": (0.93, 1.12, 1.00, 0.80), "wheel": (0.79, 1.10, 36.0),
            "seat": (0.42, 0.55, 0.13, 0.66, 0.26, 0.64, 10.0),
            "panels": [(None, 0.91, "plain"), (0.91, None, "front")]},
    "micro": {"front": 0.49, "back": -1.40, "pillar": -0.45, "arm": 0.63, "shelf": 0.950,
              "dash": (0.32, 0.975, 0.39, 0.63), "wheel": (0.17, 0.875, 28.0),
              "seat": (0.31, 0.02, -0.40, 0.53, 0.22, 0.62, 14.0),
              "bench": (-0.60, -0.92, 0.535, 0.37, 0.48, 18.0, 2),
              "panels": [(0.58, -0.45, "front"), (-0.45, -0.88, "rear"), (-0.88, None, "plain")]},
}

_LINE = 0.022                                                  # lining depth inside the skin
_MK_LIN, _MK_CAPF, _MK_CAPR, _MK_SIDE, _MK_WS, _MK_RS, _MK_SEAL = 60, 61, 62, 63, 64, 65, 66   # marks while cutting
_ARCH_X = 0.41                                                 # inner wall of the wheel arches (see _arch_cutters)


def _seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
    return (a + ab * t - p).length


def _thin(n, err, tol, span):
    """Indices of 0..n-1 to keep so that straight pieces between kept ones stay within tol (err(i, j))."""
    keep, i = [0], 0
    while i < n - 1:
        j = i + 1
        while j + 1 < n and j + 1 - i <= span and err(i, j + 1) <= tol:
            j += 1
        keep.append(j)
        i = j
    return keep


def _arch_top(S, W, y, m=0.03):
    """Top of a wheel arch at `y` grown by m (for |x| > _ARCH_X), or None away from the arches."""
    ra = W["Ro"] + S["arch"] + m
    zc = W["Ro"] - FLAT + 0.006
    top = None
    for ya in (S["yf"], S["yr"]):
        dy = y - ya
        if abs(dy) < ra:
            z = zc + math.sqrt(ra * ra - dy * dy)
            top = z if top is None else max(top, z)
    return top


def _off_arches(p, S, W, m=0.03):
    """Pull a point that would sit in (or within m of) a wheel arch in past the arch's inner wall."""
    top = _arch_top(S, W, p.y, m) if abs(p.x) > _ARCH_X - m else None
    if top is not None and p.z < top:
        p = p.copy()
        p.x = math.copysign(_ARCH_X - m, p.x)
    return p


def _lift_off_arches(verts, S, W, m=0.03):
    for v in verts:
        if abs(v.co.x) > _ARCH_X - m:
            top = _arch_top(S, W, v.co.y, m)
            if top is not None and v.co.z < top:
                v.co.z = top


def _lining(P, S, W, y_back, y_front, zc, panes=True, ws=True, rear=True, tol=0.014):
    """Inner skin from y_back to y_front: a band from one sill over the roof to the other (rays from a centre
    line at height zc(y), level-right round to level-left), each end closed by a full ring.  Facets are
    thinned so straight pieces stay within `tol` of the skin.  Windows are cut out exactly as in _carve_body
    and a reveal runs from each opening to its glass.  Faces carry _MK_* marks for the caller."""
    from shapely.geometry import Polygon, box as sbox

    rows = S["rows"]
    belt = lambda y: _interp(rows, y, 2)
    ny = max(2, int(round((y_front - y_back) / 0.025)))
    fy = [y_back + (y_front - y_back) * i / ny for i in range(ny + 1)]
    dirs = [Vector((math.cos(math.radians(3.0 * k)), 0.0, math.sin(math.radians(3.0 * k)))) for k in range(61)]

    def inset(c, d):
        loc, nrm, gl = P.ray(c, d)
        if loc is None:
            return c + d * 0.4, c + d * (0.4 - _LINE), True
        return loc, loc - d * (_LINE / max(0.45, abs(d.dot(nrm)))), gl

    H, O, G = [], [], []
    for y in fy:
        c = Vector((0.0, y, zc(y)))
        got = [inset(c, d) for d in dirs]
        H.append([g[0] for g in got])
        O.append([g[1] for g in got])
        G.append([g[2] for g in got])

    def err_a(i, j):
        worst = 0.0
        for hr, gr in zip(H, G):
            if gr[i] or gr[j]:
                continue
            for k in range(i + 1, j):
                if not gr[k]:
                    worst = max(worst, _seg_dist(hr[k], hr[i], hr[j]))
                    if worst > tol:
                        return worst
        return worst

    ka = _thin(len(dirs), err_a, tol, 8)

    def err_y(i, j):
        worst = 0.0
        for k in ka:
            if G[i][k] or G[j][k]:
                continue
            for s in range(i + 1, j):
                if not G[s][k]:
                    worst = max(worst, _seg_dist(H[s][k], H[i][k], H[j][k]))
                    if worst > tol:
                        return worst
        return worst

    ks = _thin(len(fy), err_y, tol, 12)
    bm = bmesh.new()
    V = [[bm.verts.new(O[s][k]) for k in ka] for s in ks]
    for a, b in zip(V[:-1], V[1:]):
        for k in range(len(ka) - 1):
            f = _face(bm, (a[k], a[k + 1], b[k + 1], b[k]), _MK_LIN)
            f.normal_update()
            c = f.calc_center_median()
            if f.normal.dot(Vector((0.0, c.y, zc(c.y))) - c) < 0:
                f.normal_flip()
    # end caps: the band's end ring continued round underneath
    for row, y, mark, sign in ((V[-1], fy[-1], _MK_CAPF, -1.0), (V[0], fy[0], _MK_CAPR, 1.0)):
        c = Vector((0.0, y, zc(y)))
        low = []
        for a in range(190, 360, 10):
            d = Vector((math.cos(math.radians(a)), 0.0, math.sin(math.radians(a))))
            low.append(bm.verts.new(_off_arches(inset(c, d)[1], S, W)))
        f = _face(bm, list(row) + low, mark)
        f.normal_update()
        if f.normal.y * sign < 0:
            f.normal_flip()
    # windows: the same outlines the skin was cut with
    LIN = {_MK_LIN}
    if panes:
        dlo = Polygon(S["dlo"]).buffer(-0.016, join_style=2)
        sp = lambda c, n: abs(n.x) > 0.2 and abs(c.x) > 0.25 and c.z > belt(c.y) - 0.10
        for ya, yb_ in S["panes"]:
            pane = dlo.intersection(sbox(ya, -9.0, yb_, 9.0)).simplify(0.001)
            if not pane.is_empty and pane.area > 0.01:
                carve(bm, "yz", list(pane.exterior.coords)[:-1], sp, _MK_SIDE, margin=0.3, mats=LIN)
    if ws:
        wb, wt, xb, xt = S["ws"]
        wp = lambda c, n: n.z < -0.15 and c.z > belt(c.y) - 0.05
        carve(bm, "xy", [(-xb, wb), (xb, wb), (xt, wt), (-xt, wt)], wp, _MK_LIN, _MK_WS, inset=0.03, margin=0.3,
              mats=LIN)
    if rear:
        poly, ylim, kind = S["rs"]
        if kind == "slope":
            rp = lambda c, n: n.y > 0.03 and n.z < -0.1 and c.y < ylim + 0.1 and c.z > belt(c.y) - 0.02
        else:
            rp = lambda c, n: n.y > 0.15 and c.y < ylim + 0.1 and c.z > belt(c.y) - 0.06
        carve(bm, "xz", poly, rp, _MK_LIN, _MK_RS, inset=0.025, mirror=kind == "rear_pair", margin=0.3, mats=LIN)
        carve(bm, "xz", poly, lambda c, n: n.y > 0.5 and c.y < ylim + 0.1, _MK_CAPR, _MK_RS, inset=0.025,
              mirror=kind == "rear_pair", margin=0.7, mats={_MK_CAPR})
    # open the windows and run a reveal from each opening's edge straight out to the glass
    bm.normal_update()
    holes = {_MK_SIDE: None, _MK_WS: Vector((0.0, 0.0, 1.0)), _MK_RS: Vector((0.0, -1.0, 0.0))}
    rims = []
    for f in bm.faces:
        if f.material_index in holes:
            hc = f.calc_center_median()
            for e in f.edges:
                other = [g for g in e.link_faces if g is not f]
                if other and other[0].material_index not in holes:
                    rims.append((e.verts[0], e.verts[1], f.material_index, hc))
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in holes], context="FACES")
    tips = {}

    def tip(v, kind):
        if (v, kind) not in tips:
            d = holes[kind] or Vector((math.copysign(1.0, v.co.x), 0.0, 0.0))
            loc, _, _ = P.ray(v.co, d)
            ok = loc is not None and (loc - v.co).length < 0.075
            tips[(v, kind)] = bm.verts.new(loc - d * 0.0015 if ok else v.co + d * 0.012)
        return tips[(v, kind)]

    walls, base = [], {}
    for v1, v2, kind, hc in rims:
        t1, t2 = tip(v1, kind), tip(v2, kind)
        base[t1], base[t2] = v1, v2
        f = _face(bm, (v1, v2, t2, t1), _MK_SEAL)
        f.normal_update()
        if f.normal.dot(hc - f.calc_center_median()) < 0:
            f.normal_flip()
        walls.append((f, t1, t2))
    # where a reveal would cut across the skin (a corner where the glass edge turns away), pull it back in
    for _ in range(10):
        vs = list({v for f, _, _ in walls for v in f.verts})
        idx = {v: i for i, v in enumerate(vs)}
        tree = BVHTree.FromPolygons([v.co.copy() for v in vs], [[idx[v] for v in f.verts] for f, _, _ in walls])
        bad = {j for _, j in P.bvh.overlap(tree)}
        if not bad:
            break
        for j in bad:
            for t in walls[j][1:]:
                t.co = base[t].co + (t.co - base[t].co) * 0.6
    return bm


def _trim_profile(belt, z_arm, z_bot, arm):
    """Cross-section of a side trim as (depth in from the skin, z), from the window sill down and back up the
    skin.  arm: True (armrest), False (door, no armrest here), None (plain panel, fewer points)."""
    top = [(0.006, belt - 0.004), (0.046, belt - 0.003), (0.060, belt - 0.022)]
    bot = [(0.074, z_bot + 0.008), (0.030, z_bot)]
    if arm is None:
        return top + [(0.064, (belt - 0.022 + z_bot) / 2)] + bot
    if z_arm - 0.05 > z_bot + 0.15:
        if arm:
            mid = [(0.066, z_arm + 0.050), (0.112, z_arm + 0.030), (0.118, z_arm - 0.006), (0.084, z_bot + 0.125)]
        else:
            mid = [(0.066, z_arm + 0.050), (0.068, z_arm + 0.030), (0.068, z_arm - 0.006), (0.082, z_bot + 0.125)]
    else:                                   # beside a wheel arch: no room for the armrest
        za, zb = belt - 0.022, z_bot + 0.008
        mid = [(0.064 + 0.002 * t, za + (zb - za) * (t + 1) / 5) for t in range(4)]
    return top + mid + bot


def _trims(bm, P, S, W, C, mm, ins, panels, front, back, ply=False):
    """Door cards and side panels from the window sill down to the floor, both sides, stepping up over the
    wheel arches.  Doors get an armrest, a map pocket, an inner handle and (front doors) a speaker."""
    rows = S["rows"]
    belt = lambda y: _interp(rows, y, 2)
    ra = W["Ro"] + S["arch"]
    zones = [(ya - ra - 0.08, ya + ra + 0.08) for ya in (S["yf"], S["yr"])]
    SILL, CARD = (mm("veh_ply"), mm("veh_ply")) if ply else (mm("veh_dash"), mm("veh_doorcard"))
    ARM, CHROME, DARK = mm(ins), mm("chrome"), mm("veh_gauge")
    z_arm = C.get("arm", 0.62)

    def z_bottom(y):
        x = P.x(y, belt(y) - 0.10) - 0.06
        return max(P.z_down(x, y + dy, 0.78) for dy in (-0.08, -0.04, 0.0, 0.04, 0.08)) + 0.03

    for k, (ya, yb, kind) in enumerate(panels):
        ya = front - 0.004 if ya is None else min(ya, front - 0.004)
        yb = back + 0.004 if yb is None else max(yb, back + 0.004)
        ya -= 0.0035 if k > 0 else 0.0
        yb += 0.0035 if k < len(panels) - 1 else 0.0
        if ya - yb < 0.05:
            continue
        door = kind in ("front", "rear") and not ply
        a0, a1 = (ya - 0.28, yb + 0.07) if kind == "front" else (ya - 0.07, yb + 0.30)
        has_arm = door and a0 - a1 > 0.15
        ys = [ya, a0 + 0.04, a0, a1, a1 - 0.04, yb] if has_arm else [ya, yb]
        stations = []
        for y0, y1 in zip(ys[:-1], ys[1:]):
            near = any(y1 <= z1 and y0 >= z0 for z0, z1 in zones)
            n = max(1, int(math.ceil((y0 - y1) / (0.14 if near else 0.3))))
            stations += [y0 + (y1 - y0) * q / n for q in range(n)]
        stations.append(ys[-1])
        profs = []
        for y in stations:
            arm = (a1 - 1e-6 <= y <= a0 + 1e-6) if door and has_arm else (False if door else None)
            b = belt(y) if not ply else min(belt(y), 0.84 + 0.006)
            prof = _trim_profile(b, z_arm, z_bottom(y), arm)
            if ply:
                prof = [(min(i, 0.028), z) for i, z in prof]
            profs.append([(P.x(y, z) - i, y, z) for i, z in prof])
        mis = ([SILL, SILL, CARD, ARM, ARM, CARD, CARD, CARD, CARD] if door else
               [SILL, SILL, CARD, CARD, CARD, CARD])
        for s in (1.0, -1.0):
            _loft(bm, [[Vector((s * x, y, z)) for x, y, z in prof] for prof in profs], mis, cap_mi=CARD)
        if not door:
            continue
        # inner handle in its recess near the front of the door, a speaker low down on front doors
        yh, zh = ya - 0.13, belt(ya - 0.13) - 0.075
        xf = P.x(yh, zh) - 0.064
        zsp = (z_arm - 0.04 + z_bottom(ya - 0.2) + 0.125) / 2
        xs = P.x(ya - 0.2, zsp) - 0.08
        for s in (1.0, -1.0):
            _bar(bm, (s * (xf - 0.002), yh - 0.055, zh), (s * (xf - 0.002), yh + 0.055, zh), 0.008, 0.030, DARK)
            _bar(bm, (s * (xf - 0.0065), yh - 0.045, zh + 0.002), (s * (xf - 0.0065), yh + 0.03, zh + 0.002),
                 0.006, 0.011, CHROME)
            if kind == "front" and (z_arm - 0.04) - (zsp - 0.06) > 0.06:
                _disc(bm, (s * (xs - 0.003), ya - 0.2, zsp), (-s, 0.0, 0.0), 0.055, mm("veh_shut"), segs=10)


def _carpet(bm, P, S, W, y_front, y_back, mi, z_off=0.022):
    """Floor covering from y_front to y_back following the floor, stepping in past the wheel arches."""
    ra = W["Ro"] + S["arch"] + 0.045
    zones = [(ya - ra, ya + ra) for ya in (S["yf"], S["yr"])]
    ys = {y_front, y_back}
    n = max(1, int(math.ceil((y_front - y_back) / 0.28)))
    ys |= {y_back + (y_front - y_back) * q / n for q in range(n + 1)}
    for z0, z1 in zones:
        ys |= {y for y in (z1, z1 + 0.012, z0, z0 - 0.012) if y_back < y < y_front}
    zone = lambda y: any(z0 - 1e-6 <= y <= z1 + 1e-6 for z0, z1 in zones)
    rows = []
    for y in sorted(ys, reverse=True):
        xe = P.x(y, P.z_down(0.3, y, 0.7) + 0.05) - 0.03
        if zone(y):
            xe = min(xe, _ARCH_X - 0.015)
        rows.append([bm.verts.new((xe * f, y, P.z_down(xe * f, y, 0.7) + z_off))
                     for f in (-1.0, -0.78, -0.2, 0.0, 0.2, 0.78, 1.0)])
    for a, b in zip(rows[:-1], rows[1:]):
        for k in range(6):
            f = _face(bm, (a[k], a[k + 1], b[k + 1], b[k]), mi)
            f.normal_update()
            if f.normal.z < 0:
                f.normal_flip()


def _seat(bm, x, yf, yb, zt, w, h, rec, FAB, INS, BASE, CHR, floor_z, headrest=True):
    """A front seat facing +y: pedestal, bolstered cushion, reclined backrest, headrest on two posts."""
    zb = zt - 0.13
    z0, z1 = floor_z + 0.008, zb + 0.02
    _bar(bm, (x, yf - 0.08, (z0 + z1) / 2), (x, yb + 0.06, (z0 + z1) / 2), w * 1.2, z1 - z0, BASE)

    def sec(z, k):
        ww = w * k
        return [(-ww, zb), (-ww, z - 0.035), (-0.86 * ww, z + 0.014), (-0.64 * ww, z - 0.006), (0.64 * ww, z - 0.006),
                (0.86 * ww, z + 0.014), (ww, z - 0.035), (ww, zb)]

    rings = [[Vector((x + u, y, z)) for u, z in sec(zt + dz, k)]
             for y, dz, k in ((yf, -0.04, 0.96), (yf - 0.055, 0.0, 1.0), (yb + 0.05, -0.012, 1.0), (yb, -0.03, 0.97))]
    _loft(bm, rings, [FAB, FAB, FAB, INS, FAB, FAB, FAB, BASE], cap_mi=FAB)
    r = math.radians(rec)
    up, fwd, X = Vector((0.0, -math.sin(r), math.cos(r))), Vector((0.0, math.cos(r), math.sin(r))), Vector((1.0, 0.0, 0.0))
    B = Vector((x, yb + 0.035, zb + 0.03))
    rings = []
    for v, k, lum, bol, T in ((0.0, 1.0, 0.0, 0.045, 0.11), (0.30 * h, 1.0, 0.018, 0.045, 0.10),
                              (h - 0.06, 0.96, 0.0, 0.040, 0.085), (h, 0.84, -0.012, 0.022, 0.06)):
        ww = w * k
        rings.append([B + X * u + fwd * t + up * v for u, t in
                      ((-ww, -T), (-ww, 0.012), (-0.85 * ww, bol), (-0.62 * ww, lum), (0.62 * ww, lum),
                       (0.85 * ww, bol), (ww, 0.012), (ww, -T))])
    _loft(bm, rings, [FAB, FAB, FAB, INS, FAB, FAB, FAB, FAB], cap_mi=FAB)
    if headrest:
        _headrest(bm, B + up * (h + 0.095) - fwd * 0.02, up, fwd, 0.125, FAB, CHR, B + up * (h - 0.03))


def _headrest(bm, c, up, fwd, hw, FAB, CHR, post_foot):
    X = Vector((1.0, 0.0, 0.0))
    ell = [(0.047 * math.cos(q), 0.088 * math.sin(q)) for q in (math.radians(60 * i) for i in range(6))]
    rings = [[c + X * xo + fwd * (a * k) + up * (b * k) for a, b in ell]
             for xo, k in ((-hw, 0.84), (-hw + 0.03, 1.0), (hw - 0.03, 1.0), (hw, 0.84))]
    _loft(bm, rings, FAB)
    for s in (-1.0, 1.0):
        foot = post_foot + X * (s * 0.075)
        top = Vector((foot.x, c.y, c.z)) - up * 0.04
        _tube(bm, [foot, top], 0.0065, CHR, segs=3)


def _bench(bm, yf, yb, zt, W_, h, rec, n_head, FAB, INS, BASE, CHR, floor_z, S, W):
    """Rear bench across the car: base, cushion with two seat dips, backrest, headrests; kept off the arches."""
    zb = zt - 0.13
    start = len(bm.verts)
    zone_front = S["yr"] + W["Ro"] + S["arch"] + 0.05      # where the rear wheel arch begins (going back)
    z0, z1 = floor_z + 0.008, zb + 0.02
    zm = (z0 + z1) / 2
    xi = _ARCH_X - 0.035
    _bar(bm, (0.0, yf - 0.07, zm), (0.0, yb + 0.02, zm), 2 * xi, z1 - z0, BASE)
    if W_ - 0.05 > xi + 0.03 and yf - 0.07 > zone_front + 0.03:
        for s in (-1.0, 1.0):
            xm = s * (xi + W_ - 0.05) / 2
            _bar(bm, (xm, yf - 0.07, zm), (xm, max(yb + 0.02, zone_front), zm), W_ - 0.05 - xi, z1 - z0, BASE)

    def sec(z, k):
        ww = W_ * k
        return [(-ww, zb), (-ww, z - 0.035), (-0.93 * ww, z + 0.008), (-0.5 * ww, z - 0.012), (0.0, z + 0.002),
                (0.5 * ww, z - 0.012), (0.93 * ww, z + 0.008), (ww, z - 0.035), (ww, zb)]

    rings = [[Vector((u, y, z)) for u, z in sec(zt + dz, k)]
             for y, dz, k in ((yf, -0.04, 0.98), (yf - 0.055, 0.0, 1.0), (yb + 0.05, -0.012, 1.0), (yb, -0.03, 0.99))]
    _loft(bm, rings, [FAB, FAB, INS, INS, INS, INS, FAB, FAB, BASE], cap_mi=FAB)
    r = math.radians(rec)
    up, fwd, X = Vector((0.0, -math.sin(r), math.cos(r))), Vector((0.0, math.cos(r), math.sin(r))), Vector((1.0, 0.0, 0.0))
    B = Vector((0.0, yb + 0.035, zb + 0.03))
    rings = []
    for v, k, lum, T in ((0.0, 1.0, 0.0, 0.11), (0.35 * h, 1.0, 0.016, 0.10), (h - 0.05, 0.98, 0.0, 0.09),
                         (h, 0.95, -0.01, 0.06)):
        ww = W_ * k
        rings.append([B + X * u + fwd * t + up * v for u, t in
                      ((-ww, -T), (-ww, 0.01), (-0.93 * ww, 0.03), (-0.5 * ww, lum), (0.0, 0.012), (0.5 * ww, lum),
                       (0.93 * ww, 0.03), (ww, 0.01), (ww, -T))])
    _loft(bm, rings, [FAB, FAB, INS, INS, INS, INS, FAB, FAB, FAB], cap_mi=FAB)
    bm.verts.ensure_lookup_table()
    _lift_off_arches(bm.verts[start:], S, W)
    xs = [-0.55 * W_, 0.55 * W_] if n_head == 2 else [-0.62 * W_, 0.0, 0.62 * W_]
    for xh in xs:
        c = B + X * xh + up * (h + 0.085) - fwd * 0.015
        _headrest(bm, c, up, fwd, 0.105 if xh else 0.085, FAB, CHR, B + X * xh + up * (h - 0.03))
    return B + up * h - fwd * 0.06            # top back edge (where the parcel shelf starts)


def _wheel(bm, hub, tilt, mm):
    """Steering wheel (rim, three spokes, hub) on its column running down into the dashboard."""
    t = math.radians(tilt)
    a = Vector((0.0, -math.cos(t), math.sin(t)))           # towards the driver
    u = Vector((0.0, math.sin(t), math.cos(t)))            # up in the wheel's plane
    v = a.cross(u)
    RIM, DARK, COL = mm("veh_leather"), mm("veh_dash"), mm("veh_gauge")
    R, r, n, m = 0.185, 0.0155, 12, 4
    grid = []
    for i in range(n):
        q = 2 * math.pi * i / n
        rad = u * math.cos(q) + v * math.sin(q)
        grid.append([bm.verts.new(hub + rad * R + (rad * math.cos(p) + a * math.sin(p)) * r)
                     for p in (2 * math.pi * j / m for j in range(m))])
    for i in range(n):
        for j in range(m):
            f = _face(bm, (grid[i][j], grid[(i + 1) % n][j], grid[(i + 1) % n][(j + 1) % m], grid[i][(j + 1) % m]), RIM)
            f.normal_update()
            q = 2 * math.pi * (i + 0.5) / n
            if f.normal.dot(f.calc_center_median() - (hub + (u * math.cos(q) + v * math.sin(q)) * R)) < 0:
                f.normal_flip()
    for q in (math.pi / 2, math.pi, 3 * math.pi / 2):
        d = u * math.cos(q) + v * math.sin(q)
        _bar(bm, hub + d * 0.035 - a * 0.012, hub + d * (R - 0.008) - a * 0.004, 0.042 if q == math.pi else 0.034,
             0.012, DARK, up=a)
    oct_ = [(0.058 * math.cos(math.radians(22.5 + 45 * i)), 0.052 * math.sin(math.radians(22.5 + 45 * i)))
            for i in range(8)]
    xf = Matrix.Translation(hub) @ Matrix((v, u, a)).transposed().to_4x4()
    _prism(bm, oct_, -0.028, 0.012, DARK, xf)
    _tube(bm, [hub - a * 0.02, hub - a * 0.30], 0.021, COL, segs=8)
    sh = hub - a * 0.17 - u * 0.012
    _bar(bm, sh - a * 0.07, sh + a * 0.07, 0.10, 0.075, DARK, up=u)


def _dash(bm, P, S, C, mm, x_drv):
    """Dashboard across the car, instrument hood and dials in front of the driver, centre stack with vents,
    radio and knobs, glovebox.  Returns z of the dash top at (x, y) (for things lying on it)."""
    y_tr, z_top, y_kn, z_kn = C["dash"]
    yf = C["front"] - 0.004
    ym = (yf + y_tr) / 2 + 0.03
    floor_z = P.z_down(0.0, y_kn, 0.7)
    DASH, TOP, GAUGE, DIAL = mm("veh_dash"), mm("veh_dash"), mm("veh_gauge"), mm("veh_dial")

    def prof(x):
        zw = lambda y: P.z_up(x, y, z_top - 0.25)
        return [(yf, min(z_top + 0.03, zw(yf) - 0.012)), (ym, min(z_top + 0.012, zw(ym) - 0.025)),
                (y_tr + 0.035, z_top), (y_tr, z_top - 0.03), (y_tr + 0.022, z_top - 0.10), (y_kn, z_kn + 0.03),
                (y_kn + 0.035, z_kn - 0.045), (yf, z_kn - 0.06)]

    rings = []
    for xs in (-1.0, -0.5, 0.0, 0.5, 1.0):
        pr = prof(xs if abs(xs) < 0.9 else math.copysign(0.6, xs))
        if abs(xs) > 0.9:
            rings.append([Vector((math.copysign(P.x(y, z) - 0.012, xs), y, z)) for y, z in pr])
        else:
            rings.append([Vector((xs, y, z)) for y, z in pr])
    _loft(bm, rings, [TOP, TOP, TOP, DASH, DASH, DASH, DASH, DASH], cap_mi=DASH)
    top_pts = {xs: prof(xs)[:3] for xs in (-0.5, 0.0, 0.5)}

    def top_z(x, y):
        def along(pr):
            for (y0, z0), (y1, z1) in zip(pr[:-1], pr[1:]):
                if y1 <= y <= y0:
                    return z0 + (z1 - z0) * (y - y0) / (y1 - y0)
            return pr[-1][1]

        ks = sorted(top_pts)
        x = max(ks[0], min(ks[-1], x))
        for xa, xb in zip(ks[:-1], ks[1:]):
            if xa <= x <= xb:
                t = (x - xa) / (xb - xa)
                return along(top_pts[xa]) * (1 - t) + along(top_pts[xb]) * t
        return along(top_pts[ks[0]])

    # demister vent along the foot of the windscreen, speaker grilles in the corners of the dash top
    yv = yf - 0.045
    for x0, x1 in ((-0.42, -0.04), (0.04, 0.42)):
        a, b = Vector((x0, yv, top_z(x0, yv))), Vector((x1, yv, top_z(x1, yv)))
        tn = Vector((0.0, -(top_z(0.0, yv + 0.02) - top_z(0.0, yv - 0.02)), 0.04)).normalized()
        _bar(bm, a + tn * 0.0008, b + tn * 0.0008, 0.016, 0.0016, GAUGE, up=tn)
    for s in (-1.0, 1.0):
        yg = yf - 0.10
        c = Vector((s * 0.58, yg, top_z(s * 0.58, yg)))
        tn = Vector((0.0, -(top_z(s * 0.58, yg + 0.02) - top_z(s * 0.58, yg - 0.02)), 0.04)).normalized()
        _disc(bm, c + tn * 0.0012, tn, 0.042, GAUGE, segs=10)
    # instrument hood over a dark panel with two dials
    xd = x_drv
    sec = lambda k: [(y_tr + 0.20, z_top + 0.003), (y_tr + 0.13, z_top + 0.062 * k), (y_tr + 0.012, z_top + 0.066 * k),
                     (y_tr - 0.004, z_top + 0.050 * k), (y_tr + 0.07, z_top + 0.040 * k)]
    _loft(bm, [[Vector((xd + xo, y, z)) for y, z in sec(k)] for xo, k in
               ((-0.175, 0.3), (-0.145, 1.0), (0.145, 1.0), (0.175, 0.3))], DASH)
    p0, p1 = Vector((0.0, y_tr + 0.014, z_top + 0.004)), Vector((0.0, y_tr + 0.072, z_top + 0.036))
    pn = Vector((0.0, -(p1 - p0).z, (p1 - p0).y)).normalized()
    pc = (p0 + p1) / 2
    _bar(bm, Vector((xd - 0.14, pc.y, pc.z)) - pn * 0.002, Vector((xd + 0.14, pc.y, pc.z)) - pn * 0.002, 0.006,
         (p1 - p0).length, GAUGE, up=(p1 - p0))
    for xo in (-0.065, 0.065):
        c = Vector((xd + xo, pc.y, pc.z)) + pn * 0.0015
        _disc(bm, c, pn, 0.032, DIAL, segs=12)
        _disc(bm, c + pn * 0.0012, pn, 0.027, GAUGE, segs=12)
        tip = c + pn * 0.0024 + Vector((0.016, 0.0, 0.0)) + (p1 - p0).normalized() * 0.012
        nf = _face(bm, (bm.verts.new(c + pn * 0.0024 - Vector((0.002, 0.0, 0.0))),
                        bm.verts.new(c + pn * 0.0024 + Vector((0.002, 0.0, 0.0))), bm.verts.new(tip)), mm("veh_amber"))
        nf.normal_update()
        if nf.normal.dot(pn) < 0:
            nf.normal_flip()
    # centre stack: vents, radio, climate knobs on its sloping face
    A, B = Vector((0.0, y_tr + 0.03, z_top - 0.05)), Vector((0.0, y_tr + 0.10, floor_z + 0.16))
    _loft(bm, [[Vector((xo, y, z)) for y, z in ((A.y, A.z), (B.y, B.z), (y_tr + 0.26, floor_z + 0.16),
                                                 (y_tr + 0.22, z_top - 0.05))] for xo in (-0.11, 0.11)], DASH)
    T = (B - A).normalized()
    nf = Vector((0.0, -T.z, T.y))
    if nf.y > 0:
        nf.negate()
    at = lambda xo, t: Vector((xo, 0.0, 0.0)) + A + (B - A) * t
    for xo in (-0.05, 0.05):
        c = at(xo, 0.09)
        _bar(bm, c - Vector((0.035, 0, 0)) + nf * 0.001, c + Vector((0.035, 0, 0)) + nf * 0.001, 0.006, 0.04, GAUGE, up=T)
    c = at(0.0, 0.30)
    _bar(bm, c - Vector((0.085, 0, 0)) + nf * 0.002, c + Vector((0.085, 0, 0)) + nf * 0.002, 0.008, 0.05, GAUGE, up=T)
    for xo in (-0.06, 0.0, 0.06):
        c = at(xo, 0.52)
        _tube(bm, [c - nf * 0.003, c + nf * 0.016], 0.014, DASH if xo else GAUGE, segs=6)
    # round side vents at the ends of the dash face, glovebox lid on the passenger side
    xv = min(0.66, P.x(y_tr, z_top - 0.06) - 0.10)
    for s in (-1.0, 1.0):
        c = Vector((s * xv, y_tr + 0.012, z_top - 0.062))
        _disc(bm, c + Vector((0.0, -0.004, 0.0)), (0.0, -1.0, -0.25), 0.036, GAUGE, segs=10)
    g0, g1 = Vector((0.0, y_tr + 0.022, z_top - 0.10)), Vector((0.0, y_kn, z_kn + 0.03))
    gT = (g1 - g0).normalized()
    gn = Vector((0.0, -gT.z, gT.y))
    if gn.y > 0:
        gn.negate()
    gc = g0 + (g1 - g0) * 0.45
    xg = -x_drv
    _bar(bm, Vector((xg - 0.17, gc.y, gc.z)) + gn * 0.003, Vector((xg + 0.17, gc.y, gc.z)) + gn * 0.003, 0.008,
         (g1 - g0).length * 0.62, DASH, up=gT)
    _bar(bm, Vector((xg - 0.04, gc.y, gc.z)) + gn * 0.0075 - gT * 0.03, Vector((xg + 0.04, gc.y, gc.z)) + gn * 0.0075
         - gT * 0.03, 0.004, 0.012, GAUGE, up=gT)
    return top_z


def _cabin(name, style, S, W, P, coll, seed):
    """The cabin object (see the notes above CABIN)."""
    C = CABIN[style]
    rows = S["rows"]
    belt = lambda y: _interp(rows, y, 2)
    rng = random.Random(seed * 7919 + 17)
    scheme = rng.choice(["dark", "dark", "grey", "beige", "blue"])
    mm = Mats("veh_headliner")
    FAB, INS = mm(f"veh_seat_{scheme}"), mm(f"veh_seat_{scheme}_in")
    CARPET, DASH, PILLAR, HEAD, SEAL = mm("veh_carpet"), mm("veh_dash"), mm("veh_pillar"), mm("veh_headliner"), mm("veh_seal")
    CHR, CARD, PLY = mm("chrome"), mm("veh_doorcard"), mm("veh_ply")
    x_drv = C["seat"][0]
    front, back = C["front"], C["back"]
    bm = bmesh.new()

    def lining(y0, y1, zc, capf, capr, **kw):
        lb = _lining(P, S, W, y0, y1, zc, **kw)
        for f in lb.faces:
            mk = f.material_index
            if mk == _MK_LIN:
                c, n = f.calc_center_median(), f.normal
                f.material_index = (PLY if capf == PLY else
                                    HEAD if n.z < -0.55 and c.z > belt(c.y) + 0.2 else
                                    CARD if c.z < belt(c.y) + 0.005 else PILLAR)
            elif mk == _MK_CAPF:
                f.material_index = capf
            elif mk == _MK_CAPR:
                f.material_index = capr
            else:
                f.material_index = SEAL
        _merge(bm, lb)

    zc = lambda y: belt(y) - 0.07
    if style == "van":
        lining(back, front, zc, DASH, PILLAR, rear=False)
        y_l0, y_l1 = C["load"]
        lining(y_l1, y_l0, lambda y: 0.80, PLY, PLY, panes=False, ws=False)
    else:
        lining(back, front, zc, DASH, PILLAR if S["rs"][2] != "slope" else CARPET)
    # door cards and side panels, carpet, tunnel and console
    _trims(bm, P, S, W, C, mm, f"veh_seat_{scheme}_in", C["panels"], front, back)
    _carpet(bm, P, S, W, front - 0.006, back + 0.006, CARPET)
    sx, syf, syb, szt, sw, sh, srec = C["seat"]
    y_t1 = (C["bench"][0] + 0.06) if "bench" in C else back + 0.02

    def flo(x0, x1, y0, y1):
        """Highest floor point under a footprint (the floor pan is not flat: it has a low ridge)."""
        nx, ny = max(1, int(math.ceil((x1 - x0) / 0.05))), max(1, int(math.ceil(abs(y1 - y0) / 0.05)))
        return max(P.z_down(x0 + (x1 - x0) * i / nx, y0 + (y1 - y0) * j / ny, 0.7)
                   for i in range(nx + 1) for j in range(ny + 1))

    ty = [front - 0.01, (front + y_t1) / 2, y_t1]
    tz = [flo(-0.15, 0.15, y - 0.12, y + 0.12) + 0.004 for y in ty]
    _loft(bm, [[Vector((u, y, z0 + z)) for u, z in ((-0.15, 0.0), (-0.12, 0.75 * hh), (-0.055, hh), (0.055, hh),
                                                  (0.12, 0.75 * hh), (0.15, 0.0))]
               for y, z0, hh in zip(ty, tz, (0.14, 0.10, 0.06))], CARPET)
    y_tr, z_top = C["dash"][0], C["dash"][1]
    c0, c1 = y_tr + 0.12, syb + 0.12
    cz0 = flo(-0.085, 0.085, c1, c0) + 0.02                 # console: standing in the tunnel
    cz1 = cz0 + 0.185
    cons = [(-0.085, cz0), (-0.085, cz1 - 0.02), (-0.065, cz1), (0.065, cz1), (0.085, cz1 - 0.02), (0.085, cz0)]
    _loft(bm, [[Vector((u, y, z)) for u, z in cons] for y in (c0, c0 - 0.015, c1 + 0.015, c1)], DASH)
    g = Vector((0.0, c0 - 0.10, cz1))
    _tube(bm, [g - Vector((0, 0, 0.004)), g + Vector((0, -0.006, 0.05))], [0.042, 0.016], mm("veh_vinyl"), segs=6)
    _tube(bm, [g + Vector((0, -0.006, 0.045)), g + Vector((0, -0.02, 0.13))], 0.0065, CHR, segs=4)
    _tube(bm, [g + Vector((0, -0.018, 0.12)), g + Vector((0, -0.022, 0.145)), g + Vector((0, -0.026, 0.165))],
          [0.016, 0.021, 0.016], mm("veh_leather"), segs=6)
    hb = Vector((0.0, c1 + 0.12, cz1 - 0.004))
    _bar(bm, hb, hb + Vector((0.0, -0.20, 0.06)), 0.032, 0.026, DASH)
    # dashboard, steering wheel, mirror
    top_z = _dash(bm, P, S, C, mm, x_drv)
    wy, wz, wt = C["wheel"]
    _wheel(bm, Vector((x_drv, wy, wz)), wt, mm)
    wt_y = S["ws"][1]
    ym = wt_y + 0.055
    zg = P.z_up(0.0, ym, belt(ym) + 0.1)
    mc = Vector((0.0, ym - 0.035, zg - 0.085))
    _tube(bm, [Vector((0.0, ym - 0.004, zg - 0.002)), mc + Vector((0.0, 0.004, 0.03))], [0.011, 0.007], DASH, segs=6)
    ell = [(0.022 * math.cos(q), 0.036 * math.sin(q)) for q in (math.radians(60 * i) for i in range(6))]
    _loft(bm, [[mc + Vector((xo, a * k, b * k)) for a, b in ell] for xo, k in
               ((-0.12, 0.75), (-0.10, 1.0), (0.10, 1.0), (0.12, 0.75))], DASH)
    _bar(bm, mc + Vector((-0.095, -0.0205, 0.0)), mc + Vector((0.095, -0.0205, 0.0)), 0.003, 0.05, mm("veh_mirror"))
    # seats and belts
    fz = lambda y: P.z_down(0.0, y, 0.7)
    for s in (1.0, -1.0):
        under = flo(s * sx - 0.62 * sw, s * sx + 0.62 * sw, syb + 0.06, syf - 0.08)
        _seat(bm, s * sx, syf, syb, szt, sw, sh, srec, FAB, INS, CARPET if style != "van" else DASH, CHR, under)
        yB = C["pillar"] - 0.03
        zb_ = belt(yB) + 0.30
        top = Vector((s * (P.x(yB, zb_) - 0.032), yB, zb_))
        bot = Vector((s * (sx + sw + 0.03), syb + 0.06, szt - 0.03))
        _bar(bm, top, bot, 0.045, 0.004, mm("veh_belt"), up=(1.0, 0.0, 0.0))
        _rbox(bm, top + Vector((0.0, 0.0, 0.01)), (0.012, 0.028, 0.022), 0.008, PILLAR, ticks=-1)
    bench_top = None
    if "bench" in C:
        byf, byb, bzt, bW, bh, brec, nh = C["bench"]
        under = flo(-0.38, 0.38, byb + 0.02, byf - 0.07)
        bench_top = _bench(bm, byf, byb, bzt, bW, bh, brec, nh, FAB, INS, CARPET, CHR, under, S, W)
        # parcel shelf from the top of the bench back to the back panel
        zs = C["shelf"]
        y0, y1 = bench_top.y - 0.01, back + 0.006
        rings = []
        for y in (y0, (y0 + y1) / 2, y1):
            xe = P.x(y, zs) - 0.05
            rings.append([Vector((u, y, z)) for u, z in ((-xe, zs - 0.012), (-xe, zs), (xe, zs), (xe, zs - 0.012))])
        _loft(bm, rings, CARPET)
        if S["rs"][2] == "slope":
            for s in (-1.0, 1.0):
                _disc(bm, (s * 0.42, (y0 + y1) / 2, zs + 0.0015), (0.0, 0.0, 1.0), 0.07, mm("veh_gauge"), segs=10)
    else:
        # van: plywood load bay behind the bulkhead, wheel-arch boxes, things being carried
        y_l0, y_l1 = C["load"]
        _trims(bm, P, S, W, C, mm, "veh_ply", [(y_l0, y_l1, "plain")], y_l0, y_l1, ply=True)
        _carpet(bm, P, S, W, y_l0 - 0.006, y_l1 + 0.006, PLY, z_off=0.012)
        ra = W["Ro"] + S["arch"]
        zcw = W["Ro"] - FLAT + 0.006
        ya = S["yr"]
        zt_ = zcw + ra + 0.05
        for s in (-1.0, 1.0):
            rr = []
            for y in (ya + ra + 0.035, ya - ra - 0.035):
                xo = P.x(y, zt_) - 0.03
                fl = P.z_down(_ARCH_X - 0.03, y, 0.7) + 0.012
                rr.append([Vector((s * x, y, z)) for x, z in ((xo, zt_), (_ARCH_X - 0.01, zt_), (_ARCH_X - 0.025, zt_ - 0.015),
                                                             (_ARCH_X - 0.025, fl))])
            _loft(bm, rr, PLY, closed=False)
        # boxes being carried, in front of the wheel arches
        y_free = ya + ra + 0.08
        for k in range(rng.randint(1, 3)):
            hx, hy, hz = rng.uniform(0.14, 0.24), rng.uniform(0.12, 0.22), rng.uniform(0.08, 0.17)
            yb_ = rng.uniform(y_free + 0.25, y_l0 - 0.3)
            xb_ = rng.uniform(-0.25, 0.25)
            _box(bm, (xb_, yb_, fz(yb_) + 0.012 + hz), (hx, hy, hz), rng.uniform(-0.4, 0.4), mm("veh_cardboard"))
    # a few things left in the car
    props = rng.sample(["disc", "tree", "cushion", "box", "tissues", "bottle"], k=rng.randint(1, 3))
    if "disc" in props:
        yd = (C["front"] + y_tr) / 2 + 0.03
        p0, p1 = Vector((-x_drv, yd + 0.06, top_z(-x_drv, yd + 0.06))), Vector((-x_drv, yd - 0.06, top_z(-x_drv, yd - 0.06)))
        n = Vector((0.0, -(p1 - p0).z, (p1 - p0).y)).normalized()
        if n.z < 0:
            n.negate()
        c = (p0 + p1) / 2 + n * 0.0018
        _bar(bm, c - Vector((0.075, 0, 0)), c + Vector((0.075, 0, 0)), 0.115, 0.003, mm("veh_disc_blue"), up=n)
        _disc(bm, c + n * 0.0018, n, 0.034, mm("veh_plate_white"), segs=12)
    if "tree" in props:
        hang = mc + Vector((0.0, 0.0, -0.034))
        _tube(bm, [hang, hang + Vector((0.0, 0.0, -0.07))], 0.0012, mm("veh_belt"), segs=3)
        tree = [(0.0, 0.0), (0.028, -0.04), (0.012, -0.04), (0.03, -0.075), (-0.03, -0.075), (-0.012, -0.04), (-0.028, -0.04)]
        xf = Matrix.Translation(hang + Vector((0.0, 0.0, -0.07))) @ Matrix.Rotation(math.pi / 2, 4, "X")
        _prism(bm, tree, -0.001, 0.001, mm("veh_tree"), xf)
    if "bottle" in props:
        y_b = (syf + syb) / 2
        z_b = szt + 0.024
        _tube(bm, [Vector((-sx - 0.11, y_b - 0.02, z_b)), Vector((-sx + 0.07, y_b + 0.01, z_b)),
                   Vector((-sx + 0.10, y_b + 0.015, z_b + 0.002)), Vector((-sx + 0.13, y_b + 0.02, z_b + 0.002))],
              [0.031, 0.031, 0.014, 0.014], mm("plastic_blue"), segs=8)
    if "bench" in C:
        byf, byb, bzt, bW = C["bench"][:4]
        if "cushion" in props:
            # leaning on the backrest, its foot on the seat
            xs_ = rng.choice([-0.5, 0.5]) * min(bW, 0.6)
            rr = math.radians(C["bench"][5] + 6)
            rot = Matrix.Rotation(rr, 4, "X") @ Matrix.Rotation(rng.uniform(-0.25, 0.25), 4, "Y")
            zc_ = bzt + 0.13
            yc_ = byb + 0.035 - (zc_ - (bzt - 0.10)) * math.tan(math.radians(C["bench"][5])) + 0.075
            c_ = Vector((xs_, yc_, zc_))
            ell = [(0.05 * math.cos(q), 0.13 * math.sin(q)) for q in (math.radians(22.5 + 45 * i) for i in range(8))]
            rot3 = rot.to_3x3()
            _loft(bm, [[c_ + rot3 @ Vector((xo, a * k, b * k)) for a, b in ell] for xo, k in
                       ((-0.16, 0.6), (-0.12, 1.0), (0.12, 1.0), (0.16, 0.6))],
                  mm(rng.choice(["veh_cushion_red", "veh_cushion_ochre"])))
        if "box" in props:
            xs_ = rng.choice([-0.45, 0.45]) * min(bW, 0.6)
            _box(bm, (xs_, (byf + byb) / 2 + 0.02, bzt + 0.078), (0.15, 0.12, 0.09), rng.uniform(-0.5, 0.5),
                 mm("veh_cardboard"))
        if "tissues" in props and bench_top is not None:
            zs = C["shelf"]
            _box(bm, (rng.uniform(-0.4, 0.4), (bench_top.y + back) / 2, zs + 0.045), (0.12, 0.06, 0.045),
                 rng.uniform(-0.3, 0.3), mm("veh_plate_white"))
    return _finish(bm, name, mm, coll, angle=40.0)


def build_car(name: str, style: str, paint: str, coll=None, seed: int = 0) -> list[bpy.types.Object]:
    """A parked car (hatch | sedan | van | micro) centred on the origin, front towards +Y."""
    S, W = STYLES[style], WHEELS[STYLES[style]["wheel"]]
    rng = random.Random(seed)
    body, shell = _build_body(f"{name}_body", S, W, paint, coll)
    parts = [body, _details(f"{name}_details", S, W, paint, shell.bvh, coll), _underbody(f"{name}_under", S, W, coll)]
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
    # the cabin behind the glass: a separate object that needs little light-map space
    cabin = _cabin(f"{name}_cabin", style, S, W, shell, coll, seed)
    geo.tag(cabin, role="vehicle", collide="none", lm=0.3)
    return parts + [cabin] + _colliders(name, S, W, coll)


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
    for axle in (RA, FA):
        _bar(cb, (0.0, axle.y - R, R), (0.0, axle.y + R, R), 0.07, 2 * R)
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
        hx = sum(p[0] for p in S["head"]) / 4
        close = [(CABIN[name]["seat"][2], yc - hw - 0.85, 0.0),                    # looking up at the side windows
                 (S["rows"][-1][0] + 0.70, yc - hx, -90.0),                         # a headlamp from 70 cm
                 (S["rows"][0][0] - 0.70, yc - 0.62, 90.0)]                         # a tail lamp from 70 cm
        return {"focus": (0.0, yc, 0.65), "radius": length * 0.62, "cat": _car_cats(S, W, 0.0, yc) + close}
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
