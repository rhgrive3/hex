from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(p): return (ROOT / p).read_text()
def write(p, s): (ROOT / p).write_text(s)
def once(s, old, new, name):
    n = s.count(old)
    if n != 1: raise RuntimeError(f'{name}: expected 1, got {n}')
    return s.replace(old, new, 1)

# 1) Post-dominators are undefined for paths that can disappear into a closed
# non-terminating SCC. Exclude those nodes instead of inventing a merge.
s = read('js/controlflow.js')
pat = r"function postDominatorsOf\(succ, reachable\) \{.*?\n\}\n\n/\*\*\n \* @param"
repl = r'''function postDominatorsOf(succ, pred, reachable, components, componentOf) {
  const n = succ.length;
  const EXIT = n;
  const internal = (i) => succ[i].filter((j) => reachable.has(j));

  /*
   * A closed SCC with no real exit is a non-terminating path.  If a node can
   * reach one, an ordinary immediate post-dominator is unsafe: one execution
   * may never reach the alleged merge at all.  Keep ipdom=null for that whole
   * reverse-reachable region so the decompiler falls back to explicit edges.
   */
  const compOut = components.map(() => new Set());
  const compHasExit = components.map(() => false);
  for (const i of reachable) {
    const ci = componentOf[i];
    const xs = internal(i);
    if (!xs.length) compHasExit[ci] = true;
    for (const j of xs) {
      const cj = componentOf[j];
      if (ci !== cj) compOut[ci].add(cj);
    }
  }
  const bad = new Set();
  const stack = [];
  for (let c = 0; c < components.length; c++) {
    if (compOut[c].size || compHasExit[c]) continue;
    for (const i of components[c]) if (reachable.has(i)) { bad.add(i); stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    for (const p of pred[i]) {
      if (!reachable.has(p) || bad.has(p)) continue;
      bad.add(p); stack.push(p);
    }
  }

  const eligible = new Set(Array.from(reachable).filter((i) => !bad.has(i)));
  const universe = new Set([...eligible, EXIT]);
  const pdom = Array.from({ length: n + 1 }, (_, i) => i === EXIT ? new Set([EXIT]) :
    (eligible.has(i) ? new Set(universe) : new Set([i])));
  const nexts = (i) => {
    const xs = succ[i].filter((j) => eligible.has(j));
    return xs.length ? xs : [EXIT];
  };
  for (let round = 0; round < (n + 1) * 4 + 8; round++) {
    let changed = false;
    for (const i of eligible) {
      const next = intersect(nexts(i).map((j) => pdom[j]));
      next.add(i);
      if (!sameSet(next, pdom[i])) { pdom[i] = next; changed = true; }
    }
    if (!changed) break;
  }
  const ipdom = new Array(n).fill(null);
  for (const i of eligible) {
    const candidates = Array.from(pdom[i]).filter((x) => x !== i && x !== EXIT);
    let best = null, bestSize = -1;
    for (const c of candidates) {
      const size = pdom[c].size;
      if (size > bestSize) { best = c; bestSize = size; }
    }
    ipdom[i] = best;
  }
  return { postDominators: pdom.slice(0, n), immediatePostDominators: ipdom,
    nonTerminatingReachable: bad };
}

/**
 * @param'''
s2, n = re.subn(pat, repl, s, count=1, flags=re.S)
if n != 1: raise RuntimeError(f'postDominators replacement: {n}')
s = s2
s = once(s,
"  const post = postDominatorsOf(succ, reachable);",
"  const post = postDominatorsOf(succ, predecessors, reachable, components, componentOf);",
'postdom call')
s = once(s,
"    immediatePostDominators: post.immediatePostDominators,",
"    immediatePostDominators: post.immediatePostDominators,\n    nonTerminatingReachable: post.nonTerminatingReachable,",
'postdom result')
write('js/controlflow.js', s)

