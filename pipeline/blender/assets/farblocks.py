"""Far tower blocks: post-war slab blocks 90 to 200 metres away, beyond the estate walls.

At that distance only the outline and the rhythm read: balcony stacks, rows of windows with blinds and
curtains, recessed stair cores with their entrances, floor bands, roof plant and aerials. So everything is
built from plain faces, about 4,000 to 6,000 triangles per block, one object per material.

Two rules come from how the game draws them:
  * The game draws one side of a face only, so every face looks outward (thin things get two faces).
  * The depth buffer is coarse that far away (about 4 cm at 120 m, 12 cm at 200 m). Nothing lies flat on a
    wall: windows, bands and joints are cut into the wall surface (the wall is tiled around them), and
    anything that stands out from a wall stands out by 15 cm or more.

The caller tags the parts role="far" (no baked light, no collision, no light-map space).

  run.py -- stage farblocks [--demo all | b<i> | b<i>@near]     (b7 = the seventh entry of FAR_BLOCKS, alone)
"""
from __future__ import annotations

import math
import random

import bpy
from mathutils import Vector

from wc import geo, mat

FLOOR_H = 2.85
GROUND = 0.6             # the ground floor sits a little above the street
RIM = 0.9                # roof parapet
UP = Vector((0.0, 0.0, 1.0))
DISH_AZIMUTH = 165.0     # every satellite dish in town points at the same satellite (compass bearing)

# (x, y, width, depth, floors, style, turn in degrees). Width runs along local X; the balconies face local -Y.
FAR_BLOCKS = [
    (-78.0, 96.0, 40.0, 13.0, 12, "white", 186.0),
    (6.0, 124.0, 48.0, 13.0, 15, "tile", 175.0),
    (88.0, 92.0, 36.0, 13.0, 11, "yellow", 204.0),
    (128.0, 18.0, 44.0, 13.0, 14, "white", 262.0),
    (112.0, -58.0, 36.0, 13.0, 10, "tile", 300.0),
    (48.0, -112.0, 50.0, 13.0, 16, "white", -8.0),
    (-36.0, -98.0, 42.0, 13.0, 13, "yellow", 5.0),
    (-4.0, -168.0, 46.0, 13.0, 18, "tile", 0.0),
    (-124.0, -34.0, 40.0, 13.0, 12, "tile", 96.0),
    (-110.0, 52.0, 44.0, 13.0, 14, "white", 78.0),
    (-150.0, 128.0, 40.0, 13.0, 17, "yellow", 135.0),
    (160.0, 120.0, 40.0, 13.0, 16, "tile", 225.0),
]

# wall, trim (bands and balcony fronts), how the floors show on the facade
_STYLE = {
    "white": ("plaster_white", "paint_grey", "joints"),
    "yellow": ("plaster_yellow", "paint_white", "bands"),
    "tile": ("facade_tiles", "concrete_brushed", "ledges"),
}

_ACCENTS = ("paint_blue", "paint_red", "paint_green", "paint_yellow", "terracotta", "far_panel_teal")
_LAUNDRY = ("plastic_white", "curtain_blue", "paint_red", "paint_yellow", "fabric_canopy", "terracotta")


def _materials() -> None:
    """The few plain colours the library does not have yet."""
    mat.flat("far_joint", (0.10, 0.10, 0.10), 0.85)
    mat.flat("far_frame_brown", (0.19, 0.10, 0.05), 0.6)
    mat.flat("far_awning_orange", (0.70, 0.28, 0.06), 0.85)
    mat.flat("far_awning_green", (0.08, 0.30, 0.17), 0.85)
    mat.flat("far_panel_teal", (0.07, 0.33, 0.36), 0.6)
    mat.flat("far_plants", (0.07, 0.17, 0.04), 0.95)


# ---------------------------------------------------------------- mesh helpers

class _Mesh:
    """Faces collected per material; turned into one object per material at the end."""

    def __init__(self) -> None:
        self.parts: dict[str, tuple[list, list]] = {}

    def face(self, m: str, pts) -> None:
        vs, fs = self.parts.setdefault(m, ([], []))
        i = len(vs)
        vs.extend((float(p[0]), float(p[1]), float(p[2])) for p in pts)
        fs.append(tuple(range(i, i + len(pts))))

    def quad(self, m: str, p, u, v) -> None:
        """Face p, p+u, p+u+v, p+v; it looks along u x v."""
        p, u, v = Vector(p), Vector(u), Vector(v)
        self.face(m, (p, p + u, p + u + v, p + v))

    def two_sided(self, m: str, p, u, v) -> None:
        p, u, v = Vector(p), Vector(u), Vector(v)
        self.quad(m, p, u, v)
        self.quad(m, p + u, -u, v)

    def box(self, m: str, lo, hi, skip=()) -> None:
        x0, y0, z0 = (min(a, b) for a, b in zip(lo, hi))
        x1, y1, z1 = (max(a, b) for a, b in zip(lo, hi))
        faces = {
            "-z": ((x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)),
            "+z": ((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)),
            "-y": ((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)),
            "+y": ((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)),
            "+x": ((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)),
            "-x": ((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)),
        }
        for key, pts in faces.items():
            if key not in skip:
                self.face(m, pts)

    def pole(self, m: str, x: float, y: float, z0: float, z1: float, r: float) -> None:
        """Thin square post: four sides and a top."""
        self.box(m, (x - r, y - r, z0), (x + r, y + r, z1), skip=("-z",))

    def dish(self, m: str, centre, facing, radius: float, segs: int = 8) -> None:
        """Satellite dish: a shallow cone, seen from both sides."""
        c, f = Vector(centre), Vector(facing).normalized()
        side = f.cross(UP)
        if side.length < 1e-4:
            side = Vector((1.0, 0.0, 0.0))
        side.normalize()
        up = side.cross(f).normalized()
        apex = c - f * radius * 0.28
        rim = [c + (side * math.cos(2 * math.pi * k / segs) + up * math.sin(2 * math.pi * k / segs)) * radius
               for k in range(segs)]
        for k in range(segs):
            a, b = rim[k], rim[(k + 1) % segs]
            if (a - apex).cross(b - apex).dot(f) > 0:
                self.face(m, (apex, a, b))
                self.face(m, (apex, b, a))
            else:
                self.face(m, (apex, b, a))
                self.face(m, (apex, a, b))

    def triangles(self) -> int:
        return sum(len(f) - 2 for _, fs in self.parts.values() for f in fs)

    def build(self, name: str, coll) -> list:
        objs = []
        for m, (vs, fs) in self.parts.items():
            mesh = bpy.data.meshes.new(f"{name}_{m}")
            mesh.from_pydata(vs, [], fs)
            mesh.update()
            mesh.materials.append(mat.get(m))
            obj = geo.new_object(f"{name}_{m}", mesh, coll)
            geo.uv_box(obj)
            objs.append(obj)
        return objs


