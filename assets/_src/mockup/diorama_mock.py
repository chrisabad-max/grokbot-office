# Mockup render: "building diorama" direction (Apple-like, light, airy).
# blender -b --factory-startup -P diorama_mock.py -- lib [quick]
import bpy, sys, os, math, json
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(HERE, '..', 'office'))
import build_office as bo                      # 'lib' stage: helpers only
from build_office import B, MB, mat, hexcol

QUICK = 'quick' in sys.argv
OUT = os.path.join(ROOT, 'mockups', 'diorama')
os.makedirs(OUT, exist_ok=True)
BLOBS = os.path.join(ROOT, 'assets', 'blobs')

C = dict(floor='#DAD3C7', slab='#F8F7F4', wall='#F4F2EE', oak='#D7BC93', black='#1C1C1E', graphite='#3A3A3C',
         alu='#CFCFD2', fabric='#E2DFDA', fabric2='#C9C5BE', rug='#D3CDC3', glass='#2C3440', mull='#D9DADD',
         leaf1='#4F7A45', leaf2='#6B925A', leaf3='#3E6538', pot='#F1EFEB', screen='#141A22')
M = {k: mat('mk_' + k, v, 0.6) for k, v in C.items()}
M['oak'] = mat('mk_oak2', C['oak'], 0.45)
M['black'] = mat('mk_black2', C['black'], 0.35)
M['alu'] = mat('mk_alu2', C['alu'], 0.3, metal=0.8)
M['glass'] = mat('mk_glass2', C['glass'], 0.06, spec=0.9)
M['pane'] = mat('mk_pane', '#DDE7EE', 0.02, alpha=0.08, spec=0.6)
M['fabric'] = mat('mk_fab2', C['fabric'], 0.95)
M['fabric2'] = mat('mk_fab3', C['fabric2'], 0.95)
M['rug'] = mat('mk_rug2', C['rug'], 1.0)


def emit_mat(name, hexc, strength):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = hexcol('#000000')
    b.inputs['Emission Color'].default_value = hexcol(hexc)
    b.inputs['Emission Strength'].default_value = strength
    return m


