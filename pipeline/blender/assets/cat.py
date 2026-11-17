"""The cat: a domestic short-hair built by code, rigged, skinned, with six coats and a fur map.

Everything here is the body UNDER the fur. The game grows the fur itself (shell fur: the body
pushed outwards along its normals in layers), using the pictures written by `write_textures`.

Layout (metres, Blender Z up, the cat faces +Y, paws on z = 0, the cat's right side is +X):

  shape     signed-distance primitives (ellipsoids, round cones, a lofted torso, ears) blended
            with smooth unions; sampled on a 1.5 mm grid, turned into a mesh with OpenVDB,
            remeshed to even quads with QuadriFlow (the head is magnified first so it gets more
            detail), then refined around the eyes, muzzle and paws and snapped back onto the
            exact surface.
  rig       "CatRig" with the bone names and axes the game expects. Every bone's local X axis
            points to world +X, so a rotation about local X always bends in the side view.
            Positive rotation about X swings the far end of a bone forwards (towards +Y) /
            upwards, i.e. counter-clockwise when the cat is seen from its right side.
  weights   from the primitives each vertex belongs to (soft), each with its own bone recipe,
            smoothed over the mesh, at most 4 bones per vertex.
  textures  painted per texel with numpy from the 3D position under each texel (no bakes).

Bones on the cat's left are ".L" (x < 0), on its right ".R" (x > 0).
"""
from __future__ import annotations

import math
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from wc import geo

LOG_PREFIX = "[cat]"


def log(*args) -> None:
    print(LOG_PREFIX, *args, flush=True)


# =====================================================================================
# skeleton (rest pose: standing square)
# =====================================================================================

FX = 0.031      # |x| of the front-leg bone plane
HX = 0.035      # |x| of the hind-leg bone plane
TAIL_BASE = np.array((0.0, -0.200, 0.219))
# The head was laid out first and then tipped nose-down about the skull joint and lowered / pulled
# back to sit closer to the shoulders the way a standing cat carries it; every head coordinate goes
# through hd() (points) or hdir() (directions).
HEAD_OFF = np.array((0.0, -0.006, -0.016))
HEAD_PIVOT = np.array((0.0, 0.172, 0.262))
_hp = math.radians(-6.0)
HEAD_R = np.array(((1.0, 0.0, 0.0), (0.0, math.cos(_hp), -math.sin(_hp)), (0.0, math.sin(_hp), math.cos(_hp))))


def hd(p) -> tuple:
    return tuple(HEAD_R @ (np.asarray(p, float) - HEAD_PIVOT) + HEAD_PIVOT + HEAD_OFF)


def hdir(v) -> tuple:
    return tuple(HEAD_R @ np.asarray(v, float))


def head_local(P: np.ndarray) -> np.ndarray:
    """World points -> the head's own layout (inverse of hd)."""
    return (P - HEAD_PIVOT - HEAD_OFF) @ HEAD_R + HEAD_PIVOT
TAIL_DIR = np.array((0.0, -math.cos(math.radians(16.0)), -math.sin(math.radians(16.0))))
TAIL_LEN = 0.28


def tail_pt(t: float) -> np.ndarray:
    return TAIL_BASE + TAIL_DIR * (TAIL_LEN * t)


def _side(p, s: float) -> tuple:
    return (p[0] * s, p[1], p[2])


# joints of the right side (x > 0); the left side is mirrored
FRONT = {
    "scap_top": (FX, 0.062, 0.232),
    "shoulder": (FX, 0.118, 0.178),
    "elbow": (FX, 0.062, 0.124),
    "wrist": (FX, 0.071, 0.036),
    "knuckle": (FX, 0.087, 0.0125),
    "toe": (FX, 0.111, 0.006),
}
HIND = {
    "hip": (HX, -0.128, 0.200),
    "stifle": (HX, -0.066, 0.132),
    "hock": (HX, -0.153, 0.066),
    "knuckle": (HX, -0.140, 0.0125),
    "toe": (HX, -0.113, 0.006),
}
SPINE = {
    "pelvis": (0.0, -0.168, 0.212),
    "lumbar": (0.0, -0.098, 0.218),
    "back": (0.0, -0.028, 0.215),
    "withers": (0.0, 0.040, 0.209),
    "neckbase": (0.0, 0.118, 0.197),
    "skull": hd((0.0, 0.172, 0.262)),
    "nose": hd((0.0, 0.250, 0.272)),
}
JAW = {"tmj": hd((0.0, 0.198, 0.250)), "chin": hd((0.0, 0.252, 0.237))}
EAR = {"base": hd((0.027, 0.194, 0.300)), "tip": hd((0.027, 0.190, 0.344))}


def bone_table() -> list[tuple[str, tuple, tuple, str | None]]:
    """(name, head, tail, parent) in rest pose."""
    S = SPINE
    out = [
        ("root", (0.0, -0.13, 0.0), (0.0, -0.05, 0.0), None),
        ("hips", S["pelvis"], S["lumbar"], "root"),
        ("spine1", S["lumbar"], S["back"], "hips"),
        ("spine2", S["back"], S["withers"], "spine1"),
        ("chest", S["withers"], S["neckbase"], "spine2"),
        ("neck", S["neckbase"], S["skull"], "chest"),
        ("head", S["skull"], S["nose"], "neck"),
        ("jaw", JAW["tmj"], JAW["chin"], "head"),
    ]
    for side, s in (("L", -1.0), ("R", 1.0)):
        out.append((f"ear.{side}", _side(EAR["base"], s), _side(EAR["tip"], s), "head"))
    prev = "hips"
    for i in range(5):
        name = f"tail{i + 1}"
        out.append((name, tuple(tail_pt(i / 5)), tuple(tail_pt((i + 1) / 5)), prev))
        prev = name
    for side, s in (("L", -1.0), ("R", 1.0)):
        f = {k: _side(v, s) for k, v in FRONT.items()}
        out += [
            (f"scapula.{side}", f["scap_top"], f["shoulder"], "chest"),
            (f"upperarm.{side}", f["shoulder"], f["elbow"], f"scapula.{side}"),
            (f"forearm.{side}", f["elbow"], f["wrist"], f"upperarm.{side}"),
            (f"wrist.{side}", f["wrist"], f["knuckle"], f"forearm.{side}"),
            (f"paw.{side}", f["knuckle"], f["toe"], f"wrist.{side}"),
        ]
        h = {k: _side(v, s) for k, v in HIND.items()}
        out += [
            (f"thigh.{side}", h["hip"], h["stifle"], "hips"),
            (f"shin.{side}", h["stifle"], h["hock"], f"thigh.{side}"),
            (f"hock.{side}", h["hock"], h["knuckle"], f"shin.{side}"),
            (f"hindpaw.{side}", h["knuckle"], h["toe"], f"hock.{side}"),
        ]
    return out


BONE_NAMES = [b[0] for b in bone_table()]


# =====================================================================================
# signed-distance primitives (numpy, points as (N, 3) arrays)
# =====================================================================================

FAR = 0.03


