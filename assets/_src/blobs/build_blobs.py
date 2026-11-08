"""
Bot HQ blob generator  (Blender 5.x, headless)

    blender -b --factory-startup -P build_blobs.py -- [--only id1,id2] [--no-thumbs] [--no-glb]
    blender -b --factory-startup -P build_blobs.py -- --lib [--only shape1,shape2] [--lib-px 160] [--lib-samples 64]
    blender -b --factory-startup -P build_blobs.py -- --lib-from <dir of GLBs from export_lib.mjs> [--lib-px 160]

Builds every jelly blob in BLOBS from a data table and writes
    assets/blobs/<id>.glb            (root `blob` -> body, eye_L, eye_R, [extra])
    assets/blobs/thumbs/<id>.png     (256x256, transparent, Eevee)

LIBRARY mode, the panels' pictures of ANY user's bots, rendered once and served as static files.
--lib-from (current): export_lib.mjs saves every shape of web/scene/blobgen.js (the office's own generator, traced
from the Grok Bot app's avatars) in the app's 11 colours as GLBs, and this script renders each one in the same studio,
so the panels show exactly what the office shows. --lib (older): geometry from LIB_SPECS below, its first 12 shapes
x LIB_COLORS, accessory none.
    assets/blobs/lib/<shape>-<RRGGBB>.png   (160x160, transparent)
    assets/blobs/lib/index.json             ({"shapes": [...], "colors": [...]}, the palette the web picks from)

Geometry is fully procedural (no modifiers): every silhouette is a closed 2D outline that is
star-shaped around its origin, converted to a polar radius function r(theta).  The body is a
UV-sphere-like grid (rings from the front pole to the back pole) whose cross section is a flat,
slightly domed face + a full-round quarter-ellipse bevel, i.e. an "inflated gummy" slab.

Coordinates while designing ("local"): x right, y up, +z = the way the blob faces (toward viewer).
Blender coords = (x, -z, y), so the face looks toward Blender -Y == glTF +Z.   Units: metres.
Angles of tilt are CCW as seen by the viewer looking at the face (same as the app avatars).
"""
import bpy, bmesh, json, math, os, sys
import numpy as np

ROOT = r"C:\Users\Asus\Desktop\bot-hq\assets"
OUT = os.path.join(ROOT, "blobs")
THUMBS = os.path.join(OUT, "thumbs")
LIB_DIR = os.path.join(OUT, "lib")
SIZE = 0.8  # max dimension of a blob in metres
FLAT_BOTTOM = 0.018  # height of the soft-flattened contact patch at the bottom (m)

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ONLY = None
if "--only" in argv:
    ONLY = argv[argv.index("--only") + 1].split(",")
DO_GLB = "--no-glb" not in argv
DO_THUMBS = "--no-thumbs" not in argv
DO_LIB = "--lib" in argv
LIB_PX = int(argv[argv.index("--lib-px") + 1]) if "--lib-px" in argv else 160
LIB_SAMPLES = int(argv[argv.index("--lib-samples") + 1]) if "--lib-samples" in argv else 64
LIB_FROM = argv[argv.index("--lib-from") + 1] if "--lib-from" in argv else None
if "--lib-out" in argv:                      # e.g. a scratch folder for a trial run
    LIB_DIR = argv[argv.index("--lib-out") + 1]


# ----------------------------------------------------------------------------- colour helpers
def srgb2lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex2lin(h, a=1.0):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (srgb2lin(r), srgb2lin(g), srgb2lin(b), a)


def shade(h, t):
    """mix a colour toward white (t > 0) or black (t < 0) by |t|; returns RRGGBB"""
    h = h.lstrip("#")
    tgt = 255 if t > 0 else 0
    return "%02X%02X%02X" % tuple(round(c + (tgt - c) * abs(t)) for c in (int(h[i:i + 2], 16) for i in (0, 2, 4)))


# ----------------------------------------------------------------------------- outline primitives
# every primitive returns an (M,2) closed CCW polyline, origin = kernel point of the shape
def sup(a, b, n, N=720):
    t = np.linspace(0, 2 * np.pi, N, endpoint=False)
    c, s = np.cos(t), np.sin(t)
    r = (np.abs(c / a) ** n + np.abs(s / b) ** n) ** (-1.0 / n)
    return np.stack([r * c, r * s], 1)


def reg(n, R, rot_deg):
    return np.array([[R * math.cos(math.radians(rot_deg + 360.0 * k / n)),
                      R * math.sin(math.radians(rot_deg + 360.0 * k / n))] for k in range(n)])


def rpoly(core, rr, arc=24):
    """Convex core polygon (CCW) offset by radius rr -> rounded polygon outline."""
    core = np.asarray(core, float)
    n = len(core)
    normals = []
    for i in range(n):
        e = core[(i + 1) % n] - core[i]
        v = np.array([e[1], -e[0]])
        normals.append(v / np.linalg.norm(v))
    pts = []
    for i in range(n):
        a0 = math.atan2(normals[i - 1][1], normals[i - 1][0])
        a1 = math.atan2(normals[i][1], normals[i][0])
        while a1 < a0:
            a1 += 2 * math.pi
        for t in np.linspace(a0, a1, arc):
            pts.append(core[i] + rr * np.array([math.cos(t), math.sin(t)]))
    return np.array(pts)


