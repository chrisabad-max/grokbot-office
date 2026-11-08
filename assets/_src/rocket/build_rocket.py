# Grok Bot Wallpaper: "cutaway starship" concept still (approval mockup, not app code).
#   blender -b --factory-startup -P build_rocket.py -- [final] [x2] [samples=N] [out=path] [nofog] [save]
#   (no args)  960x540 draft -> draft.png        final = 1920x1080 -> rocket.png      final x2 = 3840x2160 -> rocket.png
#   nofog = skip the steam/engine-glow billboards, save = also write _rocket.blend
# Z-up Blender coordinates. Camera looks along +Y (sits at -Y, yawed CAM_AZ), rocket axis = Z.
# Azimuth phi is measured from -Y (towards the camera) to +X (screen right).
# Interior bots come from assets/blobs/<id>.glb; the logo from assets/brand/logo.png.
import bpy, bmesh, math, os, sys, random, time
from mathutils import Vector, Matrix
from bpy_extras.object_utils import world_to_camera_view

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FINAL = 'final' in ARGS
NOFOG = 'nofog' in ARGS
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
BLOBS = os.path.join(ROOT, 'assets', 'blobs')
LOGO = os.path.join(ROOT, 'assets', 'brand', 'logo.png')
OUT_PNG = os.path.join(HERE, 'rocket.png' if FINAL else 'draft.png')
for a in ARGS:
    if a.startswith('out='):
        OUT_PNG = a[4:]
RES = (1920, 1080) if FINAL else (960, 540)
if 'x2' in ARGS:
    RES = (3840, 2160)
SAMPLES = 224 if FINAL else 40
for a in ARGS:
    if a.startswith('samples='):
        SAMPLES = int(a[8:])

# ------------------------------------------------------------------ dimensions
R = 3.15                # hull outer radius
TH = 0.20               # hull thickness (visible on cut edges)
RI = R - TH
SLAB = 0.22
CUT_HALF = math.radians(70)        # cut sector = phi in (-70, +70) -> 140 deg
CAM_AZ = math.radians(8)
CAM_EL = math.radians(16)
Z_CUT0 = 3.5
CLEAR = {1: 2.2, 2: 2.2, 3: 2.8, 4: 2.2}
DECKS = {}
_z = Z_CUT0
for k in (1, 2, 3, 4):
    DECKS[k] = dict(slab0=_z, floor=_z + SLAB, ceil=_z + SLAB + CLEAR[k])
    _z = DECKS[k]['ceil']
Z_CUT1 = _z + SLAB                  # roof slab top = top of the opening
Z_BAND1 = Z_CUT1 + 0.9             # closed band above the cut (logo)
OG_L = 4.3                          # ogive length
RN = 0.5                           # nose blunting radius
Z_SKIRT0, Z_SKIRT1, Z_AFT0 = 1.5, 2.05, 2.45
CORE = (0.0, 1.75)                  # glass core centre (x, y), radius 0.5
CORE_R = 0.5
BOT_S = 1.2                         # blob scale (blobs are ~0.8 wide natively)

FW = 6                              # filled in below
random.seed(7)


# ------------------------------------------------------------------ colour / nodes
def s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h, a=1.0):
    h = h.lstrip('#')
    r, g, b = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return (s2l(r), s2l(g), s2l(b), a)


class NT:
    def __init__(self, mat):
        mat.use_nodes = True
        self.nt = mat.node_tree
        for n in list(self.nt.nodes):
            self.nt.nodes.remove(n)

    def n(self, typ, **kw):
        node = self.nt.nodes.new(typ)
        for k, v in kw.items():
            setattr(node, k, v)
        return node

    def link(self, a, b):
        self.nt.links.new(a, b)


