from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label} anchor missing')
    return text.replace(old, new, 1)

# Core: make pointer provenance available to Memory SSA itself, using a build-local
# memo so pre-propagation observations cannot poison the public post-propagation cache.
p = Path('js/ir-core.js')
s = p.read_text()
marker = 'function locationOf(inst) {'
if marker not in s:
    raise SystemExit('locationOf anchor missing')
provenance = r'''function pointerShiftedConst(arg) {
  if (!arg || !arg.value || arg.value.const == null) return null;
  let v = arg.value.const;
  const shift = arg.shift;
  if (!shift) return v;
  const amount = BigInt(shift.amount || 0);
  if (shift.op === 'lsl') return v << amount;
  if (shift.op === 'lsr') return v >> amount;
  return null;
}

function pointerProvenanceKey(p) {
  if (!p) return null;
  return [p.kind, p.root, String(p.offset || 0n), p.address == null ? '' : String(p.address)].join(':');
}

const defaultPointerProvenanceMemo = new WeakMap();

/**
 * Conservative SSA pointer provenance. `must` only means every represented path
 * has the same symbolic root+constant offset; different roots are never assumed
 * distinct. Memory SSA passes a private memo because it runs before full value
 * propagation, while public consumers use the default post-build memo.
 */
export function pointerProvenance(value, active = null, memo = defaultPointerProvenanceMemo) {
  if (!value) return null;
  if (memo.has(value)) return memo.get(value);
  const visiting = active || new Set();
  if (visiting.has(value)) return { kind:'unknown', root:'value:' + value.id, rootValue:value, offset:0n, must:false, valueId:value.id };
  visiting.add(value);

  let out = null;
  const def = value.def;
  const reg = String(value.reg || '');
  if (value.kind === VK.ARG && (reg === 'sp' || reg === 'x29')) {
    out = { kind:'stack', root:'stack', rootValue:value, offset:0n, must:true, valueId:value.id };
  } else if (value.kind === VK.ARG && /^x[0-7]$/.test(reg)) {
    out = { kind:'arg', root:'arg:' + reg, rootValue:value, offset:0n, arg:reg, must:true, valueId:value.id };
  } else if (value.kind === VK.ARG && /^x(?:[89]|1\d|2\d|30)$/.test(reg)) {
    out = { kind:'entry-register', root:'entry:' + reg, rootValue:value, offset:0n, reg, must:true, valueId:value.id };
  } else if (def && def.op === OP.ADDR) {
    const address = value.const != null ? value.const : def.extra?.value;
    if (address != null) out = { kind:'global', root:'global', rootValue:value, offset:0n, address, must:true, valueId:value.id };
  } else if (def && def.op === OP.CALL) {
    out = { kind:'return', root:'return:' + def.id, rootValue:value, offset:0n,
      target:def.extra?.target ?? null, must:true, valueId:value.id };
  } else if (def && def.op === OP.LOAD) {
    out = { kind:'field', root:'loaded:' + value.id, rootValue:value, offset:0n,
      location:def.loc || null, must:true, valueId:value.id };
  } else if (def && def.op === OP.MOV && def.args?.[0]?.value) {
    const source = pointerProvenance(def.args[0].value, visiting, memo);
    if (source) out = { ...source, valueId:value.id, via:'mov' };
  } else if (def && def.op === OP.PHI && def.args?.length) {
    const alternatives = def.args.map((arg) => arg?.value ? pointerProvenance(arg.value, visiting, memo) : null);
    const keys = alternatives.map(pointerProvenanceKey);
    if (keys[0] && keys.every((key) => key === keys[0])) {
      out = { ...alternatives[0], valueId:value.id, via:'phi', must:alternatives.every((x) => x && x.must !== false) };
    } else {
      out = { kind:'phi', root:'phi:' + value.id, rootValue:value, offset:0n, must:false,
        alternatives:alternatives.filter(Boolean), valueId:value.id };
    }
  } else if (def && def.op === OP.BIN && (def.sub === 'add' || def.sub === 'sub') && def.args?.length >= 2) {
    const a = def.args[0], b = def.args[1];
    const ac = pointerShiftedConst(a), bc = pointerShiftedConst(b);
    if (bc != null && a?.value) {
      const source = pointerProvenance(a.value, visiting, memo);
      if (source && source.kind !== 'phi') {
        const delta = def.sub === 'sub' ? -bc : bc;
        out = { ...source, offset:(source.offset || 0n) + delta, valueId:value.id, via:def.sub + '-constant' };
      }
    } else if (def.sub === 'add' && ac != null && b?.value) {
      const source = pointerProvenance(b.value, visiting, memo);
      if (source && source.kind !== 'phi') {
        out = { ...source, offset:(source.offset || 0n) + ac, valueId:value.id, via:'add-constant' };
      }
    }
  }

  if (!out) out = { kind:'unknown', root:'value:' + value.id, rootValue:value, offset:0n, must:true, valueId:value.id };
  visiting.delete(value);
  memo.set(value, out);
  return out;
}

'''
s = s.replace(marker, provenance + marker, 1)