def star(k, rin, p, tip_deg, N=1440):
    """k-pointed soft star (also used for flowers): r = rin + (1-rin)*((1+cos(k(t-tip)))/2)^p"""
    t = np.linspace(0, 2 * np.pi, N, endpoint=False)
    g = ((1 + np.cos(k * (t - math.radians(tip_deg)))) / 2) ** p
    r = rin + (1 - rin) * g
    return np.stack([r * np.cos(t), r * np.sin(t)], 1)


def rotp(p, deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return p @ np.array([[c, s], [-s, c]])


def make_outline(shape, rot=0.0):
    kind, kw = shape
    if kind == "sup":
        pts = sup(**kw)
    elif kind == "star":
        pts = star(**kw)
    elif kind == "poly":  # regular rounded polygon: n, R (outer radius), rr (corner radius), rot, sy
        R, rr = kw["R"], kw["rr"]
        pts = rpoly(reg(kw["n"], R - rr, kw.get("rot", 90)), rr)
        pts = pts * np.array([1.0, kw.get("sy", 1.0)])
    elif kind == "tri":  # arbitrary triangle: angles, radii, rr
        core = np.array([[ra * math.cos(math.radians(a)), ra * math.sin(math.radians(a))]
                         for a, ra in zip(kw["angles"], kw["radii"])])
        pts = rpoly(core, kw["rr"])
    else:
        raise ValueError(kind)
    return rotp(pts, rot) if rot else pts


def to_polar(pts, N):
    """radius of a star-shaped closed polyline along N uniformly spaced rays from the origin"""
    P = pts
    Q = np.roll(pts, -1, axis=0)
    th = np.arange(N) * 2 * np.pi / N
    D = np.stack([np.cos(th), np.sin(th)], 1)
    E = Q - P

    def cr(a, b):
        return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]

    den = cr(D[:, None, :], E[None, :, :])
    t = cr(P[None, :, :], E[None, :, :]) / np.where(np.abs(den) < 1e-12, 1e-12, den)
    s = cr(P[None, :, :], D[:, None, :]) / np.where(np.abs(den) < 1e-12, 1e-12, den)
    ok = (np.abs(den) > 1e-12) & (s >= -1e-9) & (s <= 1 + 1e-9) & (t > 0)
    return np.where(ok, t, 0).max(axis=1)


def csmooth(a, passes=1):
    for _ in range(passes):
        a = 0.25 * np.roll(a, 1) + 0.5 * a + 0.25 * np.roll(a, -1)
    return a


# ----------------------------------------------------------------------------- body
class Body:
    def __init__(self, shape, rot, D, N=96, depth=0.5, bevel=0.92, dome=0.10, nb=8,
                 flat=(0.45, 0.8), wob=()):
        self.N, self.nb, self.dome, self.flat = N, nb, dome, flat
        self.th = np.arange(N) * 2 * np.pi / N
        r = to_polar(make_outline(shape, rot), N)
        for (k, amp, ph) in wob:
            r = r * (1 + amp * np.cos(k * (self.th - math.radians(ph))))
        r = csmooth(r, 1)
        pts = np.stack([r * np.cos(self.th), r * np.sin(self.th)], 1)
        ext = max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1]))
        self.r = r * (D / ext)
        self.D = D
        self.T = depth * D / 2.0
        self.W = csmooth(np.minimum(bevel * self.T, 0.85 * self.r), 3)
        self.pts = np.stack([self.r * np.cos(self.th), self.r * np.sin(self.th)], 1)

    # -- ring tables
    def rings(self):
        r, W, T, dome = self.r, self.W, self.T, self.dome
        rho, z = [], []
        for f in self.flat:
            rho.append(f * (r - W))
            z.append(T * (1 + dome * (1 - f * f) ** 2) * np.ones_like(r))
        for i in range(self.nb + 1):
            a = (np.pi / 2) * i / self.nb
            rho.append(r - W * (1 - np.sin(a)))
            z.append(T * np.cos(a) * np.ones_like(r))
        fr, fz = np.array(rho), np.array(z)
        br, bz = fr[:-1][::-1], -fz[:-1][::-1]
        return np.vstack([fr, br]), np.vstack([fz, bz])

    def emit(self, mb, off, mat=0):
        rho, z = self.rings()
        R, N = rho.shape
        th = self.th
        x = rho * np.cos(th)[None, :]
        y = rho * np.sin(th)[None, :]
        V = np.concatenate([[[0, 0, self.T * (1 + self.dome)]],
                            np.stack([x, y, z], 2).reshape(-1, 3),
                            [[0, 0, -self.T * (1 + self.dome)]]]) + np.asarray(off)
        faces = []
        for k in range(N):
            k1 = (k + 1) % N
            faces.append((0, 1 + k1, 1 + k))
        for j in range(R - 1):
            for k in range(N):
                k1 = (k + 1) % N
                faces.append((1 + j * N + k, 1 + j * N + k1, 1 + (j + 1) * N + k1, 1 + (j + 1) * N + k))
        base = 1 + (R - 1) * N
        last = 1 + R * N
        for k in range(N):
            k1 = (k + 1) % N
            faces.append((last, base + k, base + k1))
        mb.add(V, faces, mat)

    # -- queries on the front surface (local coords, relative to the body origin)
    def _interp(self, arr, th):
        return float(np.interp(th, np.append(self.th, 2 * np.pi), np.append(arr, arr[0])))

    def z_at(self, x, y):
        rho = math.hypot(x, y)
        th = math.atan2(y, x) % (2 * math.pi)
        r, W = self._interp(self.r, th), self._interp(self.W, th)
        rho = min(rho, r * 0.999)
        e = r - rho
        if e >= W:
            f = rho / (r - W)
            return self.T * (1 + self.dome * (1 - f * f) ** 2)
        s = 1 - e / W
        return self.T * math.sqrt(max(0.0, 1 - s * s))

    def n_at(self, x, y, h=0.004):
        dzdx = (self.z_at(x + h, y) - self.z_at(x - h, y)) / (2 * h)
        dzdy = (self.z_at(x, y + h) - self.z_at(x, y - h)) / (2 * h)
        n = np.array([-dzdx, -dzdy, 1.0])
        return n / np.linalg.norm(n)

    def r_at(self, th):
        return self._interp(self.r, th % (2 * math.pi))