def M(t, op, a, b=None, c=None, clamp=False):
    n = t.n('ShaderNodeMath', operation=op, use_clamp=clamp)
    for i, v in enumerate((a, b, c)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            t.link(v, n.inputs[i])
    return n.outputs[0]


def MR(t, v, a, b, c, d, smooth=True):
    n = t.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR', clamp=True)
    t.link(v, n.inputs['Value'])
    n.inputs['From Min'].default_value = a
    n.inputs['From Max'].default_value = b
    n.inputs['To Min'].default_value = c
    n.inputs['To Max'].default_value = d
    return n.outputs['Result']


def principled(m, base, rough=0.5, metal=0.0, **kw):
    t = NT(m)
    b = t.n('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = hexcol(base) if isinstance(base, str) else base
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    for k, v in kw.items():
        k = k.replace('_', ' ')
        if k in b.inputs:
            b.inputs[k].default_value = hexcol(v) if isinstance(v, str) else v
    o = t.n('ShaderNodeOutputMaterial')
    t.link(b.outputs[0], o.inputs['Surface'])
    return t, b, o


MATS = {}


def mat(name, base, rough=0.5, metal=0.0, **kw):
    if name not in MATS:
        m = bpy.data.materials.new(name)
        principled(m, base, rough, metal, **kw)
        MATS[name] = m
    return MATS[name]


def _black_diffuse(t):
    d = t.n('ShaderNodeBsdfDiffuse')
    d.inputs['Color'].default_value = (0.0, 0.0, 0.0, 1.0)
    return d


def emit_mat(name, hexc, strength):
    """emission with alpha 1 (Cycles gives pure emission alpha 0 on a transparent film)"""
    m = bpy.data.materials.new(name)
    t = NT(m)
    e = t.n('ShaderNodeEmission')
    e.inputs['Color'].default_value = hexcol(hexc)
    e.inputs['Strength'].default_value = strength
    d = _black_diffuse(t)
    ad = t.n('ShaderNodeAddShader')
    o = t.n('ShaderNodeOutputMaterial')
    t.link(e.outputs[0], ad.inputs[0])
    t.link(d.outputs[0], ad.inputs[1])
    t.link(ad.outputs[0], o.inputs['Surface'])
    return m


def glow_mat(name, hexc, strength=3.0, power=1.6, sphere=False):
    """soft radial glow: emission fading to transparent (object coords, unit sphere/disc), alpha = falloff"""
    m = bpy.data.materials.new(name)
    t = NT(m)
    tc = t.n('ShaderNodeTexCoord')
    gr = t.n('ShaderNodeTexGradient', gradient_type='SPHERICAL')
    t.link(tc.outputs['Object'], gr.inputs['Vector'])
    base_fac = gr.outputs['Fac']
    if sphere:      # view-facing falloff for a ball (shading points all lie on its surface)
        geo = t.n('ShaderNodeNewGeometry')
        dt = t.n('ShaderNodeVectorMath', operation='DOT_PRODUCT')
        t.link(geo.outputs['Normal'], dt.inputs[0])
        t.link(geo.outputs['Incoming'], dt.inputs[1])
        base_fac = M(t, 'ABSOLUTE', dt.outputs['Value'])
    fac = M(t, 'POWER', base_fac, power)
    tr = t.n('ShaderNodeBsdfTransparent')
    em = t.n('ShaderNodeEmission')
    em.inputs['Color'].default_value = hexcol(hexc)
    em.inputs['Strength'].default_value = strength
    d = _black_diffuse(t)
    ad = t.n('ShaderNodeAddShader')
    t.link(em.outputs[0], ad.inputs[0])
    t.link(d.outputs[0], ad.inputs[1])
    mx = t.n('ShaderNodeMixShader')
    o = t.n('ShaderNodeOutputMaterial')
    t.link(fac, mx.inputs[0])
    t.link(tr.outputs[0], mx.inputs[1])
    t.link(ad.outputs[0], mx.inputs[2])
    t.link(mx.outputs[0], o.inputs['Surface'])
    return m


def shadow_mat(name, opacity=0.5, power=1.3):
    """soft dark contact-shadow decal (alpha falloff, absorbs light)"""
    m = bpy.data.materials.new(name)
    t = NT(m)
    tc = t.n('ShaderNodeTexCoord')
    gr = t.n('ShaderNodeTexGradient', gradient_type='SPHERICAL')
    t.link(tc.outputs['Object'], gr.inputs['Vector'])
    fac = M(t, 'MULTIPLY', M(t, 'POWER', gr.outputs['Fac'], power), opacity)
    tr = t.n('ShaderNodeBsdfTransparent')
    d = t.n('ShaderNodeBsdfDiffuse')
    d.inputs['Color'].default_value = (0.012, 0.009, 0.007, 1.0)
    mx = t.n('ShaderNodeMixShader')
    o = t.n('ShaderNodeOutputMaterial')
    t.link(fac, mx.inputs[0])
    t.link(tr.outputs[0], mx.inputs[1])
    t.link(d.outputs[0], mx.inputs[2])
    t.link(mx.outputs[0], o.inputs['Surface'])
    return m


def glass_mat(name, tint='#BFD6E6', fac=0.16):
    m = bpy.data.materials.new(name)
    t = NT(m)
    g = t.n('ShaderNodeBsdfPrincipled')
    g.inputs['Base Color'].default_value = hexcol(tint)
    g.inputs['Roughness'].default_value = 0.04
    g.inputs['Specular IOR Level'].default_value = 0.9
    tr = t.n('ShaderNodeBsdfTransparent')
    mx = t.n('ShaderNodeMixShader')
    mx.inputs[0].default_value = fac
    o = t.n('ShaderNodeOutputMaterial')
    t.link(tr.outputs[0], mx.inputs[1])
    t.link(g.outputs[0], mx.inputs[2])
    t.link(mx.outputs[0], o.inputs['Surface'])
    return m


def hull_mat(name, tiles, pitch=1.0, base=(0.80, 0.82, 0.85), rough0=0.31):
    """brushed stainless with ring weld seams; optional black tile zone on the far (right/back) half"""
    m = bpy.data.materials.new(name)
    t = NT(m)
    tc = t.n('ShaderNodeTexCoord')
    sep = t.n('ShaderNodeSeparateXYZ')
    t.link(tc.outputs['Object'], sep.inputs[0])
    x, y, z = sep.outputs
    zi = M(t, 'DIVIDE', z, pitch)
    fr = M(t, 'FRACT', zi)
    omf = M(t, 'SUBTRACT', 1.0, fr)
    mn = M(t, 'MINIMUM', fr, omf)
    d = M(t, 'MULTIPLY', mn, pitch)
    seam = MR(t, d, 0.0, 0.028, 1.0, 0.0)
    bump = t.n('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.55
    bump.inputs['Distance'].default_value = 0.03
    t.link(seam, bump.inputs['Height'])
    # per-ring tone variation
    wn = t.n('ShaderNodeTexWhiteNoise', noise_dimensions='1D')
    t.link(M(t, 'FLOOR', zi), wn.inputs['W'])
    tone = M(t, 'ADD', 0.90, M(t, 'MULTIPLY', wn.outputs['Value'], 0.13))
    dark = M(t, 'SUBTRACT', 1.0, M(t, 'MULTIPLY', seam, 0.32))
    tone = M(t, 'MULTIPLY', tone, dark)
    vs = t.n('ShaderNodeVectorMath', operation='SCALE')
    vs.inputs[0].default_value = (s2l(base[0]), s2l(base[1]), s2l(base[2]))
    t.link(tone, vs.inputs['Scale'])
    # roughness: faint cloudy variation
    nz = t.n('ShaderNodeTexNoise', noise_dimensions='3D')
    nz.inputs['Scale'].default_value = 5.0
    nz.inputs['Detail'].default_value = 4.0
    t.link(tc.outputs['Object'], nz.inputs['Vector'])
    rough = M(t, 'ADD', rough0, M(t, 'MULTIPLY', nz.outputs['Fac'], 0.04))
    tg = t.n('ShaderNodeTangent', direction_type='RADIAL', axis='Z')
    st = t.n('ShaderNodeBsdfPrincipled')
    st.inputs['Metallic'].default_value = 1.0
    st.inputs['Anisotropic'].default_value = 0.8
    t.link(vs.outputs[0], st.inputs['Base Color'])
    t.link(rough, st.inputs['Roughness'])
    t.link(tg.outputs['Tangent'], st.inputs['Tangent'])
    t.link(bump.outputs['Normal'], st.inputs['Normal'])
    o = t.n('ShaderNodeOutputMaterial')
    if not tiles:
        t.link(st.outputs[0], o.inputs['Surface'])
        return m
    # --- tiles
    ang = M(t, 'ARCTAN2', x, M(t, 'MULTIPLY', y, -1.0))
    wob = t.n('ShaderNodeTexNoise', noise_dimensions='3D')
    wob.inputs['Scale'].default_value = 1.7
    wob.inputs['Detail'].default_value = 3.0
    t.link(tc.outputs['Object'], wob.inputs['Vector'])
    angw = M(t, 'ADD', ang, M(t, 'MULTIPLY', M(t, 'SUBTRACT', wob.outputs['Fac'], 0.5), 0.32))
    m1 = MR(t, angw, 0.60, 0.65, 0.0, 1.0)
    m2 = MR(t, angw, -2.52, -2.46, 1.0, 0.0)
    mask = M(t, 'MAXIMUM', m1, m2)
    cx = t.n('ShaderNodeCombineXYZ')
    t.link(M(t, 'MULTIPLY', ang, R), cx.inputs['X'])
    t.link(z, cx.inputs['Y'])
    br = t.n('ShaderNodeTexBrick', offset=0.5, offset_frequency=2, squash=1.0, squash_frequency=2)
    br.inputs['Color1'].default_value = hexcol('#08090B')
    br.inputs['Color2'].default_value = hexcol('#14161A')
    br.inputs['Mortar'].default_value = hexcol('#3A3E46')
    br.inputs['Scale'].default_value = 1.0
    br.inputs['Mortar Size'].default_value = 0.022
    br.inputs['Mortar Smooth'].default_value = 0.1
    br.inputs['Brick Width'].default_value = 0.34
    br.inputs['Row Height'].default_value = 0.22
    t.link(cx.outputs[0], br.inputs['Vector'])
    tb = t.n('ShaderNodeBump')
    tb.inputs['Strength'].default_value = 0.35
    tb.inputs['Distance'].default_value = 0.01
    t.link(br.outputs['Fac'], tb.inputs['Height'])
    tl = t.n('ShaderNodeBsdfPrincipled')
    t.link(br.outputs['Color'], tl.inputs['Base Color'])
    tl.inputs['Roughness'].default_value = 0.34
    tl.inputs['Metallic'].default_value = 0.15
    tl.inputs['Specular IOR Level'].default_value = 0.8
    try:
        tl.inputs['Coat Weight'].default_value = 0.4
        tl.inputs['Coat Roughness'].default_value = 0.15
    except Exception:
        pass
    t.link(tb.outputs['Normal'], tl.inputs['Normal'])
    mx = t.n('ShaderNodeMixShader')
    t.link(mask, mx.inputs[0])
    t.link(st.outputs[0], mx.inputs[1])
    t.link(tl.outputs[0], mx.inputs[2])
    t.link(mx.outputs[0], o.inputs['Surface'])
    return m


def flat_tile_mat(name):
    """black tile surface for flaps (object coords x/z)"""
    m = bpy.data.materials.new(name)
    t = NT(m)
    tc = t.n('ShaderNodeTexCoord')
    sep = t.n('ShaderNodeSeparateXYZ')
    t.link(tc.outputs['Object'], sep.inputs[0])
    cx = t.n('ShaderNodeCombineXYZ')
    t.link(sep.outputs['X'], cx.inputs['X'])
    t.link(sep.outputs['Z'], cx.inputs['Y'])
    br = t.n('ShaderNodeTexBrick', offset=0.5, offset_frequency=2)
    br.inputs['Color1'].default_value = hexcol('#08090B')
    br.inputs['Color2'].default_value = hexcol('#14161A')
    br.inputs['Mortar'].default_value = hexcol('#3A3E46')
    br.inputs['Mortar Size'].default_value = 0.022
    br.inputs['Brick Width'].default_value = 0.34
    br.inputs['Row Height'].default_value = 0.22
    t.link(cx.outputs[0], br.inputs['Vector'])
    tb = t.n('ShaderNodeBump')
    tb.inputs['Strength'].default_value = 0.35
    tb.inputs['Distance'].default_value = 0.01
    t.link(br.outputs['Fac'], tb.inputs['Height'])
    tl = t.n('ShaderNodeBsdfPrincipled')
    t.link(br.outputs['Color'], tl.inputs['Base Color'])
    tl.inputs['Roughness'].default_value = 0.34
    tl.inputs['Metallic'].default_value = 0.15
    try:
        tl.inputs['Coat Weight'].default_value = 0.4
        tl.inputs['Coat Roughness'].default_value = 0.15
    except Exception:
        pass
    t.link(tb.outputs['Normal'], tl.inputs['Normal'])
    o = t.n('ShaderNodeOutputMaterial')
    t.link(tl.outputs[0], o.inputs['Surface'])
    return m


def logo_mat(name):
    m = bpy.data.materials.new(name)
    t = NT(m)
    img = bpy.data.images.load(LOGO)
    ti = t.n('ShaderNodeTexImage')
    ti.image = img
    ti.extension = 'CLIP'
    bs = t.n('ShaderNodeBsdfPrincipled')
    bs.inputs['Base Color'].default_value = (1.0, 1.0, 1.0, 1)
    bs.inputs['Roughness'].default_value = 0.42
    bs.inputs['Emission Color'].default_value = (0.9, 0.94, 1.0, 1)
    bs.inputs['Emission Strength'].default_value = 0.9
    t.link(ti.outputs['Alpha'], bs.inputs['Alpha'])
    o = t.n('ShaderNodeOutputMaterial')
    t.link(bs.outputs[0], o.inputs['Surface'])
    try:
        m.surface_render_method = 'DITHERED'
    except Exception:
        pass
    return m


# ------------------------------------------------------------------ mesh helpers
EXT = INT = None


def new_coll(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def obj_from(name, bm, mats, coll):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    return ob


def P(r, phi, z):
    return Vector((r * math.sin(phi), -r * math.cos(phi), z))


def lathe(bm, prof, mis, seg=128, phi0=0.0, phi1=2 * math.pi, smooth=True, flip=False):
    """prof: [(r,z)...] bottom->top; mis: material index per segment. outward normals unless flip"""
    arc = abs(phi1 - phi0) < 2 * math.pi - 1e-6
    nu = seg
    cols = []
    for i in range(nu + (1 if arc else 0)):
        phi = phi0 + (phi1 - phi0) * i / nu
        cols.append([bm.verts.new(P(r, phi, z)) for (r, z) in prof])
    for i in range(nu):
        i2 = i + 1 if arc else (i + 1) % nu
        for j in range(len(prof) - 1):
            q = [cols[i][j], cols[i2][j], cols[i2][j + 1], cols[i][j + 1]]
            if flip:
                q.reverse()
            f = bm.faces.new(q)
            f.material_index = mis[j] if isinstance(mis, (list, tuple)) else mis
            f.smooth = smooth
    return cols


def cap(bm, r, z, up, mi, seg=128):
    vs = [bm.verts.new(P(r, 2 * math.pi * i / seg, z)) for i in range(seg)]
    if not up:
        vs.reverse()
    f = bm.faces.new(vs)
    f.material_index = mi
    f.smooth = False


def disc(bm, r, z0, z1, mi=0, bev=0.02, seg=128, mis_side=None):
    prof = [(r - bev, z0), (r, z0 + bev), (r, z1 - bev), (r - bev, z1)]
    lathe(bm, prof, [mi, mi if mis_side is None else mis_side, mi], seg=seg)
    cap(bm, r - bev, z1, True, mi, seg)
    cap(bm, r - bev, z0, False, mi, seg)


def box(bm, c, s, mi=0, bevel=0.0, rot=(0, 0, 0), smooth=False):
    old = set(bm.verts)
    r = bmesh.ops.create_cube(bm, size=1.0)
    verts = r['verts']
    for v in verts:
        v.co = Vector((v.co.x * s[0], v.co.y * s[1], v.co.z * s[2]))
    if bevel > 0:
        edges = list({e for v in verts for e in v.link_edges})
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=2, profile=0.6, affect='EDGES')
    verts = [v for v in bm.verts if v not in old]
    place(bm, verts, c, rot, mi, smooth)


def cyl(bm, c, r1, r2, h, mi=0, seg=32, rot=(0, 0, 0), smooth=True, caps=True):
    r = bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=h)
    place(bm, list(r['verts']), c, rot, mi, smooth)


def sphere(bm, c, s, mi=0, sub=2, smooth=True, rot=(0, 0, 0)):
    r = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    verts = list(r['verts'])
    for v in verts:
        v.co = Vector((v.co.x * s[0], v.co.y * s[1], v.co.z * s[2]))
    place(bm, verts, c, rot, mi, smooth)


def torus(bm, c, R0, r0, mi=0, seg=64, tube=14):
    old = set(bm.verts)
    cols = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        row = []
        for j in range(tube):
            b = 2 * math.pi * j / tube
            rr = R0 + r0 * math.cos(b)
            row.append(bm.verts.new(Vector((rr * math.cos(a), rr * math.sin(a), r0 * math.sin(b))) + Vector(c)))
        cols.append(row)
    for i in range(seg):
        for j in range(tube):
            f = bm.faces.new([cols[i][j], cols[(i + 1) % seg][j], cols[(i + 1) % seg][(j + 1) % tube], cols[i][(j + 1) % tube]])
            f.material_index = mi
            f.smooth = True


def place(bm, verts, c, rot, mi, smooth):
    Rm = Matrix.Rotation(rot[2], 4, 'Z') @ Matrix.Rotation(rot[1], 4, 'Y') @ Matrix.Rotation(rot[0], 4, 'X')
    T = Matrix.Translation(Vector(c)) @ Rm
    faces = set()
    for v in verts:
        if v.is_valid:
            v.co = T @ v.co
            faces.update(v.link_faces)
    for f in faces:
        f.material_index = mi
        f.smooth = smooth


def arc_solid(bm, r0, r1, phi0, phi1, z0, z1, mis=(0, 0, 0, 0, 0, 0), seg=40, bevel=0.0, smooth_curved=True):
    """closed solid: annular sector. mis = (outer, inner, end0, end1, top, bottom)"""
    old = set(bm.verts)
    lathe(bm, [(r1, z0), (r1, z1)], mis[0], seg=seg, phi0=phi0, phi1=phi1, smooth=smooth_curved)
    lathe(bm, [(r0, z0), (r0, z1)], mis[1], seg=seg, phi0=phi0, phi1=phi1, smooth=smooth_curved, flip=True)
    # ends
    for phi, mi, rev in ((phi0, mis[2], True), (phi1, mis[3], False)):
        q = [bm.verts.new(P(r0, phi, z0)), bm.verts.new(P(r1, phi, z0)), bm.verts.new(P(r1, phi, z1)), bm.verts.new(P(r0, phi, z1))]
        if rev:
            q.reverse()
        f = bm.faces.new(q)
        f.material_index = mi
        f.smooth = False
    # top / bottom
    for z, mi, up in ((z1, mis[4], True), (z0, mis[5], False)):
        top = [bm.verts.new(P(r1, phi0 + (phi1 - phi0) * i / seg, z)) for i in range(seg + 1)]
        bot = [bm.verts.new(P(r0, phi0 + (phi1 - phi0) * i / seg, z)) for i in range(seg + 1)]
        for i in range(seg):
            q = [bot[i], top[i], top[i + 1], bot[i + 1]]
            if not up:
                q.reverse()
            f = bm.faces.new(q)
            f.material_index = mi
            f.smooth = False
    new = [v for v in bm.verts if v not in old]
    bmesh.ops.remove_doubles(bm, verts=new, dist=1e-4)
    if bevel > 0:
        newset = {v for v in bm.verts if v not in old}
        edges = [e for e in bm.edges if e.verts[0] in newset and e.verts[1] in newset and len(e.link_faces) == 2 and e.calc_face_angle(0.0) > 0.6]
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=2, profile=0.6, affect='EDGES')



# ------------------------------------------------------------------ builder + props
class MB:
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def m(self, mt):
        if mt not in self.mats:
            self.mats.append(mt)
        return self.mats.index(mt)

    def build(self, name, coll):
        return obj_from(name, self.bm, self.mats, coll)


def tree(b, MT, c, s=1.0, seed=3):
    rng = random.Random(seed)
    x, y, z = c
    pot, trunk = b.m(MT['pot']), b.m(MT['trunk'])
    greens = [b.m(MT['g1']), b.m(MT['g2']), b.m(MT['g3'])]
    cyl(b.bm, (x, y, z + 0.30 * s), 0.30 * s, 0.25 * s, 0.60 * s, pot, seg=36)
    cyl(b.bm, (x, y, z + 0.61 * s), 0.26 * s, 0.26 * s, 0.03 * s, trunk, seg=24)
    cyl(b.bm, (x, y, z + 0.95 * s), 0.03 * s, 0.045 * s, 0.70 * s, trunk, seg=10)
    for i in range(15):
        a = rng.uniform(0, 6.283)
        r = rng.uniform(0.04, 0.40) * s
        zz = rng.uniform(1.0, 1.55) * s
        k = rng.uniform(0.20, 0.31) * s
        sphere(b.bm, (x + math.cos(a) * r, y + math.sin(a) * r, z + zz), (k, k, k * 0.82), greens[i % 3], sub=2)


def laptop(b, MT, c, face):
    """slim laptop; the screen looks along the XY vector `face`"""
    x, y, z = c
    yaw = math.atan2(face[0], -face[1])
    Rz = Matrix.Rotation(yaw, 3, 'Z')

    def at(v):
        w = Rz @ Vector(v)
        return (x + w.x, y + w.y, z + w.z)

    alu, scr = b.m(MT['alu']), b.m(MT['screen'])
    tilt = -math.radians(18)
    Rt = Matrix.Rotation(tilt, 3, 'X')
    hinge = Vector((0, 0.125, 0.014))
    box(b.bm, at((0, 0, 0.007)), (0.36, 0.25, 0.014), alu, bevel=0.004, rot=(0, 0, yaw))
    box(b.bm, at(hinge + Rt @ Vector((0, 0, 0.115))), (0.36, 0.008, 0.23), alu, bevel=0.003, rot=(tilt, 0, yaw))
    box(b.bm, at(hinge + Rt @ Vector((0, -0.0055, 0.115))), (0.335, 0.002, 0.205), scr, rot=(tilt, 0, yaw))


# ------------------------------------------------------------------ build
def build_materials():
    MT = {}
    MT['steel'] = hull_mat('hull_steel', tiles=True)
    MT['steel_plain'] = hull_mat('hull_steel_plain', tiles=False, pitch=1.0, base=(0.62, 0.64, 0.68), rough0=0.27)
    MT['slab_steel'] = hull_mat('slab_steel', tiles=False, pitch=0.6, base=(0.70, 0.72, 0.76), rough0=0.27)
    MT['tile'] = flat_tile_mat('flap_tile')
    MT['collar'] = hull_mat('collar', tiles=False, pitch=3.0, base=(0.16, 0.17, 0.19), rough0=0.32)
    MT['graphite'] = mat('graphite', '#26282C', 0.38, 0.55)
    MT['dark'] = mat('dark', '#141518', 0.5, 0.2)
    MT['floor'] = mat('floor', '#EADFCF', 0.28, 0.0, specular_ior_level=0.6)
    MT['wall'] = mat('wallin', '#BEB3A2', 0.6, 0.0)
    MT['white'] = mat('white', '#F5F3EF', 0.32, 0.0, specular_ior_level=0.6)
    MT['oak'] = mat('oak', '#D4B58A', 0.42, 0.0)
    MT['rug1'] = mat('rug1', '#E2DBCF', 1.0, 0.0)
    MT['rug2'] = mat('rug2', '#D3DACB', 1.0, 0.0)
    MT['rug3'] = mat('rug3', '#E4D6BF', 1.0, 0.0)
    MT['alu'] = mat('alu', '#C4C7CC', 0.28, 1.0)
    MT['screen'] = emit_mat('screen', '#A9C8FF', 0.9)
    MT['pot'] = mat('pot', '#34373C', 0.4, 0.2)
    MT['trunk'] = mat('trunk', '#6B5A48', 0.8)
    MT['g1'] = mat('g1', '#4F7A45', 0.55)
    MT['g2'] = mat('g2', '#6B925A', 0.55)
    MT['g3'] = mat('g3', '#3E6538', 0.55)
    MT['glass'] = glass_mat('glass')
    MT['core'] = emit_mat('corelight', '#CFE8FF', 7.0)
    MT['warmstrip'] = emit_mat('warmstrip', '#FFC98A', 5.0)
    MT['logo'] = logo_mat('logo')
    MT['nozzle'] = mat('nozzle', '#575C66', 0.30, 1.0)
    MT['nozin'] = emit_mat('nozin', '#BFD9FF', 4.0)
    MT['nozlip'] = emit_mat('nozlip', '#CFE3FF', 9.0)
    MT['skirt'] = mat('skirt', '#2B2E33', 0.42, 0.7)
    return MT


def build_hull(MT):
    global Z_TIP
    # ---- lower body: skirt (graphite) + aft hull (steel, closed)
    bm = bmesh.new()
    skirt = [(2.15, Z_SKIRT0), (2.55, Z_SKIRT0 + 0.10), (2.62, Z_SKIRT0 + 0.22), (2.62, Z_SKIRT1),
             (2.70, Z_SKIRT1 + 0.12), (2.88, Z_AFT0 - 0.14), (2.97, Z_AFT0 - 0.04), (R, Z_AFT0 + 0.04)]
    lathe(bm, skirt, 0, seg=128)
    obj_from('skirt', bm, [MT['skirt']], EXT)
    bm = bmesh.new()
    lathe(bm, [(R, Z_AFT0), (R, Z_CUT0 + 0.02)], 0, seg=128)
    obj_from('aft_hull', bm, [MT['steel']], EXT)

    # ---- cut wall: solid (outer steel/tiles, cut faces plain steel). Inner face lives in INT.
    bm = bmesh.new()
    p0, p1 = CUT_HALF, 2 * math.pi - CUT_HALF
    arc_solid(bm, RI, R, p0, p1, Z_CUT0, Z_CUT1, mis=(0, 1, 1, 1, 1, 1), seg=96, bevel=0.018)
    obj_from('cut_wall', bm, [MT['steel'], MT['steel_plain']], EXT)
    bm = bmesh.new()
    lathe(bm, [(RI - 0.004, Z_CUT0 + SLAB), (RI - 0.004, Z_CUT1 - SLAB)], 0, seg=96, phi0=p0, phi1=p1, flip=True)
    obj_from('inner_wall', bm, [MT['wall']], INT)

    # ---- closed band above the cut + rounded ogive (cubic bezier profile)
    bm = bmesh.new()
    lathe(bm, [(R, Z_CUT1 - 0.02), (R, Z_BAND1)], 0, seg=128)
    obj_from('band', bm, [MT['collar']], EXT)
    prof = [(R, Z_BAND1)]
    P0, P1, P2, P3 = (R, 0.0), (R, 0.42 * OG_L), (0.36 * R, 0.93 * OG_L), (0.0, OG_L)
    for i in range(1, 61):
        t = i / 60
        u = 1 - t
        r = u ** 3 * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t ** 3 * P3[0]
        z = u ** 3 * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t ** 3 * P3[1]
        prof.append((max(r, 1e-4), Z_BAND1 + z))
    Z_TIP = Z_BAND1 + OG_L
    bm = bmesh.new()
    lathe(bm, prof, 0, seg=128)
    obj_from('nose', bm, [MT['steel']], EXT)

    # ---- skirt ribs (graphite)
    bm = bmesh.new()
    for i in range(36):
        a = 2 * math.pi * i / 36
        c = P(2.63, a, (Z_SKIRT0 + Z_SKIRT1) / 2 + 0.03)
        box(bm, c, (0.09, 0.05, Z_SKIRT1 - Z_SKIRT0 - 0.16), 0, bevel=0.012, rot=(0, 0, a))
    obj_from('skirt_ribs', bm, [MT['dark']], EXT)


def build_flaps(MT):
    def flap(name, phi_deg, z_r0, z_r1, L, z_t0, z_t1, thick, face_mat):
        bm = bmesh.new()
        outline = [(-0.2, z_r0), (L, z_t0), (L, z_t1), (-0.2, z_r1)]
        top = [bm.verts.new((s, thick / 2, zz)) for s, zz in outline]
        bot = [bm.verts.new((s, -thick / 2, zz)) for s, zz in outline]
        bm.faces.new(top)
        bm.faces.new(list(reversed(bot)))
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new([top[i], bot[i], bot[j], top[j]])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.07, segments=3, profile=0.6, affect='EDGES')
        phi = math.radians(phi_deg)
        Rm = Matrix.Rotation(phi - math.pi / 2, 4, 'Z')
        rv = Vector((math.sin(phi), -math.cos(phi), 0))
        for v in bm.verts:
            v.co = Rm @ v.co + rv * (R - 0.04)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.normal_update()
        for f in bm.faces:
            f.smooth = True
            f.material_index = 0 if f.normal.y < -0.5 else 1
        return obj_from(name, bm, [face_mat, MT['steel_plain']], EXT)

    flap('aft_flap_R', 90, 2.55, 5.05, 1.9, 2.9, 4.2, 0.22, MT['tile'])
    flap('aft_flap_L', -90, 2.55, 5.05, 1.9, 2.9, 4.2, 0.22, MT['steel_plain'])
    zf = Z_BAND1 - 0.15
    flap('fwd_flap_R', 90, zf - 1.5, zf + 0.35, 1.25, zf - 1.05, zf - 0.05, 0.20, MT['tile'])
    flap('fwd_flap_L', -90, zf - 1.5, zf + 0.35, 1.25, zf - 1.05, zf - 0.05, 0.20, MT['steel_plain'])
    bm = bmesh.new()
    for s in (1, -1):
        cyl(bm, (s * (R + 0.02), 0, 3.8), 0.16, 0.16, 2.5, 0, seg=24)
        cyl(bm, (s * (R + 0.02), 0, zf - 0.55), 0.13, 0.13, 1.8, 0, seg=24)
    obj_from('hinges', bm, [MT['dark']], EXT)


