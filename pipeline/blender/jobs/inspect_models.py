"""Render scanned models on a plain floor to see what they are: size, parts, triangle count.

  run.py -- inspect_models jacaranda_tree shrub_04 ...
"""
import bpy
from mathutils import Vector

from wc import geo, mat, paths, ph, render, scene


def main(args: list[str]) -> None:
    out_dir = paths.ensure(paths.BUILD / "inspect")
    for ph_id in args:
        sc = scene.reset()
        scene.setup_cycles(sc, samples=48)
        scene.setup_sky(sc)
        ph._LIB.clear()
        objs = ph.place(ph_id, (0, 0, 0))
        lo, hi = ph.bounds(objs)
        size = hi - lo
        tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
        names = ", ".join(sorted({o.name.rsplit('.', 1)[0] for o in ph.load(ph_id)})[:40])
        mats = sorted({s.material.name for o in objs for s in o.material_slots if s.material})
        print(f"[inspect] {ph_id}: size {size.x:.2f} x {size.y:.2f} x {size.z:.2f} m, {tris} tris, "
              f"{len(objs)} objects, materials {mats}")
        print(f"[inspect] {ph_id} parts: {names}")
        ground = geo.box("floor", (-40, -40, -0.1), (40, 40, 0.0), mat.get("concrete_floor"))
        r = max(size.x, size.y, size.z)
        centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2))
        cam_loc = centre + Vector((r * 1.1, -r * 1.5, r * 0.55))
        render.still(sc, ph_id, cam_loc, centre, lens=35, res=(640, 480), samples=40, out_dir=out_dir)
