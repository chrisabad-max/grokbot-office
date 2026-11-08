# Bot HQ office generator. Builds the whole scene from scratch in Blender 5.x, bakes floor/wall lighting,
# exports assets/office/office.glb + preview.png.
#   blender -b --factory-startup -P build_office.py -- [contact|full] [quick]
# Coordinates: all helpers take CONTRACT coordinates (glTF Y-up: x right, y up, +z toward camera) and convert to
# Blender (Z-up) internally.  Kenney Furniture Kit (CC0) GLBs are imported as data only and recoloured.
import bpy, bmesh, math, os, sys, json, struct, random, zlib
import numpy as np
from mathutils import Vector, Matrix

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'full'
QUICK = 'quick' in ARGS

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '..', '..'))
KEN = os.path.join(HERE, 'kenney', 'Models', 'GLTF format')
OUT = os.path.join(ASSETS, 'office')
BAKEDIR = os.path.join(HERE, 'bake')
os.makedirs(OUT, exist_ok=True)
os.makedirs(BAKEDIR, exist_ok=True)


# ------------------------------------------------------------------ helpers
def B(x, y, z):  # contract -> blender
    return Vector((x, -z, y))


def s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    r, g, b = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return (s2l(r), s2l(g), s2l(b), 1.0)


MATS = {}


def mat(name, hexc, rough=0.75, metal=0.0, alpha=None, spec=0.5, emit=None):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = hexcol(hexc)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    try:
        b.inputs['Specular IOR Level'].default_value = spec
    except Exception:
        pass
    if alpha is not None:
        b.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
    if emit:
        b.inputs['Emission Color'].default_value = hexcol(emit)
        b.inputs['Emission Strength'].default_value = 0.6
    m.diffuse_color = hexcol(hexc)
    MATS[name] = m
    return m


# palette (sRGB hex)
P = dict(
    oak='#D8B686', oak_d='#B98E5E', walnut='#8E6644', white='#F4F1EA', wall='#F5EFE5', cream='#EADFCB',
    sage='#A4B79B', sage_d='#7C9674', terra='#D58A6A', terra_d='#B76A4E', mustard='#E2B65C', oat='#E6D9C2',
    char='#3E3D3B', steel='#BDB6AA', leaf1='#6FA05F', leaf2='#8CB874', leaf3='#4F8056', leaf4='#A9C985',
    slab='#E9DFCC', glass='#CFE6F2', dark='#2C2F36', brass='#C9A55C', ink='#7A94B8', soil='#4A3A2E',
    blush='#E8B7A5', sky='#BcD7E6',
)


def PM(key, rough=0.75, **kw):
    return mat('m_' + key, P[key], rough, **kw)


COL = None


def collection():
    global COL
    if COL is None:
        COL = bpy.data.collections.new('Office')
        bpy.context.scene.collection.children.link(COL)
    return COL


class MB:
    """mesh builder: accumulate primitives (contract coords, local to the piece) into one mesh, multi-material"""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def box(self, c, s, m, bevel=0.0, rot=(0, 0, 0)):
        bm = self.bm
        old = set(bm.verts)
        r = bmesh.ops.create_cube(bm, size=1.0)
        verts = r['verts']
        for v in verts:
            v.co = Vector((v.co.x * s[0], v.co.y * s[2], v.co.z * s[1]))
        if bevel > 0:
            edges = list({e for v in verts for e in v.link_edges})
            bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=2, profile=0.6, affect='EDGES')
        verts = [v for v in bm.verts if v not in old]
        self._place(verts, c, rot, m, smooth=False)

    def cyl(self, c, r1, r2, h, m, seg=24, rot=(0, 0, 0), smooth=True, caps=True):
        bm = self.bm
        r = bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=h)
        self._place(r['verts'], c, rot, m, smooth=smooth, capflat=True)

    def ell(self, c, s, m, rot=(0, 0, 0), sub=1, smooth=True):
        bm = self.bm
        r = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
        verts = r['verts']
        for v in verts:
            v.co = Vector((v.co.x * s[0], v.co.y * s[2], v.co.z * s[1]))
        self._place(verts, c, rot, m, smooth=smooth)

    def uvs(self, c, s, m, rot=(0, 0, 0), seg=16, rings=10):
        bm = self.bm
        r = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
        verts = r['verts']
        for v in verts:
            v.co = Vector((v.co.x * s[0], v.co.y * s[2], v.co.z * s[1]))
        self._place(verts, c, rot, m, smooth=True)

    def _place(self, verts, c, rot, m, smooth=True, capflat=False):
        mi = self.mi(m)
        R = Matrix.Rotation(rot[2], 4, 'Z') @ Matrix.Rotation(rot[1], 4, 'Y') @ Matrix.Rotation(rot[0], 4, 'X')
        T = Matrix.Translation(B(*c)) @ R
        faces = set()
        for v in verts:
            if v.is_valid:
                v.co = T @ v.co
                faces.update(v.link_faces)
        for f in faces:
            f.material_index = mi
            if capflat and abs(f.normal.z) > 0.99 and len(f.verts) > 4:
                f.smooth = False
            else:
                f.smooth = smooth

    def build(self, name, loc=(0, 0, 0), yaw=0.0):
        bm = self.bm
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        collection().objects.link(ob)
        ob.location = B(*loc)
        ob.rotation_euler = (0, 0, yaw)
        return ob


def facing_yaw(fx, fz):
    return math.atan2(fx, fz)


def instance(name, me, loc, yaw=0.0, scale=1.0):
    ob = bpy.data.objects.new(name, me)
    collection().objects.link(ob)
    ob.location = B(*loc)
    ob.rotation_euler = (0, 0, yaw)
    if scale != 1.0:
        ob.scale = (scale,) * 3
    return ob


# ------------------------------------------------------------------ Kenney loader (data only)
_KCACHE = {}


def ken(name, mapping, scale=2.0, height=None, rot_z=0.0):
    """import a Kenney GLB, join, scale to metres, origin = bottom centre of bbox, replace materials by mapping"""
    key = (name, tuple(sorted((k, v.name) for k, v in mapping.items())), scale, height, rot_z)
    if key in _KCACHE:
        return _KCACHE[key]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KEN, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    others = [o.name for o in new if o not in meshes]
    ob = meshes[0]
    if len(meshes) > 1:
        with bpy.context.temp_override(active_object=ob, selected_editable_objects=meshes, selected_objects=meshes):
            bpy.ops.object.join()
    me = ob.data
    me.transform(ob.matrix_world)
    ob.matrix_world = Matrix.Identity(4)
    for n in others:
        if n in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[n])
    zs = [v.co.z for v in me.vertices]
    sx = sy = scale
    sz = (height / (max(zs) - min(zs))) if height else scale
    me.transform(Matrix.Diagonal((sx, sy, sz, 1.0)))
    if rot_z:
        me.transform(Matrix.Rotation(rot_z, 4, 'Z'))
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    me.transform(Matrix.Translation((-(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -min(zs))))
    for i, slot in enumerate(list(me.materials)):
        if slot is not None and slot.name.split('.')[0] in mapping:
            me.materials[i] = mapping[slot.name.split('.')[0]]
    for p in me.polygons:
        p.use_smooth = False
    me.name = 'k_' + name
    bpy.data.objects.remove(ob)
    _KCACHE[key] = me
    return me


def seat_top(me):
    """z of the biggest up-facing surface between 20 % and 75 % of the height (seat cushion)"""
    zs = [v.co.z for v in me.vertices]
    H = max(zs)
    acc = {}
    for p in me.polygons:
        if p.normal.z > 0.9 and 0.2 * H < p.center.z < 0.75 * H:
            k = round(p.center.z, 2)
            acc[k] = acc.get(k, 0) + p.area
    return max(acc, key=acc.get) if acc else 0.45


def bbox(me):
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    return (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))


