import fs from 'node:fs';
const read=(p)=>fs.readFileSync(p,'utf8'); const write=(p,s)=>fs.writeFileSync(p,s);
function rep(p,a,b){const s=read(p);if(!s.includes(a))throw new Error(`anchor missing ${p}: ${a.slice(0,120)}`);write(p,s.replace(a,b));}

// #352/#354 — variable shifts mask the count; widening MAC sign/zero extends 32-bit multiplicands.
{
  const p='js/ir-core.js'; let s=read(p);
  s=s.replace(`const inst = push({ op: OP.BIN, sub: BIN_OF[base], dstReg: dstReg(), dstBits: dstBits(),
      negate: base === 'mneg', srcs: b ? [a, b] : [a] });`, `const inst = push({ op: OP.BIN, sub: BIN_OF[base], dstReg: dstReg(), dstBits: dstBits(),
      negate: base === 'mneg', variableShift: /^(lslv|lsrv|asrv|rorv)$/.test(base), srcs: b ? [a, b] : [a] });`);
  s=s.replace(`const folded = a != null && b != null ? foldBin(inst.sub, a, b, bits) : null;`, `const folded = a != null && b != null ? foldBin(inst.sub, a, b, bits, !!inst.extra?.variableShift) : null;`);
  s=s.replace(`      const a = argConst(inst, 0, ir, bits), b = argConst(inst, 1, ir, bits), c = argConst(inst, 2, ir, bits);
      if (a != null && b != null && c != null) setConst(inst.dst, mask(inst.extra.negate ? a - b * c : a + b * c, bits));`, `      const a = argConst(inst, 0, ir, bits), b0 = argConst(inst, 1, ir, bits), c0 = argConst(inst, 2, ir, bits);
      if (a != null && b0 != null && c0 != null) {
        const widen = inst.extra?.widen || null;
        const b = widen === 'signed' ? BigInt.asIntN(32, b0) : widen === 'unsigned' ? BigInt.asUintN(32, b0) : b0;
        const c = widen === 'signed' ? BigInt.asIntN(32, c0) : widen === 'unsigned' ? BigInt.asUintN(32, c0) : c0;
        setConst(inst.dst, mask(inst.extra.negate ? a - b * c : inst.sub === 'msub' ? a - b * c : a + b * c, bits));
      }`);
  s=s.replace(`function foldBin(op, a, b, bits) {`, `function foldBin(op, a, b, bits, variableShift = false) {`);
  s=s.replace(`    case 'shl': return mask(a << b, bits);
    case 'lshr': return mask(mask(a, bits) >> b, bits);
    case 'ashr': return mask(signedOf(a, bits) >> b, bits);`, `    case 'shl': { const n = variableShift ? (b & BigInt(bits - 1)) : b; return mask(a << n, bits); }
    case 'lshr': { const n = variableShift ? (b & BigInt(bits - 1)) : b; return mask(mask(a, bits) >> n, bits); }
    case 'ashr': { const n = variableShift ? (b & BigInt(bits - 1)) : b; return mask(signedOf(a, bits) >> n, bits); }`);

  // #357/#358/#359 — stack base identity and byte ranges are part of Memory SSA; unknown/may-overlap accesses are barriers.
  s=s.replace(`if (a.stack) return { key: 'stack:' + a.disp, kind: MK.STACK, disp: a.disp, size: a.size };`, `if (a.stack) {
    const base = a.baseReg === 'x29' ? 'fp' : a.baseReg === 'sp' ? 'sp' : String(a.baseReg || 'stack');
    return { key: 'stack:' + base + ':' + a.disp + ':' + a.size, kind: MK.STACK, base, disp: a.disp, size: a.size };
  }`);
  s=s.replace(`return { key: 'field:' + base.id + ':' + a.disp, kind: MK.FIELD,
        base, disp: a.disp, size: a.size };`, `return { key: 'field:' + base.id + ':' + a.disp + ':' + a.size, kind: MK.FIELD,
        base, disp: a.disp, size: a.size };`);
  s=s.replace(`return { key: 'global:' + absolute, kind: MK.GLOBAL, addr: absolute, disp: a.disp, size: a.size };`, `return { key: 'global:' + absolute + ':' + a.size, kind: MK.GLOBAL, addr: absolute, disp: a.disp, size: a.size };`);
  const aliasOld=`function mayAlias(a, b) {
  if (!a || !b) return true;
  if (a.kind === MK.UNKNOWN || b.kind === MK.UNKNOWN) return true;
  if (a.key === b.key) return true;
  if (a.kind === MK.STACK && b.kind === MK.STACK) return false;
  if (a.kind === MK.GLOBAL && b.kind === MK.GLOBAL) return false;
  if (a.kind === MK.FIELD && b.kind === MK.FIELD) {
    if (a.base === b.base && a.disp !== b.disp) return false;
    if (a.base !== b.base) return true;             // alias しないとは証明できない
  }
  return true;
}`;
  const aliasNew=`function byteRange(loc) {
  if (!loc || loc.size == null) return null;
  const start = loc.kind === MK.GLOBAL ? loc.addr : loc.disp;
  if (start == null) return null;
  return { start: BigInt(start), end: BigInt(start) + BigInt(loc.size) };
}
function sameAliasBase(a,b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === MK.STACK) return a.base === b.base;
  if (a.kind === MK.FIELD) return a.base === b.base;
  if (a.kind === MK.GLOBAL) return true;
  return false;
}
function exactLocation(a,b) { return !!a && !!b && a.key === b.key && a.size === b.size; }
function mayAlias(a, b) {
  if (!a || !b || a.kind === MK.UNKNOWN || b.kind === MK.UNKNOWN) return true;
  if (exactLocation(a,b)) return true;
  if (!sameAliasBase(a,b)) {
    if (a.kind === MK.STACK && b.kind === MK.STACK) return false;
    if (a.kind === MK.GLOBAL && b.kind === MK.GLOBAL) return false;
    return true;
  }
  const ar=byteRange(a), br=byteRange(b);
  if (!ar || !br) return true;
  return ar.start < br.end && br.start < ar.end;
}`;
  if(!s.includes(aliasOld)) throw new Error('mayAlias anchor missing'); s=s.replace(aliasOld,aliasNew);
  // Load forwarding only exact range. Any may-overlap store kills previous exact state for future loads.
  s=s.replace(`if (current.has(inst.loc.key)) inst.reachingStore = current.get(inst.loc.key);`, `if (current.has(inst.loc.key)) inst.reachingStore = current.get(inst.loc.key);`);
  s=s.replace(`if (inst.op === OP.STORE && inst.loc) current.set(inst.loc.key, inst);`, `if (inst.op === OP.STORE && inst.loc) {
      for (const [key, def] of Array.from(current.entries())) {
        if (key !== inst.loc.key && mayAlias(inst.loc, def?.loc)) current.delete(key);
      }
      current.set(inst.loc.key, inst);
    }`);
  // #360 — plain loads do not prove unsignedness.
  s=s.replace(`if (inst.op === OP.LOAD && inst.dst) inst.dst.signed = !!inst.extra.signed;`, `if (inst.op === OP.LOAD && inst.dst) {
      if (inst.extra?.signed === true) inst.dst.signed = true;
      else if (inst.extra?.signedExplicit === true) inst.dst.signed = false;
    }`);
  write(p,s);
}

