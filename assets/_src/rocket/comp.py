# Preview helper: composite rocket.png over a background (or crop+zoom a region).
#   blender -b --factory-startup -P comp.py -- fg.png bg.png out.png [x0 y0 x1 y1 [scale]]
import bpy, sys, numpy as np

a = sys.argv[sys.argv.index('--') + 1:]
fg_p, bg_p, out_p = a[0], a[1], a[2]
box = [int(v) for v in a[3:7]] if len(a) >= 7 else None
scale = float(a[7]) if len(a) >= 8 else 1.0


def load(p):
    im = bpy.data.images.load(p)
    im.colorspace_settings.name = 'Non-Color'
    try:
        im.alpha_mode = 'STRAIGHT'
    except Exception:
        pass
    w, h = im.size
    arr = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(arr)
    return arr.reshape(h, w, 4)[::-1], w, h  # top row first


fg, w, h = load(fg_p)
if bg_p != '-':
    bg, bw, bh = load(bg_p)
    if (bw, bh) != (w, h):
        # nearest resize
        yi = (np.arange(h) * bh // h)
        xi = (np.arange(w) * bw // w)
        bg = bg[yi][:, xi]
else:
    bg = np.zeros_like(fg)
    bg[..., :3] = (0.05, 0.07, 0.12)
    bg[..., 3] = 1.0
al = fg[..., 3:4]
rgb = fg[..., :3] * al + bg[..., :3] * (1 - al)
out = np.concatenate([rgb, np.ones_like(al)], axis=2)
if box:
    x0, y0, x1, y1 = box
    out = out[y0:y1, x0:x1]
    if scale != 1.0:
        hh, ww = out.shape[:2]
        nh, nw = int(hh * scale), int(ww * scale)
        yi = np.minimum((np.arange(nh) / scale).astype(int), hh - 1)
        xi = np.minimum((np.arange(nw) / scale).astype(int), ww - 1)
        out = out[yi][:, xi]
hh, ww = out.shape[:2]
img = bpy.data.images.new('out', ww, hh, alpha=True)
img.colorspace_settings.name = 'Non-Color'
img.pixels.foreach_set(np.ascontiguousarray(out[::-1]).ravel())
img.filepath_raw = out_p
img.file_format = 'PNG'
img.save()
print('wrote', out_p, ww, hh)
