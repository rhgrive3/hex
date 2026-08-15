/* Conservative aggregate layout inference from repeated Memory-SSA access patterns. */

function baseOf(inst) {
  return inst?.loc?.base || inst?.addr?.base || null;
}

function keyBase(inst) {
  const loc = inst?.loc, addr = inst?.addr;
  if (!loc && !addr) return null;
  if (loc?.kind === 'stack') return 'stack';
  if (loc?.kind === 'global') return `global:${loc.address}`;
  const base = baseOf(inst);
  if (!base) return null;
  return `value:${base.id ?? base.reg ?? 'unknown'}`;
}

function nominalOwner(base, types) {
  const recovered = base?.id != null ? types?.values?.get?.(base.id) : null;
  const name = recovered?.className
    || recovered?.semanticType?.className
    || recovered?.pointee?.className
    || null;
  return name ? String(name).replace(/\s*\*$/, '') : null;
}

function resolverOwner(group, types) {
  const nominal = nominalOwner(group.base, types);
  if (nominal) return { key: nominal, nominal };
  if (group.base?.reg) return { key: String(group.base.reg), nominal: null };
  if (group.base?.id != null) return { key: `ssa:${group.base.id}`, nominal: null };
  return null;
}

export function recoverAggregateLayouts(ir, types, opts = {}) {
  const groups = new Map();
  for (const inst of ir?.instructions || []) {
    if (inst.op !== 'load' && inst.op !== 'store') continue;
    if (inst.loc?.kind === 'stack') continue;
    const root = keyBase(inst); if (!root) continue;
    const base = baseOf(inst);
    let g = groups.get(root);
    if (!g) { g = { root, base, accesses:[], fixed:new Map(), indexed:[] }; groups.set(root,g); }
    const size = Number(inst.loc?.size || inst.addr?.size || inst.size || 0);
    const disp = inst.loc?.disp ?? inst.addr?.disp ?? null;
    const indexed = !!inst.addr?.index;
    const rec = { row:inst.row, ir:inst.id, op:inst.op, size, disp, indexed, scale:indexed ? (1 << Number(inst.addr?.scale || 0)) : null, key:inst.loc?.key || null };
    g.accesses.push(rec);
    if (indexed) g.indexed.push(rec);
    else if (disp != null) {
      const k=String(disp); const xs=g.fixed.get(k)||[]; xs.push(rec); g.fixed.set(k,xs);
    }
  }
  const layouts=[];
  for (const g of groups.values()) {
    let kind='object'; let confidence=0.45; const evidence=[];
    if (g.indexed.length >= 2) {
      const consistent = g.indexed.every((x)=>x.size>0 && x.scale===x.size);
      if (consistent) { kind='array'; confidence=0.86; evidence.push('multiple indexed accesses with element-size scale'); }
    }
    if (kind !== 'array' && g.fixed.size >= 2) {
      const fixed=[...g.fixed.entries()].map(([offset,xs])=>({ offset:BigInt(offset), size:xs[0].size, reads:xs.filter(x=>x.op==='load').length, writes:xs.filter(x=>x.op==='store').length }));
      const noOverlap=fixed.every((a,i)=>fixed.every((b,j)=>i===j || a.offset+BigInt(a.size||0)<=b.offset || b.offset+BigInt(b.size||0)<=a.offset));
      if (noOverlap) { kind='struct-or-object'; confidence=0.68; evidence.push('multiple non-overlapping fixed-offset fields'); }
    }
    const owner = resolverOwner(g, types);
    const fields=[...g.fixed.entries()].map(([offset,xs])=>{
      const off=BigInt(offset); let known=null;
      if (owner) {
        try {
          known=opts.fieldFor?.(owner.key,off,xs[0]?.row,{
            root:g.root,
            base:g.base,
            nominalType:owner.nominal,
          })||null;
        } catch { known=null; }
      }
      return {
        offset:off,
        size:xs[0]?.size||0,
        name:known?.name || `field_${off.toString(16).toUpperCase()}`,
        type:known?.type || types?.locations?.get?.(xs[0]?.key) || null,
        confidence:known?.name ? (owner?.nominal ? 0.95 : 0.75) : 0.5,
        owner:owner?.key || null,
      };
    });
    layouts.push({ root:g.root, owner:owner?.key || null, kind, confidence, fields, indexed:g.indexed, evidence });
  }
  return layouts;
}
