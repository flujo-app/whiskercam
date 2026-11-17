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


def _strip_vertex_colour(material: bpy.types.Material) -> None:
    """Some scans carry vertex colours meant for wind animation. glTF import multiplies them into
    the surface colour (turning leaves black), so wire the pictures straight to the shader instead."""
    if not material.use_nodes:
        return
    nt = material.node_tree
    if not any(n.type == "VERTEX_COLOR" for n in nt.nodes):
        return
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return

    def upstream_image(sock):
        seen, stack = set(), [l.from_node for l in sock.links]
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            if node.type == "TEX_IMAGE" and node.image:
                return node
            for inp in node.inputs:
                stack.extend(l.from_node for l in inp.links)
        return None

    base = bsdf.inputs["Base Color"]
    img = upstream_image(base)
    if img is not None:
        for link in list(base.links):
            nt.links.remove(link)
        nt.links.new(img.outputs["Color"], base)
    alpha = bsdf.inputs["Alpha"]
    for link in list(alpha.links):
        nt.links.remove(link)
    if img is not None and img.image.filepath.lower().endswith(".png") and img.image.depth == 32:
        nt.links.new(img.outputs["Alpha"], alpha)
    else:
        alpha.default_value = 1.0
    for node in [n for n in nt.nodes if n.type == "VERTEX_COLOR"]:
        nt.nodes.remove(node)


# scans that are far heavier than a browser needs: thin them to roughly this many triangles per part
MAX_TRIS = {
    "street_lamp_01": 6000, "fire_hydrant": 5000, "concrete_road_barrier": 6000, "garden_gnome": 5000,
    "potted_plant_01": 12000, "potted_plant_02": 9000, "watering_can_metal_01": 3000, "plastic_bottle_gallon": 2500,
    "ceramic_vase_03": 2500, "concrete_cat_statue": 4000, "planter_box_01": 3500, "planter_box_02": 3500,
    "plastic_crate_02": 3000, "street_rat": 3000, "water_manhole_cover": 2500, "can_rusted": 1500,
    "dandelion_01": 1800, "nettle_plant": 1500, "periwinkle_plant": 1800, "modular_street_seating": 1500,
    "garden_hose_wall_mounted_01": 4000, "security_light": 2500, "utility_box_02": 4000, "utility_box_01": 3500,
    "trashbag": 2500, "compost_bags": 3000, "old_tyre": 2000, "metal_trash_can": 3500,
    "grass_medium_02": 650, "weed_plant_02": 900, "fern_02": 800, "shrub_03": 900, "covered_car": 4600,
}


def _thin(obj: bpy.types.Object, limit: int) -> None:
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if tris <= limit * 1.15:
        return
    mod = obj.modifiers.new("thin", "DECIMATE")
    mod.ratio = limit / tris
    bpy.context.scene.collection.objects.link(obj)
    geo.apply_modifiers(obj)
    bpy.context.scene.collection.objects.unlink(obj)


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
        while obj.data.color_attributes:
            obj.data.color_attributes.remove(obj.data.color_attributes[0])
        for slot in obj.material_slots:
            if slot.material is not None:
                _strip_vertex_colour(slot.material)
                if not slot.material.name.startswith("ph_"):
                    slot.material.name = f"ph_{ph_id}_{slot.material.name}"[:60]
                mat.register_imported(slot.material, ph_id)
        obj["wc_ph"] = ph_id
        if ph_id in MAX_TRIS:
            _thin(obj, MAX_TRIS[ph_id])
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