start = s.index('function locationOf(inst) {')
end = s.index('/** 2 つの場所が同じ番地を指しうるか。', start)
new_location = r'''function locationOf(inst, pointerMemo = defaultPointerProvenanceMemo) {
  const a = inst.addr;
  if (!a) return null;
  const size = Number(a.size || inst.extra?.size || 0) || 0;
  if (a.index || a.disp == null || !a.base) return { key:`unknown:${inst.id}`, kind:MK.UNKNOWN, size };
  if (a.stack) {
    const baseReg = a.baseReg || a.base?.reg || 'stack';
    const frameEpoch = a.base?.id ?? -1;
    return { key:`stack:${baseReg}:e${frameEpoch}:${a.disp.toString()}:s${size}`, kind:MK.STACK, baseReg, frameEpoch, disp:a.disp, size };
  }
  const base = a.base;
  if (base.const != null) {
    const address = base.const + a.disp;
    return { key:'global:' + address.toString(16) + ':s' + size, kind:MK.GLOBAL, address, size };
  }

  const provenance = pointerProvenance(base, null, pointerMemo);
  if (provenance?.must !== false && provenance?.kind === 'global' && provenance.address != null) {
    const address = provenance.address + (provenance.offset || 0n) + a.disp;
    return { key:'global:' + address.toString(16) + ':s' + size, kind:MK.GLOBAL, address, size, provenance };
  }

  // Canonicalize only proven same-root pointer arithmetic/copies. Ambiguous PHIs
  // keep their own root and are handled as may-alias clobbers below.
  const canonical = provenance && provenance.must !== false && provenance.kind !== 'phi';
  const aliasRoot = canonical && provenance.root ? provenance.root : 'value:' + base.id;
  const disp = canonical ? a.disp + (provenance.offset || 0n) : a.disp;
  const canonicalBase = canonical && provenance.rootValue ? provenance.rootValue : base;
  return {
    key:'field:' + aliasRoot + '+' + disp.toString() + ':s' + size,
    kind:MK.FIELD,
    base:canonicalBase,
    rawBase:base,
    aliasRoot,
    disp,
    size,
    provenance:canonical ? provenance : null,
  };
}

'''
s = s[:start] + new_location + s[end:]

old = r'''  // field 同士: ベースが同じ SSA 値なら、オフセットの重なりだけで判定できる
  if (a.base && b.base && a.base.id === b.base.id) {
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(a.disp + sa <= b.disp || b.disp + sb <= a.disp);
  }
  return true;
'''
new = r'''  // field 同士: must-alias root が同じ場合だけoffsetでnon-overlapを証明できる。
  const ar = a.aliasRoot || (a.base ? 'value:' + a.base.id : null);
  const br = b.aliasRoot || (b.base ? 'value:' + b.base.id : null);
  if (ar && br && ar === br && a.disp != null && b.disp != null) {
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(a.disp + sa <= b.disp || b.disp + sb <= a.disp);
  }
  return true;
'''
s = replace_once(s, old, new, 'mayAlias field')

old = r'''  if (storeLoc.kind === MK.FIELD) {
    if (!storeLoc.base || !otherLoc.base || storeLoc.base.id !== otherLoc.base.id) return false;
    if (storeLoc.disp == null || otherLoc.disp == null) return false;
    return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
  }
'''
new = r'''  if (storeLoc.kind === MK.FIELD) {
    const storeRoot = storeLoc.aliasRoot || (storeLoc.base ? 'value:' + storeLoc.base.id : null);
    const otherRoot = otherLoc.aliasRoot || (otherLoc.base ? 'value:' + otherLoc.base.id : null);
    if (storeRoot && otherRoot && storeRoot === otherRoot) {
      if (storeLoc.disp == null || otherLoc.disp == null) return true;
      return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
    }
    // Different symbolic pointer roots are *not* proof of distinct objects.
    // Conservatively clobber the other field range so stale stores cannot become
    // semantic truth. A future noalias/distinct-object proof may refine this.
    return true;
  }
'''
s = replace_once(s, old, new, 'store overlap field')

s = replace_once(s,
'''function buildMemorySSA(ir, df, idom, children) {
  const locs = new Map();
''',
'''function buildMemorySSA(ir, df, idom, children) {
  const pointerMemo = new WeakMap();
  const locs = new Map();
''', 'memory pointer memo')
s = replace_once(s, '      const loc = locationOf(inst);', '      const loc = locationOf(inst, pointerMemo);', 'memory location call')
p.write_text(s)

# Public facade: use the core provenance implementation instead of maintaining a
# second copy with independent semantics.
p = Path('js/ir.js')
s = p.read_text()
s = replace_once(s, '  OP, MK, VK, COND,\n', '  OP, MK, VK, COND, pointerProvenance,\n', 'ir facade import')
a = s.index('function provenanceKey(p) {')
b = s.index('function effectiveLocation(loc) {', a)
s = s[:a] + s[b:]
p.write_text(s)