def build_logo(MT):
    w = 3.9
    h = w * 290 / 1860
    zc = (Z_CUT1 + Z_BAND1) / 2
    seg = 40
    half = w / 2 / R
    bm = bmesh.new()
    cols = []
    for i in range(seg + 1):
        phi = -half + 2 * half * i / seg + CAM_AZ * 0.35
        cols.append([bm.verts.new(P(R + 0.006, phi, zc - h / 2)), bm.verts.new(P(R + 0.006, phi, zc + h / 2))])
    uv_layer = bm.loops.layers.uv.new('UVMap')
    for i in range(seg):
        f = bm.faces.new([cols[i][0], cols[i + 1][0], cols[i + 1][1], cols[i][1]])
        f.smooth = True
        u0, u1 = i / seg, (i + 1) / seg
        for lp, uv in zip(f.loops, [(u0, 0), (u1, 0), (u1, 1), (u0, 1)]):
            lp[uv_layer].uv = uv
    obj_from('logo', bm, [MT['logo']], EXT)


def build_engines(MT):
    bm = bmesh.new()
    bm2 = bmesh.new()
    bm3 = bmesh.new()
    positions = [P(1.18, a, 0) for a in (0.0, 2 * math.pi / 3, -2 * math.pi / 3)]
    outer = [(0.80, 0.0), (0.75, 0.12), (0.62, 0.48), (0.50, 0.80), (0.39, 1.05), (0.33, 1.28)]
    inner = [(r - 0.045, z) for r, z in outer]
    NS = 48
    for p in positions:
        cols = []
        for i in range(NS):
            a = 2 * math.pi * i / NS
            cols.append([bm.verts.new(Vector((r * math.cos(a) + p.x, r * math.sin(a) + p.y, z))) for r, z in outer])
        for i in range(NS):
            for j in range(len(outer) - 1):
                f = bm.faces.new([cols[i][j], cols[(i + 1) % NS][j], cols[(i + 1) % NS][j + 1], cols[i][j + 1]])
                f.smooth = True
        cols = []
        for i in range(NS):
            a = 2 * math.pi * i / NS
            cols.append([bm2.verts.new(Vector((r * math.cos(a) + p.x, r * math.sin(a) + p.y, z + 0.005))) for r, z in inner])
        for i in range(NS):
            for j in range(len(inner) - 1):
                f = bm2.faces.new([cols[i][j + 1], cols[(i + 1) % NS][j + 1], cols[(i + 1) % NS][j], cols[i][j]])
                f.smooth = True
        torus(bm3, (p.x, p.y, 0.012), 0.775, 0.032, 0, seg=64, tube=8)
        cyl(bm, (p.x, p.y, 1.32), 0.33, 0.33, 0.14, 0, seg=32)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj_from('nozzles', bm, [MT['nozzle']], EXT)
    obj_from('nozzles_in', bm2, [MT['nozin']], EXT)
    obj_from('nozzle_lips', bm3, [MT['nozlip']], EXT)
    return positions


