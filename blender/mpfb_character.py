"""Build one realistic human with MPFB2 (MakeHuman; plugin GPLv3, assets and outputs CC0) in the portable Blender.
usage: node tools/blender-run.mjs blender/mpfb_character.py --timeout 900 -- <spec.json> <outDir> <mode>
  mode = render  ENHANCED_SSS skin, saved as <name>-render.blend (standing pose from the first idle frame) for Cycles (blender/people_render.py)
  mode = game    GAMEENGINE principled materials, helpers stripped, covered body faces culled, Mixamo clips retargeted, exported <name>.glb
The spec (people-1/specs/*.json) names MPFB assets by file name; `garments` adds modelled pieces (tabard, cloak) defined below.
Needs MPFB 2.0.18 + asset packs installed in bin/blender/portable (see skill/recipes/blender.md, "Realistic humans with MPFB2").
"""
import bpy, sys, json, os, math, bmesh
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:]
spec = json.load(open(argv[0])); out = argv[1]; mode = argv[2]
os.makedirs(out, exist_ok=True)
bpy.ops.preferences.addon_enable(module='bl_ext.user_default.mpfb')
from bl_ext.user_default.mpfb.services.humanservice import HumanService

info = HumanService._create_default_human_info_dict()
info['name'] = spec['name']
info['phenotype'].update(spec['phenotype'])
info['phenotype']['race'] = spec['race']
for k in ('eyes', 'eyebrows', 'eyelashes', 'hair', 'teeth', 'tongue', 'proxy'):
    info[k] = spec.get(k, '')
if mode == 'game' and spec.get('eyes_game'):
    info['eyes'] = spec['eyes_game']  # the low-poly eye mesh is enough for the phone budget
info['clothes'] = spec.get('clothes', [])
info['skin_mhmat'] = spec['skin']
info['skin_material_type'] = 'ENHANCED_SSS' if mode == 'render' else 'GAMEENGINE'
info['eyes_material_type'] = 'MAKESKIN' if mode == 'render' else 'GAMEENGINE'
info['clothes_material_type'] = 'MAKESKIN'
info['rig'] = 'mixamo'
s = HumanService.get_default_deserialization_settings()
s.update(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True, subdiv_levels=0, material_instances='NEVER')
base = HumanService.deserialize_from_dict(info, s)
arm = base.parent
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name != 'Cube']
print('BASEMESH', base.name, len(base.data.vertices))


def by(suffix):
    for o in meshes:
        if o.name.endswith(suffix):
            return o


def all_nodes(o):
    return [n for sl in o.material_slots if sl.material for n in sl.material.node_tree.nodes]


# ---------- look tuning: spec.skin_group (skin node group inputs), spec.tints {suffix: [[r,g,b], amount]}, spec.eye_tex ----------
for k, v in spec.get('skin_group', {}).items():
    for n in all_nodes(base):
        if n.type == 'GROUP' and k in n.inputs:
            n.inputs[k].default_value = v


def tint(o, rgb, amount=1.0):
    for sl in o.material_slots:
        nt = sl.material.node_tree
        pb = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        if not pb.inputs['Base Color'].links:
            continue
        link = pb.inputs['Base Color'].links[0]
        mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = amount; mix.inputs[7].default_value = (*rgb, 1)
        nt.links.new(link.from_socket, mix.inputs[6]); nt.links.new(mix.outputs[2], pb.inputs['Base Color'])


for suffix, (rgb, amt) in spec.get('tints', {}).items():
    o = by(suffix)
    if o:
        tint(o, rgb, amt)
import numpy as np


def grey_texture(o, amount, tone):
    """age hair and beards: pull the texture colour toward a grey of the given level, keeping alpha and the strand detail (spec.grey = {suffix: [amount, tone]})"""
    for n in all_nodes(o):
        if n.type == 'TEX_IMAGE' and n.image and not n.image.name.endswith('_grey'):
            im = n.image; px = np.empty(len(im.pixels), dtype=np.float32); im.pixels.foreach_get(px); px = px.reshape(-1, 4)
            lum = px[:, :3].mean(axis=1, keepdims=True)
            px[:, :3] = px[:, :3] * (1 - amount) + (tone * (0.5 + lum)) * amount  # keeps the strand contrast
            new = bpy.data.images.new(im.name + '_grey', im.size[0], im.size[1], alpha=True); new.colorspace_settings.name = 'sRGB'
            new.pixels.foreach_set(np.clip(px, 0, 1).ravel()); new.pack(); n.image = new


