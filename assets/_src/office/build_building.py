# Bot HQ v2 building generator: floor_open / floor_closed / roof / elevator_shaft / elevator_cabin -> assets/office/office.glb
#   blender -b --factory-startup -P build_building.py -- [quick] [nopreview] [preview]
#     quick     low-sample bake / small textures (geometry iteration)
#     nopreview skip the preview renders
#     preview   only re-render previews from the existing GLB + night JPGs
# Output: assets/office/office.glb (day lightmaps embedded), assets/office/night/<baked mesh>.jpg,
#         assets/office/preview-day.png, preview-night.png (+ preview-stack-*.png for the closed floors / roof / elevator).
# All helpers take CONTRACT coordinates (glTF Y-up, +z toward the camera); see docs/CONTRACT.md v2.4.
import sys, os, math, json, struct, zlib, time, shutil

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
QUICK = 'quick' in ARGV
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_argv = sys.argv
sys.argv = (sys.argv[:sys.argv.index('--')] if '--' in sys.argv else sys.argv) + ['--', 'lib']
import build_office as bo                       # helpers only ('lib' stage)
sys.argv = _argv

import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix

B, MB, mat, hexcol = bo.B, bo.MB, bo.mat, bo.hexcol

ASSETS = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ASSETS, 'office')
NIGHT = os.path.join(OUT, 'night')
TMP = os.path.join(HERE, 'bake2')
for d in (OUT, NIGHT, TMP):
    os.makedirs(d, exist_ok=True)
GLB = os.path.join(OUT, 'office.glb')

# ------------------------------------------------------------------ constants (contract v2.4)
SLAB = 0.36
STEP = 1.6
BAND = STEP - SLAB            # 1.24 glass band of a closed floor
WH = 2.7                      # open floor wall height
SW, SD = 16.4, 12.4           # slab footprint
POUF_H = 0.42
TABLES = [(-2.3, -2.7), (-2.3, 1.5)]       # (centre x, centre z); long axis along x
SEAT_DX = [-3.4, -1.7, 0.0, 1.7, 3.4]
SEAT_DZ = 1.2
LAMP_Y = 2.45                               # bulb height of the pendants
LAMP_DX = [-3.05, 0.35, 3.75]    # seat + 0.35: in the iso view a far-side blob lines up with x = seat + 1.2, so lamps never cover a face
SOFA = (5.3, 0.6)
SHAFT_C = (9.05, -2.6)

COLORS = dict(slab='#F6F5F2', wall='#F4F2EE', oak='#D9C39F', black='#1C1C1E', graphite='#3A3A3C', alu='#CFCFD2',
              fabric='#E2DFDA', fabric2='#C9C5BE', rug='#C6C3BC', pot='#F1EFEB', trunk='#6B5A48',
              leaf1='#4F7A45', leaf2='#6B925A', leaf3='#3E6538', glass='#DDE7EE', mull='#D9DADD',
              facade='#262E3A', roof='#BFBCB6', ac='#C4C4C7', floorstone='#DCD8D0')
M = {}


def make_materials():
    bo.MATS.clear()
    M.clear()
    C = COLORS
    M['slab'] = mat('slab_white', C['slab'], 0.7)
    M['wall'] = mat('wall_white', C['wall'], 0.9)
    M['oak'] = mat('oak', C['oak'], 0.5)
    M['black'] = mat('black', C['black'], 0.4)
    M['graphite'] = mat('graphite', C['graphite'], 0.5)
    M['alu'] = mat('aluminium', C['alu'], 0.3, metal=0.8)
    M['fabric'] = mat('fabric_light', C['fabric'], 0.95)
    M['fabric2'] = mat('fabric_warm', C['fabric2'], 0.95)
    M['rug'] = mat('rug', C['rug'], 1.0)
    M['pot'] = mat('pot_white', C['pot'], 0.5)
    M['trunk'] = mat('trunk', C['trunk'], 0.8)
    M['leaf'] = [mat('leaf_1', C['leaf1'], 0.55), mat('leaf_2', C['leaf2'], 0.55), mat('leaf_3', C['leaf3'], 0.55)]
    M['glass'] = mat('glass_pane', C['glass'], 0.05, alpha=0.08)
    M['glass_shaft'] = mat('glass_shaft', '#CFE0EA', 0.05, alpha=0.14)
    M['glass_cabin'] = mat('glass_cabin', '#D6E6EF', 0.05, alpha=0.18)
    M['mull'] = mat('mullion_light', C['mull'], 0.45)
    M['roof'] = mat('roof_deck', C['roof'], 0.85)
    M['ac'] = mat('ac_unit', C['ac'], 0.5)
    M['floor_cab'] = mat('cabin_floor', '#ECEAE5', 0.6)
    M['bar_white'] = mat('bar_white', C['slab'], 0.6)
    M['wall_screen'] = mat('wall_screen', '#0E1218', 0.35)
    M['task_board'] = mat('task_board', '#F4F2EE', 0.8)
    # emissive materials: emissiveFactor stays non-zero in the GLB so the scene can ramp it with emissiveIntensity
    M['night_screen'] = emat('night_screen', '#0F141B', '#8EB8F5', 0.25)
    M['night_lamp'] = emat('night_lamp', '#2A2520', '#FFC880', 0.5)
    # night_windows is built in floor_closed (needs the emissive map)


def emat(name, base_hex, emit_hex, rough=0.3, strength=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = hexcol(base_hex)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Emission Color'].default_value = hexcol(emit_hex)
    b.inputs['Emission Strength'].default_value = strength
    m.diffuse_color = hexcol(base_hex)
    return m


def set_emission(name, strength):
    m = bpy.data.materials[name]
    m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = strength


# ------------------------------------------------------------------ small geometry helpers
def lathe(mb, c, profile, m, seg=32, loop=False, smooth=True):
    """solid of revolution around the vertical axis. profile = [(r, y), ...] from axis to axis (r = 0 -> pole)
    or a closed ring loop (loop=True, r > 0). c = contract position of the local origin."""
    bm = mb.bm
    rings = []
    for (r, y) in profile:
        if r < 1e-6:
            rings.append([bm.verts.new(Vector((0.0, 0.0, y)))])
        else:
            rings.append([bm.verts.new(Vector((r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg), y)))
                          for k in range(seg)])
    pairs = list(zip(rings[:-1], rings[1:]))
    if loop:
        pairs.append((rings[-1], rings[0]))
    for a, b in pairs:
        if len(a) == 1 and len(b) == 1:
            continue
        for k in range(seg):
            k2 = (k + 1) % seg
            if len(a) == 1:
                bm.faces.new((a[0], b[k2], b[k]))
            elif len(b) == 1:
                bm.faces.new((a[k], a[k2], b[0]))
            else:
                bm.faces.new((a[k], a[k2], b[k2], b[k]))
    mb._place([v for rg in rings for v in rg], c, (0, 0, 0), m, smooth=smooth)


