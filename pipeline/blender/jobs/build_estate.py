"""Build the estate (or a window of it) and save it as a .blend, with test pictures.

  run.py -- build_estate [--window x0 y0 x1 y1] [--name NAME] [--stills]
"""
import argparse

import bpy

from sets import estate
from sets import plan as P
from wc import paths, render, scene


def main(args: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", nargs=4, type=float)
    ap.add_argument("--name", default="estate")
    ap.add_argument("--stills", action="store_true")
    opt = ap.parse_args(args)

    sc = scene.reset()
    scene.setup_cycles(sc, samples=48)
    scene.setup_sky(sc)
    estate.build(sc, opt.window)

    out = paths.ensure(paths.BUILD / "blend") / f"{opt.name}.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(out))
    tris = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == "MESH" for p in o.data.polygons)
    print(f"[build] saved {out.name}: {len(bpy.data.objects)} objects, {tris} triangles")

    if opt.stills:
        w = opt.window or P.EST
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        span = max(w[2] - w[0], (w[3] - w[1]) * 1.6) * 1.05
        render.top_view(sc, f"{opt.name}_top", (cx, cy), span, samples=24)
        sx, sy, sz = P.START
        render.catcam(sc, f"{opt.name}_cat_start", (sx, sy, P.Z_DECK + 0.12), P.START_HEADING, samples=48)
        render.catcam(sc, f"{opt.name}_cat_road", (-2.0, -19.5, 0.10), 75.0, samples=48)
        render.still(sc, f"{opt.name}_eye", (-12.0, -26.0, 6.0), (2.0, -17.0, 0.5), lens=20, samples=48)