for suffix, (amt, tone) in spec.get('grey', {}).items():
    o = by(suffix)
    if o:
        grey_texture(o, amt, tone)
if spec.get('eye_tex'):
    for n in all_nodes(by('.high-poly') or by('.low-poly')):
        if n.type == 'TEX_IMAGE':
            n.image = bpy.data.images.load(spec['eye_tex'])


# ---------- modelled garments ----------
def bone_head(name):
    return arm.matrix_world @ arm.data.bones[name].head_local


def bvh_of(objs):
    bm = bmesh.new()
    dg = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        me = o.evaluated_get(dg).to_mesh()
        me.transform(o.matrix_world); bm.from_mesh(me)
    t = BVHTree.FromBMesh(bm); bm.free(); return t


def cloth_material(name, rgb, rough=0.95):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*rgb, 1); b.inputs['Roughness'].default_value = rough
    return m


def new_mesh_obj(name, verts, faces, mat):
    me = bpy.data.meshes.new(name); me.from_pydata(verts, [], faces); me.update()
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def rig_weights(ob, weights_fn):
    for v in ob.data.vertices:
        for b, w in weights_fn(ob.matrix_world @ v.co).items():
            if w > 0.001:
                vg = ob.vertex_groups.get(b) or ob.vertex_groups.new(name=b); vg.add([v.index], w, 'REPLACE')
    ob.parent = arm; md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = arm


def thicken(ob, t):
    """real thickness in the mesh (the glTF exporter ignores modifiers when export_apply is off)"""
    bpy.context.view_layer.objects.active = ob
    m = ob.modifiers.new('Solidify', 'SOLIDIFY'); m.thickness = t; m.offset = 0
    bpy.ops.object.modifier_apply(modifier=m.name)


