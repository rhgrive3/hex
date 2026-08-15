/* Conservative SSA coalescing. It prefers false negatives over false source variables. */

function typeName(t) { return t?.name || t?.type || t?.kind || 'unknown'; }
function compatibleType(a, b) {
  const x = typeName(a), y = typeName(b);
  if (x === 'unknown' || y === 'unknown') return true;
  if (x === y) return true;
  const ax = a?.bits, by = b?.bits;
  return ax && by && ax === by && a?.kind === 'integer' && b?.kind === 'integer';
}
function argIndex(v) {
  if (!v) return null;
  const explicit = v.argIndex ?? v.argumentIndex ?? v.abiArgIndex;
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const origin = v.abiOrigin || v.origin || v.provenance;
  const originKind = origin?.kind || origin?.type;
  const originIndex = origin?.index ?? origin?.argIndex;
  if ((originKind === 'arg' || originKind === 'argument') && Number.isInteger(originIndex) && originIndex >= 0) return originIndex;
  if (v.kind !== 'arg') return null;
  if (Number.isInteger(v.n) && v.n >= 0) return v.n;
  const m = /^x([0-7])$/.exec(v.reg || '');
  return m ? Number(m[1]) : null;
}
function isArg(v) { return argIndex(v) != null; }
function addressTaken(v, ir) {
  return (v?.uses || []).some((u) => u?.op === 'store' && u?.addr?.base?.id === v.id)
    || (ir?.instructions || []).some((i) => i?.addr?.base?.id === v?.id && i?.addr?.stack);
}
function phiSensitive(v) { return v?.def?.op === 'phi' || (v?.uses || []).some((u) => u?.op === 'phi'); }

function candidateName(group, index, opts = {}) {
  const v = group.values[0];
  if (group.kind === 'argument') {
    const n = group.argIndex ?? argIndex(v) ?? index;
    const explicit = opts.argNames?.[n] || null;
    if (explicit) return { name: explicit, confidence: 0.95, reason: 'explicit argument metadata' };
    if (n === 0 && opts.receiverType) return { name: 'self', confidence: 0.92, reason: 'typed receiver in AAPCS64 x0' };
    // Keep the public decompiler's established source-like ABI naming while the
    // HighVariable identity itself remains SSA/proof based.
    return { name: `a${n + 1}`, confidence: 0.72, reason: 'AAPCS64 argument origin' };
  }
  if (group.fieldName) return { name: group.fieldName, confidence: group.fieldConfidence || 0.9, reason: 'field metadata' };
  if (group.stackOffset != null) {
    const off = BigInt(group.stackOffset);
    return { name: `local_${(off < 0n ? -off : off).toString(16).toUpperCase()}`, confidence: 0.82, reason: 'stable stack slot' };
  }
  const reg = String(v?.reg || '');
  return { name: /^x\d+$/.test(reg) ? `local_${reg}` : `local_${index + 1}`, confidence: 0.45, reason: 'conservative local' };
}

export function recoverHighVariables(ir, recoveredTypes, opts = {}) {
  const values = (ir?.values || []).filter((v) => v && v.kind !== 'const' && v.reg !== 'nzcv');
  const types = recoveredTypes?.values || new Map();
  const groups = [];
  const byKey = new Map();
  const valueToGroup = new Map();

  for (const v of values) {
    const t = types.get?.(v.id) || null;
    const unsafe = addressTaken(v, ir) || phiSensitive(v);
    const origin = v.def?.op === 'mov' && v.def?.args?.[0]?.value ? v.def.args[0].value : null;
    const originGroup = origin ? valueToGroup.get(origin.id) : null;
    // Register allocation is not source-variable identity: unrelated SSA values that
    // merely reuse xN must never be coalesced. Only an explicit ABI argument origin,
    // a stable stack slot, or an explicit MOV lineage is eligible for grouping.
    const ai = argIndex(v);
    const key = unsafe ? `v:${v.id}` : ai != null ? `arg:${ai}` : v.stackSlot?.key ? `stack:${v.stackSlot.key}` : `v:${v.id}`;
    let g = !unsafe && originGroup ? groups[originGroup - 1] : byKey.get(key);
    if (g && (!compatibleType(g.type, t) || g.unsafeMerge)) g = null;
    if (!g) {
      g = { id: groups.length + 1, key, kind: ai != null ? 'argument' : v.stackSlot ? 'stack' : 'local', values: [], type: t, unsafeMerge: unsafe };
      if (ai != null) g.argIndex = ai;
      if (v.stackSlot?.offset != null) g.stackOffset = v.stackSlot.offset;
      groups.push(g); byKey.set(key, g);
    }
    g.values.push(v); valueToGroup.set(v.id, g.id);
  }

  for (let i = 0; i < groups.length; i++) {
    const naming = candidateName(groups[i], i, opts);
    groups[i].name = naming.name;
    groups[i].nameConfidence = naming.confidence;
    groups[i].nameEvidence = naming.reason;
  }
  return { groups, valueToGroup };
}