# Regression tests exercise Memory-SSA truth directly and the dataflow facade.
p = Path('tests/ir-alias.mjs')
s = p.read_text()
s = replace_once(s,
"import { findValueUpdates, findValueUpdatesLegacy } from '../js/dataflow.js';\n",
"import { findValueUpdates, findValueUpdatesLegacy } from '../js/dataflow.js';\nimport { buildIR, OP } from '../js/ir.js';\n",
'alias test import')
insert = r'''

test('Memory SSA canonicalizes MOV aliases and reaches the latest exact store', () => {
  const ir = buildIR(modelOf([
    'mov x1, x0',
    'mov w8, #5',
    'str w8, [x0, #0x20]',
    'mov w9, #7',
    'str w9, [x1, #0x20]',
    'ldr w10, [x0, #0x20]',
    'ret',
  ]));
  const stores = ir.instructions.filter((x) => x.op === OP.STORE);
  const load = ir.instructions.find((x) => x.op === OP.LOAD && x.row === 5);
  ok(stores.length === 2 && stores[0].loc.key === stores[1].loc.key, 'MOV aliases must share one Memory-SSA location');
  ok(load?.reachingStore?.row === 4, 'load must reach the second aliasing store, not stale row 2');
});

test('Memory SSA canonicalizes zero-offset pointer ADD aliases', () => {
  const ir = buildIR(modelOf([
    'add x1, x0, #0',
    'mov w8, #7',
    'str w8, [x1, #0x20]',
    'ldr w9, [x0, #0x20]',
    'ret',
  ]));
  const store = ir.instructions.find((x) => x.op === OP.STORE);
  const load = ir.instructions.find((x) => x.op === OP.LOAD);
  ok(store?.loc.key === load?.loc.key, 'zero-offset ADD must preserve pointer identity');
  ok(load?.reachingStore === store, 'load must reach store through zero-offset alias');
});

test('Memory SSA canonicalizes PHI when every incoming pointer has the same provenance', () => {
  const ir = buildIR(modelOf([
    'cmp w2, #0',
    'b.eq #0x100000010',
    'mov x1, x0',
    'b #0x100000014',
    'mov x1, x0',
    'mov w8, #7',
    'str w8, [x1, #0x20]',
    'ldr w9, [x0, #0x20]',
    'ret',
  ]));
  const store = ir.instructions.find((x) => x.op === OP.STORE);
  const load = ir.instructions.find((x) => x.op === OP.LOAD);
  ok(store?.loc.key === load?.loc.key, 'same-provenance PHI must retain one alias class');
  ok(load?.reachingStore === store, 'PHI alias must preserve exact reaching store');
});

test('different pointer arguments remain may-alias and clobber stale reaching stores', () => {
  const ir = buildIR(modelOf([
    'mov w8, #5',
    'str w8, [x0, #0x20]',
    'mov w9, #7',
    'str w9, [x1, #0x20]',
    'ldr w10, [x0, #0x20]',
    'ret',
  ]));
  const load = ir.instructions.find((x) => x.op === OP.LOAD);
  ok(!load?.reachingStore, 'x1 store must invalidate stale x0 reachingStore');
  ok(load?.memUse?.kind === 'clobber' && load.memUse.inst?.row === 3, 'may-alias store must be represented as the reaching clobber');
});

test('may-alias object store blocks false RMW evidence across p/q', () => {
  const model = modelOf([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'mov w9, #7',
    'str w9, [x1, #0x20]',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const modern = findValueUpdates(model);
  ok(!modern.some((u) => u.store?.row === 4 && u.kind === 'read-modify-write'), 'may-alias clobber must prevent false RMW proof');
});

test('proven stack storage remains distinct from an object field store', () => {
  const ir = buildIR(modelOf([
    'mov w8, #5',
    'str w8, [sp, #0x20]',
    'mov w9, #7',
    'str w9, [x0, #0x20]',
    'ldr w10, [sp, #0x20]',
    'ret',
  ]));
  const load = ir.instructions.find((x) => x.op === OP.LOAD && x.row === 4);
  ok(load?.reachingStore?.row === 1, 'different proven storage classes must not destroy stack precision');
});

test('overlapping partial store clobbers a wider field reaching store', () => {
  const ir = buildIR(modelOf([
    'str x8, [x0, #0x20]',
    'strb w9, [x0, #0x24]',
    'ldr x10, [x0, #0x20]',
    'ret',
  ]));
  const load = ir.instructions.find((x) => x.op === OP.LOAD);
  ok(!load?.reachingStore, 'partial overlapping store must invalidate wider exact value');
  ok(load?.memUse?.kind === 'clobber' && load.memUse.inst?.row === 1, 'partial overlap must remain explicit clobber evidence');
});
'''
s = replace_once(s, "\nprocess.stdout.write('\\n' + passed + ' passed, ' + failures.length + ' failed\\n');", insert + "\nprocess.stdout.write('\\n' + passed + ' passed, ' + failures.length + ' failed\\n');", 'alias test insertion')
p.write_text(s)

print('applied issue #574 Memory-SSA alias soundness patch')
