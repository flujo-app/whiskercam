"""Scanned models from Poly Haven: import once, then place copies."""
from __future__ import annotations

import json
import math

import bpy
from mathutils import Matrix, Vector

from . import geo, mat, paths

_LIB: dict[str, list[bpy.types.Object]] = {}


def _resolution(ph_id: str) -> str:
    files = [paths.ROOT / "pipeline" / "asset_list.json"] + sorted((paths.ROOT / "pipeline" / "asset_lists").glob("*.json"))
    wanted: dict = {}
    for f in files:
        wanted.update(json.loads(f.read_text(encoding="utf-8")).get("models", {}))
    res = wanted[ph_id]
    return res[0] if isinstance(res, list) else res


def load(ph_id: str) -> list[bpy.types.Object]:
    """Import a model into a hidden library collection. Returns its mesh objects (transforms applied)."""
    if ph_id in _LIB:
        return _LIB[ph_id]
    lib = geo.collection("_library")
    lib.hide_render = True
    lib.hide_viewport = True
    path = paths.PH / "models" / ph_id / _resolution(ph_id) / f"{ph_id}.gltf"
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = []
    for obj in new:
        world = obj.matrix_world.copy()
        for coll in list(obj.users_collection):
            coll.objects.unlink(obj)
        if obj.type != "MESH":
            continue
        lib.objects.link(obj)
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        obj.data.transform(world)
        obj.data.update()
        if obj.data.uv_layers:
            obj.data.uv_layers[0].name = geo.UV0
        for slot in obj.material_slots:
            if slot.material is not None:
                if not slot.material.name.startswith("ph_"):
                    slot.material.name = f"ph_{ph_id}_{slot.material.name}"[:60]
                mat.register_imported(slot.material, ph_id)
        obj["wc_ph"] = ph_id
        meshes.append(obj)
    for obj in new:
        if obj.type != "MESH":
            bpy.data.objects.remove(obj)
    _LIB[ph_id] = meshes
    return meshes


def bounds(objs) -> tuple[Vector, Vector]:
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in objs:
        for corner in obj.bound_box:
            p = obj.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
    return lo, hi


def place(ph_id: str, loc, rot_z_deg: float = 0.0, scale: float = 1.0, coll=None, part: str | None = None,
          name: str | None = None, ground: bool = True) -> list[bpy.types.Object]:
    """Put a copy of a scanned model into the scene.

    part:   only objects whose name contains this text (for kits holding several pieces)
    ground: shift the copy so that its lowest point (and XY centre) sits at `loc`
    """
    src = [o for o in load(ph_id) if part is None or part.lower() in o.name.lower()]
    if not src:
        raise KeyError(f"{ph_id}: no part matching {part!r}")
    lo, hi = bounds(src)
    pivot = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z)) if ground else Vector((0, 0, 0))
    xform = (Matrix.Translation(Vector(loc)) @ Matrix.Rotation(math.radians(rot_z_deg), 4, "Z")
             @ Matrix.Scale(scale, 4) @ Matrix.Translation(-pivot))
    out = []
    for o in src:
        dup = o.copy()  # shares mesh data until wc.bake makes it unique
        (coll or bpy.context.scene.collection).objects.link(dup)
        dup.matrix_world = xform @ o.matrix_world
        dup.name = f"{name or ph_id}.{len(out)}"
        out.append(dup)
    return out


def parts(ph_id: str) -> list[str]:
    return [o.name for o in load(ph_id)]