// #353 — decompiler emits widening casts before the product for long MAC.
{
  const p='js/decompiler/pipeline-core.js'; let s=read(p);
  const old=`      const a = buildArg(d.args?.[0], state), b = buildArg(d.args?.[1], state), c = buildArg(d.args?.[2], state);
      const mul = expr.binary('mul', b, c, d.dst?.bits || 64, signedFor(state, d.dst), origin(d, d.dst));`;
  const neu=`      const a = buildArg(d.args?.[0], state); let b = buildArg(d.args?.[1], state), c = buildArg(d.args?.[2], state);
      if (d.extra?.widen === 'signed') { b = expr.cast('int64_t', expr.cast('int32_t', b)); c = expr.cast('int64_t', expr.cast('int32_t', c)); }
      else if (d.extra?.widen === 'unsigned') { b = expr.cast('uint64_t', expr.cast('uint32_t', b)); c = expr.cast('uint64_t', expr.cast('uint32_t', c)); }
      const mul = expr.binary('mul', b, c, d.dst?.bits || 64, signedFor(state, d.dst), origin(d, d.dst));`;
  if(s.includes(old)) s=s.replace(old,neu);
  // #356 operand wrapper width: lower 32-bit reads explicitly truncate/zero extend before use.
  const argOld=`function buildArg(arg, state) {
  return buildValue(valueOf(arg), state);
}`;
  const argNew=`function buildArg(arg, state) {
  const value = buildValue(valueOf(arg), state);
  if (!value || !arg) return value;
  if (Number(arg.bits) === 32 && Number(value.bits || 64) > 32) return expr.cast('uint32_t', value, origin(valueOf(arg)));
  return value;
}`;
  if(s.includes(argOld)) s=s.replace(argOld,argNew);
  write(p,s);
}

