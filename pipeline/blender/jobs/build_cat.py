"""Build the cat, paint its coats, export it for the game and render check pictures.

  run.py -- build_cat [--samples N] [--faces N] [--only GROUPS] [--blend]

GROUPS (comma separated, default all): bare, fur, coats, poses, deform, catcam
Writes build/export/cats/ (cat.glb + pictures) and build/stage/cat/ (check pictures).
"""
import argparse
import json
import math
import struct
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector
from shapely.geometry import box

from assets import cat as C
from wc import geo, mat, paths, render, scene

OUT = paths.BUILD / "export" / "cats"
STAGE = paths.BUILD / "stage" / "cat"

SUN_SIDE = 232.0    # compass bearing from the subject to the camera: just beside the sun (at 200)

# view: (bearing of the camera as seen from the cat (0 = in front, 90 = its right), elevation, distance, target, lens)
VIEWS = {
    "side": (90.0, 5.0, 1.85, (0.0, -0.10, 0.165), 70.0),
    "front": (0.0, 8.0, 1.15, (0.0, 0.10, 0.18), 70.0),
    "back": (180.0, 12.0, 1.25, (0.0, -0.15, 0.17), 70.0),
    "top": (90.0, 80.0, 1.9, (0.0, -0.10, 0.12), 70.0),
    "threequarter": (42.0, 16.0, 1.6, (0.0, -0.05, 0.16), 70.0),
    "face": (20.0, 6.0, 0.62, (0.0, 0.209, 0.256), 70.0),
    "profile": (90.0, 3.0, 0.55, (0.0, 0.200, 0.255), 70.0),
}


def log(*a):
    print("[cat]", *a, flush=True)


def place(rig, local_bearing: float, at=(0.0, 0.0, 0.0)) -> None:
    """Turn the cat so that a camera at SUN_SIDE sees it from `local_bearing`."""
    rig.rotation_euler = (0.0, 0.0, math.radians(local_bearing - SUN_SIDE))
    rig.location = at
    bpy.context.view_layer.update()


def shot(sc, name, rig, view, samples, res=(640, 480), target=None, dist=None, elev=None):
    bearing, el, d, tgt, lens = VIEWS[view]
    el = el if elev is None else elev
    d = d if dist is None else dist
    tgt = tgt if target is None else target
    place(rig, bearing)
    t = rig.matrix_world @ Vector(tgt)
    b, e = math.radians(SUN_SIDE), math.radians(el)
    loc = t + Vector((math.sin(b) * math.cos(e), math.cos(b) * math.cos(e), math.sin(e))) * d
    t0 = time.time()
    out = render.still(sc, name, loc, t, lens=lens, res=res, samples=samples, out_dir=STAGE)
    log(f"render {out.name} ({time.time() - t0:.1f}s)")
    return out


# ---------------------------------------------------------------- export + checks

def export_glb(cat: C.Cat, path) -> None:
    C.apply_pose(cat.rig, None)
    cat.rig.rotation_euler = (0.0, 0.0, 0.0)
    cat.rig.location = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    geo.select_only([cat.rig, cat.body, cat.eyes])
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_materials="EXPORT", export_image_format="NONE", export_texcoords=True, export_normals=True,
        export_tangents=False, export_yup=True, export_apply=False, export_extras=False, export_cameras=False,
        export_lights=False, export_animations=False, export_skins=True, export_all_influences=False,
        export_morph=False, export_vertex_color="NONE", export_def_bones=False,
    )
    log(f"exported {path} ({path.stat().st_size // 1024} KB)")


def glb_json(path) -> dict:
    data = path.read_bytes()
    clen, _ = struct.unpack_from("<II", data, 12)
    return json.loads(data[20:20 + clen])


def check_glb_axes(path) -> None:
    """Joint X axes in the exported file (glTF space: +X = the cat's right, +Y up, the cat looks along -Z)."""
    js = glb_json(path)
    nodes = js["nodes"]
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i

    def local(i):
        n = nodes[i]
        x, y, z, w = n.get("rotation", [0, 0, 0, 1])
        from mathutils import Quaternion
        q = Quaternion((w, x, y, z))
        M = q.to_matrix().to_4x4()
        t = n.get("translation", [0, 0, 0])
        M.translation = Vector(t)
        return M

    def world(i):
        M = local(i)
        while i in parent:
            i = parent[i]
            M = local(i) @ M
        return M

    joints = js["skins"][0]["joints"]
    worst = 1.0
    rows = []
    for j in joints:
        Mw = world(j)
        xa = (Mw.to_3x3() @ Vector((1, 0, 0))).normalized()
        worst = min(worst, xa.x)
        rows.append((nodes[j]["name"], xa))
    log(f"glb: {len(joints)} joints, materials {[m['name'] for m in js.get('materials', [])]}, "
        f"images {len(js.get('images', []))}, animations {len(js.get('animations', []))}")
    log(f"glb joint X axes vs glTF +X: worst dot {worst:.4f}")
    for name, xa in rows:
        if name in ("root", "hips", "head", "ear.L", "upperarm.L", "upperarm.R", "shin.L", "tail3"):
            log(f"   glb {name:12s} X = ({xa.x:+.3f}, {xa.y:+.3f}, {xa.z:+.3f})")