class _Face:
    """One flat wall: s runs along it (from o in direction a), off points out of it, z is height."""

    def __init__(self, M: _Mesh, o, a, length: float) -> None:
        self.M = M
        self.o = Vector((o[0], o[1], 0.0))
        self.a = Vector((a[0], a[1], 0.0)).normalized()
        self.n = self.a.cross(UP)
        self.L = length

    def p(self, s: float, z: float, off: float = 0.0) -> Vector:
        return self.o + self.a * s + self.n * off + UP * z

    def rect(self, m, s0, s1, z0, z1, off=0.0) -> None:            # looks out
        if s1 - s0 > 1e-4 and z1 - z0 > 1e-4:
            self.M.quad(m, self.p(s0, z0, off), self.a * (s1 - s0), UP * (z1 - z0))

    def rect_in(self, m, s0, s1, z0, z1, off=0.0) -> None:         # looks at the wall
        if s1 - s0 > 1e-4 and z1 - z0 > 1e-4:
            self.M.quad(m, self.p(s1, z0, off), self.a * (s0 - s1), UP * (z1 - z0))

    def side(self, m, s, o0, o1, z0, z1, facing: int) -> None:     # across the wall at s, looking along +a or -a
        if facing > 0:
            self.M.quad(m, self.p(s, z0, o1), self.n * (o0 - o1), UP * (z1 - z0))
        else:
            self.M.quad(m, self.p(s, z0, o0), self.n * (o1 - o0), UP * (z1 - z0))

    def level(self, m, s0, s1, o0, o1, z, up=True) -> None:        # horizontal, looking up or down
        if up:
            self.M.quad(m, self.p(s0, z, o0), self.n * (o1 - o0), self.a * (s1 - s0))
        else:
            self.M.quad(m, self.p(s0, z, o0), self.a * (s1 - s0), self.n * (o1 - o0))

    def box(self, m, s0, s1, z0, z1, o0, o1, skip=("back",)) -> None:
        if "front" not in skip:
            self.rect(m, s0, s1, z0, z1, o1)
        if "back" not in skip:
            self.rect_in(m, s0, s1, z0, z1, o0)
        if "left" not in skip:
            self.side(m, s0, o0, o1, z0, z1, -1)
        if "right" not in skip:
            self.side(m, s1, o0, o1, z0, z1, 1)
        if "top" not in skip:
            self.level(m, s0, s1, o0, o1, z1, True)
        if "bottom" not in skip:
            self.level(m, s0, s1, o0, o1, z0, False)

    def tile(self, wall_mat, holes, z0: float, z1: float, s0: float = 0.0, s1: float | None = None,
             low_mat: str | None = None, low_top: float = GROUND) -> None:
        """Cover the wall from z0 to z1 with plain faces, leaving the holes (s0, s1, z0, z1) open.
        Rows below low_top use low_mat (the plinth)."""
        s1 = self.L if s1 is None else s1
        holes = [tuple(round(v, 4) for v in h[:4]) for h in holes]
        zs = {round(z0, 4), round(z1, 4)}
        if low_mat:
            zs.add(round(low_top, 4))
        for h in holes:
            zs.update((h[2], h[3]))
        zs = sorted(z for z in zs if z0 - 1e-6 <= z <= z1 + 1e-6)
        rows: list[list] = []
        for za, zb in zip(zs, zs[1:]):
            if zb - za < 1e-4:
                continue
            cover = sorted((h[0], h[1]) for h in holes if h[2] <= za + 1e-5 and h[3] >= zb - 1e-5)
            gaps, s = [], s0
            for a, b in cover:
                if a > s + 1e-4:
                    gaps.append((s, a))
                s = max(s, b)
            if s1 > s + 1e-4:
                gaps.append((s, s1))
            m = low_mat if (low_mat and zb <= low_top + 1e-5) else wall_mat
            if rows and rows[-1][2] == gaps and rows[-1][3] == m and abs(rows[-1][1] - za) < 1e-5:
                rows[-1][1] = zb
            else:
                rows.append([za, zb, gaps, m])
        for za, zb, gaps, m in rows:
            for a, b in gaps:
                self.rect(m, a, b, za, zb)


