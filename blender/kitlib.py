"""Procedural game-kit helpers for Blender 4.5 (run through tools/blender-run.mjs). Generic: no game names here.

Authoring is in GAME coordinates (glTF/three: x right, y up, z toward the viewer); B() converts to Blender (z up) only when
vertices are written, so the export (export_yup) lands back in game coordinates.

A Part collects geometry per material slot for one LOD of one kit piece:
  solid()  closed shapes with shared vertices (boxes, beams, irregular stones, wedges, swept profiles); UVs are projected per face
           onto the shape's own axes in metres / units[slot] (world scale, so the game's tiling textures keep their size);
           slots in `long_grain` put U along the longest axis (wood grain), others put V up the slope (courses stay level);
  sheet()  a subdivided panel with rectangular holes and an optional displacement (plaster infill, wall faces, canvas);
  finish() bevels the chosen hard edges (bmesh, 1 segment), marks sharp edges by angle, area-weighted normals, bakes the vertex colour
           (shade per element x a colour callback) and makes one mesh object per slot, named '<part>_<slot>'.
"""
import bpy, bmesh, math, random
from mathutils import Vector, Matrix

UP = Vector((0, 1, 0))


def B(p):
    return Vector((p[0], -p[2], p[1]))


def G(p):
    return Vector((p[0], p[2], -p[1]))


def V(*a):
    return Vector(a if len(a) == 3 else a[0])


def rgb(s):
    return (s, s, s) if isinstance(s, (int, float)) else tuple(s)


HEXA_FACES = [(0, 2, 6, 4), (1, 5, 7, 3), (0, 4, 5, 1), (2, 3, 7, 6), (0, 1, 3, 2), (4, 6, 7, 5)]
HEXA_EDGES = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]   # 4 along each local axis, in axis order


