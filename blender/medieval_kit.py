"""Parameterised medieval building kit: timber-frame house, curtain wall segment, tower/gatehouse, well, market stall, handcart and
wagon, low field wall. Each piece is built twice (LOD0 detailed, LOD1 plain) and exported as one GLB holding the nodes
'<id>_LOD0' and '<id>_LOD1' (variants: '<id>_v<n>_LOD<k>'), meshes grouped one per material slot.

usage (through the runner, from the repo root):
  node tools/blender-run.mjs blender/medieval_kit.py -- <params.json> <outDir> [id,id,...]
Writes <outDir>/<id>.glb, <outDir>/kit-report.json (triangles per LOD, slots) and <outDir>/kit.blend (for render_views.py).
All authoring is in game metres, y up; every piece stands on y = 0 centred on its footprint (see each generator for its front)."""
import bpy, sys, os, json, math, random
from mathutils import Vector, Matrix
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kitlib as K

X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
v3 = lambda x, y, z: Vector((x, y, z))


def S(q, name):
    """Shade for a slot from the params (per-piece override, then the global table)."""
    return q.get('shade', {}).get(name, q['_shade'].get(name, 1.0))


def vary(P, s, amt=0.08):
    return s * (1 + P.r(-amt, amt))


# ---------------------------------------------------------------- timber-frame house
def house(P, q):
    """Front (door) faces +x. Footprint width (x) by depth (z) centred on the origin; gables at +-z.
    Options: jetty (m, upper storey overhangs +x), storey heights, roof pitch, overhangs, sag, chimney z, plaster tint."""
    W, D = q.get('width', 4.0), q.get('depth', 6.0)
    xa, xb, za, zb = -W / 2, W / 2, -D / 2, D / 2
    plinth = q.get('plinth', 0.55)
    tint = q.get('tint', 0.85)
    lod = P.lod
    sw, sp, ss, sl = S(q, 'wood'), S(q, 'plaster') * tint / 0.85, S(q, 'stone'), S(q, 'slate')
    jetty = q.get('jetty', 0.0)
    storeys = [(xa, xb, plinth, q.get('eave', 3.0) if not jetty else q.get('ground_top', 2.75))]
    if jetty:
        y0 = storeys[0][3] + 0.16
        storeys.append((xa, xb + jetty, y0, y0 + q.get('upper', 2.3)))
    T = 0.2   # timber section

    # plinth: stone base with an irregular top course, a gap for the door
    door_w, door_h = q.get('door_w', 1.05), q.get('door_h', 2.05)
    door_z = q.get('door_z', 0.0)
    gap = (door_z - door_w / 2 - 0.2, door_z + door_w / 2 + 0.2)
    pt = 0.36   # plinth thickness
    body_h = plinth - (0.0 if lod else 0.13)
    runs = [  # (start, end, fixed coordinate, axis) outer faces 4 cm proud of the timber
        ('z', za, zb, xb + 0.04, +1), ('z', za, zb, xa - 0.04, -1), ('x', xa - 0.04, xb + 0.04, zb + 0.04, +1), ('x', xa - 0.04, xb + 0.04, za - 0.04, -1)]
    for ax, a0, a1, f, sgn in runs:
        segs = [(a0, a1)]
        if ax == 'z' and sgn > 0:
            segs = [(a0, gap[0]), (gap[1], a1)]
        for s0, s1 in segs:
            mid, ln = (s0 + s1) / 2, s1 - s0
            if ax == 'z':
                c, size = v3(f - sgn * pt / 2, body_h / 2, mid), (pt, body_h, ln)
            else:
                c, size = v3(mid, body_h / 2, f - sgn * pt / 2), (ln, body_h, pt)
            P.box('stone', c, size, shade=ss, uv_rand=False, bevel=K.HEXA_EDGES if lod == 0 else None)
            if lod:
                continue
            u = s0
            while u < s1 - 0.05:   # top course: irregular stones, uneven heights and faces
                L = min(P.r(0.45, 0.85), s1 - u)
                if s1 - (u + L) < 0.25:
                    L = s1 - u
                h = P.r(0.13, 0.19)
                y = body_h + h / 2 + P.r(-0.015, 0.012)
                dz = P.r(-0.012, 0.02)
                if ax == 'z':
                    c, size = v3(f - sgn * (pt / 2 - dz / 2), y, u + L / 2), (pt + dz, h, L - 0.012)
                else:
                    c, size = v3(u + L / 2, y, f - sgn * (pt / 2 - dz / 2)), (L - 0.012, h, pt + dz)
                P.box('stone', c, size, shade=vary(P, ss, 0.1), jitter=0.012, bevel=TOP_EDGES)
                u += L

    for si, (x0, x1, y0, y1) in enumerate(storeys):
        top = si == len(storeys) - 1
        H = y1 - y0
        # walls: (outward normal, corner origin, length, openings[(kind, u0, u1, v0, v1)])
        walls = []
        Lz, Lx = zb - za, x1 - x0
        # +x (front) wall: U = UP x N = -z, so u runs from zb to za
        fo = []
        if si == 0:
            du = zb - door_z
            fo.append(('door', du - door_w / 2, du + door_w / 2, -y0, door_h - y0))
            for wz in q.get('windows_front', [-1.85, 1.85]):
                uu = zb - wz
                fo.append(('window', uu - 0.38, uu + 0.38, 1.25 - y0, 2.2 - y0))
        else:
            for wz in q.get('windows_upper', [-1.6, 0.0, 1.6]):
                uu = zb - wz
                fo.append(('window', uu - 0.36, uu + 0.36, H * 0.32, H * 0.32 + 0.85))
        walls.append((X, v3(x1, y0, zb), Lz, fo, True))
        bo = [('window', Lz / 2 - 0.35, Lz / 2 + 0.35, H * 0.35, H * 0.35 + 0.8)] if q.get('back_window', True) and si == 0 else []
        walls.append((-X, v3(x0, y0, za), Lz, bo, True))
        go = [('window', Lx / 2 - 0.3, Lx / 2 + 0.3, H * 0.4, H * 0.4 + 0.7)] if (top and q.get('gable_window', si == 1)) else []
        walls.append((Z, v3(x0, y0, zb), Lx, go, False))
        walls.append((-Z, v3(x1, y0, za), Lx, [], False))
        for N, o, L, opens, corners in walls:
            q['_storey'] = si
            timber_wall(P, q, N, o, L, H, y0, opens, corners, sw, sp, T)
        if si == 1:   # jetty: joist ends under the overhang, a floor band elsewhere, dragon braces at the corners
            yj = storeys[0][3]
            if lod == 0:
                n = int((zb - za) / 0.62)
                for i in range(n + 1):
                    z = za + 0.12 + i * (zb - za - 0.24) / n
                    P.box('wood', v3(xb + jetty / 2 - 0.05, yj + 0.08, z), (jetty + 0.1, 0.15, 0.14), shade=vary(P, sw), bevel=None)
            else:
                P.box('wood', v3(xb + jetty / 2 - 0.05, yj + 0.08, 0), (jetty + 0.1, 0.15, zb - za), shade=sw * 0.6, bevel=None)
            for N, a, b in ((-X, v3(xa + 0.1, yj + 0.08, za), v3(xa + 0.1, yj + 0.08, zb)),
                            (Z, v3(xa, yj + 0.08, zb - 0.1), v3(xb, yj + 0.08, zb - 0.1)), (-Z, v3(xa, yj + 0.08, za + 0.1), v3(xb, yj + 0.08, za + 0.1))):
                P.beam('wood', a, b, 0.16, T, shade=vary(P, sw), wobble=0.004 if lod == 0 else 0)
            for zc in (za + 0.1, zb - 0.1):
                P.beam('wood', v3(xb - 0.1, yj - 0.75, zc), v3(xb + jetty - 0.12, yj + 0.02, zc), 0.16, 0.16, shade=vary(P, sw))
        if top:
            roof(P, q, x0, x1, za, zb, y1, sw, sp, sl, ss)


