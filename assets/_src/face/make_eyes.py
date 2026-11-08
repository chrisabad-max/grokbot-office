# The original eyes of the approved Grok Bot frame, as movable layers. For each eye, two full-colour images that
# reproduce it exactly over the eyeless sphere (sphere.png): a multiply layer (where the eye darkens the surface)
# and a screen layer (its light rim). Moving them keeps the eye's own shading, rim and softness.
# Writes assets/face/eye-l-mul.png, eye-l-scr.png, eye-r-*.png and eyes.json (positions in sphere.png pixels, and
# each eye's lean).
# blender -b --factory-startup -P make_eyes.py
import bpy, os, json, math
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'face')
CX, CY, R = 999.5, 1196.58, 683.58
CROP = (315, 512)                                   # sphere.png's top-left in the 2000x1125 frame
PAD = 30


def load(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[::-1].copy()


def save(arr, path, alpha):
    h, w = arr.shape[:2]
    img = bpy.data.images.new('out', w, h, alpha=True)
    img.alpha_mode = 'STRAIGHT'
    rgba = np.concatenate([arr, alpha.astype(np.float32)], axis=2)
    img.pixels.foreach_set(np.ascontiguousarray(rgba[::-1], dtype=np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()


def box(a, r):
    p = np.pad(a, ((r, r), (r, r), (0, 0)), mode='edge')
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0), (0, 0)))
    k = 2 * r + 1
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def grow(m, n):
    for _ in range(n):
        g = m.copy()
        g[1:] |= m[:-1]; g[:-1] |= m[1:]; g[:, 1:] |= m[:, :-1]; g[:, :-1] |= m[:, 1:]
        m = g
    return m


orig = load(os.path.join(ROOT, 'mockups', 'wallpaper', 'base.png'))[..., :3]
H, W = orig.shape[:2]
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
inside = np.sqrt((xx - CX) ** 2 + (yy - CY) ** 2) < R - 6
lum = orig @ np.array([0.2126, 0.7152, 0.0722], np.float32)
core = inside & (lum < 0.30) & (yy < 1000)
mask = grow(core, 26) & inside

# the same eyeless surface sphere.png was made from (harmonic fill)
clean = orig.copy()
clean[mask] = clean[~mask & inside].mean(0)
for r in [48] * 30 + [24] * 40 + [12] * 60 + [6] * 80 + [3] * 120 + [1] * 160:
    b = box(clean, r)
    clean[mask] = b[mask]

eps = 1e-4
mul = np.where(orig < clean, orig / np.maximum(clean, eps), 1.0)
scr = np.where(orig > clean, 1 - (1 - orig) / np.maximum(1 - clean, eps), 0.0)
mul[~mask] = 1.0
scr[~mask] = 0.0

# split the two eyes: left / right of the gap between their cores
cols = np.where(core.any(axis=0))[0]
gaps = np.where(np.diff(cols) > 20)[0]
split = int((cols[gaps[0]] + cols[gaps[0] + 1]) / 2) if len(gaps) else int(CX)
info = {}
for name, sel in (('l', xx < split), ('r', xx >= split)):
    m = mask & sel
    ys, xs = np.where(m)
    x0, x1, y0, y1 = xs.min() - PAD, xs.max() + PAD + 1, ys.min() - PAD, ys.max() + PAD + 1
    cy_, cx_ = np.argwhere(core & sel).mean(0)
    # the pill's long axis (the painted eyes lean), clockwise from vertical: blinks squash along it
    ys_, xs_ = np.where(core & sel)
    vx, vy = np.linalg.eigh(np.cov(np.vstack([xs_ - xs_.mean(), ys_ - ys_.mean()])))[1][:, 1]
    if vy > 0: vx, vy = -vx, -vy
    axis = math.degrees(math.atan2(vx, -vy))
    along = (xs_ - xs_.mean()) * vx + (ys_ - ys_.mean()) * vy          # the dark pill's length and width
    across = (xs_ - xs_.mean()) * -vy + (ys_ - ys_.mean()) * vx
    sub = (slice(y0, y1), slice(x0, x1))
    keep = m[sub][..., None]
    # outside the eye the layers are transparent, so nothing shows past the sphere's edge
    save(np.where(keep, mul[sub], 1.0), os.path.join(OUT, f'eye-{name}-mul.png'), keep)
    save(np.where(keep, scr[sub], 0.0), os.path.join(OUT, f'eye-{name}-scr.png'), keep)
    info[name] = {'x': int(x0 - CROP[0]), 'y': int(y0 - CROP[1]), 'w': int(x1 - x0), 'h': int(y1 - y0),
                  'cx': round(float(cx_ - CROP[0]), 1), 'cy': round(float(cy_ - CROP[1]), 1), 'axis': round(axis, 1),
                  'len': round(float(np.ptp(along))), 'wid': round(float(np.ptp(across)))}
info['sphere'] = {'w': 1369, 'h': 613}
with open(os.path.join(OUT, 'eyes.json'), 'w') as fh:
    json.dump(info, fh, indent=1)
print('eyes', json.dumps(info))
