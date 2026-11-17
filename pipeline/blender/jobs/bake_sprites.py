"""Photograph clumps of scanned leaves from straight above to get leaf pictures with cut-out edges.

Hedges and tree crowns are far too leafy to model leaf by leaf for a browser, so they are
made of small flat cards. Each card shows one of these pictures, which come from real scanned
plants (Poly Haven), lit softly from all sides so the cards can be re-lit in the game.

  run.py -- bake_sprites [hedge] [tree]

Writes build/export/sprites/<name>_leaves.png (2 x 2 pictures, 1024 x 1024, with transparency).
"""
import math
import random

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

from wc import geo, paths, ph, scene

TILE = 512


def _studio(sc: bpy.types.Scene) -> None:
    scene.setup_cycles(sc, samples=96)
    sc.render.film_transparent = True
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.resolution_x = sc.render.resolution_y = TILE
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    sc.world = world


def _shoot(sc: bpy.types.Scene, centre: Vector, size: float, depth: float, path) -> None:
    cam_data = bpy.data.cameras.new("c")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = size
    cam_data.clip_start = 0.01
    cam_data.clip_end = depth + 1.0
    cam = bpy.data.objects.new("c", cam_data)
    sc.collection.objects.link(cam)
    cam.location = centre + Vector((0, 0, depth / 2 + 0.5))
    sc.camera = cam
    sc.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def _compose(parts, out_path, ragged: bool = False) -> None:
    atlas = np.zeros((TILE * 2, TILE * 2, 4), dtype=np.float32)
    for i, p in enumerate(parts):
        img = bpy.data.images.load(str(p))
        px = np.empty(TILE * TILE * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(TILE, TILE, 4)
        # un-premultiply so edge pixels keep their leaf colour, then push colour into the transparent surround
        a = px[..., 3:4]
        rgb = np.where(a > 1e-3, px[..., :3] / np.maximum(a, 1e-3), 0.0)
        mean = (rgb * (a > 0.5)).sum(axis=(0, 1)) / max(1.0, float((a > 0.5).sum()))
        rgb = np.where(a > 0.02, rgb, mean)
        alpha = np.clip(a[..., 0] * 1.15, 0, 1)
        if ragged:
            # the scan's leaf colour is rather dark; lift it a little
            rgb = np.clip(rgb * np.array([1.25, 1.32, 1.1], dtype=np.float32), 0, 1)
            # the cut-out was a ball of leaves: bite an uneven edge into the round outline
            yy, xx = np.mgrid[0:TILE, 0:TILE].astype(np.float32)
            dx, dy = (xx - TILE / 2) / (TILE / 2), (yy - TILE / 2) / (TILE / 2)
            ang = np.arctan2(dy, dx)
            rad = np.hypot(dx, dy)
            edge = 0.66 + 0.10 * np.sin(ang * 3 + i) + 0.07 * np.sin(ang * 7 + i * 2.3) + 0.05 * np.sin(ang * 13 + i * 4.1)
            grain = np.random.default_rng(i).random((TILE // 16, TILE // 16)).repeat(16, axis=0).repeat(16, axis=1)
            alpha = alpha * (rad < edge + (grain - 0.5) * 0.16)
        y, x = (i // 2) * TILE, (i % 2) * TILE
        atlas[y:y + TILE, x:x + TILE, :3] = rgb
        atlas[y:y + TILE, x:x + TILE, 3] = alpha
        bpy.data.images.remove(img)
        p.unlink()
    out = bpy.data.images.new("atlas", TILE * 2, TILE * 2, alpha=True)
    out.alpha_mode = "STRAIGHT"
    out.pixels.foreach_set(np.clip(atlas, 0, 1).ravel())
    out.filepath_raw = str(out_path)
    out.file_format = "PNG"
    out.save()
    cover = float((atlas[..., 3] > 0.5).mean())
    print(f"[sprites] wrote {out_path.name}, {cover * 100:.0f}% covered")


def hedge(out_dir) -> None:
    """Dense small leaves: clumps made from the scanned pot plant's foliage."""
    sc = scene.reset()
    _studio(sc)
    ph._LIB.clear()
    src = [o for o in ph.load("potted_plant_01") if any("leaves" in (s.material.name if s.material else "") for s in o.material_slots)]
    lo, hi = ph.bounds(src)
    centre = (lo + hi) / 2
    rng = random.Random(3)
    parts = []
    for v in range(4):
        coll = geo.collection(f"clump{v}")
        for _ in range(4):
            for o in src:
                dup = o.copy()
                coll.objects.link(dup)
                rot = Euler((rng.uniform(-1.2, 1.2), rng.uniform(-1.2, 1.2), rng.uniform(0, 6.28)))
                off = Vector((rng.uniform(-0.055, 0.055), rng.uniform(-0.055, 0.055), rng.uniform(-0.05, 0.05)))
                dup.matrix_world = (Matrix.Translation(off) @ rot.to_matrix().to_4x4() @ Matrix.Scale(0.55, 4)
                                    @ Matrix.Translation(-centre))
        path = out_dir / f"_hedge_{v}.png"
        _shoot(sc, Vector((0, 0, 0)), 0.5, 1.2, path)
        parts.append(path)
        for o in list(coll.objects):
            bpy.data.objects.remove(o)
    _compose(parts, out_dir / "hedge_leaves.png")


def tree(out_dir) -> None:
    """Twig ends cut out of the scanned tree's own crown."""
    sc = scene.reset()
    _studio(sc)
    ph._LIB.clear()
    full = ph.load("jacaranda_tree")[0]
    mesh = full.data
    leaf_slot = next(i for i, s in enumerate(full.material_slots) if "leaves" in s.material.name)
    n = len(mesh.polygons)
    mat_idx = np.empty(n, dtype=np.int32)
    mesh.polygons.foreach_get("material_index", mat_idx)
    centres = np.empty(n * 3, dtype=np.float32)
    mesh.polygons.foreach_get("center", centres)
    centres = centres.reshape(-1, 3)
    leaf = np.where(mat_idx == leaf_slot)[0]
    rng = np.random.default_rng(5)
    parts = []
    tries = 0
    while len(parts) < 4 and tries < 200:
        tries += 1
        seed_face = int(rng.choice(leaf))
        c = centres[seed_face]
        near = leaf[np.linalg.norm(centres[leaf] - c, axis=1) < 0.62]
        if len(near) < 5000:
            continue
        # copy just those faces into a small mesh
        import bmesh

        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.faces.ensure_lookup_table()
        keep = set(int(i) for i in near)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context="FACES")
        small = bpy.data.meshes.new("twig")
        bm.to_mesh(small)
        bm.free()
        small.materials.append(full.material_slots[leaf_slot].material)
        for p in small.polygons:
            p.material_index = 0
        obj = bpy.data.objects.new("twig", small)
        sc.collection.objects.link(obj)
        obj.matrix_world = Matrix.Rotation(rng.uniform(0, math.tau), 4, "Z") @ Matrix.Translation(-Vector(c))
        path = out_dir / f"_tree_{len(parts)}.png"
        _shoot(sc, Vector((0, 0, 0)), 1.36, 3.0, path)
        parts.append(path)
        bpy.data.objects.remove(obj)
        bpy.data.meshes.remove(small)
    _compose(parts, out_dir / "tree_leaves.png", ragged=True)

    # ---- keep a light version of the tree for the builders: the wood, thinned out, plus where the leaves were
    import bmesh

    wood_slots = {i for i, s in enumerate(full.material_slots) if "leaves" not in s.material.name}
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index not in wood_slots], context="FACES")
    wood_mesh = bpy.data.meshes.new("tree_wood")
    bm.to_mesh(wood_mesh)
    bm.free()
    for s in full.material_slots:
        wood_mesh.materials.append(s.material)
    wood = bpy.data.objects.new("tree_wood", wood_mesh)
    sc.collection.objects.link(wood)
    before = len(wood_mesh.polygons)
    mod = wood.modifiers.new("thin", "DECIMATE")
    tris_before = sum(len(p.vertices) - 2 for p in wood_mesh.polygons)
    mod.ratio = min(1.0, 10000 / max(1, tris_before))
    geo.apply_modifiers(wood)
    pts = centres[rng.choice(leaf, size=min(9000, len(leaf)), replace=False)]
    cache = paths.ensure(paths.BUILD / "cache")
    np.save(cache / "tree_leaf_points.npy", pts)
    lo = centres.min(axis=0)
    hi = centres.max(axis=0)
    wood["wc_tree_bounds"] = [float(v) for v in (*lo, *hi)]
    bpy.data.libraries.write(str(cache / "tree.blend"), {wood}, fake_user=True)
    print(f"[sprites] tree wood {before} -> {len(wood.data.polygons)} faces, bounds {lo.round(2)} .. {hi.round(2)}")


def main(args: list[str]) -> None:
    out_dir = paths.ensure(paths.BUILD / "export" / "sprites")
    which = args or ["hedge", "tree"]
    if "hedge" in which:
        hedge(out_dir)
    if "tree" in which:
        tree(out_dir)
