# bpdsl: write game rules once as a small AST, then (a) interpret it in plain Python (fast debugging, a differential oracle)
# or (b) emit it as a Blueprint graph from headless UE 5.8 Python (unreal.BlueprintGraphEditor, see BP-PROBE.md).
# Everything is int / bool / string. No floats. Pure BP nodes re-evaluate at each consumer, so an expression is
# built fresh per statement and never shared between statements (no hidden reads-after-writes).
import math

# ---------------------------------------------------------------- expressions
class E:
    def __init__(s, kind, *a): s.kind, s.a = kind, a
    def _b(s, op, o, rev=False):
        o = wrap(o)
        return E('bin', op, o, s) if rev else E('bin', op, s, o)
    def __add__(s, o): return s._b('add', o)
    def __radd__(s, o): return s._b('add', o, True)
    def __sub__(s, o): return s._b('sub', o)
    def __rsub__(s, o): return s._b('sub', o, True)
    def __mul__(s, o): return s._b('mul', o)
    def __rmul__(s, o): return s._b('mul', o, True)
    def __floordiv__(s, o): return s._b('div', o)
    def __mod__(s, o): return s._b('mod', o)
    def __getitem__(s, i):
        assert s.kind == 'v', 'only member arrays can be indexed'
        return E('idx', s.a[0], wrap(i))
    __hash__ = object.__hash__

def wrap(x): return x if isinstance(x, E) else E('k', x)
def K(x): return E('k', x)
def V(name): return E('v', name)       # member variable (or member array)
def L(name): return E('l', name)       # function parameter or local variable
def eq(a, b): return wrap(a)._b('eq', b)
def ne(a, b): return wrap(a)._b('ne', b)
def lt(a, b): return wrap(a)._b('lt', b)
def le(a, b): return wrap(a)._b('le', b)
def gt(a, b): return wrap(a)._b('gt', b)
def ge(a, b): return wrap(a)._b('ge', b)
def and_(*xs):
    r = wrap(xs[0])
    for x in xs[1:]: r = r._b('and', x)
    return r
def or_(*xs):
    r = wrap(xs[0])
    for x in xs[1:]: r = r._b('or', x)
    return r
def not_(a): return E('un', 'not', wrap(a))
def mx(a, b): return wrap(a)._b('max', b)
def mn(a, b): return wrap(a)._b('min', b)
def sel(c, a, b): return E('sel', wrap(c), wrap(a), wrap(b))   # a when c
def isin(x, *vals): return or_(*[eq(x, v) for v in vals])
def cat(*parts):
    r = wrap(parts[0])
    for p in parts[1:]: r = E('str', 'cat', r, wrap(p))
    return r
def i2s(a): return E('str', 'i2s', wrap(a))
def s2i(a): return E('str', 's2i', wrap(a))
def has(a, b): return E('str', 'has', wrap(a), wrap(b))
def seq(a, b): return E('str', 'seq', wrap(a), wrap(b))
def length(name): return E('len', name)

# ---------------------------------------------------------------- program
class Func:
    def __init__(s, name, ins=(), outs=()):
        s.name, s.ins, s.outs, s.locals, s.body, s.ret = name, list(ins), list(outs), [], [], {}

class Program:
    def __init__(s):
        s.vars = {}      # name -> type: 'int' | 'string' | 'int[]' | 'string[]'
        s.defaults = {}
        s.funcs = {}
        s.events = {}    # 'BeginPlay' / 'Tick' -> body
        s.vgroup, s.fgroup = {}, {}   # name -> 'sim' | 'spec' (which Blueprint class owns it)
    def var(s, name, typ='int', default=None):
        assert name not in s.vars, name
        s.vars[name] = typ
        if default is not None: s.defaults[name] = default
        return V(name)
    def func(s, name, ins=(), outs=()):
        f = Func(name, ins, outs)
        assert name not in s.funcs, name
        s.funcs[name] = f
        return Body(f)
    def event(s, name):
        b = Body(Func('event_' + name))
        s.events[name] = b.f
        return b

