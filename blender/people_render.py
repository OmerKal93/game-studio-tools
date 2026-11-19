"""Cycles look-test renders of an MPFB character blend: node tools/blender-run.mjs blender/people_render.py -- <in.blend> <outDir> <views> <times> [samples] [res]
views: comma list of front,three,face,profile,side  times: noon,dusk  -> <outDir>/<name>-<view>-<time>.png
Lighting matches the game's atmosphere: noon = high sun, cool sky, dusk = low warm sun (elevation 7 deg) with a blue-purple sky fill."""
import bpy, sys, os, math
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
src, out, views, times = a[0], a[1], a[2].split(','), a[3].split(',')
samples = int(a[4]) if len(a) > 4 else 64
H = int(a[5]) if len(a) > 5 else 900
os.makedirs(out, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=src)
sc = bpy.context.scene
for n in os.environ.get('PEOPLE_HIDE','').split(','):
    if n in bpy.data.objects: bpy.data.objects[n].hide_render = True
name = os.path.basename(src).split('-render')[0]
for o in list(bpy.data.objects):
    if o.type in ('CAMERA', 'LIGHT') or o.name == 'Cube': bpy.data.objects.remove(o)
sc.render.engine = 'CYCLES'; sc.cycles.samples = samples; sc.cycles.use_denoising = True
try:
    pr = bpy.context.preferences.addons['cycles'].preferences; pr.compute_device_type = 'NONE'
except Exception: pass
sc.cycles.device = 'CPU'
sc.render.resolution_x = int(H * 0.72); sc.render.resolution_y = H
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'None'
# ground (flagstone-ish grey) so light bounces like off a paved yard
bpy.ops.mesh.primitive_plane_add(size=30); g = bpy.context.active_object
gm = bpy.data.materials.new('ground'); gm.use_nodes = True
bs = gm.node_tree.nodes['Principled BSDF']; bs.inputs['Base Color'].default_value = (0.13, 0.105, 0.08, 1); bs.inputs['Roughness'].default_value = 0.9
g.data.materials.append(gm)
objs = [o for o in bpy.data.objects if o.type == 'MESH' and o is not g]
mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
for o in objs:
    if o.hide_render: continue
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c); mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
height = mx.z - mn.z; cx = (mn.x + mx.x) / 2; cy = (mn.y + mx.y) / 2
head_z = mn.z + height * 0.93
head_xy = (cx, cy)
for a_ in bpy.data.objects:
    if a_.type == 'ARMATURE' and 'mixamorig:Head' in a_.data.bones:
        hp = a_.matrix_world @ a_.pose.bones['mixamorig:Head'].head   # posed head: the cloak and hood make the bounding box off-centre
        head_xy = (hp.x, hp.y); head_z = hp.z + 0.09
SUN = {'noon': dict(el=58, az=210, strength=3.2, color=(1.0, 0.96, 0.9), sky_density=1.0, sky_exposure=0.0),
       'dusk': dict(el=7, az=250, strength=2.4, color=(1.0, 0.62, 0.36), sky_density=1.0, sky_exposure=-1.5)}
def setup_world(t):
    p = SUN[t]
    w = bpy.data.worlds.new('w'); w.use_nodes = True; sc.world = w
    nt = w.node_tree; nt.nodes.clear()
    sky = nt.nodes.new('ShaderNodeTexSky'); sky.sky_type = 'NISHITA'
    sky.sun_elevation = math.radians(p['el']); sky.sun_rotation = math.radians(p['az']); sky.sun_disc = False; sky.air_density = 1.0; sky.dust_density = 1.2 if t == 'dusk' else 0.6
    bg = nt.nodes.new('ShaderNodeBackground'); bg.inputs['Strength'].default_value = 1.0 if t == 'noon' else 0.9
    o = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(sky.outputs[0], bg.inputs[0]); nt.links.new(bg.outputs[0], o.inputs[0])
    for l in [x for x in bpy.data.objects if x.type == 'LIGHT']: bpy.data.objects.remove(l)
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = p['strength']; sun.color = p['color']; sun.angle = math.radians(0.6)
    so = bpy.data.objects.new('sun', sun); sc.collection.objects.link(so)
    # sun direction: from az (compass, game-like) and elevation; camera looks at +y so light from front-left-above reads the face
    el = math.radians(p['el']); az = math.radians(p['az'] - 180)
    so.rotation_euler = (math.pi / 2 - el, 0, az + math.pi)
def cam(view):
    c = bpy.data.cameras.new('cam'); co = bpy.data.objects.new('cam', c); sc.collection.objects.link(co); sc.camera = co
    tgt = Vector((cx, cy, mn.z + height * 0.5)); dist = height * 2.6; lens = 50
    yaw = {'front': 0, 'three': 35, 'profile': 90, 'side': 90}.get(view, 0)
    if view in ('face', 'face3'):
        tgt = Vector((head_xy[0], head_xy[1], head_z)); dist = 0.95; lens = 85; yaw = 0 if view == 'face' else 30
    if view == 'arms':
        tgt = Vector((cx, cy, mn.z + height * 0.68)); dist = 1.6; lens = 60; yaw = 20
    c.lens = lens; c.clip_end = 100
    a = math.radians(yaw)
    co.location = tgt + Vector((math.sin(a) * dist, -math.cos(a) * dist, 0.1 if view.startswith('face') else 0.0))
    d = tgt - co.location; co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return co
for t in times:
    setup_world(t)
    for v in views:
        co = cam(v)
        sc.render.filepath = os.path.join(out, f'{name}-{v}-{t}.png')
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(co)
