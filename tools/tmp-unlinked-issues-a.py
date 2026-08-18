from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))

# #786 + #788
replace_once('js/symbolic/executor.js', "import { OP, MK, COND } from '../ir.js';", "import { OP, MK, COND, mayAliasProvenance } from '../ir.js';")
replace_once('js/symbolic/executor.js', '''function cmp(name, a, b) {
  if (a?.kind === SYM.CONST && b?.kind === SYM.CONST) {
    const av=a.value, bv=b.value;
    const yes = name === '==' ? av === bv : name === '!=' ? av !== bv : name === '<' ? av < bv : name === '<=' ? av <= bv : name === '>' ? av > bv : name === '>=' ? av >= bv : null;
    if (yes != null) return { ...c(yes ? 1n : 0n), boolean:true };
  }
  return { kind: SYM.OP, op: name, args: [a, b], boolean: true };
}''', '''function cmp(name, a, b, options = {}) {
  const bits = Math.max(1, Math.min(64, Number(options.bits) || 64));
  const signed = options.signed === true ? true : options.signed === false ? false : null;
  if (a?.kind === SYM.CONST && b?.kind === SYM.CONST) {
    const au = BigInt.asUintN(bits, a.value), bu = BigInt.asUintN(bits, b.value);
    const av = signed === true ? BigInt.asIntN(bits, au) : au;
    const bv = signed === true ? BigInt.asIntN(bits, bu) : bu;
    const yes = name === '==' ? au === bu : name === '!=' ? au !== bu : name === '<' ? av < bv : name === '<=' ? av <= bv : name === '>' ? av > bv : name === '>=' ? av >= bv : null;
    if (yes != null) return { ...c(yes ? 1n : 0n), boolean:true, bits, signed };
  }
  return { kind: SYM.OP, op: name, args: [a, b], boolean: true, bits, signed };
}
function conditionIdentity(condition) {
  if (condition?.kind === SYM.OP && condition.boolean && ['==', '!=', '<', '<=', '>', '>='].includes(condition.op)) {
    const mode = condition.signed === true ? 's' : condition.signed === false ? 'u' : 'n';
    return `${mode}${condition.bits || 64}:${expressionText(condition)}`;
  }
  return expressionText(condition);
}''')
replace_once('js/symbolic/executor.js', '''  const key = expressionText(condition);
  for (const prior of existing || []) {
    if (prior?.kind === SYM.CONST && prior.boolean && prior.value === 0n) return false;
    if (expressionText(negate(prior)) === key) return false;
  }''', '''  const key = conditionIdentity(condition);
  for (const prior of existing || []) {
    if (prior?.kind === SYM.CONST && prior.boolean && prior.value === 0n) return false;
    if (conditionIdentity(negate(prior)) === key) return false;
  }''')
replace_once('js/symbolic/executor.js', '''  const a = evalValue(cmpInst.args[0].value, state, ir, opts, memo, active);
  const b = evalValue(cmpInst.args[1].value, state, ir, opts, memo, active);
  return cmp(info.op, a, b);''', '''  const a = evalValue(cmpInst.args[0].value, state, ir, opts, memo, active);
  const b = evalValue(cmpInst.args[1].value, state, ir, opts, memo, active);
  const bits = Number(cmpInst.args[0]?.bits || cmpInst.args[0]?.value?.bits || cmpInst.args[1]?.bits || cmpInst.args[1]?.value?.bits || 64);
  return cmp(info.op, a, b, { bits, signed: info.signed });''')
replace_once('js/symbolic/executor.js', '''  const key = locationKey(inst.loc);
  if (key && state.memory.has(key)) return state.memory.get(key);''', '''  const key = locationKey(inst.loc);
  if (key && state.memory.has(key)) {
    const remembered = state.memory.get(key);
    return remembered && remembered.value ? remembered.value : remembered;
  }''')
replace_once('js/symbolic/executor.js', '''        const key = locationKey(inst.loc);
        const value = inst.args[0] ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set()) : unknown('missing-store-value');
        if (key) state.memory.set(key, value);''', '''        const key = locationKey(inst.loc);
        const value = inst.args[0] ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set()) : unknown('missing-store-value');
        for (const [knownKey, remembered] of Array.from(state.memory.entries())) {
          const knownLocation = remembered && remembered.location ? remembered.location : null;
          if (!knownLocation || mayAliasProvenance(knownLocation, inst.loc)) state.memory.delete(knownKey);
        }
        if (key) state.memory.set(key, { location: inst.loc, value });''')