# 2) Never hide an indirect/unknown-target branch merely because it is a
# terminator.  Only an internal branch handled by the structurer is suppressed.
s = read('js/decompile.js')
s = once(s,
"    if (insn === node.terminator && insn.isBranch && !insn.isCall && !insn.isReturn) continue;",
"    if (insn === node.terminator && insn.isBranch && !insn.isCall && !insn.isReturn &&\n        (node.jump != null || node.condTarget != null)) continue;",
'preserve unknown branch')

# 3) Coverage means every Basic Block in the function, not merely blocks that
# our incomplete static CFG can prove reachable. This also preserves switch
# targets behind `br` and exception/cold chunks with no explicit normal edge.
s = once(s,
"  const before = Array.from(cfg.reachable).filter((i) => !state.emitted.has(i)).sort((a, b) => a - b);",
"  const all = cfg.nodes.map((_, i) => i);\n  const before = all.filter((i) => !state.emitted.has(i));",
'coverage all blocks')
s = once(s,
"  const missing = Array.from(cfg.reachable).filter((i) => !state.emitted.has(i)).length;\n  return { reachable: cfg.reachable.size, emitted: state.emitted.size,\n    recovered: state.recovered, missing };",
"  const missing = all.filter((i) => !state.emitted.has(i)).length;\n  const reachableMissing = Array.from(cfg.reachable).filter((i) => !state.emitted.has(i)).length;\n  return { total: cfg.nodes.length, reachable: cfg.reachable.size, emitted: state.emitted.size,\n    recovered: state.recovered, missing, reachableMissing };",
'coverage result')
s = once(s,
"    warnings.push('最適化された共有経路 ' + coverage.recovered + ' ブロックを goto で安全に補完しました（到達可能な処理の欠落はありません）。');",
"    warnings.push('構造化できなかった共有・間接経路 ' + coverage.recovered + ' ブロックを goto で安全に補完しました（関数内の処理は省略していません）。');",
'coverage warning')
write('js/decompile.js', s)

# 4) Expand fast regression coverage.
s = read('tests/cfg-structuring.mjs')
s = once(s,
"import { decompile, decompiledText } from '../js/decompile.js';",
"import { decompile, decompiledText } from '../js/decompile.js';\nimport { analyzeGraph } from '../js/controlflow.js';",
'test import')
insert = r'''
// A branch that can either exit or disappear into a closed infinite SCC has no
// safe immediate post-dominator. Treating one as a merge would invent an if.
const nonTerm = analyzeGraph([[1, 2], [1], []], 0);
assert(nonTerm.immediatePostDominators[0] == null,
  'post-dominator invented across a non-terminating path');

// Indirect branches are not statically connected to their jump-table targets.
// The decompiler must still preserve both the `br` itself and every block in
// the function range instead of silently dropping the disconnected chunk.
const indirect = make([
  'br x8',
  'mov x0, #0x1',
  'ret',
]);
assert(indirect.text.includes('__asm("br x8")'), 'indirect branch disappeared');
assert(indirect.result.coverage.missing === 0, 'disconnected function block disappeared');
assert(indirect.result.coverage.emitted === indirect.result.coverage.total,
  'coverage does not include every Basic Block');
'''
s = once(s, "console.log('cfg-structuring regression: ok');", insert + "\nconsole.log('cfg-structuring regression: ok');", 'test insertion')
write('tests/cfg-structuring.mjs', s)

s = read('tests/battlecats-cfg-regression.mjs')
s = once(s,
"assert(result.coverage && result.coverage.missing === 0,\n  `reachable blocks missing: ${JSON.stringify(result.coverage)}`);",
"assert(result.coverage && result.coverage.missing === 0,\n  `function blocks missing: ${JSON.stringify(result.coverage)}`);\nassert(result.coverage.emitted === result.coverage.total,\n  `not every function block was emitted: ${JSON.stringify(result.coverage)}`);",
'battle coverage')
write('tests/battlecats-cfg-regression.mjs', s)

print('CFG hardening applied')