def reimport(path) -> None:
    scene.reset()
    bpy.ops.import_scene.gltf(filepath=str(path))
    for o in bpy.context.scene.objects:
        if o.type == "ARMATURE":
            log(f"re-import armature {o.name}: {len(o.data.bones)} bones: {', '.join(b.name for b in o.data.bones)}")
        elif o.type == "MESH":
            if o.parent is None and not o.vertex_groups:
                continue          # the importer's own bone-display shape, not part of the file
            me = o.data
            tris = sum(len(p.vertices) - 2 for p in me.polygons)
            log(f"re-import mesh {o.name}: {len(me.vertices)} verts, {tris} triangles, uv {[u.name for u in me.uv_layers]}, "
                f"materials {[m.name for m in me.materials]}, {len(o.vertex_groups)} vertex groups")


def print_bones(rig) -> None:
    log("bones (rest, metres; head -> tail; local X axis):")
    for b in rig.data.bones:
        h, t = b.head_local, b.tail_local
        x = b.matrix_local.col[0].xyz
        log(f"   {b.name:11s} ({h.x:+.4f}, {h.y:+.4f}, {h.z:+.4f}) -> ({t.x:+.4f}, {t.y:+.4f}, {t.z:+.4f})  "
            f"X=({x.x:+.3f},{x.y:+.3f},{x.z:+.3f})  parent {b.parent.name if b.parent else '-'}")
    for name in ("upperarm.L", "upperarm.R", "thigh.L", "head"):
        M = rig.data.bones[name].matrix_local
        log(f"   matrix_local {name}: " + " | ".join(f"{M[i][0]:+.3f} {M[i][1]:+.3f} {M[i][2]:+.3f} {M[i][3]:+.3f}" for i in range(3)))


def rotation_signs(rig) -> None:
    """Rotate each leg joint +20 degrees about its local X and see which way the paw goes."""
    log("rotation signs (+20 deg about local X; movement of the end of the leg):")
    chains = {
        "front": ["scapula", "upperarm", "forearm", "wrist", "paw"],
        "hind": ["thigh", "shin", "hock", "hindpaw"],
    }
    for side in ("L", "R"):
        for leg, bones in chains.items():
            tip = f"{bones[-1]}.{side}"
            for b in bones:
                C.apply_pose(rig, None)
                p0 = rig.pose.bones[tip].tail.copy()
                b0 = rig.pose.bones[f"{b}.{side}"].tail.copy()
                rig.pose.bones[f"{b}.{side}"].rotation_euler = (math.radians(20), 0, 0)
                bpy.context.view_layer.update()
                d = rig.pose.bones[tip].tail - p0
                db = rig.pose.bones[f"{b}.{side}"].tail - b0
                log(f"   {b + '.' + side:11s} bone end moves ({db.y * 1000:+5.1f} fwd, {db.z * 1000:+5.1f} up) mm, "
                    f"paw tip ({d.y * 1000:+5.1f} fwd, {d.z * 1000:+5.1f} up) mm -> + swings {'FORWARD' if db.y > 0 else 'BACK'}")
    C.apply_pose(rig, None)


# ---------------------------------------------------------------- scene pieces

def setup_scene(samples: int):
    sc = scene.reset()
    scene.setup_cycles(sc, samples=samples)
    scene.setup_sky(sc)
    coll = geo.collection("stage")
    g = geo.flat_polygon("ground", box(-4, -4, 4, 4), -0.0004, mat.get("pavers"), coll)
    g["wc_role"] = "ground"
    return sc