class Body:
    """statement builder: `with b.if_(c):` / `with b.else_():` / `with b.for_('i', 0, 3) as i:`"""
    def __init__(s, f): s.f, s.stack = f, [f.body]
    def _add(s, st): s.stack[-1].append(st)
    def local(s, name, typ='int'):
        s.f.locals.append((name, typ)); return L(name)
    def set(s, name, e): s._add(('set', name, wrap(e)))
    def seti(s, name, i, e): s._add(('seti', name, wrap(i), wrap(e)))
    def setl(s, name, e): s._add(('setl', name, wrap(e)))
    def resize(s, name, n): s._add(('resize', name, wrap(n)))
    def parse(s, name, src, delim): s._add(('parse', name, wrap(src), wrap(delim)))
    def call(s, fname, ret=None, **args): s._add(('call', fname, {k: wrap(v) for k, v in args.items()}, ret or {}))
    def print(s, e): s._add(('print', wrap(e)))
    def returns(s, **vals): s.f.ret = {k: wrap(v) for k, v in vals.items()}
    def if_(s, cond): return _Blk(s, 'if', wrap(cond))
    def else_(s): return _Blk(s, 'else')
    def while_(s, cond): return _Blk(s, 'while', wrap(cond))
    def for_(s, var, lo, hi):
        if not any(n == var for n, _ in s.f.locals): s.f.locals.append((var, 'int'))
        return _Blk(s, 'for', var, wrap(lo), wrap(hi))

class _Blk:
    def __init__(s, b, kind, *a): s.b, s.kind, s.a, s.blk = b, kind, a, []
    def __enter__(s):
        s.b.stack.append(s.blk)
        return L(s.a[0]) if s.kind == 'for' else None
    def __exit__(s, *x):
        s.b.stack.pop()
        par = s.b.stack[-1]
        if s.kind == 'if': par.append(('if', s.a[0], s.blk, []))
        elif s.kind == 'else':
            assert par and par[-1][0] == 'if' and not par[-1][3], 'else without if'
            par[-1][3].extend(s.blk)
        elif s.kind == 'while': par.append(('while', s.a[0], s.blk))
        else: par.append(('for', s.a[0], s.a[1], s.a[2], s.blk))

# ---------------------------------------------------------------- interpreter backend
def _tdiv(a, b): return int(a / b) if abs(a) < 2**52 and abs(b) < 2**52 else a // b
def _tmod(a, b): return a - b * _tdiv(a, b)
BIN = {'add': lambda a, b: a + b, 'sub': lambda a, b: a - b, 'mul': lambda a, b: a * b,
       'div': lambda a, b: 0 if b == 0 else _tdiv(a, b), 'mod': lambda a, b: 0 if b == 0 else _tmod(a, b),
       'eq': lambda a, b: a == b, 'ne': lambda a, b: a != b, 'lt': lambda a, b: a < b, 'le': lambda a, b: a <= b,
       'gt': lambda a, b: a > b, 'ge': lambda a, b: a >= b, 'and': lambda a, b: bool(a) and bool(b),
       'or': lambda a, b: bool(a) or bool(b), 'max': max, 'min': min}