# #789
replace_once('js/expr.js', "    if ((op === 'sdiv' || op === 'udiv' || op === 'smod' || op === 'umod') && cb === 0n) return null;", "    if ((op === 'sdiv' || op === 'udiv') && cb === 0n) return ZERO;\n    if ((op === 'smod' || op === 'umod') && cb === 0n) return null;")
replace_once('js/expr.js', '''    case 'sdiv': return b === 0n ? null : truncDiv(a, b);
    case 'udiv': {
      if (b === 0n) return null;
      const m = MASK[w] || MASK[64];
      return (a & m) / (b & m);
    }''', '''    case 'sdiv': {
      const lhs = BigInt.asIntN(w, a), rhs = BigInt.asIntN(w, b);
      return rhs === 0n ? 0n : truncDiv(lhs, rhs);
    }
    case 'udiv': {
      const lhs = BigInt.asUintN(w, a), rhs = BigInt.asUintN(w, b);
      return rhs === 0n ? 0n : lhs / rhs;
    }''')

# #819
replace_once('js/expr.js', '''      return a.baseReg === b.baseReg && a.disp === b.disp && a.size === b.size &&
        a.signed === b.signed && a.resultBits === b.resultBits && a.extension === b.extension &&
        a.scale === b.scale && JSON.stringify(a.indexShift || null) === JSON.stringify(b.indexShift || null) &&''', '''      return a.baseReg === b.baseReg && a.disp === b.disp && a.size === b.size &&
        a.signed === b.signed && a.resultBits === b.resultBits && a.extension === b.extension &&
        a.memoryVersion === b.memoryVersion &&
        a.scale === b.scale && JSON.stringify(a.indexShift || null) === JSON.stringify(b.indexShift || null) &&''')
replace_once('js/expr.js', '''  let flags = null;

  /*
   * sp は本体の途中では動かないか。''', '''  let flags = null;
  // Legacy memory nodes share identity only while no write/call crosses them.
  let memoryEpoch = 0;

  /*
   * sp は本体の途中では動かないか。''')
replace_once('js/expr.js', '''    if (insn.isCall) {
      flags = null; // NZCV is caller-clobbered and cannot be reused after a call.''', '''    if (insn.isCall) {
      memoryEpoch++;
      flags = null; // NZCV is caller-clobbered and cannot be reused after a call.''')
replace_once('js/expr.js', '''              signed: /^(ldrs|ldurs|ldpsw)/.test(base),
              stack: !!m.stack, addr: absolute, row,''', '''              signed: /^(ldrs|ldurs|ldpsw)/.test(base),
              memoryVersion: m.volatile ? `volatile:${row}` : memoryEpoch,
              stack: !!m.stack, addr: absolute, row,''')

# #820
replace_once('js/expr.js', '''  const slotKey = (m) => (m && m.stack && m.disp != null && !m.indexed
    ? m.base + '+' + m.disp.toString() : null);''', '''  const stackSlotEligible = (m) => !!(m && m.stack && m.disp != null && !m.indexed);
  const stackSlotKey = (base, disp, size) => `${base}+${BigInt(disp).toString()}:s${Number(size)}`;
  const stackRead = (m, disp, size) => {
    if (!stackSlotEligible(m)) return null;
    const entry = stack.get(stackSlotKey(m.base, disp, size));
    return entry ? entry.value : null;
  };
  const stackWrite = (m, disp, size, value) => {
    if (!stackSlotEligible(m)) return;
    const start = BigInt(disp), end = start + BigInt(size);
    for (const [key, entry] of Array.from(stack.entries())) {
      if (entry.base !== m.base) continue;
      if (start < entry.end && entry.start < end) stack.delete(key);
    }
    stack.set(stackSlotKey(m.base, start, size), { base:m.base, start, end, size:Number(size), value });
  };''')
replace_once('js/expr.js', '''      const m = insn.memory;
      const memOp = insn.ops.find((x) => x.k === 'mem');
      const slot = slotKey(m);''', '''      const m = insn.memory;
      const memOp = insn.ops.find((x) => x.k === 'mem');
      const slot = stackSlotEligible(m);''')
replace_once('js/expr.js', '''        const pair = base === 'ldp' || base === 'ldpsw' || base === 'ldnp';
        const list = pair ? dstOps.slice(0, 2) : dstOps.slice(0, 1);
        list.forEach((dop, k) => {''', '''        const pair = base === 'ldp' || base === 'ldpsw' || base === 'ldnp';
        const list = pair ? dstOps.slice(0, 2) : dstOps.slice(0, 1);
        const elemSize = pair ? m.size / 2 : m.size;
        list.forEach((dop, k) => {''')
replace_once('js/expr.js', '''          else if (slot && !k && stack.has(slot)) v = stack.get(slot);
          else if (slot && k === 1 && stack.has(m.base + '+' + (m.disp + BigInt(m.size / 2)).toString())) {
            v = stack.get(m.base + '+' + (m.disp + BigInt(m.size / 2)).toString());
          }''', '''          else if (slot) {
            const stackDisp = m.disp + BigInt(k * elemSize);
            v = stackRead(m, stackDisp, elemSize);
          }''')
