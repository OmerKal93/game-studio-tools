# Retarget Mixamo Sword And Shield clips (X Bot) onto the UE5 Manny (SKM_Manny_Simple) in batch.
# Raw Mixamo FBX are imported into /Game/Animation/_ImportTmp, used, then DELETED (licence: raw Mixamo files must never enter a repo).
# Only the retargeted Manny clips are kept under /Game/Animation/Combat.
# Run: node tools/unreal/ue-run.mjs py MyGame.uproject tools/unreal/retarget-mixamo-to-manny.py -- <mixamoPackDir> <clip-name-regex-or-all>
import sys, os, re, unreal

PACK = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('MIXAMO_PACK_DIR', '')  # folder of Mixamo FBX files you downloaded yourself
TMP = '/Game/Animation/_ImportTmp'
OUT = '/Game/Animation/Combat'
MANNY = '/Game/Characters/Mannequins/Meshes/SKM_Manny_Simple'
ONLY = os.environ.get('ANIM_ONLY')
CLIPS = {  # Mixamo file stem -> our clip name
    'sword and shield attack': 'Cut_A', 'sword and shield attack (2)': 'Cut_B', 'sword and shield attack (3)': 'Cut_C', 'sword and shield attack (4)': 'Cut_D',
    'sword and shield slash': 'Slash_A', 'sword and shield slash (2)': 'Slash_B', 'sword and shield slash (3)': 'Slash_C',
    'sword and shield slash (4)': 'Slash_D', 'sword and shield slash (5)': 'Slash_E',
    'sword and shield block': 'Block', 'sword and shield block (2)': 'BlockImpact', 'sword and shield block idle': 'BlockIdle',
    'sword and shield impact': 'HitReact_A', 'sword and shield impact (2)': 'HitReact_B', 'sword and shield impact (3)': 'HitReact_C',
    'sword and shield kick': 'Kick', 'sword and shield idle': 'CombatIdle', 'sword and shield death': 'Death_A',
}
eal = unreal.EditorAssetLibrary
at = unreal.AssetToolsHelpers.get_asset_tools()
unreal.SystemLibrary.execute_console_command(None, 'Interchange.FeatureFlags.Import.FBX false')


def say(*a):
    unreal.log('ANIMRT ' + ' '.join(str(x) for x in a))


def import_fbx(path, dest, skeleton=None, mesh=False):
    ui = unreal.FbxImportUI()
    ui.automated_import_should_detect_type = False
    ui.import_mesh = mesh
    ui.import_as_skeletal = mesh
    ui.import_materials = False
    ui.import_textures = False
    ui.import_animations = not mesh
    if mesh:
        ui.mesh_type_to_import = unreal.FBXImportType.FBXIT_SKELETAL_MESH
    else:
        ui.mesh_type_to_import = unreal.FBXImportType.FBXIT_ANIMATION
        ui.skeleton = skeleton
        ui.anim_sequence_import_data.set_editor_property('import_uniform_scale', 1.0)
    t = unreal.AssetImportTask()
    t.filename, t.destination_path, t.automated, t.save, t.replace_existing = path, dest, True, True, True
    t.options = ui
    at.import_asset_tasks([t])
    return [str(p) for p in t.imported_object_paths]