def quad_obj(name, centre, normal, w, h, material, mesh=None):
    """upright w x h quad, front face (+Z of the node) along `normal`, UV 0..1 (u to the viewer's right, v up)"""
    if mesh is None:
        bm = bmesh.new()
        uv = bm.loops.layers.uv.new('UVMap')
        pts = [(-w / 2, 0, -h / 2), (w / 2, 0, -h / 2), (w / 2, 0, h / 2), (-w / 2, 0, h / 2)]
        uvs = [(0, 1), (1, 1), (1, 0), (0, 0)]      # Blender v is flipped on export: file v = 1 at the top edge (three.js PlaneGeometry convention)
        f = bm.faces.new([bm.verts.new(p) for p in pts])
        for lp, t in zip(f.loops, uvs):
            lp[uv].uv = t
        f.smooth = False
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        mesh.materials.append(material)
    ob = bpy.data.objects.new(name, mesh)
    bo.collection().objects.link(ob)
    ob.location = B(*centre)
    n = Vector(normal).normalized()
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = Vector((n.x, -n.z, n.y)).to_track_quat('-Y', 'Z')
    return ob


def new_root(name, loc=(0, 0, 0)):
    r = bpy.data.objects.new(name, None)
    r.empty_display_type = 'PLAIN_AXES'
    r.empty_display_size = 0.5
    bo.collection().objects.link(r)
    r.location = B(*loc)
    return r


class Scope:
    """collect every object created inside the block and parent it to `root`"""

    def __init__(self, root):
        self.root = root

    def __enter__(self):
        self.before = set(bo.collection().objects)
        return self

    def __exit__(self, *a):
        for o in list(bo.collection().objects):
            if o not in self.before and o is not self.root and o.parent is None:
                o.parent = self.root
        return False


# ------------------------------------------------------------------ floor_open
def seats():
    """20 seats. desk numbering: table 1 = 01..10, table 2 = 11..20; per column left->right the far seat (faces +Z)
    is odd, the near seat (faces -Z) is even."""
    out = []
    for ti, (cx, cz) in enumerate(TABLES):
        for si, dx in enumerate(SEAT_DX):
            for k, side in enumerate((-1, 1)):                    # -1 = far side (-z), 1 = near side
                n = ti * 10 + si * 2 + k + 1
                out.append(dict(n=n, ti=ti, si=si, side=side, x=cx + dx, z=cz + side * SEAT_DZ, f=-side))
    return out


def build_table(ti, cx, cz):
    t = MB()
    t.box((0, 0.725, 0), (9.0, 0.05, 1.4), M['oak'], bevel=0.015)
    for x in (-4.1, 0.0, 4.1):
        for z in (-0.55, 0.55):
            t.box((x, 0.35, z), (0.05, 0.70, 0.05), M['black'])
        t.box((x, 0.68, 0), (0.05, 0.04, 1.16), M['black'])
    return t.build('table_%d' % (ti + 1), (cx, 0, cz))


POUF = [(0, 0), (0.25, 0), (0.268, 0.025), (0.274, 0.12), (0.272, 0.29), (0.256, 0.385), (0.215, 0.412), (0.12, 0.4185), (0, 0.42)]


