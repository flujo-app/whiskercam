"""Material library shared by Blender (for baking and test pictures) and the game.

Every material carries a small description in custom properties ("wc_*"). wc.export
writes those descriptions to materials.json, and the game rebuilds the same material
from it, so the Blender look and the in-game look come from one definition.

Kinds:
  tile    - scanned tiling surface from Poly Haven (UVs in metres, `size` = metres per repeat)
  unique  - scanned object with its own textures (UVs as authored)
  flat    - plain colour / roughness / metalness
  glass   - window glass (dark, mirror-like)
  paint   - car paint (colour + clear coat)
  leaf    - foliage (lit from both sides, light shines through)
"""
from __future__ import annotations

import json

import bpy

from . import paths

# name -> definition.  `ph` is the Poly Haven texture id.
TILES: dict[str, dict] = {
    # roads and paths
    "asphalt": {"ph": "asphalt_04", "tint": (0.62, 0.62, 0.63)},
    "asphalt_old": {"ph": "tarred_gravel"},
    "asphalt_worn": {"ph": "worn_asphalt"},
    "asphalt_patch": {"ph": "asphalt_01"},
    "asphalt_cracked": {"ph": "asphalt_02"},
    "asphalt_damaged": {"ph": "road_damaged_clean"},
    "pavers": {"ph": "concrete_pavers"},
    "pavers_interlock": {"ph": "interlocking_concrete_pavers"},
    "pavers_square": {"ph": "square_concrete_pavers"},
    "pavers_red": {"ph": "red_brick_pavers"},
    "concrete_floor": {"ph": "concrete_floor_worn_001"},
    "concrete_brushed": {"ph": "brushed_concrete"},
    "concrete_wall": {"ph": "concrete_wall_008"},
    "concrete_dirty": {"ph": "dirty_concrete"},
    # walls
    "plaster_white": {"ph": "white_plaster_02"},
    "plaster_yellow": {"ph": "yellow_plaster"},
    "plaster_painted": {"ph": "painted_plaster_wall"},
    "plaster_grey": {"ph": "grey_plaster_02"},
    "facade_tiles": {"ph": "rectangular_facade_tiles"},
    "facade_concrete_tiles": {"ph": "concrete_tile_facade"},
    "block_wall": {"ph": "concrete_block_wall"},
    "bricks_white": {"ph": "white_bricks"},
    "bricks_red": {"ph": "red_brick_03"},
    # metal
    "shutter": {"ph": "painted_metal_shutter"},
    "metal_profile": {"ph": "box_profile_metal_sheet"},
    "corrugated": {"ph": "corrugated_iron"},
    "metal_plate": {"ph": "metal_plate"},
    "metal_grate": {"ph": "metal_grate_rusty"},
    "metal_rusty": {"ph": "rusty_metal_02"},
    # wood
    "deck": {"ph": "weathered_planks"},
    "deck_red": {"ph": "wood_floor_deck"},
    "planks_weathered": {"ph": "weathered_planks"},
    "planks_grey": {"ph": "wood_planks_grey"},
    # ground
    "grass": {"ph": "forrest_ground_01"},
    "grass_leafy": {"ph": "leafy_grass"},
    "grass_sparse": {"ph": "sparse_grass"},
    "dirt": {"ph": "park_dirt"},
    "mud_leaves": {"ph": "brown_mud_leaves_01"},
    "wood_chips": {"ph": "wood_chips"},
    "gravel": {"ph": "gravel_floor_02"},
    # bark and cloth
    "bark": {"ph": "bark_brown_02"},
    "bark_zelkova": {"ph": "japanese_zelkova_bark"},
    "linen": {"ph": "rough_linen"},
    "roof_tiles": {"ph": "grey_roof_tiles_02"},
    "bitumen": {"ph": "bitumen"},
}

