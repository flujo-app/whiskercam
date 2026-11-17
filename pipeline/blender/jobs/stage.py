"""Look at one asset module on a plain test stage, the way the game camera will see it.

  run.py -- stage <module> [--demo NAME] [--samples N] [--top]

<module> is a file in pipeline/blender/assets/ that provides

    demo(coll, name: str | None) -> dict

which places its example objects around the origin (ground at z = 0) and may return
  {"focus": (x, y, z), "radius": metres, "cat": [(x, y, heading_deg), ...]}
to steer the cameras. Pictures land in build/stage/<module>/:
  wide_*.jpg   normal lens, from standing height, four sides
  cat_*.jpg    the collar camera: fisheye, 11 cm above the ground
"""
import argparse
import importlib
import math

import bpy
from shapely.geometry import box

from wc import geo, mat, paths, render, scene


def main(args: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("module")
    ap.add_argument("--demo", default=None)
    ap.add_argument("--samples", type=int, default=40)
    ap.add_argument("--top", action="store_true")
    ap.add_argument("--save", action="store_true", help="also save build/stage/<module>/stage.blend")
    opt = ap.parse_args(args)

    sc = scene.reset()
    scene.setup_cycles(sc, samples=opt.samples)
    scene.setup_sky(sc)
    stage = geo.collection("stage")
    geo.flat_polygon("stage_road", box(-30, -30, 30, 0.0), 0.0, mat.get("asphalt"), stage)
    geo.flat_polygon("stage_pave", box(-30, 0.15, 30, 30), 0.14, mat.get("pavers"), stage)
    geo.extrude_polygon("stage_kerb", box(-30, 0.0, 30, 0.15), -0.2, 0.15, mat.get("concrete_brushed"), stage, bevel_w=0.012)

    module = importlib.import_module(f"assets.{opt.module}")
    info = module.demo(geo.collection(opt.module), opt.demo) or {}
    fx, fy, fz = info.get("focus", (0.0, 0.0, 0.8))
    radius = info.get("radius", 4.0)
    out_dir = paths.ensure(paths.BUILD / "stage" / opt.module)
    tag = f"_{opt.demo}" if opt.demo else ""

    tris = sum(len(p.vertices) - 2 for o in bpy.data.collections[opt.module].all_objects if o.type == "MESH"
               for p in o.data.polygons)
    print(f"[stage] {opt.module}{tag}: {tris} triangles")

    for i, az in enumerate((35, 125, 215, 305)):
        a = math.radians(az)
        loc = (fx + math.sin(a) * radius * 1.9, fy + math.cos(a) * radius * 1.9, fz + radius * 0.45 + 0.6)
        render.still(sc, f"wide{tag}_{i}", loc, (fx, fy, fz), lens=32, res=(640, 480), samples=opt.samples, out_dir=out_dir)
    cats = info.get("cat") or [(fx + radius * 0.9, fy - radius * 1.1, -40.0), (fx - radius * 0.5, fy - radius * 0.7, 35.0),
                               (fx + radius * 0.25, fy - radius * 0.45, -25.0)]
    for i, (cx, cy, heading) in enumerate(cats):
        ground = 0.14 if cy > 0.15 else 0.0     # the stage pavement is a kerb height above the road
        render.catcam(sc, f"cat{tag}_{i}", (cx, cy, ground + 0.11), heading, pitch_deg=4.0, res=(432, 768), samples=opt.samples, out_dir=out_dir)
    if opt.top:
        render.top_view(sc, f"top{tag}", (fx, fy), radius * 3.2, res=(800, 800), samples=16, out_dir=out_dir)
    if opt.save:
        bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / "stage.blend"))
