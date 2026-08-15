from pathlib import Path

p = Path('js/decompiler/passes/stack-phi-recovery.js')
s = p.read_text()
old = r'''function recoverReturnExpression(result, maps, opts, engine) {
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
    if (node.semantic?.op === 'return' || /^return\b/.test(String(node.text || '').trim())) {
      node.text = `return ${printExpression(expression)};`;
      if (node.semantic) node.semantic.expression = expression;
      changed = true;
    }
  }
  return changed;
}
'''
new = r'''function isReturnNode(node) {
  return node?.semantic?.op === 'return' || /^return\b/.test(String(node?.text || '').trim());
}

function stackReturnKey(expression) {
  return expression?.kind === 'load' && expression.location?.kind === 'stack' && expression.location?.key
    ? expression.location.key : null;
}

function returnSiteForNode(node, ir, allowSingleFallback = false) {
  const rets = (ir?.instructions || []).filter((inst) => inst.op === 'ret');
  if (!rets.length) return null;
  const source = node?.source || {};
  const rows = new Set((source.rows || []).map(Number));
  const irIds = new Set((source.ir || []).map(Number));
  const addresses = new Set((source.addresses || []).map((x) => String(x)));
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
'''
if old not in s:
    if new not in s: raise SystemExit('return-recovery anchor missing')
else:
    s = s.replace(old, new, 1)

old2 = r'''  const recovered = recoverReturnExpression(result, maps, opts, engine);
  if (!recovered || recovered.kind === 'load') return result;

  const output = result.semanticAst.outputs.find((x) => x.name === 'return');
  output.expression = recovered;
  if (!rewriteReturnInAst(result, recovered)) return result;
'''
new2 = r'''  const rewrite = rewriteReturnsInAst(result, maps, opts, engine);
  if (!rewrite.changed) return result;
'''
if old2 not in s:
    if new2 not in s: raise SystemExit('pass-body anchor missing')
else:
    s = s.replace(old2, new2, 1)

old3 = "evidence: { kind: 'cfg-memory-ssa', detail: 'two-path exact stack value reconstructed without crossing unknown memory effects' },"
new3 = "evidence: { kind: 'cfg-memory-ssa', detail: `${rewrite.changed} return site(s) reconstructed from exact RET provenance without crossing unknown memory effects` },"
if old3 in s: s = s.replace(old3, new3, 1)
elif new3 not in s: raise SystemExit('rewrite-proof anchor missing')

old4 = "rewrittenExpressions: (result.metrics?.rewrittenExpressions || 0) + 1,"
new4 = "rewrittenExpressions: (result.metrics?.rewrittenExpressions || 0) + rewrite.changed,"
if old4 in s: s = s.replace(old4, new4, 1)
elif new4 not in s: raise SystemExit('rewrite metric anchor missing')

# Fail closed if the old global-return behavior survived.
for forbidden in ['function recoverReturnExpression(result,', 'function rewriteReturnInAst(result, expression)', ".reverse().find((inst) => inst.op === 'ret')"]:
    if forbidden in s: raise SystemExit('legacy multi-return behavior survived: ' + forbidden)
for required in ['function returnSiteForNode(', 'function recoverReturnExpressionAt(', 'function rewriteReturnsInAst(', 'const rewrite = rewriteReturnsInAst(']:
    if required not in s: raise SystemExit('new return-site contract missing: ' + required)
p.write_text(s)

p = Path('package.json')
s = p.read_text()
needle = '"decompiler:test": "node tests/issue-429-range-domain.mjs'
replacement = '"decompiler:test": "node tests/issue-142-multi-return.mjs && node tests/issue-429-range-domain.mjs'
if needle in s:
    s = s.replace(needle, replacement, 1)
elif replacement not in s:
    raise SystemExit('package decompiler:test anchor missing')
p.write_text(s)

print('applied issue #142 multi-return recovery')
