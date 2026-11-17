"""Mesh-building helpers. All sizes in metres."""
from __future__ import annotations

import math
from typing import Iterable, Sequence

import bmesh
import bpy
from mathutils import Vector
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon
from shapely.geometry.polygon import orient

UV0 = "uv0"  # material UVs, in metres
UV1 = "uv1"  # lightmap UVs


# ---------------------------------------------------------------- collections / objects

def collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(coll)
    return coll


def new_object(name: str, mesh: bpy.types.Mesh, coll: bpy.types.Collection | None = None) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, mesh)
    (coll or bpy.context.scene.collection).objects.link(obj)
    return obj


def bm_to_object(bm: bmesh.types.BMesh, name: str, mat=None, coll=None, smooth: bool = False) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    if smooth:
        for poly in mesh.polygons:
            poly.use_smooth = True
    obj = new_object(name, mesh, coll)
    if mat is not None:
        mesh.materials.append(mat)
    return obj


def select_only(objs: Iterable[bpy.types.Object]) -> None:
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    first = None
    for o in objs:
        o.select_set(True)
        first = first or o
    if first is not None:
        bpy.context.view_layer.objects.active = first


def join(objs: Sequence[bpy.types.Object], name: str) -> bpy.types.Object:
    objs = [o for o in objs if o is not None]
    if len(objs) == 1:
        objs[0].name = name
        return objs[0]
    select_only(objs)
    bpy.ops.object.join()
    out = bpy.context.view_layer.objects.active
    out.name = name
    return out


def apply_modifiers(obj: bpy.types.Object) -> None:
    select_only([obj])
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


# ---------------------------------------------------------------- UVs and shading

def uv_layer(mesh: bpy.types.Mesh, name: str):
    return mesh.uv_layers.get(name) or mesh.uv_layers.new(name=name)


def uv_box(obj: bpy.types.Object, scale: float = 1.0, layer: str = UV0) -> None:
    """World-space box projection: UVs come out in metres along the two axes each face spans."""
    mesh = obj.data
    uvl = uv_layer(mesh, layer)
    mw = obj.matrix_world
    nmat = mw.to_3x3().inverted_safe().transposed()
    for poly in mesh.polygons:
        n = (nmat @ poly.normal).normalized()
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for li in poly.loop_indices:
            p = mw @ mesh.vertices[mesh.loops[li].vertex_index].co
            if az >= ax and az >= ay:
                uv = (p.x, p.y)
            elif ax >= ay:
                uv = (p.y if n.x > 0 else -p.y, p.z)
            else:
                uv = (-p.x if n.y > 0 else p.x, p.z)
            uvl.data[li].uv = (uv[0] * scale, uv[1] * scale)


def shade_auto(obj: bpy.types.Object, angle_deg: float = 35.0) -> None:
    """Smooth shading with hard edges above the given angle (kept through glTF export)."""
    mesh = obj.data
    for poly in mesh.polygons:
        poly.use_smooth = True
    bm = bmesh.new()
    bm.from_mesh(mesh)
    limit = math.radians(angle_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < limit
        else:
            e.smooth = False
    bm.to_mesh(mesh)
    bm.free()


def bevel(obj: bpy.types.Object, width: float, segments: int = 2, angle_deg: float = 30.0) -> None:
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle_deg)
    mod.harden_normals = False
    apply_modifiers(obj)


# ---------------------------------------------------------------- primitives

