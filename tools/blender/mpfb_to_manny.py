"""MPFB2 (MakeHuman) body -> UE5 Manny skeleton FBX, headless in the portable Blender.
usage: node tools/blender-run.mjs tools/blender/mpfb_to_manny.py -- probe <manny-skeleton.json> <outDir>
       node tools/blender-run.mjs tools/blender/mpfb_to_manny.py -- build <manny-skeleton.json> <outDir> <spec.json>
manny-skeleton.json comes from a small Unreal Python script that dumps the Manny skeleton (bone names, parents, ref pose) to JSON.

probe : builds the Manny skeleton alone (one tiny triangle weighted to each bone) and exports <outDir>/manny-probe.fbx. Import it onto SK_Mannequin
        and compare ref-pose local rotations with manny-skeleton.json: that calibrates CFIX (the bone-frame convention between UE and Blender).
build : MPFB body (spec: name, phenotype, race, skin, eyes) with MPFB's game_engine rig ->
        1. re-pose the MPFB rig so every bone points where the Manny bone points (swing only) and bake that pose into the mesh,
        2. place all Manny bones on the body's joints (bones with no MPFB twin go along their parent segment by Manny's own fractions),
           with Manny's exact world rotations, so clip rotations apply 1:1 and bone translations come from the mesh (retarget mode Skeleton),
        3. carry MPFB's weights onto the Manny bone names, spread over spine_04/05, neck_02 and the twist bones along the segment,
        4. export <outDir>/<name>.fbx (skeleton + skinned meshes) and <name>.blend, print counts.
Licences: MPFB plugin GPLv3 (tool only), MakeHuman base mesh/targets/assets CC0, outputs ours (CC0): see the studio asset register.
"""
import bpy, sys, os, json, math
from mathutils import Vector, Matrix, Quaternion

argv = sys.argv[sys.argv.index('--') + 1:]
MODE, SKEL_JSON, OUT = argv[0], argv[1], argv[2]
os.makedirs(OUT, exist_ok=True)
M_REFL = Matrix(((1, 0, 0), (0, -1, 0), (0, 0, 1)))  # UE (x fwd-ish, left-handed) -> Blender: negate Y, cm -> m
# CFIX maps a UE bone frame to the Blender bone frame (Blender's bone axis is local Y). Calibrated by the probe; edit after reading its result.
CFIX = Matrix.Identity(3)
if os.environ.get('MANNY_CFIX'):
    CFIX = Matrix([[float(v) for v in r.split(',')] for r in os.environ['MANNY_CFIX'].split(';')])

# ---------------------------------------------------------------- Manny skeleton (from the UE dump)
sk = json.load(open(SKEL_JSON))
MB = {b['name']: b for b in sk if b['parent'] != 'None' or b['name'] == 'root'}  # the 89 bones the template mesh carries (the rest are control-rig only)
ORDER = [b['name'] for b in sk if b['name'] in MB]  # parents precede children in the UE ref skeleton
for n in ORDER:
    b = MB[n]; q = b['world']['q']
    b['pos'] = M_REFL @ Vector(b['world']['t']) * 0.01
    b['rot'] = M_REFL @ Quaternion((q[3], q[0], q[1], q[2])).to_matrix() @ M_REFL
    b['par'] = None if b['parent'] == 'None' else b['parent']
CHILDREN = {n: [m for m in ORDER if MB[m]['par'] == n] for n in ORDER}


def make_armature(name, heads, rots, lengths=None):
    """Armature with every Manny bone: head from `heads`, world rotation rots[n] @ CFIX (so Blender-Y is the UE-frame axis CFIX maps there)."""
    arm = bpy.data.objects.new(name, bpy.data.armatures.new(name)); bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for n in ORDER:
        eb = arm.data.edit_bones.new(n)
        m = (rots[n] @ CFIX).to_4x4(); m.translation = heads[n]
        eb.head = heads[n]; eb.tail = heads[n] + Vector((0, 1, 0))
        eb.matrix = m
        eb.length = (lengths or {}).get(n, 0.04)
    for n in ORDER:
        if MB[n]['par']:
            arm.data.edit_bones[n].parent = arm.data.edit_bones[MB[n]['par']]
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