def build_decks(MT):
    bm = bmesh.new()
    for k, d in DECKS.items():
        disc(bm, R - 0.012, d['slab0'], d['slab0'] + 0.17, 0, bev=0.02)
    disc(bm, R - 0.012, DECKS[4]['ceil'], Z_CUT1, 0, bev=0.02)
    obj_from('slabs', bm, [MT['slab_steel']], EXT)
    bm = bmesh.new()
    for k, d in DECKS.items():
        disc(bm, R - 0.05, d['slab0'] + 0.17, d['floor'], 0, bev=0.012)
    obj_from('floors', bm, [MT['floor']], INT)


def build_core(MT):
    z0 = DECKS[1]['floor']
    z1 = DECKS[4]['ceil']
    cx, cy = CORE
    b = MB()
    cyl(b.bm, (cx, cy, (z0 + z1) / 2), CORE_R, CORE_R, z1 - z0, b.m(MT['glass']), seg=48, caps=False)
    b.build('core_glass', INT)
    b = MB()
    cyl(b.bm, (cx, cy, (z0 + z1) / 2), 0.14, 0.14, z1 - z0, b.m(MT['core']), seg=24, caps=False)
    b.build('core_light', INT)
    b = MB()
    a_ = b.m(MT['alu'])
    for k, d in DECKS.items():
        torus(b.bm, (cx, cy, d['floor'] + 0.02), CORE_R + 0.03, 0.035, a_, seg=48, tube=8)
        torus(b.bm, (cx, cy, d['ceil'] - 0.02), CORE_R + 0.03, 0.035, a_, seg=48, tube=8)
    for i in range(6):
        a = 2 * math.pi * i / 6
        cyl(b.bm, (cx + (CORE_R + 0.005) * math.cos(a), cy + (CORE_R + 0.005) * math.sin(a), (z0 + z1) / 2), 0.012, 0.012, z1 - z0, a_, seg=6)
    b.build('core_frame', INT)


