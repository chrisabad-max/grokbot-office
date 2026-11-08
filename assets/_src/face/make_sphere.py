# The wallpaper's hero: the approved glossy sphere (mockups/wallpaper/base.png, from the user's ChatGPT frame) with its
# painted eyes removed, so the page can draw live eyes on it. Eyes are filled by harmonic inpainting (the shading is
# smooth there), then the visible cap is cut out with an antialiased circle.
# blender -b --factory-startup -P make_sphere.py
import bpy, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SRC = os.path.join(ROOT, 'mockups', 'wallpaper', 'base.png')
OUT = os.path.join(ROOT, 'assets', 'face')
CX, CY, R = 999.5, 1196.58, 683.58          # the sphere's circle in the 2000x1125 frame (fitted by compose.py)


def load(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[::-1].copy()


def save(arr, path):
    h, w = arr.shape[:2]
    img = bpy.data.images.new('out', w, h, alpha=True)
    img.alpha_mode = 'STRAIGHT'
    img.pixels.foreach_set(np.ascontiguousarray(arr[::-1], dtype=np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()


def box(a, r):                               # separable box blur via cumulative sums
    if r < 1:
        return a
    p = np.pad(a, ((r, r), (r, r), (0, 0)), mode='edge')
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0), (0, 0)))
    k = 2 * r + 1
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


img = load(SRC)
H, W = img.shape[:2]
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
d = np.sqrt((xx - CX) ** 2 + (yy - CY) ** 2)
inside = d < R - 6
lum = img[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)

# eyes: the dark blobs on the face, grown a little to take their soft edge
eye = inside & (lum < 0.30) & (yy < 1000)
grow = eye.copy()
for _ in range(26):                          # past the glossy rim around each eye
    g = grow.copy()
    g[1:] |= grow[:-1]; g[:-1] |= grow[1:]; g[:, 1:] |= grow[:, :-1]; g[:, :-1] |= grow[:, 1:]
    grow = g
mask = grow & inside
print('eye pixels', int(mask.sum()))

# harmonic fill, coarse to fine: unknown pixels take the blurred value of their neighbourhood
col = img[..., :3].copy()
col[mask] = col[~mask & inside].mean(0)
for r in [48] * 30 + [24] * 40 + [12] * 60 + [6] * 80 + [3] * 120 + [1] * 160:
    b = box(col, r)
    col[mask] = b[mask]

alpha = np.clip(R - d + 0.5, 0, 1)
x0, x1 = int(np.floor(CX - R)), int(np.ceil(CX + R))
y0 = int(np.floor(CY - R))
out = np.concatenate([col, alpha[..., None]], axis=2)[y0:H, max(0, x0):min(W, x1)]
os.makedirs(OUT, exist_ok=True)
save(out, os.path.join(OUT, 'sphere.png'))
print('crop', max(0, x0), y0, min(W, x1), H, '->', out.shape[1], 'x', out.shape[0])