class Interp:
    def __init__(s, prog):
        s.p = prog
        s.st = {}
        for n, t in prog.vars.items():
            s.st[n] = [] if t.endswith('[]') else ('' if t == 'string' else 0)
        for n, d in prog.defaults.items(): s.st[n] = d
        s.prints = []
        s.steps = 0
    def ev(s, e, env):
        k = e.kind
        if k == 'k': return e.a[0]
        if k == 'v': return s.st[e.a[0]]
        if k == 'l': return env[e.a[0]]
        if k == 'idx':
            arr = s.st[e.a[0]]; i = s.ev(e.a[1], env)
            if 0 <= i < len(arr): return arr[i]
            return '' if s.p.vars[e.a[0]] == 'string[]' else 0
        if k == 'bin':
            r = BIN[e.a[0]](s.ev(e.a[1], env), s.ev(e.a[2], env))
            return r
        if k == 'un': return not s.ev(e.a[1], env)
        if k == 'sel': return s.ev(e.a[1], env) if s.ev(e.a[0], env) else s.ev(e.a[2], env)
        if k == 'len': return len(s.st[e.a[0]])
        if k == 'str':
            op = e.a[0]; x = [s.ev(a, env) for a in e.a[1:]]
            if op == 'cat': return x[0] + x[1]
            if op == 'i2s': return str(x[0])
            if op == 's2i':
                try: return int(x[0])
                except ValueError: return 0
            if op == 'has': return x[1] in x[0]
            if op == 'seq': return x[0] == x[1]
        raise ValueError(k)
    def run_block(s, blk, env):
        for st in blk: s.run_st(st, env)
    def run_st(s, st, env):
        k = st[0]; s.steps += 1
        if k == 'set': s.st[st[1]] = s.ev(st[2], env)
        elif k == 'seti':
            arr = s.st[st[1]]; i = s.ev(st[2], env); v = s.ev(st[3], env)
            if i >= len(arr): arr.extend([('' if s.p.vars[st[1]] == 'string[]' else 0)] * (i + 1 - len(arr)))
            arr[i] = v
        elif k == 'setl': env[st[1]] = s.ev(st[2], env)
        elif k == 'resize':
            arr = s.st[st[1]]; n = s.ev(st[2], env)
            del arr[n:]; arr.extend([('' if s.p.vars[st[1]] == 'string[]' else 0)] * (n - len(arr)))
        elif k == 'parse':
            s.st[st[1]] = [t for t in s.ev(st[2], env).split(s.ev(st[3], env)) if t]
        elif k == 'if':
            s.run_block(st[2] if s.ev(st[1], env) else st[3], env)
        elif k == 'while':
            n = 0
            while s.ev(st[1], env):
                s.run_block(st[2], env); n += 1
                assert n < 10_000_000, 'interpreter: runaway while'
        elif k == 'for':
            lo, hi = s.ev(st[2], env), s.ev(st[3], env)
            for i in range(lo, hi + 1):
                env[st[1]] = i; s.run_block(st[4], env)
        elif k == 'print': s.prints.append(s.ev(st[1], env)); print(s.prints[-1])
        elif k == 'call':
            args = {a: s.ev(e, env) for a, e in st[2].items()}
            out = s.call(st[1], **args)
            for o, loc in st[3].items(): env[loc] = out[o]
        else: raise ValueError(k)
    def call(s, name, **args):
        f = s.p.funcs[name]
        env = {n: 0 for n, _ in f.ins}; env.update({n: ('' if t == 'string' else 0) for n, t in f.locals}); env.update(args)
        s.run_block(f.body, env)
        return {o: s.ev(e, env) for o, e in f.ret.items()}

# ---------------------------------------------------------------- Blueprint emitter (UE 5.8 Python)
MATH, STR, ARR, SYS = ('/Script/Engine.KismetMathLibrary:', '/Script/Engine.KismetStringLibrary:',
                       '/Script/Engine.KismetArrayLibrary:', '/Script/Engine.KismetSystemLibrary:')
BP_BIN = {'add': 'Add_IntInt', 'sub': 'Subtract_IntInt', 'mul': 'Multiply_IntInt', 'div': 'Divide_IntInt', 'mod': 'Percent_IntInt',
          'eq': 'EqualEqual_IntInt', 'ne': 'NotEqual_IntInt', 'lt': 'Less_IntInt', 'le': 'LessEqual_IntInt', 'gt': 'Greater_IntInt',
          'ge': 'GreaterEqual_IntInt', 'and': 'BooleanAND', 'or': 'BooleanOR', 'max': 'Max', 'min': 'Min'}

