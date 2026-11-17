"""Work out the light ahead of time ("baking"), one slice at a time so it fits an 8 GB card.

The world is static and the sun never moves, so the slow, film-quality light calculation
(Cycles path tracing) runs once here and the game only has to look the result up.

Three things are stored for every surface point:
  sun  - how much of the sun disc is visible (0 = in shadow, 1 = full sun, soft edges)
  sky  - light arriving straight from the sky
  ind  - light that bounced off other surfaces first
sky + ind are added into one picture ("irr"); sun stays separate so the game can still
do crisp, bumpy sunlight per pixel and let moving things cast shadows.

Slices ("chunks"):
  ground tiles   - TILE x TILE metres of flat ground, light map = plain top-down projection
  structure cells- everything else (kerbs, walls, buildings, props), light map laid out by xatlas
"""
from __future__ import annotations

import json
import math
import subprocess
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np

from . import geo, paths, scene

TILE = 16.0            # ground tile size in metres
GROUND_RES = 1024      # sun map texels per tile side  -> 1.6 cm per texel
CELL = 26.0            # structure cell size in metres
TARGET_TPM = 22.0      # wanted light-map texels per metre for near-ground structures
ATLAS_PAD = 6
IRR_RANGE = 4.0        # irr pictures store sqrt(value / IRR_RANGE)
SAMPLES = {"sun": 96, "sky": 128, "ind": 384}
SKIP_ROLES = {"ground", "decal", "collider", "foliage", "scatter", "probe", "far"}

PYENV = paths.BUILD / "pyenv" / "Scripts" / "python.exe"


# ---------------------------------------------------------------- helpers

def static_objects(sc: bpy.types.Scene) -> list[bpy.types.Object]:
    lib = bpy.data.collections.get("_library")
    banned = set(lib.objects) if lib else set()
    return [o for o in sc.objects if o.type == "MESH" and o not in banned and not o.hide_render]


def make_single_user(objs) -> None:
    for o in objs:
        if o.data.users > 1:
            o.data = o.data.copy()


def triangulate(obj: bpy.types.Object) -> None:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()


def tile_of(x: float, y: float, origin) -> tuple[int, int]:
    return int(math.floor((x - origin[0]) / TILE)), int(math.floor((y - origin[1]) / TILE))


def _bake_node(material: bpy.types.Material):
    if not material.use_nodes:
        material.use_nodes = True
    nt = material.node_tree
    node = nt.nodes.get("wc_bake")
    if node is None:
        node = nt.nodes.new("ShaderNodeTexImage")
        node.name = "wc_bake"
        node.location = (-900, -600)
    nt.nodes.active = node
    return node


def _ensure_material(obj: bpy.types.Object) -> None:
    if not obj.data.materials or any(m is None for m in obj.data.materials):
        fallback = bpy.data.materials.get("wc_fallback") or bpy.data.materials.new("wc_fallback")
        fallback.use_nodes = True
        if not obj.data.materials:
            obj.data.materials.append(fallback)
        for i, m in enumerate(obj.data.materials):
            if m is None:
                obj.data.materials[i] = fallback