# ------------------------------------------------------------------ render / device setup
def setup_cycles(samples=64):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    ok = False
    for dt in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = dt
            prefs.get_devices()
            devs = [d for d in prefs.devices if d.type != 'CPU']
            if devs:
                for d in prefs.devices:
                    d.use = d.type != 'CPU'
                ok = True
                print('CYCLES device:', dt, [d.name for d in devs])
                break
        except Exception as e:
            print('device fail', dt, e)
    sc.cycles.device = 'GPU' if ok else 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = 'OPTIX' if ok else 'OPENIMAGEDENOISE'
    except Exception:
        pass


def iso_camera(res=(1600, 1000), target=(0, 1.0, 0)):
    sc = bpy.context.scene
    cam = bpy.data.objects.get('Camera')
    if cam is None:
        cd = bpy.data.cameras.new('Camera')
        cam = bpy.data.objects.new('Camera', cd)
        sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.clip_start = 0.1
    cam.data.clip_end = 300
    d = Vector((1, 1, 1)).normalized()
    tgt = B(*target)
    pos = tgt + Vector((d.x, -d.z, d.y)) * 80
    cam.location = pos
    cam.rotation_euler = (tgt - pos).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    return cam


def fit_camera(cam, pts, res, margin=1.04):
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    xs, ys = [], []
    for p in pts:
        q = inv @ B(*p)
        xs.append(q.x)
        ys.append(q.y)
    w = max(xs) - min(xs)
    h = max(ys) - min(ys)
    aspect = res[0] / res[1]
    scale = max(w, h * aspect) * margin
    cam.data.ortho_scale = scale
    cam.data.shift_x = ((max(xs) + min(xs)) / 2) / scale
    cam.data.shift_y = ((max(ys) + min(ys)) / 2) / scale
    return scale


def set_world(color=(0.75, 0.8, 0.9), strength=1.0):
    w = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (*color, 1)
    bg.inputs['Strength'].default_value = strength


def add_sun(name, travel_contract, strength, color, angle_deg=2.0):
    d = Vector(travel_contract).normalized()
    dB = Vector((d.x, -d.z, d.y))
    ld = bpy.data.lights.new(name, 'SUN')
    ld.energy = strength
    ld.color = color
    ld.angle = math.radians(angle_deg)
    lo = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(lo)
    lo.rotation_euler = dB.to_track_quat('-Z', 'Y').to_euler()
    return lo


# ================================================================== LAYOUT (contract coordinates)
COLX = [-6.0 + 2.0 * i for i in range(5)]
ROWZ = [-4.1 + 2.2 * j for j in range(4)]
WALL_H = 3.0
WT = 0.2
BACK_WINS = [(-5.9, 2.0, 0.9, 2.5), (2.6, 2.0, 0.9, 2.5), (6.0, 2.4, 1.85, 2.65)]  # (centre x, width, sill, head)
LEFT_WINS = [(-3.2, 2.0, 0.9, 2.5), (0.8, 2.0, 0.9, 2.5), (4.4, 2.0, 0.9, 2.5)]    # (centre z, width, sill, head)
SUN_EL = 40.0
SUN_TRAVEL = (math.cos(math.radians(SUN_EL)) * 0.7071, -math.sin(math.radians(SUN_EL)), math.cos(math.radians(SUN_EL)) * 0.7071)
EMPTIES = {}


def unB(v):
    return (v.x, v.z, -v.y)


def make_empty(name, loc, face=(0, 0, 1)):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'ARROWS'
    e.empty_display_size = 0.15
    collection().objects.link(e)
    e.location = B(*loc)
    f = Vector(face).normalized()
    fB = Vector((f.x, -f.z, f.y))
    e.rotation_mode = 'QUATERNION'
    e.rotation_quaternion = fB.to_track_quat('-Y', 'Z')
    EMPTIES[name] = loc
    return e


def wall_rects(t0, t1, wins, H=WALL_H):
    pts = sorted({t0, t1} | {w[0] - w[1] / 2 for w in wins} | {w[0] + w[1] / 2 for w in wins})
    rects = []
    for a, b in zip(pts[:-1], pts[1:]):
        mid = (a + b) / 2
        win = next((w for w in wins if w[0] - w[1] / 2 < mid < w[0] + w[1] / 2), None)
        if win:
            rects.append((a, b, 0.0, win[2]))
            rects.append((a, b, win[3], H))
        else:
            rects.append((a, b, 0.0, H))
    return rects