def timber_wall(P, q, N, o, L, H, y0, opens, corners, sw, sp, T):
    """One framed wall. N outward; o bottom-left corner on the outer timber face (u along UP x N); v up from the sole plate's foot."""
    U = K.UP.cross(N).normalized()
    lod = P.lod
    wob = 0.006 if lod == 0 else 0.0
    at = lambda u, v, d=T / 2: o + U * u + K.UP * v - N * d
    beam = lambda u0, v0, u1, v1, w=T, shade=None, d=T / 2, dep=T, ends=False: P.beam(
        'wood', at(u0, v0, d), at(u1, v1, d), w, dep, shade=vary(P, sw, 0.12) if shade is None else shade, wobble=wob, ends=ends)
    rail_bev = K.HEXA_EDGES[:4] if (lod == 0 and q.get('rail_bevel', True)) else None
    rail = lambda u0, v, u1: P.box('wood', (at(u0, v, 0.1) + at(u1, v, 0.1)) / 2, (u1 - u0, 0.14, 0.18), axes=(U, K.UP, N), shade=vary(P, sw, 0.12), bevel=rail_bev)
    door = [op for op in opens if op[0] == 'door']
    # sole plate (broken at a door) and wall plate
    s0 = 0.0
    for _, u0, u1, *_ in sorted(door, key=lambda x: x[1]):
        beam(s0, 0.1, u0 - 0.2, 0.1)
        s0 = u1 + 0.2
    beam(s0, 0.1, L, 0.1)
    beam(0, H - 0.1, L, H - 0.1, w=0.22, dep=0.22, d=0.11)
    # posts: corners (front/back walls own them), opening jambs, then fill so no bay is wider than ~1.5 m
    # gable walls (corners=False) run their bays to the wall ends: the corner posts belong to the long walls
    anchors = {0.1, L - 0.1} if corners else {0.0, L}
    for kind, u0, u1, *_ in opens:
        anchors |= {u0 - 0.1, u1 + 0.1}
    anchors = sorted(anchors)
    allu = []
    for a, b in zip(anchors, anchors[1:]):
        allu.append(a)
        n = int((b - a) / (q.get('bay', 1.5) if lod == 0 else 2.2))
        allu += [a + (b - a) * k / (n + 1) for k in range(1, n + 1)]
    allu = sorted(set(round(p, 3) for p in allu + [anchors[-1]]))
    for u in allu:
        if not corners and (u < 0.15 or u > L - 0.15):
            continue
        is_door = any(abs(u - (d[1] - 0.1)) < 1e-3 or abs(u - (d[2] + 0.1)) < 1e-3 for d in door)
        v0 = door[0][3] if is_door else 0.2
        beam(u, v0, u, H - 0.21, w=0.2 if (u < 0.2 or u > L - 0.2 or is_door) else 0.17)
    # bays: rails around windows, a mid rail in plain bays, a long down-brace in the corner bays
    bays = list(zip(allu, allu[1:]))
    for i, (a, b) in enumerate(bays):
        ins = [op for op in opens if a < (op[1] + op[2]) / 2 < b]
        if ins:
            for kind, u0, u1, v0, v1 in ins:
                if kind == 'window':
                    rail(a, v0 - 0.07, b)
                    rail(a, v1 + 0.07, b)
                else:
                    beam(u0 - 0.22, v1 + 0.13, u1 + 0.22, v1 + 0.13, w=0.26, dep=0.22, d=0.11, ends=True)   # door head
            continue
        end_bay = i == 0 or i == len(bays) - 1
        if end_bay and lod == 0 and b - a > 0.6:
            if i == 0:
                beam(a + 0.05, H - 0.35, b - 0.06, 0.25, w=0.15, dep=0.18, d=0.1)
            else:
                beam(b - 0.05, H - 0.35, a + 0.06, 0.25, w=0.15, dep=0.18, d=0.1)
        elif H > 1.6:
            rail(a, H * 0.5, b)
    # plaster infill: one panel 3 cm behind the timber face, holed for the openings, with a gentle lime-wash bulge
    holes = [(u0, v0, u1, v1) for kind, u0, u1, v0, v1 in opens]
    bulge = (lambda u, v: 0.007 * math.sin(u * 2.7 + o.x) * math.sin(v * 3.1 + o.z)) if lod == 0 else None
    P.sheet('plaster', at(0, 0.2, 0.03), U, K.UP, L, H - 0.42, cell=0.55 if lod == 0 else 9, holes=[(u0, v0 - 0.2, u1, v1 - 0.2) for u0, v0, u1, v1 in holes],
            disp=bulge, shade=sp)
    for kind, u0, u1, v0, v1 in opens:
        (window if kind == 'window' else doorway)(P, q, at, U, N, u0, u1, v0, v1, sw)


def window(P, q, at, U, N, u0, u1, v0, v1, sw):
    lod = P.lod
    depth = 0.26
    P.poly('dark', [at(u0, v0, depth), at(u1, v0, depth), at(u1, v1, depth), at(u0, v1, depth)], N)
    so = S(q, 'oak')
    P.box('oak', (at(u0 - 0.08, v0 - 0.035, -0.07) + at(u1 + 0.08, v0 - 0.035, 0.2)) / 2, (u1 - u0 + 0.16, 0.07, 0.27), axes=(U, K.UP, N), shade=vary(P, so * 0.85))
    if lod:
        return
    for a, b in ((at(u0, v0, 0.03), at(u0, v1, depth)), (at(u1, v0, 0.03), at(u1, v1, depth))):   # reveal linings
        P.box('wood', (a + b) / 2, (0.04, v1 - v0, depth - 0.03), axes=(U, K.UP, N), shade=sw * 1.2, bevel=None)
    P.box('wood', (at(u0, v1, 0.03) + at(u1, v1, depth)) / 2, (u1 - u0, 0.04, depth - 0.03), axes=(U, K.UP, N), shade=sw * 1.2, bevel=None)
    um = (u0 + u1) / 2
    P.box('wood', at(um, (v0 + v1) / 2, 0.12), (0.06, v1 - v0, 0.06), axes=(U, K.UP, N), shade=sw * 1.1, bevel=None)   # mullion
    P.box('wood', at((u0 + u1) / 2, (v0 + v1) / 2 + 0.1, 0.12), (u1 - u0, 0.05, 0.05), axes=(U, K.UP, N), shade=sw * 1.1, bevel=None)
    if q.get('_storey', 0) > 0 and not q.get('upper_shutters', False):
        return
    # shutters: two boarded leaves hinged at the jambs, left at random angles
    hw = (u1 - u0) / 2
    for side, hu in ((-1, u0), (1, u1)):
        ang = math.radians(P.r(95, 170)) if P.r(0, 1) > 0.2 else math.radians(P.r(5, 20))
        hinge = at(hu, (v0 + v1) / 2, -0.045)
        # closed leaf points from the hinge toward the window centre (-side*U); opening swings it out around the vertical
        dirc = -U * side
        d = (dirc * math.cos(ang) + N * math.sin(ang)).normalized()
        c = hinge + d * (hw / 2)
        nrm = K.UP.cross(d).normalized()
        P.box('oak', c, (hw - 0.01, v1 - v0 + 0.02, 0.035), axes=(d, K.UP, nrm), shade=vary(P, so * 0.7, 0.1))
        for vv in (v0 + 0.15, v1 - 0.15):
            P.box('oak', hinge + d * (hw / 2) + K.UP * (vv - (v0 + v1) / 2) + nrm * 0.025 * (1 if nrm.dot(N) > 0 else -1),
                  (hw - 0.06, 0.08, 0.025), axes=(d, K.UP, nrm), shade=so * 0.6, bevel=None)


def doorway(P, q, at, U, N, u0, u1, v0, v1, sw):
    lod = P.lod
    P.poly('dark', [at(u0, v0, 0.24), at(u1, v0, 0.24), at(u1, v1, 0.24), at(u0, v1, 0.24)], N)
    so = S(q, 'oak')
    n = 4 if lod == 0 else 1
    pw = (u1 - u0) / n
    for i in range(n):   # ledged plank door, recessed 13 cm, hairline gaps
        a = u0 + i * pw
        P.box('oak', (at(a + 0.004, v0, 0.13) + at(a + pw - 0.004, v1 - 0.01, 0.18)) / 2, (pw - 0.008, v1 - v0 - 0.01, 0.05),
              axes=(U, K.UP, N), shade=vary(P, so * 0.62, 0.12), bevel=K.HEXA_EDGES[4:8] if lod == 0 else None)
    if lod:
        return
    for vv in (v0 + 0.35, v1 - 0.4):   # strap hinges
        P.box('iron', (at(u0 + 0.02, vv, 0.105) + at(u1 - 0.12, vv, 0.105)) / 2, (u1 - u0 - 0.14, 0.055, 0.012), axes=(U, K.UP, N), shade=1.0, bevel=None)
    P.box('iron', at(u1 - 0.17, (v0 + v1) / 2 - 0.05, 0.1), (0.05, 0.12, 0.03), axes=(U, K.UP, N), shade=1.0, bevel=None)   # latch