RISER_H = 0.8


def build_interiors(MT):
    W, O, L, PL = MB(), MB(), MB(), MB()
    RUG = [MB(), MB(), MB()]
    mw, mo = W.m(MT['white']), O.m(MT['oak'])

    def arc_desk(f, a0d, a1d, r0=2.0, r1=2.75):
        a0, a1 = math.radians(a0d), math.radians(a1d)
        arc_solid(O.bm, r0, r1, a0, a1, f + 0.66, f + 0.70, mis=(mo,) * 6, seg=24, bevel=0.008)
        arc_solid(W.bm, r0 + 0.03, r0 + 0.09, a0 + 0.02, a1 - 0.02, f + 0.03, f + 0.66, mis=(mw,) * 6, seg=24)
        arc_solid(W.bm, r1 - 0.09, r1 - 0.03, a0 + 0.02, a1 - 0.02, f + 0.03, f + 0.66, mis=(mw,) * 6, seg=24)
        for a in (a0 + 0.03, a1 - 0.03):
            arc_solid(W.bm, r0 + 0.03, r1 - 0.03, a - 0.02, a + 0.02, f + 0.0, f + 0.66, mis=(mw,) * 6, seg=2)

    def laptops_on(f, angles_deg, r=2.38):
        for ad in angles_deg:
            p = P(r, math.radians(ad), f + 0.70)
            tgt = Vector((0, -1.6, 0))
            face = (tgt.x - p.x, tgt.y - p.y)
            n = math.hypot(*face)
            laptop(L, MT, (p.x, p.y, p.z), (face[0] / n, face[1] / n))

    plants = {1: [(-84, 0)], 2: [(84, 1)], 4: [(-84, 0), (84, 1)]}
    for k, d in DECKS.items():
        f = d['floor']
        rug_c = (0, -0.35 if k != 3 else -0.9)
        cyl(RUG[(k - 1) % 3].bm, (rug_c[0], rug_c[1], f + 0.008), 2.05, 2.05, 0.016, RUG[(k - 1) % 3].m(MT['rug%d' % (((k - 1) % 3) + 1)]), seg=64)
        arc_desk(f, 122, 160)
        arc_desk(f, 200, 238)
        laptops_on(f, (130, 151, 209, 230))
        for ad, sd in plants.get(k, []):
            p = P(2.42, math.radians(ad), f)
            tree(PL, MT, (p.x, p.y, f), 0.8, 3 + sd * 4 + k)
    # deck 3: curved riser (two shallow rows)
    f = DECKS[3]['floor']
    box(W.bm, (0, 0.25, f + (RISER_H - 0.06) / 2), (5.0, 1.6, RISER_H - 0.06), mw, bevel=0.05)
    box(O.bm, (0, 0.25, f + RISER_H - 0.03), (5.06, 1.66, 0.06), mo, bevel=0.02)
    S = W.m(MT['warmstrip'])
    box(W.bm, (0, -0.57, f + 0.07), (4.5, 0.02, 0.035), S)
    W.build('desks_white', INT)
    O.build('desks_oak', INT)
    L.build('laptops', INT)
    PL.build('plants', INT)
    for i, r in enumerate(RUG):
        r.build('rug%d' % i, INT)