FLATS: dict[str, dict] = {
    "paint_yellow": {"color": (0.78, 0.56, 0.05), "rough": 0.62},
    "paint_white": {"color": (0.82, 0.82, 0.80), "rough": 0.6},
    "paint_red": {"color": (0.55, 0.07, 0.05), "rough": 0.5},
    "paint_blue": {"color": (0.10, 0.22, 0.42), "rough": 0.45},
    "paint_green": {"color": (0.09, 0.26, 0.14), "rough": 0.5},
    "paint_grey": {"color": (0.35, 0.36, 0.37), "rough": 0.55},
    "paint_black": {"color": (0.03, 0.03, 0.03), "rough": 0.45},
    "plastic_grey": {"color": (0.42, 0.43, 0.44), "rough": 0.5},
    "plastic_white": {"color": (0.80, 0.80, 0.78), "rough": 0.4},
    "plastic_black": {"color": (0.025, 0.025, 0.025), "rough": 0.55},
    "plastic_green": {"color": (0.06, 0.25, 0.10), "rough": 0.45},
    "plastic_blue": {"color": (0.05, 0.15, 0.45), "rough": 0.45},
    "pvc_pipe": {"color": (0.62, 0.62, 0.60), "rough": 0.45},
    "pvc_yellow": {"color": (0.80, 0.62, 0.08), "rough": 0.45},
    "rubber": {"color": (0.022, 0.022, 0.022), "rough": 0.85},
    "steel": {"color": (0.55, 0.56, 0.58), "rough": 0.38, "metal": 1.0},
    "steel_dark": {"color": (0.18, 0.18, 0.19), "rough": 0.5, "metal": 1.0},
    "aluminium": {"color": (0.78, 0.79, 0.80), "rough": 0.32, "metal": 1.0},
    "chrome": {"color": (0.86, 0.86, 0.86), "rough": 0.08, "metal": 1.0},
    "galvanised": {"color": (0.60, 0.61, 0.62), "rough": 0.5, "metal": 1.0},
    "window_frame": {"color": (0.72, 0.72, 0.70), "rough": 0.4},
    "window_frame_dark": {"color": (0.12, 0.12, 0.12), "rough": 0.4},
    "curtain_cream": {"color": (0.72, 0.66, 0.55), "rough": 0.9},
    "curtain_blue": {"color": (0.30, 0.38, 0.50), "rough": 0.9},
    "interior_dark": {"color": (0.03, 0.03, 0.035), "rough": 0.9},
    "hedge_core": {"color": (0.035, 0.05, 0.02), "rough": 0.95},
    "fabric_canopy": {"color": (0.72, 0.68, 0.60), "rough": 0.8},
    "fabric_cover_grey": {"color": (0.45, 0.46, 0.47), "rough": 0.75},
    "fabric_cover_silver": {"color": (0.62, 0.63, 0.64), "rough": 0.55},
    "light_red": {"color": (0.45, 0.02, 0.02), "rough": 0.25},
    "light_clear": {"color": (0.85, 0.85, 0.85), "rough": 0.15},
    "terracotta": {"color": (0.55, 0.26, 0.15), "rough": 0.8},
}

GLASS: dict[str, dict] = {
    "glass_window": {"color": (0.02, 0.025, 0.03), "rough": 0.03},
    "glass_car": {"color": (0.012, 0.014, 0.016), "rough": 0.02},
    # windows with something pale right behind the pane (the game draws glass as a dark mirror, not see-through)
    "glass_curtain_cream": {"color": (0.30, 0.27, 0.22), "rough": 0.05},
    "glass_curtain_white": {"color": (0.42, 0.42, 0.40), "rough": 0.05},
    "glass_blind_grey": {"color": (0.16, 0.17, 0.18), "rough": 0.06},
}

CAR_PAINTS: dict[str, dict] = {
    "car_white": {"color": (0.80, 0.80, 0.78)},
    "car_silver": {"color": (0.52, 0.53, 0.55), "metal": 0.7},
    "car_black": {"color": (0.015, 0.015, 0.018)},
    "car_red": {"color": (0.42, 0.03, 0.03)},
    "car_blue": {"color": (0.04, 0.10, 0.28), "metal": 0.5},
    "car_grey": {"color": (0.16, 0.17, 0.18), "metal": 0.6},
}


def _props(mat: bpy.types.Material, desc: dict) -> None:
    mat["wc"] = json.dumps(desc)


def describe(mat: bpy.types.Material) -> dict | None:
    raw = mat.get("wc")
    return json.loads(raw) if raw else None


def _principled(name: str):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    return mat, nt, bsdf


