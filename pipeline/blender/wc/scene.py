"""Scene reset, Cycles setup and the sky.

The sky is Blender's simulated clear sky (Nishita model): a cloudless, deep-blue day with
the sun exactly where the level wants it. The sun itself is a separate lamp so that
sunlight (sharp shadows) and skylight (soft fill) can be baked separately.
"""
from __future__ import annotations

import json
import math

import bpy
import numpy as np
from mathutils import Vector

from . import paths

SUN_ELEVATION = 48.0     # degrees above the horizon
SUN_AZIMUTH = 200.0      # compass bearing of the sun: 0 = north (+Y), 90 = east (+X)
SUN_TARGET = 10.0        # sunlight strength on a surface facing the sun (scene units)
SUN_COLOR = (1.0, 0.94, 0.85)   # midday sunlight; the sky model alone makes it too orange
SKY_GAIN = 2.0                  # skylight relative to sunlight (clear day, some haze)
SKY = {"air_density": 1.0, "dust_density": 0.6, "ozone_density": 2.0, "altitude": 0.0}


def reset() -> bpy.types.Scene:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    sc.unit_settings.scale_length = 1.0
    return sc


def setup_cycles(sc: bpy.types.Scene, samples: int = 64, use_gpu: bool = True) -> None:
    sc.render.engine = "CYCLES"
    if use_gpu:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        for dev in prefs.devices:
            dev.use = dev.type == "OPTIX"
        sc.cycles.device = "GPU"
    cy = sc.cycles
    cy.samples = samples
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.02
    cy.use_denoising = True
    cy.denoiser = "OPENIMAGEDENOISE"
    cy.max_bounces = 6
    cy.diffuse_bounces = 4
    cy.glossy_bounces = 3
    cy.transmission_bounces = 4
    cy.transparent_max_bounces = 16
    cy.sample_clamp_indirect = 8.0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    sc.render.use_persistent_data = False
    sc.view_settings.view_transform = "AgX"
    try:
        sc.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass


def sun_vector(elevation_deg: float = SUN_ELEVATION, azimuth_deg: float = SUN_AZIMUTH) -> Vector:
    """Unit vector from the ground towards the sun."""
    el, az = math.radians(elevation_deg), math.radians(azimuth_deg)
    return Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))


def _world(sc: bpy.types.Scene, sun_disc: bool, strength: float, elevation: float, azimuth: float):
    world = bpy.data.worlds.get("sky") or bpy.data.worlds.new("sky")
    world.use_nodes = True
    sc.world = world
    nt = world.node_tree
    nt.nodes.clear()
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_disc = sun_disc
    sky.sun_elevation = math.radians(elevation)
    # the node measures its rotation from +Y towards +X, like a compass bearing
    sky.sun_rotation = math.radians(azimuth)
    sky.sun_size = math.radians(0.545)
    for key, val in SKY.items():
        setattr(sky, key, val)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = strength
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return world


def _measure(sc: bpy.types.Scene) -> np.ndarray:
    """Light arriving on a flat white floor, in the same units as a lamp's strength."""
    mesh = bpy.data.meshes.new("probe")
    mesh.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
    uv = mesh.uv_layers.new(name="uv")
    for i, co in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
        uv.data[i].uv = co
    obj = bpy.data.objects.new("probe", mesh)
    sc.collection.objects.link(obj)
    m = bpy.data.materials.new("probe")
    m.use_nodes = True
    node = m.node_tree.nodes.new("ShaderNodeTexImage")
    img = bpy.data.images.new("probe", 8, 8, float_buffer=True, alpha=False)
    node.image = img
    m.node_tree.nodes.active = node
    mesh.materials.append(m)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    old = sc.cycles.samples, sc.cycles.use_adaptive_sampling
    sc.cycles.samples, sc.cycles.use_adaptive_sampling = 1024, False
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT"}, margin=0, use_clear=True)
    sc.cycles.samples, sc.cycles.use_adaptive_sampling = old
    px = np.array(img.pixels[:], dtype=np.float64).reshape(-1, 4)[:, :3].mean(axis=0)
    bpy.data.objects.remove(obj)
    bpy.data.meshes.remove(mesh)
    bpy.data.materials.remove(m)
    bpy.data.images.remove(img)
    return px * math.pi   # the bake stores light / pi (what a white surface sends back)


def setup_sky(sc: bpy.types.Scene, elevation: float = SUN_ELEVATION, azimuth: float = SUN_AZIMUTH) -> dict:
    """Create the sky world and the sun lamp. Returns the numbers the game needs."""
    cache = paths.ensure(paths.BUILD / "sky") / f"nishita_{elevation:.0f}_{azimuth:.0f}.json"
    key = json.dumps(SKY, sort_keys=True) + f"|{SUN_TARGET}|{SUN_COLOR}|{SKY_GAIN}"
    info = None
    if cache.exists():
        info = json.loads(cache.read_text())
        if info.get("key") != key:
            info = None
    if info is None:
        if sc.render.engine != "CYCLES":
            setup_cycles(sc)
        _world(sc, True, 1.0, elevation, azimuth)
        with_sun = _measure(sc)
        _world(sc, False, 1.0, elevation, azimuth)
        sky_only = _measure(sc)
        sun_flat = with_sun - sky_only
        sun_normal = sun_flat / math.sin(math.radians(elevation))
        k = SUN_TARGET / float(sun_normal.max()) * SKY_GAIN
        info = {
            "key": key,
            "elevation": elevation,
            "azimuth": azimuth,
            "world_strength": k,
            "sun_irradiance": [SUN_TARGET * c for c in SUN_COLOR],
            "sky_irradiance_up": [float(v * k) for v in sky_only],
        }
        cache.write_text(json.dumps(info, indent=1))
        print(f"[sky] measured: sun {info['sun_irradiance']}, sky {info['sky_irradiance_up']}, strength {k:.5f}")

    _world(sc, False, info["world_strength"], elevation, azimuth)
    sun_dir = sun_vector(elevation, azimuth)
    irr = info["sun_irradiance"]
    strength = max(irr)
    light = bpy.data.lights.new("sun", "SUN")
    light.energy = strength
    light.color = [c / strength for c in irr]
    light.angle = math.radians(0.7)
    sun = bpy.data.objects.new("sun", light)
    sc.collection.objects.link(sun)
    sun.rotation_euler = sun_dir.to_track_quat("Z", "Y").to_euler()
    out = dict(info)
    out["sun_dir"] = [sun_dir.x, sun_dir.y, sun_dir.z]
    sc["wc_sky"] = json.dumps(out)
    return out


def sky_info(sc: bpy.types.Scene) -> dict:
    return json.loads(sc["wc_sky"])


def sun_object(sc: bpy.types.Scene) -> bpy.types.Object:
    return sc.objects["sun"]