// #355 — nearest dominating clobber is a barrier; never skip backward to stale value.
{
  const p='js/decompiler/semantic.js'; let s=read(p);
  s=s.replace(`    if (v.reg !== reg || !v.def || v.clobbered) continue;`, `    if (v.reg !== reg || !v.def) continue;`);
  // after best candidate selection, clobber returns null.
  const ret=`  return best;
}`;
  const pos=s.indexOf(ret,s.indexOf('export function reachingRegisterValue'));
  if(pos<0) throw new Error('reachingRegisterValue return anchor missing');
  s=s.slice(0,pos)+s.slice(pos).replace(ret,`  return best?.clobbered ? null : best;
}`);
  write(p,s);
}

// #361 — symbolic variable shifts use ARM64 modulo-width counts.
{
  const p='js/symbolic/executor.js'; let s=read(p);
  s=s.replace(`function binOp(op, a, b, bits = 64) {`, `function binOp(op, a, b, bits = 64, variableShift = false) {`);
  s=s.replace(`    if (op === 'shl') return sym.const(BigInt.asUintN(bits, av << bv), bits);
    if (op === 'lshr') return sym.const(BigInt.asUintN(bits, BigInt.asUintN(bits,av) >> bv), bits);
    if (op === 'ashr') return sym.const(BigInt.asUintN(bits, BigInt.asIntN(bits,av) >> bv), bits);`, `    const shift = variableShift ? (bv & BigInt(bits - 1)) : bv;
    if (op === 'shl') return sym.const(BigInt.asUintN(bits, av << shift), bits);
    if (op === 'lshr') return sym.const(BigInt.asUintN(bits, BigInt.asUintN(bits,av) >> shift), bits);
    if (op === 'ashr') return sym.const(BigInt.asUintN(bits, BigInt.asIntN(bits,av) >> shift), bits);`);
  s=s.replace(`setReg(state, inst.dst?.reg || 'tmp', binOp(inst.sub, a, b, inst.dst?.bits || 64));`, `setReg(state, inst.dst?.reg || 'tmp', binOp(inst.sub, a, b, inst.dst?.bits || 64, !!inst.extra?.variableShift));`);
  // #362 symmetric merge: missing stack cell becomes unknown/maybe, not one branch's concrete value.
  s=s.replace(`for (const [k,v] of incoming.stack) if (!base.stack.has(k)) base.stack.set(k, v);`, `const allStackKeys = new Set([...base.stack.keys(), ...incoming.stack.keys()]);
  for (const k of allStackKeys) {
    const a=base.stack.get(k), b=incoming.stack.get(k);
    if (!a || !b) base.stack.set(k, sym.unknown('stack-maybe:' + k));
    else if (JSON.stringify(a) !== JSON.stringify(b)) base.stack.set(k, sym.unknown('stack-phi:' + k));
  }`);
  // #363 guard arena/state growth before allocation/enqueue.
  s=s.replace(`const next = cloneState(state);`, `if (states.length >= maxStates || instructionBudget <= 0) { truncated = true; continue; }
    const next = cloneState(state);`);
  write(p,s);
}

console.log('issues 352-363 patches applied');
