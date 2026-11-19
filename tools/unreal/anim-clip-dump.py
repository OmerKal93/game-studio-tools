# Dump key-bone component-space positions of every AnimSequence in a folder to JSON (for side-view stick sheets and metrics).
# Run: node tools/unreal/ue-run.mjs py MyGame.uproject tools/unreal/anim-clip-dump.py -- /Game/Animation/Combat /tmp/clips.json [samples]
import sys, json, unreal
A = sys.argv[next(i for i, a in enumerate(sys.argv) if a.startswith('/Game')):]  # ue-run may prepend extra argv entries
folder, out = A[0], A[1]
N = int(A[2]) if len(A) > 2 else 24
BONES = ['pelvis', 'spine_01', 'spine_03', 'spine_05', 'neck_01', 'head', 'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
         'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r']
opt = unreal.AnimPoseEvaluationOptions(evaluation_type=unreal.AnimDataEvalType.RAW, extract_root_motion=False, incorporate_root_motion_into_pose=False)
res = {}
for ad in unreal.EditorAssetLibrary.list_assets(folder, recursive=False, include_folder=False):
    a = unreal.load_asset(ad)
    if not isinstance(a, unreal.AnimSequence):
        continue
    L = unreal.AnimationLibrary.get_sequence_length(a)
    frames = []
    for i in range(N):
        t = L * i / (N - 1)
        pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(a, t, opt)
        f = {}
        for b in BONES:
            tr = unreal.AnimPoseExtensions.get_bone_pose(pose, b, unreal.AnimPoseSpaces.WORLD)
            f[b] = [round(tr.translation.x, 2), round(tr.translation.y, 2), round(tr.translation.z, 2)]
        frames.append(f)
    res[a.get_name()] = {'length': L, 'frames': frames}
    unreal.log(f'ANIMDUMP {a.get_name()} len={L:.2f}s')
json.dump(res, open(out, 'w'))
unreal.log(f'ANIMDUMP DONE {len(res)} clips -> {out}')
