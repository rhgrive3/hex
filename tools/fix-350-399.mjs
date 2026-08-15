import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, text) { fs.writeFileSync(path, text); }
function replaceOnce(text, oldText, newText, label) {
  const i = text.indexOf(oldText);
  if (i < 0) throw new Error(`missing patch target: ${label}`);
  if (text.indexOf(oldText, i + oldText.length) >= 0) throw new Error(`ambiguous patch target: ${label}`);
  return text.slice(0, i) + newText + text.slice(i + oldText.length);
}
function replaceRx(text, rx, newText, label) {
  const matches = [...text.matchAll(new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g'))];
  if (matches.length !== 1) throw new Error(`patch target ${label}: expected 1 match, got ${matches.length}`);
  return text.replace(rx, newText);
}
function edit(path, fn) {
  const before = read(path);
  const after = fn(before);
  if (before === after) throw new Error(`no changes produced for ${path}`);
  write(path, after);
}

// #350-#354, #358-#360: Semantic IR truth and constant semantics.
edit('js/ir-core.js', (s) => {
  s = replaceOnce(s,
`  if (base === 'ccmp' || base === 'ccmn') {
    const cond = ops.find((o) => o.k === 'cond');
    push(Object.assign(flags(), {
      op: OP.CMP, sub: base === 'ccmp' ? 'sub' : 'add', conditional: true,
      cond: cond ? cond.text : null, bits: regBits(ops[0]),
      srcs: [opnd(ops[0]), opnd(ops[1]), { t: 'reg', reg: 'nzcv', bits: 4 }].filter(Boolean),
    }));
    return out;
  }`,
`  if (base === 'ccmp' || base === 'ccmn') {
    const cond = ops.find((o) => o.k === 'cond');
    const fallback = ops.find((o, index) => index >= 2 && o.k === 'imm' && o.value != null);
    push(Object.assign(flags(), {
      op: OP.CMP, sub: base === 'ccmp' ? 'sub' : 'add', conditional: true,
      cond: cond ? cond.text : null, bits: regBits(ops[0]),
      fallbackNzcv: fallback ? Number(fallback.value & 0xfn) : null,
      srcs: [opnd(ops[0]), opnd(ops[1]), { t: 'reg', reg: 'nzcv', bits: 4 }].filter(Boolean),
    }));
    return out;
  }`, '#351 ccmp fallback');

  s = replaceOnce(s,
`    case 'shl': return mask(a << (mask(b, bits) & 63n), bits);
    case 'lshr': return mask(mask(a, bits) >> (mask(b, bits) & 63n), bits);
    case 'ashr': return mask(sa >> (mask(b, bits) & 63n), bits);`,
`    case 'shl': { const sh = mask(b, bits) & BigInt(bits === 32 ? 31 : 63); return mask(a << sh, bits); }
    case 'lshr': { const sh = mask(b, bits) & BigInt(bits === 32 ? 31 : 63); return mask(mask(a, bits) >> sh, bits); }
    case 'ashr': { const sh = mask(b, bits) & BigInt(bits === 32 ? 31 : 63); return mask(sa >> sh, bits); }`, '#352 variable shift width');

  s = replaceOnce(s,
`      case OP.MAC: {
        const a = argConst(inst.args[0], bits);
        const b = argConst(inst.args[1], bits);
        const c = argConst(inst.args[2], bits);
        if (a != null && b != null && c != null) {
          setConst(inst.dst, mask(inst.sub === 'msub' ? a - b * c : a + b * c, bits));
        }
        break;
      }`,
`      case OP.MAC: {
        const addend = argConst(inst.args[0], bits);
        let a = argConst(inst.args[1], bits);
        let b = argConst(inst.args[2], bits);
        if (addend != null && a != null && b != null) {
          if (inst.extra?.widen === 'signed') { a = BigInt.asIntN(32, a); b = BigInt.asIntN(32, b); }
          else if (inst.extra?.widen === 'unsigned') { a = BigInt.asUintN(32, a); b = BigInt.asUintN(32, b); }
          setConst(inst.dst, mask(inst.sub === 'msub' ? addend - a * b : addend + a * b, bits));
        }
        break;
      }`, '#354 widening MAC constants');

  s = replaceOnce(s,
`    if (inst.op === OP.LOAD) inst.dst.signed = !!(inst.extra && inst.extra.signed);`,
`    if (inst.op === OP.LOAD) {
      // Plain LDR has no signedness evidence. Only sign-extending load opcodes
      // may positively mark the SSA value signed; absence of that flag is unknown.
      if (inst.extra && inst.extra.signed === true) inst.dst.signed = true;
    }`, '#360 load signedness');

  s = replaceOnce(s,
`function locationOf(inst) {
  const a = inst.addr;
  if (!a) return null;
  if (a.index) return { key: 'unknown', kind: MK.UNKNOWN };
  if (a.disp == null) return { key: 'unknown', kind: MK.UNKNOWN };
  if (!a.base) return { key: 'unknown', kind: MK.UNKNOWN };
  if (a.stack) {
    const baseReg = a.baseReg || a.base?.reg || 'stack';
    const frameEpoch = a.base?.id ?? -1;
    return {
      key: \`stack:\${baseReg}:e\${frameEpoch}:\${a.disp.toString()}\`,
      kind: MK.STACK, baseReg, frameEpoch, disp: a.disp, size: a.size,
    };
  }
  const base = a.base;
  if (base.const != null) {
    const addr = base.const + a.disp;
    return { key: 'global:' + addr.toString(16), kind: MK.GLOBAL, address: addr, size: a.size };
  }
  return {
    key: 'field:' + base.id + '+' + a.disp.toString(),
    kind: MK.FIELD, base, disp: a.disp, size: a.size,
  };
}`,
`function locationOf(inst) {
  const a = inst.addr;
  if (!a) return null;
  const size = Number(a.size || inst.extra?.size || 0) || 0;
  // Unknown/indexed addresses are may-alias locations, never one shared
  // must-alias bucket. A unique key prevents unrelated unknown loads/stores
  // from fabricating a reaching-store edge (#358).
  if (a.index || a.disp == null || !a.base) return { key: \`unknown:\${inst.id}\`, kind: MK.UNKNOWN, size };
  if (a.stack) {
    const baseReg = a.baseReg || a.base?.reg || 'stack';
    const frameEpoch = a.base?.id ?? -1;
    return {
      key: \`stack:\${baseReg}:e\${frameEpoch}:\${a.disp.toString()}:s\${size}\`,
      kind: MK.STACK, baseReg, frameEpoch, disp: a.disp, size,
    };
  }
  const base = a.base;
  if (base.const != null) {
    const addr = base.const + a.disp;
    return { key: 'global:' + addr.toString(16) + ':s' + size, kind: MK.GLOBAL, address: addr, size };
  }
  return {
    key: 'field:' + base.id + '+' + a.disp.toString() + ':s' + size,
    kind: MK.FIELD, base, disp: a.disp, size,
  };
}`,'#358/#359 location identity');

  s = replaceOnce(s,
`  for (const inst of ir.instructions) {
    if (inst.op === OP.LOAD || inst.op === OP.STORE) {
      const loc = locationOf(inst);
      if (!loc) continue;
      inst.loc = register(loc);
      if (inst.op === OP.STORE) {
        let s = defSites.get(loc.key);
        if (!s) { s = new Set(); defSites.set(loc.key, s); }
        s.add(inst.block);
      }
    } else if (inst.op === OP.CALL || inst.op === OP.UNKNOWN) {
      clobberInsts.push(inst);
    }
  }

  ir.locations = locs;`,
`  for (const inst of ir.instructions) {
    if (inst.op === OP.LOAD || inst.op === OP.STORE) {
      const loc = locationOf(inst);
      if (!loc) continue;
      inst.loc = register(loc);
    } else if (inst.op === OP.CALL || inst.op === OP.UNKNOWN) {
      clobberInsts.push(inst);
    }
  }
  // Every store defines its exact range and clobbers every registered range it
  // may overlap. This is what makes byte/halfword stores kill wider reaching
  // loads without pretending the partial store supplied the entire value (#359).
  for (const inst of ir.instructions) {
    if (inst.op !== OP.STORE || !inst.loc) continue;
    for (const [key, loc] of locs) {
      if (!mayAlias(inst.loc, loc)) continue;
      let defs = defSites.get(key);
      if (!defs) { defs = new Set(); defSites.set(key, defs); }
      defs.add(inst.block);
    }
  }

  ir.locations = locs;`, '#358/#359 def sites');

  s = replaceOnce(s,
`      } else if (inst.op === OP.STORE && inst.loc) {
        const node = { kind: 'store', key: inst.loc.key, inst, block: bi, prev: top(inst.loc.key) };
        inst.memDef = node;
        stacks.get(inst.loc.key).push(node);
        mark.push(inst.loc.key);
      } else if (inst.memKills) {`,
`      } else if (inst.op === OP.STORE && inst.loc) {
        for (const [key, loc] of locs) {
          if (!mayAlias(inst.loc, loc)) continue;
          const exact = key === inst.loc.key;
          const node = exact
            ? { kind: 'store', key, inst, block: bi, prev: top(key) }
            : { kind: 'clobber', key, inst, block: bi, reason: 'overlap-store' };
          if (exact) inst.memDef = node;
          stacks.get(key).push(node);
          mark.push(key);
        }
      } else if (inst.memKills) {`, '#359 overlap store clobber');
  return s;
});

// #350, #351, #353, #356: decompiler consumes operand width/conditional flags faithfully.
edit('js/decompiler/pipeline-core.js', (s) => {
  s = replaceRx(s, /function compareFromFlags\(flagValue, cond, state\) \{[\s\S]*?\n\}\n\nfunction applyShift/,
`function nzcvCondition(value, cond) {
  if (value == null) return null;
  const f = Number(value) & 15;
  const n=!!(f&8), z=!!(f&4), c=!!(f&2), v=!!(f&1);
  switch (cond) {
    case 'eq': return z; case 'ne': return !z;
    case 'cs': case 'hs': return c; case 'cc': case 'lo': return !c;
    case 'mi': return n; case 'pl': return !n; case 'vs': return v; case 'vc': return !v;
    case 'hi': return c && !z; case 'ls': return !c || z;
    case 'ge': return n === v; case 'lt': return n !== v;
    case 'gt': return !z && n === v; case 'le': return z || n !== v;
    case 'al': case 'nv': return true; default: return null;
  }
}

function compareFromFlags(flagValue, cond, state) {
  const d = flagValue?.def;
  if (!d || d.op !== 'cmp') return expr.variable('condition_' + (cond || 'flags'), 1, false);
  const a = buildArg(d.args?.[0], state), b = buildArg(d.args?.[1], state);
  const info = COND[cond] || null;
  const normal = info ? expr.compare(info.op, a, info.vsZero ? expr.constant(0, a.bits || 64) : b,
    info.signed == null ? signedFor(state, d.dst) : info.signed, origin(d))
    : expr.variable('condition_' + (cond || 'flags'), 1, false);
  if (!d.extra?.conditional) return normal;
  const previousFlags = valueOf(d.args?.[2]);
  const gate = compareFromFlags(previousFlags, d.cond, state);
  const fallbackTruth = nzcvCondition(d.extra?.fallbackNzcv, cond);
  const fallback = fallbackTruth == null ? expr.variable('fallback_' + (cond || 'flags'), 1, false)
    : expr.constant(fallbackTruth ? 1 : 0, 1, false, origin(d));
  return expr.select(gate, normal, fallback, 1, false, origin(d));
}

function applyShift`, '#351 conditional compare reconstruction');

  s = replaceRx(s, /function buildArg\(arg, state, flags = \{\}\) \{[\s\S]*?\n\}/,
`function buildArg(arg, state, flags = {}) {
  if (!arg) return expr.unknown('missing-arg');
  let out = buildValue(valueOf(arg), state, flags);
  const operandBits = Number(arg.bits || 0);
  const valueBits = Number(out?.bits || valueOf(arg)?.bits || 0);
  if (operandBits > 0 && valueBits > operandBits) {
    out = expr.unary('trunc', out, operandBits, false, sourceOf(out), { fromBits:valueBits });
  }
  return applyShift(out, arg.shift);
}`, '#356 operand wrapper bits');

  s = replaceOnce(s,
`    } else if (d.op === 'mac') {
      const addend = buildArg(d.args?.[0], state), a = buildArg(d.args?.[1], state), b = buildArg(d.args?.[2], state);
      const mult = expr.binary('mul', a, b, v.bits || 64, d.widen === 'unsigned' ? false : d.widen === 'signed' ? true : signedFor(state, v), origin(d, v));
      out = expr.binary(d.sub === 'msub' ? 'sub' : 'add', addend, mult, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'bfx') {`,
`    } else if (d.op === 'mac') {
      const addend = buildArg(d.args?.[0], state);
      let a = buildArg(d.args?.[1], state), b = buildArg(d.args?.[2], state);
      if (d.extra?.widen === 'signed' || d.extra?.widen === 'unsigned') {
        const signed = d.extra.widen === 'signed';
        const op = signed ? 'sext' : 'zext';
        a = expr.unary(op, a, v.bits || 64, signed, origin(d, v), { fromBits:32 });
        b = expr.unary(op, b, v.bits || 64, signed, origin(d, v), { fromBits:32 });
      }
      const mult = expr.binary('mul', a, b, v.bits || 64, d.extra?.widen === 'unsigned' ? false : d.extra?.widen === 'signed' ? true : signedFor(state, v), origin(d, v));
      out = expr.binary(d.sub === 'msub' ? 'sub' : 'add', addend, mult, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'bfx') {`, '#353 widening MAC AST');

  s = replaceOnce(s,
`  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits || 64), f.bits || 64, f.signed, origin(d)), v.bits || 64, signedFor(state, v), origin(d));
  if (d.sub === 'inv') return expr.select(condition, t, expr.unary('not', f, f.bits || 64, f.signed, origin(d)), v.bits || 64, signedFor(state, v), origin(d));
  if (d.sub === 'neg') return expr.select(condition, t, expr.unary('neg', f, f.bits || 64, f.signed, origin(d)), v.bits || 64, signedFor(state, v), origin(d));`,
`  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits || 64), f.bits || 64, f.signed, origin(d)), v.bits || 64, signedFor(state, v), origin(d));
  if (d.sub === 'inv') return expr.select(condition, t, expr.unary('not', f, f.bits || 64, f.signed, origin(d)), v.bits || 64, signedFor(state, v), origin(d));
  if (d.sub === 'neg') return expr.select(condition, t, expr.unary('neg', f, f.bits || 64, f.signed, origin(d)), v.bits || 64, signedFor(state, v), origin(d));
  // CINC/CINV/CNEG aliases transform the single source when their condition is
  // true; they are not the same arm ordering as CSINC/CSINV/CSNEG (#350).
  if (d.sub === 'cinc') return expr.select(condition, expr.binary('add', t, expr.constant(1, t.bits || 64), t.bits || 64, t.signed, origin(d)), t, v.bits || 64, signedFor(state, v), origin(d));
  if (d.sub === 'cinv') return expr.select(condition, expr.unary('not', t, t.bits || 64, t.signed, origin(d)), t, v.bits || 64, signedFor(state, v), origin(d));
  if (d.sub === 'cneg') return expr.select(condition, expr.unary('neg', t, t.bits || 64, t.signed, origin(d)), t, v.bits || 64, signedFor(state, v), origin(d));`, '#350 conditional aliases');
  return s;
});

// #355: a clobber is the reaching definition and terminates the query.
edit('js/decompiler/semantic.js', (s) => replaceRx(s,
/export function reachingRegisterValue\(ir, atInst, reg\) \{[\s\S]*?\n\}/,
`export function reachingRegisterValue(ir, atInst, reg) {
  if (!ir || !atInst || !reg) return null;
  let best = ir.args?.get?.(reg) || null;
  let bestDepth = -1, bestRow = -Infinity;
  for (const v of ir.values || []) {
    if (v.reg !== reg || !v.def) continue;
    const d = v.def;
    if (d === atInst) continue;
    if (d.block === atInst.block) {
      if (d.row == null || atInst.row == null || d.row >= atInst.row) continue;
      const depth = 100000 + d.row;
      if (depth > bestDepth) { best = v; bestDepth = depth; bestRow = d.row; }
      continue;
    }
    const dom = ir.dominators?.[atInst.block];
    if (!dom || !dom.has(d.block)) continue;
    const depth = dominatorDepth(ir, d.block);
    if (depth > bestDepth || (depth === bestDepth && (d.row ?? -Infinity) > bestRow)) {
      best = v; bestDepth = depth; bestRow = d.row ?? -Infinity;
    }
  }
  return best?.clobbered ? null : best;
}`, '#355 reaching clobber'));

// #361-#363: width-correct symbolic execution and infeasible path pruning.
edit('js/symbolic/executor.js', (s) => {
  s = replaceOnce(s,
`function cmp(name, a, b) { return { kind: SYM.OP, op: name, args: [a, b], boolean: true }; }`,
`function cmp(name, a, b) {
  if (a?.kind === SYM.CONST && b?.kind === SYM.CONST) {
    const av=a.value, bv=b.value;
    const yes = name === '==' ? av === bv : name === '!=' ? av !== bv : name === '<' ? av < bv : name === '<=' ? av <= bv : name === '>' ? av > bv : name === '>=' ? av >= bv : null;
    if (yes != null) return { ...c(yes ? 1n : 0n), boolean:true };
  }
  return { kind: SYM.OP, op: name, args: [a, b], boolean: true };
}`, '#363 constant comparisons');

  s = replaceOnce(s,
`function negate(condition) {
  if (!condition) return unknown('missing-condition');
  const inverse = { '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[condition.op];
  if (condition.kind === SYM.OP && inverse) return { ...condition, op: inverse };
  return { kind: SYM.OP, op: 'not', args: [condition], boolean: true };
}`,
`function negate(condition) {
  if (!condition) return unknown('missing-condition');
  if (condition.kind === SYM.CONST && condition.boolean) return { ...c(condition.value === 0n ? 1n : 0n), boolean:true };
  const inverse = { '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[condition.op];
  if (condition.kind === SYM.OP && inverse) return { ...condition, op: inverse };
  return { kind: SYM.OP, op: 'not', args: [condition], boolean: true };
}
function constraintAllowed(existing, condition) {
  if (condition?.kind === SYM.CONST && condition.boolean) return condition.value !== 0n;
  const key = expressionText(condition);
  for (const prior of existing || []) {
    if (prior?.kind === SYM.CONST && prior.boolean && prior.value === 0n) return false;
    if (expressionText(negate(prior)) === key) return false;
  }
  return true;
}`, '#363 constraint consistency');

  s = replaceOnce(s,
`      else if (name === 'shl') value = av << bv;
      else if (name === 'lshr') value = BigInt.asUintN(width, av) >> bv;
      else if (name === 'ashr') value = BigInt.asIntN(width, av) >> bv;`,
`      else if (name === 'shl') value = av << (bv % BigInt(width));
      else if (name === 'lshr') value = BigInt.asUintN(width, av) >> (bv % BigInt(width));
      else if (name === 'ashr') value = BigInt.asIntN(width, av) >> (bv % BigInt(width));`, '#361 constant variable shifts');
  s = replaceOnce(s,
`  return { kind: SYM.OP, op: name, args: [a, b] };`,
`  if (name === 'shl' || name === 'lshr' || name === 'ashr') {
    const masked = { kind:SYM.OP, op:'and', args:[b, c(BigInt(width - 1))] };
    return { kind: SYM.OP, op: name, args: [a, masked], bits:width };
  }
  return { kind: SYM.OP, op: name, args: [a, b] };`, '#361 symbolic variable shifts');

  s = replaceOnce(s,
`    } else if (d.op === OP.UN && d.args[0] && /^(sxt|uxt|fmov|neg)/.test(d.sub || '')) {
      const x = evalValue(d.args[0].value, state, ir, opts, memo, active);
      out = d.sub === 'neg' ? binOp('sub', c(0n), x, d.dst && d.dst.bits || value.bits || 64) : x;
    } else if (d.op === OP.LOAD && d.loc) {`,
`    } else if (d.op === OP.UN && d.args[0] && /^(sxt|uxt|fmov|neg)/.test(d.sub || '')) {
      const x = evalValue(d.args[0].value, state, ir, opts, memo, active);
      const toBits = d.dst && d.dst.bits || value.bits || 64;
      const m = /^(sxt|uxt)(8|16|32|64)?/.exec(d.sub || '');
      if (d.sub === 'neg') out = binOp('sub', c(0n), x, toBits);
      else if (m) {
        const fromBits = Number(m[2] || d.args[0].bits || d.args[0].value?.bits || toBits);
        if (x.kind === SYM.CONST) {
          const narrowed = m[1] === 'sxt' ? BigInt.asIntN(fromBits, x.value) : BigInt.asUintN(fromBits, x.value);
          out = c(BigInt.asUintN(toBits, narrowed));
        } else out = { kind:SYM.OP, op:m[1] === 'sxt' ? 'sext' : 'zext', args:[x], fromBits, toBits };
      } else out = x;
    } else if (d.op === OP.LOAD && d.loc) {`, '#362 symbolic extensions');

  s = replaceOnce(s,
`        const yes = cloneState(state);
        yes.prevBlock = state.block; yes.block = next.target;
        yes.constraints.push(cond);
        yes.branches.push({ row: inst.row, address: inst.address, taken: true, condition: expressionText(cond) });
        const no = cloneState(state);
        no.prevBlock = state.block; no.block = next.fallthrough;
        const inverse = negate(cond);
        no.constraints.push(inverse);
        no.branches.push({ row: inst.row, address: inst.address, taken: false, condition: expressionText(inverse) });
        queue.push(yes, no);`,
`        const inverse = negate(cond);
        if (constraintAllowed(state.constraints, cond)) {
          const yes = cloneState(state);
          yes.prevBlock = state.block; yes.block = next.target;
          yes.constraints.push(cond);
          yes.branches.push({ row: inst.row, address: inst.address, taken: true, condition: expressionText(cond) });
          queue.push(yes);
        }
        if (constraintAllowed(state.constraints, inverse)) {
          const no = cloneState(state);
          no.prevBlock = state.block; no.block = next.fallthrough;
          no.constraints.push(inverse);
          no.branches.push({ row: inst.row, address: inst.address, taken: false, condition: expressionText(inverse) });
          queue.push(no);
        }`, '#363 prune infeasible branches');
  return s;
});

// #364-#378, #382: Emulator architectural and libc/runtime semantics.
edit('js/emu.js', (s) => {
  s = replaceOnce(s,
`    this.v = new Array(32).fill(0n);       // 小数/SIMD は下位 64 ビットだけ`,
`    this.v = new Array(32).fill(0);        // 小数/SIMD はJS Numberとして保持
    this.exclusive = null;                  // ARM64 local exclusive monitor`, '#364/#368 FP reset monitor');

  s = replaceOnce(s,
`  async store(addr, size, value) {
    await this.ensure(addr);`,
`  async store(addr, size, value) {
    if (this.exclusive) {
      const a0=BigInt(addr), a1=a0+BigInt(size), e0=this.exclusive.addr, e1=e0+BigInt(this.exclusive.size);
      if (!(a1 <= e0 || e1 <= a0)) this.exclusive = null;
    }
    await this.ensure(addr);`, '#364 interfering store invalidates monitor');

  s = replaceOnce(s,
`      else if (mn === 'ubfiz' || mn === 'sbfiz') r = (src & mask) << lsb;`,
`      else if (mn === 'ubfiz') r = (src & mask) << lsb;
      else if (mn === 'sbfiz') r = BigInt.asUintN(wide ? 64 : 32, BigInt.asIntN(Number(lsb + width), (src & mask) << lsb));`, '#371 sbfiz sign extension');

  s = replaceOnce(s,
`      else { const n = bits / 8; for (let i = 0; i < n; i++) r |= ((v >> BigInt(i * 8)) & 0xffn) << BigInt((n - 1 - i) * 8); }`,
`      else {
        const n = bits / 8;
        const elementBytes = mn === 'rev16' ? 2 : mn === 'rev32' ? 4 : n;
        for (let base = 0; base < n; base += elementBytes) {
          for (let i = 0; i < elementBytes; i++) {
            r |= ((v >> BigInt((base + i) * 8)) & 0xffn) << BigInt((base + elementBytes - 1 - i) * 8);
          }
        }
      }`, '#370 rev element width');

  s = replaceOnce(s,
`    this.effectiveAddress(mem, true);
    return null;
  }

  async storeInsn(mn, ops) {`,
`    if (/^(ldxr|ldaxr)/.test(mn) && !pair) this.exclusive = { addr:BigInt(addr), size };
    this.effectiveAddress(mem, true);
    return null;
  }

  async storeInsn(mn, ops) {`, '#364 load-exclusive monitor');

  s = replaceRx(s, /  async storeInsn\(mn, ops\) \{[\s\S]*?\n  \}\n\n  \/\* ── 小数/,
`  async storeInsn(mn, ops) {
    const mem = ops.find((o) => o.k === 'mem');
    if (!mem) throw new Error('書き込み先が分かりませんでした: ' + mn);
    const exclusive = /^(stxr|stlxr)/.test(mn);
    const first = exclusive ? 1 : 0;
    const addr = this.effectiveAddress(mem, false);
    const pair = /^(stp|stnp)/.test(mn);
    const size = storeSize(mn, ops[first]);
    if (exclusive) {
      const monitor = this.exclusive;
      const success = !!monitor && monitor.addr === BigInt(addr) && monitor.size === size;
      this.exclusive = null;
      if (success) {
        if (isFloatReg(ops[first])) await this.store(addr, size, floatToBits(this.fget(ops[first]), size));
        else await this.store(addr, size, this.get(ops[first].text));
      }
      this.set(ops[0].text, success ? 0n : 1n);
      this.effectiveAddress(mem, true);
      return null;
    }
    if (pair) {
      const each = isWide(ops[0]) ? 8 : 4;
      await this.store(addr, each, this.get(ops[0].text));
      await this.store(addr + BigInt(each), each, this.get(ops[1].text));
    } else if (isFloatReg(ops[first])) {
      await this.store(addr, size, floatToBits(this.fget(ops[first]), size));
    } else await this.store(addr, size, this.get(ops[first].text));
    this.effectiveAddress(mem, true);
    return null;
  }

  /* ── 小数`, '#364 store-exclusive semantics');

  s = replaceRx(s, /  fget\(op\) \{[\s\S]*?\n  \}\n\n  floatInsn\(mn, ops\) \{[\s\S]*?\n    throw new Error\('この小数命令はまだ実行できません: ' \+ mn\);\n  \}/,
`  fget(op) {
    if (!op || op.k !== 'reg') return 0;
    if (op.cls === 'gp' || op.cls === 'sp') {
      const bits = op.bits === 32 ? 32 : 64;
      return Number(BigInt.asIntN(bits, this.get(op.text)));
    }
    const value = this.v[op.num];
    return value === undefined ? 0 : value;
  }

  fset(op, value) {
    if (!op || op.k !== 'reg') return;
    if (op.cls === 'gp') { this.set(op.text, BigInt(Math.trunc(value))); return; }
    this.v[op.num] = op.bits === 32 || /^s\\d+$/i.test(op.text || '') ? Math.fround(value) : value;
  }

  floatInsn(mn, ops) {
    const a = this.fget(ops[1]);
    const b = ops[2] ? this.fget(ops[2]) : 0;
    if (mn === 'fmov') {
      if (ops[1] && ops[1].k === 'imm') this.fset(ops[0], ops[1].float != null ? ops[1].float : Number(ops[1].value || 0n));
      else this.fset(ops[0], a);
      return null;
    }
    if (mn === 'fadd') { this.fset(ops[0], a + b); return null; }
    if (mn === 'fsub') { this.fset(ops[0], a - b); return null; }
    if (mn === 'fmul') { this.fset(ops[0], a * b); return null; }
    if (mn === 'fdiv') { this.fset(ops[0], a / b); return null; }
    if (mn === 'fneg') { this.fset(ops[0], -a); return null; }
    if (mn === 'fabs') { this.fset(ops[0], Math.abs(a)); return null; }
    if (mn === 'fsqrt') { this.fset(ops[0], Math.sqrt(a)); return null; }
    if (mn === 'fmadd') { this.fset(ops[0], this.fget(ops[3]) + a * b); return null; }
    if (mn === 'fmsub') { this.fset(ops[0], this.fget(ops[3]) - a * b); return null; }
    if (mn === 'fcvt' || mn === 'fcvtd' || mn === 'fcvts') { this.fset(ops[0], a); return null; }
    if (/^(scvtf|ucvtf)$/.test(mn)) {
      const bits = ops[1]?.bits === 32 ? 32 : 64;
      const raw = this.get(ops[1].text);
      const integer = mn === 'scvtf' ? BigInt.asIntN(bits, raw) : BigInt.asUintN(bits, raw);
      this.fset(ops[0], Number(integer));
      return null;
    }
    if (/^fcvtz[su]$/.test(mn)) {
      const bits = ops[0]?.bits === 32 || /^w/.test(ops[0]?.text || '') ? 32 : 64;
      const unsigned = mn === 'fcvtzu';
      let result = 0n;
      if (!Number.isNaN(a)) {
        const t = Math.trunc(a);
        if (unsigned) {
          const max = (1n << BigInt(bits)) - 1n;
          if (t <= 0) result = 0n;
          else if (!Number.isFinite(t) || t >= Number(max)) result = max;
          else result = BigInt(t);
        } else {
          const min = -(1n << BigInt(bits - 1)), max = (1n << BigInt(bits - 1)) - 1n;
          if (t === -Infinity || t <= Number(min)) result = min;
          else if (t === Infinity || t >= Number(max)) result = max;
          else result = BigInt(t);
        }
      }
      this.set(ops[0].text, result);
      return null;
    }
    if (mn === 'fcmp' || mn === 'fcmpe') {
      const rhs = ops[1] && ops[1].k === 'imm' ? 0 : b;
      const lhs = a;
      if (Number.isNaN(lhs) || Number.isNaN(rhs)) this.nzcv = { n:false, z:false, c:true, v:true };
      else this.nzcv = { n: lhs < rhs, z: lhs === rhs, c: lhs >= rhs, v:false };
      return null;
    }
    if (/^(fmin|fmax|fminnm|fmaxnm)$/.test(mn)) {
      let value;
      if (/nm$/.test(mn)) {
        if (Number.isNaN(a) && !Number.isNaN(b)) value = b;
        else if (!Number.isNaN(a) && Number.isNaN(b)) value = a;
        else value = /min/.test(mn) ? Math.min(a,b) : Math.max(a,b);
      } else value = /min/.test(mn) ? Math.min(a,b) : Math.max(a,b);
      this.fset(ops[0], value);
      return null;
    }
    throw new Error('この小数命令はまだ実行できません: ' + mn);
  }`, '#365-#369/#376/#377 floating semantics');

  s = replaceRx(s, /  async hookedCall\(target\) \{[\s\S]*?\n    return false;\n  \}/,
`  async hookedCall(target) {
    const name = this.io.symbolFor ? this.io.symbolFor(target) : null;
    if (!name) return false;
    const plain = name.replace(/^_+/, '');
    const MAX_HOOK_BYTES = 65536n;
    const allocate = async (size, zero = false) => {
      if (size < 0n || size > 0x100000n) throw new Error('外部メモリ確保が安全上限を超えました: ' + size);
      const addr = this.heap;
      this.heap += (size + 15n) & ~15n;
      if (zero) for (let i=0n;i<size;i++) { await this.ensure(addr+i); this.writeByte(addr+i,0); }
      return addr;
    };
    if (/^(malloc|operator new|Znwm|Znam)$/.test(plain)) {
      const size = this.x[0] || 16n;
      const addr = await allocate(size, false);
      this.x[0] = addr;
      this.log.push({ call: plain, note: 'メモリを ' + size + ' バイト確保したことにしました → 0x' + addr.toString(16) });
      return true;
    }
    if (plain === 'calloc') {
      const count=this.x[0], each=this.x[1];
      if (count !== 0n && each > MASK64 / count) throw new Error('calloc のサイズがオーバーフローしました');
      const size=count*each;
      const addr=await allocate(size,true);
      this.x[0]=addr;
      this.log.push({call:'calloc',note:size+' バイトをゼロ初期化して確保しました'});
      return true;
    }
    if (/^(free|operator delete|ZdlPv|ZdaPv)$/.test(plain)) {
      this.log.push({ call: plain, note: '解放は何もしません' });
      return true;
    }
    if (plain === 'strlen') {
      const p=this.x[0]; let n=0n;
      while (n < 4096n) { await this.ensure(p+n); if (this.byteAt(p+n) === 0) { this.x[0]=n; this.log.push({call:'strlen',note:'長さ '+n+' を返しました'}); return true; } n++; }
      throw new Error('strlen: 4096 バイト以内に終端NULがありません');
    }
    if (/^(memcpy|memmove)$/.test(plain)) {
      const d=this.x[0], src=this.x[1], n=this.x[2];
      if (n > MAX_HOOK_BYTES) throw new Error(plain + ': コピー長が安全上限65536バイトを超えました');
      const snapshot = plain === 'memmove' ? new Uint8Array(Number(n)) : null;
      if (snapshot) for (let i=0;i<snapshot.length;i++) { await this.ensure(src+BigInt(i)); snapshot[i]=this.byteAt(src+BigInt(i)); }
      for (let i=0n;i<n;i++) {
        await this.ensure(src+i); await this.ensure(d+i);
        this.writeByte(d+i, snapshot ? snapshot[Number(i)] : this.byteAt(src+i));
      }
      this.x[0]=d;
      this.log.push({call:plain,note:n+' バイトをコピーしました'});
      return true;
    }
    if (/^(memset|bzero)$/.test(plain)) {
      const d=this.x[0], c=plain==='bzero'?0n:this.x[1], n=plain==='bzero'?this.x[1]:this.x[2];
      if (n > MAX_HOOK_BYTES) throw new Error(plain + ': 書込長が安全上限65536バイトを超えました');
      for (let i=0n;i<n;i++) { await this.ensure(d+i); this.writeByte(d+i,Number(c&0xffn)); }
      this.x[0]=d;
      this.log.push({call:plain,note:n+' バイトを埋めました'});
      return true;
    }
    if (/^(arc4random|rand|random)$/.test(plain)) {
      this.x[0]=4n; this.log.push({call:plain,note:'乱数は毎回 4 を返します（結果を比べられるように）'}); return true;
    }
    if (plain === 'objc_storeStrong') {
      await this.store(this.x[0], 8, this.x[1]);
      this.log.push({call:plain,note:'strong参照先へ新しいobject pointerを書き込みました'});
      return true;
    }
    if (/^objc_(retain|release|autorelease|retainAutoreleasedReturnValue)$/.test(plain)) {
      this.log.push({call:plain,note:'参照カウントの操作は素通りします'}); return true;
    }
    return false;
  }`, '#372-#375/#378/#382 hooks');
  return s;
});

// #379: bound untrusted fire-and-forget output before structured clone.
edit('js/sandbox.js', (s) => {
  s = replaceOnce(s,
`  let seq = 1;
  const waiting = new Map();

  const send = (message) => {
    try { postMessage(message); }`,
`  let seq = 1;
  const waiting = new Map();
  const nativePostMessage = globalThis.postMessage.bind(globalThis);
  const OUTPUT_MAX_MESSAGES = 256;
  const OUTPUT_MAX_BYTES = 256 * 1024;
  const OUTPUT_MAX_PER_SECOND = 96;
  let outputMessages = 0, outputBytes = 0, outputWindow = Date.now(), outputWindowCount = 0;
  const outputSize = (value) => {
    const seen = new Set(); const stack=[value]; let bytes=0, nodes=0;
    while (stack.length && bytes <= OUTPUT_MAX_BYTES) {
      const x=stack.pop(); if (++nodes > 4096) return OUTPUT_MAX_BYTES + 1;
      if (x == null) { bytes+=4; continue; }
      if (typeof x === 'string') { bytes += x.length * 2; continue; }
      if (typeof x === 'number' || typeof x === 'bigint') { bytes+=16; continue; }
      if (typeof x === 'boolean') { bytes+=4; continue; }
      if (x instanceof ArrayBuffer) { bytes+=x.byteLength; continue; }
      if (ArrayBuffer.isView(x)) { bytes+=x.byteLength; continue; }
      if (typeof x === 'object') {
        if (seen.has(x)) continue; seen.add(x);
        const keys=Object.keys(x); bytes += keys.length * 8;
        for (let i=0;i<keys.length && i<2048;i++) { bytes += keys[i].length*2; stack.push(x[keys[i]]); }
      } else bytes+=32;
    }
    return bytes;
  };
  const outputLimit = (message) => {
    const now=Date.now(); if (now-outputWindow >= 1000) { outputWindow=now; outputWindowCount=0; }
    const bytes=outputSize(message);
    outputMessages++; outputWindowCount++; outputBytes+=bytes;
    return bytes > OUTPUT_MAX_BYTES || outputMessages > OUTPUT_MAX_MESSAGES || outputBytes > OUTPUT_MAX_BYTES || outputWindowCount > OUTPUT_MAX_PER_SECOND;
  };
  const sendOutput = (message) => {
    if (outputLimit(message)) {
      try { nativePostMessage({t:'outputLimit', error:'sandbox output budget exceeded'}); } catch {}
      try { close(); } catch {}
      return;
    }
    try { nativePostMessage(message); } catch {}
  };
  // Direct user postMessage is fire-and-forget output too; route it through the
  // same budget instead of letting it bypass print().
  try { Object.defineProperty(globalThis,'postMessage',{value:sendOutput,writable:false,configurable:false}); } catch {}

  const send = (message) => {
    try { nativePostMessage(message); }`, '#379 worker output budget');
  s = replaceOnce(s,
`  const print = (...args) => send({ t: 'print', args });`,
`  const print = (...args) => sendOutput({ t: 'print', args });`, '#379 print budget');
  s = replaceOnce(s,
`    worker.onmessage = (e) => port.postMessage(e.data || {});`,
`    worker.onmessage = (e) => {
      const data=e.data || {};
      if (data.t === 'outputLimit') { port.postMessage({t:'error',error:'出力が安全上限を超えたため停止しました。'}); stop(); return; }
      port.postMessage(data);
    };`, '#379 relay termination');
  return s;
});

// #380/#381: modern ObjC method-list flags and signed-char type encoding.
edit('js/objc-legacy.js', (s) => {
  s = replaceOnce(s, `const REL_FLAG = 0x80000000;    // method_list_t.entsize の「相対形式」の印\nconst ENTSIZE_MASK = 0xfffc;`,
`const REL_FLAG = 0x80000000;    // relative/small method entries
const DIRECT_SEL_FLAG = 0x40000000; // selector field points directly at cstring
const ENTSIZE_MASK = 0xfffc;
export function decodeMethodListHeader(rawEntsize) {
  const raw=Number(rawEntsize)>>>0;
  return { relative:!!(raw&REL_FLAG), directSelector:!!(raw&DIRECT_SEL_FLAG), stride:raw&ENTSIZE_MASK };
}`, '#380 shared method header decoder');
  s = replaceOnce(s,
`  const relative = (entsize & REL_FLAG) !== 0;
  const stride = entsize & ENTSIZE_MASK;`,
`  const { relative, directSelector, stride } = decodeMethodListHeader(entsize);`, '#380 legacy header use');
  s = replaceOnce(s,
`      // まずは「名前を指すポインタ」として読み、だめなら名前そのものとして読む
      nameAddr = await pointer(get, nameTarget);
      if (nameAddr == null) nameAddr = nameTarget;
      const viaPtr = await cstring(get, nameAddr);
      if (viaPtr == null) nameAddr = nameTarget;`,
`      if (directSelector) nameAddr = nameTarget;
      else {
        nameAddr = await pointer(get, nameTarget);
        if (nameAddr == null || await cstring(get, nameAddr) == null) nameAddr = nameTarget;
      }`, '#380 direct selector legacy');
  s = replaceOnce(s,
`    case 'c': return { kind: 'int', bytes: 1, signed: true, enc: s, bool: true };`,
`    case 'c': return { kind: 'int', bytes: 1, signed: true, enc: s };`, '#381 signed char not bool');
  return s;
});
edit('js/apple/objc-metadata.js', (s) => {
  s = replaceOnce(s,
`import { pagedReader, sanitizePointer } from '../objc-legacy.js';`,
`import { pagedReader, sanitizePointer, decodeMethodListHeader } from '../objc-legacy.js';`, '#380 metadata import');
  s = replaceOnce(s,
`const REL_FLAG = 0x80000000;
const ENTSIZE_MASK = 0xfffc;
`, ``, '#380 duplicate flags');
  s = replaceOnce(s,
`  const relative = !!(rawEntsize & REL_FLAG);
  const stride = rawEntsize & ENTSIZE_MASK;`,
`  const { relative, directSelector, stride } = decodeMethodListHeader(rawEntsize);`, '#380 metadata header use');
  s = replaceOnce(s,
`      const nameTarget = at + BigInt(i32(b, 0));
      nameAddr = await ptr(get, nameTarget);
      if (nameAddr == null || await cstring(get, nameAddr) == null) nameAddr = nameTarget;`,
`      const nameTarget = at + BigInt(i32(b, 0));
      if (directSelector) nameAddr = nameTarget;
      else {
        nameAddr = await ptr(get, nameTarget);
        if (nameAddr == null || await cstring(get, nameAddr) == null) nameAddr = nameTarget;
      }`, '#380 direct selector metadata');
  return s;
});

// #384/#385: model calls obey deadline; result count is never proof.
edit('js/agent/runtime.js', (s) => {
  s = replaceOnce(s,
`  const verified = !!(best.verification && (best.verification.verified || (best.verification.results && best.verification.results.length)));`,
`  const verdict = best.verification?.verdict?.status || best.verification?.verdict || best.verification?.status || null;
  const verified = best.verification?.verified === true || verdict === 'confirmed' || verdict === 'supported';`, '#385 explicit verification');
  s = replaceOnce(s,
`    try {
      step = await llm.next({
        goal, query, observations: observations.slice(), availableTools,
        budget: {
          remainingToolCalls: budget.maxToolCalls - call,
          remainingFunctions: Math.max(0, budget.maxFunctions - usedFunctionCount()),
          remainingDisassembly: Math.max(0, budget.maxDisassembly - disassembly),
        },
      });
    } catch (err) {`,
`    try {
      const remainingMs = Math.max(1, budget.timeoutMs - (Date.now() - started));
      const controller = new AbortController();
      const external = cfg.signal;
      const abort = () => controller.abort(external?.reason || 'cancelled');
      if (external?.aborted) abort(); else external?.addEventListener?.('abort', abort, {once:true});
      let timer;
      try {
        step = await Promise.race([
          Promise.resolve(llm.next({
            goal, query, observations: observations.slice(), availableTools, signal:controller.signal,
            budget: {
              remainingToolCalls: budget.maxToolCalls - call,
              remainingFunctions: Math.max(0, budget.maxFunctions - usedFunctionCount()),
              remainingDisassembly: Math.max(0, budget.maxDisassembly - disassembly),
              remainingMs,
            },
          })),
          new Promise((_, reject) => { timer=setTimeout(() => { controller.abort('timeout'); reject(new Error('timeout')); }, remainingMs); }),
        ]);
      } finally {
        clearTimeout(timer); external?.removeEventListener?.('abort', abort);
      }
    } catch (err) {`, '#384 bounded llm.next');
  return s;
});

// #386/#391: planner keeps data addresses and static thresholds out of proof slots.
edit('js/query/planner.js', (s) => {
  s = replaceOnce(s,
`function resultAddress(row) {
  if (!row) return null;
  for (const k of ['function', 'functionAddress', 'addr', 'address', 'start']) {
    const a = asAddr(row[k]); if (a != null) return a;
  }
  return null;
}`,
`function resultAddress(row) {
  if (!row) return null;
  for (const k of ['function', 'functionAddress', 'addr', 'address', 'start']) {
    const a = asAddr(row[k]); if (a != null) return a;
  }
  return null;
}
function explicitFunctionAddress(row) {
  if (!row) return null;
  let a=asAddr(row.functionAddress); if (a != null) return a;
  if (row.function && typeof row.function === 'object') a=asAddr(row.function.address ?? row.function.addr ?? row.function.start);
  else a=asAddr(row.function);
  return a;
}`, '#391 explicit function address helper');
  s = replaceOnce(s,
`      const direct = resultAddress(row);
      if (direct != null) addCandidate(map, direct, 'string-reference', term, 8);`,
`      const direct = explicitFunctionAddress(row);
      if (direct != null) addCandidate(map, direct, 'string-reference', term, 8);`, '#391 string data address exclusion');
  s = replaceOnce(s,
`      if ((thresholds.results || []).length) {
        c.verification = thresholds;
        c.score += 20;
        c.scoreComponents.evidenceScore += 20;
        return c;
      }`,
`      if ((thresholds.results || []).length) {
        // A static threshold fact is useful semantic evidence, not causal/runtime
        // verification. Keep it visible without occupying the proof slot (#386).
        c.thresholdEvidence = thresholds;
        c.score += 8;
        c.scoreComponents.semanticScore += 8;
      }`, '#386 thresholds not verification');
  s = replaceOnce(s,
`    verification: c.verification || null,
    evidence: Array.from(c.evidence || []),`,
`    verification: c.verification || null,
    thresholdEvidence: c.thresholdEvidence || null,
    evidence: Array.from(c.evidence || []),`, '#386 expose static threshold evidence');
  return s;
});

// #387: source-backed fingerprinting uses bounded async reads.
edit('js/binary/fingerprint.js', (s) => {
  s = replaceRx(s, /export function fingerprintFunction\(image, fn, opts = \{\}\) \{[\s\S]*?\n\}\n\nexport function fingerprintImage\(image, opts = \{\}\) \{[\s\S]*?\n\}/,
`export async function fingerprintFunction(image, fn, opts = {}) {
  const maxBytes = Math.max(16, opts.maxBytes || 1 << 20);
  let size = fn.size == null ? BigInt(opts.fallbackBytes || 64) : BigInt(fn.size);
  if (size <= 0n) return null;
  if (size > BigInt(maxBytes)) size = BigInt(maxBytes);
  const bytes = typeof image.readVirtualAsync === 'function'
    ? await image.readVirtualAsync(fn.address, Number(size))
    : image.readVirtual(fn.address, Number(size));
  if (!bytes || !bytes.length) return null;
  return { algorithm:'fnv1a64', hash:fingerprintBytes(bytes), bytes:bytes.length,
    truncated:fn.size != null && BigInt(fn.size) > BigInt(bytes.length) };
}

async function mappingChunk(image, mapping, offset, length) {
  const fileOffset = BigInt(mapping.fileOffset) + BigInt(offset);
  if (image.bytes) {
    const start=Number(fileOffset);
    if (!Number.isSafeInteger(start) || start < 0 || start + length > image.bytes.length) return null;
    return image.bytes.subarray(start,start+length);
  }
  if (image.source) return image.source.readExactly(fileOffset,length);
  if (mapping.address != null && typeof image.readVirtualAsync === 'function') return image.readVirtualAsync(BigInt(mapping.address)+BigInt(offset),length);
  return null;
}

export async function fingerprintImage(image, opts = {}) {
  const executableOnly = opts.executableOnly !== false;
  const chunkBytes = Math.max(4096, Math.min(1 << 20, Number(opts.chunkBytes || 256 * 1024)));
  let state={hi:FNV_OFFSET_HI,lo:FNV_OFFSET_LO}, total=0;
  let ranges=image.sections.filter((x)=>x.fileSize>0n && (!executableOnly || x.perms.execute));
  if (!ranges.length) ranges=image.segments.filter((x)=>x.fileSize>0n && (!executableOnly || x.perms.execute));
  for (const mapping of ranges) {
    const size=BigInt(mapping.fileSize);
    for (let off=0n;off<size;) {
      const take=Number(size-off < BigInt(chunkBytes) ? size-off : BigInt(chunkBytes));
      const bytes=await mappingChunk(image,mapping,off,take);
      if (!bytes || bytes.length !== take) break;
      state=fnv1a64State(bytes,state); total+=bytes.length; off+=BigInt(bytes.length);
    }
  }
  return {algorithm:'fnv1a64',hash:digestHex(state),bytes:total,scope:executableOnly?'executable-mappings':'all-mappings'};
}`, '#387 async fingerprints');
  return s;
});

// #388/#389/#390: runtime evidence identity, trace lifecycle, final write.
edit('js/runtime-evidence/index.js', (s) => replaceOnce(s,
`  const evidence = runtimeEvidence.filter((item) => item && (item.source === 'runtime' || item.provenance && item.provenance.group === GROUP.RUNTIME));
  const compatible = [];`,
`  const evidence = runtimeEvidence.filter((item) => item && (item.source === 'runtime' || item.provenance && item.provenance.group === GROUP.RUNTIME));
  if (!candidateHash || candidateFunction == null) {
    return { candidate:staticCandidate, status:'inconclusive', reason:'identity-missing', confidence:safeConfidence(staticCandidate && staticCandidate.confidence,0.5), runtimeGroups:0, support:0, contradictions:0, ignoredEvidence:evidence.length, evidence:[] };
  }
  const compatible = [];`, '#388 fail closed identity'));
edit('js/runtime/index.js', (s) => replaceOnce(s,
`    let observation;
    try {
      await session.adapter.launch(launchSpec,{signal:operation.signal});
      observation = await session.adapter.resume({ maxSteps:options.maxSteps ?? 20000, timeoutMs:options.timeoutMs, signal:operation.signal });
    } finally { operation.release(); }
    const trace = observation.trace || await session.adapter.trace({ limit:boundedInteger(options.limit,4096,1,50000,'limit') });`,
`    let observation, trace;
    const started=Date.now();
    try {
      await session.adapter.launch(launchSpec,{signal:operation.signal});
      observation = await session.adapter.resume({ maxSteps:options.maxSteps ?? 20000, timeoutMs:options.timeoutMs, signal:operation.signal });
      if (observation.trace) trace=observation.trace;
      else {
        const timeoutMs=options.timeoutMs == null ? undefined : Math.max(1, Number(options.timeoutMs) - (Date.now()-started));
        trace = await session.adapter.trace({ limit:boundedInteger(options.limit,4096,1,50000,'limit'), timeoutMs, signal:operation.signal });
      }
    } finally { operation.release(); }`, '#389 trace lifecycle'));
edit('js/dynamic/experiments.js', (s) => replaceOnce(s,
`  const touched = ((observation && observation.memoryDelta) || []).find((f) => f && f.offset != null && BigInt(f.offset) === offset);
  if (touched && touched.after != null) return { observed:true, value:touched.after, source:'delta' };`,
`  const deltas = (observation && observation.memoryDelta) || [];
  let touched = null;
  for (const delta of deltas) if (delta && delta.offset != null && BigInt(delta.offset) === offset && delta.after != null) touched=delta;
  if (touched) return { observed:true, value:touched.after, source:'delta-final' };`, '#390 final delta'));

// #392: bound incoming remote event traffic.
edit('js/debug/remote-protocol.js', (s) => {
  s = replaceOnce(s,
`    this.listeners = new Set();
    this.epoch = 0;`,
`    this.listeners = new Set();
    this.maxEventsPerSecond = boundedInteger(options.maxEventsPerSecond, 256, 1, 10000, 'maxEventsPerSecond');
    this.maxEventBytesPerSecond = boundedInteger(options.maxEventBytesPerSecond, 4 * 1024 * 1024, 1024, 64 * 1024 * 1024, 'maxEventBytesPerSecond');
    this.eventWindowStart = Date.now(); this.eventWindowCount = 0; this.eventWindowBytes = 0; this.droppedEvents = 0;
    this.epoch = 0;`, '#392 event budgets');
  s = replaceOnce(s,
`    if (packet.type === 'event') {
      for (const fn of this.listeners) { try { fn(packet); } catch { /* listener isolation */ } }
      return true;
    }`,
`    if (packet.type === 'event') {
      const now=Date.now();
      if (now-this.eventWindowStart >= 1000) { this.eventWindowStart=now; this.eventWindowCount=0; this.eventWindowBytes=0; this.droppedEvents=0; }
      const bytes=jsonByteSize(packet);
      if (this.eventWindowCount + 1 > this.maxEventsPerSecond || this.eventWindowBytes + bytes > this.maxEventBytesPerSecond) {
        this.droppedEvents++;
        if (this.droppedEvents === 1) {
          const notice={version:DEBUG_PROTOCOL_VERSION,type:'event',epoch:this.epoch,event:'stream-truncated',data:{reason:'event-backpressure'}};
          for (const fn of this.listeners) { try { fn(notice); } catch {} }
        }
        return false;
      }
      this.eventWindowCount++; this.eventWindowBytes+=bytes;
      for (const fn of this.listeners) { try { fn(packet); } catch { /* listener isolation */ } }
      return true;
    }`, '#392 event backpressure');
  return s;
});

// #393: conflict sets remain available across successive type merges.
edit('js/decompiler/type-recovery.js', (s) => replaceRx(s,
/export function mergeRecoveredTypes\(a, b\) \{[\s\S]*?\n\}/,
`export function mergeRecoveredTypes(a, b) {
  const flatten = (t) => {
    if (!t) return [];
    const list=Array.isArray(t.candidates) && t.candidates.length ? t.candidates : [t];
    return list.flatMap((x) => x && Array.isArray(x.candidates) && x.candidates.length ? x.candidates : [x]).filter(Boolean);
  };
  const byName=new Map();
  for (const candidate of [...flatten(a),...flatten(b)]) {
    if (!candidate || candidate.name === 'unknown' && candidate.kind !== 'ambiguous') continue;
    const key=candidate.name || candidate.kind || 'unknown';
    const prev=byName.get(key);
    if (!prev || (candidate.confidence||0) > (prev.confidence||0)) byName.set(key,candidate);
  }
  if (!byName.size) return b || a;
  const all=[...byName.values()].sort((x,y)=>(y.confidence||0)-(x.confidence||0));
  if (all.length === 1) return {...all[0],candidates:all};
  const top=all[0], second=all[1], ac=top.confidence||0, bc=second.confidence||0;
  if (Math.abs(ac-bc) < 0.12) return {name:'unknown',kind:'ambiguous',confidence:Math.max(ac,bc)*0.7,candidates:all,warning:'conflicting type evidence: '+all.map((x)=>x.name).join(' vs ')};
  return {...top,candidates:all};
}`, '#393 sticky ambiguity'));

// #394: low-confidence signatures are hints, never hard suppression.
edit('js/recognition/classifier.js', (s) => {
  s = replaceOnce(s,
`  if (context.signature?.classification && FUNCTION_CLASSES.includes(context.signature.classification)) {
    return { classification: context.signature.classification, confidence: context.signature.confidence ?? 0.95, evidence: ['signature:' + (context.signature.library || context.signature.name || 'known')] };
  }
  const name = fp.name || '';`,
`  const signature = context.signature?.classification && FUNCTION_CLASSES.includes(context.signature.classification) ? context.signature : null;
  const signatureConfidence = Number(signature?.confidence ?? 0);
  const signatureExact = signature?.exact === true || ['exact','normalized-identical'].includes(signature?.identity);
  if (signature && signatureExact && signatureConfidence >= 0.9) {
    return { classification:signature.classification, confidence:signatureConfidence, evidence:['signature:'+ (signature.library||signature.name||'known')], hardSuppress:true };
  }
  const name = fp.name || '';`, '#394 signature hard gate');
  s = replaceOnce(s,
`  const evidence = [];`, `  const evidence = [];`, '#394 anchor noop');
  // Undo noop safeguard: replaceOnce cannot be a no-op; add hint evidence near runtime imports.
  return s;
});