def build_open(root):
    S = seats()
    with Scope(root):
        # --- slab (visible white edge); its top sits 4 mm under the baked surfaces
        s = MB()
        s.box((0, -SLAB / 2 - 0.002, 0), (SW, SLAB - 0.004, SD), M['slab'], bevel=0.03)
        s.build('slab_open')
        # --- baked surfaces
        fl = bo.baked_mesh('baked_floor', [((-8, 0, 6), (8, 0, 6), (8, 0, -6), (-8, 0, -6))],
                           lambda x, y, z: ((x + 8) / 16.0, (z + 6) / 12.0), (0, 1, 0))
        wl = bo.baked_mesh('baked_wall_left', [((-8, 0, -6), (-8, 0, 6), (-8, WH, 6), (-8, WH, -6))],
                           lambda x, y, z: ((z + 6) / 12.0, y / WH), (1, 0, 0))
        hx, hz = SW / 2, SD / 2
        ring = [((-hx, 0, -hz), (hx, 0, -hz), (hx, 0, -6), (-hx, 0, -6)),
                ((-hx, 0, 6), (hx, 0, 6), (hx, 0, hz), (-hx, 0, hz)),
                ((-hx, 0, -6), (-8, 0, -6), (-8, 0, 6), (-hx, 0, 6)),
                ((8, 0, -6), (hx, 0, -6), (hx, 0, 6), (8, 0, 6))]
        st = bo.baked_mesh('baked_slab_top', ring, lambda x, y, z: ((x + hx) / SW, (z + hz) / SD), (0, 1, 0))
        # --- left wall body (behind the baked face) + glass curtain wall on the back
        w = MB()
        w.box((-8.1 - 0.0015, WH / 2, -0.1), (0.2 - 0.003, WH, 12.2 - 0.0), M['wall'])
        w.build('wall_left_core')
        cw = MB()
        cw.box((0, WH - 0.04, -6.0), (16.0, 0.08, 0.12), M['black'])
        cw.box((0, 0.04, -6.0), (16.0, 0.08, 0.12), M['black'])
        for k in range(9):
            cw.box((-7.9 + k * (15.8 / 8), WH / 2, -6.0), (0.06, WH, 0.1), M['black'])
        cw.build('curtain_wall')
        g = MB()
        g.box((0, WH / 2, -6.0), (15.8, WH - 0.16, 0.002), M['glass'])
        g.build('glass_back')
        # --- tables, seats, laptops, mugs
        for ti, (cx, cz) in enumerate(TABLES):
            build_table(ti, cx, cz)
        pf = MB()
        lp = MB()
        mg = MB()
        TH = 0.28
        for s_ in S:
            x, z, f = s_['x'], s_['z'], s_['f']
            lathe(pf, (x, 0, z), POUF, M['fabric'] if (s_['si'] + s_['ti']) % 2 else M['fabric2'], seg=32)
            lz = TABLES[s_['ti']][1] + s_['side'] * 0.32                       # laptop base centre z
            lp.box((x, 0.757, lz), (0.36, 0.014, 0.25), M['alu'], bevel=0.004)
            lp.box((x, 0.7645, lz - f * 0.04), (0.30, 0.002, 0.12), M['graphite'])                 # keyboard deck
            hz_ = lz + f * 0.12
            lid_c = (x, 0.764 + 0.115 * math.cos(TH), hz_ + f * 0.115 * math.sin(TH))
            lp.box(lid_c, (0.36, 0.23, 0.008), M['alu'], bevel=0.003, rot=(TH * f, 0, 0))
            if (s_['si'] * 3 + s_['ti'] + s_['side']) % 4 == 0:
                mg.cyl((x + 0.32, 0.80, TABLES[s_['ti']][1] + s_['side'] * 0.36), 0.04, 0.04, 0.1, M['pot'], seg=20)
        pf.build('poufs')
        lp.build('laptops')
        mg.build('mugs')
        # --- empties + screens
        qmesh = None
        for s_ in S:
            n, x, z, f = s_['n'], s_['x'], s_['z'], s_['f']
            bo.make_empty('desk_%02d' % n, (x, POUF_H, z), (0, 0, f))
            lz = TABLES[s_['ti']][1] + s_['side'] * 0.32
            hz_ = lz + f * 0.12
            ctr = Vector((x, 0.764 + 0.115 * math.cos(TH), hz_ + f * 0.115 * math.sin(TH)))
            nrm = Vector((0, math.sin(TH), -math.cos(TH) * f))
            c2 = ctr + nrm * 0.0052
            bo.make_empty('screen_%02d' % n, tuple(c2), tuple(nrm))
            o = quad_obj('laptop_screen_%02d' % n, tuple(c2), tuple(nrm), 0.335, 0.205, M['night_screen'], mesh=qmesh)
            qmesh = o.data
        # --- lounge
        # (round rug = painted into the baked floor albedo, see stone_albedo)
        sf = MB()
        sf.box((0, 0.2, 0), (3.2, 0.24, 0.95), M['fabric2'], bevel=0.05)
        sf.box((0, 0.38, 0.08), (3.0, 0.14, 0.78), M['fabric'], bevel=0.06)
        sf.box((0, 0.6, -0.38), (3.2, 0.62, 0.22), M['fabric2'], bevel=0.08)
        for x in (-1.5, 1.5):
            sf.box((x, 0.42, 0), (0.22, 0.5, 0.95), M['fabric2'], bevel=0.07)
        for x in (-1.45, 1.45):
            for z in (-0.38, 0.38):
                sf.box((x, 0.04, z), (0.05, 0.08, 0.05), M['black'])
        sf.build('sofa', (SOFA[0], 0, SOFA[1]))
        for k, dx in enumerate((-0.9, 0.0, 0.9)):
            bo.make_empty('lounge_%02d' % (k + 1), (SOFA[0] + dx, 0.45, SOFA[1] + 0.1), (0, 0, 1))
        ct = MB()
        ct.cyl((0, 0.36, 0), 0.55, 0.55, 0.04, M['oak'], seg=48)
        ct.cyl((0, 0.17, 0), 0.05, 0.05, 0.34, M['black'], seg=16)
        ct.cyl((0, 0.01, 0), 0.25, 0.25, 0.02, M['black'], seg=32)
        ct.build('coffee_table', (5.3, 0, 2.4))
        for k, (ax, az, fx, fz) in enumerate(((3.55, 2.75, 0.60, 0.80), (7.05, 2.75, -0.45, 0.89))):
            ln = math.hypot(fx, fz)
            fx, fz = fx / ln, fz / ln
            a = MB()
            a.box((0, 0.22, 0), (0.95, 0.3, 0.9), M['black'], bevel=0.06)                        # local forward = +z
            a.box((0, 0.42, -0.05), (0.8, 0.12, 0.72), M['graphite'], bevel=0.05)
            a.box((0, 0.6, -0.38), (0.95, 0.5, 0.16), M['black'], bevel=0.06)
            a.box((-0.5, 0.45, 0), (0.1, 0.34, 0.8), M['black'], bevel=0.04)
            a.box((0.5, 0.45, 0), (0.1, 0.34, 0.8), M['black'], bevel=0.04)
            a.build('armchair_%d' % (k + 1), (ax, 0, az), bo.facing_yaw(fx, fz))
            bo.make_empty('lounge_%02d' % (4 + k), (ax + fx * 0.05, 0.48, az + fz * 0.05), (fx, 0, fz))
        # coffee bar along the glass
        bar = MB()
        bar.box((0, 0.45, 0), (3.4, 0.9, 0.8), M['bar_white'], bevel=0.02)
        bar.box((0, 0.92, 0), (3.5, 0.04, 0.86), M['oak'], bevel=0.01)
        bar.box((-1.0, 1.07, 0), (0.28, 0.25, 0.3), M['black'], bevel=0.02)
        bar.cyl((-0.6, 0.99, 0.1), 0.045, 0.045, 0.1, M['pot'], seg=16)
        bar.cyl((0.4, 0.99, 0.0), 0.045, 0.045, 0.1, M['pot'], seg=16)
        bar.build('coffee_bar', (4.6, 0, -5.1))
        stl = MB()
        for x in (3.4, 4.6, 5.8):
            stl.cyl((x, 0.66, -4.15), 0.19, 0.19, 0.05, M['oak'], seg=32)
            stl.cyl((x, 0.33, -4.15), 0.025, 0.025, 0.64, M['black'], seg=12)
            stl.cyl((x, 0.01, -4.15), 0.17, 0.17, 0.02, M['black'], seg=24)
        stl.build('bar_stools')
        bo.make_empty('lounge_06', (4.6, 0.69, -4.15), (0, 0, 1))
        # trees
        for nm, x, z, sc_, seed in (('tree_1', 7.1, -1.6, 1.25, 3), ('tree_2', -7.0, 5.0, 1.0, 7), ('tree_3', 2.9, -5.3, 0.8, 11)):
            tree(nm, x, z, sc_, seed)
        # wall display + task board on the left wall (x = -8, facing +X)
        bz = MB()
        bz.box((-7.975, 1.5, -3.3), (0.05, 1.58, 2.72), M['black'], bevel=0.012)
        bz.box((-7.975, 1.5, 0.5), (0.05, 1.62, 3.12), M['alu'], bevel=0.01)
        bz.build('wall_frames')
        quad_obj('wall_screen', (-7.9475, 1.5, -3.3), (1, 0, 0), 2.6, 1.46, M['wall_screen'])
        quad_obj('task_board', (-7.9475, 1.5, 0.5), (1, 0, 0), 3.0, 1.5, M['task_board'])
        # pendant lamps
        pendants()
    return fl, wl, st


