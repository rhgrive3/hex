from pathlib import Path

# #142: recover each C-AST return from its own physical RET provenance.
p=Path('js/decompiler/passes/stack-phi-recovery.js')
s=p.read_text()
old="""function recoverReturnExpression(result, maps, opts, engine) {
  const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
  const root = output?.expression;
  if (root?.kind !== 'load' || root.location?.kind !== 'stack' || !root.location?.key) return null;
  const retInst = [...(result.ir?.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  if (!retInst) return null;
  return resolveStackBefore(result.ir, retInst.block, retInst.row, root.location.key, maps, opts, engine, new Set());
}

function rewriteReturnInAst(result, expression) {
  let changed = false;
  for (const node of result.cAst?.body || []) {
    if (node.semantic?.op === 'return' || /^return\\b/.test(String(node.text || '').trim())) {
      node.text = `return ${printExpression(expression)};`;
      if (node.semantic) node.semantic.expression = expression;
      changed = true;
    }
  }
  return changed;
}
"""
new="""function isReturnNode(node) {
  return node?.semantic?.op === 'return' || /^return\\b/.test(String(node?.text || '').trim());
}

function stackReturnKey(expression) {
  return expression?.kind === 'load' && expression.location?.kind === 'stack' && expression.location?.key
    ? expression.location.key : null;
}

function returnSiteForNode(node, ir, allowSingleFallback = false) {
  const rets = (ir?.instructions || []).filter((inst) => inst.op === 'ret');
  if (!rets.length) return null;
  const source = node?.source || {};
  const rows = new Set([...(source.rows || []), ...(node?.semantic?.expression?.source?.rows || [])].map(Number));
  const irIds = new Set([...(source.ir || []), ...(node?.semantic?.expression?.source?.ir || [])].map(Number));
  const addresses = new Set([...(source.addresses || []), ...(node?.semantic?.expression?.source?.addresses || [])].map((x) => String(x)));
  const matches = rets.filter((ret) => rows.has(Number(ret.row)) || irIds.has(Number(ret.id)) || addresses.has(String(ret.address)));
  if (matches.length === 1) return matches[0];
  if (!matches.length && allowSingleFallback && rets.length === 1) return rets[0];
  return null;
}

function recoverReturnExpressionAt(result, node, maps, opts, engine, allowSingleFallback) {
  const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
  const expression = node?.semantic?.expression || (allowSingleFallback ? output?.expression : null);
  const key = stackReturnKey(expression);
  if (!key) return null;
  const retInst = returnSiteForNode(node, result.ir, allowSingleFallback);
  if (!retInst) return null;
  return resolveStackBefore(result.ir, retInst.block, retInst.row, key, maps, opts, engine, new Set());
}

function rewriteReturnsInAst(result, maps, opts, engine) {
  const nodes = (result.cAst?.body || []).filter(isReturnNode);
  if (!nodes.length) return { changed:0, recovered:[] };
  const recovered = [];
  const allowSingleFallback = nodes.length === 1;
  for (const node of nodes) {
    const expression = recoverReturnExpressionAt(result, node, maps, opts, engine, allowSingleFallback);
    if (!expression || expression.kind === 'load') continue;
    node.text = `return ${printExpression(expression)};`;
    if (node.semantic) node.semantic.expression = expression;
    recovered.push({ node, expression });
  }
  if (recovered.length === 1 && nodes.length === 1) {
    const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
    if (output) output.expression = recovered[0].expression;
  }
  return { changed:recovered.length, recovered };
}
"""
if old not in s: raise SystemExit('#142 recovery anchor missing')
s=s.replace(old,new,1)
old="""  const recovered = recoverReturnExpression(result, maps, opts, engine);
  if (!recovered || recovered.kind === 'load') return result;

  const output = result.semanticAst.outputs.find((x) => x.name === 'return');
  output.expression = recovered;
  if (!rewriteReturnInAst(result, recovered)) return result;

  const printed = printProgram(result.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 });"""
new="""  const rewrite = rewriteReturnsInAst(result, maps, opts, engine);
  if (!rewrite.changed) return result;

  const printed = printProgram(result.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 });"""
if old not in s: raise SystemExit('#142 main recovery anchor missing')
s=s.replace(old,new,1)
s=s.replace("detail: 'two-path exact stack value reconstructed without crossing unknown memory effects'", "detail: `${rewrite.changed} return site(s) reconstructed from exact RET provenance without crossing unknown memory effects`",1)
p.write_text(s)

