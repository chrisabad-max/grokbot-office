# Contract check for assets/office/office.glb (v2.4): parses the glTF JSON + binary with the stdlib only.
#   python assets/_src/office/check_building.py [path/to/office.glb]
# Exit code 0 = all assertions passed.
import json, math, os, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '..', '..'))
GLB = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ASSETS, 'office', 'office.glb')
NIGHT = os.path.join(os.path.dirname(GLB), 'night')

FAILS = []


def check(cond, msg):
    print(('PASS  ' if cond else 'FAIL  ') + msg)
    if not cond:
        FAILS.append(msg)
    return cond


def near(a, b, tol):
    return abs(a - b) <= tol


# ------------------------------------------------------------------ load
data = open(GLB, 'rb').read()
magic, ver, total = struct.unpack('<4sII', data[:12])
jl, jt = struct.unpack('<II', data[12:20])
js = json.loads(data[20:20 + jl].decode('utf8'))
off = 20 + jl
bl, bt = struct.unpack('<II', data[off:off + 8])
BIN = data[off + 8:off + 8 + bl]
nodes = js['nodes']
meshes = js['meshes']
mats = js.get('materials', [])
acc = js['accessors']
bvs = js['bufferViews']
check(magic == b'glTF' and ver == 2, 'GLB header is glTF 2')

parent = {}
for i, n in enumerate(nodes):
    for c in n.get('children', []):
        parent[c] = i
by_name = {}
for i, n in enumerate(nodes):
    by_name.setdefault(n.get('name'), []).append(i)


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def local_m(n):
    if 'matrix' in n:
        m = n['matrix']
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = n.get('translation', [0, 0, 0])
    x, y, z, w = n.get('rotation', [0, 0, 0, 1])
    s = n.get('scale', [1, 1, 1])
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[0][0] * s[0], r[0][1] * s[1], r[0][2] * s[2], t[0]],
            [r[1][0] * s[0], r[1][1] * s[1], r[1][2] * s[2], t[1]],
            [r[2][0] * s[0], r[2][1] * s[1], r[2][2] * s[2], t[2]],
            [0, 0, 0, 1]]


_wm = {}


def world_m(i):
    if i not in _wm:
        m = local_m(nodes[i])
        _wm[i] = mat_mul(world_m(parent[i]), m) if i in parent else m
    return _wm[i]


def apply(m, p):
    return [m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3] for r in range(3)]


def rot_vec(m, v):
    out = [m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2] for r in range(3)]
    ln = math.sqrt(sum(c * c for c in out)) or 1.0
    return [c / ln for c in out]


def read_acc(ai):
    a = acc[ai]
    bv = bvs[a['bufferView']]
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    ncomp = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    fmt = {5126: 'f', 5123: 'H', 5125: 'I', 5121: 'B'}[a['componentType']]
    size = struct.calcsize(fmt)
    stride = bv.get('byteStride') or size * ncomp
    out = []
    for k in range(a['count']):
        o = base + k * stride
        out.append(struct.unpack_from('<' + fmt * ncomp, BIN, o))
    return out


def mesh_nodes():
    return [i for i, n in enumerate(nodes) if 'mesh' in n]


def descendants(i):
    out = []
    for c in nodes[i].get('children', []):
        out.append(c)
        out += descendants(c)
    return out


def verts_world(i):
    m = world_m(i)
    pts = []
    for pr in meshes[nodes[i]['mesh']]['primitives']:
        for p in read_acc(pr['attributes']['POSITION']):
            pts.append(apply(m, p))
    return pts


def bbox(pts):
    return [min(p[k] for p in pts) for k in range(3)], [max(p[k] for p in pts) for k in range(3)]


def bbox_of_root(i, only_mesh=None):
    pts = []
    for d in [i] + descendants(i):
        if 'mesh' in nodes[d] and (only_mesh is None or only_mesh(nodes[d])):
            pts += verts_world(d)
    return bbox(pts)


def tris_of(i):
    t = 0
    for pr in meshes[nodes[i]['mesh']]['primitives']:
        t += (acc[pr['indices']]['count'] if 'indices' in pr else acc[pr['attributes']['POSITION']]['count']) // 3
    return t