# ------------------------------------------------------------------ bots
STATUS = {'working': ('#34C759', 1.5, 0.45), 'idle': ('#8E8E93', 1.0, 0.25), 'waiting_user': ('#FF9F0A', 2.0, 0.6), 'error': ('#FF3B30', 2.0, 0.6)}
BOTS = {  # deck -> list of (id, x, y, z_offset, status)
    4: [('grok-bot', -1.25, -0.55, 0, 'working'), ('jevopus', 1.25, -0.55, 0, 'working')],
    3: [('qt-scout', -2.16, -1.18, 0, 'idle'), ('analytics-analyst', -1.08, -1.18, 0, 'waiting_user'),
        ('x-writer', 0.0, -1.18, 0, 'working'), ('ideas-sparring', 1.08, -1.18, 0, 'error'),
        ('trendy-x', 2.16, -1.18, 0, 'idle'),
        ('banner-visuals', -1.62, 0.32, RISER_H, 'working'), ('codila-x-researcher', -0.54, 0.32, RISER_H, 'working'),
        ('bookmarks-brain', 0.54, 0.32, RISER_H, 'working'), ('competitor-watch', 1.62, 0.32, RISER_H, 'working')],
    2: [('substack', -1.2, -0.5, 0, 'working'), ('x-ads-manager', 1.2, -0.5, 0, 'working')],
    1: [('warren-buffett', -1.2, -0.5, 0, 'working'), ('finance-team', 1.2, -0.5, 0, 'idle')],
}


def set_active_coll(c):
    bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection.children[c.name]


def place_blob(bid, x, y, z, yaw):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(BLOBS, bid + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ v.co for o in new if o.type == 'MESH' for v in o.data.vertices]
    zmin = min(p.z for p in pts)
    cx = (max(p.x for p in pts) + min(p.x for p in pts)) / 2
    cy = (max(p.y for p in pts) + min(p.y for p in pts)) / 2
    piv = bpy.data.objects.new('bot_' + bid, None)
    INT.objects.link(piv)
    for r in [o for o in new if o.parent is None]:
        r.parent = piv
        r.location = r.location - Vector((cx, cy, zmin))
    piv.scale = (BOT_S,) * 3
    piv.location = (x, y, z)
    piv.rotation_euler = (0, 0, yaw)
    return piv


def set_obj_mat(ob, m):
    ob.material_slots[0].link = 'OBJECT'
    ob.material_slots[0].material = m


def build_bots(MT):
    set_active_coll(INT)
    ring = {k: MB() for k in STATUS}
    ringmat = {k: emit_mat('ring_' + k, v[0], v[1]) for k, v in STATUS.items()}
    glowm = {k: glow_mat('glow_' + k, v[0], v[2], 1.5) for k, v in STATUS.items()}
    gme = bpy.data.meshes.new('glowdisc')
    gb = bmesh.new()
    cyl(gb, (0, 0, 0), 1.0, 1.0, 0.002, 0, seg=48)
    gb.to_mesh(gme)
    gb.free()
    gme.materials.append(glowm['working'])
    shm = shadow_mat('cshadow', 0.55)
    jit = [0.06, -0.05, 0.09, -0.08, 0.04, -0.03, 0.07, -0.06, 0.02]
    n = 0
    for k, lst in BOTS.items():
        f = DECKS[k]['floor']
        for (bid, x, y, dz, st) in lst:
            yaw = CAM_AZ + jit[n % len(jit)]
            n += 1
            z = f + dz
            place_blob(bid, x, y, z, yaw)
            rr = 0.55 if bid == 'trendy-x' else 0.47
            torus(ring[st].bm, (x, y, z + 0.045), rr, 0.045, ring[st].m(ringmat[st]), seg=64, tube=10)
            ob = bpy.data.objects.new('glow_' + bid, gme)
            ob.data = gme
            INT.objects.link(ob)
            ob.location = (x, y, z + 0.012)
            ob.scale = (0.72, 0.72, 1.0)
            ob.material_slots  # noqa
            set_obj_mat(ob, glowm[st])
            ob.visible_shadow = False
            sh = bpy.data.objects.new('cshadow_' + bid, gme)
            INT.objects.link(sh)
            sh.location = (x, y, z + 0.006)
            sh.scale = (0.64, 0.64, 1.0)
            set_obj_mat(sh, shm)
            sh.visible_shadow = False
    for k, b in ring.items():
        if b.bm.verts:
            b.build('rings_' + k, INT)
        else:
            b.bm.free()