# ----------------------------------------------------------------------------- mesh plumbing
class MB:
    """collects verts/faces/material index in local design coords"""

    def __init__(self):
        self.v, self.f, self.m, self.n = [], [], [], 0

    def add(self, verts, faces, mat=0):
        verts = np.asarray(verts, float)
        self.v.append(verts)
        self.f += [tuple(i + self.n for i in f) for f in faces]
        self.m += [mat] * len(faces)
        self.n += len(verts)

    def verts(self):
        return np.vstack(self.v)


def to_bl(V):
    V = np.asarray(V, float)
    return np.stack([V[..., 0], -V[..., 2], V[..., 1]], -1)


def make_obj(name, V, faces, mats, matidx, loc=(0, 0, 0), parent=None):
    """V in local design coords (already shifted); loc in local design coords (object origin)"""
    me = bpy.data.meshes.new(name)
    Vb = to_bl(np.asarray(V) - np.asarray(loc))
    me.from_pydata([tuple(v) for v in Vb], [], [tuple(f) for f in faces])
    me.update()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.faces.ensure_lookup_table()
    for f, mi in zip(bm.faces, matidx):
        f.material_index = mi
        f.smooth = True
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = tuple(to_bl(np.asarray(loc, float)))
    if parent is not None:
        ob.parent = parent
    return ob


def ellipsoid(rx, ry, rz, S=16, Rg=10, m=2.7):
    """capsule-ish ellipsoid, poles on +-z (z is the face normal). returns verts, faces"""
    V = [[0, 0, rz]]
    for i in range(1, Rg):
        ph = math.pi * i / Rg
        for j in range(S):
            t = 2 * math.pi * j / S
            c, s = math.cos(t), math.sin(t)
            k = (abs(c) ** m + abs(s) ** m) ** (-1.0 / m)  # squarish cross-section
            V.append([rx * math.sin(ph) * c * k, ry * math.sin(ph) * s * k, rz * math.cos(ph)])
    V.append([0, 0, -rz])
    F = []
    for j in range(S):
        F.append((0, 1 + (j + 1) % S, 1 + j))
    for i in range(Rg - 2):
        for j in range(S):
            j1 = (j + 1) % S
            F.append((1 + i * S + j, 1 + i * S + j1, 1 + (i + 1) * S + j1, 1 + (i + 1) * S + j))
    last = len(V) - 1
    b = 1 + (Rg - 2) * S
    for j in range(S):
        F.append((last, b + j, b + (j + 1) % S))
    return np.array(V), F


def torus(R, r, nu=20, nv=8):
    V = []
    for i in range(nu):
        a = 2 * math.pi * i / nu
        for j in range(nv):
            b = 2 * math.pi * j / nv
            V.append([(R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)])
    F = []
    for i in range(nu):
        for j in range(nv):
            F.append((i * nv + j, ((i + 1) % nu) * nv + j, ((i + 1) % nu) * nv + (j + 1) % nv, i * nv + (j + 1) % nv))
    return np.array(V), F