def _bake_pass(sc: bpy.types.Scene, obj: bpy.types.Object, kind: str, res: int, uv: str) -> np.ndarray:
    """Run one Cycles bake for `obj`; returns a (res, res, 4) float array (row 0 = bottom)."""
    img = bpy.data.images.new(f"bake_{kind}", res, res, alpha=True, float_buffer=True)
    for m in obj.data.materials:
        _bake_node(m).image = img
    obj.data.uv_layers.active = obj.data.uv_layers[uv]
    geo.select_only([obj])
    world_bg = sc.world.node_tree.nodes["Background"].inputs["Strength"]
    sun = scene.sun_object(sc)
    keep_strength, keep_hide = world_bg.default_value, sun.hide_render
    sc.cycles.samples = SAMPLES[kind]
    sc.cycles.use_adaptive_sampling = False
    sc.cycles.use_denoising = False
    margin = max(2, ATLAS_PAD * res // 1024)
    try:
        if kind == "sun":
            world_bg.default_value = 0.0
            bpy.ops.object.bake(type="SHADOW", margin=margin, use_clear=True, uv_layer=uv)
        elif kind == "sky":
            sun.hide_render = True
            bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT"}, margin=margin, use_clear=True, uv_layer=uv)
        else:
            bpy.ops.object.bake(type="DIFFUSE", pass_filter={"INDIRECT"}, margin=margin, use_clear=True, uv_layer=uv)
    finally:
        world_bg.default_value = keep_strength
        sun.hide_render = keep_hide
    px = np.empty(res * res * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    for m in obj.data.materials:
        _bake_node(m).image = None
    bpy.data.images.remove(img)
    return px.reshape(res, res, 4)


def _blur_valid(rgb: np.ndarray, valid: np.ndarray, passes: int = 2) -> np.ndarray:
    """Small blur that only mixes texels that hold real data (hides leftover sampling noise)."""
    w = valid.astype(np.float32)
    acc = rgb * w[..., None]
    for _ in range(passes):
        for axis in (0, 1):
            acc = (np.roll(acc, 1, axis) + 2.0 * acc + np.roll(acc, -1, axis)) / 4.0
            w = (np.roll(w, 1, axis) + 2.0 * w + np.roll(w, -1, axis)) / 4.0
    out = acc / np.maximum(w, 1e-6)[..., None]
    return np.where(valid[..., None], out, rgb)


def _save_png(arr: np.ndarray, path: Path) -> None:
    """Write a (H, W, 3 or 1) array of 0..1 values as an 8-bit PNG without colour management."""
    h, w = arr.shape[:2]
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = arr if arr.shape[2] == 3 else np.repeat(arr, 3, axis=2)
    rng = np.random.default_rng(1)
    rgba[..., :3] += (rng.random((h, w, 1), dtype=np.float32) - 0.5) / 255.0   # dither against banding
    np.clip(rgba, 0.0, 1.0, out=rgba)
    img = bpy.data.images.new("save", w, h, alpha=True, float_buffer=False, is_data=True)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = str(path)
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def bake_chunk(sc: bpy.types.Scene, obj: bpy.types.Object, res: int, out_dir: Path, uv: str = geo.UV1) -> dict:
    """Bake sun / sky / bounce light for one chunk object and write <name>_sun.png and <name>_irr.png."""
    name = obj.name
    sun_path, irr_path = out_dir / f"{name}_sun.png", out_dir / f"{name}_irr.png"
    started = time.time()
    _ensure_material(obj)
    sun = _bake_pass(sc, obj, "sun", res, uv)
    half = max(64, res // 2)
    sky = _bake_pass(sc, obj, "sky", half, uv)
    ind = _bake_pass(sc, obj, "ind", half, uv)
    valid = (ind[..., 3] > 0.0) | (ind[..., :3].sum(axis=2) > 0.0)
    irr = sky[..., :3] + _blur_valid(ind[..., :3], valid)
    _save_png(np.sqrt(np.clip(irr / IRR_RANGE, 0.0, 1.0)), irr_path)
    _save_png(np.clip(sun[..., :1], 0.0, 1.0), sun_path)
    print(f"[bake] {name}: {res}px in {time.time() - started:.1f}s")
    return {"name": name, "res": res, "sun": sun_path.name, "irr": irr_path.name}


# ---------------------------------------------------------------- ground tiles

def prepare_ground(sc: bpy.types.Scene, origin) -> list[bpy.types.Object]:
    """Join the ground pieces of every tile and give them a top-down light-map projection."""
    groups: dict[str, list] = {}
    for o in static_objects(sc):
        if o.get("wc_role") == "ground" and o.get("wc_tile"):
            groups.setdefault(o["wc_tile"], []).append(o)
    out = []
    for key, objs in sorted(groups.items()):
        make_single_user(objs)
        ix, iy = (int(v) for v in key.split("_"))
        obj = geo.join(objs, f"ground_{ix}_{iy}")
        triangulate(obj)
        x0, y0 = origin[0] + ix * TILE, origin[1] + iy * TILE
        mesh = obj.data
        uvl = geo.uv_layer(mesh, geo.UV1)
        mw = obj.matrix_world
        for loop in mesh.loops:
            p = mw @ mesh.vertices[loop.vertex_index].co
            uvl.data[loop.index].uv = ((p.x - x0) / TILE, (p.y - y0) / TILE)
        obj["wc_chunk"] = "ground"
        obj["wc_tile_origin"] = (x0, y0)
        out.append(obj)
    return out


# ---------------------------------------------------------------- structure cells

def _atlas(objs: list[bpy.types.Object], res: int, tag: str) -> dict:
    tmp = paths.ensure(paths.BUILD / "tmp")
    src, dst = tmp / f"atlas_{tag}_in.npz", tmp / f"atlas_{tag}_out.npz"
    payload = {"n": len(objs), "res": res, "padding": ATLAS_PAD}
    for k, o in enumerate(objs):
        mesh = o.data
        weight = float(o.get("wc_lm", 1.0))
        co = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        mw = np.array(o.matrix_world, dtype=np.float32)
        payload[f"pos_{k}"] = (co @ mw[:3, :3].T + mw[:3, 3]) * weight
        idx = np.empty(len(mesh.polygons) * 3, dtype=np.int32)
        mesh.polygons.foreach_get("vertices", idx)
        payload[f"idx_{k}"] = idx.reshape(-1, 3).astype(np.uint32)
    np.savez(src, **payload)
    proc = subprocess.run([str(PYENV), "-I", str(paths.ROOT / "tools" / "atlas.py"), str(src), str(dst)],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"atlas failed for {tag}: {proc.stderr[-800:]}")
    result = dict(np.load(dst))
    src.unlink(missing_ok=True)
    dst.unlink(missing_ok=True)
    return result


def _apply_atlas(objs, result) -> None:
    for k, o in enumerate(objs):
        uvl = geo.uv_layer(o.data, geo.UV1)
        uvl.data.foreach_set("uv", result[f"uv_{k}"].reshape(-1).astype(np.float32))


def prepare_structures(sc: bpy.types.Scene) -> list[tuple[bpy.types.Object, int]]:
    """Group everything that is not flat ground into cells, lay out a light map for each, join each cell."""
    from mathutils import Vector

    def centre(o):
        pts = [o.matrix_world @ Vector(b) for b in o.bound_box]
        return (min(p.x for p in pts) + max(p.x for p in pts)) / 2, (min(p.y for p in pts) + max(p.y for p in pts)) / 2

    todo = [o for o in static_objects(sc) if o.get("wc_role") not in SKIP_ROLES and not o.get("wc_chunk")
            and len(o.data.polygons) > 0]
    make_single_user(todo)
    cells: dict[tuple[int, int], list] = {}
    for o in todo:
        cx, cy = centre(o)
        cells.setdefault((int(math.floor(cx / CELL)), int(math.floor(cy / CELL))), []).append(o)

    out = []
    queue = [(f"cell_{cx}_{cy}".replace("-", "m"), objs) for (cx, cy), objs in sorted(cells.items())]
    while queue:
        tag, objs = queue.pop(0)
        for o in objs:
            triangulate(o)
        res = 1024
        result = _atlas(objs, res, tag)
        tpm = float(result["texels_per_unit"])
        if tpm < TARGET_TPM * 0.8:
            res = 2048
            result = _atlas(objs, res, tag)
            tpm = float(result["texels_per_unit"])
            if tpm < TARGET_TPM * 0.55 and len(objs) > 1:
                # still too coarse: split the cell in two along its longer side and try again
                xs = [centre(o)[0] for o in objs]
                ys = [centre(o)[1] for o in objs]
                axis = 0 if (max(xs) - min(xs)) >= (max(ys) - min(ys)) else 1
                vals = xs if axis == 0 else ys
                mid = sorted(vals)[len(vals) // 2]
                a = [o for o, v in zip(objs, vals) if v < mid]
                b = [o for o, v in zip(objs, vals) if v >= mid]
                if a and b:
                    queue[:0] = [(tag + "a", a), (tag + "b", b)]
                    continue
        while tpm > TARGET_TPM * 2.4 and res > 256:
            res //= 2
            tpm /= 2
        _apply_atlas(objs, result)
        obj = geo.join(objs, tag)
        obj["wc_chunk"] = "struct"
        obj["wc_tpm"] = tpm
        print(f"[bake] {tag}: {len(objs)} objects, {int(result['charts'])} charts, {tpm:.1f} texels/m at {res}px")
        out.append((obj, res))
    return out


# ---------------------------------------------------------------- leaves (light stored per corner point)

def prepare_foliage(sc: bpy.types.Scene) -> list[bpy.types.Object]:
    """Join the leaf-card objects of each cell. Their light is baked per vertex, no light map needed."""
    from mathutils import Vector

    cells: dict[tuple[int, int], list] = {}
    for o in static_objects(sc):
        if o.get("wc_role") != "foliage" or o.get("wc_chunk"):
            continue
        pts = [o.matrix_world @ Vector(b) for b in o.bound_box]
        cx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2
        cy = (min(p.y for p in pts) + max(p.y for p in pts)) / 2
        cells.setdefault((int(math.floor(cx / CELL)), int(math.floor(cy / CELL))), []).append(o)
    out = []
    for (cx, cy), objs in sorted(cells.items()):
        make_single_user(objs)
        obj = geo.join(objs, f"leaf_{cx}_{cy}".replace("-", "m"))
        obj["wc_chunk"] = "foliage"
        out.append(obj)
    return out


def bake_vertex(sc: bpy.types.Scene, obj: bpy.types.Object) -> dict:
    """Bake sun / sky / bounce light into a colour attribute: rgb = sqrt(light / IRR_RANGE), alpha = sun."""
    started = time.time()
    mesh = obj.data
    geo.select_only([obj])
    world_bg = sc.world.node_tree.nodes["Background"].inputs["Strength"]
    sun = scene.sun_object(sc)
    keep_strength, keep_hide = world_bg.default_value, sun.hide_render
    sc.cycles.use_adaptive_sampling = False
    sc.cycles.use_denoising = False
    n = len(mesh.vertices)
    got = {}
    for kind in ("sun", "sky", "ind"):
        attr = mesh.color_attributes.new(f"bk_{kind}", "FLOAT_COLOR", "POINT")
        mesh.color_attributes.active_color = attr
        sc.cycles.samples = {"sun": 96, "sky": 96, "ind": 192}[kind]
        try:
            if kind == "sun":
                world_bg.default_value = 0.0
                bpy.ops.object.bake(type="SHADOW", target="VERTEX_COLORS")
            elif kind == "sky":
                sun.hide_render = True
                bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT"}, target="VERTEX_COLORS")
            else:
                bpy.ops.object.bake(type="DIFFUSE", pass_filter={"INDIRECT"}, target="VERTEX_COLORS")
        finally:
            world_bg.default_value = keep_strength
            sun.hide_render = keep_hide
        data = np.empty(n * 4, dtype=np.float32)
        mesh.color_attributes[f"bk_{kind}"].data.foreach_get("color", data)
        got[kind] = data.reshape(n, 4)[:, :3].copy()
    for kind in ("sun", "sky", "ind"):
        mesh.color_attributes.remove(mesh.color_attributes[f"bk_{kind}"])
    final = np.ones((n, 4), dtype=np.float32)
    final[:, :3] = np.sqrt(np.clip((got["sky"] + got["ind"]) / IRR_RANGE, 0.0, 1.0))
    final[:, 3] = np.clip(got["sun"][:, 0], 0.0, 1.0)
    col = mesh.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    col.data.foreach_set("color", final.ravel())
    mesh.color_attributes.active_color = col
    mesh.color_attributes.render_color_index = mesh.color_attributes.find("Col")
    print(f"[bake] {obj.name}: {n} leaf points in {time.time() - started:.1f}s")
    return {"name": obj.name, "kind": "foliage"}


# ---------------------------------------------------------------- whole scene

def bake_scene(sc: bpy.types.Scene, name: str, origin) -> dict:
    out_dir = paths.ensure(paths.BUILD / "bake" / name)
    scene.setup_cycles(sc)
    sc.cycles.max_bounces = 5
    sc.cycles.diffuse_bounces = 4
    sc.render.bake.margin_type = "EXTEND"
    chunks = []
    started = time.time()
    for obj in prepare_ground(sc, origin):
        info = bake_chunk(sc, obj, GROUND_RES, out_dir)
        info.update(kind="ground", tile_origin=list(obj["wc_tile_origin"]), tile_size=TILE)
        chunks.append(info)
    for obj, res in prepare_structures(sc):
        info = bake_chunk(sc, obj, res, out_dir)
        info.update(kind="struct")
        chunks.append(info)
    for obj in prepare_foliage(sc):
        chunks.append(bake_vertex(sc, obj))
    # far-away scenery gets no baked light at all: the game lights it with plain sun and sky
    far = [o for o in static_objects(sc) if o.get("wc_role") == "far" and not o.get("wc_chunk")]
    if far:
        make_single_user(far)
        obj = geo.join(far, "far_0")
        obj["wc_chunk"] = "far"
        chunks.append({"name": obj.name, "kind": "far"})
    manifest = {"chunks": chunks, "irr_range": IRR_RANGE, "seconds": round(time.time() - started, 1)}
    (out_dir / "chunks.json").write_text(json.dumps(manifest, indent=1))
    print(f"[bake] {len(chunks)} chunks in {manifest['seconds']}s")
    return manifest