class Part:
    def __init__(self, name, cfg, seed=0, lod=0):
        self.name, self.cfg, self.lod = name, cfg, lod
        self.rng = random.Random(seed)
        self.units = cfg.get('units', {})
        self.long_grain = set(cfg.get('long_grain', ['wood', 'oak']))
        self.bms, self.bevel_edges = {}, {}

    # ---------- low level ----------
    def _bm(self, slot):
        if slot not in self.bms:
            bm = bmesh.new()
            bm.loops.layers.uv.new('UVMap')
            bm.loops.layers.float_color.new('shade')
            self.bms[slot] = bm
            self.bevel_edges[slot] = {}   # ordered (dict), so the bevel and the export are byte-for-byte repeatable
        return self.bms[slot]

    def r(self, a, b):
        return self.rng.uniform(a, b)

    def _frame(self, n, axes, ext, slot):
        k = max(range(3), key=lambda i: abs(n.dot(axes[i])))
        a, b = [i for i in range(3) if i != k]
        A, Bv = axes[a], axes[b]
        if slot not in self.long_grain and max(abs(A.y), abs(Bv.y)) > 0.3:
            Vv, U = (A, Bv) if abs(A.y) > abs(Bv.y) else (Bv, A)
        else:
            U, Vv = (A, Bv) if ext[a] >= ext[b] else (Bv, A)
        if Vv.y < -1e-6:
            Vv = -Vv
        return U, Vv

    def solid(self, slot, pts, faces, axes=None, shade=1.0, bevel=None, uv_rand=True, origin=None, recalc=True):
        """pts: game-space points; faces: index tuples (any winding; normals are recalculated outward);
        axes: three unit vectors for UV projection (default world axes); bevel: edge index pairs to bevel ('all' = every edge)."""
        bm = self._bm(slot)
        uvl, cl = bm.loops.layers.uv['UVMap'], bm.loops.layers.float_color['shade']
        pts = [Vector(p) for p in pts]
        axes = axes or (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
        c = sum(pts, Vector()) / len(pts)
        ext = [max(p.dot(ax) for p in pts) - min(p.dot(ax) for p in pts) for ax in axes]
        o = Vector(origin) if origin is not None else (c if uv_rand else Vector())
        off = (self.r(0, 1), self.r(0, 1)) if uv_rand else (0.0, 0.0)
        vs = [bm.verts.new(B(p)) for p in pts]
        fs = []
        for f in faces:
            try:
                fs.append(bm.faces.new([vs[i] for i in f]))
            except ValueError:
                pass
        if recalc:   # closed shapes: outward normals whatever the winding; open surfaces keep the caller's CCW-from-front winding
            bmesh.ops.recalc_face_normals(bm, faces=fs)
        s = self.units.get(slot, 1.0)
        col = rgb(shade)
        for f in fs:
            n = G(f.normal)
            U, Vv = self._frame(n, axes, ext, slot)
            for l in f.loops:
                d = G(l.vert.co) - o
                l[uvl].uv = (d.dot(U) / s + off[0], d.dot(Vv) / s + off[1])
                l[cl] = (*col, 1.0)
        if bevel:
            pairs = [(i, j) for f in faces for i, j in zip(f, f[1:] + f[:1])] if bevel == 'all' else bevel
            for i, j in pairs:
                e = bm.edges.get((vs[i], vs[j]))
                if e:
                    self.bevel_edges[slot][e] = None
        return vs

    # ---------- shapes ----------
    def poly(self, slot, pts, N, shade=1.0, uv_rand=False, axes=None):
        """One flat one-sided face whose front faces N (gable infill, arch spandrels, dark recess backs)."""
        pts = [Vector(p) for p in pts]
        n = sum(((pts[i] - pts[0]).cross(pts[i + 1] - pts[0]) for i in range(1, len(pts) - 1)), Vector())
        if n.dot(Vector(N)) < 0:
            pts = pts[::-1]
        return self.solid(slot, pts, [tuple(range(len(pts)))], axes, shade, None, uv_rand, recalc=False)

    def transform(self, M):
        """Apply a game-space 4x4 matrix to everything built so far (e.g. tilt a wreck)."""
        for bm in self.bms.values():
            for v in bm.verts:
                v.co = B(M @ G(v.co))


    def hexa(self, slot, p8, axes=None, shade=1.0, bevel='all', uv_rand=True, origin=None):
        """8 corners in bit order (bit0 = +axis0, bit1 = +axis1, bit2 = +axis2)."""
        if bevel == 'all':
            bevel = HEXA_EDGES
        return self.solid(slot, p8, HEXA_FACES, axes, shade, bevel, uv_rand, origin)

    def box(self, slot, c, size, axes=None, shade=1.0, jitter=0.0, bevel='all', uv_rand=True, origin=None, top_scale=1.0, top_inset=0.0):
        """Box centred at c with full size (along axes; default world). jitter moves each corner randomly (irregular stones);
        top_scale < 1 tapers the +axis1 face (merlon, chimney); top_inset sets the +axis1 face back by that much on both axis2 sides
        (a laid course: the course above overhangs it, so the joint reads as a thin shadow line)."""
        axes = axes or (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
        c = Vector(c)
        pts = []
        for k in range(8):
            sx, sy, sz = (1 if k & 1 else -1), (1 if k & 2 else -1), (1 if k & 4 else -1)
            t = top_scale if sy > 0 else 1.0
            p = c + axes[0] * (sx * size[0] / 2 * t) + axes[1] * (sy * size[1] / 2) + axes[2] * (sz * (size[2] / 2 * t - (top_inset if sy > 0 else 0.0)))
            if jitter:
                p += Vector((self.r(-jitter, jitter), self.r(-jitter, jitter) * 0.6, self.r(-jitter, jitter)))
            pts.append(p)
        return self.hexa(slot, pts, axes, shade, bevel, uv_rand, origin)

    def beam(self, slot, a, b, w, d, shade=1.0, roll=0.0, wobble=0.0, ends=False, extend=0.0):
        """Timber from a to b, section w (side) x d (depth). wobble: random endpoint offset (m) and roll (rad) so no two members are
        perfectly parallel. Bevels the 4 long edges (plus the end edges when ends=True)."""
        a, b = Vector(a), Vector(b)
        L = (b - a).normalized()
        a, b = a - L * extend, b + L * extend
        if wobble:
            a = a + Vector((self.r(-1, 1), self.r(-1, 1), self.r(-1, 1))) * wobble
            b = b + Vector((self.r(-1, 1), self.r(-1, 1), self.r(-1, 1))) * wobble
            roll += self.r(-1, 1) * wobble * 1.5
        L = (b - a)
        ln = L.length
        L.normalize()
        side = Vector((1, 0, 0)) if abs(L.y) > 0.95 else UP.cross(L).normalized()
        if roll:
            side = Matrix.Rotation(roll, 3, L) @ side
        third = L.cross(side).normalized()
        c = (a + b) / 2
        bev = HEXA_EDGES[:4] + (HEXA_EDGES[4:] if ends else [])
        return self.box(slot, c, (ln, w, d), (L, side, third), shade, bevel=bev)

    def sweep(self, slot, profile, path, closed_path=False, shade=1.0, axes=None, bevel_angle=None, uv_rand=True, caps=True, origin=None):
        """Extrude a closed 2-D profile along a path. profile: [(a, b)] in the path frame (a along `side`, b along `up` of each station);
        path: [(point, side, up)] game-space. Closed paths make rings (wheel rims, well copings)."""
        n, m = len(profile), len(path)
        pts = []
        for p, side, up in path:
            for a, b in profile:
                pts.append(Vector(p) + Vector(side) * a + Vector(up) * b)
        faces = []
        segs = m if closed_path else m - 1
        for i in range(segs):
            i2 = (i + 1) % m
            for j in range(n):
                j2 = (j + 1) % n
                faces.append((i * n + j, i * n + j2, i2 * n + j2, i2 * n + j))
        if caps and not closed_path:
            faces.append(tuple(range(n)))
            faces.append(tuple((m - 1) * n + j for j in range(n)))
        bev = None
        if bevel_angle is not None:   # bevel the edges running along the path at profile corners sharper than bevel_angle
            bev = []
            for j in range(n):
                p0, p1, p2 = Vector((*profile[j - 1], 0)), Vector((*profile[j], 0)), Vector((*profile[(j + 1) % n], 0))
                d1, d2 = (p1 - p0).normalized(), (p2 - p1).normalized()
                if math.acos(max(-1, min(1, d1.dot(d2)))) > bevel_angle:
                    bev += [(i * n + j, ((i + 1) % m) * n + j) for i in range(segs)]
        return self.solid(slot, pts, faces, axes, shade, bev, uv_rand, origin)

    def cylinder(self, slot, a, b, r, n=8, shade=1.0, r2=None, bevel=True, caps=True):
        a, b = Vector(a), Vector(b)
        L = (b - a).normalized()
        side = Vector((1, 0, 0)) if abs(L.y) > 0.95 else UP.cross(L).normalized()
        up = L.cross(side).normalized()
        prof = [(math.cos(2 * math.pi * i / n), math.sin(2 * math.pi * i / n)) for i in range(n)]
        path = [(a, side * r, up * r), (b, side * (r2 or r), up * (r2 or r))]
        pts = [Vector(p) + Vector(s) * x + Vector(u) * y for p, s, u in path for x, y in prof]
        faces = [(j, (j + 1) % n, n + (j + 1) % n, n + j) for j in range(n)]
        if caps:
            faces += [tuple(range(n)), tuple(n + j for j in range(n))]
        bev = [(j, (j + 1) % n) for j in range(n)] + [(n + j, n + (j + 1) % n) for j in range(n)] if bevel and caps else None
        return self.solid(slot, pts, faces, (L, side, up), shade, bev)

    def sheet(self, slot, o, U, Vv, w, h, cell=0.6, holes=(), disp=None, shade=1.0, back=0.0, uv_origin=None):
        """Panel from corner o spanning w along U and h along Vv; its front faces U x Vv. holes: [(u0, v0, u1, v1)] in metres.
        disp(u, v) -> offset along the normal. back > 0 adds a back face that far behind (canvas, thin boards)."""
        o, U, Vv = Vector(o), Vector(U).normalized(), Vector(Vv).normalized()
        N = U.cross(Vv).normalized()
        us = {round(w * i / max(1, round(w / cell)), 4) for i in range(max(1, round(w / cell)) + 1)}
        vs_ = {round(h * i / max(1, round(h / cell)), 4) for i in range(max(1, round(h / cell)) + 1)}
        for u0, v0, u1, v1 in holes:
            us |= {round(u0, 4), round(u1, 4)}
            vs_ |= {round(v0, 4), round(v1, 4)}
        # rounding can push the far edge a hair past w or h: clamp instead of dropping it
        us, vs_ = sorted({min(max(x, 0.0), w) for x in us if -1e-3 <= x <= w + 1e-3}), sorted({min(max(x, 0.0), h) for x in vs_ if -1e-3 <= x <= h + 1e-3})
        inside = lambda u, v: any(u0 < u < u1 and v0 < v < v1 for u0, v0, u1, v1 in holes)
        bm = self._bm(slot)
        uvl, cl = bm.loops.layers.uv['UVMap'], bm.loops.layers.float_color['shade']
        s = self.units.get(slot, 1.0)
        uo = Vector(uv_origin) if uv_origin is not None else Vector()
        col = rgb(shade)
        for layer, sign in ((0.0, 1), (back, -1)) if back else ((0.0, 1),):
            grid = {}
            for i, u in enumerate(us):
                for j, v in enumerate(vs_):
                    p = o + U * u + Vv * v + N * ((disp(u, v) if disp else 0.0) - layer)
                    grid[i, j] = bm.verts.new(B(p))
            for i in range(len(us) - 1):
                for j in range(len(vs_) - 1):
                    if inside((us[i] + us[i + 1]) / 2, (vs_[j] + vs_[j + 1]) / 2):
                        continue
                    q = [grid[i, j], grid[i + 1, j], grid[i + 1, j + 1], grid[i, j + 1]]
                    f = bm.faces.new(q if sign > 0 else q[::-1])   # B() is a proper rotation: CCW about U x V stays the front
                    for l in f.loops:
                        d = G(l.vert.co) - uo
                        l[uvl].uv = (d.dot(U) / s, d.dot(Vv) / s)
                        l[cl] = (*col, 1.0)
        return N

    # ---------- finish ----------
    def finish(self, materials, color_fn=None, collection=None, parent=None):
        """Bevel, normals, vertex colour; returns {slot: object}. color_fn(slot, p_game, n_game, shade_rgb) -> rgb."""
        bev_w = self.cfg.get('bevel', {})
        sharp_deg = self.cfg.get('sharp_angle', 50 if self.lod == 0 else 30)
        objs = {}
        for slot, bm in self.bms.items():
            w = bev_w.get(slot, 0.0) if self.lod == 0 else 0.0
            edges = [e for e in self.bevel_edges[slot] if e.is_valid and len(e.link_faces) == 2]
            if w > 0 and edges:
                bmesh.ops.bevel(bm, geom=edges, offset=w, offset_type='OFFSET', profile_type='SUPERELLIPSE', segments=1, profile=0.5,
                                affect='EDGES', clamp_overlap=True, loop_slide=True, mark_seam=False, mark_sharp=False, harden_normals=False,
                                face_strength_mode='NONE', miter_outer='SHARP', miter_inner='SHARP', spread=0.1, vmesh_method='ADJ')
            bm.normal_update()
            thr = math.radians(sharp_deg)
            for e in bm.edges:
                e.smooth = not (len(e.link_faces) == 2 and e.calc_face_angle(0) > thr)
            for f in bm.faces:
                f.smooth = True
            me = bpy.data.meshes.new(f'{self.name}_{slot}')
            bm.to_mesh(me)
            bm.free()
            # colour: shade x color_fn, per corner
            shade = me.attributes['shade']
            col = me.color_attributes.new('Color', 'FLOAT_COLOR', 'CORNER')
            for poly in me.polygons:
                n = G(poly.normal)
                for li in poly.loop_indices:
                    p = G(me.vertices[me.loops[li].vertex_index].co)
                    sc = shade.data[li].color[:3]
                    c = color_fn(slot, p, n, sc) if color_fn else sc
                    col.data[li].color = (*(min(1.0, max(0.0, x)) for x in c), 1.0)
            me.attributes.remove(me.attributes['shade'])
            me.color_attributes.active_color = col
            me.color_attributes.render_color_index = me.color_attributes.find('Color')
            me.materials.append(materials[slot])
            ob = bpy.data.objects.new(me.name, me)
            (collection or bpy.context.scene.collection).objects.link(ob)
            if parent:
                ob.parent = parent
            mod = ob.modifiers.new('wn', 'WEIGHTED_NORMAL')
            mod.keep_sharp, mod.mode, mod.weight = True, 'FACE_AREA', 50
            with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
                bpy.ops.object.modifier_apply(modifier=mod.name)
            objs[slot] = ob
        self.bms = {}
        return objs


def tris(objs):
    return sum(sum(len(p.vertices) - 2 for p in ob.data.polygons) for ob in objs)


def make_materials(slots, preview):
    """One material per slot, each with its own base colour (optimize-gltf's dedup merges materials that differ only by name)."""
    mats = {}
    for i, s in enumerate(slots):
        m = bpy.data.materials.get(s) or bpy.data.materials.new(s)
        m.use_nodes = True
        hexc = preview.get(s, '#808080')
        c = [int(hexc[k:k + 2], 16) / 255 for k in (1, 3, 5)]
        c[2] = min(1.0, c[2] + i * 1e-3)   # keep factors distinct even if two previews match
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = (*[x ** 2.2 for x in c], 1)
        bsdf.inputs['Roughness'].default_value = 1.0
        m.diffuse_color = (*[x ** 2.2 for x in c], 1)
        mats[s] = m
    return mats


def export_glb(path, roots):
    bpy.ops.object.select_all(action='DESELECT')
    for r in roots:
        r.select_set(True)
        for ch in r.children_recursive:
            ch.select_set(True)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True, export_normals=True,
              export_texcoords=True, export_tangents=False, export_materials='EXPORT', export_extras=False, export_cameras=False,
              export_lights=False, export_animations=False, export_skins=False, export_morph=False)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    if 'export_vertex_color' in props:
        kw['export_vertex_color'] = 'ACTIVE'
    else:
        kw['export_colors'] = True
    bpy.ops.export_scene.gltf(**kw)
