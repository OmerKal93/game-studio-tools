"""Review renders of kit pieces (EEVEE): a three-quarter view and a street-level view (eye 1.6 m) of each piece's LOD0, plus the LOD1
three-quarter, with the game's colour textures box-mapped through the exported UVs and multiplied by the baked vertex colour.

usage:
  node tools/blender-run.mjs blender/render_views.py -- <kit.blend> <spec.json> <outDir> [id,id]
spec.json: {"textures": "<dir with <slot>-color.webp>", "grades": {"stone": [r,g,b], ...}, "alias": {"oak": "wood", "canvas": "plaster"},
            "pieces": {"<id>": {"front": [x, z]}}}   front = the piece's facing direction in game x/z (default [0, 1]).
Writes <outDir>/<id>-34.png, <id>-street.png, <id>-lod1.png."""
import bpy, sys, os, json, math
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
blend, spec_path, out = argv[0], argv[1], argv[2]
only = set(argv[3].split(',')) if len(argv) > 3 and argv[3] else None
spec = json.load(open(spec_path, encoding='utf8'))
bpy.ops.wm.open_mainfile(filepath=blend)
os.makedirs(out, exist_ok=True)
sc = bpy.context.scene
eng = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in eng else 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 960, 720
sc.view_settings.view_transform = 'AgX' if 'AgX' in [i.identifier for i in sc.view_settings.bl_rna.properties['view_transform'].enum_items] else 'Filmic'
try:
    sc.eevee.use_shadows = True
    sc.eevee.use_gtao = True
except Exception:
    pass

# world + sun
world = bpy.data.worlds.new('w')
sc.world = world
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs['Color'].default_value = (0.42, 0.55, 0.75, 1)
bg.inputs['Strength'].default_value = 0.9
sun_d = bpy.data.lights.new('sun', 'SUN')
sun_d.energy = 4.2
sun_d.color = (1, 0.95, 0.87)
sun_d.angle = math.radians(1.5)
sun = bpy.data.objects.new('sun', sun_d)
sc.collection.objects.link(sun)
ground = bpy.data.meshes.new('ground')
ground.from_pydata([(-60, -60, 0), (60, -60, 0), (60, 60, 0), (-60, 60, 0)], [], [(0, 1, 2, 3)])
gob = bpy.data.objects.new('ground', ground)
sc.collection.objects.link(gob)
gm = bpy.data.materials.new('ground')
gm.diffuse_color = (0.16, 0.15, 0.12, 1)
gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.12, 0.12, 0.09, 1)
gm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 1
ground.materials.append(gm)

# textured materials: base = texture x grade x vertex colour
tex_dir, grades, alias = spec.get('textures'), spec.get('grades', {}), spec.get('alias', {})
for m in bpy.data.materials:
    if m.name in ('ground',):
        continue
    slot = alias.get(m.name, m.name)
    path = os.path.join(tex_dir, f'{slot}-color.webp') if tex_dir else None
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    if not bsdf:
        continue
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Color'
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type, mul.blend_type = 'RGBA', 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    if path and os.path.exists(path):
        img = nt.nodes.new('ShaderNodeTexImage')
        img.image = bpy.data.images.load(path)
        g = grades.get(m.name, grades.get(slot, [1, 1, 1]))
        gr = nt.nodes.new('ShaderNodeMix')
        gr.data_type, gr.blend_type = 'RGBA', 'MULTIPLY'
        gr.inputs['Factor'].default_value = 1.0
        nt.links.new(img.outputs['Color'], gr.inputs['A'])
        gr.inputs['B'].default_value = (*g, 1)
        nt.links.new(gr.outputs['Result'], mul.inputs['A'])
    else:
        mul.inputs['A'].default_value = bsdf.inputs['Base Color'].default_value
    nt.links.new(vc.outputs['Color'], mul.inputs['B'])
    nt.links.new(mul.outputs['Result'], bsdf.inputs['Base Color'])

cam_d = bpy.data.cameras.new('cam')
cam = bpy.data.objects.new('cam', cam_d)
sc.collection.objects.link(cam)
sc.camera = cam
G2B = lambda x, y, z: Vector((x, -z, y))


def look(eye, target, lens):
    cam.location = eye
    cam.rotation_euler = (target - eye).to_track_quat('-Z', 'Y').to_euler()
    cam_d.lens = lens


def bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs if o.type == 'MESH' for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


roots = [o for o in bpy.data.objects if o.type == 'EMPTY' and '_LOD' in o.name]
pieces = sorted({r.name.split('_v')[0].split('_LOD')[0] for r in roots})
for pid in pieces:
    if only and pid not in only:
        continue
    f = spec.get('pieces', {}).get(pid, {}).get('front', [0, 1])
    for lod in (0, 1):
        show = [r for r in roots if r.name in (f'{pid}_LOD{lod}', f'{pid}_v0_LOD{lod}')]
        for r in roots:
            vis = r in show
            for o in [r] + list(r.children_recursive):
                o.hide_render = not vis
        objs = [c for r in show for c in r.children_recursive]
        lo, hi = bounds(objs)
        c = (lo + hi) / 2
        size = (hi - lo).length
        fx, fz = f
        fwd = G2B(fx, 0, fz).normalized()
        side = G2B(-fz, 0, fx).normalized()
        views = [('34', fwd * 0.8 + side * 0.65, 0.42, 1.2)] if lod else [('34', fwd * 0.8 + side * 0.65, 0.42, 1.2), ('street', fwd * 0.92 - side * 0.38, 0.0, 0.85)]
        for name, dirv, elev, dist in views:
            dirv = dirv.normalized()
            if name == 'street':
                eye = c + dirv * (size * dist + 1.0)
                eye.z = 1.6
                tgt = Vector((c.x, c.y, min(hi.z * 0.5, 2.4)))
                look(eye, tgt, 24)
            else:
                eye = c + (dirv + Vector((0, 0, elev))).normalized() * size * dist * 1.05
                look(eye, c, 35)
            # sun from the front-left, 38 degrees up
            sdir = (fwd * 0.6 + side * 0.8).normalized()
            sun.rotation_euler = (Vector((0, 0, 0)) - (sdir + Vector((0, 0, 0.78)))).to_track_quat('-Z', 'Y').to_euler()
            sc.render.filepath = os.path.join(out, f'{pid}-{name if lod == 0 else "lod1"}.png')
            bpy.ops.render.render(write_still=True)
            print('RENDER', sc.render.filepath)