def glow_mat(name, hexc, strength=3.0, radius=0.62):
    """soft radial glow disc: emission fading to transparent"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (1 / radius, 1 / radius, 1 / radius)
    gr = nt.nodes.new('ShaderNodeTexGradient')
    gr.gradient_type = 'SPHERICAL'
    pw = nt.nodes.new('ShaderNodeMath')
    pw.operation = 'POWER'
    pw.inputs[1].default_value = 1.6
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = hexcol(hexc)
    em.inputs['Strength'].default_value = strength
    mx = nt.nodes.new('ShaderNodeMixShader')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
    nt.links.new(mp.outputs['Vector'], gr.inputs['Vector'])
    nt.links.new(gr.outputs['Fac'], pw.inputs[0])
    nt.links.new(pw.outputs['Value'], mx.inputs['Fac'])
    nt.links.new(tr.outputs['BSDF'], mx.inputs[1])
    nt.links.new(em.outputs['Emission'], mx.inputs[2])
    nt.links.new(mx.outputs['Shader'], out.inputs['Surface'])
    return m


# ------------------------------------------------------------------ building
FH = 1.5          # compressed height of the closed floors below
SL = 0.36         # slab thickness


def building():
    b = MB()
    b.box((0, -SL / 2, 0), (16.4, SL, 12.4), M['slab'], bevel=0.05)          # active floor slab
    b.box((0, 0.006, 0), (15.9, 0.012, 11.9), M['floor'])                      # floor finish, inset
    for i in range(3):
        top = -SL - i * FH
        b.box((0, top - (FH - SL) / 2, 0), (15.7, FH - SL, 11.7), M['glass'])            # glass band
        b.box((0, top - FH + SL / 2, 0), (16.4, SL, 12.4), M['slab'], bevel=0.05)        # slab under it
        for k in range(17):                                                                # mullions, +z face
            x = -7.8 + k * (15.6 / 16)
            b.box((x, top - (FH - SL) / 2, 5.86), (0.05, FH - SL, 0.04), M['mull'])
        for k in range(13):                                                                # mullions, +x face
            z = -5.8 + k * (11.6 / 12)
            b.box((7.86, top - (FH - SL) / 2, z), (0.04, FH - SL, 0.05), M['mull'])
    b.build('building')
    return -SL - 3 * FH


WH = 2.7


def walls():
    w = MB()
    # left wall: solid, white plaster
    w.box((-8.0, WH / 2, 0), (0.2, WH, 12.0), M['wall'], bevel=0.02)
    # back wall: glass curtain wall with slim dark mullions
    w.box((0, WH - 0.04, -6.0), (16.0, 0.08, 0.12), M['black'])
    w.box((0, 0.04, -6.0), (16.0, 0.08, 0.12), M['black'])
    for k in range(9):
        x = -7.9 + k * (15.8 / 8)
        w.box((x, WH / 2, -6.0), (0.06, WH, 0.1), M['black'])
    w.build('walls')
    g = MB()
    g.box((0, WH / 2, -6.0), (15.8, WH - 0.16, 0.01), M['pane'])
    g.build('glass_back')
    # wall display (left wall): dark screen + soft chart bars
    s = MB()
    s.box((-7.87, 1.55, -1.6), (0.05, 1.5, 2.7), M['black'], bevel=0.02)
    s.build('display')
    scr = emit_mat('mk_scr', '#1B2533', 1.0)
    sc = MB()
    sc.box((-7.84, 1.55, -1.6), (0.01, 1.38, 2.58), scr)
    sc.build('display_screen')
    bars = [('#34C759', 0.55), ('#34C759', 0.8), ('#FFB020', 0.4), ('#34C759', 0.95), ('#34C759', 0.7), ('#FF453A', 0.3), ('#34C759', 0.85)]
    for i, (col, h) in enumerate(bars):
        bb = MB()
        bb.box((-7.83, 1.0 + h * 0.5 * 1.05, -2.6 + i * 0.33), (0.008, h * 1.05, 0.16), emit_mat('mk_bar%d' % i, col, 2.2))
        bb.build('bar%d' % i)


# ------------------------------------------------------------------ desks
TABLES = [(-2.3, -2.7), (-2.3, 1.5)]        # centre x, centre z (long axis along x)
SEATX = [-5.7, -4.0, -2.3, -0.6, 1.1]
SEAT_D = 1.2
POUF_H = 0.42


def table(cx, cz):
    t = MB()
    t.box((0, 0.725, 0), (9.0, 0.05, 1.4), M['oak'], bevel=0.015)
    for x in (-4.1, 0.0, 4.1):
        for z in (-0.55, 0.55):
            t.box((x, 0.35, z), (0.05, 0.70, 0.05), M['black'])
        t.box((x, 0.68, 0), (0.05, 0.04, 1.16), M['black'])
    t.build('table_%g' % cz, (cx, 0, cz))


def laptop(name, x, z, facing):
    """facing: +1 = screen faces -z (user sits at -z side, looks to +z) ... the user is on the far side"""
    l = MB()
    l.box((0, 0.757, 0), (0.36, 0.014, 0.25), M['alu'], bevel=0.004)
    tilt = 0.28 * facing
    l.box((0, 0.757 + 0.115, 0.125 * facing + 0.02 * facing), (0.36, 0.23, 0.008), M['alu'], bevel=0.003, rot=(tilt, 0, 0))
    l.build(name, (x, 0, z))


def pouf(name, x, z, m):
    p = MB()
    p.cyl((0, POUF_H / 2, 0), 0.27, 0.27, POUF_H, m, seg=40)
    p.build(name, (x, 0, z))


def mug(name, x, z):
    p = MB()
    p.cyl((0, 0.75 + 0.05, 0), 0.04, 0.04, 0.1, M['pot'], seg=20)
    p.build(name, (x, 0, z))


SEATS = []


def desks():
    for ti, (cx, cz) in enumerate(TABLES):
        table(cx, cz)
        for si, sx in enumerate(SEATX):
            x = cx + sx + 2.3
            for side in (-1, 1):                   # -1 = far side (faces +z, towards camera)
                z = cz + side * SEAT_D
                SEATS.append(dict(x=x, z=z, side=side))
                pouf('pouf_%d_%d_%d' % (ti, si, side), x, z, M['fabric'] if (si + ti) % 2 else M['fabric2'])
                laptop('lap_%d_%d_%d' % (ti, si, side), x, cz + side * 0.32, -side)
                if (si * 3 + ti + side) % 4 == 0:
                    mug('mug_%d_%d_%d' % (ti, si, side), x + 0.32, cz + side * 0.36)


# ------------------------------------------------------------------ lounge + coffee bar
SOFA = dict(x=5.3, z=0.6)


def lounge():
    r = MB()
    r.cyl((0, 0.008, 0), 2.2, 2.2, 0.016, M['rug'], seg=64)
    r.build('rug', (5.3, 0, 2.3))
    s = MB()                                         # modern block sofa facing +z
    s.box((0, 0.2, 0), (3.2, 0.24, 0.95), M['fabric2'], bevel=0.05)
    s.box((0, 0.38, 0.08), (3.0, 0.14, 0.78), M['fabric'], bevel=0.06)
    s.box((0, 0.6, -0.38), (3.2, 0.62, 0.22), M['fabric2'], bevel=0.08)
    for x in (-1.5, 1.5):
        s.box((x, 0.42, 0), (0.22, 0.5, 0.95), M['fabric2'], bevel=0.07)
    for x in (-1.45, 1.45):
        for z in (-0.38, 0.38):
            s.box((x, 0.04, z), (0.05, 0.08, 0.05), M['black'])
    s.build('sofa', (SOFA['x'], 0, SOFA['z']))
    c = MB()                                         # coffee table
    c.cyl((0, 0.36, 0), 0.55, 0.55, 0.04, M['oak'], seg=48)
    c.cyl((0, 0.17, 0), 0.05, 0.05, 0.34, M['black'], seg=16)
    c.cyl((0, 0.01, 0), 0.25, 0.25, 0.02, M['black'], seg=32)
    c.build('coffee_table', (5.3, 0, 2.4))
    a = MB()                                         # two armchairs facing the sofa (-z)
    a.box((0, 0.22, 0), (0.95, 0.3, 0.9), M['black'], bevel=0.06)
    a.box((0, 0.42, 0.05), (0.8, 0.12, 0.72), M['graphite'], bevel=0.05)
    a.box((0, 0.6, 0.38), (0.95, 0.5, 0.16), M['black'], bevel=0.06)
    a.build('arm1', (4.2, 0, 4.0), math.radians(20))
    a2 = MB()
    a2.box((0, 0.22, 0), (0.95, 0.3, 0.9), M['black'], bevel=0.06)
    a2.box((0, 0.42, 0.05), (0.8, 0.12, 0.72), M['graphite'], bevel=0.05)
    a2.box((0, 0.6, 0.38), (0.95, 0.5, 0.16), M['black'], bevel=0.06)
    a2.build('arm2', (6.4, 0, 4.0), math.radians(-20))
    # coffee bar along the glass
    k = MB()
    k.box((0, 0.45, 0), (3.4, 0.9, 0.8), M['slab'], bevel=0.02)
    k.box((0, 0.92, 0), (3.5, 0.04, 0.86), M['oak'], bevel=0.01)
    k.cyl((-1.0, 1.05, 0), 0.11, 0.11, 0.22, M['black'], seg=24)
    k.cyl((-0.6, 0.99, 0.1), 0.045, 0.045, 0.1, M['pot'], seg=16)
    k.build('bar', (4.6, 0, -5.1))
    for i, x in enumerate((3.4, 4.6, 5.8)):
        st = MB()
        st.cyl((0, 0.66, 0), 0.19, 0.19, 0.05, M['oak'], seg=32)
        st.cyl((0, 0.33, 0), 0.025, 0.025, 0.64, M['black'], seg=12)
        st.cyl((0, 0.01, 0), 0.17, 0.17, 0.02, M['black'], seg=24)
        st.build('stool%d' % i, (x, 0, -4.15))


def tree(name, x, z, s=1.0, seed=3):
    import random
    rng = random.Random(seed)
    t = MB()
    t.cyl((0, 0.32 * s, 0), 0.34 * s, 0.28 * s, 0.64 * s, M['pot'], seg=40)
    t.cyl((0, 1.05 * s, 0), 0.035 * s, 0.05 * s, 0.9 * s, mat('mk_trunk', '#6B5A48', 0.8), seg=10)
    greens = [mat('mk_l1', C['leaf1'], 0.55), mat('mk_l2', C['leaf2'], 0.55), mat('mk_l3', C['leaf3'], 0.55)]
    for i in range(14):
        a = rng.uniform(0, 6.283)
        r = rng.uniform(0.05, 0.45) * s
        y = rng.uniform(1.45, 2.15) * s
        k = rng.uniform(0.22, 0.34) * s
        t.ell((math.cos(a) * r, y, math.sin(a) * r), (k, k * 0.8, k), greens[i % 3], sub=2)
    t.build(name, (x, 0, z))


# ------------------------------------------------------------------ blobs
BOTS = [  # (id, seat|('sofa', dx), status)
    ('codila-x-researcher', (0, 0, -1), 'working'),
    ('x-writer', (0, 1, -1), 'working'),
    ('analytics-analyst', (0, 2, -1), 'waiting_user'),
    ('banner-visuals', (0, 3, -1), 'working'),
    ('competitor-watch', (0, 4, -1), 'working'),
    ('bookmarks-brain', (1, 1, -1), 'working'),
    ('ideas-sparring', (1, 3, -1), 'error'),
    ('qt-scout', ('sofa', -0.75), 'idle'),
    ('trendy-x', ('sofa', 0.75), 'idle'),
]
GLOW = {'waiting_user': '#FFB020', 'error': '#FF453A'}
BLOB_H = 1.0


def place_blob(bid, x, y, z, yaw):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(BLOBS, bid + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ v.co for o in new if o.type == 'MESH' for v in o.data.vertices]
    zmin = min(p.z for p in pts)
    h = max(p.z for p in pts) - zmin
    cx = (max(p.x for p in pts) + min(p.x for p in pts)) / 2
    cy = (max(p.y for p in pts) + min(p.y for p in pts)) / 2
    piv = bpy.data.objects.new('bot_' + bid, None)
    bpy.context.scene.collection.objects.link(piv)
    for r in [o for o in new if o.parent is None]:
        r.parent = piv
        r.location -= Vector((cx, cy, zmin))
    s = BLOB_H / h
    piv.scale = (s, s, s)
    piv.location = B(x, y, z)
    piv.rotation_euler = (0, 0, yaw)
    return piv


def blobs():
    out = {}
    for bid, seat, status in BOTS:
        if seat[0] == 'sofa':
            x, y, z, yaw = SOFA['x'] + seat[1], 0.45, SOFA['z'] + 0.05, 0.3
        else:
            ti, si, side = seat
            cx, cz = TABLES[ti]
            x, y, z = cx + SEATX[si] + 2.3, POUF_H, cz + side * SEAT_D
            yaw = 0.32 if side < 0 else math.pi - 0.32
        place_blob(bid, x, y, z, yaw)
        if status in GLOW:
            g = MB()
            g.cyl((0, 0.02, 0), 0.62, 0.62, 0.002, glow_mat('glow_' + bid, GLOW[status]), seg=48)
            g.build('glow_' + bid, (x, 0, z))
        out[bid] = dict(x=x, y=y + BLOB_H, z=z, status=status)
    return out


# ------------------------------------------------------------------ main
def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    global M
    # factory reset dropped the materials created at import time: rebuild them
    bo.MATS.clear()
    M.clear()
    M.update({k: mat('mk_' + k, v, 0.6) for k, v in C.items()})
    M['floor'] = mat('mk_floor2', C['floor'], 0.38, spec=0.6)
    M['oak'] = mat('mk_oak2', C['oak'], 0.45)
    M['black'] = mat('mk_black2', C['black'], 0.35)
    M['alu'] = mat('mk_alu2', C['alu'], 0.3, metal=0.8)
    M['glass'] = mat('mk_glass2', C['glass'], 0.06, spec=0.9)
    M['pane'] = mat('mk_pane', '#DDE7EE', 0.02, alpha=0.08, spec=0.6)
    M['fabric'] = mat('mk_fab2', C['fabric'], 0.95)
    M['fabric2'] = mat('mk_fab3', C['fabric2'], 0.95)
    M['rug'] = mat('mk_rug2', C['rug'], 1.0)
    bo.COL = None
    sc = bpy.context.scene
    bo.setup_cycles(32 if QUICK else 160)
    ground = building()
    walls()
    desks()
    lounge()
    tree('tree1', 7.1, -1.6, 1.25, 3)
    tree('tree2', -7.0, 5.0, 1.0, 7)
    tree('tree3', 2.9, -5.3, 0.8, 11)
    bots = blobs()
    # shadow catcher ground
    gp = MB()
    gp.box((0, ground - 0.01, 0), (120, 0.02, 120), M['slab'])
    g = gp.build('ground')
    g.is_shadow_catcher = True
    # light: soft sky + low warm sun from the back-left, through the glass wall
    bo.set_world((0.74, 0.81, 0.93), 0.38)
    bo.add_sun('Sun', (0.62, -0.55, 0.56), 6.0, (1.0, 0.88, 0.74), 2.0)
    sc.render.film_transparent = True
    try:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except Exception as e:
        print('view transform', e)
    sc.view_settings.exposure = 0.1
    res = (2400, 1500)
    cam = bo.iso_camera(res, target=(0, 0.6, 0))
    pts = [(x, y, z) for x in (-8.3, 8.3) for y in (-3.3, 2.8) for z in (-6.3, 6.3)]
    bo.fit_camera(cam, pts, res, 1.06)
    cam.data.shift_x += 0.035
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.filepath = os.path.join(OUT, 'scene.png')
    bpy.context.view_layer.update()
    marks = {}
    for bid, d in bots.items():
        u = world_to_camera_view(sc, cam, B(d['x'], d['y'], d['z']))
        f = world_to_camera_view(sc, cam, B(d['x'], d['y'] - BLOB_H, d['z']))
        marks[bid] = dict(u=round(u.x, 4), v=round(1 - u.y, 4), fu=round(f.x, 4), fv=round(1 - f.y, 4), status=d['status'])
    with open(os.path.join(OUT, 'marks.json'), 'w') as fh:
        json.dump(marks, fh, indent=1)
    bpy.ops.render.render(write_still=True)
    print('render ->', sc.render.filepath)


main()