def roof(P, q, x0, x1, za, zb, ye, sw, sp, sl, ss):
    lod = P.lod
    pitch = math.radians(q.get('pitch', 47))
    ov_e, ov_g, t = q.get('overhang_eaves', 0.42), q.get('overhang_gable', 0.32), q.get('roof_t', 0.13)
    sag = q.get('sag', 0.05) if lod == 0 else 0.0
    half = (x1 - x0) / 2
    xr = (x0 + x1) / 2
    yru = ye + half * math.tan(pitch)   # underside at the ridge line (through the wall plates' outer top edges)
    zl0, zl1 = za - ov_g, zb + ov_g
    zc, zL = (za + zb) / 2, (zl1 - zl0)
    nz = 6 if lod == 0 else 1
    sag_at = lambda z: -sag * (1 - ((z - zc) / (zL / 2)) ** 2)
    S_e = (half + ov_e) / math.cos(pitch)
    for side in (-1, 1):
        d = v3(side * math.cos(pitch), -math.sin(pitch), 0)   # down the slope
        nrm = v3(side * math.sin(pitch), math.cos(pitch), 0)
        R = v3(xr, yru, 0)
        if lod == 0:
            K_ = max(4, round(S_e / q.get('course', 0.36)))
            step = 0.022
            prof = [(0.0, t)]
            for k in range(1, K_ + 1):
                s = S_e * k / K_
                prof += [(s, t + step), (s, t)] if k < K_ else [(s, t + step)]
            prof += [(S_e, 0.0), (0.0, 0.0)]
        else:
            prof = [(0.0, t), (S_e, t), (S_e, 0.0), (0.0, 0.0)]
        path = []
        for i in range(nz + 1):
            z = zl0 + zL * i / nz
            wob = P.r(-0.008, 0.008) if (lod == 0 and 0 < i < nz) else 0.0
            path.append((R + v3(0, sag_at(z) + wob, z), d, nrm))
        # profile b is along nrm; the sweep's 'side' is d (slope) and 'up' is nrm
        P.sweep('slate', prof, path, shade=vary(P, sl, 0.05), axes=(Z, d, nrm), uv_rand=False, origin=R)   # the course steps catch the light; no bevel needed
    # ridge cap (sagging with the slabs)
    ytop = yru + t / math.cos(pitch)
    prof = [(-0.16, -0.07), (0.16, -0.07), (0.1, 0.03), (-0.1, 0.03)]
    path = [(v3(xr, ytop + sag_at(z), z), X, K.UP) for z in [zl0 - 0.02 + (zL + 0.04) * i / nz for i in range(nz + 1)]]
    P.sweep('slate', prof, path, shade=sl * 0.75, axes=(Z, X, K.UP), uv_rand=False)
    # barge boards, purlins and ridge beam (their ends show under the verges)
    for side in (-1, 1):
        d = v3(side * math.cos(pitch), -math.sin(pitch), 0)
        nrm = v3(side * math.sin(pitch), math.cos(pitch), 0)
        for zg in (zl0 + 0.03, zl1 - 0.03):
            a = v3(xr, yru + sag_at(zg) - 0.11, zg) + d * 0.05
            b = v3(xr, yru + sag_at(zg) - 0.11, zg) + d * (S_e - 0.02)
            P.beam('wood', a - nrm * 0.0, b, 0.04, 0.24, shade=vary(P, sw), ends=lod == 0)
        if lod == 0:
            for f in (0.42, 0.78):
                c = v3(xr, yru, 0) + d * (S_e * f * (half / (half + ov_e))) - nrm * 0.1
                P.beam('wood', v3(c.x, c.y, zl0 + 0.08), v3(c.x, c.y, zl1 - 0.08), 0.15, 0.17, shade=vary(P, sw), roll=0, ends=True)
            n = int((zb - za) / 0.85) if q.get('rafter_feet', True) else -1
            for i in range(n + 1):   # rafter feet under the eaves
                z = za + 0.1 + i * (zb - za - 0.2) / n
                a = v3(xr, yru + sag_at(z), z) + d * (half / math.cos(pitch) - 0.25) - nrm * 0.07
                b = v3(xr, yru + sag_at(z), z) + d * (S_e - 0.06) - nrm * 0.07
                P.box('wood', (a + b) / 2, ((b - a).length, 0.08, 0.12), axes=((b - a).normalized(), Z, (b - a).normalized().cross(Z)), shade=vary(P, sw), bevel=None)
    if lod == 0:
        P.beam('wood', v3(xr, yru - 0.1, zl0 + 0.06), v3(xr, yru - 0.1, zl1 - 0.06), 0.18, 0.2, shade=vary(P, sw), ends=True)
    # gable triangles: plaster infill 3 cm behind king post, collar, queen struts and principal rafters
    rise = yru - ye
    for zg, Nz in ((zb, Z), (za, -Z)):
        inset = Nz * 0.03
        P.poly('plaster', [v3(x0, ye, zg) - inset, v3(x1, ye, zg) - inset, v3(xr, yru - 0.02, zg) - inset], Nz, shade=sp)
        tz = zg - Nz.z * T_HALF
        tim = lambda a, b, w=0.17: P.beam('wood', v3(a[0], a[1], tz), v3(b[0], b[1], tz), w, 0.2, shade=vary(P, sw, 0.12), wobble=0.005 if lod == 0 else 0)
        tim((xr, ye + 0.1), (xr, yru - 0.05))
        yc = ye + rise * 0.5
        xc = half * 0.5
        tim((xr - xc - 0.05, yc), (xr + xc + 0.05, yc), 0.15)
        if lod == 0:
            for sgn in (-1, 1):
                tim((xr + sgn * xc * 0.55, ye + 0.1), (xr + sgn * xc * 0.55, yc), 0.13)
                tim((x0 if sgn < 0 else x1, ye + 0.08), (xr + sgn * 0.08, yru - 0.08), 0.18)
    # chimney: stone stack through the ridge with an oversailing course and a dark flue
    cz = q.get('chimney_z', None)
    if cz is not None:
        cx = xr + q.get('chimney_dx', -0.35)
        yb, ytop2 = ye + rise * 0.35, ytop + q.get('chimney_h', 0.95)
        h = ytop2 - yb
        P.box('stone', v3(cx, yb + h / 2, cz), (0.72, h, 0.62), shade=vary(P, ss), jitter=0.012 if lod == 0 else 0)
        P.box('stone', v3(cx, ytop2 - 0.2, cz), (0.84, 0.13, 0.74), shade=vary(P, ss), jitter=0.01 if lod == 0 else 0)
        P.box('stone', v3(cx, ytop2 + 0.05, cz), (0.62, 0.1, 0.52), shade=vary(P, ss * 0.9))
        P.poly('dark', [v3(cx - 0.17, ytop2 + 0.101, cz - 0.13), v3(cx + 0.17, ytop2 + 0.101, cz - 0.13), v3(cx + 0.17, ytop2 + 0.101, cz + 0.13), v3(cx - 0.17, ytop2 + 0.101, cz + 0.13)], K.UP)


T_HALF = 0.1
TOP_EDGES = [(2, 3), (6, 7), (2, 6), (3, 7)]   # hexa edges around the +axis1 (top) face
VERT_EDGES = K.HEXA_EDGES[4:8]                 # the four edges along axis1


# ---------------------------------------------------------------- masonry helpers
def courses(rng, height, lo=0.28, hi=0.42):
    ys, y = [0.0], 0.0
    while y < height - lo * 0.8:
        y = min(height, y + rng.uniform(lo, hi))
        ys.append(y)
    ys[-1] = height
    return ys


def coursed_block(P, slot, x0, x1, y0, y1, zo, zi, cs, offs, shade, lod):
    """Wall body as horizontal courses spanning x0..x1, each a few mm in or out (offs[k] = (outer, inner, top inset) metres) with its top
    set back, so every bed joint reads as a thin shadow line under the course above; ends stay square so segments butt seamlessly."""
    for k, (a, b) in enumerate(zip(cs, cs[1:])):
        if b <= y0 or a >= y1:
            continue
        a, b = max(a, y0), min(b, y1)
        oo, oi, ti = offs[k % len(offs)] if lod == 0 else (0, 0, 0)
        P.box(slot, v3((x0 + x1) / 2, (a + b) / 2, (zo - oo + zi + oi) / 2), (x1 - x0, b - a, zi + oi - zo + oo), shade=shade * (1 + 0.04 * math.sin(k * 2.3)),
              uv_rand=False, bevel=None, top_inset=ti)