def _symmetric(rng: random.Random, n: int, p: float) -> list[bool]:
    half = [rng.random() < p for _ in range((n + 1) // 2)]
    out = half + half[: n // 2][::-1]
    if not any(out):
        out[n // 2] = True
        out[(n - 1) // 2] = True
    return out


# ---------------------------------------------------------------- one block

class _Block:
    def __init__(self, w: float, d: float, floors: int, style: str, rng: random.Random, turn: float,
                 coarse: float = 1.0) -> None:
        r = self.rng = rng
        self.coarse = coarse            # > 1: wider bays, so fewer windows and balconies (keeps big blocks in budget)
        self.M = _Mesh()
        self.w, self.d, self.floors = w, d, floors
        self.h = GROUND + floors * FLOOR_H
        self.top = self.h + RIM
        self.wall, self.trim, self.surface = _STYLE[style]
        if r.random() < 0.25:
            self.surface = r.choice(("joints", "bands", "ledges"))

        # layout: sections, each with one stair core on the back
        self.n_sec = max(2, round(w / (r.uniform(12.0, 15.5) * (1.0 + (coarse - 1.0) * 0.5))))
        self.sw = w / self.n_sec
        self.cw = r.choice((2.6, 2.8, 3.0))
        self.recess = r.choice((0.6, 0.9, 1.2))
        self.nb = max(2, round(self.sw / (r.uniform(3.4, 4.1) * coarse)))       # front bays per section
        self.bw = self.sw / self.nb

        # looks
        self.core_mat = r.choice(("concrete_wall", "plaster_grey", "facade_concrete_tiles", self.wall))
        self.plinth = r.choice(("concrete_dirty", "concrete_wall"))
        self.coping = r.choice(("galvanised", "concrete_brushed", "paint_grey"))
        self.frame = r.choices(("window_frame", "far_frame_brown", "window_frame_dark"), (5, 3, 1))[0]
        self.frame_alt = "window_frame" if self.frame != "window_frame" else "far_frame_brown"
        self.shutters = r.random() < 0.45
        self.shutter_mat = r.choice(("plastic_grey", "plastic_white", "plastic_grey"))
        self.mullion = r.random() < 0.4
        self.p_open = 0.02
        self.win_frac = r.uniform(0.48, 0.72)                        # width of a plain front window in its bay
        self.shops = r.random() < 0.35
        self.stair = r.choice(("mid", "strip"))
        self.strip_mat = r.choice(("glass_curtain_white", "glass_window", "glass_blind_grey"))
        self.gable_kind = r.choice(("blind", "windows", "windows", "stripe"))
        self.gable_mat = r.choice((self.wall, self.wall, self.core_mat, "bricks_red", "facade_concrete_tiles"))

        # balconies
        self.bal = r.choice(("fins", "open", "band"))
        self.parapet = r.choice(("panel", "panel", "rail", "half", "glass"))
        self.bd = r.uniform(1.1, 1.5)
        self.mask = _symmetric(r, self.nb, 0.7 if self.bal == "band" else 0.55)
        self.pair = r.random() < 0.5
        self.scheme = r.choice(("one", "one", "alt", "section"))
        base = r.choice(("paint_white", "concrete_brushed", "metal_profile", self.trim, "paint_grey"))
        accents = list(_ACCENTS)
        r.shuffle(accents)
        self.pcolours = [base] if self.scheme == "one" else ([base, accents[0]] if self.scheme == "alt" else accents)
        self.fin_mat = r.choice((self.wall, self.trim, self.core_mat))

        # dishes point at one satellite: which way is that in the block's own frame?
        az = math.radians(DISH_AZIMUTH)
        wx, wy = math.sin(az), math.cos(az)
        t = math.radians(-turn)
        self.dish_dir = Vector((wx * math.cos(t) - wy * math.sin(t), wx * math.sin(t) + wy * math.cos(t), 0.0))
        self.dish_aim = (self.dish_dir * math.cos(math.radians(28)) + UP * math.sin(math.radians(28))).normalized()
        self.dish_front = self.dish_dir.dot(Vector((0, -1, 0))) > 0.25
        self.dish_back = self.dish_dir.dot(Vector((0, 1, 0))) > 0.25

    # ------------------------------------------------ windows

    def look(self):
        """What is behind one pane: (lower material, upper material, how far down the upper one comes)."""
        r = self.rng
        k = r.choices(("dark", "net", "cream", "blind", "half", "drawn"), (4, 2, 2, 1.2, 1.6, 0.5))[0]
        if k == "dark":
            return ("glass_window", None, 0.0)
        if k == "net":
            return ("glass_curtain_white", None, 0.0)
        if k == "cream":
            return ("glass_curtain_cream", None, 0.0)
        if k == "blind":
            return ("glass_blind_grey", None, 0.0)
        if k == "half":
            return ("glass_window", r.choice(("glass_blind_grey", "glass_curtain_white", "glass_curtain_cream")),
                    r.uniform(0.2, 0.65))
        return ("drawn", r.choice(("glass_curtain_cream", "glass_curtain_white", "glass_blind_grey")), 0.0)

    def pane(self, F: _Face, s0, s1, z0, z1, look) -> None:
        lower, upper, frac = look
        if lower == "drawn":                      # curtains pulled to both sides, dark glass between
            c = min(0.28, (s1 - s0) * 0.25)
            F.rect(upper, s0, s0 + c, z0, z1)
            F.rect("glass_window", s0 + c, s1 - c, z0, z1)
            F.rect(upper, s1 - c, s1, z0, z1)
            return
        if upper:
            zc = z1 - (z1 - z0) * frac
            F.rect(lower, s0, s1, z0, zc)
            F.rect(upper, s0, s1, zc, z1)
        else:
            F.rect(lower, s0, s1, z0, z1)

    def window(self, F: _Face, s0, s1, z0, z1, door: bool = False, frame: str | None = None) -> None:
        """Fill the hole (s0..s1, z0..z1) exactly: shutter box, panes, a frame bar between two panes."""
        r = self.rng
        frame = frame or (self.frame if r.random() < 0.8 else self.frame_alt)
        if not door and r.random() < self.p_open:
            self.open_window(F, s0, s1, z0, z1, frame)
            return
        z = z0
        top = z1
        if self.shutters:
            u = r.random()
            shut = r.uniform(0.15, 0.7) if u < 0.35 else (1.0 if u < 0.45 else 0.0)
            if shut > 0:
                zs = top - (top - z) * shut
                F.rect(self.shutter_mat, s0, s1, zs, top)
                top = zs
        if top - z < 0.05:
            return
        look = self.look()
        if self.mullion and s1 - s0 > 1.25 and not door and look[1] is None:
            mid = (s0 + s1) / 2
            F.rect(frame, mid - 0.045, mid + 0.045, z, top)
            self.pane(F, s0, mid - 0.045, z, top, look)
            self.pane(F, mid + 0.045, s1, z, top, look if r.random() < 0.75 else self.look())
        else:
            self.pane(F, s0, s1, z, top, look)

    def open_window(self, F: _Face, s0, s1, z0, z1, frame) -> None:
        """Dark room behind, one glass leaf swung out."""
        r = self.rng
        F.rect("interior_dark", s0, s1, z0, z1)
        left = r.random() < 0.5
        width = min(0.75, (s1 - s0) * 0.55)
        th = math.radians(r.uniform(30, 75))
        along = F.a * (math.cos(th) if left else -math.cos(th)) + F.n * math.sin(th)
        hinge = F.p(s0 if left else s1, z0, 0.0)
        self.M.two_sided("glass_window", hinge, along * width, UP * (z1 - z0))

    # ------------------------------------------------ floor lines

    def floor_lines(self, F: _Face, holes: list, s0: float, s1: float, ext: float = 0.0) -> None:
        """Panel joints or painted bands at every floor (cut into the wall), or concrete ledges standing out
        (ext: how far a ledge runs on past the ends, to meet the ledge round the corner)."""
        for f in range(1, self.floors + 1):
            zf = GROUND + f * FLOOR_H
            if self.surface == "joints" and F.L > 2.0:
                holes.append((s0, s1, zf - 0.08, zf - 0.02))
                F.rect("far_joint", s0, s1, zf - 0.08, zf - 0.02)
            elif self.surface == "bands" and f < self.floors:
                holes.append((s0, s1, zf - 0.30, zf))
                F.rect(self.trim, s0, s1, zf - 0.30, zf)
            elif self.surface == "ledges" and f < self.floors and F.L > 2.0:
                # front and underside only: the street never sees the top or the ends
                F.box(self.trim, s0 - ext, s1 + ext, zf - 0.22, zf - 0.02, 0.0, 0.18,
                      skip=("back", "top", "left", "right"))

    def coping_band(self, F: _Face, holes: list, s0: float, s1: float) -> None:
        holes.append((s0, s1, self.top - 0.14, self.top))
        F.rect(self.coping, s0, s1, self.top - 0.14, self.top)

    # ------------------------------------------------ the balcony side

    def front(self, F: _Face) -> None:
        r, M = self.rng, self.M
        holes: list = []
        nb, bw = self.nb, self.bw
        # balconies: runs of balcony bays, split into single or paired balconies unless they run as one band
        runs, i = [], 0
        while i < nb:
            if self.mask[i]:
                j = i
                while j < nb and self.mask[j]:
                    j += 1
                if self.bal == "band":
                    runs.append((i, j))
                else:
                    step = 2 if self.pair else 1
                    k = i
                    while k < j:
                        runs.append((k, min(j, k + step)))
                        k += step
                i = j
            else:
                i += 1
        first = 1 if self.shops else 0
        for sec in range(self.n_sec):
            x0 = sec * self.sw
            for f in range(first, self.floors):
                zf = GROUND + f * FLOOR_H
                for b in range(nb):
                    bx0, bx1 = x0 + b * bw, x0 + (b + 1) * bw
                    if self.mask[b]:
                        # balcony door on the side nearer the section middle, window beside it
                        door_left = b >= nb / 2
                        if door_left:
                            d0, d1 = bx0 + 0.3, bx0 + 1.2
                            w0, w1 = d1, bx1 - 0.35
                        else:
                            d0, d1 = bx1 - 1.2, bx1 - 0.3
                            w0, w1 = bx0 + 0.35, d0
                        holes.append((d0, d1, zf, zf + 2.3))
                        self.window(F, d0, d1, zf, zf + 2.3, door=True)
                        if w1 - w0 > 0.5:
                            holes.append((w0, w1, zf + 0.9, zf + 2.3))
                            self.window(F, w0, w1, zf + 0.9, zf + 2.3)
                    else:
                        ww = bw * self.win_frac
                        xc = (bx0 + bx1) / 2
                        holes.append((xc - ww / 2, xc + ww / 2, zf + 0.9, zf + 2.3))
                        self.window(F, xc - ww / 2, xc + ww / 2, zf + 0.9, zf + 2.3)
            # balconies of this section
            for k, (i0, i1) in enumerate(runs):
                pm = self.parapet_mat(sec, k)
                s0, s1 = x0 + i0 * bw, x0 + i1 * bw
                self.balcony_stack(F, s0, s1, first, pm, sec, k)
            if self.shops:
                self.shopfronts(F, x0, x0 + self.sw, holes)
        # plinth with cellar windows
        for b in range(self.n_sec * nb):
            if b % 2 == 1 and not self.shops:
                xc = (b + 0.5) * bw
                holes.append((xc - 0.45, xc + 0.45, 0.12, 0.46))
                F.rect("glass_blind_grey" if r.random() < 0.5 else "interior_dark", xc - 0.45, xc + 0.45, 0.12, 0.46)
        self.floor_lines(F, holes, 0.0, F.L, ext=0.18)
        self.coping_band(F, holes, 0.0, F.L)
        F.tile(self.wall, holes, -1.0, self.top, low_mat=self.plinth)

    def parapet_mat(self, sec: int, k: int) -> str:
        if self.scheme == "alt":
            return self.pcolours[k % 2]
        if self.scheme == "section":
            return self.pcolours[sec % len(self.pcolours)]
        return self.pcolours[0]

    def balcony_stack(self, F: _Face, s0, s1, first: int, pm: str, sec: int, k: int) -> None:
        """One column of balconies from floor `first` to the top."""
        r, bd = self.rng, self.bd
        fins = self.bal == "fins"
        inset = 0.0 if fins else 0.12
        a0, a1 = s0 + inset, s1 - inset
        if fins:
            t = 0.16
            zb = GROUND + first * FLOOR_H - 0.3
            zt = self.h + (RIM if r.random() < 0.5 else 0.0)
            if a0 - t < 0.01:                     # keep the fins inside the corners of the block
                a0 += t
            if a1 + t > F.L - 0.01:
                a1 -= t
            F.box(self.fin_mat, a0 - t, a0, zb, zt, 0.0, bd + 0.06)
            F.box(self.fin_mat, a1, a1 + t, zb, zt, 0.0, bd + 0.06)
        for f in range(first, self.floors):
            zf = GROUND + f * FLOOR_H
            top_floor = f == self.floors - 1
            self.balcony(F, a0, a1, zf, pm, fins, top_floor)

    def balcony(self, F: _Face, a0, a1, zf, pm, fins: bool, top_floor: bool) -> None:
        r, M, bd = self.rng, self.M, self.bd
        e = 0.0 if fins else 0.03          # the front panel wraps round the slab ends on open balconies
        kind = self.parapet
        slab = "concrete_brushed"
        # The street only ever sees balconies from below and from the front: underside, front, ends.
        F.level(slab, a0, a1, 0.0, bd, zf - 0.18, up=False)
        ptop = zf + 1.0
        if kind == "rail":
            F.rect(slab, a0, a1, zf - 0.18, zf, bd)
            if not fins:
                F.side(slab, a0, 0.0, bd, zf - 0.18, zf, -1)
                F.side(slab, a1, 0.0, bd, zf - 0.18, zf, 1)
            low = zf
        else:
            # a panel that hangs down over the slab edge (glass ones are frosted)
            low = ptop if kind != "half" else zf + 0.55
            m = "glass_curtain_white" if kind == "glass" else pm
            F.rect(m, a0 - e, a1 + e, zf - 0.2, low, bd + 0.03)
            if not fins:
                F.side(m, a0 - e, 0.0, bd + 0.03, zf - 0.2, low, -1)
                F.side(m, a1 + e, 0.0, bd + 0.03, zf - 0.2, low, 1)
        if kind == "glass":
            F.box("aluminium", a0 - e, a1 + e, ptop, ptop + 0.05, bd - 0.02, bd + 0.05,
                  skip=("back", "left", "right", "top"))
        elif kind in ("rail", "half"):
            rail = "steel_dark" if pm in ("paint_white", "concrete_brushed", "metal_profile", "paint_grey") else pm
            F.box(rail, a0, a1, ptop - 0.05, ptop, bd - 0.05, bd, skip=("back", "left", "right", "top"))
            n_posts = max(2, int((a1 - a0) / 1.8) + 1)
            for i in range(1 if fins else 0, n_posts - (1 if fins else 0)):     # fins hold the ends
                s = a0 + 0.04 + (a1 - a0 - 0.08) * i / (n_posts - 1)
                F.rect(rail, s - 0.03, s + 0.03, low, ptop - 0.05, bd - 0.02)
            if not fins:
                for s, side in ((a0, -1), (a1, 1)):
                    F.side(rail, s, 0.0, bd, ptop - 0.05, ptop, side)
        # what people do with their balconies
        u = r.random()
        if u < 0.05:                                    # glazed in
            F.rect("glass_window", a0, a1, ptop, zf + FLOOR_H - 0.2, bd - 0.04)
            if not fins:
                F.side("glass_window", a0, 0.0, bd - 0.04, ptop, zf + FLOOR_H - 0.2, -1)
                F.side("glass_window", a1, 0.0, bd - 0.04, ptop, zf + FLOOR_H - 0.2, 1)
            return
        if u < 0.09 or (top_floor and u < 0.35):        # fabric awning
            m = r.choice(("far_awning_orange", "far_awning_green", "fabric_canopy", "curtain_blue"))
            p = F.p(a0 + 0.05, zf + 2.5, 0.15)
            M.two_sided(m, p, F.a * (a1 - a0 - 0.1), F.n * (bd - 0.15) - UP * 0.55)
            M.two_sided(m, F.p(a0 + 0.05, zf + 1.75, bd + 0.02), F.a * (a1 - a0 - 0.1), UP * 0.2)
        if r.random() < 0.08:                           # washing on a rack, a rug over the front
            n = r.randint(2, 4)
            for i in range(n):
                s = a0 + 0.3 + (a1 - a0 - 0.8) * r.random()
                width = r.uniform(0.35, 0.7)
                M.two_sided(r.choice(_LAUNDRY), F.p(s, zf + r.uniform(0.85, 1.1), bd * 0.55), F.a * width,
                            UP * r.uniform(0.45, 0.75))
            if kind != "glass" and r.random() < 0.5:
                s = a0 + (a1 - a0) * r.uniform(0.2, 0.6)
                M.quad(r.choice(_LAUNDRY), F.p(s, ptop - 0.9, bd + 0.2), F.a * r.uniform(0.6, 1.1), UP * 0.9 - F.n * 0.16)
        if r.random() < 0.06:                           # flower boxes
            F.box("far_plants", a0 + 0.1, a1 - 0.1, ptop, ptop + 0.35, bd - 0.3, bd - 0.04, skip=("back", "bottom"))
        if self.dish_front and r.random() < 0.1:        # satellite dish on the rail
            s = a0 + 0.45 if r.random() < 0.5 else a1 - 0.45
            c = F.p(s, ptop + 0.35, bd + 0.25)
            M.dish(r.choice(("plastic_white", "aluminium", "plastic_grey")), c, self.dish_aim, r.uniform(0.3, 0.42))
            F.box("steel_dark", s - 0.03, s + 0.03, ptop - 0.4, ptop + 0.3, bd + 0.05, bd + 0.11, skip=("back",))

    def shopfronts(self, F: _Face, x0: float, x1: float, holes: list) -> None:
        """Shops on the street side of the ground floor: big windows, a sign band, now and then an awning."""
        r, M = self.rng, self.M
        n = r.choice((1, 2, 2, 3))
        width = (x1 - x0) / n
        for i in range(n):
            s0, s1 = x0 + i * width + 0.35, x0 + (i + 1) * width - 0.35
            holes.append((s0, s1, 0.15, 2.75))
            frame = r.choice(("aluminium", "window_frame_dark", "steel_dark"))
            F.rect(frame, s0, s1, 0.15, 0.45)                                    # stall riser
            if r.random() < 0.5:                                                 # door at the left end
                d0, d1, m0, m1, g0, g1 = s0, s0 + 1.0, s0 + 1.0, s0 + 1.09, s0 + 1.09, s1
            else:
                d0, d1, m0, m1, g0, g1 = s1 - 1.0, s1, s1 - 1.09, s1 - 1.0, s0, s1 - 1.09
            F.rect("glass_window", d0, d1, 0.45, 2.4)
            F.rect(frame, d0, d1, 2.4, 2.75)
            F.rect(frame, m0, m1, 0.45, 2.75)
            look = r.choice(("glass_window", "glass_window", "glass_curtain_white", "glass_blind_grey"))
            F.rect(look, g0, g1, 0.45, 2.75)
            # the sign band above
            sign = r.choice(("paint_red", "paint_blue", "paint_green", "plastic_white", "paint_yellow"))
            holes.append((s0 - 0.15, s1 + 0.15, 2.82, 3.12))
            F.rect(sign, s0 - 0.15, s1 + 0.15, 2.82, 3.12)
            if r.random() < 0.4:
                m = r.choice(("far_awning_orange", "far_awning_green", "paint_red", "curtain_blue"))
                M.two_sided(m, F.p(s0, 2.78, 0.15), F.a * (s1 - s0), F.n * 1.3 - UP * 0.5)
                M.two_sided(m, F.p(s0, 2.08, 1.45), F.a * (s1 - s0), UP * 0.2)

    # ------------------------------------------------ the entrance side

    def back_windows(self, sec: int, x_lo: float, x_hi: float, mirror: bool, kinds: list) -> list:
        """Windows on one side of a stair core (world x range), as (x0, x1, z0, z1) per floor."""
        out = []
        n = len(kinds)
        bay = (x_hi - x_lo) / n
        for i, kind in enumerate(kinds):
            j = (n - 1 - i) if mirror else i
            xc = x_lo + (j + 0.5) * bay
            ww, sill = {"big": (min(1.5, bay - 0.6), 0.9), "kitchen": (min(1.2, bay - 0.6), 0.9),
                        "small": (0.6, 1.55), "pair": (min(1.9, bay - 0.5), 0.9)}[kind]
            for f in range(self.floors):
                zf = GROUND + f * FLOOR_H
                out.append((xc - ww / 2, xc + ww / 2, zf + sill, zf + 2.3, kind))
        return out

    def back(self, segments: list, cores: list) -> None:
        r = self.rng
        # one window plan per section, mirrored about the stair core, the same for every section
        side_len = (self.sw - self.cw) / 2
        n_side = max(1, round(side_len / (3.3 * self.coarse)))
        kinds = [r.choice(("big", "pair", "big"))] + [r.choice(("kitchen", "small", "kitchen", "big"))
                                                      for _ in range(n_side - 1)]
        wins = []
        for sec in range(self.n_sec):
            xs0 = -self.w / 2 + sec * self.sw
            xc = xs0 + self.sw / 2
            wins += self.back_windows(sec, xs0, xc - self.cw / 2, False, kinds)
            wins += self.back_windows(sec, xc + self.cw / 2, xs0 + self.sw, True, kinds)
        for F in segments:
            # this segment runs from x = F.o.x down to x = F.o.x - F.L
            holes = []
            for x0, x1, z0, z1, kind in wins:
                if x0 >= F.o.x - F.L - 1e-4 and x1 <= F.o.x + 1e-4:
                    s0, s1 = F.o.x - x1, F.o.x - x0
                    holes.append((s0, s1, z0, z1))
                    self.window(F, s0, s1, z0, z1)
                    if self.dish_back and kind != "small" and r.random() < 0.025:
                        sc = (s0 + s1) / 2
                        self.M.dish(r.choice(("plastic_white", "aluminium")), F.p(sc, z0 - 0.45, 0.55), self.dish_aim, 0.36)
                        F.box("steel_dark", sc - 0.03, sc + 0.03, z0 - 0.8, z0 - 0.35, 0.0, 0.5)
            # cellar windows
            n_cellar = int(F.L // 3.0)
            for i in range(n_cellar):
                if r.random() < 0.6:
                    s = (i + 0.5) * F.L / n_cellar
                    holes.append((s - 0.4, s + 0.4, 0.12, 0.46))
                    F.rect("interior_dark", s - 0.4, s + 0.4, 0.12, 0.46)
            self.floor_lines(F, holes, 0.0, F.L)
            self.coping_band(F, holes, 0.0, F.L)
            F.tile(self.wall, holes, -1.0, self.top, low_mat=self.plinth)
        for sec, (C, over_top) in enumerate(cores):
            self.core(C, over_top, sec)

    def core(self, C: _Face, over_top: float, sec: int) -> None:
        """Recessed stair core: entrance at the bottom, stair windows at the half landings, lift room on top."""
        r, M = self.rng, self.M
        holes = []
        L = C.L
        mid = L / 2
        # entrance: double glass door with a fanlight, a canopy over it, a lamp
        d0, d1 = mid - 0.95, mid + 0.95
        door = r.choice(("window_frame_dark", "far_frame_brown", "aluminium", "paint_green", "paint_blue"))
        holes.append((d0, d1, 0.0, 2.45))
        C.rect(door, d0, d1, 0.0, 0.4)
        C.rect("glass_window", d0, mid - 0.05, 0.4, 2.0)
        C.rect(door, mid - 0.05, mid + 0.05, 0.4, 2.0)
        C.rect("glass_window", mid + 0.05, d1, 0.4, 2.0)
        C.rect(door, d0, d1, 2.0, 2.1)
        C.rect("glass_curtain_white" if r.random() < 0.5 else "glass_window", d0, d1, 2.1, 2.45)
        canopy = r.choice(("concrete_brushed", "galvanised", self.trim))
        C.box(canopy, 0.0, L, 2.62, 2.8, 0.0, self.recess + r.uniform(0.6, 1.3), skip=("back",))
        C.box("plastic_white", mid + 1.1, mid + 1.35, 2.15, 2.4, 0.0, 0.15, skip=("back",))
        # stair windows
        if self.stair == "mid":
            for f in range(self.floors):
                zl = GROUND + f * FLOOR_H + FLOOR_H / 2
                z0, z1 = zl + 0.9, zl + 2.1
                if z0 < 2.9 or z1 > self.h + 0.6:
                    continue
                holes.append((mid - 0.6, mid + 0.6, z0, z1))
                self.window(C, mid - 0.6, mid + 0.6, z0, z1, frame=self.frame)
        else:
            for f in range(1, self.floors):
                zf = GROUND + f * FLOOR_H
                holes.append((mid - 0.55, mid + 0.55, zf + 0.1, zf + FLOOR_H - 0.25))
                C.rect(self.strip_mat, mid - 0.55, mid + 0.55, zf + 0.1, zf + FLOOR_H - 0.25)
        # the lift room above the roof: the core face simply carries on up
        holes.append((0.0, L, over_top - 0.14, over_top))
        C.rect(self.coping, 0.0, L, over_top - 0.14, over_top)
        C.tile(self.core_mat, holes, -1.0, over_top)
        depth = r.uniform(3.8, 5.2)
        C.box(self.core_mat, 0.0, L, self.h, over_top, -depth, 0.0, skip=("bottom", "front"))
        if r.random() < 0.6:                       # louvre box on the side of the lift room
            C.box("galvanised", L, L + 0.15, over_top - 1.6, over_top - 0.5, -depth * 0.7, -depth * 0.3, skip=("left",))

    # ------------------------------------------------ the ends

    def gable(self, F: _Face) -> None:
        r = self.rng
        holes = []
        m = self.gable_mat
        if self.gable_kind == "windows":
            cols = (F.L * 0.27, F.L * 0.73) if r.random() < 0.3 else (F.L * 0.5,)
            for f in range(self.floors):
                zf = GROUND + f * FLOOR_H
                for c in cols:
                    holes.append((c - 0.45, c + 0.45, zf + 1.0, zf + 2.3))
                    self.window(F, c - 0.45, c + 0.45, zf + 1.0, zf + 2.3)
        elif self.gable_kind == "stripe":                # a painted stripe from the plinth to the roof
            c = F.L * r.choice((0.3, 0.5, 0.7))
            sw = r.uniform(1.2, 2.4)
            accent = r.choice(_ACCENTS)
            holes.append((c - sw / 2, c + sw / 2, GROUND, self.top - 0.14))
            F.rect(accent, c - sw / 2, c + sw / 2, GROUND, self.top - 0.14)
        if self.gable_kind != "stripe":
            self.floor_lines(F, holes, 0.0, F.L, ext=0.18)
        self.coping_band(F, holes, 0.0, F.L)
        F.tile(m, holes, -1.0, self.top, low_mat=self.plinth)

    # ------------------------------------------------ roof

    def roof(self, edges: list, cores_x: list) -> None:
        r, M = self.rng, self.M
        w, d, h = self.w, self.d, self.h
        t = 0.25
        yb = d / 2 - self.recess
        # roof membrane
        M.quad("bitumen", (-w / 2, -d / 2, h), (w, 0, 0), (0, yb + d / 2, 0))
        xs = [-w / 2] + [v for xc in cores_x for v in (xc - self.cw / 2, xc + self.cw / 2)] + [w / 2]
        for x0, x1 in zip(xs[::2], xs[1::2]):
            M.quad("bitumen", (x0, yb, h), (x1 - x0, 0, 0), (0, self.recess, 0))
        # parapet: inside face and coping
        for F, kind in edges:
            if kind == "core":
                continue
            F.rect_in(self.wall if kind != "end" else self.gable_mat, 0.0, F.L, h, self.top - 0.0, -t)
            F.level(self.coping, 0.0, F.L, -t, 0.0, self.top)
        # vent stacks in a row or two over the bathrooms
        for row_y in r.sample((-2.2, 0.4, 2.6), r.randint(1, 2)):
            x = -w / 2 + r.uniform(2.0, 4.0)
            while x < w / 2 - 2.0:
                if all(abs(x - xc) > self.cw for xc in cores_x):
                    vh = r.uniform(0.7, 1.4)
                    M.box("concrete_wall", (x - 0.22, row_y - 0.22, h), (x + 0.22, row_y + 0.22, h + vh), skip=("-z", "+z"))
                    M.box("galvanised", (x - 0.32, row_y - 0.32, h + vh), (x + 0.32, row_y + 0.32, h + vh + 0.08), skip=())
                x += r.uniform(3.0, 6.5)
        # plant room
        if r.random() < 0.55:
            pw, pd = r.uniform(5.0, 10.0), r.uniform(3.5, 5.0)
            px = r.uniform(-w / 2 + pw / 2 + 3, w / 2 - pw / 2 - 3)
            ph = r.uniform(2.2, 3.2)
            pm = r.choice(("metal_profile", "concrete_wall", self.wall))
            M.box(pm, (px - pw / 2, -d / 2 + 2.0, h), (px + pw / 2, -d / 2 + 2.0 + pd, h + ph), skip=("-z",))
            # a louvre box and a door frame standing out from the wall (flat on it they would flicker)
            y0 = -d / 2 + 2.0
            M.box("galvanised", (px - pw / 2 + 0.6, y0 - 0.15, h + 0.8), (px - pw / 2 + 2.2, y0, h + 2.0), skip=("+y",))
            M.box("steel_dark", (px + pw / 2 - 1.6, y0 - 0.15, h), (px + pw / 2 - 0.7, y0, h + 2.1), skip=("+y", "-z"))
        # water tank
        if r.random() < 0.35:
            tx = r.uniform(-w / 2 + 4, w / 2 - 4)
            obj_r = r.uniform(0.9, 1.3)
            segs = 10
            cy = r.uniform(-1.0, 2.5)
            top = h + r.uniform(1.8, 2.6)
            ring = [(tx + obj_r * math.cos(2 * math.pi * k / segs), cy + obj_r * math.sin(2 * math.pi * k / segs)) for k in range(segs)]
            for k in range(segs):
                (xa, ya), (xb, yb2) = ring[k], ring[(k + 1) % segs]
                M.face("galvanised", ((xa, ya, h), (xb, yb2, h), (xb, yb2, top), (xa, ya, top)))
            M.face("galvanised", [(x, y, top) for x, y in ring])
        # television aerials: masts with cross-bars
        for _ in range(r.randint(2, 6)):
            ax, ay = r.uniform(-w / 2 + 1.5, w / 2 - 1.5), r.uniform(-d / 2 + 1.5, yb - 1.5)
            ah = r.uniform(2.5, 5.5)
            M.pole("galvanised", ax, ay, h, h + ah, 0.035)
            ang = r.uniform(0, math.pi)
            for k in range(r.randint(1, 3)):
                zz = h + ah - 0.35 - k * 0.6
                ln = r.uniform(0.9, 1.8)
                dx, dy = math.cos(ang) * ln / 2, math.sin(ang) * ln / 2
                # a cross-bar is one thin upright strip, seen from both sides: enough from the street
                M.two_sided("galvanised", (ax - dx, ay - dy, zz), (2 * dx, 2 * dy, 0), (0, 0, 0.05))
        # satellite dishes on stands
        for _ in range(r.randint(1, 3) + (3 if not (self.dish_front or self.dish_back) else 0)):
            sx, sy = r.uniform(-w / 2 + 1.5, w / 2 - 1.5), r.uniform(-d / 2 + 1.0, yb - 1.0)
            rad = r.uniform(0.4, 0.75)
            M.pole("steel_dark", sx, sy, h, h + 0.9 + rad, 0.04)
            M.dish(r.choice(("plastic_white", "aluminium", "plastic_grey")), (sx, sy, h + 0.9 + rad), self.dish_aim, rad)
        # a phone mast on some roofs
        if r.random() < 0.3:
            mx, my = r.uniform(-w / 4, w / 4), r.uniform(-1.0, 1.0)
            mh = r.uniform(6.0, 9.0)
            M.pole("galvanised", mx, my, h, h + mh, 0.15)
            for k in range(3):
                ang = 2 * math.pi * k / 3 + 0.3
                cx, cy = mx + math.cos(ang) * 0.45, my + math.sin(ang) * 0.45
                M.box("plastic_white", (cx - 0.17, cy - 0.17, h + mh - 1.9), (cx + 0.17, cy + 0.17, h + mh - 0.4), skip=("-z",))
            M.box("plastic_grey", (mx - 1.0, my + 1.0, h), (mx + 1.0, my + 2.0, h + 1.8), skip=("-z",))

    # ------------------------------------------------ everything

    def build(self) -> None:
        w, d, r = self.w, self.d, self.rng
        M = self.M
        yb = d / 2 - self.recess
        cores_x = [-w / 2 + (k + 0.5) * self.sw for k in range(self.n_sec)]
        edges = []
        F = _Face(M, (-w / 2, -d / 2), (1, 0), w)
        edges.append((F, "front"))
        self.front(F)
        R = _Face(M, (w / 2, -d / 2), (0, 1), d)
        edges.append((R, "end"))
        self.gable(R)
        # the entrance side, walked from +x to -x with a notch at every stair core
        segments, cores = [], []
        x = w / 2
        for xc in reversed(cores_x):
            xa, xb = xc + self.cw / 2, xc - self.cw / 2
            seg = _Face(M, (x, d / 2), (-1, 0), x - xa)
            segments.append(seg)
            edges.append((seg, "back"))
            s1 = _Face(M, (xa, d / 2), (0, -1), self.recess)
            C = _Face(M, (xa, yb), (-1, 0), self.cw)
            s2 = _Face(M, (xb, yb), (0, 1), self.recess)
            for s in (s1, s2):
                edges.append((s, "nside"))
                hs: list = []
                self.floor_lines(s, hs, 0.0, s.L)
                self.coping_band(s, hs, 0.0, s.L)
                s.tile(self.wall, hs, -1.0, self.top, low_mat=self.plinth)
            edges.append((C, "core"))
            cores.append((C, self.top + r.uniform(1.8, 3.0)))
            x = xb
        seg = _Face(M, (x, d / 2), (-1, 0), x + w / 2)
        segments.append(seg)
        edges.append((seg, "back"))
        self.back(segments, cores)
        Lf = _Face(M, (-w / 2, d / 2), (0, -1), d)
        edges.append((Lf, "end"))
        self.gable(Lf)
        self.roof(edges, cores_x)


BUDGET = 6000          # triangles per block


def far_block(name: str, w: float, d: float, floors: int, style: str, coll, rng: random.Random, turn: float = 0.0) -> list:
    """A post-war slab block seen from far away, centred on the origin, balconies towards -Y.
    Big blocks that come out over BUDGET are laid out again with wider bays (same choices otherwise)."""
    _materials()
    seed = rng.random()
    coarse = 1.0
    while True:
        block = _Block(w, d, floors, style, random.Random(seed), turn, coarse)
        block.build()
        if block.M.triangles() <= BUDGET or coarse > 2.0:
            break
        coarse += 0.08
    return block.M.build(name, coll)


def triangles(objs) -> int:
    return sum(len(p.vertices) - 2 for o in objs if o.type == "MESH" for p in o.data.polygons)


def build_far_blocks(coll, blocks=FAR_BLOCKS, seed: int = 41) -> list:
    """All the far blocks at their places, tagged as far scenery (no baked light, no collision)."""
    rng = random.Random(seed)
    made = []
    total = 0
    for i, (x, y, w, d, floors, style, turn) in enumerate(blocks):
        parts = far_block(f"far{i}", w, d, floors, style, coll, random.Random(rng.random()), turn)
        geo.place(parts, (x, y, 0.0), turn)
        geo.tag(parts, role="far", collide="none")
        t = triangles(parts)
        total += t
        print(f"[far] far{i}: {w:.0f} x {d:.0f} m, {floors} floors, {style}: {t} triangles in {len(parts)} objects")
        made += parts
    print(f"[far] all far blocks: {total} triangles")
    return made


# ---------------------------------------------------------------- stage

def demo(coll, name=None) -> dict:
    """Stage demo. name: all (the twelve blocks where the estate sees them) | b<i> | b<i>@near (one block, from 120 or 55 m)."""
    name = name or "all"
    stage = geo.collection("stage")
    from shapely.geometry import box as sbox

    geo.flat_polygon("stage_far_ground", sbox(-400, -400, 400, 400), -0.02, mat.get("grass"), stage)
    if name == "all":
        build_far_blocks(coll)
        return {"focus": (0.0, -4.0, 14.0), "radius": 9.0,
                "cat": [(0.0, -10.0, 0.0), (8.0, -12.0, 170.0), (-6.0, -12.0, 95.0), (4.0, -14.0, -100.0)]}
    spec, _, view = name.partition("@")
    i = int(spec.lstrip("b") or 0)
    for o in [bpy.data.objects.get(n) for n in ("stage_road", "stage_pave", "stage_kerb")]:
        if o is not None:
            bpy.data.objects.remove(o, do_unlink=True)
    x, y, w, d, floors, style, turn = FAR_BLOCKS[i]
    rng = random.Random(41)
    for _ in range(i + 1):
        sub = rng.random()
    parts = far_block(f"far{i}", w, d, floors, style, coll, random.Random(sub), turn)   # built as in the estate, left unturned
    geo.tag(parts, role="far", collide="none")
    print(f"[far] far{i}: {triangles(parts)} triangles")
    h = GROUND + floors * FLOOR_H
    radius = 28.0 if view == "near" else 62.0
    return {"focus": (0.0, 0.0, h * 0.5), "radius": radius,
            "cat": [(-55.0, -105.0, 28.0), (60.0, -115.0, -28.0), (35.0, 120.0, 196.0)]}