def export_fbx(path, objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.fbx(filepath=path, use_selection=True, object_types={'ARMATURE', 'MESH'}, add_leaf_bones=False,
                             bake_anim=False, armature_nodetype='NULL', apply_scale_options='FBX_SCALE_ALL', axis_forward='-Z', axis_up='Y',
                             mesh_smooth_type='FACE', use_mesh_modifiers=True, use_tspace=False, path_mode='COPY', embed_textures=False)
    print('EXPORTED', path, os.path.getsize(path))


if MODE == 'probe':
    arm = make_armature('Armature', {n: MB[n]['pos'] for n in ORDER}, {n: MB[n]['rot'] for n in ORDER})
    verts, faces, groups = [], [], {}
    for n in ORDER:  # one tiny triangle at each bone head so UE keeps every bone
        p = MB[n]['pos']; i = len(verts)
        verts += [p, p + Vector((0.01, 0, 0)), p + Vector((0, 0, 0.01))]; faces.append((i, i + 1, i + 2)); groups[n] = (i, i + 1, i + 2)
    me = bpy.data.meshes.new('probe'); me.from_pydata(verts, [], faces)
    ob = bpy.data.objects.new('probe', me); bpy.context.scene.collection.objects.link(ob)
    for n, idx in groups.items():
        ob.vertex_groups.new(name=n).add(list(idx), 1.0, 'REPLACE')
    ob.parent = arm; md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = arm
    export_fbx(os.path.join(OUT, 'manny-probe.fbx'), [arm, ob])
    sys.exit(0)

# ================================================================ build mode
# STATUS 2026-11-17: probe verified (89 bones, ref-pose rotations identical to SK_Mannequin in UE; import with import_uniform_scale 100,
# armature object named 'Armature' so UE adds no extra root bone, CFIX identity).
# STATUS 2026-11-19: build mode written (probe P6).
import bmesh
import numpy as np
spec = json.load(open(argv[3]))
bpy.ops.preferences.addon_enable(module='bl_ext.user_default.mpfb')
from bl_ext.user_default.mpfb.services.humanservice import HumanService

info = HumanService._create_default_human_info_dict()
info['name'] = spec['name']
info['phenotype'].update(spec['phenotype']); info['phenotype']['race'] = spec['race']
for k in ('eyes', 'eyebrows', 'eyelashes', 'hair', 'teeth', 'tongue', 'proxy'):
    info[k] = spec.get(k, '')
if spec.get('eyes_game'):
    info['eyes'] = spec['eyes_game']
info['clothes'] = spec.get('clothes', [])
info['skin_mhmat'] = spec['skin']
info['skin_material_type'] = 'GAMEENGINE'; info['eyes_material_type'] = 'GAMEENGINE'; info['clothes_material_type'] = 'MAKESKIN'
info['rig'] = 'game_engine'  # UE4-style names (pelvis, spine_01-03, neck_01, upperarm_l ...): most of the Manny names, no twin for spine_04/05, neck_02, metacarpals, twists
s = HumanService.get_default_deserialization_settings()
s.update(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True, subdiv_levels=0, material_instances='NEVER')
base = HumanService.deserialize_from_dict(info, s)
src = base.parent
assert src and src.type == 'ARMATURE', 'MPFB built no rig'
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name != 'Cube']
print('MPFB rig', src.name, len(src.data.bones), 'bones; meshes', [(o.name, len(o.data.vertices)) for o in meshes])
assert all(abs(a - b) < 1e-5 for ra, rb in zip(src.matrix_world.to_3x3(), Matrix.Identity(3)) for a, b in zip(ra, rb)), 'MPFB rig is rotated or scaled'