def tube(path, radii, sides=8):
    """tube along a 3D polyline with end caps. returns verts, faces"""
    path = np.asarray(path, float)
    M = len(path)
    V, F = [], []
    ref = np.array([0.0, 0.0, 1.0])
    for i in range(M):
        T = path[min(i + 1, M - 1)] - path[max(i - 1, 0)]
        T /= np.linalg.norm(T)
        n1 = np.cross(T, ref)
        if np.linalg.norm(n1) < 1e-6:
            n1 = np.cross(T, np.array([0.0, 1.0, 0.0]))
        n1 /= np.linalg.norm(n1)
        n2 = np.cross(T, n1)
        for j in range(sides):
            a = 2 * math.pi * j / sides
            V.append(path[i] + radii[i] * (math.cos(a) * n1 + math.sin(a) * n2))
    for i in range(M - 1):
        for j in range(sides):
            j1 = (j + 1) % sides
            F.append((i * sides + j, i * sides + j1, (i + 1) * sides + j1, (i + 1) * sides + j))
    T0 = path[1] - path[0]
    T0 /= np.linalg.norm(T0)
    T1 = path[-1] - path[-2]
    T1 /= np.linalg.norm(T1)
    c0 = len(V)
    V.append(path[0] - T0 * radii[0] * 0.5)
    c1 = len(V)
    V.append(path[-1] + T1 * radii[-1] * 0.8)
    for j in range(sides):
        j1 = (j + 1) % sides
        F.append((c0, j1, j))
        F.append((c1, (M - 1) * sides + j, (M - 1) * sides + j1))
    return np.array(V), F