def coats_lineup(sc, cat: C.Cat, samples: int) -> None:
    coll = geo.collection("coats")
    cat.body.hide_render = True
    cat.eyes.hide_render = True
    bearing = 40.0
    right = Vector((math.cos(math.radians(SUN_SIDE)), -math.sin(math.radians(SUN_SIDE)), 0.0))
    away = -Vector((math.sin(math.radians(SUN_SIDE)), math.cos(math.radians(SUN_SIDE)), 0.0))
    made = []
    for i, coat in enumerate(C.COATS):
        row, colm = divmod(i, 3)
        at = right * ((1 - colm) * 0.56) + away * ((1 - row) * 0.75)
        rot = Matrix.Translation(at) @ Matrix.Rotation(math.radians(bearing - SUN_SIDE), 4, "Z")
        m = C.body_material(f"cat_body_{coat}", cat.images[f"cat_{coat}_diff"], cat.images["cat_fur"])
        for src in (cat.body, cat.eyes):
            o = src.copy()
            o.modifiers.clear()
            o.parent = None
            o.hide_render = False
            o.matrix_world = rot
            coll.objects.link(o)
            if src is cat.body:
                o.material_slots[0].link = "OBJECT"
                o.material_slots[0].material = m
            made.append(o)
    bpy.context.view_layer.update()
    tgt = right * 0.0 + away * 0.37 + Vector((0, 0, 0.14))
    b, e = math.radians(SUN_SIDE), math.radians(24.0)
    loc = tgt + Vector((math.sin(b) * math.cos(e), math.cos(b) * math.cos(e), math.sin(e))) * 3.1
    t0 = time.time()
    out = render.still(sc, "coats", loc, tgt, lens=58, res=(640, 480), samples=samples, out_dir=STAGE)
    log(f"render {out.name} ({time.time() - t0:.1f}s)")
    for o in made:
        bpy.data.objects.remove(o)
    cat.body.hide_render = False
    cat.eyes.hide_render = False


def pose_shots(sc, cat: C.Cat, samples: int) -> None:
    plan = [
        ("pose_sit", "sit", "threequarter", dict(target=(0.0, -0.03, 0.15), dist=1.5)),
        ("pose_crouch", "crouch", "side", dict(target=(0.0, -0.09, 0.10), dist=1.7)),
        ("pose_gallop_stretch", "gallop_stretch", "side", dict(target=(0.0, -0.10, 0.16), dist=2.1)),
        ("pose_gallop_gather", "gallop_gather", "side", dict(target=(0.0, -0.06, 0.16), dist=1.7)),
        ("pose_slap", "slap", "threequarter", dict(target=(0.0, 0.0, 0.18), dist=1.4)),
        ("pose_head_turn", "head_turn", "threequarter", dict(target=(0.0, 0.05, 0.2), dist=1.2, elev=22.0)),
    ]
    for name, pose, view, kw in plan:
        p = C.POSES.get(pose) or {}
        C.apply_pose(cat.rig, p)
        C.ground(cat.rig, cat.body)
        shot(sc, name, cat.rig, view, samples, **kw)
    C.apply_pose(cat.rig, None)


def deform_shots(sc, cat: C.Cat, samples: int) -> None:
    """Close-ups of the joints that bend most, in plain grey so the surface shows."""
    clay = C.body_material("cat_clay", None, None)
    clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.45, 0.43, 0.41, 1.0)
    cat.body.material_slots[0].link = "OBJECT"
    cat.body.material_slots[0].material = clay
    plan = [
        ("deform_shoulder_elbow", "gallop_stretch", "side", dict(target=(0.0, 0.10, 0.13), dist=0.75)),
        ("deform_knee_hip", "gallop_gather", "side", dict(target=(0.0, -0.11, 0.13), dist=0.75)),
        ("deform_neck", "head_turn", "threequarter", dict(target=(0.0, 0.14, 0.22), dist=0.7, elev=30.0)),
        ("deform_sit_haunch", "sit", "side", dict(target=(0.0, -0.08, 0.10), dist=0.8)),
    ]
    for name, pose, view, kw in plan:
        C.apply_pose(cat.rig, C.POSES[pose])
        C.ground(cat.rig, cat.body)
        shot(sc, name, cat.rig, view, samples, **kw)
    C.apply_pose(cat.rig, None)
    cat.body.material_slots[0].link = "DATA"