# #574: normalize must-alias field pointer provenance and conservatively kill
# potentially aliasing FIELD ranges when roots differ.
p=Path('js/ir-core.js'); s=p.read_text()
anchor="""function locationOf(inst) {
  const a = inst.addr;"""
helper="""function pointerProvenanceOf(value, memo = new Map(), active = new Set()) {
  if (!value) return null;
  if (memo.has(value.id)) return memo.get(value.id);
  if (active.has(value.id)) return null;
  active.add(value.id);
  let out = null;
  const def = value.def;
  if (!def || value.kind === VK.ARG || value.kind === VK.UNDEF) {
    out = { root:value.id, offset:0n, must:true, via:value.kind || 'root' };
  } else if (def.op === OP.MOV && def.args?.[0]?.value) {
    const p = pointerProvenanceOf(def.args[0].value, memo, active);
    if (p?.must) out = { ...p, via:'mov' };
  } else if (def.op === OP.BIN && (def.sub === 'add' || def.sub === 'sub') && def.args?.length >= 2) {
    const left=def.args[0]?.value, right=def.args[1]?.value;
    const lc=left?.const, rc=right?.const;
    if (left && rc != null) {
      const p=pointerProvenanceOf(left,memo,active);
      if (p?.must && p.offset != null) out={...p,offset:p.offset+(def.sub==='sub'?-rc:rc),via:def.sub};
    } else if (def.sub === 'add' && right && lc != null) {
      const p=pointerProvenanceOf(right,memo,active);
      if (p?.must && p.offset != null) out={...p,offset:p.offset+lc,via:'add'};
    }
  } else if (def.op === OP.PHI && def.args?.length) {
    const incoming=def.args.map((a)=>pointerProvenanceOf(a?.value,memo,active));
    if (incoming.every((x)=>x?.must && x.root != null && x.offset != null)) {
      const first=incoming[0];
      if (incoming.every((x)=>x.root===first.root && x.offset===first.offset)) out={...first,via:'phi'};
    }
  }
  active.delete(value.id);
  memo.set(value.id,out);
  return out;
}

function locationOf(inst) {
  const a = inst.addr;"""
if anchor not in s: raise SystemExit('#574 location anchor missing')
s=s.replace(anchor,helper,1)
old="""  return {
    key: 'field:' + base.id + '+' + a.disp.toString() + ':s' + size,
    kind: MK.FIELD, base, disp: a.disp, size,
  };"""
new="""  const provenance = pointerProvenanceOf(base);
  const baseRoot = provenance?.must && provenance.root != null ? provenance.root : base.id;
  const disp = provenance?.must && provenance.offset != null ? a.disp + provenance.offset : a.disp;
  return {
    key: 'field:' + baseRoot + '+' + disp.toString() + ':s' + size,
    kind: MK.FIELD, base, baseRoot, pointerProvenance:provenance, disp, size,
  };"""
if old not in s: raise SystemExit('#574 field key anchor missing')
s=s.replace(old,new,1)
old="""  if (a.base && b.base && a.base.id === b.base.id) {
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(a.disp + sa <= b.disp || b.disp + sb <= a.disp);
  }
  return true;"""
new="""  if (a.baseRoot != null && b.baseRoot != null && a.baseRoot === b.baseRoot) {
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(a.disp + sa <= b.disp || b.disp + sb <= a.disp);
  }
  return true;"""
if old not in s: raise SystemExit('#574 mayAlias anchor missing')
s=s.replace(old,new,1)
old="""  if (storeLoc.kind === MK.FIELD) {
    if (!storeLoc.base || !otherLoc.base || storeLoc.base.id !== otherLoc.base.id) return false;
    if (storeLoc.disp == null || otherLoc.disp == null) return false;
    return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
  }"""
new="""  if (storeLoc.kind === MK.FIELD) {
    if (storeLoc.disp == null || otherLoc.disp == null) return true;
    if (storeLoc.baseRoot != null && otherLoc.baseRoot != null && storeLoc.baseRoot === otherLoc.baseRoot) {
      return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
    }
    // Different SSA roots are not proof of distinct objects. Treat them as
    // may-alias and install a clobber so a stale reaching store cannot survive.
    return true;
  }"""
if old not in s: raise SystemExit('#574 store overlap anchor missing')
s=s.replace(old,new,1)
p.write_text(s)
print('applied decompiler/IR batch 2')