def mat_name(pr):
    return mats[pr['material']].get('name') if 'material' in pr else None


def jpeg_size(path):
    d = open(path, 'rb').read()
    i = 2
    while i < len(d):
        if d[i] != 0xFF:
            i += 1
            continue
        mk = d[i + 1]
        if mk in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack('>HH', d[i + 5:i + 9])
            return w, h
        ln = struct.unpack('>H', d[i + 2:i + 4])[0]
        i += 2 + ln
    return None


# ------------------------------------------------------------------ structure
scene_roots = js['scenes'][js.get('scene', 0)]['nodes']
root_names = [nodes[i].get('name') for i in scene_roots]
ROOTS = ['floor_open', 'floor_closed', 'roof', 'elevator_shaft', 'elevator_cabin']
for r in ROOTS:
    check(r in root_names, 'root node %s exists at scene top level' % r)
    check(len(by_name.get(r, [])) == 1 and bool(nodes[by_name[r][0]].get('children')) if r in by_name else False, 'root %s has children' % r)
fo = by_name['floor_open'][0]
fc = by_name['floor_closed'][0]
rf = by_name['roof'][0]
sh = by_name['elevator_shaft'][0]
cb = by_name['elevator_cabin'][0]
fo_desc = set(descendants(fo))


def under_fo(name):
    ids = by_name.get(name, [])
    return len(ids) == 1 and ids[0] in fo_desc


for g, cnt in (('desk', 20), ('screen', 20), ('lounge', 6), ('lamp', 6), ('laptop_screen', 20)):
    names = ['%s_%02d' % (g, k) for k in range(1, cnt + 1)]
    check(all(under_fo(n) for n in names), '%s_01..%02d all present (once) under floor_open' % (g, cnt))
for n in ('wall_screen', 'task_board', 'baked_floor', 'baked_wall_left', 'baked_slab_top'):
    check(under_fo(n), 'mesh %s under floor_open' % n)
for n in ('desk_01', 'screen_01', 'lounge_01', 'lamp_01'):
    check('mesh' not in nodes[by_name[n][0]], '%s is an empty (no mesh)' % n)
check(not any((n.get('name') or '').lower().startswith(('dummy', 'bot_', 'blob')) for n in nodes), 'no placeholder blobs / per-bot props in the GLB')

# ------------------------------------------------------------------ materials
mat_by = {m.get('name'): m for m in mats}
for n in ('night_lamp', 'night_windows', 'night_screen'):
    check(n in mat_by, 'material %s exists' % n)
    m = mat_by.get(n, {})
    ef = m.get('emissiveFactor', [0, 0, 0])
    check(max(ef) > 0.05, '%s: emissiveFactor non-zero %s (scene ramps emissiveIntensity)' % (n, [round(c, 2) for c in ef]))
check('emissiveTexture' in mat_by.get('night_windows', {}), 'night_windows has an emissive map (warm window pattern)')
for pr_node in [by_name['laptop_screen_%02d' % k][0] for k in range(1, 21)]:
    pm = [mat_name(p) for p in meshes[nodes[pr_node]['mesh']]['primitives']]
    if pm != ['night_screen']:
        check(False, 'laptop_screen mesh uses night_screen (got %s)' % pm)
        break
else:
    check(True, 'all 20 laptop_screen_NN use material night_screen')
glass = [m for m in mats if (m.get('name') or '').startswith('glass')]
check(len(glass) >= 3 and all(m.get('alphaMode') == 'BLEND' and m.get('doubleSided') for m in glass),
      'glass materials %s export with alphaMode BLEND + doubleSided' % [m['name'] for m in glass])