def align_to(n):
    z = np.array([0.0, 0.0, 1.0])
    c = float(z @ n)
    if c > 0.99999:
        return np.eye(3)
    v = np.cross(z, n)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def rz_mat(deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def eye_frame(body, x, y, tilt, lean=0.7):
    z = body.z_at(x, y)
    n = body.n_at(x, y)
    nb = lean * n + (1 - lean) * np.array([0, 0, 1.0])
    nb /= np.linalg.norm(nb)
    return z, n, align_to(nb) @ rz_mat(tilt)


# ----------------------------------------------------------------------------- materials
def get_principled(mat):
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = nt.nodes.get("Material Output") or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def setin(node, name, val):
    try:
        node.inputs[name].default_value = val
    except Exception as e:
        print("  [warn] cannot set", name, e)


def make_mat(name, hexcol, rough=0.3, coat=1.0, coat_rough=0.06, emit=0.0):
    mat = bpy.data.materials.new(name)
    b = get_principled(mat)
    col = hex2lin(hexcol)
    setin(b, "Base Color", col)
    setin(b, "Roughness", rough)
    setin(b, "Metallic", 0.0)
    setin(b, "Coat Weight", coat)
    setin(b, "Coat Roughness", coat_rough)
    if emit:
        setin(b, "Emission Color", col)
        setin(b, "Emission Strength", emit)
    mat.diffuse_color = col
    return mat


# ----------------------------------------------------------------------------- the data table
# eyes: c = face centre (x,y) in units of D from the body origin, sp = eye spacing, w/h = eye size (units of D),
#       pair = angle of the line through both eyes (CCW deg), tilt = tilt of each oval (CCW deg)
TRI = dict(kind="tri")
BLOBS = [
    dict(id="grok-bot", color="#FD690F", extra="stem", D=0.70,
         shape=("sup", dict(a=1.0, b=0.93, n=2.5)), rot=6, wob=[(3, 0.025, -30), (2, 0.02, 0)],
         eyes=dict(c=(0.20, 0.14), sp=0.25, w=0.13, h=0.27, pair=12, tilt=20)),
    dict(id="jevopus", color="#F93498",
         shape=("sup", dict(a=1.0, b=0.97, n=2.0)), rot=0,
         eyes=dict(c=(0.20, 0.17), sp=0.25, w=0.11, h=0.25, pair=20, tilt=20)),
    dict(id="x-writer", color="#1E86FC",
         shape=("poly", dict(n=4, R=1.0, rr=0.34, rot=45)), rot=22,
         eyes=dict(c=(0.05, 0.02), sp=0.22, w=0.10, h=0.23, pair=12, tilt=25)),
    dict(id="banner-visuals", color="#14C16F",
         shape=("tri", dict(angles=[-4, 108, 236], radii=[1.0, 0.98, 0.98], rr=0.40)), rot=0,
         eyes=dict(c=(0.05, 0.14), sp=0.2, w=0.10, h=0.21, pair=8, tilt=48)),
    dict(id="analytics-analyst", color="#F93498",
         shape=("star", dict(k=4, rin=0.73, p=0.9, tip_deg=65, N=1440)), rot=0,
         eyes=dict(c=(0.06, 0.09), sp=0.21, w=0.10, h=0.21, pair=17, tilt=20)),
    dict(id="competitor-watch", color="#A06B39",
         shape=("tri", dict(angles=[-8, 112, 232], radii=[1.0, 1.0, 1.0], rr=0.40)), rot=0,
         eyes=dict(c=(0.10, 0.17), sp=0.24, w=0.10, h=0.20, pair=18, tilt=45)),
    dict(id="qt-scout", color="#F59312",
         shape=("sup", dict(a=1.0, b=0.76, n=2.7)), rot=8,
         eyes=dict(c=(0.08, 0.05), sp=0.27, w=0.10, h=0.25, pair=18, tilt=24)),
    dict(id="ideas-sparring", color="#FB2B3E",
         shape=("star", dict(k=4, rin=0.58, p=1.3, tip_deg=-3, N=1440)), rot=0, depth=0.30, bevel=0.5,
         eyes=dict(c=(0.07, 0.08), sp=0.20, w=0.09, h=0.22, pair=12, tilt=25)),
    dict(id="bookmarks-brain", color="#13B7A2",
         shape=("poly", dict(n=6, R=1.0, rr=0.30, rot=90)), rot=-6,
         eyes=dict(c=(0.04, -0.03), sp=0.26, w=0.11, h=0.25, pair=10, tilt=4)),
    dict(id="codila-x-researcher", color="#0C0C0E", N=104, depth=0.30, bevel=0.5,
         shape=("star", dict(k=6, rin=0.58, p=1.1, tip_deg=90, N=1440)), rot=0,
         eyes=dict(c=(0.0, -0.07), sp=0.25, w=0.115, h=0.24, pair=0, tilt=0)),
    dict(id="substack", color="#FD690F",
         shape=("poly", dict(n=3, R=1.0, rr=0.38, rot=90, sy=0.94)), rot=0,
         eyes=dict(c=(-0.02, -0.04), sp=0.24, w=0.11, h=0.22, pair=0, tilt=0)),
    dict(id="x-ads-manager", color="#A06B39",
         shape=("poly", dict(n=6, R=1.0, rr=0.30, rot=100)), rot=0,
         eyes=dict(c=(0.10, 0.03), sp=0.27, w=0.11, h=0.27, pair=17, tilt=30)),
    dict(id="warren-buffett", color="#FADFC6", extra="glasses",
         shape=("sup", dict(a=1.0, b=0.97, n=2.0)), rot=0, N=80,
         eyes=dict(c=(0.0, 0.02), sp=0.25, w=0.085, h=0.19, pair=0, tilt=0)),
    dict(id="finance-team", color="#1F8F4E",
         shape=("poly", dict(n=4, R=1.0, rr=0.38, rot=45)), rot=5,
         eyes=dict(c=(0.0, 0.02), sp=0.25, w=0.10, h=0.24, pair=0, tilt=0)),
    dict(id="trendy-x", cluster=True),
    dict(id="_default", color="#FFFFFF", thumb_color="#97A3B8",
         shape=("sup", dict(a=1.0, b=0.95, n=2.0)), rot=0,
         eyes=dict(c=(0.06, 0.06), sp=0.25, w=0.11, h=0.25, pair=12, tilt=15)),
]

# cluster of three mini blobs (Тренды X)
CLUSTER = [
    # key, colour, shape, rot, D, centre(x,y,z), eyes
    dict(key="orange", color="#F59312", shape=("sup", dict(a=1.0, b=0.93, n=2.4)), rot=5, D=0.42,
         at=(-0.20, 0.20, 0.0), eyes=dict(c=(0.12, 0.08), sp=0.25, w=0.12, h=0.25, pair=14, tilt=18)),
    dict(key="teal", color="#13B7A2", shape=("poly", dict(n=6, R=1.0, rr=0.30, rot=90)), rot=-6, D=0.46,
         at=(0.19, 0.23, 0.05), eyes=dict(c=(0.03, -0.02), sp=0.26, w=0.11, h=0.25, pair=10, tilt=4)),
    dict(key="black", color="#0C0C0E", shape=("star", dict(k=6, rin=0.58, p=1.1, tip_deg=90, N=1440)), rot=0, D=0.42,
         at=(0.02, 0.57, -0.09), eyes=dict(c=(0.0, -0.07), sp=0.25, w=0.115, h=0.24, pair=0, tilt=0)),
]
TRIO_SHADES = (-0.10, 0.0, 0.10)

# ----------------------------------------------------------------------------- library (any user's bots)
# shapes = LOOK_SHAPES in web/lib/state.js; each reuses the geometry + face of the closest hand-made blob
LIB_SHAPES = ["sphere", "rounded_cube", "pill", "triangle", "cone", "pentagon",
              "hexagon", "star4", "star6", "clover", "rounded_square", "trio"]
# 12 colours around the wheel (the Grok Bot palette of the owner's bots + violet + lime), then near-black and near-white.
# The web (face.js libPick) snaps a bot's look.color to the nearest of these: keep the two lists in sync.
LIB_COLORS = ["FB2B3E", "FD690F", "F6A317", "A8D52F", "1FAE63", "13B7A2",
              "1E86FC", "7B5CF2", "F93498", "A06B39", "0C0C0E", "F3E7DB"]


def _like(bid, **kw):
    return dict(next(b for b in BLOBS if b["id"] == bid), **kw)


LIB_SPECS = {
    "sphere": _like("jevopus"),
    "rounded_cube": _like("x-writer"),
    "pill": _like("qt-scout"),
    "triangle": _like("substack"),
    "cone": dict(shape=("tri", dict(angles=[90, 218, 322], radii=[1.0, 0.86, 0.86], rr=0.30)), rot=0,
                 eyes=dict(c=(0.0, -0.10), sp=0.23, w=0.10, h=0.23, pair=6, tilt=8)),
    "pentagon": dict(shape=("poly", dict(n=5, R=1.0, rr=0.32, rot=90)), rot=0,
                     eyes=dict(c=(0.0, 0.0), sp=0.25, w=0.105, h=0.24, pair=8, tilt=10)),
    "hexagon": _like("bookmarks-brain"),
    "star4": _like("ideas-sparring"),
    "star6": _like("codila-x-researcher"),
    "clover": _like("analytics-analyst"),
    "rounded_square": _like("finance-team"),
    "trio": dict(cluster=True),
}


# ----------------------------------------------------------------------------- blob assembly
def build_blob(spec):
    """returns dict with objects created in the current scene"""
    bid = spec["id"]
    body_mb, extra_mb = MB(), MB()
    eyes_out = {}  # name -> (verts_rel, faces, centre_local)
    body_mats, extra_mats = [], []

    eye_mat = make_mat("eye_mat", "#FFFFFF", rough=0.22, coat=0.6, coat_rough=0.05, emit=0.10)

    def eyes_for(body, off, face, S, Rg, collect):
        D = body.D
        fc = np.array(face["c"]) * D
        d = np.array([math.cos(math.radians(face["pair"])), math.sin(math.radians(face["pair"]))]) * face["sp"] * D / 2
        out = []
        rx, ry = face["w"] * D / 2, face["h"] * D / 2
        rz = 0.62 * rx
        for side, c in (("eye_L", fc - d), ("eye_R", fc + d)):
            z, n, M = eye_frame(body, c[0], c[1], face["tilt"])
            ctr = np.array([c[0], c[1], z + 0.15 * rz]) + np.asarray(off)
            V, F = ellipsoid(rx, ry, rz, S, Rg)
            out.append((side, V @ M.T, F, ctr, M, body, c))
        return out

    primary = None
    if spec.get("cluster"):
        mats = []
        for i, part in enumerate(CLUSTER):   # lib mode: one colour, each blob a touch lighter/darker so they read apart
            col = shade(spec["color"], TRIO_SHADES[i]) if spec.get("color") else part["color"]
            mats.append(make_mat("body_" + part["key"], col))
        body_mats = mats
        for i, part in enumerate(CLUSTER):
            b = Body(part["shape"], part["rot"], part["D"], N=48, nb=6, flat=(0.5,), depth=0.5, wob=())
            b.emit(body_mb, part["at"], i)
            ev = eyes_for(b, part["at"], part["eyes"], 12, 8, None)
            if part["key"] == "teal":
                primary = ev
            else:
                for (side, V, F, ctr, M, bb, c) in ev:
                    extra_mb.add(V + ctr, F, 0)
        extra_mats = [eye_mat]
        extra_has = True
    else:
        mat = make_mat("body_mat", spec["color"])
        body_mats = [mat]
        D = spec.get("D", SIZE)
        b = Body(spec["shape"], spec["rot"], D, N=spec.get("N", 96), wob=spec.get("wob", ()),
                 depth=spec.get("depth", 0.5), bevel=spec.get("bevel", 0.92))
        b.emit(body_mb, (0, 0, 0), 0)
        primary = eyes_for(b, (0, 0, 0), spec["eyes"], 16, 10, None)
        extra_has = False
        if spec.get("extra") == "stem":
            dark = make_mat("extra_mat", "#3A3D40", rough=0.5, coat=0.3)
            extra_mats = [dark]
            th = math.radians(116)
            rr = b.r_at(th)
            k = D / 0.8
            base = np.array([math.cos(th) * (rr - 0.045 * k), math.sin(th) * (rr - 0.045 * k), 0.0])
            P0 = base
            P1 = base + k * np.array([-0.020, 0.115, 0.0])
            P2 = base + k * np.array([-0.125, 0.205, 0.0])
            ts = np.linspace(0, 1, 11)
            path = [(1 - t) ** 2 * P0 + 2 * (1 - t) * t * P1 + t ** 2 * P2 for t in ts]
            radii = [k * (0.050 - 0.016 * t) for t in ts]
            V, F = tube(path, radii, 8)
            extra_mb.add(V, F, 0)
            extra_has = True
        elif spec.get("extra") == "glasses":
            blk = make_mat("extra_mat", "#101012", rough=0.45, coat=0.4)
            extra_mats = [blk]
            D = b.D
            Rr, rt = 0.118 * D, 0.0135 * D
            cents = []
            for (side, V, F, ctr, M, bb, c) in primary:
                zc, n, M2 = eye_frame(b, c[0], c[1], 0, lean=0.7)
                cc = np.array([c[0], c[1], zc + 0.004])
                TV, TF = torus(Rr, rt, 22, 8)
                extra_mb.add(TV @ M2.T + cc, TF, 0)
                cents.append((c, M2))
            (c1, M1), (c2, M2_) = cents
            # bridge between the lenses (follows the surface)
            dirv = (c2 - c1) / np.linalg.norm(c2 - c1)
            pts = []
            for t in np.linspace(0, 1, 5):
                p = c1 + dirv * Rr + (c2 - c1 - 2 * dirv * Rr) * t
                pts.append([p[0], p[1], b.z_at(p[0], p[1]) + rt * 1.2 + 0.006 * math.sin(math.pi * t)])
            V, F = tube(pts, [rt] * 5, 6)
            extra_mb.add(V, F, 0)
            # temples: hug the head surface out to the silhouette
            for sgn, cc_ in ((-1, c1), (1, c2)):
                pts = []
                for t in np.linspace(0, 1, 9):
                    p = cc_ + sgn * dirv * (Rr + t * (0.40 * D - Rr + 0.02))
                    ang = math.atan2(p[1], p[0]) % (2 * math.pi)
                    rmax = b.r_at(ang)
                    if math.hypot(*p) > rmax * 0.985:
                        sc = rmax * 0.985 / math.hypot(*p)
                        p = p * sc
                    pts.append([p[0], p[1], b.z_at(p[0], p[1]) + rt * 1.2])
                V, F = tube(pts, [rt * 0.9] * 9, 6)
                extra_mb.add(V, F, 0)
            extra_has = True

    # ---- global shift: bbox centre in x/depth, bottom at y=0
    allv = body_mb.verts()
    ymin0 = allv[:, 1].min()
    c0, k0 = FLAT_BOTTOM, 0.010          # soft clamp -> small flat contact patch so the blob "sits"
    t_ = allv[:, 1] - ymin0 - c0
    allv[:, 1] = ymin0 + c0 + 0.5 * (t_ + np.sqrt(t_ * t_ + k0 * k0))
    shift = np.array([-(allv[:, 0].min() + allv[:, 0].max()) / 2, -allv[:, 1].min(),
                      -(allv[:, 2].min() + allv[:, 2].max()) / 2])

    root = bpy.data.objects.new("blob", None)
    root.empty_display_type = "PLAIN_AXES"
    bpy.context.scene.collection.objects.link(root)

    body_ob = make_obj("body", allv + shift, body_mb.f, body_mats, body_mb.m, parent=root)
    objs = {"root": root, "body": body_ob}
    for (side, V, F, ctr, M, bb, c) in primary:
        c3 = ctr + shift
        objs[side] = make_obj(side, V + c3, F, [eye_mat], [0] * len(F), loc=c3, parent=root)
    if extra_has:
        ev = extra_mb.verts() + shift
        objs["extra"] = make_obj("extra", ev, extra_mb.f, extra_mats, extra_mb.m, parent=root)
    allx = allv + shift
    if extra_has:
        allx = np.vstack([allx, extra_mb.verts() + shift])
    bbox = to_bl(allx)
    objs["_bbox"] = (bbox.min(0), bbox.max(0))
    return objs


# ----------------------------------------------------------------------------- studio / thumbnails
def setup_studio():
    sc = bpy.context.scene
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.render.resolution_x = sc.render.resolution_y = 256
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.render.filter_size = 1.2
    try:
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
    except Exception as e:
        print("[warn] view transform", e)
    try:
        sc.eevee.taa_render_samples = 96
    except Exception:
        pass
    for attr, val in (("use_shadows", True), ("use_raytracing", False), ("use_gtao", True)):
        try:
            setattr(sc.eevee, attr, val)
        except Exception:
            pass
    # world: soft, slightly warm-grey studio
    w = bpy.data.worlds.new("studio")
    sc.world = w
    try:
        w.use_nodes = True
    except Exception:
        pass
    bg = w.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.82, 0.82, 0.84, 1)
    bg.inputs["Strength"].default_value = 0.30
    # camera (orthographic, fixed scale so all thumbs share one scale)
    cam = bpy.data.cameras.new("thumb_cam")
    cam.type = "ORTHO"
    cam.ortho_scale = 1.0
    cam.clip_start, cam.clip_end = 0.01, 50
    co = bpy.data.objects.new("thumb_cam", cam)
    bpy.context.scene.collection.objects.link(co)
    co["keep"] = True
    sc.camera = co
    lights = {}
    for name, size in (("key", 1.6), ("fill", 2.2), ("rim", 1.2), ("top", 1.4)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.size = size
        lo = bpy.data.objects.new(name, ld)
        bpy.context.scene.collection.objects.link(lo)
        lo["keep"] = True
        lights[name] = lo
    return co, lights


def aim(obj, target):
    from mathutils import Vector
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def render_thumb(co, lights, bbox, path):
    lo, hi = bbox
    ctr = (lo + hi) / 2
    az, el = math.radians(28), math.radians(20)
    dist = 4.0
    co.location = (ctr[0] + dist * math.sin(az) * math.cos(el), ctr[1] - dist * math.cos(az) * math.cos(el),
                   ctr[2] + dist * math.sin(el))
    aim(co, ctr)
    # lights relative to the blob centre (blob faces -Y)
    spec = {
        "key": ((-1.6, -2.2, 2.4), 168),
        "fill": ((2.4, -1.4, 0.8), 48),
        "rim": ((0.8, 2.2, 1.6), 80),
        "top": ((0.0, -0.4, 3.2), 40),
    }
    for n, (p, e) in spec.items():
        lights[n].location = (ctr[0] + p[0], ctr[1] + p[1], ctr[2] + p[2])
        lights[n].data.energy = e
        aim(lights[n], ctr)
    sc = bpy.context.scene
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def clear_blob():
    for ob in list(bpy.data.objects):
        if ob.get("keep"):
            continue
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", export_yup=True, export_apply=True,
        export_materials="EXPORT", export_normals=True, export_texcoords=False,
        export_cameras=False, export_lights=False, export_animations=False, export_extras=False,
        use_selection=False)


