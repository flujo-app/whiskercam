"""Re-export a baked estate without baking again (after changes to wc.export only).

  run.py -- reexport [--name NAME]
"""
import argparse
import json

import bpy

from sets import plan as P
from wc import export, paths


def main(args: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="estate")
    opt = ap.parse_args(args)
    bpy.ops.wm.open_mainfile(filepath=str(paths.BUILD / "blend" / f"{opt.name}_baked.blend"))
    manifest = json.loads((paths.BUILD / "bake" / opt.name / "chunks.json").read_text())
    export.export_world(bpy.context.scene, opt.name, manifest, P.START, P.START_HEADING)
