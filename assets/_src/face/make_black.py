# The BLACK Grok Bot ball, rendered as a real 3D object: a glossy black sphere (clear coat over a slightly rough black
# base) in a small studio, so it has true volume: a soft softbox reflection at the upper left (where the white ball
# has its streak), the body falling off to the lower right, a thin crisp rim of back light along the top edge and a
# little reflected light at the bottom. An orthographic camera puts the ball exactly where sphere.png has it
# (centre (684.5, 684.58), radius 683.58 px), so it fits the same clip and eyes; only the top 613 rows are kept.
# The eyes are the white ball's own painted eyes made light (1 - their multiply layer), screened on by the page.
# Writes assets/face/sphere-black.png, eye-l-wht.png, eye-r-wht.png.
# blender -b --factory-startup -P make_black.py   (Cycles, GPU when available)
import bpy, os, math
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
FACE = os.path.join(ROOT, 'assets', 'face')
TMP = os.path.join(HERE, '_black_render.png')
W, KEEP, R_PX = 1369, 613, 683.58
EYE_LIFT = 1.08                          # the light eyes' core reaches white

# studio, in Blender units (ball radius 1; camera looks along +Y, image up = +Z, image right = +X)
STREAK = dict(loc=(-3.1, 1.8, 2.8), size=(1.6, 0.9), energy=260, shape='ELLIPSE')   # small softbox up-left behind: a curved streak near the edge
RIM = dict(loc=(1.0, 4.5, 3.8), size=(4.0, 0.5), energy=300, shape='RECTANGLE')    # back light: a thin crisp edge on top
FILL = dict(loc=(0.8, -3.0, -3.2), size=(4.0, 2.0), energy=60, shape='RECTANGLE')  # floor bounce: a little light at the bottom
BASE_COLOR, BASE_ROUGH, COAT_ROUGH = (0.010, 0.011, 0.014, 1), 0.45, 0.09


def area(name, loc, size, energy, shape):
    light = bpy.data.lights.new(name, 'AREA')
    light.shape, light.size, light.size_y, light.energy = shape, size[0], size[1], energy
    obj = bpy.data.objects.new(name, light)
    obj.location = loc
    bpy.context.scene.collection.objects.link(obj)
    look = obj.constraints.new('TRACK_TO')                 # aim at the ball
    look.target, look.track_axis, look.up_axis = ball, 'TRACK_NEGATIVE_Z', 'UP_Y'


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = 'GPU'
                break
        except TypeError:
            continue
except Exception:
    pass
scene.cycles.samples, scene.cycles.use_denoising = 384, True
scene.render.resolution_x = scene.render.resolution_y = W
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.view_settings.view_transform = 'Standard'

bpy.ops.mesh.primitive_uv_sphere_add(segments=256, ring_count=128, radius=1.0)
ball = bpy.context.active_object
bpy.ops.object.shade_smooth()
mat = bpy.data.materials.new('black')
mat.use_nodes = True
bsdf = mat.node_tree.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value = BASE_COLOR
bsdf.inputs['Roughness'].default_value = BASE_ROUGH
bsdf.inputs['Coat Weight'].default_value = 1.0
bsdf.inputs['Coat Roughness'].default_value = COAT_ROUGH
ball.data.materials.append(mat)

cam_data = bpy.data.cameras.new('cam')
cam_data.type, cam_data.ortho_scale = 'ORTHO', W / R_PX
cam = bpy.data.objects.new('cam', cam_data)
cam.location, cam.rotation_euler = (0, -10, 0), (math.radians(90), 0, 0)
scene.collection.objects.link(cam)
scene.camera = cam

for name, spec in (('streak', STREAK), ('rim', RIM), ('fill', FILL)):
    area(name, **spec)

# a dark studio, lighter overhead: the broad, edgeless sheen on the upper half of the ball (no light shape to show)
world = bpy.data.worlds.new('studio')
scene.world = world
world.use_nodes = True
nt = world.node_tree
coord, sep, ramp = nt.nodes.new('ShaderNodeTexCoord'), nt.nodes.new('ShaderNodeSeparateXYZ'), nt.nodes.new('ShaderNodeValToRGB')
mapr = nt.nodes.new('ShaderNodeMapRange')
mapr.inputs['From Min'].default_value, mapr.inputs['From Max'].default_value = -1.0, 1.0
nt.links.new(coord.outputs['Generated'], sep.inputs[0])
nt.links.new(sep.outputs['Z'], mapr.inputs['Value'])
nt.links.new(mapr.outputs['Result'], ramp.inputs['Fac'])
ramp.color_ramp.elements[0].color = (0.002, 0.002, 0.003, 1)
ramp.color_ramp.elements[1].position, ramp.color_ramp.elements[1].color = 1.0, (0.13, 0.135, 0.15, 1)
mid = ramp.color_ramp.elements.new(0.5)
mid.color = (0.008, 0.008, 0.010, 1)
nt.links.new(ramp.outputs['Color'], nt.nodes['Background'].inputs['Color'])

scene.render.filepath = TMP
bpy.ops.render.render(write_still=True)


def load(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[::-1].copy()


def save(rgba, path):
    h, w = rgba.shape[:2]
    img = bpy.data.images.new('out', w, h, alpha=True)
    img.alpha_mode = 'STRAIGHT'
    img.pixels.foreach_set(np.ascontiguousarray(rgba[::-1], dtype=np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()


save(load(TMP)[:KEEP], os.path.join(FACE, 'sphere-black.png'))
os.remove(TMP)
for side in ('l', 'r'):
    mul = load(os.path.join(FACE, f'eye-{side}-mul.png'))
    light = np.clip((1 - mul[..., :3]) * EYE_LIFT, 0, 1)
    save(np.concatenate([light, mul[..., 3:]], axis=2), os.path.join(FACE, f'eye-{side}-wht.png'))
print('black ball rendered + light eyes written, device:', scene.cycles.device)
