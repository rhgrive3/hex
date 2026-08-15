/* AAPCS64 prototype recovery driven by actual SSA uses and recovered type evidence. */

function tname(t, fallback = 'unknown') { return t?.name || t?.type || fallback; }
function used(v) { return (v?.uses || []).some((u) => u && !u.clobbered); }
function bitsOf(t) { return Number(t?.bits || (t?.size ? Number(t.size) * 8 : 0) || 0); }
function kindOf(t) { return String(t?.kind || t?.class || t?.abiClass || '').toLowerCase(); }

function registerArguments(ir, types, opts, prefix, abiClass) {
  let lastUsed = -1;
  for (let i = 0; i < 8; i++) {
    const v = ir?.args?.get?.(`${prefix}${i}`) || null;
    if (v && used(v)) lastUsed = i;
  }
  const out = [];
  for (let i = 0; i <= lastUsed; i++) {
    const v = ir?.args?.get?.(`${prefix}${i}`) || null;
    const recovered = v ? types?.values?.get?.(v.id) : null;
    out.push({
      index:i, bankIndex:i, reg:`${prefix}${i}`, abiClass,
      name:opts.argNames?.[`${prefix}${i}`] || (abiClass === 'integer' ? opts.argNames?.[i] : null) || `${abiClass === 'fp' ? 'fpArg' : 'arg'}${i + 1}`,
      type:tname(recovered), confidence:recovered?.confidence || (v ? 0.45 : 0.2),
      valueId:v?.id ?? null, used:!!v && used(v), sourceOrderKnown:false,
    });
  }
  return out;
}

function entryStackArguments(ir, types) {
  const entrySp = ir?.args?.get?.('sp') || null;
  if (!entrySp) return [];
  const byKey = new Map();
  for (const inst of ir?.instructions || []) {
    if (inst?.op !== 'load' || inst.loc?.kind !== 'stack' || inst.loc?.baseReg !== 'sp') continue;
    if (inst.loc.frameEpoch !== entrySp.id || inst.loc.disp == null || inst.loc.disp < 0n) continue;
    if (inst.memUse?.kind !== 'entry') continue;
    const key = inst.loc.key;
    if (byKey.has(key)) continue;
    const recovered = inst.dst ? types?.values?.get?.(inst.dst.id) : null;
    byKey.set(key, {
      index:null, reg:null, abiClass:'stack', stackOffset:inst.loc.disp,
      name:`stackArg_${inst.loc.disp.toString(16)}`, type:tname(recovered),
      confidence:recovered?.confidence || 0.5, valueId:inst.dst?.id ?? null, used:true,
      sourceOrderKnown:false, evidence:'load from entry-SP Memory-SSA version with no reaching store',
    });
  }
  return [...byKey.values()].sort((a,b) => a.stackOffset < b.stackOffset ? -1 : a.stackOffset > b.stackOffset ? 1 : 0);
}

function returnLocations(ret, indirectResult, opts = {}) {
  if (indirectResult) return [{ kind:'indirect', reg:'x8', role:'result-address' }];
  const name = tname(ret, opts.returnType || 'unknown').toLowerCase();
  if (name === 'void' || kindOf(ret) === 'void') return [];
  if (!ret && !opts.returnType && !opts.returnClass) return [];
  const kind = kindOf(ret) || String(opts.returnClass || '').toLowerCase();
  const bits = bitsOf(ret) || Number(opts.returnBits || 0);
  const hfaCount = Number(ret?.hfaCount || ret?.hvaCount || opts.hfaCount || 0);
  if ((kind.includes('hfa') || kind.includes('hva')) && hfaCount >= 1 && hfaCount <= 4) {
    return Array.from({ length:hfaCount }, (_, i) => ({ kind:'register', reg:`v${i}`, abiClass:'fp' }));
  }
  if (kind.includes('float') || kind.includes('double') || kind.includes('vector') || /^(float|double|__fp16)/.test(name)) {
    return [{ kind:'register', reg:'v0', abiClass:'fp' }];
  }
  const aggregate = kind.includes('aggregate') || kind.includes('struct') || kind.includes('union') || ret?.aggregate === true;
  if (aggregate) {
    if (!bits) return [];
    if (bits <= 64) return [{ kind:'register', reg:'x0', abiClass:'integer' }];
    if (bits <= 128) return [{ kind:'register', reg:'x0', abiClass:'integer' }, { kind:'register', reg:'x1', abiClass:'integer' }];
    return [];
  }
  if (bits > 64 && bits <= 128) return [{ kind:'register', reg:'x0', abiClass:'integer' }, { kind:'register', reg:'x1', abiClass:'integer' }];
  if (bits > 128) return [];
  return [{ kind:'register', reg:'x0', abiClass:'integer' }];
}

export function recoverFunctionPrototype(ir, types, opts = {}) {
  const integerArgs = registerArguments(ir, types, opts, 'x', 'integer');
  const fpArgs = registerArguments(ir, types, opts, 'v', 'fp');
  const stackArgs = entryStackArguments(ir, types);
  const args = [...integerArgs, ...fpArgs, ...stackArgs];
  const x8 = ir?.args?.get?.('x8');
  const indirectResult = !!(x8 && used(x8) && (types?.values?.get?.(x8.id)?.kind === 'pointer' || opts.indirectResult));
  const ret = types?.ret || null;
  const retType = tname(ret, opts.returnType || 'unknown');
  const locations = returnLocations(ret, indirectResult, opts);
  return {
    convention:'AAPCS64', arguments:args,
    argumentBanks:{ integer:integerArgs, fp:fpArgs, stack:stackArgs },
    returnType:retType, returnConfidence:ret?.confidence || (locations.length ? 0.35 : 0),
    returnLocations:locations, returnLocationKnown:indirectResult || !!ret || !!opts.returnType || !!opts.returnClass,
    indirectResult, indirectResultRegister:indirectResult ? 'x8' : null,
    variadic:opts.variadic === true,
    evidence:[
      ...(integerArgs.length ? ['entry SSA use of x0..x7'] : []),
      ...(fpArgs.length ? ['entry SSA use of v0..v7'] : []),
      ...(stackArgs.length ? ['entry-SP loads with Memory-SSA entry versions'] : []),
      ...(indirectResult ? ['x8 used as typed indirect-result pointer'] : []),
      ...(ret ? ['semantic return-type evidence'] : []),
    ],
  };
}