def tri_count(objs):
    t = 0
    for k in ("body", "eye_L", "eye_R", "extra"):
        if k in objs:
            t += sum(len(p.vertices) - 2 for p in objs[k].data.polygons)
    return t


def set_body_color(objs, hexcol):
    """recolour the already built body in place (the trio has three body materials, one per blob)"""
    mats = objs["body"].data.materials
    for i, mat in enumerate(mats):
        c = hex2lin(shade(hexcol, TRIO_SHADES[i]) if len(mats) == 3 else hexcol)
        setin(get_principled(mat), "Base Color", c)
        mat.diffuse_color = c


def lib_main():
    import time
    t0 = time.time()
    os.makedirs(LIB_DIR, exist_ok=True)
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    co, lights = setup_studio()
    sc = bpy.context.scene
    sc.render.resolution_x = sc.render.resolution_y = LIB_PX
    try:
        sc.eevee.taa_render_samples = LIB_SAMPLES
    except Exception:
        pass
    shapes = [s for s in LIB_SHAPES if not ONLY or s in ONLY]
    for shape in shapes:
        clear_blob()
        objs = build_blob(dict(LIB_SPECS[shape], id=shape, color="#" + LIB_COLORS[0]))
        for hexcol in LIB_COLORS:
            set_body_color(objs, hexcol)
            render_thumb(co, lights, objs["_bbox"], os.path.join(LIB_DIR, "%s-%s.png" % (shape, hexcol)))
        print("LIB %-15s %d colours  %.0fs" % (shape, len(LIB_COLORS), time.time() - t0))
    if not ONLY:
        with open(os.path.join(LIB_DIR, "index.json"), "w") as f:
            json.dump({"shapes": LIB_SHAPES, "colors": LIB_COLORS}, f)
    print("LIB DONE %.0fs" % (time.time() - t0))