def _image(path, colorspace: str) -> bpy.types.Image:
    img = bpy.data.images.load(str(path), check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


def _tile_size(ph_id: str) -> float:
    info = json.loads((paths.PH / "textures" / ph_id / "info.json").read_text(encoding="utf-8"))
    dims = info.get("dimensions") or [2000, 2000]
    return round(max(dims[0], dims[1]) / 1000.0, 3)


def _make_tile(name: str, d: dict) -> bpy.types.Material:
    ph_id = d["ph"]
    size = d.get("size") or _tile_size(ph_id)
    tex_dir = paths.PH / "textures" / ph_id
    mat, nt, bsdf = _principled(name)
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "uv0"
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.0 / size, 1.0 / size, 1.0)
    nt.links.new(uv.outputs["UV"], mapping.inputs["Vector"])

    def tex(kind: str, colorspace: str):
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = _image(tex_dir / f"{ph_id}_{kind}_1k.jpg", colorspace)
        nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
        return node

    diff = tex("Diffuse", "sRGB")
    if "tint" in d:
        mul = nt.nodes.new("ShaderNodeMix")
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 1.0
        mul.inputs["B"].default_value = (*d["tint"], 1.0)
        nt.links.new(diff.outputs["Color"], mul.inputs["A"])
        nt.links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
    else:
        nt.links.new(diff.outputs["Color"], bsdf.inputs["Base Color"])
    arm = tex("arm", "Non-Color")
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(arm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nor = tex("nor_gl", "Non-Color")
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.uv_map = "uv0"
    nt.links.new(nor.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    desc = {"kind": "tile", "ph": ph_id, "size": size}
    for key in ("tint", "rough_mul", "normal_scale"):
        if key in d:
            desc[key] = d[key]
    _props(mat, desc)
    return mat


def _make_flat(name: str, d: dict, kind: str = "flat") -> bpy.types.Material:
    mat, _, bsdf = _principled(name)
    color = d["color"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = d.get("rough", 0.5)
    bsdf.inputs["Metallic"].default_value = d.get("metal", 0.0)
    desc = {"kind": kind, "color": list(color), "rough": d.get("rough", 0.5), "metal": d.get("metal", 0.0)}
    if kind == "paint":
        bsdf.inputs["Roughness"].default_value = 0.35
        bsdf.inputs["Coat Weight"].default_value = 1.0
        bsdf.inputs["Coat Roughness"].default_value = 0.04
        desc["rough"] = 0.35
    _props(mat, desc)
    return mat


def get(name: str) -> bpy.types.Material:
    """Fetch (or create) a library material by name."""
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    if name in TILES:
        return _make_tile(name, TILES[name])
    if name in FLATS:
        return _make_flat(name, FLATS[name])
    if name in GLASS:
        return _make_flat(name, GLASS[name], "glass")
    if name in CAR_PAINTS:
        return _make_flat(name, CAR_PAINTS[name], "paint")
    raise KeyError(f"unknown material {name!r}")


def tile(name: str, ph_id: str, **extra) -> bpy.types.Material:
    """One-off scanned tiling surface (registered under `name`); extra: size, tint, rough_mul, normal_scale."""
    m = bpy.data.materials.get(name)
    if m is None:
        m = _make_tile(name, {"ph": ph_id, **extra})
    return m


def flat(name: str, color, rough: float = 0.5, metal: float = 0.0) -> bpy.types.Material:
    """One-off plain material (registered under `name`)."""
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = _make_flat(name, {"color": tuple(color), "rough": rough, "metal": metal})
    return mat


def leaf(name: str, diffuse_path, color_tint=(1.0, 1.0, 1.0)) -> bpy.types.Material:
    """Foliage card material: RGBA picture, cut out by alpha, light shines through."""
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat, nt, bsdf = _principled(name)
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = _image(diffuse_path, "sRGB")
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "uv0"
    nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.55
    # thin leaves pass some light through
    bsdf.inputs["Subsurface Weight"].default_value = 0.0
    trans = nt.nodes.new("ShaderNodeBsdfTranslucent")
    nt.links.new(tex.outputs["Color"], trans.inputs["Color"])
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = 0.35
    out = nt.nodes["Material Output"]
    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix_alpha = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(bsdf.outputs["BSDF"], mix.inputs[1])
    nt.links.new(trans.outputs["BSDF"], mix.inputs[2])
    nt.links.new(tex.outputs["Alpha"], mix_alpha.inputs["Fac"])
    nt.links.new(transp.outputs["BSDF"], mix_alpha.inputs[1])
    nt.links.new(mix.outputs["Shader"], mix_alpha.inputs[2])
    nt.links.new(mix_alpha.outputs["Shader"], out.inputs["Surface"])
    _props(mat, {"kind": "leaf", "diff": str(diffuse_path), "tint": list(color_tint)})
    return mat


def register_imported(mat: bpy.types.Material, ph_id: str) -> None:
    """Describe a material that came with a scanned model (textures found by walking its nodes)."""
    if mat.get("wc") or not mat.use_nodes:
        return
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    desc: dict = {"kind": "unique", "ph": ph_id}
    if bsdf is None:
        _props(mat, desc)
        return

    def find_image(socket_name: str):
        sock = bsdf.inputs.get(socket_name)
        seen = set()
        stack = [l.from_node for l in sock.links] if sock else []
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            if node.type == "TEX_IMAGE" and node.image:
                return node.image
            for inp in node.inputs:
                stack.extend(l.from_node for l in inp.links)
        return None

    for key, sock in (("diff", "Base Color"), ("nor", "Normal"), ("arm", "Roughness")):
        img = find_image(sock)
        if img is not None:
            desc[key] = bpy.path.abspath(img.filepath)
    if "diff" not in desc:
        desc["color"] = list(bsdf.inputs["Base Color"].default_value[:3])
    if "arm" not in desc:
        desc["rough"] = bsdf.inputs["Roughness"].default_value
        desc["metal"] = bsdf.inputs["Metallic"].default_value
    alpha = bsdf.inputs.get("Alpha")
    if alpha is not None and alpha.links:
        desc["alpha"] = "clip"
    _props(mat, desc)