# flatten fitting shape keys, drop the helper geometry (as mpfb_character.py game mode), so the meshes are plain and posable
for o in meshes:
    if o.data.shape_keys:
        bpy.context.view_layer.objects.active = o
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
if cover:  # delete body faces the clothes hide (normal ray, as mpfb_character.py)
    from mathutils.bvhtree import BVHTree
    cbm = bmesh.new(); dg = bpy.context.evaluated_depsgraph_get()
    for o in cover:
        me = o.evaluated_get(dg).to_mesh(); me.transform(o.matrix_world); cbm.from_mesh(me)
    cb = BVHTree.FromBMesh(cbm); cbm.free()
    bm = bmesh.new(); bm.from_mesh(base.data); bm.verts.ensure_lookup_table()
    head_z = max(v.co.z for v in bm.verts) - 0.30; covered = set()
    for v in bm.verts:
        w = base.matrix_world @ v.co; n = (base.matrix_world.to_3x3() @ v.normal).normalized()
        if cb.ray_cast(w + n * 0.001, n, 0.06)[0] is not None and w.z < head_z:
            covered.add(v.index)
    kill = [v for v in bm.verts if v.index in covered and all(e.other_vert(v).index in covered for e in v.link_edges)
            and all(e2.other_vert(e.other_vert(v)).index in covered for e in v.link_edges for e2 in e.other_vert(v).link_edges)]
    bmesh.ops.delete(bm, geom=kill, context='VERTS'); bm.to_mesh(base.data); bm.free()
    print('BODY after cover cull', len(base.data.polygons), 'quads')
for suffix, ratio in spec.get('decimate', {}).items():
    o = next((m for m in meshes if m.name.endswith(suffix)), None)
    if o:
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('Decimate', 'DECIMATE'); m.ratio = ratio
        bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0); bpy.ops.object.modifier_apply(modifier=m.name)

# ---------------------------------------------------------------- 1. re-pose the MPFB rig to the Manny directions, bake into the meshes
LIM = {'l', 'r'}
PAIRS = []  # (bone, child): same names on both rigs; the bone is swung so that bone-head -> child-head points where Manny's does
for sd in ('l', 'r'):
    PAIRS += [(f'clavicle_{sd}', f'upperarm_{sd}'), (f'upperarm_{sd}', f'lowerarm_{sd}'), (f'lowerarm_{sd}', f'hand_{sd}'), (f'hand_{sd}', f'middle_01_{sd}')]
    for fg in ('thumb', 'index', 'middle', 'ring', 'pinky'):
        PAIRS += [(f'{fg}_01_{sd}', f'{fg}_02_{sd}'), (f'{fg}_02_{sd}', f'{fg}_03_{sd}')]
    PAIRS += [(f'thigh_{sd}', f'calf_{sd}'), (f'calf_{sd}', f'foot_{sd}'), (f'foot_{sd}', f'ball_{sd}')]
PAIRS += [('neck_01', 'head')]


def depth(b):
    d = 0
    while b.parent:
        b = b.parent; d += 1
    return d


PAIRS.sort(key=lambda p: depth(src.data.bones[p[0]]))
bpy.context.view_layer.objects.active = src
bpy.ops.object.mode_set(mode='POSE')
for pb in src.pose.bones:
    pb.rotation_mode = 'QUATERNION'
bpy.context.view_layer.update()


def phead(n):
    return src.matrix_world @ src.pose.bones[n].head


for b, c in PAIRS:
    cur = (phead(c) - phead(b)).normalized(); tgt = (MB[c]['pos'] - MB[b]['pos']).normalized()
    q = cur.rotation_difference(tgt)
    pb = src.pose.bones[b]
    h = pb.head.copy()
    pb.matrix = Matrix.Translation(h) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h) @ pb.matrix
    bpy.context.view_layer.update()