replace_once('js/expr.js', '''      } else {
        const srcs = insn.ops.filter((x) => x.k === 'reg');
        const pair = base === 'stp' || base === 'stnp';
        const list = pair ? srcs.slice(0, 2) : srcs.slice(0, 1);
        list.forEach((sop, k) => {''', '''      } else {
        memoryEpoch++;
        const srcs = insn.ops.filter((x) => x.k === 'reg');
        const pair = base === 'stp' || base === 'stnp';
        const list = pair ? srcs.slice(0, 2) : srcs.slice(0, 1);
        const elemSize = pair ? m.size / 2 : m.size;
        list.forEach((sop, k) => {''')
replace_once('js/expr.js', '''          const step = pair ? BigInt(k * (m.size / 2)) : 0n;
          if (slot && m.disp != null) stack.set(m.base + '+' + (m.disp + step).toString(), v);
          memWrites.push({
            row, address: insn.address, baseReg: m.base,
            disp: m.disp != null ? m.disp + step : null,
            size: pair ? m.size / 2 : m.size, stack: !!m.stack,''', '''          const step = pair ? BigInt(k * elemSize) : 0n;
          if (slot && m.disp != null) stackWrite(m, m.disp + step, elemSize, v);
          memWrites.push({
            row, address: insn.address, baseReg: m.base,
            disp: m.disp != null ? m.disp + step : null,
            size: elemSize, stack: !!m.stack,''')

# #822
replace_once('js/expr.js', '''  let cmp = null;
  if (flags && flags.a) {
    if (flags.op === 'tst' || flags.op === 'ands' || flags.op === 'bics') {
      cmp = { a: bin('and', flags.a, flags.b, 64), b: ZERO };
    } else if (flags.op === 'cmn' || flags.op === 'adds') {
      cmp = { a: bin('add', flags.a, flags.b, 64), b: ZERO };
    } else {
      cmp = { a: flags.a, b: flags.b };
    }
    if (!cmp.a) cmp = null;
  }''', '''  let cmp = null;
  if (flags && flags.a) {
    const zeroOnly = cond === 'eq' || cond === 'ne';
    if ((flags.op === 'tst' || flags.op === 'ands') && zeroOnly) {
      cmp = { a: bin('and', flags.a, flags.b, bits), b: ZERO };
    } else if (flags.op === 'bics' && zeroOnly) {
      cmp = { a: bin('and', flags.a, un('not', flags.b), bits), b: ZERO };
    } else if ((flags.op === 'cmn' || flags.op === 'adds') && zeroOnly) {
      cmp = { a: bin('add', flags.a, flags.b, bits), b: ZERO };
    } else if (flags.op === 'cmp' || flags.op === 'subs' || flags.op === 'negs' || flags.op === 'fcmp' || flags.op === 'fcmpe') {
      cmp = { a: flags.a, b: flags.b };
    }
    if (!cmp?.a || !cmp?.b) cmp = null;
  }''')
replace_once('js/expr.js', '''    if (/^(subs|adds|ands|bics|negs)$/.test(base)) {
      flags = { op: base, a: A(), b: B() };
    }''', '''    if (/^(subs|adds|ands|bics|negs)$/.test(base)) {
      flags = base === 'negs' ? { op: base, a: ZERO, b: A() } : { op: base, a: A(), b: B() };
    }''')

# #827
replace_once('js/ir-core.js', '''      const key = `stack:${BigInt.asUintN(64, offset).toString()}`;
      const existing = projected.locations?.get?.(key) ?? null;
      const loc = existing ?? {
        key,
        kind: LEGACY_MK.STACK,
        disp: inst.addr.disp ?? offset,
        size: inst.addr.size ?? inst.extra?.size ?? null,
        regionId: inst.loc?.regionId ?? null,
        origin: inst.loc?.origin ?? inst.addr?.origin ?? null,
        compatAbiPreservedAddress: true,
      };
      if (!existing) projected.locations?.set?.(key, loc);''', '''      const key = `stack:${BigInt.asUintN(64, offset).toString()}`;
      const size = inst.addr.size ?? inst.extra?.size ?? null;
      const existing = projected.locations?.get?.(key) ?? null;
      const existingMatches = !!existing && existing.kind === LEGACY_MK.STACK
        && existing.disp != null && BigInt(existing.disp) === offset
        && (existing.size == null || size == null || Number(existing.size) === Number(size));
      const locKey = existing && !existingMatches ? `${key}:s${size ?? '?'}:compat` : key;
      const loc = existingMatches ? existing : {
        key: locKey,
        kind: LEGACY_MK.STACK,
        disp: offset,
        size,
        regionId: inst.loc?.regionId ?? null,
        origin: inst.loc?.origin ?? inst.addr?.origin ?? null,
        compatAbiPreservedAddress: true,
      };
      if (!existingMatches) projected.locations?.set?.(locKey, loc);''')

print('guarded batch A source patch applied')
