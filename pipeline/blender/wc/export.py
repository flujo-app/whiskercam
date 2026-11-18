"""Write the world out for the game.

Blender is Z-up, the game (three.js) is Y-up:  game (x, y, z) = blender (x, z, -y).
Everything written here is already in game coordinates.

Output (build/export/<name>/):
  chunks/<chunk>.glb   geometry; materials by name only, without pictures
  materials.json       how to rebuild each material (see wc.mat)
  collision.json/.bin  triangles the cat can stand on or bump into
  sky.png              the sky as a picture (equirect, sqrt-encoded), see export_sky
  world.json           the index: sun, sky, chunks, spawn point
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import bake, geo, mat, paths, scene


def to_game(p) -> list[float]:
    return [round(float(p[0]), 5), round(float(p[2]), 5), round(float(-p[1]), 5)]


# ---------------------------------------------------------------- collision

SURFACES = ["asphalt", "pavers", "concrete", "grass", "soil", "wood", "gravel", "metal", "plaster", "hedge"]
SURFACE_OF = {
    "asphalt": "asphalt", "asphalt_old": "asphalt", "asphalt_worn": "asphalt", "asphalt_patch": "asphalt",
    "asphalt_cracked": "asphalt", "pavers": "pavers", "pavers_interlock": "pavers", "pavers_square": "pavers",
    "pavers_red": "pavers", "concrete_floor": "concrete", "concrete_brushed": "concrete", "concrete_dirty": "concrete",
    "concrete": "concrete", "grass": "grass", "grass_sparse": "grass", "grass_leafy": "grass", "dirt": "soil",
    "wood_chips": "soil", "mud_leaves": "soil", "deck": "wood", "gravel": "gravel", "metal": "metal",
}


def export_collision(sc: bpy.types.Scene, out_dir: Path) -> dict:
    """Collect every object tagged wc_collide="mesh" into two triangle soups: solid and soft (hedges)."""
    groups = {"solid": ([], [], []), "soft": ([], [], [])}
    counts = {"solid": 0, "soft": 0}
    for o in bake.static_objects(sc) + [o for o in sc.objects if o.type == "MESH" and o.get("wc_role") == "collider"]:
        if o.get("wc_collide") != "mesh":
            continue
        key = "soft" if o.get("wc_soft") else "solid"
        pos, idx, surf = groups[key]
        tagged = str(o.get("wc_surface", ""))
        # the tag is either a material name or already one of the surface kinds ("wood", "metal")
        surface = tagged if tagged in SURFACES else SURFACE_OF.get(tagged, "hedge" if key == "soft" else "plaster")
        sid = SURFACES.index(surface)
        bm = bmesh.new()
        bm.from_mesh(o.data)
        # Closed shapes (boxes, car bodies, pipe casings) go out with every face pointing outwards, so the game
        # can tell a ray that leaves a solid from one that enters it. Open sheets (the ground) keep their side.
        if bm.edges and all(e.is_manifold for e in bm.edges):
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        base = counts[key]
        for v in bm.verts:
            pos.append(to_game(o.matrix_world @ v.co))
        for f in bm.faces:
            a, b, c = (v.index + base for v in f.verts)
            idx.append((a, b, c))
            surf.append(sid)
        counts[key] += len(bm.verts)
        bm.free()
    blob = bytearray()
    index = {"surfaces": SURFACES, "groups": {}}
    for key, (pos, idx, surf) in groups.items():
        p = np.asarray(pos, dtype=np.float32).reshape(-1, 3)
        i = np.asarray(idx, dtype=np.uint32).reshape(-1, 3)
        s = np.asarray(surf, dtype=np.uint8)
        entry = {"vertices": len(p), "triangles": len(i)}
        for label, arr in (("pos", p), ("idx", i), ("surf", s)):
            while len(blob) % 4:
                blob.append(0)
            entry[label] = len(blob)
            blob.extend(arr.tobytes())
        index["groups"][key] = entry
    (out_dir / "collision.bin").write_bytes(bytes(blob))
    (out_dir / "collision.json").write_text(json.dumps(index))
    print(f"[export] collision: {index['groups']['solid']['triangles']} solid, {index['groups']['soft']['triangles']} soft triangles")
    return index


# ---------------------------------------------------------------- sky picture

SKY_W, SKY_H = 1024, 512


def export_sky(sc: bpy.types.Scene, out_dir: Path) -> dict:
    """Bake the sky colour onto a sphere whose UVs follow the game's equirect lookup, save as sky.png.

    Game lookup (three.js):  u = atan2(d.z, d.x) / 2pi + 0.5,  v = asin(d.y) / pi + 0.5
    """
    nu, nv = 128, 64
    verts, faces, uvs = [], [], []
    for j in range(nv + 1):
        lat = (j / nv - 0.5) * math.pi
        for i in range(nu + 1):
            lon = (i / nu - 0.5) * 2.0 * math.pi
            gx, gy, gz = math.cos(lat) * math.cos(lon), math.sin(lat), math.cos(lat) * math.sin(lon)
            verts.append((gx * 900.0, -gz * 900.0, gy * 900.0))   # game -> blender
            uvs.append((i / nu, j / nv))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + 1, a + nu + 2, a + nu + 1))
    mesh = bpy.data.meshes.new("sky_probe")
    mesh.from_pydata(verts, [], faces)
    uvl = mesh.uv_layers.new(name="sky")
    for poly in mesh.polygons:
        for li, vi in zip(poly.loop_indices, poly.vertices):
            uvl.data[li].uv = uvs[vi]
    obj = bpy.data.objects.new("sky_probe", mesh)
    sc.collection.objects.link(obj)
    m = bpy.data.materials.new("sky_probe")
    m.use_nodes = True
    node = m.node_tree.nodes.new("ShaderNodeTexImage")
    img = bpy.data.images.new("sky_probe", SKY_W, SKY_H, alpha=False, float_buffer=True)
    node.image = img
    m.node_tree.nodes.active = node
    mesh.materials.append(m)
    geo.select_only([obj])
    sc.cycles.samples = 16
    bpy.ops.object.bake(type="ENVIRONMENT", margin=2, use_clear=True)
    px = np.empty(SKY_W * SKY_H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(SKY_H, SKY_W, 4)[..., :3]
    bpy.data.objects.remove(obj)
    bpy.data.meshes.remove(mesh)
    bpy.data.materials.remove(m)
    bpy.data.images.remove(img)

    upper = px[SKY_H // 2:]
    peak = float(np.percentile(upper, 99.9)) * 1.05
    # below the horizon: fade to a dim ground tone so reflections never show a second sky
    horizon = upper[0].mean(axis=0)
    for row in range(SKY_H // 2):
        t = 1.0 - row / (SKY_H // 2)            # 1 at the bottom of the picture, 0 at the horizon
        px[row] = horizon * (0.35 + 0.25 * (1.0 - t))
    bake._save_png(np.sqrt(np.clip(px / peak, 0.0, 1.0))[::1], out_dir / "sky.png")
    return {"file": "sky.png", "range": peak}


# ---------------------------------------------------------------- what kind of ground is where

KINDS_PER_M = 4


def export_kinds(regions, bounds, out_dir: Path) -> dict:
    """Small map of the ground: red = lawn (the game grows grass there), green = soil beds."""
    import shapely

    x0, y0, x1, y1 = bounds
    w, h = int((x1 - x0) * KINDS_PER_M), int((y1 - y0) * KINDS_PER_M)
    xs = x0 + (np.arange(w) + 0.5) / KINDS_PER_M
    ys = y0 + (np.arange(h) + 0.5) / KINDS_PER_M
    gx, gy = np.meshgrid(xs, ys)
    img = np.zeros((h, w, 3), dtype=np.float32)
    for reg in regions:
        channel = {"lawn": 0, "bed": 1}.get(reg.kind)
        if channel is None:
            continue
        bx0, by0, bx1, by1 = reg.geom.bounds
        i0, i1 = max(0, int((bx0 - x0) * KINDS_PER_M)), min(w, int((bx1 - x0) * KINDS_PER_M) + 1)
        j0, j1 = max(0, int((by0 - y0) * KINDS_PER_M)), min(h, int((by1 - y0) * KINDS_PER_M) + 1)
        if i1 <= i0 or j1 <= j0:
            continue
        inside = shapely.contains_xy(reg.geom, gx[j0:j1, i0:i1], gy[j0:j1, i0:i1])
        img[j0:j1, i0:i1, channel] = np.maximum(img[j0:j1, i0:i1, channel], inside.astype(np.float32))
    # row 0 of a Blender image is the bottom (south) edge, which is what _save_png expects
    bake._save_png(img, out_dir / "kinds.png")
    return {"file": "kinds.png", "x0": x0, "z0": -y1, "w": x1 - x0, "h": y1 - y0}


# ---------------------------------------------------------------- geometry + materials

def export_chunk(obj: bpy.types.Object, out_dir: Path, colors: bool = False) -> str:
    geo.select_only([obj])
    path = out_dir / f"{obj.name}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        # materials go out by name only (no pictures); the game rebuilds them from materials.json
        export_materials="EXPORT", export_image_format="NONE", export_texcoords=True, export_normals=True,
        export_tangents=False, export_yup=True, export_apply=False, export_extras=False, export_cameras=False,
        export_lights=False, export_animations=False, export_skins=False, export_morph=False,
        export_vertex_color="ACTIVE" if colors else "NONE", export_active_vertex_color_when_no_material=colors,
        export_all_vertex_colors=False,
    )
    return path.name


def _game_matrix(m) -> list[float]:
    """Blender world matrix -> three.js matrix (column-major), for meshes exported with Y up."""
    c = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
    g = c @ m @ c.inverted()
    return [round(g[r][col], 5) for col in range(4) for r in range(4)]


def export_scatter(sc: bpy.types.Scene, out_dir: Path) -> dict:
    """Small plants are drawn as copies: write each distinct mesh once plus the list of placements."""
    scatter_dir = paths.ensure(out_dir / "scatter")
    groups: dict[str, list] = {}
    for o in bake.static_objects(sc):
        if o.get("wc_role") == "scatter" and o.get("wc_src"):
            groups.setdefault(o["wc_src"], []).append(o)
    table = {}
    used = []
    for key, objs in sorted(groups.items()):
        mesh = objs[0].data
        proto = bpy.data.objects.new("sc_" + key.replace("|", "_").replace(".", "_")[:48], mesh)
        sc.collection.objects.link(proto)
        used.append(proto)
        file = "scatter/" + export_chunk(proto, scatter_dir)
        table[key] = {"file": file, "plant": not objs[0].get("wc_solid"),
                      "matrices": [v for o in objs for v in _game_matrix(o.matrix_world)]}
    mats = material_table(used)
    for proto in used:
        bpy.data.objects.remove(proto)
    print(f"[export] scatter: {len(table)} models, {sum(len(v['matrices']) // 16 for v in table.values())} copies")
    return {"models": table, "materials": mats}

def material_table(objs) -> dict:
    table = {}
    for o in objs:
        for m in o.data.materials:
            if m is None or m.name in table:
                continue
            desc = mat.describe(m)
            if desc is None:
                bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if m.use_nodes else None
                color = list(bsdf.inputs["Base Color"].default_value[:3]) if bsdf else [0.5, 0.5, 0.5]
                desc = {"kind": "flat", "color": color, "rough": 0.6, "metal": 0.0}
            table[m.name] = desc
    return table


def export_props(sc: bpy.types.Scene, out_dir: Path) -> dict:
    """Loose things the cat can knock about: one model file per kind plus where each one starts."""
    from . import ph

    loose = json.loads(sc.get("wc_loose", "[]"))
    prop_dir = paths.ensure(out_dir / "props")
    models: dict[str, dict] = {}
    items = []
    made = []
    for item in loose:
        key = item["model"] + (f"|{item['part']}" if item.get("part") else "")
        if key not in models:
            src = [o for o in ph.load(item["model"]) if not item.get("part") or item["part"].lower() in o.name.lower()]
            lo, hi = ph.bounds(src)
            pivot = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
            dups = []
            for o in src:
                d = o.copy()
                d.data = o.data.copy()
                sc.collection.objects.link(d)
                d.matrix_world = Matrix.Translation(-pivot) @ o.matrix_world
                dups.append(d)
            joined = geo.join(dups, "prop_" + key.replace("|", "_").replace(".", "_")[:48])
            geo.select_only([joined])
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            made.append(joined)
            size = hi - lo
            models[key] = {"file": "props/" + export_chunk(joined, prop_dir), "size": [round(size.x, 4), round(size.z, 4), round(size.y, 4)]}
        items.append({"key": key, "pos": to_game(item["pos"]), "rot": item["rot"], "scale": item["scale"],
                      "mass": item["mass"], "kind": item["kind"]})
    mats = material_table(made)
    for o in made:
        bpy.data.objects.remove(o)
    print(f"[export] props: {len(models)} models, {len(items)} loose things")
    return {"models": models, "items": items, "materials": mats}


def export_world(sc: bpy.types.Scene, name: str, manifest: dict, spawn, heading: float, extra: dict | None = None) -> Path:
    out_dir = paths.ensure(paths.BUILD / "export" / name)
    chunk_dir = paths.ensure(out_dir / "chunks")
    sky = scene.sky_info(sc)
    by_name = {c["name"]: c for c in manifest["chunks"]}
    objs = [o for o in sc.objects if o.type == "MESH" and o.get("wc_chunk") and o.name in by_name]
    chunks = []
    for o in objs:
        info = dict(by_name[o.name])
        info["file"] = "chunks/" + export_chunk(o, chunk_dir, colors=info["kind"] == "foliage")
        if "sun" in info:
            info["sun"] = "lm/" + info["sun"]
            info["irr"] = "lm/" + info["irr"]
        if "tile_origin" in info:
            x0, y0 = info["tile_origin"]
            # game z = -blender y: the tile covers z from -(y0 + size) to -y0
            info["tile_origin"] = [x0, -(y0 + info["tile_size"])]
        lo = [min((o.matrix_world @ Vector(b))[i] for b in o.bound_box) for i in range(3)]
        hi = [max((o.matrix_world @ Vector(b))[i] for b in o.bound_box) for i in range(3)]
        info["bounds"] = [[lo[0], lo[2], -hi[1]], [hi[0], hi[2], -lo[1]]]
        chunks.append(info)
    scatter = export_scatter(sc, out_dir)
    props = export_props(sc, out_dir)
    table = material_table(objs)
    table.update(scatter["materials"])
    table.update(props["materials"])
    (out_dir / "materials.json").write_text(json.dumps(table, indent=1))
    world = {
        "name": name,
        "version": 1,
        "sun": {"dir": to_game(sky["sun_dir"]), "irradiance": sky["sun_irradiance"]},
        "sky": export_sky(sc, out_dir),
        "sky_irradiance_up": sky["sky_irradiance_up"],
        "irr_range": manifest["irr_range"],
        "chunks": chunks,
        "scatter": scatter["models"],
        "props": {"models": props["models"], "items": props["items"]},
        "spawn": {"pos": to_game(spawn), "heading": heading},
        # places for the movement tests: [kind, x, z, nx, nz] in game axes
        # (for a tree the last two numbers are not a direction: fork height and trunk thickness)
        "poi": [[k, x, -y, nx, ny if k == "tree" else -ny] for k, x, y, nx, ny in json.loads(sc.get("wc_poi", "[]"))],
    }
    world.update(extra or {})
    path = out_dir / "world.json"
    path.write_text(json.dumps(world, indent=1))
    print(f"[export] {len(chunks)} chunks -> {out_dir}")
    return path