def make_tabard(cfg):
    """front and back panels over the torso, to the knee; the lower part splits per thigh (weights by side)."""
    bvh = bvh_of([o for o in meshes if o.name.endswith(('.body', 'tunic'))])
    hips = bone_head('mixamorig:Hips'); neck = bone_head('mixamorig:Neck'); knee = bone_head('mixamorig:LeftLeg')
    z_top = neck.z - 0.05; z_hem = knee.z + cfg.get('hem_offset', -0.02)
    nu, nv = 10, 22; hw = cfg.get('half_width', 0.19); off = cfg.get('offset', 0.03)
    verts = []; faces = []; last = {}
    for side in (-1, 1):  # -1 = front (-y), +1 = back
        base_i = len(verts)
        for j in range(nv + 1):
            z = z_top + (z_hem - z_top) * j / nv
            for i in range(nu + 1):
                x = -hw + 2 * hw * i / nu
                y = None
                if z >= hips.z - 0.06:
                    h = bvh.ray_cast(Vector((x, side, z)), Vector((0, -side, 0)))
                    if h[0] is not None:
                        y = h[0].y + (-off if side == -1 else off)
                if y is None:
                    y = last.get((side, i), 0.0)
                last[(side, i)] = y
                verts.append(Vector((x, y, z)))
        for j in range(nv):
            for i in range(nu):
                a = base_i + j * (nu + 1) + i; b = a + 1; c = a + nu + 2; d = a + nu + 1
                faces.append((a, b, c, d) if side == 1 else (a, d, c, b))
    mat = cloth_material('tabard', cfg['rgb'])
    ob = new_mesh_obj(spec['name'] + '.tabard', verts, faces, mat)
    bm = bmesh.new(); bm.from_mesh(ob.data); bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.004); bm.to_mesh(ob.data); bm.free()
    thicken(ob, 0.006)
    # planar UVs (x -> u, z -> v) and a painted emblem: a white tower on the field, gold edging
    uv = ob.data.uv_layers.new(name='UVMap')
    for lp in ob.data.loops:
        co = ob.data.vertices[lp.vertex_index].co
        uv.data[lp.index].uv = ((co.x + hw) / (2 * hw), (co.z - z_hem) / (z_top - z_hem))
    N = 256; img = bpy.data.images.new('tabard_emblem', N, N, alpha=False); px = [0.0] * (N * N * 4)
    fld = [min(1, (c * 12.92 if c < 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055)) for c in cfg['rgb']]
    for y in range(N):
        for x in range(N):
            u, v = x / N, y / N; c = (*fld, 1.0)
            if u < 0.035 or u > 0.965 or v < 0.02: c = (0.62, 0.5, 0.2, 1.0)
            tower = 0.43 < u < 0.57 and 0.64 < v < 0.86
            merlon = 0.40 < u < 0.60 and 0.86 <= v < 0.90 and (int((u - 0.40) / 0.04) % 2 == 0)
            door = 0.48 < u < 0.52 and 0.64 < v < 0.72
            if (tower or merlon) and not door: c = (0.93, 0.93, 0.9, 1.0)
            i = (y * N + x) * 4; px[i:i + 4] = c
    img.pixels = px; img.pack()
    nt = mat.node_tree; tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img
    nt.links.new(tex.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color'])
    crotch_z = hips.z - 0.08

    def w(p):
        if p.z > hips.z + 0.02:
            if p.z > neck.z - 0.12:
                return {'mixamorig:Spine2': 0.6, 'mixamorig:Neck': 0.1, 'mixamorig:Spine1': 0.3}
            return {'mixamorig:Spine2': 0.45, 'mixamorig:Spine1': 0.35, 'mixamorig:Spine': 0.2}
        if p.z > crotch_z:
            return {'mixamorig:Hips': 0.6, 'mixamorig:Spine': 0.4}
        t = min(1.0, (crotch_z - p.z) / 0.15)
        return {'mixamorig:Hips': 1 - 0.85 * t, ('mixamorig:LeftUpLeg' if p.x > 0 else 'mixamorig:RightUpLeg'): 0.85 * t}
    rig_weights(ob, w)
    return ob


def make_cloak(cfg):
    """open-front short cloak: swept elliptical sheet from the shoulders to below the hips with a flare, rigged to spine and shoulders."""
    neck = bone_head('mixamorig:Neck'); hips = bone_head('mixamorig:Hips')
    z_top = neck.z + 0.01; z_hem = hips.z - cfg.get('below_hips', 0.30)
    nu, nv = 24, 20; ang = math.radians(cfg.get('span_deg', 236)); cy = hips.y + 0.015
    verts = []; faces = []
    for j in range(nv + 1):
        t = j / nv; z = z_top + (z_hem - z_top) * t
        rx = 0.19 + 0.09 * math.sin(min(t * 3.2, math.pi / 2)) + 0.20 * t ** 2.2
        ry = 0.135 + 0.06 * math.sin(min(t * 3.2, math.pi / 2)) + 0.17 * t ** 2.2
        for i in range(nu + 1):
            a = -ang / 2 + ang * i / nu
            fold = 1 + 0.045 * math.sin(i * 1.7) * t
            verts.append(Vector((rx * fold * math.sin(a), cy + ry * fold * math.cos(a), z)))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i; faces.append((a, a + 1, a + nu + 2, a + nu + 1))
    ob = new_mesh_obj(spec['name'] + '.cloak', verts, faces, cloth_material('cloak', cfg['rgb'], 0.97))
    thicken(ob, 0.008)

    def w(p):
        t = max(0, min(1, (z_top - p.z) / (z_top - z_hem)))
        if t < 0.18:
            return {'mixamorig:Neck': 0.2, 'mixamorig:Spine2': 0.6, 'mixamorig:Spine1': 0.2}
        if t < 0.55:
            return {'mixamorig:Spine2': 0.3, 'mixamorig:Spine1': 0.4, 'mixamorig:Spine': 0.3}
        return {'mixamorig:Spine': 0.3, 'mixamorig:Hips': 0.7}
    rig_weights(ob, w)
    return ob


for g in spec.get('garments', []):
    meshes.append({'tabard': make_tabard, 'cloak': make_cloak}[g['type']](g))
bpy.context.view_layer.update()


# ---------- Mixamo clip retarget (by bone name, per-bone rest alignment; MPFB's Mixamo rig is A-pose, Mixamo clips are T-pose) ----------
def retarget(fbx, action_name, frame_range=None, step=1):
    pre = set(bpy.data.objects)
    shown = [o for o in meshes if not o.hide_viewport]
    for o in shown:
        o.hide_viewport = True  # the depsgraph then skips skinning 40k vertices on every pose update
    bpy.ops.import_scene.fbx(filepath=fbx)
    new = [o for o in bpy.data.objects if o not in pre]
    src = next(o for o in new if o.type == 'ARMATURE')
    sact = src.animation_data.action
    f0, f1 = (int(sact.frame_range[0]), int(sact.frame_range[1])) if frame_range in (None, 'auto') else frame_range
    sc = bpy.context.scene
    Wt = arm.matrix_world.copy()

    def facing(a):
        """horizontal direction the character faces: the left-to-right hip line turned a quarter about up (feet and toes are too noisy across rigs)"""
        l = a.data.bones['mixamorig:LeftUpLeg'].head_local; r = a.data.bones['mixamorig:RightUpLeg'].head_local
        d = a.matrix_world.to_3x3() @ (l - r); d.z = 0; d.normalize()
        return Vector((-d.y, d.x, 0))
    fs, ft = facing(src), facing(arm)
    F = Matrix.Rotation(math.atan2(ft.y, ft.x) - math.atan2(fs.y, fs.x), 3, 'Z')

    def bdir(a, b):
        """physical bone direction (head to the mean of the children's heads; a leaf continues its parent's direction), not the bone's own Y axis: the two rigs orient hand bones differently"""
        bo = a.data.bones[b]; W = a.matrix_world
        kids = [ch for ch in bo.children if 'UpLeg' not in ch.name] or list(bo.children)  # the pelvis points at the spine, not at the mean of spine and both thighs
        if kids:
            c = sum((ch.head_local for ch in kids), Vector()) / len(kids)
            return (W.to_3x3() @ (c - bo.head_local)).normalized()
        return (W.to_3x3() @ (bo.head_local - bo.parent.head_local)).normalized()

    def rest3(a, b):
        return (a.matrix_world @ a.data.bones[b].matrix_local).to_3x3()
    def depth(b):
        d = 0
        while b.parent:
            b = b.parent; d += 1
        return d
    names = sorted([b.name for b in arm.data.bones if b.name in src.data.bones], key=lambda n: depth(arm.data.bones[n]))
    Q = {b: bdir(arm, b).rotation_difference(F @ bdir(src, b)).to_matrix() for b in names}
    # reference orientation of each target bone in the source's T-pose: shortest arc from the bone's own direction to the source's
    RT = {b: Q[b] @ rest3(arm, b) for b in names}
    hs_rest = (src.matrix_world @ src.data.bones['mixamorig:Hips'].matrix_local).translation
    ratio = (Wt @ arm.data.bones['mixamorig:Hips'].matrix_local).translation.z / hs_rest.z
    act = bpy.data.actions.new(action_name); arm.animation_data_create(); arm.animation_data.action = act
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    rest_ankle = min(arm.data.bones['mixamorig:LeftFoot'].head_local.z, arm.data.bones['mixamorig:RightFoot'].head_local.z)

    def pose_frame(f, dz):
        pose_arm = {}; out_ = {}
        for b in names:
            sb = src.pose.bones[b]
            Rs_pose = (src.matrix_world @ sb.matrix).to_3x3()
            D = F @ (Rs_pose @ rest3(src, b).inverted()).to_quaternion().to_matrix() @ F.inverted()
            R_arm = Wt.to_3x3().inverted() @ (D @ RT[b])
            tb = arm.data.bones[b]; par = tb.parent
            if par is None or par.name not in pose_arm:
                pos = tb.head_local.copy()
                if b == 'mixamorig:Hips':
                    d = (src.matrix_world @ sb.matrix).translation - hs_rest
                    pos = pos + Wt.to_3x3().inverted() @ (F @ d) * ratio
                    pos.z += dz
                M = Matrix.Translation(pos) @ R_arm.to_4x4()
                basis = tb.matrix_local.inverted() @ M
            else:
                rel = par.matrix_local.inverted() @ tb.matrix_local
                pos = (pose_arm[par.name] @ rel).translation
                M = Matrix.Translation(pos) @ R_arm.to_4x4()
                basis = rel.inverted() @ pose_arm[par.name].inverted() @ M
            pose_arm[b] = M; out_[b] = basis
        return out_
    def apply(bases, key_frame=None):
        for b, basis in bases.items():
            pb = arm.pose.bones[b]
            pb.rotation_quaternion = basis.to_quaternion(); pb.location = basis.translation
            if key_frame is not None:
                pb.keyframe_insert('rotation_quaternion', frame=key_frame); pb.keyframe_insert('location', frame=key_frame)
    def lowest_ankle():
        bpy.context.view_layer.update()
        return min(arm.pose.bones['mixamorig:LeftFoot'].head.z, arm.pose.bones['mixamorig:RightFoot'].head.z)
    if frame_range == 'auto':  # pick, among the candidate frames, the one whose retargeted feet stand level (leg lengths differ between the rigs)
        best = None
        for f in range(int(sact.frame_range[0]), int(sact.frame_range[1]) + 1, 3):
            sc.frame_set(f); apply(pose_frame(f, 0.0)); bpy.context.view_layer.update()
            lv = abs(arm.pose.bones['mixamorig:LeftFoot'].head.z - arm.pose.bones['mixamorig:RightFoot'].head.z)
            if best is None or lv < best[0]:
                best = (lv, f)
        f0 = f1 = best[1]; print('POSE FRAME', f0, 'foot height difference', round(best[0], 3))
    for f in range(f0, f1 + 1, step):
        sc.frame_set(f)
        if os.environ.get('RETARGET_REST'):
            for pbx in src.pose.bones:
                pbx.matrix_basis.identity()
        bpy.context.view_layer.update()
        apply(pose_frame(f, 0.0))
        dz = -(lowest_ankle() - rest_ankle)   # keep the lower ankle at its standing height: the feet stay on the floor
        if os.environ.get('RETARGET_DEBUG'): print('DBGZ', f, 'dz', round(dz, 3), 'ratio', round(ratio, 3), 'hips rest z', round(arm.data.bones['mixamorig:Hips'].head_local.z, 3), 'src hips z rest', round(hs_rest.z, 3))
        apply(pose_frame(f, dz), key_frame=f - f0 + 1)
    if os.environ.get('RETARGET_DEBUG'):
        fmt = lambda v: tuple(round(x, 2) for x in v)
        for bn in ('mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:Spine2', 'mixamorig:LeftUpLeg'):
            print('DBG2', bn, 'src rest', fmt(bdir(src, bn)), 'tgt rest', fmt(bdir(arm, bn)), 'F x', fmt(F @ Vector((1, 0, 0))))
        bpy.context.view_layer.update()
        def pdir(a, b):
            pb = a.pose.bones[b]
            if pb.children:
                c = sum((ch.head for ch in pb.children), Vector()) / len(pb.children)
                return (a.matrix_world.to_3x3() @ (c - pb.head)).normalized()
            return (a.matrix_world.to_3x3() @ (pb.head - pb.parent.head)).normalized()
        for bn in ('mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', 'mixamorig:Spine2'):
            print('DBG3', bn, 'src pose(F)', fmt(F @ pdir(src, bn)), 'tgt pose', fmt(pdir(arm, bn)))
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in shown:
        o.hide_viewport = False
    act.use_fake_user = True
    return act


clips = spec.get('clips', {})
if mode == 'render':
    retarget(clips['idle'], 'Idle_A', frame_range='auto')
    # look-test stance: only the arms and hands from the idle clip, everything else in the rig's rest stance (no foot IK in a plain retarget, so a
    # weight-shifted idle floats one foot on rigs whose leg lengths differ)
    for pb in arm.pose.bones:
        if not any(k in pb.name for k in ('Shoulder', 'Arm', 'Hand')):
            pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
    arm.animation_data.action = None  # the keyed pose would override the manual one on load
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, spec['name'] + '-render.blend'))
    sys.exit(0)

