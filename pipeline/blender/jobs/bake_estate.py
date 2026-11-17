"""Bake the light for a built estate and export it for the game.

  run.py -- bake_estate [--name NAME]

Reads build/blend/<name>.blend, writes build/bake/<name>/ and build/export/<name>/.
"""
import argparse
import shutil

import bpy

from sets import plan as P
from wc import bake, export, paths


def main(args: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="estate")
    opt = ap.parse_args(args)

    bpy.ops.wm.open_mainfile(filepath=str(paths.BUILD / "blend" / f"{opt.name}.blend"))
    sc = bpy.context.scene
    out_dir = paths.ensure(paths.BUILD / "export" / opt.name)
    export.export_collision(sc, out_dir)          # before objects get joined into chunks
    manifest = bake.bake_scene(sc, opt.name, (P.EST[0], P.EST[1]))
    export.export_world(sc, opt.name, manifest, P.START, P.START_HEADING)
    lm = paths.ensure(out_dir / "lm")
    for f in (paths.BUILD / "bake" / opt.name).glob("*.png"):
        shutil.copy2(f, lm / f.name)
    bpy.ops.wm.save_as_mainfile(filepath=str(paths.BUILD / "blend" / f"{opt.name}_baked.blend"))
