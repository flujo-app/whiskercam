"""Lay out light-map UVs for a set of meshes with xatlas (run with build/pyenv python).

Blender cannot load xatlas itself, so wc.bake writes the triangles to an .npz file,
calls this script and reads the UVs back.

  python tools/atlas.py in.npz out.npz

in.npz:  n (mesh count), res (atlas size in texels), padding, pos_<k> (V,3 float32), idx_<k> (T,3 uint32)
         Positions are pre-scaled by each mesh's detail weight (bigger = more texels).
out.npz: uv_<k> (T,3,2 float32, per triangle corner, 0..1), texels_per_unit, charts
"""
import sys
import time

import numpy as np
import xatlas


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    data = np.load(src)
    n = int(data["n"])
    res = int(data["res"])
    padding = int(data["padding"])
    atlas = xatlas.Atlas()
    for k in range(n):
        atlas.add_mesh(np.ascontiguousarray(data[f"pos_{k}"], dtype=np.float32),
                       np.ascontiguousarray(data[f"idx_{k}"], dtype=np.uint32))
    chart = xatlas.ChartOptions()
    chart.max_iterations = 2
    pack = xatlas.PackOptions()
    pack.resolution = res
    pack.padding = padding
    pack.texels_per_unit = 0.0      # 0 = as dense as fits into one atlas of `res`
    pack.bilinear = True
    pack.blockAlign = False
    pack.bruteForce = False
    pack.rotate_charts = True
    started = time.time()
    atlas.generate(chart_options=chart, pack_options=pack)
    out = {"charts": atlas.chart_count, "atlases": atlas.atlas_count, "width": atlas.width, "height": atlas.height}
    area3d = 0.0
    area_uv = 0.0
    for k in range(n):
        vmap, idx, uvs = atlas[k]
        src_idx = data[f"idx_{k}"]
        if not (vmap[idx] == src_idx).all():
            raise SystemExit(f"mesh {k}: xatlas changed the triangle order")
        corner_uv = uvs[idx].astype(np.float32)          # (T, 3, 2)
        out[f"uv_{k}"] = corner_uv
        p = data[f"pos_{k}"][src_idx]
        area3d += float(np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1).sum() / 2)
        a, b, c = corner_uv[:, 0], corner_uv[:, 1], corner_uv[:, 2]
        area_uv += float(np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])).sum() / 2)
    out["texels_per_unit"] = float(np.sqrt(area_uv / max(area3d, 1e-9)) * res)
    out["fill"] = area_uv
    np.savez(dst, **out)
    print(f"[atlas] {n} meshes, {atlas.chart_count} charts, {out['texels_per_unit']:.1f} texels/unit, "
          f"fill {area_uv:.2f}, {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