def baked_mesh(name, quads, uvf, normal_contract):
    """quads: list of 4-tuples of contract points (CCW seen from the normal side)."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    nB = Vector((normal_contract[0], -normal_contract[2], normal_contract[1]))
    for q in quads:
        vs = [bm.verts.new(B(*p)) for p in q]
        f = bm.faces.new(vs)
        f.normal_update()
        if f.normal.dot(nB) < 0:
            f.normal_flip()
        for lp in f.loops:
            co = lp.vert.co
            lp[uv].uv = uvf(co.x, co.z, -co.y)
        f.smooth = False
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    collection().objects.link(ob)
    return ob


# ================================================================== SHELL (floor, slab, walls, windows)
def build_shell():
    white = PM('white', 0.55)
    # baked floor (top plane y=0, interior only)
    fl = baked_mesh('baked_floor', [((-8, 0, 6), (8, 0, 6), (8, 0, -6), (-8, 0, -6))],
                    lambda x, y, z: ((x + 8) / 16.0, (z + 6) / 12.0), (0, 1, 0))
    # slab (visible edge); top slightly below the baked floor
    sl = MB()
    sl.box((-0.1, -0.1255, -0.1), (16.2, 0.245, 12.2), PM('slab', 0.8), bevel=0.012)
    sl.build('slab_edge')
    # baked wall faces
    brects = wall_rects(-8.0, 8.0, BACK_WINS)
    quads = [((a, y0, -6.0), (b, y0, -6.0), (b, y1, -6.0), (a, y1, -6.0)) for (a, b, y0, y1) in brects]
    wb = baked_mesh('baked_wall_back', quads, lambda x, y, z: ((x + 8) / 16.0, y / WALL_H), (0, 0, 1))
    lrects = wall_rects(-6.0, 6.0, LEFT_WINS)
    quads = [((-8.0, y0, a), (-8.0, y0, b), (-8.0, y1, b), (-8.0, y1, a)) for (a, b, y0, y1) in lrects]
    wl = baked_mesh('baked_wall_left', quads, lambda x, y, z: ((z + 6) / 12.0, y / WALL_H), (1, 0, 0))
    # wall core (thick body behind the baked faces, PBR)
    core = MB()
    wm = mat('wall_core', P['wall'], 0.9)
    for (a, b, y0, y1) in brects:
        a2 = a - (WT if a <= -8.0 + 1e-6 else 0)
        core.box(((a2 + b) / 2, (y0 + y1) / 2, -6.0 - 0.1 - 0.0025), (b - a2, y1 - y0, WT - 0.005), wm)
    for (a, b, y0, y1) in lrects:
        core.box((-8.0 - 0.1 - 0.0025, (y0 + y1) / 2, (a + b) / 2), (WT - 0.005, y1 - y0, b - a), wm)
    core.build('wall_core')
    # skirting boards
    sk = MB()
    sk.box((0, 0.065, -5.985), (16.0, 0.13, 0.03), white, bevel=0.006)
    sk.box((-7.985, 0.065, 0), (0.03, 0.13, 12.0), white, bevel=0.006)
    sk.build('skirting')
    # windows
    for i, (cx, w, y0, y1) in enumerate(BACK_WINS):
        window('back_%d' % (i + 1), (cx, 0, -6.0), 0.0, w, y0, y1)
    for i, (cz, w, y0, y1) in enumerate(LEFT_WINS):
        window('left_%d' % (i + 1), (-8.0, 0, cz), math.pi / 2, w, y0, y1)
    return fl, wb, wl


GLASS_OBJS = []


def window(tag, loc, yaw, w, y0, y1):
    white = PM('white', 0.5)
    t = 0.07
    h = y1 - y0
    zc, d = -0.05, 0.16
    fr = MB()
    fr.box((0, y0 + t / 2, zc), (w, t, d), white, bevel=0.01)
    fr.box((0, y1 - t / 2, zc), (w, t, d), white, bevel=0.01)
    fr.box((-w / 2 + t / 2, (y0 + y1) / 2, zc), (t, h, d), white, bevel=0.01)
    fr.box((w / 2 - t / 2, (y0 + y1) / 2, zc), (t, h, d), white, bevel=0.01)
    fr.box((0, (y0 + y1) / 2, zc), (0.045, h - 2 * t, 0.1), white)
    if h > 1.2:
        fr.box((0, (y0 + y1) / 2 + 0.1, zc), (w - 2 * t, 0.045, 0.1), white)
    fr.box((0, y0 - 0.02, 0.03), (w + 0.22, 0.05, 0.22), white, bevel=0.012)
    o = fr.build('window_frame_' + tag, (loc[0], 0, loc[2]), yaw)
    o.location = B(*loc)
    g = MB()
    g.box((0, (y0 + y1) / 2, -0.1), (w - 2 * t, h - 2 * t, 0.004), mat('glass', P['glass'], 0.05, alpha=0.16, spec=0.5))
    go = g.build('glass_' + tag, loc, yaw)
    GLASS_OBJS.append(go)


def whiteboard():
    white = PM('white', 0.5)
    board = mat('whiteboard', '#FBFAF6', 0.22)
    mb = MB()
    cx, cy, w, h = -1.5, 1.75, 3.0, 1.15
    mb.box((cx, cy, 0.02), (w + 0.08, h + 0.08, 0.04), PM('steel', 0.4, metal=0.5), bevel=0.01)
    mb.box((cx, cy, 0.045), (w, h, 0.01), board)
    mb.box((cx, cy - h / 2 - 0.045, 0.06), (1.0, 0.03, 0.07), PM('steel', 0.4, metal=0.5), bevel=0.008)
    # scribbles + sticky notes
    inks = [mat('ink_blue', '#4F78C4', 0.4), mat('ink_red', '#CF5A4A', 0.4), mat('ink_green', '#4E9A62', 0.4)]
    rng = random.Random(3)
    for i in range(7):
        x = cx - 1.2 + rng.random() * 1.1
        y = cy + 0.38 - i * 0.12
        mb.box((x + 0.35, y, 0.052), (0.5 + rng.random() * 0.5, 0.012, 0.004), inks[i % 3], rot=(0, 0, 0))
    notes = [mat('note_y', '#F4D35E', 0.7), mat('note_p', '#F2A3A3', 0.7), mat('note_g', '#A9D18E', 0.7), mat('note_b', '#9CC5E8', 0.7)]
    k = 0
    for r in range(2):
        for c in range(4):
            mb.box((cx + 0.35 + c * 0.2, cy + 0.2 - r * 0.2, 0.054), (0.15, 0.15, 0.004), notes[k % 4], rot=(0, 0, (rng.random() - 0.5) * 0.12))
            k += 1
    mb.build('whiteboard', (0, 0, -6.0))
    # wall clock
    ck = MB()
    ck.cyl((0, 0, 0), 0.26, 0.26, 0.04, white, seg=32, rot=(math.pi / 2, 0, 0))
    ck.cyl((0, 0, 0.022), 0.23, 0.23, 0.006, mat('clockface', '#FBF8F2', 0.5), seg=32, rot=(math.pi / 2, 0, 0))
    ck.box((0.0, 0.07, 0.03), (0.016, 0.14, 0.006), PM('char'))
    ck.box((0.05, 0.0, 0.03), (0.1, 0.016, 0.006), PM('char'))
    ck.build('wall_clock', (-4.0, 2.0, -5.97))
    # framed art
    art = [
        ((0.8, 1.85), -6.0, 0, (0.7, 0.9), ['sage', 'terra', 'oat']),
        ((4.2, 1.6), -6.0, 0, (0.6, 0.8), ['terra', 'mustard', 'sage_d']),
    ]
    for i, (pos, wz, yaw, (aw, ah), cols) in enumerate(art):
        frame_art('art_back_%d' % i, (pos[0], pos[1], -6.0), 0.0, aw, ah, cols)
    frame_art('art_left_1', (-8.0, 1.7, -1.2), math.pi / 2, 0.8, 1.0, ['sage_d', 'oat', 'terra'])
    frame_art('art_left_2', (-8.0, 1.65, 2.6), math.pi / 2, 0.9, 0.7, ['terra_d', 'cream', 'sage'])


def frame_art(name, loc, yaw, aw, ah, cols):
    mb = MB()
    mb.box((0, 0, 0.02), (aw + 0.08, ah + 0.08, 0.04), PM('walnut', 0.6), bevel=0.008)
    mb.box((0, 0, 0.042), (aw, ah, 0.006), mat('paper', '#F8F4EC', 0.8))
    mb.cyl((-aw * 0.15, ah * 0.1, 0.05), aw * 0.22, aw * 0.22, 0.006, PM(cols[0], 0.8), seg=24, rot=(math.pi / 2, 0, 0))
    mb.box((aw * 0.18, -ah * 0.12, 0.05), (aw * 0.42, ah * 0.4, 0.006), PM(cols[1], 0.8), rot=(0, 0, 0.1))
    mb.cyl((0, -ah * 0.30, 0.056), aw * 0.12, aw * 0.12, 0.006, PM(cols[2], 0.8), seg=20, rot=(math.pi / 2, 0, 0))
    mb.build(name, loc, yaw)


# ================================================================== PLANTS
def plant(name, x, z, kind='bush', s=1.0, pot='white', seed=1, y=0.0, potscale=1.0):
    rng = random.Random(seed)
    mb = MB()
    potm = {'white': PM('white', 0.45), 'terra': PM('terra', 0.8), 'char': PM('char', 0.6), 'sage': PM('sage_d', 0.7),
            'oat': PM('oat', 0.8)}[pot]
    soil = PM('soil', 0.95)
    greens = [PM('leaf1', 0.6), PM('leaf2', 0.6), PM('leaf3', 0.6), PM('leaf4', 0.6)]
    ps = potscale
    if kind in ('bush', 'fiddle', 'snake', 'round'):
        ph, pr1, pr2 = 0.34 * s * ps, 0.15 * s * ps, 0.21 * s * ps
    else:
        ph, pr1, pr2 = 0.34 * s * ps, 0.15 * s * ps, 0.2 * s * ps
    mb.cyl((0, y + ph / 2, 0), pr1, pr2, ph, potm, seg=20)
    mb.cyl((0, y + ph - 0.012 * s, 0), pr2 * 0.9, pr2 * 0.9, 0.024 * s, soil, seg=20)
    top = y + ph

    def leaf(base, az, tilt, L, W, T, m):
        # long axis along local up; rotate: tilt about X then azimuth about Z (blender space)
        R = Matrix.Rotation(az, 3, 'Z') @ Matrix.Rotation(tilt, 3, 'X')
        dirB = R @ Vector((0, 0, 1))
        bB = B(*base)
        cB = bB + dirB * (L / 2)
        mb.ell(unB(cB), (W, L / 2, T), m, rot=(tilt, 0, az), sub=1)

    if kind == 'bush':
        n = int(16 + 8 * s)
        for i in range(n):
            az = rng.random() * math.tau
            tilt = math.radians(rng.uniform(15, 62))
            L = rng.uniform(0.5, 0.85) * s
            leaf((rng.uniform(-0.05, 0.05) * s, top, rng.uniform(-0.05, 0.05) * s), az, tilt, L, 0.12 * s, 0.025 * s, greens[rng.randrange(4)])
    elif kind == 'snake':
        for i in range(11):
            az = i * 2.4 + rng.random() * 0.4
            tilt = math.radians(rng.uniform(2, 16))
            L = rng.uniform(0.7, 1.15) * s
            leaf((math.cos(az) * 0.05 * s, top, math.sin(az) * 0.05 * s), az, tilt, L, 0.055 * s, 0.018 * s, greens[2 if i % 2 else 0])
    elif kind == 'fiddle':
        th = 0.95 * s
        mb.cyl((0, top + th / 2, 0), 0.016 * s, 0.026 * s, th, PM('walnut', 0.8), seg=8)
        for i in range(15):
            az = rng.random() * math.tau
            hh = top + th * (0.45 + 0.55 * rng.random())
            tilt = math.radians(rng.uniform(35, 85))
            off = 0.0
            leaf((0, hh, 0), az, tilt, rng.uniform(0.3, 0.45) * s, 0.15 * s, 0.02 * s, greens[rng.randrange(4)])
        mb.ell((0, top + th + 0.05 * s, 0), (0.12 * s, 0.14 * s, 0.12 * s), greens[1], sub=1)
    elif kind == 'round':
        th = 0.6 * s
        mb.cyl((0, top + th / 2, 0), 0.018 * s, 0.025 * s, th, PM('walnut', 0.8), seg=8)
        mb.uvs((0, top + th + 0.22 * s, 0), (0.3 * s, 0.26 * s, 0.3 * s), greens[0], seg=14, rings=9)
        for i in range(8):
            a = rng.random() * math.tau
            mb.ell((math.cos(a) * 0.2 * s, top + th + 0.15 * s + rng.random() * 0.2 * s, math.sin(a) * 0.2 * s),
                   (0.12 * s, 0.1 * s, 0.12 * s), greens[rng.randrange(1, 4)], sub=1)
    else:  # succulent / tiny
        for i in range(9):
            az = i * 0.7 + rng.random() * 0.3
            tilt = math.radians(rng.uniform(25, 60))
            leaf((0, top, 0), az, tilt, rng.uniform(0.3, 0.45) * s, 0.07 * s, 0.03 * s, greens[(i % 2) * 2 + 1 if i % 3 else 0])
    return mb.build(name, (x, 0, z))


# ================================================================== FURNITURE
def make_desk_mesh():
    """open white desk: slim white top, oak legs, drawer pedestal on the +X side (open knee space for the blob)"""
    top = mat('desk_top', '#F6F3EC', 0.38)
    oak = PM('oak', 0.55)
    steel = PM('steel', 0.4, metal=0.6)
    d = MB()
    d.box((0, 0.7325, 0), (1.5, 0.035, 0.78), top, bevel=0.012)
    for sx in (-1, 1):
        for sz in (-1, 1):
            d.box((sx * 0.69, 0.3575, sz * 0.32), (0.05, 0.715, 0.05), oak, bevel=0.006)
    for sz in (-1, 1):
        d.box((0, 0.685, sz * 0.32), (1.36, 0.06, 0.02), oak)
    for sx in (-1, 1):
        d.box((sx * 0.69, 0.685, 0), (0.02, 0.06, 0.62), oak)
    d.box((0.45, 0.4575, 0.0), (0.44, 0.515, 0.64), top, bevel=0.01)
    for yy in (0.58, 0.34):
        d.box((0.45, yy, -0.325), (0.38, 0.2, 0.012), mat('drawer', '#EDE6D8', 0.5), bevel=0.003)
        d.box((0.45, yy + 0.05, -0.336), (0.12, 0.012, 0.012), steel)
    ob = d.build('desk_tpl')
    me = ob.data
    me.name = 'desk_open'
    bpy.data.objects.remove(ob)
    return me


def build_furniture():
    white, oak, oakd = PM('white', 0.45), PM('oak', 0.6), PM('oak_d', 0.6)
    sage, terra, oat = PM('sage', 0.92), PM('terra', 0.92), PM('oat', 0.92)
    char, steel = PM('char', 0.5), PM('steel', 0.4, metal=0.6)
    screen = mat('screen', '#20242C', 0.25, emit='#2B3C55')
    alu = mat('aluminium', '#D8D3CA', 0.35, metal=0.7)
    keys = mat('keys', '#8C8A86', 0.5)
    gray = mat('chair_base', '#6F6C66', 0.55)

    desk_me = make_desk_mesh()
    chair_sets = {
        'sage': {'carpet': sage, 'metalMedium': gray},
        'oat': {'carpet': oat, 'metalMedium': gray},
        'terra': {'carpet': terra, 'metalMedium': gray},
    }
    chair_me = {k: ken('chairDesk', v, scale=2.0, height=1.163) for k, v in chair_sets.items()}
    seat_y = seat_top(chair_me['sage'])
    lap_me = ken('laptop', {'metal': screen, 'metalDark': alu, 'metalMedium': keys}, scale=1.6, rot_z=math.pi)
    print('chair seat y = %.3f' % seat_y)
    chair_pat = ['sage', 'oat', 'sage', 'oat', 'sage', 'oat', 'sage', 'terra', 'sage', 'oat', 'sage', 'oat', 'terra', 'oat', 'sage', 'oat', 'sage', 'oat', 'sage', 'oat']
    mugcols = [PM('terra', 0.5), PM('white', 0.4), PM('sage_d', 0.5), PM('mustard', 0.5)]
    mats_mat = [PM('oat', 0.95), PM('sage', 0.95), PM('terra', 0.95), PM('cream', 0.95)]
    idx = 0
    for j, cz in enumerate(ROWZ):
        for i, cx in enumerate(COLX):
            idx += 1
            n = '%02d' % idx
            rng = random.Random(idx * 7)
            instance('chair_' + n, chair_me[chair_pat[idx - 1]], (cx, 0, cz), rng.uniform(-0.12, 0.12))
            instance('desk_furn_' + n, desk_me, (cx, 0, cz + 0.81), 0.0)
            # desk mat + laptop (screen faces the chair, -Z)
            mb = MB()
            mb.box((cx, 0.754, cz + 0.8), (0.66, 0.008, 0.4), mats_mat[(i + j) % 4], bevel=0.003)
            mb.build('deskmat_' + n)
            instance('laptop_' + n, lap_me, (cx, 0.75, cz + 0.8), 0.0)
            # screen centre / normal (screen faces -Z and tilts up)
            sp = (cx, 0.75 + 0.14, cz + 0.8 + 0.12)
            make_empty('screen_' + n, sp, (0, 0.41, -0.91))
            make_empty('desk_' + n, (cx, seat_y, cz), (0, 0, 1))
            # props
            acc = MB()
            mc = mugcols[rng.randrange(4)]
            mx, mz = cx + 0.52, cz + 0.66
            acc.cyl((mx, 0.75 + 0.045, mz), 0.04, 0.036, 0.09, mc, seg=16)
            acc.box((mx + 0.05, 0.75 + 0.05, mz), (0.02, 0.05, 0.012), mc, rot=(0, 0, 0))
            if rng.random() < 0.55:
                acc.box((cx - 0.5, 0.75 + 0.008, cz + 0.68), (0.2, 0.014, 0.28), mats_mat[rng.randrange(4)], bevel=0.003, rot=(0, 0, rng.uniform(-0.3, 0.3)))
                acc.box((cx - 0.5, 0.75 + 0.02, cz + 0.68), (0.19, 0.01, 0.26), white, bevel=0.002, rot=(0, 0, rng.uniform(-0.3, 0.3)))
            acc.build('desk_props_' + n)
            if idx in (2, 4, 6, 9, 11, 14, 16, 19):
                p = plant('deskplant_' + n, cx - 0.55, cz + 1.0, 'succ' if idx % 2 else 'bush', 0.32 if idx % 2 else 0.3, ['white', 'terra', 'sage'][idx % 3], seed=idx, y=0.75)
    # ---------------- lounge
    sofa_me = ken('loungeSofa', {'carpet': sage, 'wood': oakd}, scale=2.0)
    arm_me = ken('loungeChair', {'carpet': terra, 'wood': oakd}, scale=2.0)
    sofa_seat = seat_top(sofa_me)
    arm_seat = seat_top(arm_me)
    print('sofa seat %.3f armchair seat %.3f' % (sofa_seat, arm_seat))
    rug = MB()
    rug.cyl((5.9, 0.007, -0.55), 1.95, 1.95, 0.014, mat('rug_outer', '#EAE0CE', 0.98), seg=48)
    rug.cyl((5.9, 0.010, -0.55), 1.62, 1.62, 0.020, mat('rug_ring', '#A4B79B', 0.98), seg=48)
    rug.cyl((5.9, 0.013, -0.55), 1.45, 1.45, 0.026, mat('rug_inner', '#EFE6D6', 0.98), seg=48)
    rug.build('rug')
    sofa_pos = (5.9, 0, -1.95)
    instance('sofa', sofa_me, sofa_pos, 0.0)
    make_empty('lounge_01', (5.42, sofa_seat, -1.95), (0.0, 0, 1))
    make_empty('lounge_02', (6.38, sofa_seat, -1.95), (0.0, 0, 1))
    pil = MB()
    pil.box((5.0 + 0.0, 0.62, -2.18), (0.4, 0.38, 0.12), terra, bevel=0.04, rot=(-0.2, 0, 0.2))
    pil.box((6.82, 0.62, -2.18), (0.4, 0.38, 0.12), PM('mustard', 0.92), bevel=0.04, rot=(-0.2, 0, -0.25))
    pil.box((6.55, 0.6, -2.2), (0.36, 0.34, 0.11), oat, bevel=0.04, rot=(-0.2, 0, 0.1))
    pil.build('pillows')
    a1 = (4.55, 0, 0.35)
    a2 = (7.15, 0, 0.55)
    f1 = Vector((0.95, 0, 0.30)).normalized()
    f2 = Vector((-0.55, 0, 0.84)).normalized()
    instance('armchair_1', arm_me, a1, facing_yaw(f1.x, f1.z))
    instance('armchair_2', arm_me, a2, facing_yaw(f2.x, f2.z))
    make_empty('lounge_03', (a1[0], arm_seat, a1[2]), (f1.x, 0, f1.z))
    make_empty('lounge_04', (a2[0], arm_seat, a2[2]), (f2.x, 0, f2.z))
    # coffee table + decor
    tab_me = ken('tableCoffee', {'wood': oak}, scale=2.0)
    instance('coffee_table', tab_me, (5.9, 0, -0.55), 0.0)
    books_me = ken('books', {'carpetDarker': terra, 'carpetWhite': oat, 'metal': sage, 'plant': PM('mustard', 0.7)}, scale=2.0)
    instance('table_books', books_me, (5.65, 0.46, -0.5), 0.3)
    tp = MB()
    tp.cyl((6.2, 0.46 + 0.04, -0.62), 0.06, 0.05, 0.08, PM('white', 0.4), seg=16)
    tp.cyl((6.2, 0.46 + 0.01, -0.62), 0.09, 0.09, 0.02, PM('white', 0.4), seg=16)
    tp.build('table_cup')
    plant('table_plant', 5.95, -0.42, 'succ', 0.34, 'white', seed=77, y=0.46)
    # side table + lamp next to the sofa, pouf in front of the table
    st = MB()
    st.cyl((0, 0.49, 0), 0.26, 0.26, 0.03, oak, seg=28)
    st.cyl((0, 0.25, 0), 0.025, 0.025, 0.48, PM('brass', 0.4, metal=0.8), seg=10)
    st.cyl((0, 0.01, 0), 0.17, 0.17, 0.02, PM('brass', 0.4, metal=0.8), seg=24)
    st.build('side_table', (4.5, 0, -1.95))
    tl2 = ken('lampRoundTable', {'lamp': PM('cream', 0.6), 'metal': PM('brass', 0.4, metal=0.8)}, scale=1.6)
    instance('side_lamp', tl2, (4.5, 0.505, -1.95), 0.0)
    pf = MB()
    pf.cyl((0, 0.2, 0), 0.3, 0.3, 0.4, PM('mustard', 0.95), seg=28)
    pf.cyl((0, 0.4, 0), 0.27, 0.27, 0.02, PM('mustard', 0.95), seg=28)
    pf.build('pouf', (5.9, 0, 0.85))
    # beanbags
    bean = MB()
    bm1 = mat('bean_oat', '#E4D4B8', 0.97)
    bm2 = mat('bean_terra', '#D58A6A', 0.97)
    for (bx, bz, bmm, yaw) in ((5.05, -4.15, bm1, 0.15), (6.75, -4.25, bm2, -0.2)):
        b = MB()
        b.uvs((0, 0.24, 0.02), (0.5, 0.25, 0.46), bmm, seg=20, rings=12)
        b.uvs((0, 0.45, -0.3), (0.46, 0.34, 0.24), bmm, rot=(-0.35, 0, 0), seg=20, rings=12)
        b.build('beanbag_%d' % (1 if bmm is bm1 else 2), (bx, 0, bz), yaw)
    make_empty('lounge_05', (5.05 + 0.0, 0.36, -4.15 + 0.06), (0.15, 0, 1))
    make_empty('lounge_06', (6.75, 0.36, -4.25 + 0.06), (-0.2, 0, 1))
    # back wall furniture (lounge side)
    bc_me = ken('bookcaseClosedWide', {'wood': white}, scale=2.0)
    instance('bookcase', bc_me, (4.92, 0, -5.74), 0.0)
    cred_me = ken('cabinetTelevision', {'wood': oak}, scale=2.0)
    instance('credenza', cred_me, (6.62, 0, -5.74), 0.0)
    cof_me = ken('kitchenCoffeeMachine', {'carpetWhite': white, 'metal': steel, 'metalMedium': char}, scale=1.8)
    instance('coffee_machine', cof_me, (6.2, 0.62, -5.72), 0.0)
    cm = MB()
    for k, (mx, mc) in enumerate(((6.62, mugcols[0]), (6.78, mugcols[2]), (6.94, mugcols[3]))):
        cm.cyl((mx, 0.62 + 0.045, -5.62), 0.04, 0.036, 0.09, mc, seg=14)
    cm.box((7.05, 0.62 + 0.04, -5.78), (0.34, 0.08, 0.24), oat, bevel=0.01)
    cm.build('coffee_bar_props')
    top_books = ken('books', {'carpetDarker': terra, 'carpetWhite': oat, 'metal': sage, 'plant': PM('mustard', 0.7)}, scale=2.0)
    instance('books_top_1', top_books, (4.55, 1.58, -5.7), 0.1)
    instance('books_top_2', top_books, (5.35, 1.58, -5.7), -0.2)
    plant('plant_bookcase', 5.0, -5.74, 'bush', 0.45, 'terra', seed=11, y=1.58)
    lamp_me = ken('lampRoundFloor', {'lamp': PM('cream', 0.6), 'metal': PM('brass', 0.4, metal=0.8)}, scale=1.7)
    instance('floor_lamp_1', lamp_me, (7.55, 0, -4.9), 0.0)
    instance('floor_lamp_2', lamp_me, (7.45, 0, 1.5), 0.0)
    # left wall furniture
    side_me = ken('cabinetTelevision', {'wood': oak}, scale=2.0)
    for k, zc in enumerate((-3.2, 4.4)):
        instance('sideboard_%d' % (k + 1), side_me, (-7.72, 0, zc), math.pi / 2)
    tl_me = ken('lampRoundTable', {'lamp': PM('cream', 0.6), 'metal': PM('brass', 0.4, metal=0.8)}, scale=1.8)
    instance('table_lamp', tl_me, (-7.72, 0.62, -3.6), 0.0)
    instance('books_side', top_books, (-7.72, 0.62, -2.8), 1.2)
    # divider planters + big plants
    big = [
        ('plant_div_1', 3.55, -5.2, 'fiddle', 1.15, 'white', 21), ('plant_div_2', 3.55, -1.2, 'bush', 1.0, 'terra', 22),
        ('plant_div_3', 3.55, 2.4, 'snake', 1.0, 'char', 23), ('plant_div_4', 3.55, 5.2, 'fiddle', 1.1, 'sage', 24),
        ('plant_corner_1', -7.55, -5.45, 'fiddle', 1.3, 'terra', 25), ('plant_left_1', -7.6, 0.8, 'bush', 1.15, 'white', 26),
        ('plant_left_2', -7.6, 5.4, 'snake', 1.1, 'terra', 27), ('plant_lounge_1', 7.6, -5.45, 'fiddle', 1.4, 'white', 28),
        ('plant_lounge_2', 7.55, 3.6, 'round', 1.1, 'sage', 29), ('plant_lounge_3', 4.35, 3.2, 'bush', 1.0, 'terra', 30),
        ('plant_lounge_4', 5.9, 5.2, 'snake', 1.0, 'white', 31),
        ('plant_wb', -3.6, -5.6, 'snake', 0.95, 'char', 32), ('plant_wb2', 0.6, -5.55, 'fiddle', 1.0, 'terra', 33),
        ('plant_win_a', -7.2, -5.3, 'bush', 0.8, 'white', 34),
    ]
    for (n, x, z, kind, s, pot, seed) in big:
        plant(n, x, z, kind, s, pot, seed)
    plant('plant_side_1', -7.72, -4.15, 'bush', 0.55, 'white', 41, y=0.62)
    plant('plant_side_2', -7.72, 3.9, 'succ', 0.55, 'terra', 42, y=0.62)
    plant('plant_cred', 7.25, -5.7, 'succ', 0.5, 'white', 43, y=0.62)
    # front planter bench with low plants
    for k, px in enumerate((-5.0, -1.8, 1.4)):
        pb = MB()
        pb.box((0, 0.2, 0), (1.9, 0.4, 0.55), PM('oak', 0.6), bevel=0.02)
        pb.box((0, 0.405, 0), (1.76, 0.02, 0.42), PM('soil', 0.95))
        pb.build('planter_%d' % (k + 1), (px, 0, 5.45))
        for q in range(3):
            plant('planter_plant_%d_%d' % (k, q), px - 0.6 + q * 0.6, 5.45, ['bush', 'succ', 'bush'][(q + k) % 3], 0.5 + 0.1 * ((q + k) % 2), 'oat', seed=100 + 10 * k + q, y=0.38, potscale=0.01)


# ================================================================== CHECK helpers
def tri_count_objects(objs):
    t = 0
    for o in objs:
        if o.type == 'MESH':
            t += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return t


# ================================================================== BAKE (floor + 2 walls, lighting only; albedo is procedural)
def px_get(img):
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def lin_of(hexc):
    return np.array(hexcol(hexc)[:3], np.float32)


def srgb_enc(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 1e-8), 1 / 2.4) - 0.055)


def box_blur_x(a, k):
    k = int(k) | 1
    pad = k // 2
    p = np.pad(a, ((0, 0), (pad + 1, pad)), mode='edge')
    cs = np.cumsum(p, axis=1, dtype=np.float64)
    return ((cs[:, k:] - cs[:, :-k]) / k).astype(np.float32)


def blur2(a, r):
    """cheap separable box blur (3 passes ~ gaussian) on (h,w,c)"""
    out = a
    for _ in range(3):
        out = np.stack([box_blur_x(out[..., c], r) for c in range(out.shape[2])], axis=2)
        out = np.stack([box_blur_x(np.ascontiguousarray(out[..., c].T), r).T for c in range(out.shape[2])], axis=2)
    return out


def resize_bilinear(a, H, W):
    h, w, c = a.shape
    ys = (np.arange(H) + 0.5) * h / H - 0.5
    xs = (np.arange(W) + 0.5) * w / W - 0.5
    y0 = np.floor(ys).astype(int)
    x0 = np.floor(xs).astype(int)
    fy = (ys - y0).astype(np.float32)[:, None, None]
    fx = (xs - x0).astype(np.float32)[None, :, None]
    y0c, y1c = np.clip(y0, 0, h - 1), np.clip(y0 + 1, 0, h - 1)
    x0c, x1c = np.clip(x0, 0, w - 1), np.clip(x0 + 1, 0, w - 1)
    rows0 = a[y0c]
    rows1 = a[y1c]
    top = rows0[:, x0c] * (1 - fx) + rows0[:, x1c] * fx
    bot = rows1[:, x0c] * (1 - fx) + rows1[:, x1c] * fx
    return (top * (1 - fy) + bot * fy).astype(np.float32)


def wood_albedo(W, H):
    """light-oak planks along X over the 16 x 12 m floor; image row 0 = z -6"""
    rng = np.random.default_rng(11)
    x = (np.arange(W, dtype=np.float32) + 0.5) * (16.0 / W)
    z = (np.arange(H, dtype=np.float32) + 0.5) * (12.0 / H)
    PW, PL = 0.17, 2.3
    row = np.floor(z / PW).astype(int)
    nrows = int(row.max()) + 1
    off = rng.random(nrows).astype(np.float32) * PL
    tone = rng.normal(0, 1, size=(nrows, 14)).astype(np.float32)
    hue = rng.normal(0, 1, size=(nrows, 14)).astype(np.float32)
    shift = off[row][:, None]
    xs = x[None, :] + shift
    col = np.floor(xs / PL).astype(int)
    t = tone[row[:, None], col]
    hu = hue[row[:, None], col]
    # grain (streaks along x)
    g1 = rng.standard_normal((H, W)).astype(np.float32)
    g_fine = box_blur_x(g1, max(9, W // 170))
    g_fine /= g_fine.std() + 1e-6
    g_coarse = box_blur_x(rng.standard_normal((H, W)).astype(np.float32), max(31, W // 26))
    g_coarse /= g_coarse.std() + 1e-6
    var = 1.0 + 0.060 * t + 0.040 * g_coarse + 0.022 * g_fine
    base = lin_of('#E6CFAA')
    img = np.empty((H, W, 3), np.float32)
    img[..., 0] = base[0] * var * (1 + 0.025 * hu)
    img[..., 1] = base[1] * var
    img[..., 2] = base[2] * var * (1 - 0.040 * hu)
    # gaps
    gz = (z % PW) * (W / 16.0)           # in px of plank edge distance (z)
    gap_z = (np.minimum(z % PW, PW - (z % PW)) < 0.0028)[:, None]
    gap_x = (np.minimum(xs % PL, PL - (xs % PL)) < 0.0028)
    gapm = np.where(gap_z | gap_x, 0.70, 1.0).astype(np.float32)
    img *= gapm[..., None]
    return img


def plaster_albedo(W, H, seed):
    rng = np.random.default_rng(seed)
    n = rng.standard_normal((H, W)).astype(np.float32)
    n = box_blur_x(n, 9)
    n = box_blur_x(n.T, 9).T
    n /= n.std() + 1e-6
    base = lin_of('#F5EFE5')
    img = base[None, None, :] * (1 + 0.010 * n)[..., None]
    return img.astype(np.float32)


def shoulder(c, k=0.78):
    return np.where(c < k, c, k + (1 - k) * (1 - np.exp(-(c - k) / (1 - k))))


def save_jpeg(arr_srgb, name, quality=88):
    h, w, _ = arr_srgb.shape
    img = bpy.data.images.new(name + '_tmp', w, h, alpha=False)
    img.colorspace_settings.name = 'sRGB'
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = np.clip(arr_srgb, 0, 1)
    img.pixels.foreach_set(rgba.ravel())
    path = os.path.join(BAKEDIR, name + '.jpg')
    img.filepath_raw = path
    img.file_format = 'JPEG'
    sc = bpy.context.scene
    sc.render.image_settings.quality = quality
    try:
        img.save(quality=quality)
    except TypeError:
        img.save()
    bpy.data.images.remove(img)
    return path


def bake_lighting(ob, size, samples):
    sc = bpy.context.scene
    w, h = size
    img = bpy.data.images.new(ob.name + '_light', w, h, alpha=False, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    m = ob.data.materials[0]
    nt = m.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    for n in nt.nodes:
        n.select = False
    tex.select = True
    nt.nodes.active = tex
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.render.bake.margin = 6
    try:
        sc.render.bake.margin_type = 'EXTEND'
    except Exception:
        pass
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, use_clear=True)
    arr = px_get(img)[..., :3].copy()
    nt.nodes.remove(tex)
    bpy.data.images.remove(img)
    return arr


def make_bake_material(ob, hexc):
    m = bpy.data.materials.new('bakesrc_' + ob.name)
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = hexcol(hexc)
    m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.8
    ob.data.materials.clear()
    ob.data.materials.append(m)
    return m


def final_material(name, jpg_path):
    img = bpy.data.images.load(jpg_path)
    img.name = name + '_tex'
    img.colorspace_settings.name = 'sRGB'
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = 1.0
    try:
        b.inputs['Specular IOR Level'].default_value = 0.0
    except Exception:
        pass
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.extension = 'EXTEND'
    tex.interpolation = 'Linear'
    nt.links.new(tex.outputs['Color'], b.inputs['Base Color'])
    m.use_backface_culling = True
    return m, img


def run_bake(baked, quick):
    """baked: list of (ob, albedo_hex, light_size, final_size, albedo_fn). returns {name: (jpg path, image)}"""
    sc = bpy.context.scene
    samples = 40 if quick else 320
    lights = {}
    for (ob, hexc, lsize, fsize, afn, gain) in baked:
        make_bake_material(ob, hexc)
    for g in GLASS_OBJS:
        g.hide_render = True
    for (ob, hexc, lsize, fsize, afn, gain) in baked:
        if quick:
            lsize = (lsize[0] // 2, lsize[1] // 2)
        print('baking', ob.name, lsize, samples)
        lights[ob.name] = bake_lighting(ob, lsize, samples)
    for g in GLASS_OBJS:
        g.hide_render = False
    # exposure from floor
    fl = lights['baked_floor']
    L = fl[..., 0] * 0.2126 + fl[..., 1] * 0.7152 + fl[..., 2] * 0.0722
    expo = 1.08 / np.percentile(L, 92)
    print('floor light p50/p92/max', np.percentile(L, 50), np.percentile(L, 92), L.max(), 'expo', expo)
    out = {}
    for (ob, hexc, lsize, fsize, afn, gain) in baked:
        if quick:
            fsize = (fsize[0] // 4, fsize[1] // 4)
        light = blur2(lights[ob.name], 2) if not quick else lights[ob.name]
        light = resize_bilinear(light, fsize[1], fsize[0])
        alb = afn(fsize[0], fsize[1])
        col = shoulder(light * alb * expo * gain * np.array([1.02, 1.0, 0.95], np.float32) if gain > 1 else light * alb * expo)
        # tiny warm grade + saturation
        lum = (col * np.array([0.2126, 0.7152, 0.0722], np.float32)).sum(-1, keepdims=True)
        col = lum + (col - lum) * 1.03
        col = srgb_enc(col)
        path = save_jpeg(col, ob.name, 88)
        print(ob.name, 'jpg', os.path.getsize(path) // 1024, 'KB', fsize)
        mfin, img = final_material(ob.name, path)
        ob.data.materials.clear()
        ob.data.materials.append(mfin)
        out[ob.name] = (path, img)
    return out


# ================================================================== EXPORT + CHECK
def strip_uvs():
    seen = set()
    for o in collection().objects:
        if o.type == 'MESH' and not o.name.startswith('baked_') and o.data.name not in seen:
            seen.add(o.data.name)
            for uv in list(o.data.uv_layers):
                o.data.uv_layers.remove(uv)
            for a in list(o.data.color_attributes):
                o.data.color_attributes.remove(a)


def export_glb(path):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in collection().objects:
        o.hide_set(False)
        o.select_set(True)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_image_format='AUTO', export_jpeg_quality=88,
              export_apply=True, export_yup=True, export_cameras=False, export_lights=False, export_extras=False,
              export_texcoords=True, export_normals=True, export_materials='EXPORT', export_animations=False)
    for _ in range(8):
        try:
            bpy.ops.export_scene.gltf(**kw)
            return
        except TypeError as e:
            msg = str(e)
            bad = [k for k in kw if k in msg]
            if not bad:
                raise
            print('dropping export option', bad)
            for k in bad:
                kw.pop(k)
    raise RuntimeError('export failed')


def patch_glb(path):
    data = open(path, 'rb').read()
    magic, ver, length = struct.unpack('<4sII', data[:12])
    jl, jt = struct.unpack('<II', data[12:20])
    js = json.loads(data[20:20 + jl].decode('utf8'))
    rest = data[20 + jl:]
    used = set(js.get('extensionsUsed', []))
    n_unlit = 0
    for m in js.get('materials', []):
        nm = m.get('name', '')
        if nm.startswith('baked_'):
            m['extensions'] = {'KHR_materials_unlit': {}}
            pbr = m.setdefault('pbrMetallicRoughness', {})
            pbr['metallicFactor'] = 0.0
            pbr['roughnessFactor'] = 1.0
            m.pop('emissiveFactor', None)
            used.add('KHR_materials_unlit')
            n_unlit += 1
        elif nm.startswith('glass'):
            m['alphaMode'] = 'BLEND'
            m['doubleSided'] = True
    still = set()
    for m in js.get('materials', []):
        still |= set(m.get('extensions', {}).keys())
    used = {u for u in used if not u.startswith('KHR_materials_') or u in still}
    js.setdefault('asset', {})['copyright'] = 'Furniture models derived from Kenney Furniture Kit (CC0, kenney.nl). Generated by assets/_src/office/build_office.py'
    js['extensionsUsed'] = sorted(used)
    nb = json.dumps(js, separators=(',', ':')).encode('utf8')
    nb += b' ' * ((4 - len(nb) % 4) % 4)
    out = struct.pack('<4sII', magic, ver, 12 + 8 + len(nb) + len(rest)) + struct.pack('<II', len(nb), jt) + nb + rest
    open(path, 'wb').write(out)
    print('patched GLB: %d unlit materials' % n_unlit)


def check_glb(path):
    data = open(path, 'rb').read()
    jl, jt = struct.unpack('<II', data[12:20])
    js = json.loads(data[20:20 + jl].decode('utf8'))
    nodes = js['nodes']
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i

    def world(i):
        n = nodes[i]
        t = n.get('translation', [0, 0, 0])
        if i in parent:
            pw = world(parent[i])
            return [pw[0] + t[0], pw[1] + t[1], pw[2] + t[2]]
        return list(t)
    named = {n.get('name'): i for i, n in enumerate(nodes)}
    groups = {'desk': 20, 'screen': 20, 'lounge': 6}
    ok = True
    for g, cnt in groups.items():
        found = []
        for k in range(1, cnt + 1):
            nm = '%s_%02d' % (g, k)
            if nm not in named:
                print('MISSING', nm)
                ok = False
                continue
            p = world(named[nm])
            found.append((nm, p))
            print('  %-10s (%6.2f, %5.2f, %6.2f)' % (nm, *p))
        print('%s: %d/%d' % (g, len(found), cnt))
    # desks inside work zone + row-major
    dp = [world(named['desk_%02d' % k]) for k in range(1, 21)]
    inz = all(-7 <= p[0] <= 3 and -4.5 <= p[2] <= 4 for p in dp)
    rm = all(dp[r * 5 + c][0] < dp[r * 5 + c + 1][0] for r in range(4) for c in range(4)) and \
        all(dp[r * 5][2] < dp[(r + 1) * 5][2] for r in range(3))
    def facing(i):
        q = nodes[i].get('rotation', [0, 0, 0, 1])
        x, y, z, w = q
        # rotate (0,0,1) by quaternion
        fx = 2 * (x * z + w * y)
        fy = 2 * (y * z - w * x)
        fz = 1 - 2 * (x * x + y * y)
        return fx, fy, fz
    for g in ('lounge', 'desk', 'screen'):
        for k in ((1, 2, 3, 4, 5, 6) if g == 'lounge' else (1, 20)):
            print('  facing %s_%02d = (%.2f, %.2f, %.2f)' % (g, k, *facing(named['%s_%02d' % (g, k)])))
    print('desks inside work zone:', inz, '| row-major back-row-first, left-to-right:', rm)
    tris = 0
    for n in nodes:
        if 'mesh' in n:
            for pr in js['meshes'][n['mesh']]['primitives']:
                tris += js['accessors'][pr['indices']]['count'] // 3 if 'indices' in pr else js['accessors'][pr['attributes']['POSITION']]['count'] // 3
    print('triangles: %d | nodes: %d | meshes: %d | materials: %d | images: %d' % (tris, len(nodes), len(js['meshes']), len(js.get('materials', [])), len(js.get('images', []))))
    print('file size: %.2f MB' % (os.path.getsize(path) / 1048576))
    print('extensionsUsed:', js.get('extensionsUsed'))
    print('baked meshes:', [n['name'] for n in nodes if n.get('name', '').startswith('baked_')])
    return ok and inz and rm


# ================================================================== PREVIEW
def add_dummy_blobs():
    cols = ['#FF7A59', '#2F6BFF', '#F0A6C8', '#3FB8A5', '#222222', '#F5B000']
    for k, (nm, loc) in enumerate(sorted(EMPTIES.items())):
        if not (nm.startswith('desk_') or nm.startswith('lounge_')):
            continue
        e = bpy.data.objects[nm]
        mb = MB()
        m = mat('dummy%d' % (k % 6), cols[k % 6], 0.3)
        mb.uvs((0, 0.38, 0), (0.4, 0.38, 0.4), m, seg=20, rings=12)
        eye = mat('dummy_eye', '#FFFFFF', 0.3)
        for sx in (-0.12, 0.12):
            mb.uvs((sx, 0.5, 0.36), (0.06, 0.1, 0.03), eye, seg=10, rings=8)
        o = mb.build('dummy_' + nm, loc, 0.0)
        o.rotation_mode = 'QUATERNION'
        o.rotation_quaternion = e.rotation_quaternion
        o.rotation_mode = 'XYZ'


def render_preview(path, baked_out, quick):
    sc = bpy.context.scene
    # swap baked materials to unlit emission (what the integrator will do)
    for name, (jpg, img) in baked_out.items():
        ob = bpy.data.objects[name]
        m = bpy.data.materials.new(name + '_unlit')
        m.use_nodes = True
        nt = m.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = img
        tex.extension = 'EXTEND'
        em = nt.nodes.new('ShaderNodeEmission')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(tex.outputs['Color'], em.inputs['Color'])
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
        ob.data.materials.clear()
        ob.data.materials.append(m)
    for o in list(bpy.data.objects):
        if o.type == 'LIGHT':
            bpy.data.objects.remove(o)
    # browser-like lighting: hemisphere + directional from (-4, 8, -3) towards origin, bg = page colour
    w = bpy.data.worlds.new('PreviewWorld')
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    bgA = nt.nodes.new('ShaderNodeBackground')
    bgA.inputs['Color'].default_value = (0.86, 0.87, 0.90, 1)
    bgA.inputs['Strength'].default_value = 0.62
    bgB = nt.nodes.new('ShaderNodeBackground')
    bgB.inputs['Color'].default_value = hexcol('#F6F1EA')
    bgB.inputs['Strength'].default_value = 1.0
    lp = nt.nodes.new('ShaderNodeLightPath')
    mix = nt.nodes.new('ShaderNodeMixShader')
    outn = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs['Fac'])
    nt.links.new(bgA.outputs['Background'], mix.inputs[1])
    nt.links.new(bgB.outputs['Background'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], outn.inputs['Surface'])
    add_sun('PreviewSun', (4, -8, 3), 2.6, (1.0, 0.95, 0.88), 3.0)
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    if 'dummies' in ARGS:                # debug only: placeholder blobs at the seat empties (never exported)
        add_dummy_blobs()
    res = (1600, 1000)
    cam = iso_camera(res)
    pts = [(x, y, z) for x in (-8.2, 8.0) for y in (-0.25, 3.0) for z in (-6.2, 6.0)]
    fit_camera(cam, pts, res, 1.05)
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.cycles.samples = 24 if quick else 160
    sc.cycles.use_denoising = True
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('preview ->', path)
    for a in ARGS:                      # debug close-ups: close=x,y,z,scale  (contract point to centre on, ortho scale)
        if a.startswith('close='):
            x, y, z, scl = [float(v) for v in a[6:].split(',')]
            cam.data.ortho_scale = scl
            inv = cam.matrix_world.inverted()
            q = inv @ B(x, y, z)
            cam.data.shift_x = q.x / scl
            cam.data.shift_y = q.y / scl
            sc.render.filepath = os.environ.get('CLOSE_OUT', os.path.join(BAKEDIR, 'closeup.png'))
            bpy.ops.render.render(write_still=True)
            print('closeup ->', sc.render.filepath)


# ================================================================== MAIN
def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    setup_cycles(64)
    sc.view_settings.view_transform = 'Standard'
    fl, wb, wl = build_shell()
    whiteboard()
    build_furniture()
    # lighting for bake: sun from the back-left windows (travels +X +Z) + soft sky
    set_world((0.74, 0.80, 0.92), 1.1)
    add_sun('BakeSun', SUN_TRAVEL, 4.6, (1.0, 0.92, 0.80), 1.6)
    baked = [
        (fl, '#E6CFAA', (2048, 1536), (4096, 3072), wood_albedo, 1.0),
        (wb, '#F5EFE5', (2048, 384), (4096, 768), lambda W, H: plaster_albedo(W, H, 5), 1.32),
        (wl, '#F5EFE5', (1536, 384), (3072, 768), lambda W, H: plaster_albedo(W, H, 6), 1.32),
    ]
    out = run_bake(baked, QUICK)
    strip_uvs()
    glb = os.path.join(OUT, 'office.glb')
    export_glb(glb)
    patch_glb(glb)
    print('---- CHECK ----')
    ok = check_glb(glb)
    print('contract check OK:', ok)
    print('blender-side triangles (incl. glass etc.):', tri_count_objects(list(collection().objects)))
    render_preview(os.path.join(OUT, 'preview.png'), out, QUICK)


if STAGE != 'lib':
    main()