def lib_from_main():
    """<key>-<RRGGBB>.glb from export_lib.mjs -> lib/<key>-<RRGGBB>.png, same studio and camera as every thumbnail"""
    import glob, time
    t0 = time.time()
    os.makedirs(LIB_DIR, exist_ok=True)
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    co, lights = setup_studio()
    sc = bpy.context.scene
    sc.render.resolution_x = sc.render.resolution_y = LIB_PX
    try:
        sc.eevee.taa_render_samples = LIB_SAMPLES
    except Exception:
        pass
    files = sorted(glob.glob(os.path.join(LIB_FROM, "*.glb")))
    keys, colors = [], []
    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        key, hexcol = name.rsplit("-", 1)
        if key not in keys:
            keys.append(key)
        if hexcol not in colors:
            colors.append(hexcol)
        clear_blob()
        bpy.ops.import_scene.gltf(filepath=f)
        pts = np.array([list(ob.matrix_world @ v.co) for ob in sc.objects if ob.type == "MESH" for v in ob.data.vertices])
        render_thumb(co, lights, (pts.min(0), pts.max(0)), os.path.join(LIB_DIR, name + ".png"))
    with open(os.path.join(LIB_DIR, "index.json"), "w") as fh:
        json.dump({"shapes": keys, "colors": colors}, fh)
    print("LIB-FROM %d thumbnails %.0fs" % (len(files), time.time() - t0))


def main():
    if LIB_FROM:
        return lib_from_main()
    if DO_LIB:
        return lib_main()
    os.makedirs(THUMBS, exist_ok=True)
    clear_blob()
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    co, lights = setup_studio()
    for spec in BLOBS:
        if ONLY and spec["id"] not in ONLY:
            continue
        clear_blob()
        # hide studio from exporter: lights/camera are not exported (export_cameras/lights False)
        objs = build_blob(spec)
        lo, hi = objs["_bbox"]
        print("BLOB %-22s size(x,y_up,z)=(%.3f, %.3f, %.3f) tris=%d" % (
            spec["id"], hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1], tri_count(objs)))
        if DO_GLB:
            export_glb(os.path.join(OUT, spec["id"] + ".glb"))
        if DO_THUMBS:
            if "thumb_color" in spec:  # only the 2D icon is tinted; the GLB stays pure white
                bsdf = get_principled(objs["body"].data.materials[0])
                setin(bsdf, "Base Color", hex2lin(spec["thumb_color"]))
            render_thumb(co, lights, objs["_bbox"], os.path.join(THUMBS, spec["id"] + ".png"))
    print("DONE")


main()