def tree(name, x, z, s=1.0, seed=3):
    import random
    rng = random.Random(seed)
    t = MB()
    lathe(t, (0, 0, 0), [(0, 0), (0.255 * s, 0), (0.275 * s, 0.03 * s), (0.34 * s, 0.6 * s), (0.345 * s, 0.64 * s), (0.30 * s, 0.645 * s), (0, 0.645 * s)],
          M['pot'], seg=40)
    t.cyl((0, 1.05 * s, 0), 0.035 * s, 0.05 * s, 0.9 * s, M['trunk'], seg=10)
    for i in range(14):
        a = rng.uniform(0, 6.283)
        r = rng.uniform(0.05, 0.45) * s
        y = rng.uniform(1.45, 2.15) * s
        k = rng.uniform(0.22, 0.34) * s
        t.ell((math.cos(a) * r, y, math.sin(a) * r), (k, k * 0.8, k), M['leaf'][i % 3], sub=3)
    return t.build(name, (x, 0, z))


LAMPS = []


def pendants():
    pb = MB()
    for ti, (cx, cz) in enumerate(TABLES):
        for dx in LAMP_DX:
            x = cx + dx
            LAMPS.append((x, LAMP_Y, cz))
            # dome shade (hollow shell, open at the bottom): outer wall from the apex down to the rim, back up inside
            top, bot = LAMP_Y + 0.22, LAMP_Y - 0.02
            shade = [(0, top - 0.012), (0.066, top - 0.012), (0.19, bot), (0.2, bot), (0.2, bot + 0.004), (0.07, top), (0, top)]
            lathe(pb, (x, 0, cz), shade, M['black'], seg=36)
            pb.cyl((x, (top + WH) / 2, cz), 0.006, 0.006, WH - top, M['black'], seg=6)          # cable
            pb.cyl((x, WH - 0.01, cz), 0.04, 0.04, 0.02, M['black'], seg=16)                      # ceiling rose
            # glow ring on the rim + bulb (night_lamp)
            lathe(pb, (x, 0, cz), [(0.188, bot - 0.012), (0.205, bot - 0.012), (0.205, bot + 0.008), (0.188, bot + 0.008)], M['night_lamp'], seg=36, loop=True)
            pb.uvs((x, LAMP_Y, cz), (0.045, 0.045, 0.045), M['night_lamp'], seg=12, rings=8)
    pb.build('pendants')
    for k, (x, y, z) in enumerate(LAMPS):
        bo.make_empty('lamp_%02d' % (k + 1), (x, y, z), (0, -1, 0))


# ------------------------------------------------------------------ floor_closed / roof / elevator
def write_png(path, arr):
    h, w, _ = arr.shape
    raw = b''.join(b'\x00' + arr[y].tobytes() for y in range(h))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)


FACE_PANES = [16, 12, 16, 12]         # +z, +x, -z, -x faces: number of bays (mullion spacing)
LIT_FRACTION = 0.40


def windows_texture(path):
    """emissive map: 4 rows (one per facade face, top row = +z face), 2 cells per bay, ~40 % of the cells lit warm"""
    W, H, RH = 2048, 512, 128
    rng = np.random.default_rng(21)
    img = np.zeros((H, W, 3), np.float32)
    lit = tot = 0
    for r, bays in enumerate(FACE_PANES):
        cells = bays * 2
        pick = set(rng.permutation(cells)[:int(round(cells * LIT_FRACTION))].tolist())
        for i in range(cells):
            tot += 1
            if i not in pick:
                continue
            lit += 1
            x0, x1 = int(round(i * W / cells)) + 3, int(round((i + 1) * W / cells)) - 3
            y0, y1 = r * RH + 8, (r + 1) * RH - 8
            warm = rng.uniform(0.0, 1.0)
            col = np.array([1.0, 0.80 + 0.12 * warm, 0.52 + 0.25 * warm], np.float32) * rng.uniform(0.62, 1.0)
            gy = np.linspace(1.0, 0.72, y1 - y0, dtype=np.float32)[:, None, None]              # slightly brighter near the ceiling
            img[y0:y1, x0:x1] = col[None, None, :] * gy
            if rng.random() < 0.3:                                                             # half-drawn blind
                img[y0 + int((y1 - y0) * 0.55):y1, x0:x1] *= 0.35
    print('windows: %d/%d cells lit (%.1f%%)' % (lit, tot, 100.0 * lit / tot))
    arr = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
    write_png(path, arr)
    return lit / tot


def facade_mesh(hw, hd, y0, y1):
    """4 side faces of the glass band (outward normals) with UVs: one atlas row per face"""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    faces = [  # (corner a, corner b) seen from outside, left -> right
        (((-hw, y0, hd), (hw, y0, hd)), (0, 0, 1)),
        (((hw, y0, hd), (hw, y0, -hd)), (1, 0, 0)),
        (((hw, y0, -hd), (-hw, y0, -hd)), (0, 0, -1)),
        (((-hw, y0, -hd), (-hw, y0, hd)), (-1, 0, 0)),
    ]
    for i, ((a, b), n) in enumerate(faces):
        v0, v1 = 1 - (i + 1) / 4.0, 1 - i / 4.0
        pts = [a, b, (b[0], y1, b[2]), (a[0], y1, a[2])]
        uvs = [(0, v0), (1, v0), (1, v1), (0, v1)]
        f = bm.faces.new([bm.verts.new(B(*p)) for p in pts])
        f.normal_update()
        nB = Vector((n[0], -n[2], n[1]))
        if f.normal.dot(nB) < 0:
            f.normal_flip()
        for lp in f.loops:
            co = lp.vert.co
            # find uv by matching the vertex position
            for p, t in zip(pts, uvs):
                if (B(*p) - co).length < 1e-6:
                    lp[uv].uv = t
        f.smooth = False
    return bm