def _n(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def smax(a, b, k):
    return -smin(-a, -b, k)


def ss(e0, e1, x):
    """smoothstep (works for e0 > e1 too)."""
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def frame(long_axis, side=(1.0, 0.0, 0.0)) -> np.ndarray:
    """Orthonormal 3x3 whose columns are local x (towards `side`), y, z (= long axis)."""
    z = _n(long_axis)
    x = np.asarray(side, float) - z * np.dot(side, z)
    x = _n(x)
    y = np.cross(z, x)
    return np.stack([x, y, z], axis=1)


def yaw_frame(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


class Prim:
    """One building block. op: 'add' (smooth union) or 'sub' (smooth subtraction)."""

    def __init__(self, label: str, rig: str | None, k: float, op: str = "add"):
        self.label = label   # texture / region name
        self.rig = rig       # skin-weight recipe name (None for 'sub')
        self.k = k
        self.op = op

    def sdf(self, P: np.ndarray) -> np.ndarray:
        raise NotImplementedError

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        raise NotImplementedError


class Implicit(Prim):
    """Primitive given as an implicit function F (< 0 inside); distance = F / |grad F|."""

    def F(self, P):
        raise NotImplementedError

    def sdf(self, P):
        e = 2.0e-4
        f = self.F(P)
        g2 = np.zeros(len(P))
        for i in range(3):
            d = np.zeros(3)
            d[i] = e
            g = (self.F(P + d) - self.F(P - d)) / (2 * e)
            g2 += g * g
        return f / np.maximum(np.sqrt(g2), 1e-3)


class Ellipsoid(Prim):
    def __init__(self, c, r, fr=None, label="", rig=None, k=0.006, op="add"):
        super().__init__(label, rig, k, op)
        self.c = np.asarray(c, float)
        self.r = np.asarray(r, float)
        self.fr = np.eye(3) if fr is None else np.asarray(fr, float)

    def sdf(self, P):
        q = (P - self.c) @ self.fr
        k0 = np.linalg.norm(q / self.r, axis=1)
        k1 = np.linalg.norm(q / (self.r * self.r), axis=1)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)

    def bounds(self):
        ext = np.abs(self.fr) @ self.r
        return self.c - ext, self.c + ext


class RoundCone(Prim):
    """Cone between spheres (a, ra) and (b, rb), exact distance (Inigo Quilez)."""

    def __init__(self, a, b, ra, rb, label="", rig=None, k=0.006, op="add"):
        super().__init__(label, rig, k, op)
        self.a = np.asarray(a, float)
        self.b = np.asarray(b, float)
        self.ra, self.rb = float(ra), float(rb)

    def sdf(self, P):
        a, b, r1, r2 = self.a, self.b, self.ra, self.rb
        ba = b - a
        l2 = float(ba @ ba)
        rr = r1 - r2
        a2 = l2 - rr * rr
        il2 = 1.0 / l2
        pa = P - a
        y = pa @ ba
        z = y - l2
        xv = pa * l2 - y[:, None] * ba
        x2 = np.einsum("ij,ij->i", xv, xv)
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        d1 = np.sqrt(x2 + z2) * il2 - r2
        d2 = np.sqrt(x2 + y2) * il2 - r1
        d3 = (np.sqrt(np.maximum(x2 * a2 * il2, 0.0)) + y * rr) * il2 - r1
        return np.where(np.sign(z) * a2 * z2 > k, d1, np.where(np.sign(y) * a2 * y2 < k, d2, d3))

    def bounds(self):
        r = max(self.ra, self.rb)
        return np.minimum(self.a, self.b) - r, np.maximum(self.a, self.b) + r


class Tube(Prim):
    """Constant-radius tube along a polyline (hard union of capsules)."""

    def __init__(self, pts, r, label="", rig=None, k=0.001, op="sub"):
        super().__init__(label, rig, k, op)
        self.pts = np.asarray(pts, float)
        self.r = float(r)

    def sdf(self, P):
        d = np.full(len(P), 1e3)
        for a, b in zip(self.pts[:-1], self.pts[1:]):
            ba = b - a
            t = np.clip(((P - a) @ ba) / (ba @ ba), 0.0, 1.0)
            q = P - a - t[:, None] * ba
            d = np.minimum(d, np.linalg.norm(q, axis=1))
        return d - self.r

    def bounds(self):
        return self.pts.min(0) - self.r, self.pts.max(0) + self.r


def _spline_table(xk, yk, n=1600):
    """Catmull-Rom (cubic Hermite) through the knots, sampled densely."""
    xk = np.asarray(xk, float)
    yk = np.asarray(yk, float)
    m = np.zeros_like(yk)
    m[1:-1] = (yk[2:] - yk[:-2]) / (xk[2:] - xk[:-2])
    m[0] = (yk[1] - yk[0]) / (xk[1] - xk[0])
    m[-1] = (yk[-1] - yk[-2]) / (xk[-1] - xk[-2])
    xs = np.linspace(xk[0], xk[-1], n)
    i = np.clip(np.searchsorted(xk, xs, "right") - 1, 0, len(xk) - 2)
    dx = xk[i + 1] - xk[i]
    t = (xs - xk[i]) / dx
    h00 = 2 * t ** 3 - 3 * t ** 2 + 1
    h10 = t ** 3 - 2 * t ** 2 + t
    h01 = -2 * t ** 3 + 3 * t ** 2
    h11 = t ** 3 - t ** 2
    return xs, h00 * yk[i] + h10 * dx * m[i] + h01 * yk[i + 1] + h11 * dx * m[i + 1]


class Loft(Implicit):
    """Torso and neck: cross-sections stacked along Y (side and top outlines as splines).

    stations: rows of (y, top z, bottom z, half width, height of the widest point as a fraction
    from the bottom, exponent above, exponent below). Exponent 2 = ellipse, < 2 keel, > 2 boxy.
    Both ends are closed with elliptical caps of the given lengths.
    """

    def __init__(self, stations, cap_back, cap_front, label="torso", rig="torso", k=0.0):
        super().__init__(label, rig, k, "add")
        st = np.asarray(stations, float)
        self.y0, self.y1 = st[0, 0], st[-1, 0]
        self.cb, self.cf = cap_back, cap_front
        self.tab = {}
        for col, key in enumerate(("top", "bot", "w", "f", "nu", "nd"), start=1):
            xs, ys = _spline_table(st[:, 0], st[:, col])
            self.tab[key] = ys
        self.ys = xs

    def look(self, y, key):
        return np.interp(y, self.ys, self.tab[key])

    def centre(self, y):
        top, bot, f = self.look(y, "top"), self.look(y, "bot"), self.look(y, "f")
        return bot + f * (top - bot)

    def F(self, P):
        x, y, z = P[:, 0], P[:, 1], P[:, 2]
        s = np.ones_like(y)
        b = y < self.y0
        s[b] = np.sqrt(np.clip(1.0 - ((self.y0 - y[b]) / self.cb) ** 2, 0.0, 1.0))
        f = y > self.y1
        s[f] = np.sqrt(np.clip(1.0 - ((y[f] - self.y1) / self.cf) ** 2, 0.0, 1.0))
        yc = np.clip(y, self.y0, self.y1)
        top, bot, w = self.look(yc, "top"), self.look(yc, "bot"), self.look(yc, "w")
        fr, nu, nd = self.look(yc, "f"), self.look(yc, "nu"), self.look(yc, "nd")
        zc = bot + fr * (top - bot)
        au = np.maximum((top - zc) * s, 1e-5)
        ad = np.maximum((zc - bot) * s, 1e-5)
        ww = np.maximum(w * s, 1e-5)
        dz = z - zc
        up = dz > 0
        v = np.where(up, dz / au, -dz / ad)
        n = np.where(up, nu, nd)
        u = np.abs(x) / ww
        F = (u ** n + v ** n) ** (1.0 / n) - 1.0
        return np.where(s <= 1e-4, 50.0, F)

    def bounds(self):
        wmax = self.tab["w"].max()
        return (np.array((-wmax, self.y0 - self.cb, self.tab["bot"].min())),
                np.array((wmax, self.y1 + self.cf, self.tab["top"].max())))


class Ear(Implicit):
    """Flat cone: lens-shaped cross-section shrinking to a rounded tip.

    base: centre of the ear base; up: along the ear; facing: where the opening looks.
    off0/off1: shift of the cross-section along `facing` at base / tip (used by the hollow).
    """

    def __init__(self, base, up, facing, H, W0, D0, D1, off0=0.0, off1=0.0, below=0.012,
                 label="ear", rig=None, k=0.004, op="add"):
        super().__init__(label, rig, k, op)
        self.base = np.asarray(base, float)
        self.e3 = _n(up)
        f = np.asarray(facing, float)
        self.e2 = _n(f - self.e3 * np.dot(f, self.e3))
        self.e1 = np.cross(self.e2, self.e3)
        self.H, self.W0, self.D0, self.D1 = H, W0, D0, D1
        self.off0, self.off1, self.below = off0, off1, below

    def F(self, P):
        q = P - self.base
        a = q @ self.e1
        h = q @ self.e3
        t = np.clip(h / self.H, 0.0, 1.0)
        b = q @ self.e2 - (self.off0 * (1 - t) + self.off1 * t)
        W = self.W0 * (1.0 - t ** 1.25) * (1.0 + 0.35 * t * (1.0 - t)) + 2e-5
        D = (self.D0 * (1 - t) + self.D1 * t) * np.sqrt(np.clip(1.0 - t ** 6, 0.0, 1.0)) + 2e-5
        F = np.sqrt((a / W) ** 2 + (b / D) ** 2) - 1.0
        F = np.maximum(F, (-h - self.below) / 0.004)
        F = np.maximum(F, (h - self.H) / 0.002)
        return F

    def bounds(self):
        pts = [self.base + self.e3 * hh + self.e1 * aa * self.W0 * 1.1 + self.e2 * bb * (self.D0 + abs(self.off0) + 0.002)
               for hh in (-self.below, self.H) for aa in (-1, 1) for bb in (-1, 1)]
        pts = np.array(pts)
        return pts.min(0), pts.max(0)


class EyeCut(Prim):
    """The eye opening. mode 'lid': a shell around the eyeball outside the almond aperture
    (makes sure the face covers the eyeball there). mode 'open': the aperture cone in front of
    the eyeball (removed from the face so the eyeball shows through)."""

    def __init__(self, E, gaze, Re, side, tha, thb, tilt, mode, label="lids", rig="head", k=0.0015):
        super().__init__(label, rig if mode == "lid" else None, k, "add" if mode == "lid" else "sub")
        self.E = np.asarray(E, float)
        self.g = _n(gaze)
        ah = _n(np.cross(self.g, (0.0, 0.0, 1.0))) * side       # towards the outer corner
        av = _n(np.cross(ah, self.g)) * side                     # up
        if av[2] < 0:
            av = -av
        t = math.radians(tilt)
        self.ah = math.cos(t) * ah + math.sin(t) * av
        self.av = -math.sin(t) * ah + math.cos(t) * av
        self.Re, self.tha, self.thb, self.mode = Re, math.radians(tha), math.radians(thb), mode
        self.p = 1.7

    def angular(self, P):
        q = P - self.E
        c = q @ self.g
        al = np.arctan2(q @ self.ah, c)
        be = np.arctan2(q @ self.av, c)
        A = (np.abs(al / self.tha) ** self.p + np.abs(be / self.thb) ** self.p) ** (1.0 / self.p)
        return A, np.linalg.norm(q, axis=1), al, be

    def sdf(self, P):
        A, r, _, _ = self.angular(P)
        ap = (A - 1.0) * min(self.tha, self.thb) * np.maximum(r, 1e-4)   # > 0 outside the aperture
        if self.mode == "lid":
            shell = np.maximum(r - (self.Re + 0.0026), (self.Re - 0.002) - r)
            return np.maximum(shell, -ap)
        return np.maximum.reduce([ap, (self.Re - 0.0008) - r, r - (self.Re + 0.02)])

    def bounds(self):
        R = self.Re + 0.021
        return self.E - R, self.E + R


# =====================================================================================
# the cat's shape
# =====================================================================================

# torso / neck outline (skin, under the fur)
#            y      top    bottom  half-w  f     n_up  n_down
TORSO = [
    (-0.212, 0.238, 0.172, 0.022, 0.50, 2.0, 2.0),
    (-0.195, 0.249, 0.160, 0.030, 0.50, 2.1, 2.0),
    (-0.170, 0.255, 0.155, 0.036, 0.52, 2.2, 2.0),
    (-0.140, 0.256, 0.160, 0.039, 0.52, 2.2, 2.0),
    (-0.110, 0.253, 0.163, 0.037, 0.50, 2.2, 2.0),
    (-0.080, 0.248, 0.168, 0.035, 0.48, 2.2, 2.0),
    (-0.050, 0.243, 0.156, 0.040, 0.45, 2.2, 2.0),
    (-0.020, 0.238, 0.138, 0.045, 0.42, 2.2, 1.9),
    (0.010, 0.235, 0.124, 0.047, 0.40, 2.2, 1.8),
    (0.040, 0.237, 0.117, 0.046, 0.40, 2.2, 1.75),
    (0.070, 0.241, 0.116, 0.044, 0.42, 2.2, 1.7),
    (0.095, 0.241, 0.123, 0.041, 0.45, 2.1, 1.7),
    (0.115, 0.238, 0.136, 0.037, 0.50, 2.0, 1.8),
    (0.132, 0.244, 0.148, 0.035, 0.52, 2.0, 1.9),
    (0.148, 0.252, 0.152, 0.035, 0.50, 2.0, 2.0),
    (0.163, 0.262, 0.161, 0.034, 0.50, 2.0, 2.0),
    (0.178, 0.270, 0.174, 0.032, 0.50, 2.0, 2.0),
    (0.190, 0.275, 0.188, 0.029, 0.50, 2.0, 2.0),
]

# eyes
EYE_R = 0.0105
EYE_C = hd((0.0178, 0.2325, 0.2838))      # right eye centre
EYE_GAZE = (0.21, 0.975, 0.06)            # right eye axis (x mirrored on the left)
EYE_OPEN = (50.0, 38.0, 8.0)              # aperture half-angles (horizontal, vertical), tilt


def eye(side: float):
    return np.array(_side(EYE_C, side)), _n(hdir((EYE_GAZE[0] * side, EYE_GAZE[1], EYE_GAZE[2])))


class Shape:
    """All primitives in build order, plus things the painter and rig need to know."""

    def __init__(self, proxy: bool = False):
        """proxy=True: a remeshing stand-in with thick, solid ears and no mouth line (thin parts confuse
        QuadriFlow); the real shape is then snapped onto."""
        self.proxy = proxy
        self.prims: list[Prim] = []
        self.loft: Loft | None = None
        self.eyes: dict[float, EyeCut] = {}
        self.ear_hollows: list[Ear] = []
        self.mouth: Tube | None = None
        self.ground_k = 0.0015
        self._build()

    THIN = ("fleg", "fpaw", "hleg", "hpaw", "tail")

    def add(self, p: Prim) -> Prim:
        if self.proxy and p.label in self.THIN:
            # fatter limbs for the remesher, so ankles and wrists never tear
            if isinstance(p, RoundCone):
                p.ra += 0.0018
                p.rb += 0.0018
            elif isinstance(p, Ellipsoid):
                p.r = p.r + 0.0012
        self.prims.append(p)
        return p

    # ------------------------------------------------------------------ parts
    def _build(self) -> None:
        A = self.add
        self.loft = A(Loft(TORSO, cap_back=0.024, cap_front=0.012))

        for s in (-1.0, 1.0):
            sd = "L" if s < 0 else "R"
            self._front_leg(s, sd)
            self._hind_leg(s, sd)

        # tail
        A(RoundCone(tail_pt(-0.03), tail_pt(0.70), 0.0110, 0.0088, label="tail", rig="tail", k=0.012))
        A(RoundCone(tail_pt(0.70), tail_pt(0.985), 0.0088, 0.0055, label="tail", rig="tail", k=0.004))

        self._head()

    def _front_leg(self, s: float, sd: str) -> None:
        A = self.add
        f = {k: np.array(_side(v, s)) for k, v in FRONT.items()}
        rig = f"fleg.{sd}"
        x = np.array((s, 0.0, 0.0))
        # shoulder blade, flat on the side of the ribcage
        ax = f["shoulder"] - f["scap_top"]
        c = f["scap_top"] + 0.42 * ax + x * -0.0025
        A(Ellipsoid(c, (0.0095, 0.019, 0.043), frame(ax), label="torso", rig=rig, k=0.010))
        # upper arm mass (mostly inside the body skin), point of shoulder, elbow
        ax = f["elbow"] - f["shoulder"]
        c = (f["shoulder"] + f["elbow"]) / 2 + x * 0.0045 + np.array((0, -0.003, 0))
        A(Ellipsoid(c, (0.0155, 0.0220, 0.043), frame(ax), label="fleg_up", rig=rig, k=0.012))
        A(Ellipsoid(f["shoulder"] + x * 0.005 + np.array((0, 0.004, 0.002)), (0.014, 0.0135, 0.015),
                    label="fleg_up", rig=rig, k=0.009))
        A(Ellipsoid(f["elbow"] + np.array((0, -0.0065, 0.003)), (0.0095, 0.0095, 0.012),
                    label="fleg", rig=rig, k=0.006))
        # forearm
        A(RoundCone(f["elbow"] + np.array((0, 0.001, 0.002)), f["wrist"] + np.array((0, 0, 0.002)),
                    0.0125, 0.0080, label="fleg", rig=rig, k=0.006))
        ax = f["wrist"] - f["elbow"]
        A(Ellipsoid(f["elbow"] + 0.27 * ax + np.array((0, 0.0035, 0)), (0.0112, 0.0122, 0.027), frame(ax),
                    label="fleg", rig=rig, k=0.007))
        A(Ellipsoid(f["wrist"] + np.array((0, -0.001, 0)), (0.0088, 0.0092, 0.0090), label="fleg", rig=rig, k=0.005))
        # metacarpus, paw, toes
        A(RoundCone(f["wrist"], f["knuckle"] + np.array((0, -0.003, 0.002)), 0.0084, 0.0102,
                    label="fpaw", rig=rig, k=0.005))
        pc = np.array((s * FX, 0.093, 0.0092))
        A(Ellipsoid(pc, (0.0135, 0.0145, 0.0092), label="fpaw", rig=rig, k=0.004))
        for ang, rad in ((-52, 0.0120), (-18, 0.0127), (18, 0.0127), (52, 0.0120)):
            a = math.radians(ang)
            tc = pc + np.array((math.sin(a) * rad, math.cos(a) * rad, -0.0010))
            A(Ellipsoid(tc, (0.0054, 0.0062, 0.0070), yaw_frame(-ang), label="fpaw", rig=rig, k=0.0022))

    def _hind_leg(self, s: float, sd: str) -> None:
        A = self.add
        h = {k: np.array(_side(v, s)) for k, v in HIND.items()}
        rig = f"hleg.{sd}"
        # thigh (front and side) and hamstrings (back of the thigh)
        A(Ellipsoid((s * 0.031, -0.106, 0.176), (0.0195, 0.037, 0.055), frame((0, 0.065, -0.09)),
                    label="thigh", rig=rig, k=0.012))
        # back of the thigh flowing down into the calf (one smooth line from buttock to heel)
        A(Ellipsoid((s * 0.027, -0.170, 0.152), (0.0175, 0.0220, 0.049), frame((0, 0.050, -0.084)),
                    label="thigh_back", rig=rig, k=0.012))
        a, b = np.array((s * 0.031, -0.113, 0.126)), np.array((s * 0.032, -0.157, 0.082))
        A(Ellipsoid((a + b) / 2, (0.0118, 0.0135, 0.033), frame(b - a), label="hleg", rig=rig, k=0.012))
        # flank fold: the skin web that ties the knee to the belly (no gap between knee and body)
        A(Ellipsoid((s * 0.029, -0.073, 0.150), (0.0110, 0.0140, 0.0230), frame((0, 0.45, 0.89)),
                    label="thigh", rig=rig, k=0.012))
        # shin, calf, achilles tendon, heel
        A(RoundCone(h["stifle"], h["hock"], 0.0125, 0.0074, label="hleg", rig=rig, k=0.008))
        ax = h["hock"] - h["stifle"]
        d = _n(ax)
        post = np.array((0.0, d[2], -d[1]))       # side-plane perpendicular facing back / up
        if post[1] > 0:
            post = -post
        A(Ellipsoid(h["stifle"] + 0.30 * ax + post * 0.0070, (0.0110, 0.0120, 0.030), frame(ax),
                    label="hleg", rig=rig, k=0.010))
        A(RoundCone(h["stifle"] + 0.55 * ax + post * 0.010, h["hock"] + np.array((0, -0.0085, 0.006)),
                    0.0036, 0.0036, label="hleg", rig=rig, k=0.005))
        A(Ellipsoid(h["hock"] + np.array((0, -0.0075, 0.002)), (0.0062, 0.0062, 0.0064),
                    label="hleg", rig=rig, k=0.004))
        # metatarsus, paw, toes
        A(RoundCone(h["hock"], h["knuckle"] + np.array((0, -0.002, 0.002)), 0.0078, 0.0090,
                    label="hpaw", rig=rig, k=0.005))
        pc = np.array((s * HX, -0.127, 0.0088))
        A(Ellipsoid(pc, (0.0125, 0.0150, 0.0088), label="hpaw", rig=rig, k=0.004))
        for ang, rad in ((-50, 0.0118), (-17, 0.0125), (17, 0.0125), (50, 0.0118)):
            a = math.radians(ang)
            tc = pc + np.array((math.sin(a) * rad, math.cos(a) * rad, -0.0010))
            A(Ellipsoid(tc, (0.0050, 0.0058, 0.0066), yaw_frame(-ang), label="hpaw", rig=rig, k=0.0022))

    def _head(self) -> None:
        A = self.add
        first = len(self.prims)
        A(Ellipsoid((0, 0.198, 0.283), (0.0305, 0.037, 0.0310), label="head", rig="head", k=0.012))
        A(Ellipsoid((0, 0.222, 0.293), (0.0235, 0.020, 0.0180), label="head", rig="head", k=0.009))
        # soft throat filling the angle between the lower jaw and the neck
        A(Ellipsoid((0, 0.199, 0.229), (0.0205, 0.028, 0.0185), label="torso", rig="torso", k=0.014))
        for s in (-1.0, 1.0):
            A(Ellipsoid((s * 0.0210, 0.212, 0.263), (0.0175, 0.025, 0.0215), label="cheek", rig="head", k=0.009))
            A(Ellipsoid((s * 0.0185, 0.188, 0.253), (0.0190, 0.022, 0.0245), label="cheek", rig="head", k=0.010))
            # zygomatic arch: widens the face at eye level, from under the eye back towards the ear
            A(Ellipsoid((s * 0.0275, 0.214, 0.2765), (0.0095, 0.021, 0.0105), yaw_frame(s * 12),
                        label="cheek", rig="head", k=0.008))
        A(Ellipsoid((0, 0.240, 0.2620), (0.0150, 0.0145, 0.0125), label="muzzle", rig="head", k=0.006))
        for s in (-1.0, 1.0):
            A(Ellipsoid((s * 0.0086, 0.2505, 0.2602), (0.0099, 0.0100, 0.0090), yaw_frame(-s * 25),
                        label="muzzle", rig="head", k=0.004))
        A(RoundCone((0, 0.231, 0.293), (0, 0.2585, 0.2738), 0.0088, 0.0060, label="bridge", rig="head", k=0.005))
        A(Ellipsoid((0, 0.2632, 0.2688), (0.0068, 0.0042, 0.0050), label="nose", rig="head", k=0.002))
        # lower jaw: small chin set back behind the nose
        # (narrow, tucked under the cheeks; only the small chin shows in front)
        A(Ellipsoid((0, 0.2410, 0.2440), (0.0058, 0.0066, 0.0050), label="chin", rig="jaw", k=0.006))
        A(Ellipsoid((0, 0.2150, 0.2450), (0.0105, 0.0240, 0.0075), label="chin", rig="jaw", k=0.012))
        # brow ridges (subtle)
        for s in (-1.0, 1.0):
            A(Ellipsoid((s * 0.0165, 0.2315, 0.2970), (0.0105, 0.0078, 0.0046), yaw_frame(-s * 15),
                        label="head", rig="head", k=0.006))
        for p in self.prims[first:]:          # the parts above were laid out before the head was placed
            if isinstance(p, Ellipsoid):
                p.c = np.array(hd(p.c))
                p.fr = HEAD_R @ p.fr
            elif isinstance(p, RoundCone):
                p.a, p.b = np.array(hd(p.a)), np.array(hd(p.b))
        # ears: solid flat cone, then the hollow scooped out of the front
        for s in (-1.0, 1.0):
            sd = "L" if s < 0 else "R"
            base = np.array(_side(EAR["base"], s)) + np.array((0, -0.001, -0.004))
            up = hdir((s * 0.309, -0.105, 0.945))
            facing = hdir((s * 0.42, 0.9, 0.05))
            # (a deep cone, open at the front: from the side it shows as a broad triangle, not a blade)
            if self.proxy:
                A(Ear(base, up, facing, H=0.047, W0=0.0178, D0=0.0128, D1=0.0045, label="ear", rig=f"ear.{sd}", k=0.006))
                continue
            A(Ear(base, up, facing, H=0.046, W0=0.0170, D0=0.0105, D1=0.0018, label="ear", rig=f"ear.{sd}", k=0.005))
            hol = Ear(base, up, facing, H=0.041, W0=0.0140, D0=0.0105, D1=0.0012, off0=0.0035, off1=0.0026,
                      below=0.004, label="ear_inner", rig=None, k=0.0030, op="sub")
            self.ear_hollows.append(A(hol))
        # eyes: lids first, then the opening
        tha, thb, tilt = EYE_OPEN
        for s in (-1.0, 1.0):
            E, g = eye(s)
            A(EyeCut(E, g, EYE_R, s, tha, thb, tilt, "lid", k=0.0015))
        for s in (-1.0, 1.0):
            E, g = eye(s)
            self.eyes[s] = A(EyeCut(E, g, EYE_R, s, tha, thb, tilt, "open", label="socket", k=0.0008))
        # mouth line: painted only (a carved groove read as an open beak); kept for the painter and weights
        half = [(0.0155, 0.2405, 0.2475), (0.0120, 0.2490, 0.2482), (0.0070, 0.2565, 0.2492), (0.0, 0.2605, 0.2505)]
        pts = [hd((-x, y, z)) for x, y, z in half] + [hd((x, y, z)) for x, y, z in reversed(half[:-1])]
        self.mouth = Tube(pts, 0.0007, label="mouth", k=0.0012, op="sub")

    # ------------------------------------------------------------------ evaluation
    def sdf(self, P: np.ndarray) -> np.ndarray:
        D = np.full(len(P), FAR)
        for p in self.prims:
            lo, hi = p.bounds()
            pad = p.k + 0.005
            m = np.all((P >= lo - pad) & (P <= hi + pad), axis=1)
            if not m.any():
                continue
            d = p.sdf(P[m])
            D[m] = smin(D[m], d, p.k) if p.op == "add" else smax(D[m], -d, p.k)
        return smax(D, -P[:, 2], self.ground_k)

    def grad(self, P: np.ndarray, e: float = 2.0e-4) -> np.ndarray:
        g = np.zeros_like(P)
        for i in range(3):
            d = np.zeros(3)
            d[i] = e
            g[:, i] = (self.sdf(P + d) - self.sdf(P - d)) / (2 * e)
        return g

    def project(self, V: np.ndarray, iters: int = 4) -> np.ndarray:
        V = V.copy()
        for _ in range(iters):
            d = self.sdf(V)
            g = self.grad(V)
            g2 = np.maximum(np.einsum("ij,ij->i", g, g), 1e-6)
            step = (d / g2)[:, None] * g
            n = np.linalg.norm(step, axis=1)
            lim = np.minimum(1.0, 0.003 / np.maximum(n, 1e-12))
            V -= step * lim[:, None]
        return V

    def grid(self, lo, h, n) -> np.ndarray:
        D = np.full(tuple(n), FAR, np.float32)
        axes = [lo[i] + np.arange(n[i]) * h for i in range(3)]
        for p in self.prims:
            plo, phi = p.bounds()
            pad = p.k + 0.005
            i0 = [max(int(math.floor((plo[i] - pad - lo[i]) / h)), 0) for i in range(3)]
            i1 = [min(int(math.ceil((phi[i] + pad - lo[i]) / h)) + 1, n[i]) for i in range(3)]
            if any(a >= b for a, b in zip(i0, i1)):
                continue
            # chunk along y to keep memory small
            step = max(1, int(1.5e6 // max(1, (i1[0] - i0[0]) * (i1[2] - i0[2]))))
            for j0 in range(i0[1], i1[1], step):
                j1 = min(j0 + step, i1[1])
                X, Y, Z = np.meshgrid(axes[0][i0[0]:i1[0]], axes[1][j0:j1], axes[2][i0[2]:i1[2]], indexing="ij")
                P = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1)
                d = p.sdf(P).reshape(X.shape).astype(np.float32)
                sub = D[i0[0]:i1[0], j0:j1, i0[2]:i1[2]]
                if p.op == "add":
                    sub[...] = smin(sub, d, p.k)
                else:
                    sub[...] = smax(sub, -d, p.k)
        z = axes[2][None, None, :].astype(np.float32)
        return smax(D, -z, self.ground_k).astype(np.float32)

    # ------------------------------------------------------------------ per-label distances
    def label_distances(self, P: np.ndarray) -> dict[str, np.ndarray]:
        """Distance from each point to each labelled 'add' part (min over its primitives)."""
        out: dict[str, np.ndarray] = {}
        for p in self.prims:
            if p.op != "add":
                continue
            d = p.sdf(P)
            out[p.label] = np.minimum(out[p.label], d) if p.label in out else d
        return out

    def rig_distances(self, P: np.ndarray) -> dict[str, np.ndarray]:
        out: dict[str, np.ndarray] = {}
        for p in self.prims:
            if p.op != "add" or p.rig is None:
                continue
            d = p.sdf(P)
            out[p.rig] = np.minimum(out[p.rig], d) if p.rig in out else d
        return out


# =====================================================================================
# mesh: SDF -> OpenVDB quads -> QuadriFlow -> refine -> snap
# =====================================================================================

GRID_LO = np.array((-0.068, -0.488, -0.004))
GRID_HI = np.array((0.068, 0.284, 0.366))
GRID_H = 0.0015

class Taper:
    """Smooth magnification beyond a plane: along `axis` the scale ramps from 1 (before a0) to S (after a1),
    and the other two coordinates are scaled about `centre` by the same amount. Always invertible."""

    def __init__(self, axis: int, a0: float, a1: float, S: float, centre):
        self.ax = axis
        self.others = [i for i in range(3) if i != axis]
        self.c = np.asarray(centre, float)
        self.t = np.linspace(-1.0, 1.0, 40001)
        self.s = 1.0 + (S - 1.0) * ss(a0, a1, self.t)
        T = np.concatenate([[0.0], np.cumsum((self.s[1:] + self.s[:-1]) * 0.5 * np.diff(self.t))]) + self.t[0]
        self.T = T + (a0 - np.interp(a0, self.t, T))      # identity before a0

    def fwd(self, V):
        a = V[:, self.ax]
        s = np.interp(a, self.t, self.s)
        out = V.copy()
        out[:, self.ax] = np.interp(a, self.t, self.T)
        for i in self.others:
            out[:, i] = self.c[i] + (V[:, i] - self.c[i]) * s
        return out

    def inv(self, W):
        a = np.interp(W[:, self.ax], self.T, self.t)
        s = np.interp(a, self.t, self.s)
        out = W.copy()
        out[:, self.ax] = a
        for i in self.others:
            out[:, i] = self.c[i] + (W[:, i] - self.c[i]) / s
        return out


# Before QuadriFlow the head is magnified (ramp along the neck) and the ears even more (everything
# above the skull top), so those parts get smaller quads; afterwards the vertices are put back.
WARPS = [Taper(2, 0.294 + HEAD_OFF[2], 0.312 + HEAD_OFF[2], 1.65, (0.0, 0.192 + HEAD_OFF[1], 0.0)),
         Taper(1, 0.125 + HEAD_OFF[1], 0.185 + HEAD_OFF[1], 1.55, (0.0, 0.0, 0.27 + HEAD_OFF[2]))]


def warp(V: np.ndarray) -> np.ndarray:
    for w in WARPS:
        V = w.fwd(V)
    return V


def unwarp(W: np.ndarray) -> np.ndarray:
    for w in reversed(WARPS):
        W = w.inv(W)
    return W


def _mesh_arrays(me: bpy.types.Mesh) -> tuple[np.ndarray, np.ndarray]:
    V = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", V)
    E = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", E)
    return V.reshape(-1, 3), E.reshape(-1, 2)


def _set_coords(me: bpy.types.Mesh, V: np.ndarray) -> None:
    me.vertices.foreach_set("co", V.astype(np.float32).ravel())
    me.update()


def _relax(shape: Shape, me: bpy.types.Mesh, iters: int = 3, lam: float = 0.5) -> None:
    V, E = _mesh_arrays(me)
    n = len(V)
    cnt = np.bincount(E.ravel(), minlength=n).astype(float)
    for _ in range(iters):
        acc = np.zeros_like(V)
        np.add.at(acc, E[:, 0], V[E[:, 1]])
        np.add.at(acc, E[:, 1], V[E[:, 0]])
        L = acc / np.maximum(cnt, 1)[:, None] - V
        g = shape.grad(V)
        g /= np.maximum(np.linalg.norm(g, axis=1), 1e-9)[:, None]
        L -= np.einsum("ij,ij->i", L, g)[:, None] * g
        V = shape.project(V + lam * L, iters=2)
    _set_coords(me, V)


def _refine(me: bpy.types.Mesh, inside) -> int:
    """Split every face in a region into four (transition faces become triangles / quads)."""
    bm = bmesh.new()
    bm.from_mesh(me)
    co = np.array([v.co for v in bm.verts])
    flag = inside(co)
    faces = [f for f in bm.faces if sum(flag[v.index] for v in f.verts) >= 3]
    edges = list({e for f in faces for e in f.edges})
    if edges:
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, quad_corner_type="INNER_VERT")
        ngons = [f for f in bm.faces if len(f.verts) > 4]
        if ngons:
            bmesh.ops.triangulate(bm, faces=ngons, quad_method="BEAUTY", ngon_method="BEAUTY")
    bm.to_mesh(me)
    bm.free()
    return len(faces)


def _qf_ready(bm: bmesh.types.BMesh, tol: float) -> dict:
    """Repair what Blender's QuadriFlow check rejects; returns what was found.
    (It wants: <= 2 faces per edge, consistent winding, no wire edges, no loose vertices and no
    edge shorter than 1e-4 along every axis.)"""
    found = {}
    for it in range(4):
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=tol)
        bmesh.ops.dissolve_degenerate(bm, dist=tol, edges=bm.edges[:])
        over = [e for e in bm.edges if len(e.link_faces) > 2]
        wire = [e for e in bm.edges if not e.link_faces]
        nmv = [v for v in bm.verts if not v.is_manifold and v.link_faces]
        found = {"over": len(over), "wire": len(wire), "nonmanifold_verts": len(nmv)}
        if not over and not wire and not nmv:
            break
        # cut out the faces around trouble spots and close the holes again
        bad = {f for e in over for f in e.link_faces} | {f for v in nmv for f in v.link_faces}
        bmesh.ops.delete(bm, geom=wire, context="EDGES")
        bmesh.ops.delete(bm, geom=list(bad), context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bnd = [e for e in bm.edges if e.is_boundary]
        if bnd:
            bmesh.ops.holes_fill(bm, edges=bnd, sides=0)
            bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    flips = 0
    for e in bm.edges:
        if len(e.link_loops) == 2 and e.link_loops[0].vert == e.link_loops[1].vert:
            flips += 1
    found["flipped"] = flips
    found["short"] = sum(1 for e in bm.edges if max(abs(c) for c in (e.verts[0].co - e.verts[1].co)) <= 1e-4)
    return found


def build_body_mesh(shape: Shape, coll, target_faces: int = 3500) -> bpy.types.Object:
    t0 = time.time()
    import openvdb as vdb

    lo, h = GRID_LO, GRID_H
    n = (np.ceil((GRID_HI - lo) / h) + 1).astype(int)
    D = Shape(proxy=True).grid(lo, h, n)
    log(f"sdf grid {tuple(n)} in {time.time() - t0:.1f}s")
    grid = vdb.FloatGrid(FAR)
    grid.copyFromArray(D)
    pts, quads = grid.convertToQuads(isovalue=0.0)
    V = lo + np.asarray(pts, float) * h
    Q = np.asarray(quads, dtype=np.int64)
    log(f"iso-surface: {len(V)} verts, {len(Q)} quads")

    # QuadriFlow refuses edges shorter than 0.1 mm (fixed tolerance), so it works on a 100x copy
    QS = 100.0
    me = bpy.data.meshes.new("CatBody")
    me.from_pydata((warp(V) * QS).tolist(), [], Q.tolist())
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    found = _qf_ready(bm, 0.002)
    bm.to_mesh(me)
    bm.free()
    obj = geo.new_object("CatBody", me, coll)
    me.use_mirror_x = True

    geo.select_only([obj])
    t1 = time.time()
    # (QuadriFlow's mirror mode leaves NaN vertices on this shape, so it runs without it)
    res = bpy.ops.object.quadriflow_remesh(use_mesh_symmetry=False, use_preserve_sharp=False, use_preserve_boundary=False,
                                           preserve_attributes=False, smooth_normals=False, mode="FACES",
                                           target_faces=target_faces, seed=3)
    if "FINISHED" not in res or len(obj.data.polygons) > target_faces * 3:
        log(f"quadriflow refused the raw surface ({found}); voxel remesh first")
        mod = obj.modifiers.new("vox", "REMESH")
        mod.mode = "VOXEL"
        mod.voxel_size = 0.17
        geo.apply_modifiers(obj)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        found = _qf_ready(bm, 0.002)
        bm.to_mesh(obj.data)
        bm.free()
        geo.select_only([obj])
        res = bpy.ops.object.quadriflow_remesh(use_mesh_symmetry=False, mode="FACES", target_faces=target_faces, seed=3)
        if "FINISHED" not in res:
            raise RuntimeError(f"QuadriFlow failed ({found})")
    me = obj.data
    Vq, _ = _mesh_arrays(me)
    if not np.isfinite(Vq).all():
        raise RuntimeError(f"QuadriFlow returned {int((~np.isfinite(Vq)).any(axis=1).sum())} broken vertices")
    # weld the two mirrored halves
    bm = bmesh.new()
    bm.from_mesh(me)
    for dist in (0.04, 0.1, 0.2, 0.3):
        bverts = list({v for e in bm.edges if e.is_boundary for v in e.verts})
        if not bverts:
            break
        bmesh.ops.remove_doubles(bm, verts=bverts, dist=dist)
    bnd = [e for e in bm.edges if e.is_boundary]
    if bnd:
        xs = [round(v.co.x / QS * 1000, 1) for e in bnd for v in e.verts]
        log(f"open edges left after welding: {len(bnd)}, x (mm) {sorted(set(xs))[:12]}; filling")
        bmesh.ops.holes_fill(bm, edges=bnd, sides=0)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    # keep only the biggest connected piece (QuadriFlow sometimes leaves a speck behind)
    bm.faces.ensure_lookup_table()
    seen: set = set()
    pieces = []
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        stack, piece = [f0], []
        seen.add(f0.index)
        while stack:
            f = stack.pop()
            piece.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        pieces.append(piece)
    pieces.sort(key=len, reverse=True)
    if len(pieces) > 1:
        where = [tuple(round(float(c) / QS * 1000) for c in np.mean([f.calc_center_median() for f in p], axis=0))
                 for p in pieces[1:6]]
        log(f"dropping {len(pieces) - 1} loose pieces ({[len(p) for p in pieces[1:6]]} faces at {where} mm, warped)")
        bmesh.ops.delete(bm, geom=[f for p in pieces[1:] for f in p], context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    open_edges = sum(1 for e in bm.edges if e.is_boundary)
    nonman = sum(1 for e in bm.edges if not e.is_manifold)
    bm.to_mesh(me)
    bm.free()
    log(f"quadriflow: {len(me.polygons)} faces in {time.time() - t1:.1f}s, {open_edges} open / {nonman} non-manifold edges")
    if open_edges:
        raise RuntimeError("cat body is not closed after QuadriFlow")

    V, _ = _mesh_arrays(me)
    _set_coords(me, shape.project(unwarp(V / QS), iters=5))
    _relax(shape, me, iters=3)

    def near_eyes_muzzle(co):
        m = np.zeros(len(co), bool)
        for s in (-1.0, 1.0):
            E, _ = eye(s)
            m |= np.linalg.norm(co - E, axis=1) < 0.0145
        m |= np.linalg.norm(co - np.array(hd((0.0, 0.256, 0.254))), axis=1) < 0.0165
        return m

    def paws(co):
        return co[:, 2] < 0.024

    def ears(co):
        m = np.zeros(len(co), bool)
        for s in (-1.0, 1.0):
            b = np.array(_side(EAR["base"], s))
            m |= ((np.linalg.norm(co - (b + np.array((s * 0.006, -0.002, 0.020))), axis=1) < 0.030)
                  & (co[:, 2] > 0.298 + HEAD_OFF[2]))
        return m

    nf = _refine(me, near_eyes_muzzle)
    nf2 = _refine(me, paws)
    nf += _refine(me, ears)
    V, _ = _mesh_arrays(me)
    _set_coords(me, shape.project(V, iters=5))
    _relax(shape, me, iters=4)
    for p in me.polygons:
        p.use_smooth = True
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    log(f"body mesh: {len(me.vertices)} verts, {len(me.polygons)} faces, {tris} triangles "
        f"(refined {nf} head + {nf2} paw faces) in {time.time() - t0:.1f}s")
    return obj


def _xatlas_uvs(me: bpy.types.Mesh, P: np.ndarray, res: int = 1024, padding: int = 4) -> np.ndarray | None:
    """Per-corner UVs from the project's xatlas tool (tools/atlas.py in build/pyenv), or None."""
    import subprocess

    from wc import paths

    py = paths.BUILD / "pyenv" / "Scripts" / "python.exe"
    tool = paths.ROOT / "tools" / "atlas.py"
    if not py.exists() or not tool.exists():
        return None
    idx = np.empty(len(me.polygons) * 3, dtype=np.int32)
    me.polygons.foreach_get("vertices", idx)
    tmp = paths.ensure(paths.BUILD / "tmp")
    src, dst = tmp / "cat_atlas_in.npz", tmp / "cat_atlas_out.npz"
    np.savez(src, n=1, res=res, padding=padding, pos_0=P.astype(np.float32), idx_0=idx.reshape(-1, 3).astype(np.uint32))
    proc = subprocess.run([str(py), "-I", str(tool), str(src), str(dst)], capture_output=True, text=True)
    src.unlink(missing_ok=True)
    if proc.returncode != 0:
        log(f"xatlas failed ({proc.stderr[-300:]}); falling back to smart project")
        return None
    out = dict(np.load(dst))
    dst.unlink(missing_ok=True)
    log(proc.stdout.strip().replace("[atlas]", "xatlas:"))
    return out["uv_0"]


def unwrap(obj: bpy.types.Object) -> None:
    """Unique UVs ("uv0"). The layout is made on the magnified-head copy of the mesh (see WARPS), so
    the face and ears get more texels than the flanks. The body is triangulated first (the game gets
    triangles anyway, and charts may then split any quad)."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
    bm.to_mesh(me)
    bm.free()
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    uvl = me.uv_layers.new(name=geo.UV0)
    me.uv_layers.active = uvl
    V, _ = _mesh_arrays(me)
    uv = _xatlas_uvs(me, warp(V))
    if uv is not None:
        me.uv_layers[geo.UV0].data.foreach_set("uv", uv.reshape(-1).astype(np.float32))
        return
    _set_coords(me, warp(V))
    geo.select_only([obj])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(40.0), margin_method="FRACTION", island_margin=0.004,
                             area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    # make sure every UV is selected, so the packer moves all islands (no UV editor in background mode)
    ebm = bmesh.from_edit_mesh(me)
    luv = ebm.loops.layers.uv.active
    for f in ebm.faces:
        f.select = True
        for lp in f.loops:
            lp[luv].select = True
            lp[luv].select_edge = True
    bmesh.update_edit_mesh(me)
    bpy.ops.uv.pack_islands(rotate=True, rotate_method="ANY", shape_method="CONCAVE", margin_method="FRACTION",
                            margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")
    _set_coords(me, V)
    me.calc_loop_triangles()
    tl = np.empty(len(me.loop_triangles) * 3, np.int64)
    me.loop_triangles.foreach_get("loops", tl)
    uv = np.empty(len(me.loops) * 2)
    me.uv_layers[geo.UV0].data.foreach_get("uv", uv)       # (fetch again: edit mode invalidates old handles)
    t = uv.reshape(-1, 2)[tl].reshape(-1, 3, 2)
    area = 0.5 * np.abs((t[:, 1, 0] - t[:, 0, 0]) * (t[:, 2, 1] - t[:, 0, 1]) - (t[:, 2, 0] - t[:, 0, 0]) * (t[:, 1, 1] - t[:, 0, 1]))
    log(f"uv0: {area.sum() * 100:.0f}% of the picture covered, bounds {t.min():.3f}..{t.max():.3f}")


# =====================================================================================
# rig
# =====================================================================================

def build_rig(coll) -> bpy.types.Object:
    arm = bpy.data.armatures.new("CatRig")
    rig = bpy.data.objects.new("CatRig", arm)
    coll.objects.link(rig)
    arm.display_type = "STICK"
    geo.select_only([rig])
    bpy.ops.object.mode_set(mode="EDIT")
    for name, head, tail, parent in bone_table():
        eb = arm.edit_bones.new(name)
        eb.head = head
        eb.tail = tail
        d = (Vector(tail) - Vector(head)).normalized()
        eb.align_roll(Vector((1.0, 0.0, 0.0)).cross(d))
        if parent:
            eb.parent = arm.edit_bones[parent]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.bones["root"].use_deform = False
    return rig


def check_rig_axes(rig: bpy.types.Object) -> float:
    worst = 1.0
    for b in rig.data.bones:
        x = b.matrix_local.col[0].xyz
        worst = min(worst, x.x)
    return worst


# =====================================================================================
# skin weights
# =====================================================================================

def _seg_dist(P, a, b):
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    ba = b - a
    t = np.clip(((P - a) @ ba) / (ba @ ba), 0.0, 1.0)
    return np.linalg.norm(P - a - t[:, None] * ba, axis=1), t


def _chain_dist(P, segs, power=4.0, eps=0.002):
    """Weights from distance to each segment (good for slim limbs)."""
    out: dict[str, np.ndarray] = {}
    for a, b, bone in segs:
        d, _ = _seg_dist(P, a, b)
        w = 1.0 / (d + eps) ** power
        out[bone] = np.maximum(out.get(bone, 0.0), w)
    tot = sum(out.values())
    return {k: v / tot for k, v in out.items()}


def _chain_proj(P, segs, blends, plane_yz=False):
    """Weights from where a point projects along a polyline (good for the deep torso)."""
    Q = P.copy()
    if plane_yz:
        Q[:, 0] = 0.0
    best = np.full(len(P), 1e9)
    tpos = np.zeros(len(P))
    acc = 0.0
    bounds = []
    for a, b, _ in segs:
        a = np.asarray(a, float)
        b = np.asarray(b, float)
        L = float(np.linalg.norm(b - a))
        d, t = _seg_dist(Q, a, b)
        m = d < best
        best[m] = d[m]
        tpos[m] = acc + t[m] * L
        acc += L
        bounds.append(acc)
    # past(i) = how far the point is beyond joint i (0 before, 1 after, smooth across `blends[i]`)
    out: dict[str, np.ndarray] = {}
    prev = np.ones(len(P))
    for i, (_, _, bone) in enumerate(segs):
        past = ss(bounds[i] - blends[i] / 2, bounds[i] + blends[i] / 2, tpos) if i < len(segs) - 1 else np.zeros(len(P))
        out[bone] = out.get(bone, 0.0) + (prev - past)
        prev = past
    return out


def _recipes() -> dict:
    S = SPINE
    rec: dict = {}
    rec["torso"] = ("proj", [(S["pelvis"], S["lumbar"], "hips"), (S["lumbar"], S["back"], "spine1"),
                             (S["back"], S["withers"], "spine2"), (S["withers"], S["neckbase"], "chest"),
                             (S["neckbase"], S["skull"], "neck"), (S["skull"], S["nose"], "head")],
                    [0.040, 0.045, 0.045, 0.030, 0.022], True)
    rec["head"] = ("fixed", "head")
    rec["jaw"] = ("dist", [(hd((0, 0.200, 0.282)), JAW["tmj"], "head"), (JAW["tmj"], JAW["chin"], "jaw")])
    tail = [(tail_pt(i / 5), tail_pt((i + 1) / 5), f"tail{i + 1}") for i in range(5)]
    rec["tail"] = ("proj", [((0, -0.150, 0.215), tuple(TAIL_BASE), "hips")] + tail, [0.03, 0.026, 0.026, 0.024, 0.022], False)
    for side, s in (("L", -1.0), ("R", 1.0)):
        rec[f"ear.{side}"] = ("dist", [(hd((0, 0.198, 0.282)), _side(EAR["base"], s), "head"),
                                       (_side(EAR["base"], s), _side(EAR["tip"], s), f"ear.{side}")])
        f = {k: _side(v, s) for k, v in FRONT.items()}
        rec[f"fleg.{side}"] = ("dist", [((0, 0.05, 0.205), f["scap_top"], "chest"),
                                        (f["scap_top"], f["shoulder"], f"scapula.{side}"),
                                        (f["shoulder"], f["elbow"], f"upperarm.{side}"),
                                        (f["elbow"], f["wrist"], f"forearm.{side}"),
                                        (f["wrist"], f["knuckle"], f"wrist.{side}"),
                                        (f["knuckle"], f["toe"], f"paw.{side}")])
        h = {k: _side(v, s) for k, v in HIND.items()}
        rec[f"hleg.{side}"] = ("dist", [((0, -0.150, 0.214), h["hip"], "hips"),
                                        (h["hip"], h["stifle"], f"thigh.{side}"),
                                        (h["stifle"], h["hock"], f"shin.{side}"),
                                        (h["hock"], h["knuckle"], f"hock.{side}"),
                                        (h["knuckle"], h["toe"], f"hindpaw.{side}")])
    return rec


def _eval_recipe(rec, P) -> dict[str, np.ndarray]:
    kind = rec[0]
    if kind == "fixed":
        return {rec[1]: np.ones(len(P))}
    if kind == "dist":
        return _chain_dist(P, rec[1])
    return _chain_proj(P, rec[1], rec[2], plane_yz=rec[3])


def compute_weights(shape: Shape, me: bpy.types.Mesh, tau: float = 0.0022, smooth_iters: int = 4):
    """Returns (bone names, (N, B) weights, max 4 per vertex, normalised)."""
    V, E = _mesh_arrays(me)
    names = [n for n in BONE_NAMES if n != "root"]
    col = {n: i for i, n in enumerate(names)}
    W = np.zeros((len(V), len(names)))
    dist = shape.rig_distances(V)
    keys = list(dist.keys())
    Dm = np.stack([np.maximum(dist[k], 0.0) for k in keys], axis=1)
    Dm -= Dm.min(axis=1, keepdims=True)
    M = np.exp(-Dm / tau)
    M /= M.sum(axis=1, keepdims=True)
    recipes = _recipes()
    for j, key in enumerate(keys):
        m = M[:, j]
        sel = m > 1e-4
        if not sel.any():
            continue
        ws = _eval_recipe(recipes[key], V[sel])
        for bone, w in ws.items():
            W[sel, col[bone]] += m[sel] * w
    # smooth over the mesh, but keep the lips sharp (upper lip = head, lower lip = jaw)
    lam = np.full(len(V), 0.5)
    lips = (V[:, 1] > 0.228 + HEAD_OFF[1]) & (V[:, 2] < 0.262 + HEAD_OFF[2]) & (np.abs(V[:, 0]) < 0.024)
    lam[lips] = 0.0
    cnt = np.bincount(E.ravel(), minlength=len(V)).astype(float)
    for _ in range(smooth_iters):
        acc = np.zeros_like(W)
        np.add.at(acc, E[:, 0], W[E[:, 1]])
        np.add.at(acc, E[:, 1], W[E[:, 0]])
        W = (1 - lam[:, None]) * W + lam[:, None] * acc / np.maximum(cnt, 1)[:, None]
    # keep the four strongest
    order = np.argsort(-W, axis=1)
    keep = np.zeros_like(W, bool)
    rows = np.arange(len(V))[:, None]
    keep[rows, order[:, :4]] = True
    W = np.where(keep & (W > 0.01), W, 0.0)
    W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-9)
    return names, W


def apply_weights(obj: bpy.types.Object, names: list[str], W: np.ndarray) -> None:
    obj.vertex_groups.clear()
    groups = [obj.vertex_groups.new(name=n) for n in names]
    for j, g in enumerate(groups):
        idx = np.nonzero(W[:, j])[0]
        for i in idx:
            g.add([int(i)], float(W[i, j]), "REPLACE")


def bind(obj: bpy.types.Object, rig: bpy.types.Object) -> None:
    obj.parent = rig
    mod = obj.modifiers.new("rig", "ARMATURE")
    mod.object = rig
    mod.use_vertex_groups = True


# =====================================================================================
# eyes
# =====================================================================================

EYE_CAP = math.radians(80.0)


def build_eyes(coll) -> bpy.types.Object:
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new(geo.UV0)
    rings, segs = 8, 16
    for s in (-1.0, 1.0):
        E, g = eye(s)
        ah = _n(np.cross(g, (0.0, 0.0, 1.0)))        # +x-ish on both eyes (texture u)
        av = _n(np.cross(ah, g))
        if av[2] < 0:
            av = -av
        pole = None
        ring_verts = []
        for k in range(rings + 1):
            th = EYE_CAP * k / rings
            bulge = 0.0007 * max(0.0, math.cos(min(th / math.radians(48.0), 1.0) * math.pi / 2)) ** 2
            R = EYE_R + bulge
            if k == 0:
                pole = bm.verts.new(tuple(E + g * R))
                continue
            row = []
            for j in range(segs):
                ps = 2 * math.pi * j / segs
                d = math.cos(th) * g + math.sin(th) * (math.cos(ps) * ah + math.sin(ps) * av)
                row.append(bm.verts.new(tuple(E + d * R)))
            ring_verts.append(row)

        def uv_of(k, j):
            th = k / rings
            ps = 2 * math.pi * j / segs
            return (0.5 + 0.5 * th * math.cos(ps), 0.5 + 0.5 * th * math.sin(ps))

        faces = []
        for j in range(segs):
            j2 = (j + 1) % segs
            f = bm.faces.new((pole, ring_verts[0][j], ring_verts[0][j2]))
            faces.append((f, [(0, 0), (1, j), (1, j + 1)]))
        for k in range(rings - 1):
            for j in range(segs):
                j2 = (j + 1) % segs
                f = bm.faces.new((ring_verts[k][j], ring_verts[k + 1][j], ring_verts[k + 1][j2], ring_verts[k][j2]))
                faces.append((f, [(k + 1, j), (k + 2, j), (k + 2, j + 1), (k + 1, j + 1)]))
        for f, ids in faces:
            for loop, (kk, jj) in zip(f.loops, ids):
                loop[uvl].uv = uv_of(kk, jj) if kk > 0 else (0.5, 0.5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = geo.bm_to_object(bm, "CatEyes", None, coll, smooth=True)
    return obj


# =====================================================================================
# texel sampling: every texel of the body's UV layout -> 3D point, normal, regions
# =====================================================================================

TEX = 1024


def _rasterise(uvt: np.ndarray, res: int):
    tri = np.full((res, res), -1, np.int32)
    bary = np.zeros((res, res, 3), np.float32)
    P = uvt * res - 0.5
    for t in range(len(P)):
        p = P[t]
        x0 = max(int(math.floor(p[:, 0].min())), 0)
        x1 = min(int(math.ceil(p[:, 0].max())), res - 1)
        y0 = max(int(math.floor(p[:, 1].min())), 0)
        y1 = min(int(math.ceil(p[:, 1].max())), res - 1)
        if x1 < x0 or y1 < y0:
            continue
        X, Y = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        (ax, ay), (bx, by), (cx, cy) = p
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        l0 = ((by - cy) * (X - cx) + (cx - bx) * (Y - cy)) / den
        l1 = ((cy - ay) * (X - cx) + (ax - cx) * (Y - cy)) / den
        l2 = 1.0 - l0 - l1
        m = (l0 >= -1e-3) & (l1 >= -1e-3) & (l2 >= -1e-3)
        if not m.any():
            continue
        tri[Y[m], X[m]] = t
        bary[Y[m], X[m], 0] = l0[m]
        bary[Y[m], X[m], 1] = l1[m]
        bary[Y[m], X[m], 2] = l2[m]
    return tri, bary


class Texels:
    """Points on the body surface, one per used texel (rest pose)."""

    def __init__(self, shape: Shape, obj: bpy.types.Object, res: int = TEX):
        t0 = time.time()
        me = obj.data
        me.calc_loop_triangles()
        T = len(me.loop_triangles)
        tl = np.empty(T * 3, np.int64)
        tv = np.empty(T * 3, np.int64)
        me.loop_triangles.foreach_get("loops", tl)
        me.loop_triangles.foreach_get("vertices", tv)
        uv = np.empty(len(me.loops) * 2)
        me.uv_layers[geo.UV0].data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        uvt = uv[tl].reshape(T, 3, 2)
        tri, bary = _rasterise(uvt, res)
        self.valid = tri >= 0
        idx = tri[self.valid]
        b = bary[self.valid].astype(np.float64)
        b /= b.sum(axis=1, keepdims=True)
        tvv = tv.reshape(T, 3)[idx]
        V = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", V)
        V = V.reshape(-1, 3)
        Nv = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("normal", Nv)
        Nv = Nv.reshape(-1, 3)

        def interp(A):
            A = np.asarray(A)
            if A.ndim == 1:
                return (A[tvv] * b).sum(axis=1)
            return np.einsum("mk,mkc->mc", b, A[tvv])

        self.interp = interp
        self.P = interp(V)
        N = interp(Nv)
        self.N = N / np.maximum(np.linalg.norm(N, axis=1), 1e-9)[:, None]
        # distances to labelled parts and to the carved surfaces, interpolated from the vertices
        lab = shape.label_distances(V)
        self.vlab = lab
        self.labels = list(lab.keys())
        Dm = np.stack([np.maximum(interp(lab[k]), 0.0) for k in self.labels], axis=1)
        Dm -= Dm.min(axis=1, keepdims=True)
        Mm = np.exp(-Dm / 0.0018)
        Mm /= Mm.sum(axis=1, keepdims=True)
        self.reg = {k: Mm[:, i] for i, k in enumerate(self.labels)}
        self.hollow = np.minimum.reduce([np.abs(interp(e.sdf(V))) for e in shape.ear_hollows])
        self.mouth = np.abs(interp(shape.mouth.sdf(V)))
        self.res = res
        self.vert_uv = (uv, tl, tv)
        log(f"texels: {int(self.valid.sum())} of {res * res} used ({self.valid.mean() * 100:.0f}%) in {time.time() - t0:.1f}s")

    def r(self, *names) -> np.ndarray:
        out = np.zeros(len(self.P))
        for n in names:
            if n in self.reg:
                out = out + self.reg[n]
        return np.clip(out, 0.0, 1.0)

    def image(self, values: np.ndarray, fill=None) -> np.ndarray:
        """Spread per-texel values into a full (res, res, C) picture, padding outwards past seams."""
        C = values.shape[1] if values.ndim > 1 else 1
        img = np.zeros((self.res, self.res, C), np.float32)
        img[self.valid] = values.reshape(-1, C)
        return _dilate(img, self.valid.copy(), fill)


def _pushpull(img: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Fill empty texels from ever coarser averages of the filled ones."""
    h, wd = w.shape
    if h <= 1 or wd <= 1 or w.all():
        return img
    C = img.shape[2]
    acc = (img * w[..., None]).reshape(h // 2, 2, wd // 2, 2, C).sum(axis=(1, 3))
    ws = w.reshape(h // 2, 2, wd // 2, 2).sum(axis=(1, 3))
    coarse = acc / np.maximum(ws, 1e-9)[..., None]
    coarse = _pushpull(coarse, (ws > 0).astype(np.float32))
    up = np.repeat(np.repeat(coarse, 2, axis=0), 2, axis=1)
    return np.where(w[..., None] > 0, img, up)


def _dilate(img: np.ndarray, valid: np.ndarray, fill=None, iters: int = 3) -> np.ndarray:
    """Pad UV islands: a few exact rings of neighbours, then push-pull for everything else."""
    for _ in range(iters):
        acc = np.zeros_like(img)
        cnt = np.zeros(valid.shape, np.float32)
        vf = valid.astype(np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            acc += np.roll(np.roll(img * vf[..., None], dy, 0), dx, 1)
            cnt += np.roll(np.roll(vf, dy, 0), dx, 1)
        new = (~valid) & (cnt > 0)
        if not new.any():
            break
        img[new] = acc[new] / cnt[new][:, None]
        valid = valid | new
    if fill is not None:
        img[~valid] = fill
        return img
    return _pushpull(img, valid.astype(np.float32))


# =====================================================================================
# noise
# =====================================================================================

def _hash(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 144665) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float64) / float(0xFFFFFF)


def vnoise(P: np.ndarray, freq: float, seed: int = 0) -> np.ndarray:
    Q = P * freq + 17.31 * seed
    i = np.floor(Q).astype(np.int64)
    f = Q - i
    u = f * f * (3 - 2 * f)
    out = np.zeros(len(P))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[:, 0] if dx else 1 - u[:, 0]) * (u[:, 1] if dy else 1 - u[:, 1]) * (u[:, 2] if dz else 1 - u[:, 2])
                out += w * _hash(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out * 2.0 - 1.0


def fbm(P: np.ndarray, freq: float, seed: int = 0, octaves: int = 3) -> np.ndarray:
    out = np.zeros(len(P))
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += amp * vnoise(P, freq * 2 ** o, seed + o * 7)
        tot += amp
        amp *= 0.5
    return out / tot


# =====================================================================================
# coats
# =====================================================================================

COATS = ("tabby", "ginger", "black", "white", "grey", "tux")


def _polyline_dist(P2, pts):
    pts = np.asarray(pts, float)
    d = np.full(len(P2), 1e3)
    for a, b in zip(pts[:-1], pts[1:]):
        ba = b - a
        t = np.clip(((P2 - a) @ ba) / (ba @ ba), 0.0, 1.0)
        d = np.minimum(d, np.linalg.norm(P2 - a - t[:, None] * ba, axis=1))
    return d


def _chain_param(P, pts):
    """Arc length (from pts[0]) of the nearest point on a polyline, and the distance to it."""
    pts = np.asarray(pts, float)
    best = np.full(len(P), 1e9)
    s = np.zeros(len(P))
    acc = 0.0
    for a, b in zip(pts[:-1], pts[1:]):
        L = float(np.linalg.norm(b - a))
        d, t = _seg_dist(P, a, b)
        m = d < best
        best[m] = d[m]
        s[m] = acc + t[m] * L
        acc += L
    return s, best


def _chain_param_smooth(P, pts, power=6.0, eps=0.003):
    """Like _chain_param but blended between segments, so it keeps changing around bent joints."""
    pts = np.asarray(pts, float)
    acc, num, den = 0.0, np.zeros(len(P)), np.zeros(len(P))
    for a, b in zip(pts[:-1], pts[1:]):
        ba = b - a
        L = float(np.linalg.norm(ba))
        t = ((P - a) @ ba) / (ba @ ba)
        d = np.linalg.norm(P - a - np.clip(t, 0.0, 1.0)[:, None] * ba, axis=1)
        w = 1.0 / (d + eps) ** power
        num += w * (acc + np.clip(t, -0.8, 1.8) * L)
        den += w
        acc += L
    return num / den


class Painter:
    """Coat-independent fields (stripe pattern, masks, fur map) computed once per texel."""

    def __init__(self, shape: Shape, tx: Texels):
        t0 = time.time()
        self.tx = tx
        P, N = tx.P, tx.N
        x, y, z = P[:, 0], P[:, 1], P[:, 2]
        sx = np.where(x >= 0, 1.0, -1.0)
        self.sx = sx
        ax = np.abs(x)
        nz = N[:, 2]
        nlat = N[:, 0] * sx            # > 0 facing outwards (away from the midline)
        loft = shape.loft
        zc = loft.centre(np.clip(y, loft.y0, loft.y1))
        phi = np.arctan2(ax, z - zc)   # 0 on the spine, pi/2 on the flank, pi on the belly
        self.phi = phi
        n1 = fbm(P, 40.0, 1)
        n2 = fbm(P, 90.0, 2)
        self.n_lo = fbm(P, 14.0, 3)
        self.n_fine = fbm(P, 260.0, 4, octaves=2)
        # head features are described in the head's own layout (before it was lowered, see HEAD_OFF)
        self.Ph = Ph = head_local(P)
        yh, zh = Ph[:, 1], Ph[:, 2]

        torso = tx.r("torso")
        legf = tx.r("fleg_up", "fleg", "fpaw")
        legh = tx.r("thigh", "thigh_back", "hleg", "hpaw")
        tail = tx.r("tail")
        headr = tx.r("head", "cheek", "bridge", "muzzle", "chin", "nose", "lids", "ear")
        self.torso, self.legf, self.legh, self.tail, self.headr = torso, legf, legh, tail, headr

        # ---------------------------------------------------------- tabby pattern (0..1 = dark)
        # flanks: mackerel stripes running down from the spine, bending back a little towards the belly
        ye = y + 0.011 * (phi / (math.pi / 2)) ** 2 + 0.0050 * n1 + 0.0018 * n2
        lam = 0.0185
        st = ss(0.66 + 0.10 * self.n_lo, 0.88 + 0.08 * self.n_lo, 0.5 + 0.5 * np.cos(2 * math.pi * ye / lam))
        st *= 0.75 + 0.25 * ss(-0.4, 0.4, fbm(P, 60.0, 5))   # stripes not all equally dark
        st *= 1.0 - ss(1.85, 2.4, phi)                       # fade out on the lower belly
        st *= 1.0 - 0.6 * ss(0.06, 0.10, y) * ss(0.2, 0.6, N[:, 1])   # chest front: only faint bars
        dorsal = 1.0 - ss(0.16, 0.30, phi + 0.03 * n1)       # dark line along the spine
        belly_spots = ss(0.45, 0.7, vnoise(P * np.array((2.2, 1.0, 1.0)), 70.0, 9)) * ss(2.4, 2.7, phi) * 0.8
        a_torso = np.maximum(np.maximum(st, dorsal * 0.95), belly_spots)
        # neck: lines along the top, necklaces round the throat and chest
        dn = np.linalg.norm(Ph - np.array((0.0, 0.245, 0.236)), axis=1)
        neck_rings = ss(0.55, 0.8, 0.5 + 0.5 * np.cos(2 * math.pi * (dn - 0.008 * n1) / 0.019)) * ss(1.1, 1.6, phi)
        neck_rings *= ss(0.05, 0.065, dn) * (1 - ss(0.11, 0.125, dn))
        neck_top = ss(0.6, 0.85, 0.5 + 0.5 * np.cos(2 * math.pi * (x + 0.0015 * n1) / 0.0105)) * (1 - ss(0.7, 1.1, phi))
        neck_w = ss(0.105, 0.135, y)
        a_torso = a_torso * (1 - neck_w) + np.maximum(neck_rings, neck_top) * neck_w
        # legs: rings, weaker on the inside of the leg
        fpts = {s: [_side(FRONT[k], s) for k in ("toe", "knuckle", "wrist", "elbow", "shoulder")] for s in (-1.0, 1.0)}
        hpts = {s: [_side(HIND[k], s) for k in ("toe", "knuckle", "hock", "stifle", "hip")] for s in (-1.0, 1.0)}
        sf = np.zeros(len(P))
        sh = np.zeros(len(P))
        for s in (-1.0, 1.0):
            m = sx == s
            sf[m] = _chain_param_smooth(P[m], fpts[s])
            sh[m] = _chain_param_smooth(P[m], hpts[s])
        self.sf, self.sh = sf, sh
        inner = ss(0.1, 0.6, -nlat)
        ring_f = ss(0.64, 0.86, 0.5 + 0.5 * np.cos(2 * math.pi * (sf + 0.003 * n1) / 0.017)) * (1 - 0.85 * inner)
        ring_f *= ss(0.03, 0.05, sf)                         # paws plain
        ring_h = ss(0.64, 0.86, 0.5 + 0.5 * np.cos(2 * math.pi * (sh + 0.003 * n1) / 0.018)) * (1 - 0.85 * inner)
        ring_h *= ss(0.035, 0.055, sh)
        # dark "stocking" on the back of the hind foot (hock down to the paw)
        stocking = ss(0.25, 0.6, -N[:, 1]) * ss(0.075, 0.06, z) * ss(0.01, 0.02, z)
        a_legh = np.maximum(ring_h, stocking * 0.9)
        # tail: rings and a dark tip
        st_t, _ = _chain_param(P, [tuple(tail_pt(0)), tuple(tail_pt(1.0))])
        ring_t = ss(0.45, 0.72, 0.5 + 0.5 * np.cos(2 * math.pi * (st_t - 0.004 + 0.002 * n1) / 0.024))
        ring_t = np.maximum(ring_t * ss(0.01, 0.03, st_t), ss(0.245, 0.26, st_t))
        self.s_tail = st_t
        # head
        a_head = self._head_pattern(Ph, N, n1)
        reg_t = torso
        a =(a_torso * reg_t + ring_f * legf + a_legh * legh + ring_t * tail + a_head * headr)
        a /= np.maximum(reg_t + legf + legh + tail + headr, 1e-6)
        self.a = np.clip(a, 0.0, 1.0)

        # ---------------------------------------------------------- pale / white areas
        chin = tx.r("chin") + headr * ss(-0.2, -0.6, nz) * ss(0.19, 0.21, yh)
        self.chin = np.clip(chin, 0, 1)
        whisker = tx.r("muzzle") * ss(0.268, 0.259, zh)
        self.muzzle = np.clip(whisker + self.chin, 0, 1)
        self.belly = torso * ss(2.0, 2.45, phi + 0.12 * self.n_lo) * ss(-0.135, -0.105, y) * ss(0.13, 0.10, y)
        bib_zone = ss(0.098, 0.118, y + 0.006 * self.n_lo) * ss(1.45, 2.0, phi + 0.15 * self.n_lo)
        self.bib = np.clip((torso + tx.r("fleg_up")) * bib_zone + self.chin * ss(0.2, 0.19, yh + 0.01), 0, 1)
        # eye surround: pale "spectacles" just outside the lids
        rim = np.zeros(len(P))
        near = np.zeros(len(P))
        for s in (-1.0, 1.0):
            A, r, _, _ = shape.eyes[s].angular(P)
            close = r < EYE_R + 0.0075
            rim = np.maximum(rim, (ss(0.93, 1.0, A) * ss(1.22, 1.12, A)) * close)
            near = np.maximum(near, ss(1.75, 1.25, A) * ss(EYE_R + 0.012, EYE_R + 0.004, r))
        self.eye_rim = np.clip(rim, 0, 1)
        self.spectacles = np.clip(near - rim, 0, 1)
        # skin
        # nose leather: the front of the nose pad only (a rounded triangle, point down)
        tri = ss(0.0010, -0.0004, np.abs(x) - (0.0062 - 0.55 * np.clip(0.2725 - zh, 0, None)) + 0.0004 * n1)
        nose = tx.r("nose", "bridge") * ss(0.05, 0.4, N[:, 1]) * ss(0.2735, 0.2715, zh) * ss(0.2615, 0.2635, zh) * tri
        self.nose = np.clip(nose, 0, 1)
        self.nose_rim = np.clip(tx.r("nose", "bridge") * ss(0.0, 0.3, N[:, 1]) * ss(0.2755, 0.2735, zh)
                                * ss(0.0025, -0.0003, np.abs(x) - (0.0062 - 0.55 * np.clip(0.2725 - zh, 0, None))) - nose, 0, 1)
        self.inner_ear = ss(0.0011, 0.0004, tx.hollow) * tx.r("ear")
        self.lips = ss(0.0011, 0.0004, tx.mouth) * tx.r("muzzle", "chin")
        pads = np.zeros(len(P))
        for s in (-1.0, 1.0):
            for pc, toes, mainr in (((s * FX, 0.093), 0.0122, (0.0085, 0.0060)), ((s * HX, -0.127), 0.0122, (0.0080, 0.0058))):
                cx, cy = pc
                dmain = ((x - cx) / mainr[0]) ** 2 + ((y - (cy - 0.0045)) / mainr[1]) ** 2
                p = ss(1.1, 0.8, dmain)
                for ang in (-52, -18, 18, 52):
                    aa = math.radians(ang)
                    tcx, tcy = cx + math.sin(aa) * toes, cy + math.cos(aa) * toes
                    p = np.maximum(p, ss(0.0044, 0.0034, np.hypot(x - tcx, y - tcy)))
                pads = np.maximum(pads, p)
        pads *= ss(0.0065, 0.004, z) * ss(-0.3, -0.7, nz)
        # carpal pad on the back of each front wrist
        for s in (-1.0, 1.0):
            pads = np.maximum(pads, ss(0.0036, 0.0026, np.linalg.norm(P - np.array((s * FX, FRONT["wrist"][1] - 0.0085, 0.026)), axis=1)))
        self.pads = np.clip(pads, 0, 1)
        self.skin = np.clip(np.maximum.reduce([self.nose, self.inner_ear, self.pads, self.eye_rim, self.lips]), 0, 1)
        self.paws_f = legf * ss(0.036, 0.028, z + 0.004 * self.n_lo)
        self.paws_h = legh * ss(0.028, 0.020, z + 0.004 * self.n_lo)

        # ---------------------------------------------------------- fur map
        L = np.zeros(len(P))
        belly_long = ss(-0.2, -0.65, nz)
        chest_long = ss(0.085, 0.115, y) * ss(1.2, 1.9, phi)
        L_torso = 0.35 + 0.65 * np.maximum(belly_long, chest_long)
        L_torso = np.maximum(L_torso, 0.55 * ss(0.12, 0.16, y))           # neck ruff
        cheeks = tx.r("cheek") * ss(0.236, 0.222, yh) * ss(0.022, 0.03, ax)
        L_head = 0.12 + 0.88 * np.clip(cheeks, 0, 1)
        L_head = np.maximum(L_head, 0.3 * ss(0.205, 0.18, yh) * tx.r("head"))   # back of the head
        breeches = ss(-0.15, -0.55, N[:, 1]) * ss(0.09, 0.13, z)
        L_legh = 0.12 + 0.88 * breeches * tx.r("thigh", "thigh_back") + 0.23 * tx.r("thigh") * (1 - breeches)
        L_legf = 0.12 + 0.2 * tx.r("fleg_up")
        L = (L_torso * reg_t + L_legf * legf + L_legh * legh + 1.0 * tail + L_head * headr)
        L /= np.maximum(reg_t + legf + legh + tail + headr, 1e-6)
        L *= 1.0 - self.skin
        self.fur_len = np.clip(L, 0, 1)
        G = 0.5 * reg_t + 0.3 * (legf + legh) + 0.45 * tail + 0.3 * headr
        G /= np.maximum(reg_t + legf + legh + tail + headr, 1e-6)
        G = G * (1 - 0.5 * belly_long * torso)
        self.fur_root = np.clip(G * (1 - self.skin), 0, 1)
        log(f"painter fields in {time.time() - t0:.1f}s")

    # ------------------------------------------------------------------ head stripes
    def _head_pattern(self, P, N, n1):
        x, y, z = P[:, 0], P[:, 1], P[:, 2]
        ax = np.abs(x)
        sx = self.sx
        front = ss(0.0, 0.35, N[:, 1]) * ss(0.214, 0.226, y)
        # the "M" on the forehead, drawn in the front view (x, z)
        Mpts = [(-0.0185, 0.2985), (-0.0115, 0.3085), (-0.0055, 0.2995), (0.0, 0.3105),
                (0.0055, 0.2995), (0.0115, 0.3085), (0.0185, 0.2985)]
        dM = _polyline_dist(np.stack([x, z], 1), Mpts)
        dM = np.minimum(dM, _polyline_dist(np.stack([x, z], 1), [(0.0, 0.3105), (0.0, 0.2945)]))
        aM = ss(0.0016, 0.0009, dM + 0.0003 * n1) * front
        # lines running back over the crown to the neck
        crown = ss(0.62, 0.86, 0.5 + 0.5 * np.cos(2 * math.pi * (x + 0.001 * n1) / 0.0105)) * ss(0.25, 0.6, N[:, 2])
        crown *= ss(0.236, 0.226, y) * (1 - ss(0.018, 0.024, ax))
        # cheek lines from the outer eye corner backwards
        c1 = [(0.0275, 0.2355, 0.2875), (0.0335, 0.222, 0.2855), (0.0375, 0.205, 0.281), (0.0365, 0.190, 0.270)]
        c2 = [(0.0285, 0.2275, 0.2715), (0.0350, 0.214, 0.2650), (0.0380, 0.200, 0.2575), (0.0330, 0.188, 0.2470)]
        Pm = np.stack([ax, y, z], 1)
        dc = np.minimum(_polyline_dist(Pm, c1), _polyline_dist(Pm, c2))
        aC = ss(0.0021, 0.0012, dc + 0.0004 * n1) * ss(0.15, 0.45, N[:, 0] * sx)
        # ear backs darker
        ear_back = self.tx.r("ear") * ss(0.0, -0.5, N[:, 1]) * 0.55
        return np.clip(np.maximum.reduce([aM, crown, aC, ear_back]), 0, 1)

    # ------------------------------------------------------------------ colour
    def coat(self, name: str) -> np.ndarray:
        """Diffuse colour per texel (sRGB 0..1) for one coat."""
        a = self.a
        nl, nf = self.n_lo, self.n_fine
        n = len(a)

        def c(rgb):
            return np.broadcast_to(np.asarray(rgb, float), (n, 3)).copy()

        def mix(A, B, t):
            return A + (B - A) * np.clip(t, 0, 1)[:, None]

        tick = (1.0 + 0.10 * nf + 0.06 * nl)[:, None]
        white = c((0.93, 0.92, 0.88))
        if name == "tabby":
            ground = c((0.49, 0.41, 0.30)) * tick
            ground = mix(ground, c((0.30, 0.25, 0.19)), ss(0.2, 0.7, self.n_fine) * 0.5)     # darker ticking
            col = mix(ground, c((0.10, 0.08, 0.062)), a * 0.9)
            pale = c((0.82, 0.76, 0.64)) * tick
            throat = ss(0.15, 0.19, self.tx.P[:, 1])
            pale_m = np.maximum.reduce([self.belly, self.chin * 1.0, self.muzzle * 0.9, self.spectacles * 0.85,
                                        self.bib * (0.45 + 0.45 * throat)])
            col = mix(col, pale, pale_m * (1 - 0.7 * a))
            nose, pads, ear_in, rim = (0.70, 0.38, 0.33), (0.20, 0.14, 0.13), (0.74, 0.60, 0.56), (0.07, 0.06, 0.05)
        elif name == "ginger":
            ground = c((0.87, 0.53, 0.22)) * tick
            col = mix(ground, c((0.66, 0.30, 0.09)), a * 0.8)
            col = mix(col, c((0.96, 0.82, 0.60)), np.maximum(self.belly, self.spectacles) * 0.7)
            wm = np.maximum.reduce([self.chin, self.muzzle * 0.8, self.bib, self.belly, self.paws_f, self.paws_h])
            col = mix(col, white, ss(0.35, 0.6, wm + 0.15 * nl))
            nose, pads, ear_in, rim = (0.88, 0.55, 0.50), (0.85, 0.55, 0.52), (0.88, 0.64, 0.58), (0.50, 0.28, 0.16)
        elif name == "black":
            col = c((0.032, 0.028, 0.026)) * (1.0 + 0.15 * nl)[:, None]
            col = mix(col, c((0.075, 0.055, 0.042)), (1 - a) * 0.25 * ss(0.3, 1.0, self.phi))   # rusty sheen, ghost stripes
            nose, pads, ear_in, rim = (0.09, 0.08, 0.08), (0.08, 0.07, 0.07), (0.30, 0.24, 0.24), (0.03, 0.03, 0.03)
        elif name == "white":
            col = c((0.93, 0.92, 0.89)) * (1.0 + 0.02 * nl)[:, None]
            nose, pads, ear_in, rim = (0.90, 0.60, 0.58), (0.88, 0.60, 0.58), (0.93, 0.70, 0.68), (0.72, 0.52, 0.50)
        elif name == "grey":
            ground = c((0.50, 0.52, 0.56)) * tick
            col = mix(ground, c((0.34, 0.36, 0.41)), a * 0.55)
            col = mix(col, c((0.64, 0.65, 0.68)), np.maximum(self.belly, self.chin) * 0.55)
            nose, pads, ear_in, rim = (0.46, 0.42, 0.46), (0.42, 0.38, 0.42), (0.70, 0.58, 0.60), (0.20, 0.20, 0.22)
        elif name == "tux":
            col = c((0.032, 0.028, 0.026)) * (1.0 + 0.15 * nl)[:, None]
            x, y, z = self.Ph[:, 0], self.Ph[:, 1], self.Ph[:, 2]
            blaze = self.headr * ss(0.226, 0.236, y) * ss(0.0045, 0.0025, np.abs(x) - 0.45 * np.clip(0.296 - z, 0, None))
            wm = np.maximum.reduce([self.chin, self.muzzle, blaze, self.bib * 1.0, self.belly,
                                    self.legf * ss(0.046, 0.036, z + 0.004 * nl), self.paws_h])
            col = mix(col, white, ss(0.35, 0.6, wm + 0.15 * nl))
            nose, pads, ear_in, rim = (0.86, 0.58, 0.56), (0.20, 0.16, 0.16), (0.70, 0.55, 0.55), (0.05, 0.05, 0.05)
        else:
            raise KeyError(name)
        # skin
        pinkpads = name in ("ginger", "white")
        col = mix(col, c(rim), self.nose_rim * 0.8)
        col = mix(col, c(nose), self.nose)
        col = mix(col, c(pads if not (name == "tux") else (0.82, 0.55, 0.53)), self.pads * (1.0 if not pinkpads else 1.0))
        col = mix(col, c(ear_in), self.inner_ear)
        col = mix(col, c(rim), self.eye_rim)
        col = mix(col, c(rim) * 0.8 + c(nose) * 0.2, self.lips)
        return np.clip(col, 0.0, 1.0)


# =====================================================================================
# pictures
# =====================================================================================

def save_png(arr: np.ndarray, path: Path) -> None:
    """(H, W, C) 0..1 -> 8-bit PNG, values written as they are (no colour management)."""
    h, w = arr.shape[:2]
    rgba = np.ones((h, w, 4), dtype=np.float32)
    C = arr.shape[2]
    rgba[..., :3] = arr[..., :3] if C >= 3 else np.repeat(arr[..., :1], 3, axis=2)
    np.clip(rgba, 0.0, 1.0, out=rgba)
    img = bpy.data.images.new("save_" + path.stem, w, h, alpha=True, float_buffer=False, is_data=True)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = str(path)
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def eye_texture(res: int = TEX) -> np.ndarray:
    v, u = np.mgrid[0:res, 0:res]
    du = (u + 0.5) / res - 0.5
    dv = (v + 0.5) / res - 0.5
    rho = np.hypot(du, dv) / 0.5                     # 0 centre .. 1 = edge of the eye cap
    th = rho * math.degrees(EYE_CAP)                 # degrees from the eye axis
    psi = np.arctan2(dv, du)
    P = np.stack([du.ravel(), dv.ravel(), np.zeros(du.size)], 1)
    n_rad = fbm(np.stack([np.cos(psi.ravel()) * 3, np.sin(psi.ravel()) * 3, rho.ravel() * 0.4], 1), 9.0, 11).reshape(res, res)
    fib = 0.5 + 0.5 * np.sin(psi * 90 + 6 * n_rad)
    inner = np.array((0.58, 0.64, 0.22))
    mid = np.array((0.86, 0.68, 0.20))
    outer = np.array((0.74, 0.47, 0.12))
    t = np.clip(th / 52.0, 0, 1)[..., None]
    col = np.where(t < 0.45, inner + (mid - inner) * (t / 0.45), mid + (outer - mid) * ((t - 0.45) / 0.55))
    col = col * (0.85 + 0.25 * fib[..., None]) * (0.92 + 0.12 * fbm(P, 30.0, 12).reshape(res, res)[..., None])
    # dark limbal ring and the sclera beyond
    limb = ss(44.0, 51.0, th)
    col = col * (1 - 0.75 * limb[..., None])
    sclera = ss(52.0, 55.0, th)
    col = col + (np.array((0.62, 0.54, 0.44)) - col) * sclera[..., None]
    # slit pupil (vertical, pointed ends)
    ph, pw = 0.30, 0.065
    yy = dv / ph
    half = pw * np.clip(1.0 - yy * yy, 0.0, 1.0)
    pupil = ss(0.004, -0.002, np.abs(du) - half) * (np.abs(yy) < 1.0)
    col = col * (1 - pupil[..., None]) + np.array((0.012, 0.010, 0.010)) * pupil[..., None]
    return np.clip(col, 0, 1).astype(np.float32)


# =====================================================================================
# materials
# =====================================================================================

def body_material(name: str, diff: bpy.types.Image | None, fur: bpy.types.Image | None) -> bpy.types.Material:
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Roughness"].default_value = 0.75
    bsdf.inputs["Base Color"].default_value = (0.5, 0.4, 0.3, 1.0)
    if diff is not None:
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.uv_map = geo.UV0
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = diff
        nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if fur is not None:
            ft = nt.nodes.new("ShaderNodeTexImage")
            ft.image = fur
            nt.links.new(uv.outputs["UV"], ft.inputs["Vector"])
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(ft.outputs["Color"], sep.inputs["Color"])
            rmap = nt.nodes.new("ShaderNodeMapRange")
            rmap.inputs["To Min"].default_value = 0.78
            rmap.inputs["To Max"].default_value = 0.32
            nt.links.new(sep.outputs["Blue"], rmap.inputs["Value"])
            nt.links.new(rmap.outputs["Result"], bsdf.inputs["Roughness"])
    return m


def eye_material(img: bpy.types.Image | None) -> bpy.types.Material:
    m = bpy.data.materials.get("cat_eyes") or bpy.data.materials.new("cat_eyes")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.04
    bsdf.inputs["Coat Weight"].default_value = 1.0
    bsdf.inputs["Coat Roughness"].default_value = 0.02
    bsdf.inputs["Base Color"].default_value = (0.7, 0.5, 0.1, 1.0)
    if img is not None:
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.uv_map = geo.UV0
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return m


# =====================================================================================
# poses (degrees about each bone's own axes; X bends in the side view, + swings forward/up)
# ".*" entries are applied to both sides (Y and Z mirrored on the left).
# =====================================================================================

POSES: dict[str, dict] = {
    "sit": {
        "rot": {
            "hips": (48, 0, 0), "spine1": (-4, 0, 0), "spine2": (-8, 0, 0), "chest": (-10, 0, 0),
            "neck": (-6, 0, 0), "head": (-22, 0, 0),
            "scapula.*": (-14, 0, 0), "upperarm.*": (-8, 0, 0), "forearm.*": (-4, 0, 0), "wrist.*": (-14, 0, 0),
            "paw.*": (0, 0, 0),
            "thigh.*": (12, 0, 0), "shin.*": (-78, 0, 0), "hock.*": (96, 0, 0), "hindpaw.*": (-60, 0, 0),
            "tail1": (-45, 0, 0), "tail2": (-25, 0, 20), "tail3": (0, 0, 30), "tail4": (0, 0, 30), "tail5": (0, 0, 25),
        },
        "loc": {"hips": (0, 0, -0.09)},
    },
    "crouch": {
        "rot": {
            "hips": (-2, 0, 0), "spine1": (2, 0, 0), "chest": (-6, 0, 0), "neck": (-28, 0, 0), "head": (26, 0, 0),
            "scapula.*": (22, 0, 0), "upperarm.*": (-58, 0, 0), "forearm.*": (70, 0, 0), "wrist.*": (2, 0, 0),
            "paw.*": (0, 0, 0),
            "thigh.*": (34, 0, 0), "shin.*": (-62, 0, 0), "hock.*": (32, 0, 0), "hindpaw.*": (-6, 0, 0),
            "tail1": (-12, 0, 0), "tail2": (4, 0, 0),
        },
        "loc": {"hips": (0, 0, -0.10)},
    },
    "gallop_stretch": {
        "rot": {
            "hips": (4, 0, 0), "spine1": (-3, 0, 0), "spine2": (-3, 0, 0), "chest": (-2, 0, 0),
            "neck": (-10, 0, 0), "head": (6, 0, 0),
            "scapula.*": (20, 0, 0), "upperarm.*": (22, 0, 0), "forearm.*": (8, 0, 0), "wrist.*": (12, 0, 0),
            "thigh.*": (-62, 0, 0), "shin.*": (40, 0, 0), "hock.*": (-50, 0, 0), "hindpaw.*": (-12, 0, 0),
            "tail1": (-14, 0, 0), "tail2": (-4, 0, 0),
        },
        "loc": {},
    },
    "gallop_gather": {
        "rot": {
            "hips": (14, 0, 0), "spine1": (-8, 0, 0), "spine2": (-14, 0, 0), "chest": (-16, 0, 0),
            "neck": (12, 0, 0), "head": (8, 0, 0),
            "scapula.*": (-12, 0, 0), "upperarm.*": (-10, 0, 0), "forearm.*": (0, 0, 0), "wrist.*": (-25, 0, 0),
            "thigh.*": (14, 0, 0), "shin.*": (45, 0, 0), "hock.*": (-57, 0, 0), "hindpaw.*": (-22, 0, 0),
            "tail1": (-20, 0, 0), "tail2": (-10, 0, 0), "tail3": (-6, 0, 0),
        },
        "loc": {},
    },
    "slap": {
        "rot": {
            "hips": (8, 0, 0), "chest": (-6, 0, 0), "neck": (-6, 0, 0), "head": (4, 0, 6),
            "scapula.R": (20, 0, 0), "upperarm.R": (95, 0, 0), "forearm.R": (30, 0, 0), "wrist.R": (-10, 0, 0),
            "paw.R": (10, 0, 0),
            "scapula.L": (-4, 0, 0), "upperarm.L": (-6, 0, 0),
            "tail1": (-10, 0, 0),
        },
        "loc": {},
    },
    "head_turn": {
        "rot": {"neck": (4, 0, 0)},
        "world": {"neck": ((0.0, 0.0, 1.0), 28.0), "head": ((0.0, 0.0, 1.0), 32.0)},
    },
    "walk": {
        "rot": {
            "scapula.L": (16, 0, 0), "upperarm.L": (30, 0, 0), "forearm.L": (18, 0, 0), "wrist.L": (8, 0, 0),
            "scapula.R": (10, 0, 0), "upperarm.R": (22, 0, 0), "forearm.R": (12, 0, 0),
            "thigh.L": (-14, 0, 0), "thigh.R": (10, 0, 0), "shin.R": (-6, 0, 0),
            "neck": (-6, 0, 0), "head": (4, 0, 0),
        },
        "loc": {},
    },
}


def apply_pose(rig: bpy.types.Object, pose: dict | None) -> None:
    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0.0, 0.0, 0.0)
        pb.location = (0.0, 0.0, 0.0)
    if not pose:
        bpy.context.view_layer.update()
        return
    for key, (rx, ry, rz) in pose.get("rot", {}).items():
        targets = [(key[:-1] + "R", 1.0), (key[:-1] + "L", -1.0)] if key.endswith(".*") else [(key, 1.0)]
        for name, m in targets:
            pb = rig.pose.bones[name]
            pb.rotation_euler = (math.radians(rx), math.radians(ry * m), math.radians(rz * m))
    for name, loc in pose.get("loc", {}).items():
        rig.pose.bones[name].location = loc
    bpy.context.view_layer.update()
    for name, (axis, deg) in pose.get("world", {}).items():
        rotate_world(rig, name, axis, deg)


def rotate_world(rig: bpy.types.Object, name: str, axis, deg: float) -> None:
    """Rotate a pose bone about an armature-space axis through its head."""
    pb = rig.pose.bones[name]
    head = pb.head.copy()
    R = Matrix.Rotation(math.radians(deg), 4, Vector(axis))
    pb.matrix = Matrix.Translation(head) @ R @ Matrix.Translation(-head) @ pb.matrix
    bpy.context.view_layer.update()


def evaluated_coords(obj: bpy.types.Object) -> np.ndarray:
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    V = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", V)
    ev.to_mesh_clear()
    V = V.reshape(-1, 3)
    mw = np.array(obj.matrix_world)
    return V @ mw[:3, :3].T + mw[:3, 3]


def ground(rig: bpy.types.Object, body: bpy.types.Object) -> float:
    """Move the root so the lowest point of the posed body touches z = 0."""
    bpy.context.view_layer.update()
    V = evaluated_coords(body)
    dz = float(V[:, 2].min()) - rig.matrix_world.translation.z
    rig.pose.bones["root"].location.z -= dz
    bpy.context.view_layer.update()
    return dz


# =====================================================================================
# build everything
# =====================================================================================

class Cat:
    def __init__(self):
        self.shape: Shape | None = None
        self.rig = self.body = self.eyes = None
        self.painter: Painter | None = None
        self.texels: Texels | None = None
        self.images: dict[str, bpy.types.Image] = {}
        self.coat_px: dict[str, np.ndarray] = {}
        self.fur_px: np.ndarray | None = None


def build(coll=None, target_faces: int = 3500) -> Cat:
    coll = coll or geo.collection("cat")
    cat = Cat()
    t0 = time.time()
    cat.shape = Shape()
    cat.body = build_body_mesh(cat.shape, coll, target_faces)
    unwrap(cat.body)
    cat.rig = build_rig(coll)
    names, W = compute_weights(cat.shape, cat.body.data)
    apply_weights(cat.body, names, W)
    bind(cat.body, cat.rig)
    cat.eyes = build_eyes(coll)
    g = cat.eyes.vertex_groups.new(name="head")
    g.add(list(range(len(cat.eyes.data.vertices))), 1.0, "REPLACE")
    bind(cat.eyes, cat.rig)
    nmax = max(len(v.groups) for v in cat.body.data.vertices)
    log(f"rig: {len(cat.rig.data.bones)} bones, worst local-X . world-X = {check_rig_axes(cat.rig):.4f}, "
        f"max influences {nmax}; built in {time.time() - t0:.1f}s")
    return cat


def paint(cat: Cat, out_dir: Path | None = None) -> dict[str, bpy.types.Image]:
    """Compute all pictures; save them to out_dir if given; return them as Blender images."""
    t0 = time.time()
    cat.texels = tx = Texels(cat.shape, cat.body)
    cat.painter = pt = Painter(cat.shape, tx)
    images: dict[str, bpy.types.Image] = {}

    def to_image(name, arr, data: bool):
        h, w = arr.shape[:2]
        rgba = np.ones((h, w, 4), np.float32)
        rgba[..., :3] = arr[..., :3]
        if out_dir is not None:
            path = out_dir / f"{name}.png"
            save_png(arr, path)
            img = bpy.data.images.load(str(path), check_existing=False)
        else:
            img = bpy.data.images.new(name, w, h, alpha=True)
            img.pixels.foreach_set(rgba.ravel())
            img.pack()
        img.name = name
        img.colorspace_settings.name = "Non-Color" if data else "sRGB"
        images[name] = img
        return img

    for coat in COATS:
        cat.coat_px[coat] = tx.image(pt.coat(coat))
        to_image(f"cat_{coat}_diff", cat.coat_px[coat], False)
    fur = np.stack([pt.fur_len, pt.fur_root, pt.skin], axis=1)
    # what the fur map says, part by part (to compare with the spec)
    P, N = tx.P, tx.N
    probes = {
        "back": (pt.torso > 0.9) & (pt.phi < 0.5) & (P[:, 1] < 0.05),
        "flank": (pt.torso > 0.9) & (np.abs(pt.phi - 1.5) < 0.2) & (P[:, 1] < 0.03),
        "belly": (pt.torso > 0.9) & (N[:, 2] < -0.8),
        "chest": (pt.torso > 0.9) & (P[:, 1] > 0.12) & (N[:, 1] > 0.5) & (P[:, 2] < 0.17),
        "cheeks": tx.r("cheek") > 0.9,
        "face": (tx.r("bridge", "muzzle") > 0.9) & (pt.skin < 0.1),
        "ear back": (tx.r("ear") > 0.9) & (N[:, 1] < -0.5),
        "inner ear": pt.inner_ear > 0.9,
        "front legs": (pt.legf > 0.9) & (P[:, 2] > 0.04) & (P[:, 2] < 0.10),
        "back of thighs": (tx.r("thigh_back") > 0.9) & (N[:, 1] < -0.6),
        "tail": pt.tail > 0.95,
        "nose": pt.nose > 0.9,
        "paw pads": pt.pads > 0.9,
        "eye rims": pt.eye_rim > 0.9,
    }
    rows = []
    for name, m in probes.items():
        if m.any():
            rows.append(f"{name} R {fur[m, 0].mean():.2f} G {fur[m, 1].mean():.2f} B {fur[m, 2].mean():.2f}")
    log("fur map: " + "; ".join(rows))
    cat.fur_px = tx.image(fur)
    to_image("cat_fur", cat.fur_px, True)
    to_image("cat_eyes", eye_texture(), False)
    cat.images = images
    log(f"textures in {time.time() - t0:.1f}s")
    return images


def vertex_fur(cat: Cat) -> tuple[np.ndarray, np.ndarray]:
    """Per-vertex fur length and density (for the hair preview), read back from the fur map."""
    img = cat.images["cat_fur"]
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    uv, tl, tv = cat.texels.vert_uv
    me = cat.body.data
    lv = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", lv)
    ix = np.clip((uv[:, 0] * w).astype(int), 0, w - 1)
    iy = np.clip((uv[:, 1] * h).astype(int), 0, h - 1)
    samp = px[iy, ix]
    n = len(me.vertices)
    cnt = np.bincount(lv, minlength=n).astype(float)
    L = np.bincount(lv, weights=samp[:, 0], minlength=n) / np.maximum(cnt, 1)
    B = np.bincount(lv, weights=samp[:, 2], minlength=n) / np.maximum(cnt, 1)
    return L, 1.0 - B


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hair_material() -> bpy.types.Material:
    m = bpy.data.materials.get("cat_fur_preview")
    if m is not None:
        return m
    m = bpy.data.materials.new("cat_fur_preview")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    hb = nt.nodes.new("ShaderNodeBsdfHairPrincipled")
    hb.parametrization = "COLOR"
    hb.inputs["Roughness"].default_value = 0.5
    hb.inputs["Radial Roughness"].default_value = 0.7
    hb.inputs["Coat"].default_value = 0.0
    col = nt.nodes.new("ShaderNodeAttribute")
    col.attribute_name = "fur_col"
    g = nt.nodes.new("ShaderNodeAttribute")
    g.attribute_name = "fur_root"
    info = nt.nodes.new("ShaderNodeHairInfo")
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = "SUBTRACT"
    inv.inputs[0].default_value = 1.0
    nt.links.new(info.outputs["Intercept"], inv.inputs[1])
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    nt.links.new(inv.outputs[0], mul.inputs[0])
    nt.links.new(g.outputs["Fac"], mul.inputs[1])
    dark = nt.nodes.new("ShaderNodeMath")
    dark.operation = "MULTIPLY_ADD"
    nt.links.new(mul.outputs[0], dark.inputs[0])
    dark.inputs[1].default_value = -0.6
    dark.inputs[2].default_value = 1.0
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    nt.links.new(col.outputs["Color"], mix.inputs["A"])
    nt.links.new(dark.outputs[0], mix.inputs["B"])
    nt.links.new(mix.outputs["Result"], hb.inputs["Color"])
    nt.links.new(hb.outputs[0], out.inputs["Surface"])
    return m


def fur_preview(cat: Cat, coat: str, coll, strands: int = 240000, seed: int = 5) -> bpy.types.Object:
    """A quick look at the fur: real hair strands grown from the fur map, coloured by the coat."""
    t0 = time.time()
    me = cat.body.data
    me.calc_loop_triangles()
    T = len(me.loop_triangles)
    tv = np.empty(T * 3, np.int64)
    tl = np.empty(T * 3, np.int64)
    me.loop_triangles.foreach_get("vertices", tv)
    me.loop_triangles.foreach_get("loops", tl)
    tv, tl = tv.reshape(T, 3), tl.reshape(T, 3)
    V = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", V)
    V = V.reshape(-1, 3)
    Nv = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", Nv)
    Nv = Nv.reshape(-1, 3)
    uv = cat.texels.vert_uv[0]
    A = 0.5 * np.linalg.norm(np.cross(V[tv[:, 1]] - V[tv[:, 0]], V[tv[:, 2]] - V[tv[:, 0]]), axis=1)
    rng = np.random.default_rng(seed)
    pick = rng.choice(T, strands, p=A / A.sum())
    r1, r2 = rng.random(strands), rng.random(strands)
    s1 = np.sqrt(r1)
    b = np.stack([1 - s1, s1 * (1 - r2), s1 * r2], 1)
    root = np.einsum("nk,nkc->nc", b, V[tv[pick]])
    nrm = np.einsum("nk,nkc->nc", b, Nv[tv[pick]])
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    uvr = np.einsum("nk,nkc->nc", b, uv[tl[pick]])
    res = cat.fur_px.shape[0]
    ix = np.clip((uvr[:, 0] * res).astype(int), 0, res - 1)
    iy = np.clip((uvr[:, 1] * res).astype(int), 0, res - 1)
    fur = cat.fur_px[iy, ix]
    L = fur[:, 0] * 0.028
    keep = (L > 0.0012) & (fur[:, 2] < 0.5)
    # which part each root sits on -> which way the fur lies
    vl = cat.texels.vlab
    keys = list(vl.keys())
    Dm = np.stack([np.maximum(np.einsum("nk,nk->n", b, vl[k][tv[pick]]), 0.0) for k in keys], 1)
    Dm -= Dm.min(axis=1, keepdims=True)
    M = np.exp(-Dm / 0.002)
    M /= M.sum(axis=1, keepdims=True)
    reg = {k: M[:, i] for i, k in enumerate(keys)}

    def r(*names):
        return sum(reg.get(n, 0.0) for n in names)

    back = np.array((0.0, -1.0, -0.2))
    down = np.array((0.0, -0.25, -1.0))
    chest_down = ss(0.09, 0.12, root[:, 1]) * ss(0.1, 0.5, nrm[:, 1] - nrm[:, 2])
    w_body = r("torso", "head", "cheek", "bridge", "muzzle", "nose", "chin", "lids") * (1 - chest_down)
    w_down = r("fleg_up", "fleg", "fpaw", "thigh", "thigh_back", "hleg", "hpaw") + r("torso") * chest_down
    flow = (w_body[:, None] * back + w_down[:, None] * down + r("tail")[:, None] * TAIL_DIR
            + r("ear")[:, None] * np.array((0.0, -0.1, 1.0)))
    flow -= np.einsum("ij,ij->i", flow, nrm)[:, None] * nrm
    flow /= np.maximum(np.linalg.norm(flow, axis=1, keepdims=True), 1e-6)
    jit = rng.normal(size=(strands, 3)) * 0.16
    lift = 0.55 - 0.3 * np.clip(L / 0.028, 0, 1)        # long fur lies flatter
    d0 = nrm * lift[:, None] + flow + jit
    d0 /= np.linalg.norm(d0, axis=1, keepdims=True)
    d1 = d0 + 0.9 * flow
    d1 /= np.linalg.norm(d1, axis=1, keepdims=True)
    d2 = d1 + 1.2 * flow - 0.25 * nrm
    d2 /= np.linalg.norm(d2, axis=1, keepdims=True)
    Ls = (L * (0.75 + 0.5 * rng.random(strands)))[:, None] / 3.0
    p0 = root - nrm * 0.0003
    p1 = p0 + d0 * Ls
    p2 = p1 + d1 * Ls
    p3 = p2 + d2 * Ls
    pts = np.stack([p0, p1, p2, p3], 1)[keep]
    n = len(pts)
    colour = _srgb_to_linear(cat.coat_px[coat][iy, ix][keep].astype(np.float64))
    cv = bpy.data.hair_curves.new("CatFur")
    cv.add_curves([4] * n)
    cv.position_data.foreach_set("vector", pts.astype(np.float32).ravel())
    rad = cv.attributes.get("radius") or cv.attributes.new("radius", "FLOAT", "POINT")
    rad.data.foreach_set("value", np.tile(np.array((0.00007, 0.00006, 0.000045, 0.00002), np.float32), n))
    ca = cv.attributes.new("fur_col", "FLOAT_COLOR", "CURVE")
    rgba = np.ones((n, 4), np.float32)
    rgba[:, :3] = colour
    ca.data.foreach_set("color", rgba.ravel())
    ga = cv.attributes.new("fur_root", "FLOAT", "CURVE")
    ga.data.foreach_set("value", fur[keep, 1].astype(np.float32))
    cv.materials.append(hair_material())
    obj = bpy.data.objects.new("CatFur", cv)
    coll.objects.link(obj)
    obj.parent = cat.rig
    log(f"fur preview: {n} strands ({coat}) in {time.time() - t0:.1f}s")
    return obj


def demo(coll, name=None) -> dict:
    """For the stage job: one cat standing at the origin (also writes the same pictures as build_cat)."""
    from wc import paths

    cat = build(coll)
    paint(cat, paths.ensure(paths.BUILD / "export" / "cats"))
    cat.body.data.materials.append(body_material("cat_body", cat.images["cat_tabby_diff"], cat.images["cat_fur"]))
    cat.eyes.data.materials.append(eye_material(cat.images["cat_eyes"]))
    return {"focus": (0.0, -0.05, 0.16), "radius": 0.45}