def box(name: str, p0: Sequence[float], p1: Sequence[float], mat=None, coll=None,
        bevel_w: float = 0.0, uv_scale: float = 1.0) -> bpy.types.Object:
    """Axis-aligned box from corner p0 to corner p1."""
    x0, y0, z0 = (min(a, b) for a, b in zip(p0, p1))
    x1, y1, z1 = (max(a, b) for a, b in zip(p0, p1))
    bm = bmesh.new()
    v = [bm.verts.new(c) for c in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                                   (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    for idx in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([v[i] for i in idx])
    obj = bm_to_object(bm, name, mat, coll)
    if bevel_w > 0:
        bevel(obj, bevel_w)
        shade_auto(obj)
    uv_box(obj, uv_scale)
    return obj


def boxes(name: str, items: Sequence[tuple[Sequence[float], Sequence[float]]], mat=None, coll=None) -> bpy.types.Object:
    """Many axis-aligned boxes in one mesh (fences, railings, slats)."""
    bm = bmesh.new()
    for p0, p1 in items:
        x0, y0, z0 = (min(a, b) for a, b in zip(p0, p1))
        x1, y1, z1 = (max(a, b) for a, b in zip(p0, p1))
        v = [bm.verts.new(c) for c in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                                       (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
        for idx in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            bm.faces.new([v[i] for i in idx])
    obj = bm_to_object(bm, name, mat, coll)
    uv_box(obj)
    return obj


def oriented_box(name: str, a: Sequence[float], b: Sequence[float], width: float, z0: float, z1: float,
                 mat=None, coll=None) -> bpy.types.Object:
    """Box whose long axis runs from 2D point a to 2D point b (walls, rails at any angle)."""
    ax, ay = a[0], a[1]
    bx, by = b[0], b[1]
    length = math.hypot(bx - ax, by - ay)
    nx, ny = -(by - ay) / length * width / 2, (bx - ax) / length * width / 2
    ring = [(ax - nx, ay - ny), (bx - nx, by - ny), (bx + nx, by + ny), (ax + nx, ay + ny)]
    return extrude_polygon(name, Polygon(ring), z0, z1, mat, coll, cap_top=True, cap_bottom=True)


def cylinder(name: str, radius: float, p0: Sequence[float], p1: Sequence[float], mat=None, coll=None,
             segments: int = 20, caps: bool = True) -> bpy.types.Object:
    """Cylinder between two points (any direction)."""
    a, b = Vector(p0), Vector(p1)
    axis = b - a
    length = axis.length
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segments,
                          radius1=radius, radius2=radius, depth=length)
    obj = bm_to_object(bm, name, mat, coll, smooth=True)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = axis.to_track_quat("Z", "Y")
    obj.location = (a + b) / 2
    bpy.context.view_layer.update()
    select_only([obj])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    shade_auto(obj, 50)
    uv_box(obj)
    return obj


# ---------------------------------------------------------------- 2D layout -> meshes

def polygons_of(geom) -> list[Polygon]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def _rings(poly: Polygon) -> list[list[tuple[float, float]]]:
    poly = orient(poly, 1.0)
    return [list(poly.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in poly.interiors]


def flat_polygon(name: str, geom, z: float, mat=None, coll=None, simplify: float = 0.002) -> bpy.types.Object | None:
    """Horizontal filled area (holes allowed), facing up, with UVs in metres from world XY."""
    bm = bmesh.new()
    any_face = False
    for poly in polygons_of(geom):
        poly = poly.simplify(simplify)
        if poly.is_empty or poly.area < 1e-5:
            continue
        edges = []
        for ring in _rings(poly):
            vs = [bm.verts.new((x, y, z)) for x, y in ring]
            for i in range(len(vs)):
                edges.append(bm.edges.new((vs[i], vs[(i + 1) % len(vs)])))
        res = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
        any_face = any_face or bool(res["geom"])
    if not any_face:
        bm.free()
        return None
    bm.faces.ensure_lookup_table()
    for f in bm.faces:
        f.normal_update()
        if f.normal.z < 0:
            f.normal_flip()
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    obj = bm_to_object(bm, name, mat, coll)
    uv_box(obj)
    return obj


def extrude_polygon(name: str, geom, z0: float, z1: float, mat=None, coll=None, cap_top: bool = True,
                    cap_bottom: bool = False, bevel_w: float = 0.0, simplify: float = 0.002) -> bpy.types.Object | None:
    """Prism: the 2D area pushed up from z0 to z1 (walls plus optional caps)."""
    bm = bmesh.new()
    count = 0
    for poly in polygons_of(geom):
        poly = poly.simplify(simplify)
        if poly.is_empty or poly.area < 1e-6:
            continue
        count += 1
        rings = _rings(poly)
        for ri, ring in enumerate(rings):
            n = len(ring)
            lo = [bm.verts.new((x, y, z0)) for x, y in ring]
            hi = [bm.verts.new((x, y, z1)) for x, y in ring]
            for i in range(n):
                j = (i + 1) % n
                # exterior rings are counter-clockwise, holes clockwise: this order faces outwards for both
                bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
        for zc, up in ((z1, True), (z0, False)):
            if (up and not cap_top) or (not up and not cap_bottom):
                continue
            edges = []
            for ring in rings:
                vs = [bm.verts.new((x, y, zc)) for x, y in ring]
                for i in range(len(vs)):
                    edges.append(bm.edges.new((vs[i], vs[(i + 1) % len(vs)])))
            res = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
            for f in (g for g in res["geom"] if isinstance(g, bmesh.types.BMFace)):
                f.normal_update()
                if (f.normal.z < 0) == up:
                    f.normal_flip()
    if count == 0:
        bm.free()
        return None
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    obj = bm_to_object(bm, name, mat, coll)
    if bevel_w > 0:
        bevel(obj, bevel_w)
    shade_auto(obj)
    uv_box(obj)
    return obj


def lines_of(geom) -> list[LineString]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    out = []
    for g in getattr(geom, "geoms", []):
        out.extend(lines_of(g))
    return out


def shared_edge(area: Polygon, neighbour, tol: float = 0.01) -> list[LineString]:
    """Pieces of area's outline that touch `neighbour`, oriented so that `area` lies on the LEFT."""
    from shapely.ops import linemerge

    out = []
    for poly in polygons_of(area):
        poly = orient(poly, 1.0)  # counter-clockwise exterior => interior on the left
        rings = [poly.exterior] + list(poly.interiors)
        for ring in rings:
            part = ring.intersection(neighbour.buffer(tol))
            merged = linemerge(part) if part.geom_type == "MultiLineString" else part
            for ln in lines_of(merged):
                if ln.length < 0.05:
                    continue
                # keep the ring's own direction
                d0 = ring.project(Point(ln.coords[0]))
                d1 = ring.project(Point(ln.coords[min(1, len(ln.coords) - 1)]))
                if (d1 - d0) % ring.length > ring.length / 2:
                    ln = LineString(list(ln.coords)[::-1])
                out.append(ln)
    return out


def sweep(name: str, profile: Sequence[tuple[float, float]], path: Sequence[Sequence[float]], mat=None, coll=None,
          closed: bool = False, z: float = 0.0, cap_ends: bool = True, smooth_angle: float = 35.0) -> bpy.types.Object:
    """Push a 2D profile along a ground path.

    profile: closed loop of (right, up) offsets, counter-clockwise when looking along the path.
    path:    list of (x, y) or (x, y, z) points; `z` is added to every point.
    UVs: u = metres along the path, v = metres around the profile.
    """
    pts = [Vector((p[0], p[1], (p[2] if len(p) > 2 else 0.0) + z)) for p in path]
    if closed and (pts[0] - pts[-1]).length < 1e-6:
        pts.pop()
    n = len(pts)
    m = len(profile)
    bm = bmesh.new()
    rings = []
    dist = [0.0]
    for i in range(n):
        prev_pt = pts[i - 1] if (i > 0 or closed) else None
        next_pt = pts[(i + 1) % n] if (i < n - 1 or closed) else None
        d_in = (pts[i] - prev_pt).normalized() if prev_pt is not None else None
        d_out = (next_pt - pts[i]).normalized() if next_pt is not None else None
        d_in = d_in or d_out
        d_out = d_out or d_in
        tangent = Vector((d_in.x + d_out.x, d_in.y + d_out.y, 0.0))
        if tangent.length < 1e-6:
            tangent = Vector((d_out.x, d_out.y, 0.0))
        tangent.normalize()
        right = Vector((tangent.y, -tangent.x, 0.0))
        d_in2 = Vector((d_in.x, d_in.y, 0.0)).normalized()
        cos_half = max(0.35, tangent.dot(d_in2))
        mitre = 1.0 / cos_half
        rings.append([bm.verts.new(pts[i] + right * (r * mitre) + Vector((0, 0, up))) for r, up in profile])
        if i > 0:
            dist.append(dist[-1] + (pts[i] - pts[i - 1]).length)
    if closed:
        dist.append(dist[-1] + (pts[0] - pts[-1]).length)
    plen = [0.0]
    for k in range(m):
        a, b = profile[k], profile[(k + 1) % m]
        plen.append(plen[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    uvl = bm.loops.layers.uv.new(UV0)
    segs = n if closed else n - 1
    for i in range(segs):
        j = (i + 1) % n
        for k in range(m):
            k2 = (k + 1) % m
            f = bm.faces.new((rings[i][k], rings[j][k], rings[j][k2], rings[i][k2]))
            u0, u1 = dist[i], dist[i + 1]
            for loop, uv in zip(f.loops, ((u0, plen[k]), (u1, plen[k]), (u1, plen[k + 1]), (u0, plen[k + 1]))):
                loop[uvl].uv = uv
    if cap_ends and not closed:
        f0 = bm.faces.new(rings[0])
        f1 = bm.faces.new(list(reversed(rings[-1])))
        for f in (f0, f1):
            for loop in f.loops:
                loop[uvl].uv = (loop.vert.co.x, loop.vert.co.z)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = bm_to_object(bm, name, mat, coll)
    shade_auto(obj, smooth_angle)
    return obj


def densify(coords: Sequence[Sequence[float]], step: float) -> list[tuple[float, float]]:
    """Insert points so no segment of a 2D path is longer than `step`."""
    out = []
    for a, b in zip(coords[:-1], coords[1:]):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        k = max(1, int(math.ceil(seg / step)))
        for t in range(k):
            out.append((a[0] + (b[0] - a[0]) * t / k, a[1] + (b[1] - a[1]) * t / k))
    out.append((coords[-1][0], coords[-1][1]))
    return out