def catcam_shot(sc, cat: C.Cat, samples: int) -> None:
    """The player's view: collar camera 2 cm in front of the throat, looking forward and a little down."""
    C.apply_pose(cat.rig, C.POSES["walk"])
    C.ground(cat.rig, cat.body)
    rig = cat.rig
    rig.rotation_euler = (0.0, 0.0, math.radians(-25.0))     # facing away from the sun: own shadow in front
    rig.location = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    neck = rig.pose.bones["neck"]
    M = rig.matrix_world @ neck.matrix @ neck.bone.matrix_local.inverted()
    # walk out of the body from inside the jaw, forwards-down, until we leave the skin: that is the throat
    normal = np.array((0.0, 0.35, -0.94))
    normal /= np.linalg.norm(normal)
    start = np.array(C.hd((0.0, 0.214, 0.242)))
    steps = start + normal * np.arange(0.0, 0.08, 0.0005)[:, None]
    outside = np.nonzero(cat.shape.sdf(steps) > 0.0)[0]
    throat = Vector(steps[outside[0]] if len(outside) else start)
    cam = M @ (throat + Vector(normal) * 0.02)
    log(f"collar camera: throat at {tuple(round(v, 3) for v in throat)} (rest pose)")
    fwd = (M.to_3x3() @ Vector((0.0, 1.0, 0.0)))
    fwd.z = 0.0
    fwd.normalize()
    pitch = math.radians(-18.0)
    look = cam + Vector((fwd.x * math.cos(pitch), fwd.y * math.cos(pitch), math.sin(pitch)))
    t0 = time.time()
    out = render.still(sc, "catcam", cam, look, res=(480, 640), samples=samples, fisheye_fov=150.0, out_dir=STAGE)
    log(f"render {out.name} ({time.time() - t0:.1f}s); camera at {tuple(round(v, 3) for v in cam)}")
    C.apply_pose(cat.rig, None)
    rig.rotation_euler = (0.0, 0.0, 0.0)


# ---------------------------------------------------------------- main

def main(args: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=40)
    ap.add_argument("--faces", type=int, default=3500)
    ap.add_argument("--only", default="bare,fur,coats,poses,deform,catcam")
    ap.add_argument("--views", default="side,front,back,top,threequarter,face,profile")
    ap.add_argument("--blend", action="store_true", help="save the scene to the scratch .blend for debugging")
    ap.add_argument("--clay", action="store_true", help="plain grey body in the bare views (to judge the shape)")
    opt = ap.parse_args(args)
    groups = set(opt.only.split(",")) if opt.only else set()
    views = [v for v in opt.views.split(",") if v]

    paths.ensure(OUT)
    paths.ensure(STAGE)
    sc = setup_scene(opt.samples)
    coll = geo.collection("cat")
    cat = C.build(coll, opt.faces)
    C.paint(cat, OUT)
    cat.body.data.materials.append(C.body_material("cat_body", cat.images["cat_tabby_diff"], cat.images["cat_fur"]))
    cat.eyes.data.materials.append(C.eye_material(cat.images["cat_eyes"]))
    tris = sum(len(p.vertices) - 2 for p in cat.body.data.polygons)
    etris = sum(len(p.vertices) - 2 for p in cat.eyes.data.polygons)
    log(f"CatBody {len(cat.body.data.vertices)} verts / {tris} triangles; CatEyes {len(cat.eyes.data.vertices)} verts / {etris} triangles")

    print_bones(cat.rig)
    rotation_signs(cat.rig)
    glb = OUT / "cat.glb"
    export_glb(cat, glb)
    check_glb_axes(glb)

    if opt.blend:
        bpy.ops.wm.save_as_mainfile(filepath=str(paths.BUILD / "tmp" / "cat_debug.blend"))

    if "bare" in groups:
        if opt.clay:
            clay = C.body_material("cat_clay", None, None)
            clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.42, 0.42, 0.42, 1.0)
            cat.body.material_slots[0].link = "OBJECT"
            cat.body.material_slots[0].material = clay
        for v in views:
            shot(sc, f"{'clay' if opt.clay else 'bare'}_{v}", cat.rig, v, opt.samples)
        if opt.clay:
            cat.body.material_slots[0].link = "DATA"
    if "poses" in groups:
        pose_shots(sc, cat, opt.samples)
    if "deform" in groups:
        deform_shots(sc, cat, opt.samples)
    if "catcam" in groups:
        catcam_shot(sc, cat, opt.samples)
    if "coats" in groups:
        coats_lineup(sc, cat, opt.samples)
    if "fur" in groups:
        fur = C.fur_preview(cat, "tabby", geo.collection("cat"))
        for v in views:
            shot(sc, f"fur_{v}", cat.rig, v, opt.samples)
        bpy.data.objects.remove(fur)

    reimport(glb)