def build():
    if eal.does_directory_exist(TMP):
        eal.delete_directory(TMP)
    xb = import_fbx(PACK + '/X Bot.fbx', TMP + '/XBot', mesh=True)
    say('xbot imported', xb)
    xmesh = next(unreal.load_asset(p) for p in xb if isinstance(unreal.load_asset(p), unreal.SkeletalMesh))
    skel = xmesh.get_editor_property('skeleton')
    say('skeleton', skel.get_path_name())
    manny = unreal.load_asset(MANNY)

    # IK rigs
    def make_rig(name, mesh):
        rig = at.create_asset(name, TMP, unreal.IKRigDefinition, unreal.IKRigDefinitionFactory())
        c = unreal.IKRigController.get_controller(rig)
        c.set_skeletal_mesh(mesh)
        say(name, 'auto chains', c.apply_auto_generated_retarget_definition(), [str(x.chain_name) if hasattr(x, 'chain_name') else str(x) for x in c.get_retarget_chains()])
        return rig
    rs, rt = make_rig('IK_XBot', xmesh), make_rig('IK_Manny', manny)
    rtg = at.create_asset('RTG_XBot_to_Manny', TMP, unreal.IKRetargeter, unreal.IKRetargetFactory())
    rc = unreal.IKRetargeterController.get_controller(rtg)
    rc.set_ik_rig(unreal.RetargetSourceOrTarget.SOURCE, rs)
    rc.set_ik_rig(unreal.RetargetSourceOrTarget.TARGET, rt)
    rc.set_preview_mesh(unreal.RetargetSourceOrTarget.SOURCE, xmesh)
    rc.set_preview_mesh(unreal.RetargetSourceOrTarget.TARGET, manny)
    say('ops before', rc.get_num_retarget_ops())
    if rc.get_num_retarget_ops() == 0:
        say('add_default_ops', rc.add_default_ops())
    say('ops', rc.get_num_retarget_ops(), [str(rc.get_op_name(i)) for i in range(rc.get_num_retarget_ops())])
    for st, rig in ((unreal.RetargetSourceOrTarget.SOURCE, rs), (unreal.RetargetSourceOrTarget.TARGET, rt)):
        rc.assign_ik_rig_to_all_ops(st, rig)
    try:
        rc.auto_map_chains(unreal.AutoMapChainType.FUZZY, True)
    except Exception as e:
        say('auto_map_chains failed', e)
    for st in (unreal.RetargetSourceOrTarget.SOURCE, unreal.RetargetSourceOrTarget.TARGET):
        try:
            rc.auto_align_all_bones(st)
        except Exception as e:
            say('auto_align failed', st, e)
    eal.save_loaded_asset(rtg)

    assets = []
    for stem, name in CLIPS.items():
        if ONLY and not re.search(ONLY, name):
            continue
        f = f'{PACK}/{stem}.fbx'
        if not os.path.exists(f):
            say('MISSING', f)
            continue
        r = import_fbx(f, TMP + '/Clips', skeleton=skel)
        say('clip', stem, r)
        for p in r:
            a = unreal.load_asset(p)
            if isinstance(a, unreal.AnimSequence):
                assets.append((a, name))
                tn = unreal.AnimationLibrary.get_animation_track_names(a)
                rot = unreal.AnimationLibrary.get_raw_track_rotation_data(a, tn[3]) if len(tn) > 3 else []
                for tt in (0.0, 0.4, 0.9):
                    ps = unreal.AnimPoseExtensions.get_anim_pose_at_time(a, tt, unreal.AnimPoseEvaluationOptions(evaluation_type=unreal.AnimDataEvalType.RAW))
                    say('src pose', name, tt, [str(unreal.AnimPoseExtensions.get_bone_pose(ps, b, unreal.AnimPoseSpaces.WORLD).translation) for b in ('rightHand', 'leftHand')][0])
                say('src diag', name, 'keys', unreal.AnimationLibrary.get_num_keys(a), 'len', a.get_editor_property('sequence_length'), 'tracks', len(tn), tn[:3], 'rotkeys', len(rot))
    eal.make_directory(OUT)
    done = unreal.IKRetargetBatchOperation.duplicate_and_retarget(
        [unreal.EditorAssetLibrary.find_asset_data(a.get_path_name()) for a, _ in assets], xmesh, manny, rtg,
        target_path=OUT, use_source_path=False, include_referenced_assets=False, overwrite_existing_files=True)
    say('retargeted', len(done))
    for ad in done:
        o = unreal.load_asset(str(ad.package_name))
        ps = [unreal.AnimPoseExtensions.get_anim_pose_at_time(o, tt, unreal.AnimPoseEvaluationOptions(evaluation_type=unreal.AnimDataEvalType.RAW)) for tt in (0.0, 0.4, 0.9)]
        say('out pose', str(ad.package_name), [str(unreal.AnimPoseExtensions.get_bone_pose(q, 'hand_r', unreal.AnimPoseSpaces.WORLD).translation) for q in ps])
    # rename to game names
    for ad, (a, name) in zip(done, assets):
        new = f'{OUT}/MM_{name}'
        if eal.does_asset_exist(new):
            eal.delete_asset(new)
        say('rename', str(ad.package_name), '->', new, eal.rename_asset(str(ad.package_name), new))
    eal.delete_directory(TMP)
    say('DONE')


try:
    build()
finally:
    pass
