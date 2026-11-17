"""Print the parts of scanned models with their sizes (to plan where they go).

  run.py -- list_parts <polyhaven id> ...
"""
from wc import ph, scene


def main(args: list[str]) -> None:
    scene.reset()
    for ph_id in args:
        for o in ph.load(ph_id):
            lo, hi = ph.bounds([o])
            s = hi - lo
            tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
            print(f"[parts] {ph_id} | {o.name}: {s.x:.2f} x {s.y:.2f} x {s.z:.2f} m, z from {lo.z:.2f}, {tris} tris")