# ------------------------------------------------------------------ vapour: camera-facing planes with procedural noise
def steam_mat(seed, hw0, hw1, dens, y_len=9.5, sway_amp=0.7, strength=1.8, top_fade=0.2):
    """soft drifting steam, y=0 at the nozzle exit and negative downwards (plane local coords)"""
    m = bpy.data.materials.new('steam%d' % seed)
    t = NT(m)
    tc = t.n('ShaderNodeTexCoord')
    sep = t.n('ShaderNodeSeparateXYZ')
    t.link(tc.outputs['Object'], sep.inputs[0])
    x, y, _ = sep.outputs
    s_ = M(t, 'DIVIDE', M(t, 'MULTIPLY', y, -1.0), y_len, clamp=True)
    sway = M(t, 'MULTIPLY', M(t, 'SINE', M(t, 'ADD', M(t, 'MULTIPLY', s_, 3.0), seed)), M(t, 'MULTIPLY', s_, sway_amp))
    width = M(t, 'ADD', hw0, M(t, 'MULTIPLY', M(t, 'POWER', s_, 0.6), hw1))
    rel = M(t, 'DIVIDE', M(t, 'ABSOLUTE', M(t, 'SUBTRACT', x, sway)), width)
    radial = MR(t, rel, 0.04, 1.0, 1.0, 0.0)
    fadeout = MR(t, s_, 0.30, 1.0, 1.0, 0.0)
    mtop = MR(t, M(t, 'MULTIPLY', y, -1.0), -0.45, top_fade, 0.0, 1.0)
    c1 = t.n('ShaderNodeCombineXYZ')
    t.link(M(t, 'MULTIPLY', x, 0.85), c1.inputs['X'])
    t.link(M(t, 'MULTIPLY', y, 0.75), c1.inputs['Y'])
    c1.inputs['Z'].default_value = seed * 7.3
    n1 = t.n('ShaderNodeTexNoise', noise_dimensions='3D')
    n1.inputs['Scale'].default_value = 1.0
    n1.inputs['Detail'].default_value = 7.0
    n1.inputs['Roughness'].default_value = 0.55
    n1.inputs['Distortion'].default_value = 1.6
    t.link(c1.outputs[0], n1.inputs['Vector'])
    c2 = t.n('ShaderNodeCombineXYZ')
    t.link(M(t, 'MULTIPLY', x, 0.32), c2.inputs['X'])
    t.link(M(t, 'MULTIPLY', y, 0.22), c2.inputs['Y'])
    c2.inputs['Z'].default_value = seed * 3.1 + 11.0
    n2 = t.n('ShaderNodeTexNoise', noise_dimensions='3D')
    n2.inputs['Scale'].default_value = 1.0
    n2.inputs['Detail'].default_value = 3.0
    n2.inputs['Roughness'].default_value = 0.5
    n2.inputs['Distortion'].default_value = 0.7
    t.link(c2.outputs[0], n2.inputs['Vector'])
    comb = M(t, 'ADD', M(t, 'MULTIPLY', n1.outputs['Fac'], 0.58), M(t, 'MULTIPLY', n2.outputs['Fac'], 0.42))
    dn = MR(t, comb, 0.34, 0.70, 0.0, 1.0)
    alpha = M(t, 'MULTIPLY', M(t, 'MULTIPLY', radial, fadeout), M(t, 'MULTIPLY', mtop, M(t, 'MULTIPLY', dn, dens)), clamp=True)
    # colour: hot cool-white near the engines, fading to Earth-glow blue downstream
    mix = t.n('ShaderNodeMix', data_type='RGBA')
    t.link(M(t, 'POWER', s_, 0.7), mix.inputs[0])
    mix.inputs[6].default_value = (0.92, 0.96, 1.0, 1.0)
    mix.inputs[7].default_value = (0.50, 0.68, 1.0, 1.0)
    core = M(t, 'POWER', M(t, 'SUBTRACT', 1.0, s_), 2.5)
    strg = M(t, 'ADD', strength * 0.55, M(t, 'MULTIPLY', core, strength * 1.6))
    em = t.n('ShaderNodeEmission')
    t.link(mix.outputs[2], em.inputs['Color'])
    t.link(strg, em.inputs['Strength'])
    d = _black_diffuse(t)
    ad = t.n('ShaderNodeAddShader')
    t.link(em.outputs[0], ad.inputs[0])
    t.link(d.outputs[0], ad.inputs[1])
    tr = t.n('ShaderNodeBsdfTransparent')
    mx = t.n('ShaderNodeMixShader')
    o = t.n('ShaderNodeOutputMaterial')
    t.link(alpha, mx.inputs[0])
    t.link(tr.outputs[0], mx.inputs[1])
    t.link(ad.outputs[0], mx.inputs[2])
    t.link(mx.outputs[0], o.inputs['Surface'])
    return m


def billboard(name, x0, x1, y0, y1, loc, rot, m):
    bm = bmesh.new()
    v = [bm.verts.new((x0, y0, 0)), bm.verts.new((x1, y0, 0)), bm.verts.new((x1, y1, 0)), bm.verts.new((x0, y1, 0))]
    bm.faces.new(v)
    ob = obj_from(name, bm, [m], EXT)
    ob.location = loc
    ob.rotation_euler = rot
    ob.visible_shadow = False
    return ob


def build_vapour(cam, nozzle_pos):
    back = Vector(cam.matrix_world.to_quaternion() @ Vector((0, 0, -1)))      # away from the camera
    rot = cam.rotation_euler.copy()
    base = Vector((0, 0, 0.0))
    # engine glow discs (flat, camera facing): hot cores under each bell + a soft halo
    gcore = glow_mat('eng_core', '#E4EEFF', 7.0, 1.6)
    ghalo = glow_mat('eng_halo', '#86AEFF', 2.6, 1.5)
    for i, p in enumerate(nozzle_pos):
        c = Vector((p.x, p.y, -0.15)) + back * 0.6
        billboard('gcore%d' % i, -1, 1, -1, 1, c, rot, gcore).scale = (1.25, 1.25, 1)
    billboard('ghalo', -1, 1, -1, 1, Vector((0, 0, -0.7)) + back * 0.7, rot, ghalo).scale = (5.2, 3.8, 1)
    layers = [
        (11, 2.0, 8.4, 0.95, 10.0, 1.4, 1.4, 2.2, 0.30),
        (23, 1.4, 6.2, 1.20, 9.5, 1.0, 1.8, 0.9, 0.16),
        (37, 1.0, 4.4, 0.75, 8.5, -1.0, 1.9, -1.5, 0.30),
    ]
    for (seed, hw0, hw1, dens, ylen, sa, strg, dz, tf) in layers:
        mt = steam_mat(seed, hw0, hw1, dens, ylen, sa, strg, tf)
        c = base + back * dz
        billboard('steam%d' % seed, -7.0, 7.0, -ylen - 1.0, 1.0, c, rot, mt)


# ------------------------------------------------------------------ lights / world / camera
def add_light(kind, name, loc, target=None, energy=100.0, color=(1, 1, 1), size=1.0, size_y=None, shape=None,
              link=None, angle=None, radius=None):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy
    ld.color = color
    if kind == 'AREA':
        ld.shape = shape or ('RECTANGLE' if size_y else 'SQUARE')
        ld.size = size
        if size_y:
            ld.size_y = size_y
    elif kind == 'SUN':
        ld.angle = math.radians(angle or 4.0)
    elif kind == 'POINT':
        ld.shadow_soft_size = radius or 0.2
    lo = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(lo)
    lo.location = loc
    if target is not None:
        lo.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    if link is not None:
        try:
            lo.light_linking.receiver_collection = link
        except Exception as e:
            print('light linking failed', e)
    return lo


def add_softbox(name, loc, target, sx, sy, color, strength, link=None):
    bm = bmesh.new()
    box(bm, (0, 0, 0), (sx, sy, 0.02), 0)
    for f in bm.faces:
        f.material_index = 0
    m = emit_mat('sb_' + name, color, strength)
    ob = obj_from('softbox_' + name, bm, [m], EXT)
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('Z', 'Y').to_euler()
    ob.visible_camera = False
    ob.visible_shadow = False
    try:
        ob.light_linking.receiver_collection = EXT
    except Exception as e:
        print('softbox link', e)
    return ob