for n in ('baked_floor', 'baked_wall_left', 'baked_slab_top'):
    m = mat_by.get(n, {})
    check('KHR_materials_unlit' in m.get('extensions', {}) and 'baseColorTexture' in m.get('pbrMetallicRoughness', {}),
          '%s: unlit + day lightmap embedded' % n)
    mi = by_name[n][0]
    pr = meshes[nodes[mi]['mesh']]['primitives'][0]
    check('TEXCOORD_0' in pr['attributes'], '%s has UVs' % n)
    nj = os.path.join(NIGHT, n + '.jpg')
    check(os.path.exists(nj), 'night lightmap %s exists' % os.path.relpath(nj, os.path.dirname(GLB)))
    if os.path.exists(nj):
        print('      %s night jpg %s, %d KB' % (n, jpeg_size(nj), os.path.getsize(nj) // 1024))

# ------------------------------------------------------------------ desks / seats
tables = {1: -2.7, 2: 1.5}
dp = {}
for k in range(1, 21):
    i = by_name['desk_%02d' % k][0]
    m = world_m(i)
    dp[k] = (apply(m, [0, 0, 0]), rot_vec(m, [0, 0, 1]))
ok_face = all((dp[k][1][2] > 0.99) == (k % 2 == 1) and abs(dp[k][1][2]) > 0.99 for k in dp)
check(ok_face, 'desk facing: +Z of odd desks -> +Z (far side), even desks -> -Z')
ok_tab = all(abs(dp[k][0][2] - tables[1 if k <= 10 else 2]) < 1.3 for k in dp)
check(ok_tab, 'desks 01-10 sit at table 1, 11-20 at table 2')
ok_far = all(dp[k][0][2] < dp[k + 1][0][2] for k in range(1, 20, 2))
check(ok_far, 'odd desk is the far-side (smaller z) seat of its pair')
ok_cols = all(dp[k][0][0] < dp[k + 2][0][0] for k in list(range(1, 9)) + list(range(11, 19)))
check(ok_cols, 'columns run left -> right (x increases) on both tables')
check(all(near(dp[k][0][1], 0.42, 0.02) for k in dp), 'desk empties at pouf-top height y = 0.42')
check(all(-7 <= dp[k][0][0] <= 3 and -4.5 <= dp[k][0][2] <= 4 for k in dp), 'desks inside the work zone x[-7,3] z[-4.5,4]')
check(len({(round(dp[k][0][0], 2), round(dp[k][0][2], 2)) for k in dp}) == 20, '20 distinct seat positions')
# screens
ok_scr = True
ok_dir = True
for k in range(1, 21):
    si = by_name['screen_%02d' % k][0]
    ls = by_name['laptop_screen_%02d' % k][0]
    sp = apply(world_m(si), [0, 0, 0])
    lb = bbox(verts_world(ls))
    c = [(lb[0][j] + lb[1][j]) / 2 for j in range(3)]
    if max(abs(sp[j] - c[j]) for j in range(3)) > 0.01:
        ok_scr = False
    n = rot_vec(world_m(ls), [0, 0, 1])
    # the screen face must look at the seat: opposite to the blob's facing direction (horizontal part)
    if n[2] * dp[k][1][2] > -0.5:
        ok_dir = False
    # screen is in front of its seat, near the table edge, at laptop height
    if not (0.75 < sp[1] < 1.1) or abs(sp[2] - dp[k][0][2]) > 1.4 or abs(sp[0] - dp[k][0][0]) > 0.05:
        ok_dir = False
check(ok_scr, 'screen_NN empty sits at the centre of laptop_screen_NN')
check(ok_dir, 'screens face their seat, sit 0.75-1.1 m high in front of it')
# lounge
for k in range(1, 7):
    p = apply(world_m(by_name['lounge_%02d' % k][0]), [0, 0, 0])
    f = rot_vec(world_m(by_name['lounge_%02d' % k][0]), [0, 0, 1])
    print('      lounge_%02d at (%.2f, %.2f, %.2f) facing (%.2f, %.2f, %.2f)' % (k, *p, *f))
lp = [apply(world_m(by_name['lounge_%02d' % k][0]), [0, 0, 0]) for k in range(1, 7)]
check(all(0.3 < p[1] < 0.8 for p in lp) and all(p[0] > 3 for p in lp[:5]) and abs(lp[5][2] + 4.15) < 0.1, 'lounge seats at plausible seat heights (sofa x3, armchair x2, bar stool)')
lm = [apply(world_m(by_name['lamp_%02d' % k][0]), [0, 0, 0]) for k in range(1, 7)]
check(all(1.8 < p[1] < 2.6 for p in lm) and all(min(abs(p[2] - t) for t in tables.values()) < 0.01 for p in lm), 'lamp_01..06 above the two tables at pendant height')

# ------------------------------------------------------------------ wall screen / task board
def quad_info(name):
    i = by_name[name][0]
    pts = verts_world(i)
    lo, hi = bbox(pts)
    pr = meshes[nodes[i]['mesh']]['primitives'][0]
    uv = read_acc(pr['attributes']['TEXCOORD_0'])
    nrm = rot_vec(world_m(i), [0, 0, 1])
    # upright: v increases with world y
    vs = [(u[1], p[1]) for u, p in zip(uv, pts)]
    vmax = max(vs)[1]
    vmin = min(vs)[1]
    us = [(u[0], p[2]) for u, p in zip(uv, pts)]
    umax_z = max(us)[1]
    umin_z = min(us)[1]
    return dict(lo=lo, hi=hi, uvmin=[min(u[k] for u in uv) for k in (0, 1)], uvmax=[max(u[k] for u in uv) for k in (0, 1)],
                n=nrm, up=vmax > vmin, ur=umax_z < umin_z, size=(hi[2] - lo[2], hi[1] - lo[1]), ntris=len(read_acc(pr['indices'])) // 3)


for name, w, h in (('wall_screen', 2.6, 1.46), ('task_board', 3.0, 1.5)):
    q = quad_info(name)
    check(near(q['size'][0], w, 0.02) and near(q['size'][1], h, 0.02), '%s size %.2f x %.2f m (got %.2f x %.2f)' % (name, w, h, *q['size']))
    check(q['n'][0] > 0.99, '%s faces +X (normal %s)' % (name, [round(c, 2) for c in q['n']]))
    check(near(q['lo'][0], -7.95, 0.05) and near(q['hi'][0], q['lo'][0], 0.001), '%s lies flat on the left wall (x = %.3f)' % (name, q['lo'][0]))
    check(q['uvmin'] == [0, 0] and q['uvmax'] == [1, 1], '%s UV spans 0..1' % name)
    check(q['up'] and q['ur'], '%s UV upright and not mirrored (u -> viewer right = -z, v -> up)' % name)
a, b = quad_info('wall_screen'), quad_info('task_board')
check(a['hi'][2] < b['lo'][2] or b['hi'][2] < a['lo'][2], 'wall_screen and task_board do not overlap')
check(all(0.5 < q['lo'][1] and q['hi'][1] < 2.6 for q in (a, b)) and all(-6 < q['lo'][2] and q['hi'][2] < 6 for q in (a, b)), 'both inside the wall rectangle (z[-6,6], y[0.5,2.6])')

# ------------------------------------------------------------------ roots: geometry
lo, hi = bbox_of_root(fo)
check(near(lo[1], -0.36, 0.005), 'floor_open: slab bottom y = %.3f (want -0.36)' % lo[1])
slab = bbox(verts_world(by_name['slab_open'][0]))
check(near(slab[0][1], -0.36, 0.002) and near(slab[1][1], 0.0, 0.006) and near(slab[1][0] - slab[0][0], 16.4, 0.01) and near(slab[1][2] - slab[0][2], 12.4, 0.01),
      'floor_open slab 16.4 x 12.4, y in [-0.36, 0] (top %.3f)' % slab[1][1])
fl = bbox(verts_world(by_name['baked_floor'][0]))
check(near(fl[0][0], -8, 1e-3) and near(fl[1][0], 8, 1e-3) and near(fl[0][2], -6, 1e-3) and near(fl[1][2], 6, 1e-3) and near(fl[1][1], 0, 1e-4), 'baked_floor = interior x[-8,8] z[-6,6] at y = 0')
wl_ = bbox(verts_world(by_name['wall_left_core'][0]))
cw_ = bbox(verts_world(by_name['curtain_wall'][0]))
check(near(wl_[1][1], 2.7, 0.01) and near(cw_[1][1], 2.7, 0.01), 'open floor wall height 2.7 (left wall %.2f, curtain wall %.2f)' % (wl_[1][1], cw_[1][1]))
check(near(wl_[1][0], -8.003, 0.002) and near(cw_[0][2], -6.06, 0.01), 'left wall inner face at x = -8, glass wall on z = -6')
lo, hi = bbox_of_root(fc)
check(near(lo[1], -0.36, 0.005) and near(hi[1], 1.24, 0.005), 'floor_closed spans y [-0.36, 1.24] (got %.3f..%.3f)' % (lo[1], hi[1]))
check(near(hi[0] - lo[0], 16.4, 0.02) and near(hi[2] - lo[2], 12.4, 0.02), 'floor_closed footprint 16.4 x 12.4')
fm = [i for i in descendants(fc) if 'mesh' in nodes[i] and nodes[i]['name'] == 'facade_glass']
check(len(fm) == 1 and [mat_name(p) for p in meshes[nodes[fm[0]]['mesh']]['primitives']] == ['night_windows'], 'floor_closed glass band uses night_windows')
lo, hi = bbox_of_root(rf)
check(near(lo[1], 0.0, 0.005) and near(hi[0] - lo[0], 16.4, 0.02) and hi[1] > 0.8, 'roof: origin at its bottom (y %.2f..%.2f), 16.4 wide' % (lo[1], hi[1]))
lo, hi = bbox_of_root(sh)
check(near(lo[1], 0, 0.005) and near(hi[1], 1.0, 0.005), 'elevator_shaft is exactly 1 m tall (y %.3f..%.3f)' % (lo[1], hi[1]))
check(near(hi[0] - lo[0], 1.5, 0.02) and near(hi[2] - lo[2], 1.5, 0.02) and near((hi[0] + lo[0]) / 2, 9.05, 0.01) and near((hi[2] + lo[2]) / 2, -2.6, 0.01),
      'elevator_shaft 1.5 x 1.5 footprint centred at (9.05, -2.6)')
lo, hi = bbox_of_root(cb)
check(near(lo[1], 0, 0.005) and near(hi[1], 2.2, 0.03) and near(hi[0] - lo[0], 1.3, 0.06) and near(hi[2] - lo[2], 1.3, 0.06),
      'elevator_cabin ~1.3 x 2.2 x 1.3, origin at its floor (%.2f x %.2f x %.2f)' % (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]))
check(near((hi[0] + lo[0]) / 2, 9.05, 0.01) and near((hi[2] + lo[2]) / 2, -2.6, 0.01), 'elevator_cabin centred at the shaft centre in plan')

# ------------------------------------------------------------------ budgets
tris = {}
for r, nm in ((fo, 'floor_open'), (fc, 'floor_closed'), (rf, 'roof'), (sh, 'elevator_shaft'), (cb, 'elevator_cabin')):
    tris[nm] = sum(tris_of(d) for d in [r] + descendants(r) if 'mesh' in nodes[d])
TT = sum(tris.values())
print('      triangles per root:', tris, 'total', TT)
check(TT <= 150000, 'triangles %d <= 150000' % TT)
sz = os.path.getsize(GLB)
check(sz <= 6 * 1024 * 1024, 'GLB size %.2f MB <= 6 MB' % (sz / 1048576))
nj = sum(os.path.getsize(os.path.join(NIGHT, f)) for f in os.listdir(NIGHT) if f.lower().endswith('.jpg')) if os.path.isdir(NIGHT) else 0
check(nj <= 2 * 1024 * 1024, 'night JPGs %.2f MB <= 2 MB' % (nj / 1048576))
imgs = js.get('images', [])
print('      embedded images:', [(im.get('name'), im.get('mimeType')) for im in imgs])
print('      materials:', len(mats), '| nodes:', len(nodes), '| meshes:', len(meshes), '| extensionsUsed:', js.get('extensionsUsed'))

print()
print('ALL CHECKS PASSED' if not FAILS else '%d CHECK(S) FAILED' % len(FAILS))
sys.exit(1 if FAILS else 0)
