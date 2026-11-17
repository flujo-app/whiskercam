"""Test pictures. Nothing here ships; it is how the sets get checked before baking."""
from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector

from . import paths


def camera(sc: bpy.types.Scene, loc, look_at, lens: float = 24.0, fisheye_fov: float | None = None,
           roll_deg: float = 0.0) -> bpy.types.Object:
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    cam.location = loc
    direction = Vector(look_at) - Vector(loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam.rotation_euler.rotate_axis("Z", math.radians(roll_deg))
    cam_data.sensor_width = 36.0
    cam_data.lens = lens
    cam_data.clip_start = 0.01
    cam_data.clip_end = 2000.0
    if fisheye_fov is not None:
        cam_data.type = "PANO"
        # equisolid = a real fisheye lens; the focal length is picked so the long side spans fisheye_fov
        cam_data.panorama_type = "FISHEYE_EQUISOLID"
        cam_data.fisheye_fov = math.radians(200.0)
        cam_data.fisheye_lens = 18.0 / (2.0 * math.sin(math.radians(fisheye_fov) / 4.0))
    sc.camera = cam
    return cam


def still(sc: bpy.types.Scene, name: str, loc, look_at, lens: float = 24.0, res=(960, 540), samples: int = 48,
          exposure: float = 0.0, fisheye_fov: float | None = None, out_dir: Path | None = None,
          roll_deg: float = 0.0) -> Path:
    cam = camera(sc, loc, look_at, lens, fisheye_fov, roll_deg)
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.cycles.samples = samples
    sc.view_settings.exposure = exposure
    sc.render.image_settings.file_format = "JPEG"
    sc.render.image_settings.quality = 90
    out = (out_dir or paths.ensure(paths.BUILD / "stills")) / f"{name}.jpg"
    sc.render.filepath = str(out)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    return out


def top_view(sc: bpy.types.Scene, name: str, centre, width: float, res=(1600, 1000), samples: int = 24,
             exposure: float = 0.0, out_dir: Path | None = None) -> Path:
    """Map-like picture from straight above (no perspective)."""
    cam_data = bpy.data.cameras.new("top")
    cam = bpy.data.objects.new("top", cam_data)
    sc.collection.objects.link(cam)
    cam.location = (centre[0], centre[1], 200.0)
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = width
    cam_data.clip_end = 1000.0
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.cycles.samples = samples
    sc.view_settings.exposure = exposure
    sc.render.image_settings.file_format = "JPEG"
    out = (out_dir or paths.ensure(paths.BUILD / "stills")) / f"{name}.jpg"
    sc.render.filepath = str(out)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    return out


def catcam(sc: bpy.types.Scene, name: str, loc, heading_deg: float, pitch_deg: float = -8.0,
           res=(540, 960), samples: int = 48, exposure: float = 0.0, out_dir: Path | None = None) -> Path:
    """A picture the way the collar camera sees: ultra wide, upright, a few centimetres off the ground."""
    h = math.radians(heading_deg)
    p = math.radians(pitch_deg)
    look = Vector(loc) + Vector((math.sin(h) * math.cos(p), math.cos(h) * math.cos(p), math.sin(p)))
    return still(sc, name, loc, look, res=res, samples=samples, exposure=exposure, fisheye_fov=138.0, out_dir=out_dir)