def setup_world():
    w = bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    t = NT.__new__(NT)
    t.nt = w.node_tree
    for n in list(t.nt.nodes):
        t.nt.nodes.remove(n)
    tc = t.n('ShaderNodeTexCoord')
    sep = t.n('ShaderNodeSeparateXYZ')
    t.link(tc.outputs['Generated'], sep.inputs[0])
    ramp = t.n('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'EASE'
    els = ramp.color_ramp.elements
    els[0].position = 0.0
    els[0].color = (0.08, 0.22, 0.75, 1)
    els[1].position = 1.0
    els[1].color = (0.045, 0.055, 0.085, 1)
    e = els.new(0.38)
    e.color = (0.028, 0.065, 0.20, 1)
    e = els.new(0.50)
    e.color = (0.022, 0.030, 0.060, 1)
    # map z (-1..1) to 0..1
    mp = MR(t, sep.outputs['Z'], -1.0, 1.0, 0.0, 1.0, smooth=False)
    t.link(mp, ramp.inputs['Fac'])
    bg = t.n('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = 1.0
    t.link(ramp.outputs['Color'], bg.inputs['Color'])
    o = t.n('ShaderNodeOutputWorld')
    t.link(bg.outputs[0], o.inputs['Surface'])


def setup_cycles(sc):
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
    sc.cycles.samples = SAMPLES
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.015
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = 'OPTIX' if ok else 'OPENIMAGEDENOISE'
    except Exception:
        pass
    sc.cycles.max_bounces = 8
    sc.cycles.diffuse_bounces = 4
    sc.cycles.glossy_bounces = 6
    sc.cycles.transmission_bounces = 4
    sc.cycles.transparent_max_bounces = 24
    sc.cycles.volume_bounces = 2
    sc.cycles.sample_clamp_indirect = 8.0
    sc.cycles.sample_clamp_direct = 0.0
    try:
        sc.cycles.volume_step_rate = 0.7
        sc.cycles.volume_max_steps = 256
    except Exception:
        pass
    sc.render.film_transparent = True
    sc.render.resolution_x, sc.render.resolution_y = RES
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.color_depth = '8'
    sc.view_settings.view_transform = 'AgX'
    for look in ('AgX - Medium High Contrast', 'Medium High Contrast', 'AgX - Punchy', 'Punchy'):
        try:
            sc.view_settings.look = look
            break
        except Exception:
            continue
    sc.view_settings.exposure = EXPOSURE


EXPOSURE = 0.0
TARGET_EXT, TOP_Y, AX_X = 0.845, 0.975, 0.668


def setup_camera(sc):
    cd = bpy.data.cameras.new('Camera')
    cd.lens = 150
    cd.sensor_width = 36
    cd.sensor_fit = 'HORIZONTAL'
    cd.clip_start = 5
    cd.clip_end = 3000
    cam = bpy.data.objects.new('Camera', cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    dirv = Vector((math.sin(CAM_AZ) * math.cos(CAM_EL), -math.cos(CAM_AZ) * math.cos(CAM_EL), math.sin(CAM_EL)))
    tgt = Vector((0, 0, Z_TIP * 0.5))
    D = 140.0
    for it in range(10):
        cam.location = tgt + dirv * D
        cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.view_layer.update()
        pt = world_to_camera_view(sc, cam, Vector((0, 0, Z_TIP)))
        pb = world_to_camera_view(sc, cam, Vector((0, 0, 0)))
        ext = pt.y - pb.y
        D *= ext / TARGET_EXT
        cd.shift_x -= (AX_X - pt.x)
        cd.shift_y -= (TOP_Y - pt.y) * (RES[1] / RES[0])
    print('camera D=%.1f shift=(%.3f, %.3f) ext=%.3f' % (D, cd.shift_x, cd.shift_y, ext))
    return cam


def main():
    t0 = time.time()
    global EXT, INT
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    EXT = new_coll('EXT')
    INT = new_coll('INT')
    MT = build_materials()
    build_hull(MT)
    build_flaps(MT)
    build_logo(MT)
    nozzle_pos = build_engines(MT)
    build_decks(MT)
    build_core(MT)
    build_interiors(MT)
    build_bots(MT)
    # ---- lights
    Z_MID = Z_TIP * 0.5
    add_light('SUN', 'moon_key', (0, 0, 40), target=(0.62, 0.52, 39.0 - 0.0), energy=LIGHT_KEY, color=(0.80, 0.89, 1.0), angle=5.0, link=EXT)
    sun = bpy.data.objects['moon_key']
    s_dir = Vector((-0.60, -0.50, 0.62)).normalized()
    sun.rotation_euler = (-s_dir).to_track_quat('-Z', 'Y').to_euler()
    add_light('AREA', 'earth_rim', (-1.5, 3.0, -9.0), target=(0, 0, 7.0), energy=LIGHT_RIM, color=(0.25, 0.50, 1.0), size=16, link=EXT)
    add_light('AREA', 'back_rim', (9.5, 9.0, 11.0), target=(0, 0, 9.0), energy=LIGHT_BACK, color=(0.45, 0.70, 1.0), size=6, size_y=18, link=EXT)
    add_light('AREA', 'ext_fill', (-8.0, -14.0, 7.0), target=(0, 0, 8.0), energy=LIGHT_FILL, color=(0.62, 0.75, 1.0), size=10, link=EXT)
    for k, d in DECKS.items():
        f, c = d['floor'], d['ceil']
        big = k == 3
        add_light('AREA', 'deck%d_main' % k, (0, -0.3, c - 0.06), target=(0, -0.3, f), energy=LIGHT_DECK * (1.5 if big else 1.0),
                  color=(1.0, 0.80, 0.58), size=1.9, shape='DISK')
        add_light('AREA', 'deck%d_front' % k, (0, -2.45, c - 0.35), target=(0, 0.0, f + 0.55), energy=LIGHT_FRONT * (1.4 if big else 1.0),
                  color=(1.0, 0.86, 0.70), size=3.6, size_y=0.5)
        add_light('AREA', 'deck%d_back' % k, (0, 2.3, c - 0.2), target=(0, -0.5, f + 0.4), energy=LIGHT_BACKW * (1.3 if big else 1.0),
                  color=(1.0, 0.82, 0.62), size=3.4, size_y=0.4)
    for i, p in enumerate(nozzle_pos):
        add_light('POINT', 'eng%d' % i, (p.x, p.y, -0.5), energy=LIGHT_ENGINE, color=(0.62, 0.80, 1.0), radius=0.5)
    if SOFTBOX:
        add_softbox('left', (-14, -10, 9.5), (0, 0, 9.5), 2.0, 24, '#E4F0FF', SB_LEFT)
        add_softbox('right', (14, -9, 10), (0, 0, 9.5), 1.0, 22, '#FFF0DC', SB_RIGHT)
        add_softbox('top', (-3, -6, 34), (0, 0, 14), 16, 16, '#BBD2FF', SB_TOP)
    setup_world()
    setup_cycles(sc)
    cam = setup_camera(sc)
    if not NOFOG:
        build_vapour(cam, nozzle_pos)
    sc.render.filepath = OUT_PNG
    print('setup %.1fs' % (time.time() - t0))
    t1 = time.time()
    bpy.ops.render.render(write_still=True)
    print('RENDER %.1fs -> %s' % (time.time() - t1, OUT_PNG))
    if 'save' in ARGS:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, '_rocket.blend'))


LIGHT_KEY, LIGHT_RIM, LIGHT_BACK, LIGHT_FILL = 6.0, 650.0, 650.0, 400.0
SOFTBOX, SB_LEFT, SB_RIGHT, SB_TOP = True, 12.0, 5.0, 2.2
LIGHT_DECK, LIGHT_FRONT, LIGHT_BACKW, LIGHT_ENGINE = 135.0, 55.0, 30.0, 300.0

main()