def curtain_wall(P, q):
    """Segment of length L along x (tiles end to end), outer face toward -z, court face +z. Wall walk at `walk`, parapet on the outer
    side with merlons and coped crenels, a battered outer foot, a walk-level lip on the court side."""
    lod = P.lod
    L, T = q.get('length', 4.5), q.get('thickness', 0.64)
    walk, pt, breast, mh = q.get('walk', 2.75), q.get('parapet_t', 0.38), q.get('breast', 0.5), q.get('merlon_h', 0.8)
    ss = S(q, 'stone')
    zo, zi = -T / 2, T / 2
    shared = random.Random(q.get('course_seed', 7))   # same courses in every variant, so segments meet cleanly
    cs = courses(shared, walk + breast)
    offs = [(shared.uniform(-0.006, 0.006), shared.uniform(-0.005, 0.005), shared.uniform(0.012, 0.022)) for _ in cs]
    x0, x1 = -L / 2, L / 2
    coursed_block(P, 'stone', x0, x1, 0, walk, zo, zi, cs, offs, ss, lod)
    coursed_block(P, 'stone', x0, x1, walk, walk + breast, zo, zo + pt, cs, offs, ss, lod)
    bh, bo = q.get('batter_h', 0.95), q.get('batter', 0.24)
    p8 = [v3(x0, 0, zo - bo), v3(x1, 0, zo - bo), v3(x0, bh, zo + 0.01), v3(x1, bh, zo + 0.01), v3(x0, 0, zo + 0.1), v3(x1, 0, zo + 0.1), v3(x0, bh, zo + 0.1), v3(x1, bh, zo + 0.1)]
    P.hexa('stone', p8, shade=ss * 0.95, bevel=[(2, 3)] if lod == 0 else None, uv_rand=False, origin=Vector())
    P.box('stone', v3(0, 0.12, zi + 0.025), (L, 0.24, 0.05 + 0.02), shade=ss * 0.9, uv_rand=False, bevel=K.HEXA_EDGES[:4] if lod == 0 else None)
    P.box('stone', v3(0, walk - 0.07, zi + 0.04), (L, 0.15, 0.08 + 0.02), shade=ss, uv_rand=False, bevel=K.HEXA_EDGES[:4] if lod == 0 else None)   # walk lip
    # merlons with quoined edges and coping, crenel sills sloping outward
    m = q.get('merlons', 2)
    pitch = L / m
    cw = q.get('crenel', 0.8)
    mw = pitch - cw
    ytop = walk + breast
    for i in range(m):
        cx = x0 + pitch * (i + 0.5)
        P.box('stone', v3(cx, ytop + mh / 2, zo + pt / 2), (mw, mh, pt), shade=vary(P, ss, 0.05), jitter=0.008 if lod == 0 else 0, bevel=K.HEXA_EDGES if lod == 0 else None)
        tilt = (Matrix.Rotation(P.r(-0.03, 0.03), 3, X) @ Matrix.Rotation(P.r(-0.02, 0.02), 3, Z)) if lod == 0 else Matrix()
        ax = (tilt @ X, tilt @ Y, tilt @ Z)
        P.box('stone', v3(cx + P.r(-0.02, 0.02), ytop + mh + 0.055, zo + pt / 2), (mw + 0.08, 0.11, pt + 0.09), axes=ax, shade=vary(P, ss * 1.05), jitter=0.01 if lod == 0 else 0,
              top_scale=0.9, bevel=K.HEXA_EDGES if lod == 0 else None)
        if lod == 0:
            for sgn in (-1, 1):   # quoins: alternate long and short stones on each merlon edge, a little proud
                yq = ytop
                for k in range(2):
                    h = mh / 2 - 0.01
                    ln = 0.42 if (k + i + (sgn > 0)) % 2 else 0.26
                    P.box('stone', v3(cx + sgn * (mw / 2 - ln / 2 + 0.012), yq + h / 2 + 0.005, zo + pt / 2), (ln, h, pt + 0.03), shade=vary(P, ss, 0.1), jitter=0.01)
                    yq += h + 0.01
    for i in range(m + 1):
        xs = [x0 + pitch * i - cw / 2, x0 + pitch * i + cw / 2]
        xs = [max(x0, xs[0]), min(x1, xs[1])]
        if xs[1] - xs[0] < 0.05:
            continue
        p8 = [v3(xs[0], ytop, zo - 0.04), v3(xs[1], ytop, zo - 0.04), v3(xs[0], ytop + 0.06, zo - 0.04), v3(xs[1], ytop + 0.06, zo - 0.04),
              v3(xs[0], ytop, zo + pt + 0.03), v3(xs[1], ytop, zo + pt + 0.03), v3(xs[0], ytop + 0.11, zo + pt + 0.03), v3(xs[1], ytop + 0.11, zo + pt + 0.03)]
        P.hexa('stone', p8, shade=ss * 1.05, bevel=[(2, 3), (6, 7), (0, 1)] if lod == 0 else None, uv_rand=False, origin=Vector())
    if lod == 0:   # a few proud stones break both faces (kept off the segment ends)
        for face, zf in ((-1, zo), (1, zi)):
            for _ in range(q.get('proud', 5)):
                w, h = P.r(0.28, 0.5), P.r(0.18, 0.3)
                x = P.r(x0 + w, x1 - w)
                y = P.r(bh + 0.2 if face < 0 else 0.4, walk - 0.3)
                P.box('stone', v3(x, y, zf + face * 0.005), (w, h, 0.06), shade=vary(P, ss, 0.12), jitter=0.012)


def low_wall(P, q):
    """Field / yard wall segment of length L along x (tiles), thickness T, body height H, irregular overhanging capstones."""
    lod = P.lod
    L, T, H = q.get('length', 4.5), q.get('thickness', 0.6), q.get('height', 1.3)
    ss = S(q, 'stone')
    shared = random.Random(q.get('course_seed', 11))
    cs = courses(shared, H, 0.36, 0.5)
    offs = [(shared.uniform(-0.008, 0.008), shared.uniform(-0.008, 0.008), shared.uniform(0.014, 0.024)) for _ in cs]
    coursed_block(P, 'stone', -L / 2, L / 2, 0, H, -T / 2, T / 2, cs, offs, ss, lod)
    if lod:
        P.box('stone', v3(0, H + 0.065, 0), (L, 0.13, T + 0.14), shade=ss * 1.05, bevel=None, uv_rand=False)
        return
    x = -L / 2
    while x < L / 2 - 0.01:
        ln = min(P.r(0.42, 0.8), L / 2 - x)
        if L / 2 - (x + ln) < 0.3:
            ln = L / 2 - x
        h = P.r(0.1, 0.17)
        tilt = Matrix.Rotation(P.r(-0.05, 0.05), 3, X) @ Matrix.Rotation(P.r(-0.035, 0.035), 3, Z)
        ax = (tilt @ X, tilt @ Y, tilt @ Z)
        P.box('stone', v3(x + ln / 2, H + h / 2 - 0.01, P.r(-0.03, 0.03)), (ln - 0.014, h, T + P.r(0.08, 0.17)), axes=ax, shade=vary(P, ss * 1.05, 0.1), jitter=0.016)
        x += ln
    for face in (-1, 1):
        for _ in range(q.get('proud', 3)):
            w, h = P.r(0.25, 0.45), P.r(0.15, 0.25)
            P.box('stone', v3(P.r(-L / 2 + w, L / 2 - w), P.r(0.25, H - 0.3), face * (T / 2 + 0.008)), (w, h, 0.05), shade=vary(P, ss, 0.12), jitter=0.012)