class Emitter:
    def __init__(s, unreal, prog, bp_path, parent, group='sim'):
        s.u, s.p, s.path, s.group = unreal, prog, bp_path, group
        s.BEL, s.GE = unreal.BlueprintEditorLibrary, unreal.BlueprintGraphEditor
        s.X = s.BEL.find_execute_pin
        s.nodes = 0
        s.parent = parent
        s.bp = s.BEL.create_blueprint_asset_with_parent(bp_path, parent)
        assert s.bp, 'create blueprint ' + bp_path

    # types
    def T(s, t):
        b = s.BEL.get_basic_type_by_name
        if t.endswith('[]'): return s.BEL.get_array_type(b(t[:-2]))
        return b(t)

    def declare(s):
        for n, t in s.p.vars.items():
            if s.p.vgroup.get(n, 'sim') != s.group: continue
            assert s.BEL.add_member_variable(s.bp, n, s.T(t)), 'member var ' + n
        for f in s.p.funcs.values():
            if s.p.fgroup.get(f.name, 'sim') != s.group: continue
            ed = s.GE.create_and_edit_function_graph(s.bp, f.name)
            assert ed, 'function ' + f.name
            for n, t in f.ins: ed.add_graph_input_parameter(n, s.T(t))
            for n, t in f.outs: ed.add_graph_output_parameter(n, s.T(t))
        assert s.BEL.compile_blueprint(s.bp) is not False  # skeleton: own functions become callable

    # ---- per-graph context
    class Ctx: pass

    def node(s, path):
        n = s.cx.ed.add_call_function_node(path)
        assert n, 'missing node ' + path
        s.nodes += 1
        return n

    def wire(s, a, b, what=''):
        assert a.is_valid() and b.is_valid() and a.try_create_connection(b), 'wire failed ' + what

    def tail_to(s, pin):
        for t in s.cx.tails: s.wire(t, pin, 'exec')
        s.cx.tails = []

    def stmt_node(s, n, then=None):
        s.tail_to(s.X(n)); s.cx.tails = [then if then is not None else s.BEL.find_then_pin(n)]

    def is_wild(s, pin): return 'Wildcard' in str(pin.get_pin_type_display_string())

    def feed(s, e, pin):
        e = wrap(e)
        if e.kind == 'k' and not s.is_wild(pin):
            v = e.a[0]
            sv = ('true' if v else 'false') if isinstance(v, bool) else str(v)
            assert pin.set_pin_value(sv), f'set literal {sv} on {pin.get_pin_name()}'
            return
        s.wire(s.expr(e), pin, 'data ' + str(e.kind))

    def lit(s, v):
        if isinstance(v, bool): n, f = s.node(SYS + 'MakeLiteralBool'), 'Value'; sv = 'true' if v else 'false'
        elif isinstance(v, int): n, f = s.node(SYS + 'MakeLiteralInt'), 'Value'; sv = str(v)
        else: n, f = s.node(SYS + 'MakeLiteralString'), 'Value'; sv = v
        assert n.find_input_pin(f).set_pin_value(sv)
        return n.find_output_pin('ReturnValue')

    def expr(s, e):
        k, a = e.kind, e.a
        if k == 'k': return s.lit(a[0])
        if k == 'v':
            n = s.cx.ed.add_get_member_variable_node(a[0]); s.nodes += 1
            return n.find_output_pin(a[0])
        if k == 'l':
            if a[0] in s.cx.params: return s.cx.params[a[0]]
            n = s.cx.ed.add_get_local_variable_node(a[0]); s.nodes += 1
            return n.find_output_pin(a[0])
        if k == 'idx':
            n = s.node(ARR + 'Array_Get')
            s.feed(V(a[0]), n.find_input_pin('TargetArray'))
            s.feed(a[1], n.find_input_pin('Index'))
            return n.find_output_pin('Item')
        if k == 'len':
            n = s.node(ARR + 'Array_Length'); s.feed(V(a[0]), n.find_input_pin('TargetArray'))
            return n.find_output_pin('ReturnValue')
        if k == 'bin':
            n = s.node(MATH + BP_BIN[a[0]])
            ops = [(a[1], n.find_input_pin('A')), (a[2], n.find_input_pin('B'))]
            ops.sort(key=lambda t: t[0].kind == 'k')  # a non-literal first resolves the wildcard pins
            for x, p in ops: s.feed(x, p)
            return n.find_output_pin('ReturnValue')
        if k == 'un':
            n = s.node(MATH + 'Not_PreBool'); s.feed(a[1], n.find_input_pin('A')); return n.find_output_pin('ReturnValue')
        if k == 'sel':
            n = s.node(MATH + 'SelectInt')
            s.feed(a[0], n.find_input_pin('bPickA')); s.feed(a[1], n.find_input_pin('A')); s.feed(a[2], n.find_input_pin('B'))
            return n.find_output_pin('ReturnValue')
        if k == 'str':
            op = a[0]
            if op == 'cat':
                n = s.node(STR + 'Concat_StrStr'); s.feed(a[1], n.find_input_pin('A')); s.feed(a[2], n.find_input_pin('B'))
            elif op == 'i2s':
                n = s.node(STR + 'Conv_IntToString'); s.feed(a[1], n.find_input_pin('InInt'))
            elif op == 's2i':
                n = s.node(STR + 'Conv_StringToInt'); s.feed(a[1], n.find_input_pin('InString'))
            elif op == 'has':
                n = s.node(STR + 'Contains'); s.feed(a[1], n.find_input_pin('SearchIn')); s.feed(a[2], n.find_input_pin('Substring'))
                n.find_input_pin('bUseCase').set_pin_value('true')
            elif op == 'seq':
                n = s.node(STR + 'EqualEqual_StrStr'); s.feed(a[1], n.find_input_pin('A')); s.feed(a[2], n.find_input_pin('B'))
            else: raise ValueError(op)
            return n.find_output_pin('ReturnValue')
        raise ValueError(k)

    # ---- statements
    def block(s, blk):
        for st in blk: s.stmt(st)

    def stmt(s, st):
        k = st[0]
        if k == 'set':
            n = s.cx.ed.add_set_member_variable_node(st[1]); s.nodes += 1
            s.feed(st[2], n.find_input_pin(st[1])); s.stmt_node(n)
        elif k == 'setl':
            n = s.cx.ed.add_set_local_variable_node(st[1]); s.nodes += 1
            s.feed(st[2], n.find_input_pin(st[1])); s.stmt_node(n)
        elif k == 'seti':
            n = s.node(ARR + 'Array_Set')
            s.feed(V(st[1]), n.find_input_pin('TargetArray')); s.feed(st[2], n.find_input_pin('Index'))
            s.feed(st[3], n.find_input_pin('Item')); n.find_input_pin('bSizeToFit').set_pin_value('true')
            s.stmt_node(n)
        elif k == 'resize':
            n = s.node(ARR + 'Array_Resize'); s.feed(V(st[1]), n.find_input_pin('TargetArray')); s.feed(st[2], n.find_input_pin('Size'))
            s.stmt_node(n)
        elif k == 'parse':
            pn = s.node(STR + 'ParseIntoArray')
            s.feed(st[2], pn.find_input_pin('SourceString')); s.feed(st[3], pn.find_input_pin('Delimiter'))
            pn.find_input_pin('CullEmptyStrings').set_pin_value('true')
            n = s.cx.ed.add_set_member_variable_node(st[1]); s.nodes += 1
            s.wire(pn.find_output_pin('ReturnValue'), n.find_input_pin(st[1]), 'parse result')
            s.stmt_node(n)
        elif k == 'print':
            n = s.node(SYS + 'PrintString'); s.feed(st[1], n.find_input_pin('InString'))
            n.find_input_pin('bPrintToScreen').set_pin_value('false'); s.stmt_node(n)
        elif k == 'call':
            n = s.node(st[1])
            for a, e in st[2].items():
                pin = n.find_input_pin(a); assert pin.is_valid(), f'{st[1]} has no input {a}'
                s.feed(e, pin)
            s.stmt_node(n)
            for o, loc in st[3].items():
                ln = s.cx.ed.add_set_local_variable_node(loc); s.nodes += 1
                s.wire(n.find_output_pin(o), ln.find_input_pin(loc), 'call result')
                s.stmt_node(ln)
        elif k == 'if':
            br = s.cx.ed.add_branch_node(); s.nodes += 1
            s.feed(st[1], s.BEL.find_condition_pin(br)); s.tail_to(s.X(br))
            s.cx.tails = [s.BEL.find_then_pin(br)]; s.block(st[2]); t1 = s.cx.tails
            s.cx.tails = [s.BEL.find_else_pin(br)]; s.block(st[3]); s.cx.tails = t1 + s.cx.tails
        elif k == 'while':
            br = s.cx.ed.add_branch_node(); s.nodes += 1
            s.feed(st[1], s.BEL.find_condition_pin(br)); s.tail_to(s.X(br))
            s.cx.tails = [s.BEL.find_then_pin(br)]; s.block(st[2])
            for t in s.cx.tails: s.wire(t, s.X(br), 'loop back edge')
            s.cx.tails = [s.BEL.find_else_pin(br)]
        elif k == 'for':
            m = s.cx.ed.add_macro_node('/Engine/EditorBlueprintResources/StandardMacros.StandardMacros:ForLoop'); s.nodes += 1
            s.feed(st[2], m.find_input_pin('FirstIndex')); s.feed(st[3], m.find_input_pin('LastIndex')); s.tail_to(s.X(m))
            idx = m.find_output_pin('Index')
            ln = s.cx.ed.add_set_local_variable_node(st[1]); s.nodes += 1   # copy Index into the named local at body start
            s.wire(idx, ln.find_input_pin(st[1]), 'loop index')
            s.wire(m.find_output_pin('LoopBody'), s.X(ln), 'loop body')
            s.cx.tails = [s.BEL.find_then_pin(ln)]; s.block(st[4])
            # the body's exec chain simply ends: the macro pops back to the loop itself (no back edge)
            s.cx.tails = [m.find_output_pin('Completed')]
        else: raise ValueError(k)

    def build_func(s, f):
        ed = s.GE.get_graph_editor(s.BEL.find_graph(s.bp, f.name))
        assert ed, 'graph ' + f.name
        cx = s.cx = s.Ctx(); cx.ed = ed
        entry = ed.find_graph_entry_pin(); en = entry.get_owning_node()
        cx.params = {n: en.find_output_pin(n) for n, _ in f.ins}
        for n, t in f.locals:
            assert ed.add_local_variable(n, s.T(t)), 'local ' + n
        cx.tails = [entry]
        s.block(f.body)
        if f.outs:
            ret = ed.list_nodes_of_class(s.u.K2Node_FunctionResult)[0]
            for o, e in f.ret.items(): s.feed(e, ret.find_input_pin(o))
            s.tail_to(s.X(ret))

    def build_event(s, name, f):
        ed = s.GE.get_graph_editor(s.BEL.find_event_graph(s.bp))
        cx = s.cx = s.Ctx(); cx.ed = ed; cx.params = {}
        ev = s.BEL.add_event_override(s.bp, 'Receive' + name, s.u.IntPoint(0, 0))
        assert ev, 'event ' + name
        cx.tails = [s.BEL.find_then_pin(ev)]
        assert not f.locals, 'event graphs use no locals'
        s.block(f.body)

    def build(s):
        s.declare()
        for f in s.p.funcs.values():
            if s.p.fgroup.get(f.name, 'sim') == s.group: s.build_func(f)
        if s.group == 'spec':
            for n, f in s.p.events.items(): s.build_event(n, f)
        ok = s.BEL.compile_blueprint(s.bp)
        errs = []
        for g in s.BEL.list_graphs(s.bp):
            e = s.GE.get_graph_editor(g)
            if e: errs += [s.BEL.get_node_title(x) for x in e.list_nodes_with_errors()]
        return errs
