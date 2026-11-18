"""Write only the collision shapes and the test spots of a built estate (no light baking).

  run.py -- export_collision [--name NAME]

Reads build/blend/<name>.blend and writes collision.json / collision.bin / poi.json to build/export/<name>/.
Use it to try out changes to what the cat bumps into without waiting for a bake.
"""
import argparse
import json

import bpy

from wc import export, paths


def main(args: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="estate")
    opt = ap.parse_args(args)
    bpy.ops.wm.open_mainfile(filepath=str(paths.BUILD / "blend" / f"{opt.name}.blend"))
    sc = bpy.context.scene
    out_dir = paths.ensure(paths.BUILD / "export" / opt.name)
    export.export_collision(sc, out_dir)
    poi = [[k, x, -y, nx, ny if k == "tree" else -ny] for k, x, y, nx, ny in json.loads(sc.get("wc_poi", "[]"))]
    (out_dir / "poi.json").write_text(json.dumps(poi))
    print(f"[export] {len(poi)} test spots")