# ---------------------------------------------------------------- tower / gatehouse
def arch(P, q, cx, zf, Nz, ow, sh, rv, depth, ss, nv, door=None):
    """Round arch opening in a face at z = zf (outward Nz = +-1): voussoirs with a long-and-short extrados, jamb stones, spandrel fill
    between the arch and the rectangular hole the face sheet leaves (cx +- ow/2, 0 .. sh + ow/2)."""
    lod = P.lod
    r = ow / 2
    cy = sh
    zin = zf - Nz * depth   # back of the reveal
    pr = Nz * 0.03          # voussoirs and jambs stand 3 cm proud
    # spandrels: the face between the semicircle and the hole's top corners
    n = 6
    for sgn in (-1, 1):
        pts = [v3(cx + sgn * r, cy + r, zf)] + [v3(cx + sgn * r * math.cos(a), cy + r * math.sin(a), zf) for a in [math.pi / 2 * (1 - k / n) for k in range(n + 1)]]
        P.poly('stone', pts, v3(0, 0, Nz), shade=ss)
    for i in range(nv):
        a0, a1 = math.pi * i / nv, math.pi * (i + 1) / nv
        ro = r + rv * (1.3 if (i % 2 == 0 and i not in (0, nv - 1)) else 1.0) + (0.04 if i == nv // 2 else 0)
        pts = []
        for k in range(8):
            a = a1 if k & 1 else a0
            rr = ro if k & 2 else r
            z = zf + pr if k & 4 else zin
            pts.append(v3(cx + rr * math.cos(a), cy + rr * math.sin(a), z))
        if lod == 0:
            gap = 0.006
            for k in range(8):
                pts[k] += (v3(-math.sin(a0), math.cos(a0), 0) if not k & 1 else v3(math.sin(a1), -math.cos(a1), 0)) * gap
        P.hexa('stone', pts, axes=(v3(math.cos((a0 + a1) / 2), math.sin((a0 + a1) / 2), 0), v3(-math.sin((a0 + a1) / 2), math.cos((a0 + a1) / 2), 0), Z),
               shade=vary(P, ss * 1.05, 0.08), bevel=K.HEXA_EDGES if lod == 0 else None)
    if lod == 0:   # mortar joints run through the whole reveal: a dark back in each, or the hollow shell's sky shows through
        rmax = r + rv * 1.3 + 0.06
        for j in range(nv + 1):
            a = math.pi * j / nv
            c, t = v3(math.cos(a), math.sin(a), 0), v3(-math.sin(a), math.cos(a), 0)
            base = v3(cx, cy, zin + Nz * 0.004)
            P.poly('dark', [base + c * (r - 0.005) - t * 0.02, base + c * rmax - t * 0.02, base + c * rmax + t * 0.02, base + c * (r - 0.005) + t * 0.02], v3(0, 0, Nz))
    # jambs: stacked stones lining both sides below the springing
    y = 0.0
    k = 0
    while y < sh - 0.05:
        h = min(sh - y, P.r(0.45, 0.65) if lod == 0 else sh)
        for sgn in (-1, 1):
            w = rv * (1.25 if (k + (sgn > 0)) % 2 else 0.95)
            xin = cx + sgn * r
            P.box('stone', v3(xin + sgn * w / 2, y + h / 2, (zf + pr + zin) / 2), (w, h - 0.006, abs(zf + pr - zin)), shade=vary(P, ss * 1.03, 0.08),
                  bevel=VERT_EDGES if lod == 0 else None, jitter=0.006 if lod == 0 else 0)
        y += h
        k += 1
    if door:   # arched plank door at the back of the reveal
        so = S(q, 'oak')
        zd = zin + Nz * 0.06
        np_ = 5 if lod == 0 else 1
        pw = ow / np_
        top = lambda x: cy + math.sqrt(max(0.0, r * r - (x - cx) ** 2))
        for i in range(np_):
            xa_, xb_ = cx - r + i * pw + 0.004, cx - r + (i + 1) * pw - 0.004
            xm = (xa_ + xb_) / 2
            prof = [v3(xa_, 0.02, 0), v3(xb_, 0.02, 0), v3(xb_, top(xb_) - 0.01, 0), v3(xm, top(xm) - 0.01, 0), v3(xa_, top(xa_) - 0.01, 0)]
            pts = [p + v3(0, 0, zd) for p in prof] + [p + v3(0, 0, zd + Nz * 0.06) for p in prof]
            m = len(prof)
            faces = [tuple(range(m)), tuple(range(m, 2 * m))] + [(j, (j + 1) % m, m + (j + 1) % m, m + j) for j in range(m)]
            P.solid('oak', pts, faces, axes=(Y, X, Z), shade=vary(P, so * 0.55, 0.12), bevel=[(1, 2), (4, 0), (m + 1, m + 2), (m + 4, m)] if lod == 0 else None)
        if lod == 0:
            for yy in (0.5, sh - 0.2):
                P.box('iron', v3(cx, yy, zd + Nz * 0.065), (ow - 0.1, 0.07, 0.014), shade=1.0, bevel=None)
        P.poly('dark', [v3(cx - r, 0, zd - Nz * 0.02), v3(cx + r, 0, zd - Nz * 0.02), v3(cx + r, cy + r, zd - Nz * 0.02), v3(cx - r, cy + r, zd - Nz * 0.02)], v3(0, 0, Nz))


def slit(P, at, u, v, N, U, ss, depth=0.42, w=0.13, h=0.95):
    """Arrow slit: a narrow hole with deep stone reveals, a dark back, a proud sill and lintel stone."""
    lod = P.lod
    P.poly('dark', [at(u - w / 2, v, depth), at(u + w / 2, v, depth), at(u + w / 2, v + h, depth), at(u - w / 2, v + h, depth)], N)
    if lod:
        return
    for uu, nn in ((u - w / 2, U), (u + w / 2, -U)):
        P.poly('stone', [at(uu, v, 0), at(uu, v, depth), at(uu, v + h, depth), at(uu, v + h, 0)], nn, shade=ss * 0.8)
    for vv, hh in ((v - 0.07, 0.14), (v + h + 0.07, 0.14)):
        P.box('stone', at(u, vv, 0.0), (w + P.r(0.35, 0.5), hh, 0.1), axes=(U, K.UP, N), shade=vary(P, ss * 1.05), jitter=0.008)
    P.poly('stone', [at(u - w / 2, v, 0), at(u + w / 2, v, 0), at(u + w / 2, v, depth), at(u - w / 2, v, depth)], K.UP, shade=ss * 0.9)
    P.poly('stone', [at(u - w / 2, v + h, 0), at(u - w / 2, v + h, depth), at(u + w / 2, v + h, depth), at(u + w / 2, v + h, 0)], -K.UP, shade=ss * 0.7)


def tower(P, q):
    """Square tower (watchtower) or gatehouse (passage through z). Footprint width (x) by depth (z); front (door / outer passage face) +z.
    Battered foot, quoined corners, slit windows, corbelled parapet with merlons."""
    lod = P.lod
    w, d, h = q.get('width', 4.0), q.get('depth', 4.0), q.get('height', 5.6)
    ss = S(q, 'stone')
    hw, hd = w / 2, d / 2
    passage = q.get('passage')
    door = q.get('door')
    bh = q.get('batter_h', 1.0)
    # faces: (N, origin corner, U, length, holes)
    faces = [(Z, v3(-hw, 0, hd), X, w), (-Z, v3(hw, 0, -hd), -X, w), (X, v3(hw, 0, hd), -Z, d), (-X, v3(-hw, 0, -hd), Z, d)]
    slits = q.get('slits', {'front': [], 'back': [[0.0, 3.0]], 'right': [[0.0, 2.4], [0.0, 4.1]], 'left': [[-0.6, 3.2]]})
    names = ['front', 'back', 'right', 'left']
    for (N, o, U, L), nm in zip(faces, names):
        at = lambda u, v, dd=0.0, o=o, U=U, N=N: o + U * u + K.UP * v - N * dd
        holes = []
        op = passage if (passage and nm in ('front', 'back')) else (door if (door and nm == 'front') else None)
        if op:
            ow, sh = op['width'], op['spring']
            holes.append((L / 2 - ow / 2, 0, L / 2 + ow / 2, sh + ow / 2))
        sl = [(L / 2 + s[0], s[1]) for s in slits.get(nm, [])]
        for u, v in sl:
            holes.append((u - 0.065, v, u + 0.065, v + 0.95))
        P.sheet('stone', o, U, K.UP, L, h, cell=0.9 if lod == 0 else 20, holes=holes, shade=ss, uv_origin=o,
                disp=(lambda u, v: 0.008 * math.sin(u * 3.3 + v * 1.7) * math.sin(v * 2.9)) if lod == 0 else None)
        for u, v in sl:
            slit(P, at, u, v, N, U, ss)
        if lod == 0:   # put-log holes left by the builders' scaffolding, in rows
            for vrow in q.get('putlog_rows', [1.9, 3.7]):
                for _ in range(q.get('putlogs', 3)):
                    u = P.r(0.5, L - 0.5)
                    if any(h[0] - 0.2 < u < h[2] + 0.2 and h[1] - 0.3 < vrow < h[3] + 0.3 for h in holes):
                        continue
                    s_ = P.r(0.11, 0.15)
                    P.poly('dark', [at(u, vrow, -0.012), at(u + s_, vrow, -0.012), at(u + s_, vrow + s_, -0.012), at(u, vrow + s_, -0.012)], N)
        if op:
            cxw = o + U * (L / 2)
            if N.z != 0:
                arch(P, q, cxw.x, o.z, N.z, op['width'], op['spring'], op.get('ring', 0.36), op.get('depth', 0.6) if passage else op.get('depth', 0.5), ss,
                     op.get('voussoirs', 11), door=None if passage else True)
    # roof / walk at the top so the shell is closed from above
    P.poly('stone', [v3(-hw, h - 0.02, -hd), v3(hw, h - 0.02, -hd), v3(hw, h - 0.02, hd), v3(-hw, h - 0.02, hd)], K.UP, shade=ss * 0.8)
    if passage:   # passage: side walls, barrel vault, portcullis grooves
        ow, sh = passage['width'], passage['spring']
        r = ow / 2
        dz = passage.get('depth', 0.6)
        z0, z1 = -hd + dz, hd - dz
        for sgn in (-1, 1):
            U = Z if sgn > 0 else -Z
            o = v3(sgn * r, 0, z0 if sgn > 0 else z1)
            P.sheet('stone', o, U, K.UP, z1 - z0, sh, cell=0.8 if lod == 0 else 20, shade=ss * 0.85)
            for zg in (z1 - 0.35, z0 + 0.35):
                P.box('dark', v3(sgn * (r + 0.02), (sh + r) / 2, zg), (0.1, sh + r, 0.12), shade=1.0, bevel=None)
        n = 10 if lod == 0 else 5
        pts, fcs = [], []
        for i in range(n + 1):
            a = math.pi * i / n
            for z in (z0, z1):
                pts.append(v3(r * math.cos(a), sh + r * math.sin(a), z))
        for i in range(n):
            a, b = 2 * i, 2 * (i + 1)
            fcs.append((a, a + 1, b + 1, b))   # inner side (faces the passage axis)
        P.solid('stone', pts, fcs, axes=(Z, X, Y), shade=ss * 0.75, recalc=False, uv_rand=False)   # (a, a+1, b+1, b) winds toward the axis
    # battered foot (mitred around the footprint), string course, corbel table, parapet and merlons
    ring = lambda prof, yb: P.sweep('stone', prof, [(v3(sx * hw, yb, sz * hd), v3(sx, 0, sz), K.UP) for sx, sz in ((1, 1), (1, -1), (-1, -1), (-1, 1))],
                                    closed_path=True, shade=vary(P, ss, 0.05), bevel_angle=math.radians(40) if lod == 0 else None, uv_rand=False, origin=Vector())
    bat = q.get('batter', 0.26)
    for N, o, U, L in faces:   # battered foot, one wedge per face (corners overlap), split around a passage
        segs = [(0.0, L)]
        op = passage if (passage and N.z != 0) else (door if (door and N == Z) else None)   # a door is cut through the foot too
        if op:
            g = op['width'] / 2 + op.get('ring', 0.36) + 0.05
            segs = [(0.0, L / 2 - g), (L / 2 + g, L)]
        for u0, u1 in segs:
            e0, e1 = (bat if u0 == 0 else 0), (bat if u1 == L else 0)
            p8 = [o + U * (u0 - e0) + N * bat, o + U * (u1 + e1) + N * bat, o + U * u0 + K.UP * bh + N * 0.01, o + U * u1 + K.UP * bh + N * 0.01,
                  o + U * u0 - N * 0.1, o + U * u1 - N * 0.1, o + U * u0 + K.UP * bh - N * 0.1, o + U * u1 + K.UP * bh - N * 0.1]
            P.hexa('stone', p8, axes=(U, K.UP, N), shade=vary(P, ss * 0.95, 0.04), bevel=[(2, 3)] if lod == 0 else None, uv_rand=False, origin=o)
    if lod == 0:
        ys = max(h * 0.55, (passage['spring'] + passage['width'] / 2 + passage.get('ring', 0.36) + 0.35) if passage else 0)
        ring([(-0.05, 0), (0.07, 0.0), (0.07, 0.1), (-0.05, 0.14)], ys)
    ov = q.get('parapet_ov', 0.45)   # parapet stands out on corbels; the gap behind it is the machicolation slot
    pt = q.get('parapet_t', 0.32)
    yp, breast, mh = h, q.get('breast', 0.55), q.get('merlon_h', 0.75)
    ring([(ov - pt, 0), (ov, 0), (ov, breast), (ov - pt, breast)], yp)
    ring([(ov - pt - 0.02, breast), (ov + 0.04, breast), (ov + 0.04, breast + 0.08), (ov - pt - 0.02, breast + 0.08)], yp) if lod == 0 else None
    if lod == 0:   # corbels: tapered brackets under the overhang, dark machicolation slots between them
        for N, o, U, L in faces:
            n = max(3, int(L / q.get('corbel_pitch', 0.95)))
            for i in range(n + 1):
                u = 0.15 + i * (L - 0.3) / n
                b0 = o + U * u + K.UP * (yp - 0.42)
                p8 = [b0 + U * (sx * 0.1) + K.UP * (sy * 0.42) + N * (-0.04 if sz == 0 else (ov if sy else 0.08)) for sz in (0, 1) for sy in (0, 1) for sx in (-1, 1)]
                P.hexa('stone', p8, axes=(U, K.UP, N), shade=vary(P, ss, 0.08), bevel=[(4, 6), (5, 7), (4, 5), (0, 4), (1, 5)])   # bracket: deep at the top, shallow at the foot
            P.poly('dark', [o + U * 0.1 + K.UP * (yp - 0.03), o + U * (L - 0.1) + K.UP * (yp - 0.03), o + U * (L - 0.1) + K.UP * (yp - 0.03) + N * (ov - pt + 0.01),
                            o + U * 0.1 + K.UP * (yp - 0.03) + N * (ov - pt + 0.01)], -K.UP)
    # merlons: one at each corner, one centred on each side
    ytop = yp + breast + (0.08 if lod == 0 else 0)
    for sx, sz in ((1, 1), (1, -1), (-1, -1), (-1, 1)):
        c = v3(sx * (hw + ov - 0.42), ytop + mh / 2, sz * (hd + ov - 0.42))
        P.box('stone', c, (0.84, mh, 0.84), shade=vary(P, ss, 0.06), jitter=0.01 if lod == 0 else 0, bevel=K.HEXA_EDGES if lod == 0 else None)
        P.box('stone', c + v3(0, mh / 2 + 0.05, 0), (0.92, 0.1, 0.92), shade=ss * 1.05, top_scale=0.88, jitter=0.008 if lod == 0 else 0, bevel=K.HEXA_EDGES if lod == 0 else None)
    for N, o, U, L in faces:
        c = o + U * (L / 2) + N * (ov - pt / 2) + K.UP * (ytop + mh / 2)
        mw = q.get('merlon_w', 0.95)
        P.box('stone', c, (mw, mh, pt), axes=(U, K.UP, N), shade=vary(P, ss, 0.06), jitter=0.01 if lod == 0 else 0, bevel=K.HEXA_EDGES if lod == 0 else None)
        P.box('stone', c + K.UP * (mh / 2 + 0.05), (mw + 0.08, 0.1, pt + 0.08), axes=(U, K.UP, N), shade=ss * 1.05, top_scale=0.88, bevel=K.HEXA_EDGES if lod == 0 else None)
    # quoins: long-and-short corner stones standing proud of both faces
    if lod == 0:
        yq, k = bh, 0
        while yq < h - 0.3:
            hq = min(q.get('quoin_h', 0.6), h - 0.25 - yq)
            for sx, sz in ((1, 1), (1, -1), (-1, -1), (-1, 1)):
                lx, lz = (0.62, 0.36) if (k + (sx * sz > 0)) % 2 else (0.36, 0.62)
                c = v3(sx * (hw - lx / 2 + 0.025), yq + hq / 2, sz * (hd - lz / 2 + 0.025))
                P.box('stone', c, (lx, hq - 0.012, lz), shade=vary(P, ss * 1.04, 0.08), jitter=0.01, bevel=VERT_EDGES + TOP_EDGES[:2])
            yq += hq
            k += 1


# ---------------------------------------------------------------- well
def well(P, q):
    """Round stone well (outer radius R) with a timber frame, windlass, bucket and a small boarded roof; frame posts on +-x."""
    lod = P.lod
    R, ri, h = q.get('radius', 0.95), q.get('inner', 0.66), q.get('height', 0.78)
    ss, so = S(q, 'stone'), S(q, 'oak')
    cs = [0, 0.24, 0.5, h - 0.1] if lod == 0 else [0, h - 0.1]
    for c, (y0, y1) in enumerate(zip(cs, cs[1:])):
        n = q.get('stones', 11) if lod == 0 else 1
        off = (c % 2) * math.pi / n
        if lod:
            P.cylinder('stone', v3(0, 0, 0), v3(0, h, 0), R, 14, shade=ss)
            P.cylinder('dark', v3(0, h - 0.05, 0), v3(0, h + 0.004, 0), ri, 14, shade=1.0, bevel=False)
            break
        for i in range(n):
            a0 = off + 2 * math.pi * i / n + 0.012
            a1 = off + 2 * math.pi * (i + 1) / n - 0.012 + P.r(-0.03, 0.03)
            ro = R + P.r(-0.025, 0.025)
            pts = []
            for k in range(8):
                a = a1 if k & 1 else a0
                rr = ro if k & 2 else ri
                y = (y1 if k & 4 else y0) + (P.r(-0.012, 0.012) if k & 4 else 0)
                pts.append(v3(rr * math.cos(a), y, rr * math.sin(a)))
            am = (a0 + a1) / 2
            P.hexa('stone', pts, axes=(v3(-math.sin(am), 0, math.cos(am)), Y, v3(math.cos(am), 0, math.sin(am))), shade=vary(P, ss, 0.1))
    if lod == 0:
        n = 9
        for i in range(n):   # coping
            a0, a1 = 2 * math.pi * i / n + 0.01, 2 * math.pi * (i + 1) / n - 0.01
            pts = []
            for k in range(8):
                a = a1 if k & 1 else a0
                rr = (R + 0.05) if k & 2 else (ri - 0.03)
                y = (h + 0.04 + P.r(-0.01, 0.01)) if k & 4 else h - 0.1
                pts.append(v3(rr * math.cos(a), y, rr * math.sin(a)))
            am = (a0 + a1) / 2
            P.hexa('stone', pts, axes=(v3(-math.sin(am), 0, math.cos(am)), Y, v3(math.cos(am), 0, math.sin(am))), shade=vary(P, ss * 1.05, 0.08))
        P.cylinder('dark', v3(0, 0.3, 0), v3(0, 0.31, 0), ri, 12, shade=1.0, bevel=False)
    # frame
    px = R + 0.1
    top = q.get('frame_h', 2.05)
    for sx in (-1, 1):
        P.beam('oak', v3(sx * px, 0, 0), v3(sx * px, top, 0), 0.14, 0.14, shade=vary(P, so * 0.8), wobble=0.006 if lod == 0 else 0)
        if lod == 0:
            for sz in (-1, 1):
                P.beam('oak', v3(sx * px, 0, sz * 0.5), v3(sx * px, 0.75, sz * 0.04), 0.09, 0.09, shade=vary(P, so * 0.75), ends=True)
    P.beam('oak', v3(-px - 0.25, top - 0.07, 0), v3(px + 0.25, top - 0.07, 0), 0.14, 0.14, shade=vary(P, so * 0.8), ends=lod == 0)
    P.cylinder('oak', v3(-px + 0.07, 1.3, 0), v3(px - 0.07, 1.3, 0), 0.085, 8 if lod == 0 else 6, shade=so * 0.7)
    if lod == 0:
        P.beam('iron', v3(px + 0.07, 1.3, 0), v3(px + 0.15, 1.3, 0), 0.03, 0.03, shade=1)
        P.beam('iron', v3(px + 0.15, 1.3, 0), v3(px + 0.15, 1.05, 0.12), 0.03, 0.03, shade=1)
        P.beam('iron', v3(px + 0.15, 1.05, 0.12), v3(px + 0.3, 1.05, 0.12), 0.035, 0.035, shade=1)
        P.cylinder('oak', v3(0.1, 1.24, 0), v3(0.1, 0.95, 0), 0.012, 4, shade=so * 0.6, bevel=False)
        P.cylinder('oak', v3(0.1, 0.95, 0), v3(0.1, 0.68, 0), 0.15, 9, shade=so * 0.7, r2=0.12)
        for yb in (0.72, 0.9):
            P.cylinder('iron', v3(0.1, yb - 0.015, 0), v3(0.1, yb + 0.015, 0), 0.142 if yb < 0.8 else 0.153, 9, shade=1, bevel=False, caps=False)
    # boarded roof
    pitch = math.radians(38)
    span = px + 0.4
    rise = span * math.tan(pitch)
    for sgn in (-1, 1):
        d = v3(sgn * math.cos(pitch), -math.sin(pitch), 0)
        nrm = v3(sgn * math.sin(pitch), math.cos(pitch), 0)
        L = span / math.cos(pitch)
        nb = 4 if lod == 0 else 1
        for i in range(nb):
            s0 = L * i / nb
            c = v3(0, top + rise + 0.02, 0) + d * (s0 + L / nb / 2) + nrm * (0.03 + 0.012 * (i % 2))
            P.box('wood', c, (L / nb + 0.03, 0.035, 1.5), axes=(d, nrm, Z), shade=vary(P, S(q, 'wood') * 1.4, 0.1), bevel=K.HEXA_EDGES if lod == 0 else None)
    P.beam('oak', v3(0, top + rise, -0.78), v3(0, top + rise, 0.78), 0.12, 0.14, shade=so * 0.7)
    for sz in (-0.62, 0.62):
        P.beam('oak', v3(-px, top, sz), v3(0, top + rise, sz), 0.08, 0.1, shade=so * 0.7)
        P.beam('oak', v3(px, top, sz), v3(0, top + rise, sz), 0.08, 0.1, shade=so * 0.7)


# ---------------------------------------------------------------- vehicles and stall
def wheel(P, c, r, spokes, width=0.075, rim=0.075, hub_r=0.1, so=0.7):
    """Spoked wheel centred at c, axle along x."""
    lod = P.lod
    P.cylinder('oak', c - X * 0.13, c + X * 0.13, hub_r, 8 if lod == 0 else 6, shade=so * 0.8, r2=hub_r * 0.8)
    n = spokes if lod == 0 else max(4, spokes // 2)
    for i in range(n):
        a = 2 * math.pi * i / n
        dv = v3(0, math.cos(a), math.sin(a))
        P.beam('oak', c + dv * (hub_r * 0.8), c + dv * (r - rim + 0.01), 0.045, 0.03, shade=vary(P, so * 0.85, 0.08))
    m = 14 if lod == 0 else 10
    path = [(c, v3(0, math.cos(2 * math.pi * i / m), math.sin(2 * math.pi * i / m)), X) for i in range(m)]
    P.sweep('oak', [(r - rim, -width / 2), (r - 0.012, -width / 2), (r - 0.012, width / 2), (r - rim, width / 2)], path, closed_path=True,
            shade=vary(P, so * 0.8), bevel_angle=math.radians(60) if lod == 0 else None, axes=(Y, Z, X))
    if lod == 0:
        P.sweep('iron', [(r - 0.013, -width / 2 - 0.004), (r, -width / 2 - 0.004), (r, width / 2 + 0.004), (r - 0.013, width / 2 + 0.004)], path, closed_path=True, shade=1.0)


def planks(P, slot, c, along, across, length, width, n, t, gap, shade, bevel=True):
    """n boards side by side (gap between) centred at c; boards run along `along`, laid out across `across`; t thick (normal = along x across)."""
    nrm = along.cross(across).normalized()
    pw = (width - gap * (n - 1)) / n
    for i in range(n):
        off = -width / 2 + pw / 2 + i * (pw + gap)
        P.box(slot, c + across * off + along * P.r(-0.01, 0.01), (length + P.r(-0.02, 0.02), pw - P.r(0, 0.008), t), axes=(along, across, nrm),
              shade=vary(P, shade, 0.12), bevel=K.HEXA_EDGES[:4] if (bevel and P.lod == 0) else None)


def cart(P, q):
    """Two-wheeled handcart; bed centred on the origin, shafts toward -z (like a typical handcart)."""
    lod = P.lod
    so = S(q, 'oak')
    bw, bl, by = q.get('bed_w', 1.1), q.get('bed_l', 1.5), q.get('bed_y', 0.62)
    planks(P, 'oak', v3(0, by, 0), Z, X, bl, bw, 5 if lod == 0 else 1, 0.05, 0.012, so * 0.85)
    for sx in (-1, 1):   # side boards with gaps, stakes
        for k in range(2 if lod == 0 else 1):
            hh = 0.15 if lod == 0 else 0.34
            planks(P, 'oak', v3(sx * (bw / 2 - 0.02), by + 0.12 + k * 0.18 if lod == 0 else by + 0.2, 0), Z, Y, bl, hh, 1, 0.035, 0, so * 0.8)
        for zz in (-bl / 2 + 0.06, 0, bl / 2 - 0.06):
            P.beam('oak', v3(sx * (bw / 2 + 0.02), by - 0.05, zz), v3(sx * (bw / 2 + 0.04), by + 0.45, zz), 0.05, 0.05, shade=vary(P, so * 0.75))
    for sz in (-1, 1):
        planks(P, 'oak', v3(0, by + 0.2, sz * (bl / 2 - 0.02)), X, Y, bw, 0.32, 2 if lod == 0 else 1, 0.035, 0.02, so * 0.8)
    for sx in (-0.42, 0.42):   # frame rails running out into shafts
        P.beam('oak', v3(sx, by - 0.07, bl / 2), v3(sx * 0.85, by - 0.15, -bl / 2 - 1.65), 0.07, 0.08, shade=vary(P, so * 0.8), ends=True)
    P.beam('oak', v3(-0.55, by - 0.08, 0.15), v3(0.55, by - 0.08, 0.15), 0.07, 0.07, shade=so * 0.7)   # axle tree
    for sx in (-0.66, 0.66):
        wheel(P, v3(sx, q.get('wheel_r', 0.5), 0.15), q.get('wheel_r', 0.5), 10, so=so)
    P.beam('oak', v3(0, 0.0, -bl / 2 + 0.05), v3(0, by - 0.1, -bl / 2 + 0.05), 0.06, 0.06, shade=so * 0.7)   # prop leg


def wagon(P, q):
    """Four-wheeled farm wagon; bed centred on the origin, tongue toward -z. wreck: front-left wheel off and lying flat, bed tilted."""
    lod = P.lod
    so = S(q, 'oak')
    bw, bl, by = q.get('bed_w', 1.55), q.get('bed_l', 3.3), q.get('bed_y', 0.72)
    planks(P, 'oak', v3(0, by, 0), Z, X, bl, bw, 6 if lod == 0 else 1, 0.05, 0.014, so * 0.8)
    for sx in (-1, 1):
        P.beam('oak', v3(sx * 0.45, by - 0.1, -bl / 2), v3(sx * 0.45, by - 0.1, bl / 2), 0.1, 0.12, shade=so * 0.7, ends=True)   # sills
        # sloped plank sides (wider at the top, as the reference cart), stakes
        flare = 0.12
        for k in range(3 if lod == 0 else 1):
            hh = 0.17 if lod == 0 else 0.55
            y = by + 0.12 + k * 0.19 if lod == 0 else by + 0.32
            x = sx * (bw / 2 + flare * (y - by) / 0.6)
            tilt = Matrix.Rotation(-sx * math.atan2(flare, 0.6), 3, Z)
            planks(P, 'oak', v3(x, y, 0), Z, tilt @ Y, bl + 0.04 * k, hh, 1, 0.035, 0, so * 0.82)
        for zz in (-bl / 2 + 0.1, -0.5, 0.5, bl / 2 - 0.1):
            P.beam('oak', v3(sx * (bw / 2 + 0.03), by - 0.12, zz), v3(sx * (bw / 2 + flare + 0.05), by + 0.68, zz), 0.06, 0.06, shade=vary(P, so * 0.7), ends=True)
    for sz in (-1, 1):
        planks(P, 'oak', v3(0, by + 0.28, sz * (bl / 2)), X, Y, bw + 0.1, 0.5, 3 if lod == 0 else 1, 0.035, 0.025, so * 0.78)
    wreck = q.get('wreck')
    rf, rr = q.get('front_r', 0.47), q.get('rear_r', 0.56)
    for z, r, sp in ((-1.15, rf, 10), (1.15, rr, 12)):
        P.beam('oak', v3(-0.98, r, z), v3(0.98, r, z), 0.1, 0.1, shade=so * 0.65, ends=True)   # axle
        P.beam('oak', v3(-0.5, r + 0.02, z), v3(-0.45, by - 0.12, z), 0.08, 0.08, shade=so * 0.65)
        P.beam('oak', v3(0.5, r + 0.02, z), v3(0.45, by - 0.12, z), 0.08, 0.08, shade=so * 0.65)
        for sx in (-1, 1):
            if wreck and sx < 0 and z < 0:
                continue
            wheel(P, v3(sx * 0.92, r, z), r, sp, so=so)
    P.beam('oak', v3(0, rf * 0.9, -1.15), v3(0, 0.5 if not wreck else 0.06, -3.4), 0.09, 0.09, shade=so * 0.7, ends=True)   # tongue
    if wreck:
        # sits on the bare front-left axle end, then the loose wheel lying flat beside it
        Mx = Matrix.Translation(v3(-0.98, rf, -1.15)) @ Matrix.Rotation(-0.07, 4, Z) @ Matrix.Rotation(-0.05, 4, X) @ Matrix.Translation(-v3(-0.98, rf, -1.15))
        P.transform(Mx)
        P.loose_wheel = (v3(-2.0, 0.075, -1.0), rf)   # built as its own Part by main() and laid flat there


def stall(P, q):
    """Market stall: front (counter) faces +x; four posts, plank counter with a boarded front, back shelf, striped canvas awning."""
    lod = P.lod
    so = S(q, 'oak')
    d, wd = q.get('depth', 1.0), q.get('width', 2.2)
    hf, hb = q.get('front_h', 2.15), q.get('back_h', 1.8)
    for sx, hh in ((1, hf), (-1, hb)):
        for sz in (-1, 1):
            P.beam('oak', v3(sx * d / 2, 0, sz * (wd / 2 - 0.05)), v3(sx * d / 2, hh, sz * (wd / 2 - 0.05)), 0.09, 0.09, shade=vary(P, so * 0.8), wobble=0.008 if lod == 0 else 0, ends=True)
        P.beam('oak', v3(sx * d / 2, hh - 0.05, -wd / 2 - 0.05), v3(sx * d / 2, hh - 0.05, wd / 2 + 0.05), 0.07, 0.08, shade=so * 0.75, ends=True)
    for sz in (-1, 1):   # side rails and braces
        P.beam('oak', v3(-d / 2, 0.85, sz * (wd / 2 - 0.05)), v3(d / 2, 0.85, sz * (wd / 2 - 0.05)), 0.06, 0.07, shade=so * 0.75)
        if lod == 0:
            P.beam('oak', v3(d / 2, hf - 0.45, sz * (wd / 2 - 0.05)), v3(d / 2, hf - 0.07, sz * (wd / 2 - 0.4)), 0.05, 0.05, shade=so * 0.7, ends=True)
    # counter: plank top over the front, boarded front from the ground
    planks(P, 'oak', v3(d / 2 - 0.22, 0.92, 0), Z, X, wd + 0.05, 0.6, 3 if lod == 0 else 1, 0.045, 0.012, so * 0.9)
    planks(P, 'oak', v3(d / 2 + 0.06, 0.48, 0), Y, Z, 0.84, wd - 0.05, 9 if lod == 0 else 1, 0.03, 0.01, so * 0.75)
    planks(P, 'oak', v3(-d / 2 + 0.2, 1.1, 0), Z, X, wd, 0.3, 2 if lod == 0 else 1, 0.035, 0.015, so * 0.8)   # back shelf
    # canvas: six stripes from the back rail over the front rail, sagging between, with a short valance
    stripes = q.get('stripes', [[0.95, 0.9, 0.78], [0.62, 0.22, 0.18]])
    n = 6
    ext = q.get('awning', 0.35)
    span = d + ext
    sag = 0.07 if lod == 0 else 0.0
    for i in range(n):
        z0 = -wd / 2 - 0.08 + (wd + 0.16) * i / n
        z1 = -wd / 2 - 0.08 + (wd + 0.16) * (i + 1) / n
        a = v3(-d / 2, hb + 0.05, z1)
        U = (v3(d / 2, hf + 0.05, z1) - a).normalized()
        Lr = (v3(d / 2, hf, 0) - v3(-d / 2, hb, 0)).length
        L = Lr * span / d
        sh = rgb_mul(stripes[i % len(stripes)], S(q, 'canvas'))
        disp = (lambda u, v: -sag * math.sin(math.pi * u / Lr) if u < Lr else -0.05 * (u - Lr) / (L - Lr)) if lod == 0 else None
        P.sheet('canvas', a, U, -Z, L, z1 - z0, cell=0.25 if lod == 0 else 9, disp=disp, shade=sh, back=0.008)
        if lod == 0:   # valance
            tip = a + U * L + v3(0, -0.05, 0)
            P.sheet('canvas', tip - v3(0, 0.26, 0), -Z, K.UP, z1 - z0, 0.26, cell=0.2, shade=tuple(x * 0.95 for x in sh), back=0.008,
                    disp=lambda u, v: 0.015 * math.sin(u * 9) * (1 - v / 0.26))


def rgb_mul(c, s):
    return tuple(x * s for x in c)


GENERATORS = {'house': house, 'curtain_wall': curtain_wall, 'low_wall': low_wall, 'tower': tower, 'well': well, 'cart': cart, 'wagon': wagon, 'stall': stall}


def color_fn_for(cfg):
    """Weathering in model space: darker damp foot, low-frequency mottling, moss on upward stone above 1.2 m."""
    W = cfg.get('weather', {})
    masonry, moss_slots = set(W.get('masonry', [])), set(W.get('moss', []))
    k = W.get('k', [0.14, 2.0, 0.045, 4.0])

    def fn(slot, p, n, s):
        if slot not in masonry:
            return s
        y = max(0.0, p.y)
        w = 1 - k[0] * math.exp(-y * k[1]) + k[2] * math.sin(p.x * 1.61 + p.z * 0.73) * math.cos(p.y * 1.4)
        damp = math.exp(-y * k[3])
        moss = (0.5 + 0.5 * math.sin(p.x * 2.3 + p.z * 1.7)) if (slot in moss_slots and n.y > 0.5 and y > 1.2) else 0.0
        return (s[0] * w * (1 - 0.1 * damp - 0.3 * moss), s[1] * w * (1 - 0.05 * damp + 0.02 * moss), s[2] * w * (1 - 0.02 * damp - 0.4 * moss))
    return fn


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    cfg_path, out = argv[0], argv[1]
    only = set(argv[2].split(',')) if len(argv) > 2 and argv[2] else None
    cfg = json.load(open(cfg_path, encoding='utf8'))
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = K.make_materials(cfg['slots'], cfg.get('preview', {}))
    color_fn = color_fn_for(cfg)
    report = {}
    for piece in cfg['pieces']:
        if only and piece['id'] not in only:
            continue
        gen = GENERATORS[piece['kind']]
        q = dict(piece.get('params', {}))
        q['_shade'] = cfg.get('shade', {})
        coll = bpy.data.collections.new(piece['id'])
        bpy.context.scene.collection.children.link(coll)
        roots, rep = [], {}
        nvar = piece.get('variants', 1)
        for v in range(nvar):
            for lod in (0, 1):
                tag = f"{piece['id']}{'_v%d' % v if nvar > 1 else ''}_LOD{lod}"
                root = bpy.data.objects.new(tag, None)
                coll.objects.link(root)
                P = K.Part(tag, cfg, seed=piece.get('seed', 0) * 101 + v * 7 + lod * 0, lod=lod)
                gen(P, q)
                objs = P.finish(mats, color_fn, coll, root)
                lw = getattr(P, 'loose_wheel', None)
                if lw:   # the wreck's loose wheel, built on its own and laid flat
                    P2 = K.Part(tag + '_wheel', cfg, seed=5, lod=lod)
                    wheel(P2, v3(0, 0, 0), lw[1], 10, so=S(q, 'oak') * 0.9)
                    P2.transform(Matrix.Translation(lw[0]) @ Matrix.Rotation(0.06, 4, X) @ Matrix.Rotation(math.pi / 2, 4, Z))
                    for s, ob in P2.finish(mats, color_fn, coll, root).items():
                        ob.name = f'{tag}_wheel_{s}'
                        objs[s + '_wheel'] = ob
                roots.append(root)
                rep[f'v{v}_LOD{lod}' if nvar > 1 else f'LOD{lod}'] = {'tris': K.tris(objs.values()), 'by_slot': {s: K.tris([ob]) for s, ob in sorted(objs.items())}}
        path = os.path.join(out, piece['id'] + '.glb')
        K.export_glb(path, roots)
        report[piece['id']] = rep
        print('KIT', piece['id'], json.dumps(rep))
    with open(os.path.join(out, 'kit-report.json'), 'w') as f:
        json.dump(report, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, 'kit.blend'))


main()