# ---------- game export ----------
bpy.context.view_layer.objects.active = base
if base.data.shape_keys:
    bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
for md in list(base.modifiers):
    if md.type == 'MASK':
        base.modifiers.remove(md)
bm = bmesh.new(); bm.from_mesh(base.data)
vg = base.vertex_groups['body'].index; lay = bm.verts.layers.deform.active
bmesh.ops.delete(bm, geom=[v for v in bm.verts if vg not in v[lay]], context='VERTS')
bm.to_mesh(base.data); bm.free()
print('BODY after helper strip', len(base.data.polygons), 'quads')
cover = [o for o in meshes if o.name.split('.', 1)[-1] in spec.get('covering', [])]
if cover:
    cb = bvh_of(cover); bm = bmesh.new(); bm.from_mesh(base.data); bm.verts.ensure_lookup_table()
    head_z = max(v.co.z for v in bm.verts) - 0.30
    covered = set()
    for v in bm.verts:
        w = base.matrix_world @ v.co; n = (base.matrix_world.to_3x3() @ v.normal).normalized()
        h = cb.ray_cast(w + n * 0.001, n, 0.06)
        if h[0] is not None and w.z < head_z:
            covered.add(v.index)
    kill = [v for v in bm.verts if v.index in covered and all(e.other_vert(v).index in covered for e in v.link_edges)
            and all(e2.other_vert(e.other_vert(v)).index in covered for e in v.link_edges for e2 in e.other_vert(v).link_edges)]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    bm.to_mesh(base.data); bm.free()
    print('BODY after cover cull', len(base.data.polygons), 'quads')