bpy.ops.object.mode_set(mode='OBJECT')
dg = bpy.context.evaluated_depsgraph_get()
for o in meshes:
    eo = o.evaluated_get(dg); me = eo.to_mesh()
    assert len(me.vertices) == len(o.data.vertices), (o.name, len(me.vertices), len(o.data.vertices))
    co = np.empty(len(me.vertices) * 3, dtype=np.float32); me.vertices.foreach_get('co', co)
    o.data.vertices.foreach_set('co', co); o.data.update(); eo.to_mesh_clear()
bpy.context.view_layer.update()
PH = {b.name: src.matrix_world @ src.pose.bones[b.name].head for b in src.data.bones}  # posed joint positions in world space (the mesh is baked to them)
for b, c in PAIRS:
    d = (PH[c] - PH[b]).normalized().dot((MB[c]['pos'] - MB[b]['pos']).normalized())
    if d < 0.999:
        print('REPOSE residual', b, round(math.degrees(math.acos(min(1, d))), 2), 'deg')
print('POSED heads', {k: tuple(round(x, 3) for x in PH[k]) for k in ('pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'upperarm_l', 'hand_l', 'foot_l', 'ball_l')})

# ---------------------------------------------------------------- 2. Manny bone positions on the body's joints
AXIAL_MPFB = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head']
AXIAL_MANNY = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05', 'neck_01', 'neck_02', 'head']


def polyline_fracs(pts):
    L = [0.0]
    for a, b in zip(pts, pts[1:]):
        L.append(L[-1] + (b - a).length)
    return [x / L[-1] for x in L]


fm = dict(zip(AXIAL_MANNY, polyline_fracs([MB[n]['pos'] for n in AXIAL_MANNY])))
P_AX = [PH[n] for n in AXIAL_MPFB]; fb = polyline_fracs(P_AX)
UAX = {}; POS = {}   # UAX: position of each Manny axial bone in MPFB-chain index space, for the weights
for n in AXIAL_MANNY:
    f = fm[n]
    j = max(i for i in range(len(fb) - 1) if fb[i] <= f + 1e-9) if f < 1 else len(fb) - 2
    t = (f - fb[j]) / (fb[j + 1] - fb[j])
    POS[n] = P_AX[j].lerp(P_AX[j + 1], t); UAX[n] = j + t
SEGMENT = {}  # Manny bone with no MPFB twin -> (segment start, segment end) in Manny, then placed by the same fraction on the body
for sd in ('l', 'r'):
    for tw, (a, b) in {f'upperarm_twist_01_{sd}': ('upperarm', 'lowerarm'), f'upperarm_twist_02_{sd}': ('upperarm', 'lowerarm'),
                       f'lowerarm_twist_01_{sd}': ('lowerarm', 'hand'), f'lowerarm_twist_02_{sd}': ('lowerarm', 'hand'),
                       f'thigh_twist_01_{sd}': ('thigh', 'calf'), f'thigh_twist_02_{sd}': ('thigh', 'calf'),
                       f'calf_twist_01_{sd}': ('calf', 'foot'), f'calf_twist_02_{sd}': ('calf', 'foot')}.items():
        SEGMENT[tw] = (f'{a}_{sd}', f'{b}_{sd}')
    for fg in ('index', 'middle', 'ring', 'pinky'):
        SEGMENT[f'{fg}_metacarpal_{sd}'] = (f'hand_{sd}', f'{fg}_01_{sd}')
for n in ORDER:
    if n in POS:
        continue
    if n in SEGMENT:
        a, b = SEGMENT[n]; ab = MB[b]['pos'] - MB[a]['pos']
        t = (MB[n]['pos'] - MB[a]['pos']).dot(ab) / ab.length_squared
        POS[n] = PH[a].lerp(PH[b], t)
    elif n in PH:
        POS[n] = PH[n]
    elif n in ('ik_hand_gun', 'ik_hand_r'):
        POS[n] = PH['hand_r']
    elif n == 'ik_hand_l':
        POS[n] = PH['hand_l']
    elif n in ('ik_foot_l', 'ik_foot_r'):
        POS[n] = PH['foot_' + n[-1]]
    else:  # root, ik_*_root, interaction, center_of_mass sit at the origin
        POS[n] = Vector((0, 0, 0))
print('MANNY bones placed', len(POS), 'of', len(ORDER), '(no twin by rule:', sorted(n for n in ORDER if n not in PH and n not in POS), ')')
# the rig lengths drive nothing; give each bone half the distance to its first child, else a small stub
lengths = {}
for n in ORDER:
    kids = CHILDREN[n]
    lengths[n] = max(0.015, min(0.12, (POS[kids[0]] - POS[n]).length * 0.5)) if kids and (POS[kids[0]] - POS[n]).length > 1e-4 else 0.03

# ---------------------------------------------------------------- 3. weights: MPFB groups -> Manny groups
NOWEIGHT = {n for n in ORDER if 'twist' in n or n.startswith('ik_') or n in ('root', 'interaction', 'center_of_mass') or 'metacarpal' in n}
SKINNED = [n for n in ORDER if n not in NOWEIGHT]
UL = sorted((UAX[n], n) for n in AXIAL_MANNY)
LIMIT = int(spec.get('max_influences', 4))
FINGERS = [f'{fg}_0{k}' for fg in ('thumb', 'index', 'middle', 'ring', 'pinky') for k in (1, 2, 3)]
SMOOTH_REGIONS = []  # (bones, iterations): hands and forearms, shoulders, neck. spec.smooth = {"hand": n, "shoulder": n, "neck": n} overrides the counts
for sd in ('l', 'r'):
    SMOOTH_REGIONS.append(({f'{x}_{sd}' for x in ['hand', 'lowerarm'] + FINGERS}, int(spec.get('smooth', {}).get('hand', 8))))
    SMOOTH_REGIONS.append(({f'{x}_{sd}' for x in ('clavicle', 'upperarm')}, int(spec.get('smooth', {}).get('shoulder', 6))))
SMOOTH_REGIONS.append(({'neck_01', 'neck_02', 'head'}, int(spec.get('smooth', {}).get('neck', 4))))


def map_weights(ws):
    out = {}; wa = 0.0; ua = 0.0
    for name, w in ws.items():
        if name in AXIAL_MPFB:
            wa += w; ua += AXIAL_MPFB.index(name) * w
        elif name in SKINNED:
            out[name] = out.get(name, 0.0) + w
        # 'Root' and anything else is dropped
    if wa > 0:
        u = ua / wa
        k = max(i for i in range(len(UL) - 1) if UL[i][0] <= u + 1e-9) if u < UL[-1][0] else len(UL) - 2
        t = (u - UL[k][0]) / (UL[k + 1][0] - UL[k][0]); t = min(1.0, max(0.0, t))
        out[UL[k][1]] = out.get(UL[k][1], 0.0) + wa * (1 - t); out[UL[k + 1][1]] = out.get(UL[k + 1][1], 0.0) + wa * t
    return out


def finalize(out):
    top = sorted(((w, n) for n, w in out.items() if w > 0.01), reverse=True)[:LIMIT]
    tot = sum(w for w, _ in top)
    return {n: w / tot for w, n in top} if tot > 0 else {}


def smooth(o, data, bones, iters, a):
    """Laplacian smoothing of the whole weight vector over the mesh edges, only for vertices that carry weight on `bones`: MPFB's weights are made for a flat hand and
    tear when the clips curl the fingers round a grip."""
    adj = [[] for _ in data]
    for e in o.data.edges:
        adj[e.vertices[0]].append(e.vertices[1]); adj[e.vertices[1]].append(e.vertices[0])
    mask = [any(n in bones for n in w) and adj[i] for i, w in enumerate(data)]
    for _ in range(iters):
        new = list(data)
        for v, m in enumerate(mask):
            if not m:
                continue
            acc = {}
            for nb in adj[v]:
                for n, w in data[nb].items():
                    acc[n] = acc.get(n, 0.0) + w / len(adj[v])
            new[v] = {n: (1 - a) * data[v].get(n, 0.0) + a * acc.get(n, 0.0) for n in set(acc) | set(data[v])}
        data = new
    return data


# new armature on the posed body
bpy.ops.object.select_all(action='DESELECT')
mat_world = {o.name: o.matrix_world.copy() for o in meshes}
# UE reads FBX_SCALE_ALL files as 1 unit = 1 cm: the probe's metre units only worked because its mesh was a stub. Build in centimetres (x100)
CM = 100.0
arm = make_armature('Armature', {n: v * CM for n, v in POS.items()}, {n: MB[n]['rot'] for n in ORDER}, {n: v * CM for n, v in lengths.items()})
for o in meshes:
    olds = {g.index: g.name for g in o.vertex_groups}
    assert all(m.type != 'ARMATURE' or m.object == src for m in o.modifiers), o.name
    data = []
    for v in o.data.vertices:
        data.append(map_weights({olds[g.group]: g.weight for g in v.groups if g.group in olds}))
    for bones, iters in SMOOTH_REGIONS:
        data = smooth(o, data, bones, iters, 0.5)
    data = [finalize(w) for w in data]
    for md in [m for m in o.modifiers if m.type == 'ARMATURE']:
        o.modifiers.remove(md)
    o.parent = None; o.matrix_world = mat_world[o.name]
    for g in list(o.vertex_groups):
        o.vertex_groups.remove(g)
    groups = {}
    for i, w in enumerate(data):
        for n, wt in w.items():
            if n not in groups:
                groups[n] = o.vertex_groups.new(name=n)
            groups[n].add([i], wt, 'REPLACE')
    o.data.transform(Matrix.Scale(CM, 4)); o.data.update()
    o.parent = arm; md = o.modifiers.new('Armature', 'ARMATURE'); md.object = arm
    nov = sum(1 for w in data if not w)
    print('SKIN', o.name, 'verts', len(data), 'unweighted', nov, 'bones used', len(groups))
bpy.data.objects.remove(src, do_unlink=True)

# ---------------------------------------------------------------- 4. materials, texture size, tris, export
cap = spec.get('texture_cap', {'default': 1024, 'skin': 2048})
for im in bpy.data.images:
    if im.size[0] == 0:
        continue
    c = cap['skin'] if 'skin' in im.name.lower() or 'lightskinned' in im.name or 'eurasian' in im.name else cap['default']
    if max(im.size) > c:
        im.scale(c, int(im.size[1] * c / im.size[0]))
if spec.get('eye_tex'):
    eye = next((m for m in meshes if m.name.endswith(('.high-poly', '.low-poly'))), None)
    if eye:
        for sl in eye.material_slots:
            for n in sl.material.node_tree.nodes:
                if n.type == 'TEX_IMAGE':
                    n.image = bpy.data.images.load(spec['eye_tex'])
total = 0
for o in meshes:
    t = sum(len(p.vertices) - 2 for p in o.data.polygons); total += t
    print('TRIS', o.name, t, 'materials', len(o.material_slots))
print('TRIS TOTAL', total)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, spec['name'] + '-parts.blend'), copy=True)  # the separate, weighted parts (a kit builder starts from this)
# One skinned mesh with one material slot per part (a skeletal mesh section each). Exporting the parts as separate objects made UE's FBX import scale
# the last one (hair) by 100 (bounds 180 m tall, a giant hair blob in every render); each part imported alone was right.
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
joined = bpy.context.view_layer.objects.active; joined.name = spec['name']
print('JOINED', joined.name, 'materials', len(joined.material_slots), 'bones used', len({joined.vertex_groups[g.group].name for v in joined.data.vertices for g in v.groups}))
export_fbx(os.path.join(OUT, spec['name'] + '.fbx'), [arm, joined])
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, spec['name'] + '.blend'))
print('BUILD_DONE')