def build_closed(root):
    wtex = os.path.join(TMP, 'night_windows.png')
    windows_texture(wtex)
    img = bpy.data.images.load(wtex)
    img.colorspace_settings.name = 'sRGB'
    m = bpy.data.materials.new('night_windows')
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = hexcol(COLORS['facade'])
    b.inputs['Roughness'].default_value = 0.12
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.links.new(tex.outputs['Color'], b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = 1.0
    M['night_windows'] = m
    hw, hd = 15.7 / 2, 11.7 / 2
    with Scope(root):
        s = MB()
        s.box((0, -SLAB / 2, 0), (SW, SLAB, SD), M['slab'], bevel=0.03)
        s.build('slab_closed')
        bm = facade_mesh(hw, hd, 0.0, BAND)
        me = bpy.data.meshes.new('facade_glass')
        bm.to_mesh(me)
        bm.free()
        me.materials.append(m)
        ob = bpy.data.objects.new('facade_glass', me)
        bo.collection().objects.link(ob)
        mu = MB()
        yc = BAND / 2
        for k in range(17):
            x = -hw + k * (2 * hw / 16)
            mu.box((x, yc, hd), (0.055, BAND, 0.05), M['mull'])
            mu.box((x, yc, -hd), (0.055, BAND, 0.05), M['mull'])
        for k in range(1, 12):
            z = -hd + k * (2 * hd / 12)
            mu.box((hw, yc, z), (0.05, BAND, 0.055), M['mull'])
            mu.box((-hw, yc, z), (0.05, BAND, 0.055), M['mull'])
        mu.build('facade_mullions')


def build_roof(root):
    with Scope(root):
        s = MB()
        s.box((0, 0.18, 0), (SW, 0.36, SD), M['slab'], bevel=0.03)
        s.box((0, 0.3605, 0), (SW - 0.4, 0.002, SD - 0.4), M['roof'])
        t = 0.16
        py = 0.36 + 0.22
        s.box((0, py, SD / 2 - 0.1), (SW - 0.2, 0.44, t), M['slab'], bevel=0.01)
        s.box((0, py, -SD / 2 + 0.1), (SW - 0.2, 0.44, t), M['slab'], bevel=0.01)
        s.box((SW / 2 - 0.1, py, 0), (t, 0.44, SD - 0.2 - 2 * t), M['slab'], bevel=0.01)
        s.box((-SW / 2 + 0.1, py, 0), (t, 0.44, SD - 0.2 - 2 * t), M['slab'], bevel=0.01)
        s.build('roof_slab')
        a = MB()
        for (x, z, w, d, h) in ((-3.2, -1.6, 1.5, 1.0, 0.8), (-1.5, -1.6, 1.5, 1.0, 0.8), (3.8, 1.8, 1.0, 1.0, 0.7), (-4.5, 2.6, 2.0, 1.1, 0.55)):
            a.box((x, 0.36 + h / 2, z), (w, h, d), M['ac'], bevel=0.02)
            a.box((x, 0.36 + h + 0.004, z), (min(w, d) * 0.72, 0.008, min(w, d) * 0.72), M['graphite'])
            for i in range(5):
                a.box((x, 0.36 + h * (0.2 + 0.14 * i), z + d / 2 + 0.004), (w * 0.8, 0.012, 0.008), M['graphite'])
        a.box((5.6, 0.36 + 0.55, -3.4), (2.6, 1.1, 1.9), M['slab'], bevel=0.02)             # stair head
        a.box((5.6, 0.36 + 1.1 + 0.02, -3.4), (2.76, 0.04, 2.06), M['roof'], bevel=0.01)
        a.box((5.0, 0.36 + 0.4, -3.4 + 0.96), (0.8, 0.8, 0.02), M['graphite'])             # door
        a.cyl((-6.8, 0.36 + 0.9, 4.2), 0.015, 0.015, 1.8, M['black'], seg=8)               # mast
        a.cyl((-6.8, 0.36 + 0.03, 4.2), 0.12, 0.12, 0.06, M['graphite'], seg=16)
        a.build('roof_equipment')


def build_shaft(root):
    with Scope(root):
        p = MB()
        for sx in (-1, 1):
            for sz in (-1, 1):
                p.box((sx * 0.715, 0.5, sz * 0.715), (0.07, 1.0, 0.07), M['black'])
        p.build('shaft_posts')
        for nm, c, n, w in (('shaft_glass_px', (0.715, 0.5, 0), (1, 0, 0), 1.5), ('shaft_glass_nx', (-0.715, 0.5, 0), (-1, 0, 0), 1.5),
                            ('shaft_glass_pz', (0, 0.5, 0.715), (0, 0, 1), 1.5), ('shaft_glass_nz', (0, 0.5, -0.715), (0, 0, -1), 1.5)):
            quad_obj(nm, c, n, w - 0.1, 1.0, M['glass_shaft'])


def build_cabin(root):
    with Scope(root):
        f = MB()
        f.box((0, 0.03, 0), (1.3, 0.06, 1.3), M['floor_cab'], bevel=0.01)
        f.box((0, 2.175, 0), (1.3, 0.05, 1.3), M['graphite'], bevel=0.01)
        for sx in (-1, 1):
            for sz in (-1, 1):
                f.box((sx * 0.6275, 1.1, sz * 0.6275), (0.045, 2.2, 0.045), M['black'])
        for y in (0.075, 2.14):
            f.box((0, y, 0.63), (1.3, 0.04, 0.04), M['black'])
            f.box((0, y, -0.63), (1.3, 0.04, 0.04), M['black'])
            f.box((0.63, y, 0), (0.04, 0.04, 1.3), M['black'])
            f.box((-0.63, y, 0), (0.04, 0.04, 1.3), M['black'])
        f.box((0, 2.14, 0), (0.7, 0.012, 0.7), M['night_lamp'])                                 # ceiling light
        f.build('cabin_frame')
        for nm, c, n in (('cabin_glass_px', (0.6275, 1.1, 0), (1, 0, 0)), ('cabin_glass_nx', (-0.6275, 1.1, 0), (-1, 0, 0)),
                         ('cabin_glass_pz', (0, 1.1, 0.6275), (0, 0, 1)), ('cabin_glass_nz', (0, 1.1, -0.6275), (0, 0, -1))):
            quad_obj(nm, c, n, 1.2, 2.0, M['glass_cabin'])


# ------------------------------------------------------------------ BAKE
SKY_DAY, SUN_DAY = 0.55, 2.8
SUN_COL = (1.0, 0.91, 0.80)
SUN_TRAVEL = (0.62, -0.55, 0.56)
SKY_NIGHT = 0.12
LAMP_W = 120.0


def clear_lights():
    for o in list(bpy.data.objects):
        if o.type == 'LIGHT':
            bpy.data.objects.remove(o)


def setup_day():
    clear_lights()
    bo.set_world((0.74, 0.81, 0.93), SKY_DAY)
    bo.add_sun('BakeSun', SUN_TRAVEL, SUN_DAY, SUN_COL, 2.0)
    set_emission('night_screen', 0.0)
    set_emission('night_lamp', 0.0)


def setup_night():
    clear_lights()
    bo.set_world((0.04, 0.06, 0.15), SKY_NIGHT)
    for k, (x, y, z) in enumerate(LAMPS):
        ld = bpy.data.lights.new('lamp%d' % k, 'POINT')
        ld.energy = LAMP_W
        ld.color = (1.0, 0.72, 0.44)
        ld.shadow_soft_size = 0.06
        lo = bpy.data.objects.new('lamp%d' % k, ld)
        bpy.context.scene.collection.objects.link(lo)
        lo.location = B(x, y + 0.02, z)
    set_emission('night_screen', 5.0)
    set_emission('night_lamp', 0.0)           # the bulbs are represented by the point lights


def stone_albedo(W, H):
    rng = np.random.default_rng(5)
    base = bo.lin_of(COLORS['floorstone'])
    n = bo.blur2(rng.standard_normal((H // 8, W // 8, 1)).astype(np.float32), 5)[..., 0]
    n = bo.resize_bilinear(n[..., None], H, W)[..., 0]
    n /= n.std() + 1e-6
    fine = rng.standard_normal((H, W)).astype(np.float32)
    var = 1.0 + 0.012 * n + 0.006 * fine
    x = (np.arange(W, dtype=np.float32) + 0.5) * (16.0 / W)
    z = (np.arange(H, dtype=np.float32) + 0.5) * (12.0 / H)
    jx = np.abs(((x + 0.8) % 1.6) - 0.8)           # distance to the nearest vertical joint (1.6 m grid)
    jz = np.abs(((z + 0.75) % 1.5) - 0.75)
    joint = np.minimum(jx[None, :], jz[:, None])
    line = 1.0 - 0.045 * np.clip(1.0 - joint / 0.004, 0, 1)
    img = base[None, None, :] * (var * line)[..., None]
    # round rug (centre 5.3, 2.3; r 2.2): slightly darker, cooler wool, soft edge, one fine inner ring
    rc = bo.lin_of(COLORS['rug'])
    d = np.hypot(x[None, :] - (5.3 + 8.0), z[:, None] - (2.3 + 6.0))      # x, z here are floor-local (0..16, 0..12)
    px = 16.0 / W
    edge = np.clip((2.2 - d) / (1.6 * px), 0, 1)
    ring = 1.0 - 0.05 * np.clip(1.0 - np.abs(d - 1.95) / 0.012, 0, 1)
    wool = 1.0 + 0.020 * rng.standard_normal((H, W)).astype(np.float32)
    rug = rc[None, None, :] * (wool * ring)[..., None]
    img = img * (1 - edge[..., None]) + rug * edge[..., None]
    return img.astype(np.float32)


def flat_albedo(hexc, seed=0, amp=0.008):
    base = bo.lin_of(hexc)

    def fn(W, H):
        rng = np.random.default_rng(seed)
        n = bo.box_blur_x(rng.standard_normal((H, W)).astype(np.float32), 9)
        n = bo.box_blur_x(n.T, 9).T
        n /= n.std() + 1e-6
        return (base[None, None, :] * (1 + amp * n)[..., None]).astype(np.float32)
    return fn


def dither(a, amp=0.7, seed=3):
    rng = np.random.default_rng(seed)
    return a + (rng.random(a.shape).astype(np.float32) - 0.5) * 2 * amp / 255.0


def compose(light, alb, expo, gain, tint=(1.0, 1.0, 1.0)):
    col = bo.shoulder(light * alb * expo * gain * np.array(tint, np.float32))
    lum = (col * np.array([0.2126, 0.7152, 0.0722], np.float32)).sum(-1, keepdims=True)
    col = lum + (col - lum) * 1.03
    return np.clip(dither(bo.srgb_enc(col)), 0, 1)


def run_bakes(baked, quick):
    """baked: list of (ob, albedo_hex, albedo_fn, light_size, final_size_day, final_size_night, gain)
    returns {name: (day_jpg_path, night_jpg_path)}"""
    t0 = time.time()
    sc = bpy.context.scene
    samples_d = 48 if quick else 320
    samples_n = 64 if quick else 640
    for (ob, hexc, *_r) in baked:
        bo.make_bake_material(ob, hexc)
    glass = [o for o in bpy.data.objects if o.name.startswith('glass_back')]
    for g in glass:
        g.hide_render = True
    lights = {'day': {}, 'night': {}}
    for mode, setup, samples in (('day', setup_day, samples_d), ('night', setup_night, samples_n)):
        setup()
        for (ob, hexc, afn, lsize, fd, fn_, gain) in baked:
            ls = (lsize[0] // 2, lsize[1] // 2) if quick else lsize
            print('baking', mode, ob.name, ls, samples)
            lights[mode][ob.name] = bo.bake_lighting(ob, ls, samples)
    for g in glass:
        g.hide_render = False
    out = {}
    fl = lights['day']['baked_floor']
    L = fl[..., 0] * 0.2126 + fl[..., 1] * 0.7152 + fl[..., 2] * 0.0722
    expo_d = 1.0 / np.percentile(L, 90)
    fn_ = lights['night']['baked_floor']
    Ln = fn_[..., 0] * 0.2126 + fn_[..., 1] * 0.7152 + fn_[..., 2] * 0.0722
    expo_n = 0.80 / np.percentile(Ln, 99)
    print('day light p50/p90/max', np.percentile(L, 50), np.percentile(L, 90), L.max(), 'expo', expo_d)
    print('night light p50/p99/max', np.percentile(Ln, 50), np.percentile(Ln, 99), Ln.max(), 'expo', expo_n)
    for (ob, hexc, afn, lsize, fd, fnt, gain) in baked:
        res = {}
        for mode, expo, size, tint in (('day', expo_d, fd, (1.0, 1.0, 0.99)), ('night', expo_n, fnt, (1.0, 1.0, 1.0))):
            if quick:
                size = (size[0] // 4, size[1] // 4)
            light = bo.blur2(lights[mode][ob.name], 2) if not quick else lights[mode][ob.name]
            light = bo.resize_bilinear(light, size[1], size[0])
            alb = afn(size[0], size[1])
            col = compose(light, alb, expo, gain, tint)
            path = bo.save_jpeg(col, '%s_%s' % (mode, ob.name), 90 if mode == 'day' else 86)
            res[mode] = path
            print(ob.name, mode, os.path.getsize(path) // 1024, 'KB', size)
        out[ob.name] = res
    print('bake time %.1f s' % (time.time() - t0))
    return out


# ------------------------------------------------------------------ export
def export_glb(path):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in bo.collection().objects:
        o.hide_set(False)
        o.select_set(True)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_image_format='AUTO', export_jpeg_quality=90,
              export_apply=True, export_yup=True, export_cameras=False, export_lights=False, export_extras=False,
              export_texcoords=True, export_normals=True, export_materials='EXPORT', export_animations=False)
    for _ in range(8):
        try:
            bpy.ops.export_scene.gltf(**kw)
            return
        except TypeError as e:
            bad = [k for k in kw if k in str(e)]
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
    for m in js.get('materials', []):
        nm = m.get('name', '')
        if nm.startswith('baked_'):
            m['extensions'] = {'KHR_materials_unlit': {}}
            pbr = m.setdefault('pbrMetallicRoughness', {})
            pbr['metallicFactor'] = 0.0
            pbr['roughnessFactor'] = 1.0
            m.pop('emissiveFactor', None)
            m.pop('emissiveTexture', None)
            used.add('KHR_materials_unlit')
        elif nm.startswith('glass'):
            m['alphaMode'] = 'BLEND'
            m['doubleSided'] = True
    still = set()
    for m in js.get('materials', []):
        still |= set(m.get('extensions', {}).keys())
    used = {u for u in used if not u.startswith('KHR_materials_') or u in still}
    js.setdefault('asset', {})['copyright'] = 'Bot HQ v2 building, generated by assets/_src/office/build_building.py'
    js['extensionsUsed'] = sorted(used)
    nb = json.dumps(js, separators=(',', ':')).encode('utf8')
    nb += b' ' * ((4 - len(nb) % 4) % 4)
    out = struct.pack('<4sII', magic, ver, 12 + 8 + len(nb) + len(rest)) + struct.pack('<II', len(nb), jt) + nb + rest
    open(path, 'wb').write(out)


# ------------------------------------------------------------------ PREVIEW (re-import the exported GLB, light it like the browser would)
def subtree(o):
    yield o
    for c in o.children:
        yield from subtree(c)


def clone_tree(root, offset=(0, 0, 0), scale_y=None):
    mapping = {}
    for o in subtree(root):
        n = o.copy()
        bpy.context.scene.collection.objects.link(n)
        mapping[o] = n
    for o, n in mapping.items():
        if o.parent in mapping:
            n.parent = mapping[o.parent]
            n.matrix_parent_inverse = o.matrix_parent_inverse.copy()
    nr = mapping[root]
    nr.location = nr.location + Vector(B(*offset))
    if scale_y:
        nr.scale = (1, 1, scale_y)
    return nr


def hide_tree(root, hide=True):
    for o in subtree(root):
        o.hide_render = hide
        o.hide_viewport = hide


def world_pos(o):
    t = o.matrix_world.translation
    return (t.x, t.z, -t.y)


def unlit_baked(night):
    for m in bpy.data.materials:
        if not m.name.startswith('baked_'):
            continue
        base = m.name.split('.')[0]
        nt = m.node_tree
        tex = next((n for n in nt.nodes if n.type == 'TEX_IMAGE'), None)
        if tex is None:
            continue
        if night:
            p = os.path.join(NIGHT, base + '.jpg')
            if os.path.exists(p):
                im = bpy.data.images.load(p)
                im.colorspace_settings.name = 'sRGB'
                tex.image = im
        tex.extension = 'EXTEND'
        for n in list(nt.nodes):
            if n.name != tex.name:
                nt.nodes.remove(n)
        em = nt.nodes.new('ShaderNodeEmission')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(tex.outputs['Color'], em.inputs['Color'])
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])


def set_mat_emission(name, strength):
    for m in bpy.data.materials:
        if m.name.split('.')[0] == name and m.use_nodes:
            b = m.node_tree.nodes.get('Principled BSDF')
            if b:
                b.inputs['Emission Strength'].default_value = strength


def preview_world(night):
    sc = bpy.context.scene
    w = bpy.data.worlds.new('PreviewWorld')
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    bgA = nt.nodes.new('ShaderNodeBackground')
    bgB = nt.nodes.new('ShaderNodeBackground')
    if night:
        bgA.inputs['Color'].default_value = (0.05, 0.075, 0.16, 1)
        bgA.inputs['Strength'].default_value = 0.55
        bgB.inputs['Color'].default_value = hexcol('#0D1320')
    else:
        bgA.inputs['Color'].default_value = (0.86, 0.87, 0.90, 1)
        bgA.inputs['Strength'].default_value = 0.62
        bgB.inputs['Color'].default_value = hexcol('#F1F1F3')
    bgB.inputs['Strength'].default_value = 1.0
    lp = nt.nodes.new('ShaderNodeLightPath')
    mix = nt.nodes.new('ShaderNodeMixShader')
    outn = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs['Fac'])
    nt.links.new(bgA.outputs['Background'], mix.inputs[1])
    nt.links.new(bgB.outputs['Background'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], outn.inputs['Surface'])


def dummies():
    cols = ['#FF7A59', '#2F6BFF', '#F0A6C8', '#3FB8A5', '#222222', '#F5B000']
    k = 0
    for o in list(bpy.data.objects):
        if o.type == 'EMPTY' and (o.name.startswith('desk_') or o.name.startswith('lounge_')) and o.name.count('.') == 0:
            if o.hide_render:
                continue
            x, y, z = world_pos(o)
            mb = MB()
            m = mat('dummy%d' % (k % 6), cols[k % 6], 0.3)
            mb.uvs((0, 0.3, 0), (0.3, 0.3, 0.3), m, seg=20, rings=12)
            q = o.matrix_world.to_quaternion()
            ob = mb.build('dummy_' + o.name, (x, y, z))
            ob.rotation_mode = 'QUATERNION'
            ob.rotation_quaternion = q
            k += 1


def render_to(path, res, samples, pts, target):
    sc = bpy.context.scene
    bo.setup_cycles(samples)
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    cam = bo.iso_camera(res, target=target)
    bo.fit_camera(cam, pts, res, 1.05)
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('preview ->', path)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bo.COL = None
    bo.MATS.clear()


def load_glb():
    reset_scene()
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=GLB)
    return {o.name: o for o in bpy.data.objects if o not in before and o.parent is None}


def light_day():
    sc = bpy.context.scene
    preview_world(False)
    bo.add_sun('PreviewSun', (4, -8, 3), 2.6, (1.0, 0.95, 0.88), 3.0)
    for n in ('night_screen', 'night_lamp', 'night_windows'):
        set_mat_emission(n, 0.0)


def light_night(lamps):
    sc = bpy.context.scene
    preview_world(True)
    for k, (x, y, z) in enumerate(lamps):
        ld = bpy.data.lights.new('pl%d' % k, 'POINT')
        ld.energy = LAMP_W
        ld.color = (1.0, 0.72, 0.44)
        ld.shadow_soft_size = 0.06
        lo = bpy.data.objects.new('pl%d' % k, ld)
        sc.collection.objects.link(lo)
        lo.location = B(x, y + 0.02, z)
    set_mat_emission('night_screen', 5.0)
    set_mat_emission('night_lamp', 7.0)
    set_mat_emission('night_windows', 2.2)


def render_close():
    """debug: render a close-up from the exported GLB.  args: close=x,y,z,scale  [night]  [out=path]  [res=W,H]"""
    spec = [a for a in ARGV if a.startswith('close=')][0][6:]
    x, y, z, scl = [float(v) for v in spec.split(',')]
    night = 'night' in ARGV
    out = next((a[4:] for a in ARGV if a.startswith('out=')), os.path.join(TMP, 'close.png'))
    res = tuple(int(v) for v in next((a[4:] for a in ARGV if a.startswith('res=')), '1400,900').split(','))
    roots = load_glb()
    for n in ('floor_closed', 'roof', 'elevator_shaft', 'elevator_cabin'):
        hide_tree(roots[n])
    unlit_baked(night)
    bpy.context.view_layer.update()
    if 'dummies' in ARGV:
        dummies()
    if night:
        light_night([world_pos(o) for o in bpy.data.objects if o.name.startswith('lamp_')])
    else:
        light_day()
    sc = bpy.context.scene
    bo.setup_cycles(40 if QUICK else 128)
    sc.view_settings.view_transform = 'Standard'
    cam = bo.iso_camera(res, target=(x, y, z))
    cam.data.ortho_scale = scl
    cam.data.shift_x = 0
    cam.data.shift_y = 0
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.image_settings.file_format = 'PNG'
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print('closeup ->', out)


def render_previews():
    res = (1800, 1125)
    spl = 40 if QUICK else 160
    pts_open = [(x, y, z) for x in (-8.3, 8.3) for y in (-0.4, 2.9) for z in (-6.3, 6.3)]
    for night in (False, True):
        roots = load_glb()
        for n in ('floor_closed', 'roof', 'elevator_shaft', 'elevator_cabin'):
            hide_tree(roots[n])
        unlit_baked(night)
        bpy.context.view_layer.update()
        dummies()
        if night:
            lamps = [world_pos(o) for o in bpy.data.objects if o.name.startswith('lamp_')]
            light_night(lamps)
        else:
            light_day()
        render_to(os.path.join(OUT, 'preview-night.png' if night else 'preview-day.png'), res, spl, pts_open, (0, 0.6, 0))
    # stack previews: closed floors + open floor + elevator (night), all closed + roof (day)
    for night, cfg in ((True, 'open'), (False, 'closed')):
        roots = load_glb()
        fo, fc, rf, sh, cb = (roots[n] for n in ('floor_open', 'floor_closed', 'roof', 'elevator_shaft', 'elevator_cabin'))
        for r in (fo, fc, rf, sh, cb):
            hide_tree(r, False)
        unlit_baked(night)
        top = 4 if cfg == 'open' else 5
        for k in range(1, top):
            clone_tree(fc, (0, (k - 1) * STEP, 0))
        hide_tree(fc)
        if cfg == 'open':
            fo.location = Vector(B(0, 3 * STEP, 0))
            hide_tree(rf)
            hgt = 4 * STEP
            hide_tree(sh)
            hide_tree(cb)
            shn = clone_tree(sh, (0, 0, 0), scale_y=hgt)
            cbn = clone_tree(cb, (0, 3 * STEP, 0))
            for o in (shn, cbn):
                hide_tree(o, False)
        else:
            hide_tree(fo)
            rf.location = Vector(B(0, 3 * STEP + BAND, 0))
            hide_tree(sh)
            hide_tree(cb)
            shn = clone_tree(sh, (0, 0, 0), scale_y=3 * STEP + BAND)
            cbn = clone_tree(cb, (0, 1 * STEP, 0))
            for o in (shn, cbn):
                hide_tree(o, False)
        if night:
            bpy.context.view_layer.update()
            lamps = [world_pos(o) for o in bpy.data.objects if o.name.startswith('lamp_') and not o.hide_render]
            light_night(lamps)
        else:
            light_day()
        pts = [(x, y, z) for x in (-8.3, 9.9) for y in (-3.0, 8.0) for z in (-6.3, 6.3)]
        render_to(os.path.join(OUT, 'preview-stack-%s.png' % ('night' if night else 'day')), (1500, 1500), spl, pts, (0.5, 2.2, 0))


# ------------------------------------------------------------------ MAIN
def main():
    t0 = time.time()
    reset_scene()
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    bo.setup_cycles(64)
    sc.view_settings.view_transform = 'Standard'
    make_materials()
    roots = {n: new_root(n) for n in ('floor_open', 'floor_closed', 'roof')}
    roots['elevator_shaft'] = new_root('elevator_shaft', (SHAFT_C[0], 0, SHAFT_C[1]))
    roots['elevator_cabin'] = new_root('elevator_cabin', (SHAFT_C[0], 0, SHAFT_C[1]))
    fl, wl, st = build_open(roots['floor_open'])
    for ob in (fl, wl, st):
        ob.parent = roots['floor_open']
    baked = [
        (fl, COLORS['floorstone'], stone_albedo, (2048, 1536), (4096, 3072), (3072, 2304), 1.22),
        (wl, COLORS['wall'], flat_albedo(COLORS['wall'], 6), (2048, 512), (3072, 704), (2048, 512), 1.25),
        (st, COLORS['slab'], flat_albedo(COLORS['slab'], 7, 0.004), (1024, 768), (1024, 768), (1024, 768), 1.0),
    ]
    baked_out = run_bakes(baked, QUICK)
    # final materials + night JPGs
    for (ob, *_r) in baked:
        p = baked_out[ob.name]
        mfin, img = bo.final_material(ob.name, p['day'])
        ob.data.materials.clear()
        ob.data.materials.append(mfin)
        shutil.copyfile(p['night'], os.path.join(NIGHT, ob.name + '.jpg'))
    clear_lights()
    # remaining roots (they do not affect the bake)
    build_closed(roots['floor_closed'])
    build_roof(roots['roof'])
    build_shaft(roots['elevator_shaft'])
    build_cabin(roots['elevator_cabin'])
    for n in ('night_screen', 'night_lamp'):
        set_emission(n, 1.0)
    export_glb(GLB)
    patch_glb(GLB)
    print('exported', GLB, os.path.getsize(GLB) // 1024, 'KB; total script time %.1f s' % (time.time() - t0))
    if 'nopreview' not in ARGV:
        render_previews()


if any(a.startswith('close=') for a in ARGV):
    render_close()
elif 'preview' in ARGV:
    render_previews()
else:
    main()