import numpy as np
for o in meshes:  # flatten fitting shape keys so the meshes can be decimated and exported plain
    if o.data.shape_keys:
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)


def bake_tint(o):
    """the glTF exporter drops the multiply node, so bake the tint into a copy of the texture"""
    for sl in o.material_slots:
        nt = sl.material.node_tree
        pb = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        links = pb.inputs['Base Color'].links
        if not links or links[0].from_node.type != 'MIX':
            continue
        mix = links[0].from_node
        up = [mix]; tex = None
        while up and tex is None:
            n = up.pop(0)
            for i in n.inputs:
                for lk in i.links:
                    if lk.from_node.type == 'TEX_IMAGE':
                        tex = lk.from_node; break
                    up.append(lk.from_node)
                if tex: break
        im = tex.image
        px = np.empty(len(im.pixels), dtype=np.float32); im.pixels.foreach_get(px); px = px.reshape(-1, 4)
        amt = mix.inputs[0].default_value; rgb = np.array(mix.inputs[7].default_value[:3])
        px[:, :3] *= rgb * amt + (1 - amt)
        new = bpy.data.images.new(im.name + '_tint', im.size[0], im.size[1], alpha=True); new.colorspace_settings.name = 'sRGB'
        new.pixels.foreach_set(px.ravel()); new.pack(); tex.image = new
        nt.links.new(tex.outputs['Color'], pb.inputs['Base Color'])
for suffix in spec.get('tints', {}):
    o = by(suffix)
    if o:
        bake_tint(o)
for suffix, ratio in spec.get('decimate', {}).items():
    o = by(suffix)
    if o:
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('Decimate', 'DECIMATE'); m.ratio = ratio
        bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0); bpy.ops.object.modifier_apply(modifier=m.name)
total = 0
for o in meshes:
    t = sum(len(p.vertices) - 2 for p in o.data.polygons); total += t
    print('TRIS', o.name, t)
print('TRIS TOTAL', total)
for cname, key, stp in (('Idle_A', 'idle', 3), ('Walking_A', 'walk', 1)):
    if key in clips:
        retarget(clips[key], cname, step=stp)
if 'idle' in clips:  # a one-frame still (arms from the idle, rest stance elsewhere) for sheets; the full idle leans and lifts a foot
    st = retarget(clips['idle'], 'Stand_A', frame_range='auto')
    arm.animation_data.action = st
    for pb in arm.pose.bones:
        if not any(k in pb.name for k in ('Shoulder', 'Arm', 'Hand')):
            pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
            for fr in (1, 2):  # two keys: a zero-length NLA strip is refused
                pb.keyframe_insert('rotation_quaternion', frame=fr); pb.keyframe_insert('location', frame=fr)
    for pb in arm.pose.bones:
        if any(k in pb.name for k in ('Shoulder', 'Arm', 'Hand')):
            for fr in (2,):
                pb.keyframe_insert('rotation_quaternion', frame=fr); pb.keyframe_insert('location', frame=fr)
# Mixamo glTF convention: no colon in bone names
for b in arm.data.bones:
    b.name = b.name.replace('mixamorig:', 'mixamorig')
for o in meshes:
    for vgp in o.vertex_groups:
        vgp.name = vgp.name.replace('mixamorig:', 'mixamorig')
for a in bpy.data.actions:
    for fc in a.fcurves:
        fc.data_path = fc.data_path.replace('mixamorig:', 'mixamorig')
cap = spec.get('texture_cap', {'default': 1024, 'skin': 2048})
for im in bpy.data.images:
    if im.size[0] == 0:
        continue
    c = cap['skin'] if 'skin' in im.name.lower() or 'lightskinned' in im.name or 'eurasian' in im.name else cap['default']
    if max(im.size) > c:
        im.scale(c, int(im.size[1] * c / im.size[0]))
arm.animation_data.action = None
for a in [x for x in bpy.data.actions if x.name in ('Idle_A', 'Walking_A', 'Stand_A')]:
    t = arm.animation_data.nla_tracks.new(); t.name = a.name; t.strips.new(a.name, 1, a)
bpy.ops.object.select_all(action='DESELECT')
for o in list(meshes) + [arm]:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, spec['name'] + '.glb'), export_format='GLB', use_selection=True,
                          export_animations=True, export_animation_mode='NLA_TRACKS', export_skins=True, export_yup=True,
                          export_apply=False, export_image_format='AUTO', export_morph=False, export_extras=False)
print('EXPORTED')
