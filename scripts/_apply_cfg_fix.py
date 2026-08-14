from pathlib import Path
import json, re

ROOT = Path(__file__).resolve().parents[1]

def read(p): return (ROOT / p).read_text()
def write(p, s):
    path = ROOT / p
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(s)

def replace_once(s, old, new, label):
    n = s.count(old)
    if n != 1:
        raise RuntimeError(f'{label}: expected 1 occurrence, got {n}')
    return s.replace(old, new, 1)

def regex_once(s, pattern, repl, label):
    out, n = re.subn(pattern, repl, s, count=1, flags=re.S)
    if n != 1:
        raise RuntimeError(f'{label}: expected 1 match, got {n}')
    return out

CONTROLFLOW = r'''/*
 * Graph-theoretic control-flow analysis shared by the semantic model,
 * CFG viewer and decompiler.  Address order is deliberately irrelevant:
 * optimized binaries routinely place cleanup/cold blocks before their callers.
 */

function normalizedSuccessors(successors) {
  const n = successors.length;
  return successors.map((xs) => Array.from(new Set((xs || []).filter((x) => Number.isInteger(x) && x >= 0 && x < n))));
}

function predecessorsOf(succ) {
  const pred = succ.map(() => []);
  for (let i = 0; i < succ.length; i++) for (const j of succ[i]) pred[j].push(i);
  return pred;
}

function reachableFrom(succ, entry) {
  const out = new Set();
  if (!(entry >= 0 && entry < succ.length)) return out;
  const stack = [entry];
  while (stack.length) {
    const i = stack.pop();
    if (out.has(i)) continue;
    out.add(i);
    for (const j of succ[i]) if (!out.has(j)) stack.push(j);
  }
  return out;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function intersect(sets) {
  if (!sets.length) return new Set();
  const out = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) for (const x of Array.from(out)) if (!sets[i].has(x)) out.delete(x);
  return out;
}

function dominatorsOf(succ, pred, reachable, entry) {
  const all = new Set(reachable);
  const dom = succ.map((_, i) => reachable.has(i) ? new Set(all) : new Set([i]));
  if (reachable.has(entry)) dom[entry] = new Set([entry]);
  for (let round = 0; round < succ.length * 4 + 8; round++) {
    let changed = false;
    for (const i of reachable) {
      if (i === entry) continue;
      const ps = pred[i].filter((p) => reachable.has(p));
      const next = ps.length ? intersect(ps.map((p) => dom[p])) : new Set();
      next.add(i);
      if (!sameSet(next, dom[i])) { dom[i] = next; changed = true; }
    }
    if (!changed) break;
  }
  return dom;
}

function tarjan(succ, reachable) {
  let nextIndex = 0;
  const index = new Array(succ.length).fill(-1);
  const low = new Array(succ.length).fill(-1);
  const stack = [];
  const onStack = new Set();
  const components = [];
  const componentOf = new Array(succ.length).fill(-1);

  const visit = (v) => {
    index[v] = low[v] = nextIndex++;
    stack.push(v); onStack.add(v);
    for (const w of succ[v]) {
      if (!reachable.has(w)) continue;
      if (index[w] < 0) { visit(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack.has(w)) low[v] = Math.min(low[v], index[w]);
    }
    if (low[v] !== index[v]) return;
    const comp = [];
    while (stack.length) {
      const w = stack.pop(); onStack.delete(w); comp.push(w);
      componentOf[w] = components.length;
      if (w === v) break;
    }
    components.push(comp);
  };

  for (const v of reachable) if (index[v] < 0) visit(v);
  return { components, componentOf };
}

function postDominatorsOf(succ, reachable) {
  const n = succ.length;
  const EXIT = n;
  const universe = new Set([...reachable, EXIT]);
  const pdom = Array.from({ length: n + 1 }, (_, i) => i === EXIT ? new Set([EXIT]) :
    (reachable.has(i) ? new Set(universe) : new Set([i])));
  const nexts = (i) => {
    const xs = succ[i].filter((j) => reachable.has(j));
    return xs.length ? xs : [EXIT];
  };
  for (let round = 0; round < (n + 1) * 4 + 8; round++) {
    let changed = false;
    for (const i of reachable) {
      const next = intersect(nexts(i).map((j) => pdom[j]));
      next.add(i);
      if (!sameSet(next, pdom[i])) { pdom[i] = next; changed = true; }
    }
    if (!changed) break;
  }
  const ipdom = new Array(n).fill(null);
  for (const i of reachable) {
    const candidates = Array.from(pdom[i]).filter((x) => x !== i && x !== EXIT);
    let best = null, bestSize = -1;
    for (const c of candidates) {
      const size = pdom[c].size;
      if (size > bestSize) { best = c; bestSize = size; }
    }
    ipdom[i] = best;
  }
  return { postDominators: pdom.slice(0, n), immediatePostDominators: ipdom };
}

/**
 * @param {number[][]} successors internal CFG successor indices
 * @param {number} entry entry node index
 */
export function analyzeGraph(successors, entry = 0) {
  const succ = normalizedSuccessors(successors || []);
  const predecessors = predecessorsOf(succ);
  const reachable = reachableFrom(succ, entry);
  const dominators = dominatorsOf(succ, predecessors, reachable, entry);
  const { components, componentOf } = tarjan(succ, reachable);
  const backEdges = [];

  // A natural back-edge is not "an edge to a smaller address".  The target
  // must dominate the source and both ends must be in the same SCC.
  for (const from of reachable) {
    for (const to of succ[from]) {
      if (!reachable.has(to)) continue;
      if (componentOf[from] < 0 || componentOf[from] !== componentOf[to]) continue;
      if (!dominators[from].has(to)) continue;
      backEdges.push({ from, to });
    }
  }

  const loopByHeader = new Map();
  for (const edge of backEdges) {
    const header = edge.to, latch = edge.from;
    let loop = loopByHeader.get(header);
    if (!loop) {
      loop = { header, latches: new Set(), nodes: new Set([header]), exits: new Set() };
      loopByHeader.set(header, loop);
    }
    loop.latches.add(latch);
    const members = new Set([header, latch]);
    const stack = latch === header ? [] : [latch];
    while (stack.length) {
      const x = stack.pop();
      for (const p of predecessors[x]) {
        if (!reachable.has(p) || members.has(p)) continue;
        // Side-entry nodes make the region irreducible; do not absorb them.
        if (!dominators[p].has(header)) continue;
        if (componentOf[p] !== componentOf[header]) continue;
        members.add(p);
        if (p !== header) stack.push(p);
      }
    }
    for (const x of members) loop.nodes.add(x);
  }
  for (const loop of loopByHeader.values()) {
    for (const x of loop.nodes) for (const y of succ[x]) if (!loop.nodes.has(y)) loop.exits.add(y);
  }

  const post = postDominatorsOf(succ, reachable);
  return {
    successors: succ,
    predecessors,
    reachable,
    dominators,
    components,
    componentOf,
    backEdges,
    loops: Array.from(loopByHeader.values()),
    loopByHeader,
    postDominators: post.postDominators,
    immediatePostDominators: post.immediatePostDominators,
  };
}
'''
write('js/controlflow.js', CONTROLFLOW)

# blocks.js: make loop classification graph-theoretic rather than address-order based.
s = read('js/blocks.js')
if "./controlflow.js" not in s:
    s = replace_once(s, "import { parseOperands, categoryOf } from './arm64.js';", "import { parseOperands, categoryOf } from './arm64.js';\nimport { analyzeGraph } from './controlflow.js';", 'blocks import')
NEW_BASIC = r'''export function buildBasicBlocks(insns, opts) {
  const o = opts || {};
  const byRow = new Map();
  for (const i of insns) byRow.set(i.row, i);
  const first = insns.length ? insns[0].row : 0;
  const last = insns.length ? insns[insns.length - 1].row : 0;
  const inRange = (row) => row >= first && row <= last;

  const leaders = new Set([first]);
  const joinRows = new Set();
  for (const insn of insns) {
    if (!insn.isBranch) continue;
    if (insn.branchTarget != null && o.rowOfAddress) {
      const trow = o.rowOfAddress(insn.branchTarget);
      if (trow != null && inRange(trow)) {
        leaders.add(trow);
        joinRows.add(trow);
      }
    }
    if (!insn.isCall && inRange(insn.row + 1)) leaders.add(insn.row + 1);
  }
  if (o.extraLeaders) for (const r of o.extraLeaders) if (inRange(r)) leaders.add(r);

  const sorted = Array.from(leaders).sort((a, b) => a - b);
  const blocks = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const end = i + 1 < sorted.length ? sorted[i + 1] - 1 : last;
    if (end < start) continue;
    const rows = [];
    for (let r = start; r <= end; r++) if (byRow.has(r)) rows.push(r);
    if (!rows.length) continue;
    blocks.push({ index: blocks.length, startRow: start, endRow: end, rows,
      isJoin: joinRows.has(start), isLoopHeader: false });
  }

  const blockOfRow = (row) => {
    for (let i = 0; i < blocks.length; i++) if (row >= blocks[i].startRow && row <= blocks[i].endRow) return i;
    return -1;
  };
  const lastInsn = (b) => {
    for (let r = b.endRow; r >= b.startRow; r--) {
      const x = byRow.get(r);
      if (x && !x.data) return x;
    }
    return null;
  };
  const succ = blocks.map(() => []);
  for (let i = 0; i < blocks.length; i++) {
    const term = lastInsn(blocks[i]);
    const next = i + 1 < blocks.length ? i + 1 : -1;
    if (!term) { if (next >= 0) succ[i].push(next); continue; }
    if (term.isReturn || term.isTailCall) continue;
    if (term.isBranch && !term.isCall) {
      if (term.branchTarget != null && o.rowOfAddress) {
        const row = o.rowOfAddress(term.branchTarget);
        const to = row == null ? -1 : blockOfRow(row);
        if (to >= 0) succ[i].push(to);
      }
      if (term.isConditional && next >= 0) succ[i].push(next);
      continue;
    }
    if (next >= 0) succ[i].push(next);
  }

  const graph = analyzeGraph(succ, blocks.length ? 0 : -1);
  const backEdges = graph.backEdges.map((e) => {
    const term = lastInsn(blocks[e.from]);
    return { from: term ? term.row : blocks[e.from].endRow, to: blocks[e.to].startRow };
  });
  const headers = new Set(graph.backEdges.map((e) => e.to));
  blocks.forEach((b, i) => { b.isLoopHeader = headers.has(i); });
  return { blocks, joinRows, backEdges };
}'''
s = regex_once(s, r"export function buildBasicBlocks\(insns, opts\) \{.*?return \{ blocks, joinRows, backEdges \};\n\}", NEW_BASIC, 'buildBasicBlocks')
write('js/blocks.js', s)

# cfg.js: same natural-loop rule, and use post-dominators for branch merges.
s = read('js/cfg.js')
if "./controlflow.js" not in s:
    s = replace_once(s, "import { ROLE } from './blocks.js';", "import { ROLE } from './blocks.js';\nimport { analyzeGraph } from './controlflow.js';", 'cfg import')
s = replace_once(s, "        if (tblock <= node.index) backEdges.push({ from: node.index, to: tblock });\n", "", 'cfg old backward edge')
anchor = "  // Semantic Block の役割を、対応する Basic Block に添える（見出しに使う）"
insert = r'''  const graph = analyzeGraph(nodes.map((n) => n.succ.filter((s) => s.to >= 0).map((s) => s.to)), nodes.length ? 0 : -1);
  backEdges.push(...graph.backEdges.map((e) => ({ from: e.from, to: e.to })));
  const loopHeaders = new Set(graph.backEdges.map((e) => e.to));
  for (const n of nodes) n.isLoopHeader = loopHeaders.has(n.index);

'''
s = replace_once(s, anchor, insert + anchor, 'cfg graph insertion')
s = replace_once(s, "    shapes: classifyShapes(nodes, backEdges, model),", "    shapes: classifyShapes(nodes, backEdges, model, graph.immediatePostDominators),\n    dominators: graph.dominators,\n    components: graph.components,", 'cfg return graph')
s = replace_once(s, "function classifyShapes(nodes, backEdges, model) {", "function classifyShapes(nodes, backEdges, model, ipdom) {", 'cfg classify signature')
s = replace_once(s, "    const merge = firstMerge(nodes, a, c, 6);", "    const pd = ipdom && ipdom[n.index] != null ? ipdom[n.index] : -1;\n    const merge = pd >= 0 ? pd : firstMerge(nodes, a, c, 32);", 'cfg merge')
write('js/cfg.js', s)

# decompile.js: graph analysis, conservative structuring, explicit fallback edges and coverage recovery.
s = read('js/decompile.js')
if "./controlflow.js" not in s:
    s = replace_once(s, "import { findAccumulators } from './comprehend.js';", "import { findAccumulators } from './comprehend.js';\nimport { analyzeGraph } from './controlflow.js';", 'decompile import')
s = replace_once(s,
"  const state = { labels: new Set(), gotos: 0, depth: 0, openLoops: new Set() };\n  emitRange(cfg, 0, cfg.nodes.length - 1, 1, body, ctx, state, null);",
"  const state = { labels: new Set(), gotos: 0, depth: 0, openLoops: new Set(), emitted: new Set(), recovered: 0 };\n  emitRange(cfg, 0, cfg.nodes.length - 1, 1, body, ctx, state, null);\n  const coverage = recoverUnemittedBlocks(cfg, body, ctx, state);",
'decompile state coverage')
s = replace_once(s,
"  if (state.gotos) {\n    warnings.push('制御の流れが複雑で、' + state.gotos + ' か所は goto のまま残しました（コンパイラの最適化でよくあります）。');\n  }",
"  if (state.gotos) {\n    warnings.push('制御の流れが複雑で、' + state.gotos + ' か所は goto のまま残しました（コンパイラの最適化でよくあります）。');\n  }\n  if (coverage.recovered) {\n    warnings.push('最適化された共有経路 ' + coverage.recovered + ' ブロックを goto で安全に補完しました（到達可能な処理の欠落はありません）。');\n  }\n  if (coverage.missing) warnings.push('内部エラー: 到達可能な ' + coverage.missing + ' ブロックを出力できませんでした。');",
'decompile coverage warning')
s = replace_once(s, "  return { lines: out, signature, types, warnings, labels: state.labels, ctx };", "  return { lines: out, signature, types, warnings, labels: state.labels, ctx, coverage };", 'decompile return coverage')

old_flow_end = "  const preds = nodes.map(() => []);\n  for (const n of nodes) for (const s of n.succ) preds[s].push(n.index);\n  nodes.forEach((n, i) => { n.pred = preds[i]; });\n\n  return { nodes, nodeOfRow };"
new_flow_end = r'''  const preds = nodes.map(() => []);
  for (const n of nodes) for (const s of n.succ) preds[s].push(n.index);
  nodes.forEach((n, i) => { n.pred = preds[i]; });

  const graph = analyzeGraph(nodes.map((n) => n.succ), nodes.length ? 0 : -1);
  const loopByHeader = new Map();
  for (const loop of graph.loops) {
    const sorted = Array.from(loop.nodes).sort((a, b) => a - b);
    const min = sorted.length ? sorted[0] : loop.header;
    const max = sorted.length ? sorted[sorted.length - 1] : loop.header;
    const contiguous = min === loop.header && sorted.length === max - min + 1 &&
      sorted.every((x, k) => x === min + k);
    const exits = Array.from(loop.exits);
    const singleNaturalExit = exits.length === 0 || (exits.length === 1 && exits[0] === max + 1);
    const tailIsLatch = loop.latches.has(max);
    loopByHeader.set(loop.header, Object.assign({}, loop, {
      min, max, contiguous,
      structurable: contiguous && singleNaturalExit && tailIsLatch,
      exit: exits.length === 1 ? exits[0] : null,
    }));
  }
  return { nodes, nodeOfRow, graph, reachable: graph.reachable,
    loopByHeader, ipdom: graph.immediatePostDominators };
'''
s = replace_once(s, old_flow_end, new_flow_end, 'decompile buildFlow graph')

s = replace_once(s,
"    const n = cfg.nodes[i];\n\n    /* ループ: 自分に戻ってくる辺があるか（同じループを二重に開かない） */",
"    const n = cfg.nodes[i];\n    if (state.emitted.has(i)) return -1;\n\n    /* ループ: natural loop と証明できるものだけ構造化する。 */",
'emitRange emitted guard')

old_cond = r'''    /* 条件分岐 */
    if (n.cond && n.condTarget != null) {
      const nextI = emitIf(cfg, i, to, indent, out, ctx, state, loop);
      if (nextI != null) { i = nextI; continue; }
    }

    /* ふつうの並び */
    emitBlockBody(n, indent, out, ctx, state);'''
new_cond = r'''    /* 条件分岐。構造化できなければ、taken/fall の両方を明示して絶対に捨てない。 */
    if (n.cond && n.condTarget != null) {
      const nextI = emitIf(cfg, i, to, indent, out, ctx, state, loop);
      if (nextI != null) { i = nextI; continue; }
      emitBlockBody(n, indent, out, ctx, state, { skipTerminator: true });
      const targetLabel = labelOf(cfg.nodes[n.condTarget], ctx);
      if (loop && n.condTarget === loop.header) {
        out.push(line('ctrl', indent, 'if (' + condText(n.cond, ctx) + ') continue;', n.endRow, addrOf(ctx, n.endRow)));
      } else if (loop && loop.exit != null && n.condTarget === loop.exit) {
        out.push(line('ctrl', indent, 'if (' + condText(n.cond, ctx) + ') break;', n.endRow, addrOf(ctx, n.endRow)));
      } else {
        out.push(line('ctrl', indent, 'if (' + condText(n.cond, ctx) + ') goto ' + targetLabel + ';', n.endRow, addrOf(ctx, n.endRow)));
        state.labels.add(targetLabel); state.gotos++;
      }
      if (n.fall == null) return -1;
      i = n.fall;
      continue;
    }

    /* ふつうの並び */
    emitBlockBody(n, indent, out, ctx, state);'''
s = replace_once(s, old_cond, new_cond, 'emitRange conditional fallback')

old_jump = r'''    if (n.jump != null) {
      const target = n.jump;
      if (loop && target === loop.header) { out.push(line('ctrl', indent, 'continue;', n.endRow)); return -1; }
      if (loop && target === loop.exit) { out.push(line('ctrl', indent, 'break;', n.endRow)); return -1; }
      if (target === i + 1) { i = i + 1; continue; }      // ただの次へ
      if (target > to || target < from) {
        out.push(line('ctrl', indent, 'goto ' + labelOf(cfg.nodes[target], ctx) + ';', n.endRow));
        state.labels.add(labelOf(cfg.nodes[target], ctx));
        state.gotos++;
        return -1;
      }
      i = target;
      continue;
    }'''
new_jump = r'''    if (n.jump != null) {
      const target = n.jump;
      if (loop && target === loop.header) { out.push(line('ctrl', indent, 'continue;', n.endRow)); return -1; }
      if (loop && loop.exit != null && target === loop.exit) { out.push(line('ctrl', indent, 'break;', n.endRow)); return -1; }
      if (target === i + 1) { i = i + 1; continue; }
      const label = labelOf(cfg.nodes[target], ctx);
      out.push(line('ctrl', indent, 'goto ' + label + ';', n.endRow, addrOf(ctx, n.endRow)));
      state.labels.add(label); state.gotos++;
      // A non-fallthrough jump ends this linear path. Other reachable blocks are
      // emitted by their owning branch or by the final coverage recovery pass.
      return -1;
    }'''
s = replace_once(s, old_jump, new_jump, 'emitRange jump')

s = regex_once(s,
r"/\*\* i に戻ってくる後ろ向きの辺のうち、いちばん後ろの節点。なければ -1。 \*/\nfunction backEdgeInto\(cfg, i, to\) \{.*?\n\}",
r'''/** natural loop と証明でき、今の範囲で安全に構造化できる場合だけ返す。 */
function backEdgeInto(cfg, i, to) {
  const loop = cfg.loopByHeader && cfg.loopByHeader.get(i);
  if (!loop || !loop.structurable || loop.max > to) return -1;
  return loop.max;
}''', 'backEdgeInto')

s = regex_once(s,
r"/\*\* ループを訳す。header\.\.last がループの中身。 \*/\nfunction emitLoop\(cfg, header, last, to, indent, out, ctx, state\) \{.*?\n\}",
r'''/** natural loop を訳す。証明できない後方ジャンプはここへ来ない。 */
function emitLoop(cfg, header, last, to, indent, out, ctx, state) {
  const info = cfg.loopByHeader.get(header);
  if (!info || !info.structurable) return header;
  const node = cfg.nodes[header];
  const exit = info.exit != null ? info.exit : (last + 1 <= to ? last + 1 : null);
  const loop = { header, exit, last, members: info.nodes };
  state.openLoops.add(header);
  try {
    const headCond = node.cond && node.condTarget != null && !info.nodes.has(node.condTarget);
    if (headCond) {
      const cond = negate(node.cond);
      emitBlockBody(node, indent, out, ctx, state, { skipTerminator: true });
      out.push(line('ctrl', indent, 'while (' + condText(cond, ctx) + ')  {', node.endRow, addrOf(ctx, node.endRow)));
      if (ctx.beginner) out[out.length - 1].note = condNote(cond) + 'あいだ、下を繰り返します。';
      if (last >= header + 1) emitRange(cfg, header + 1, last, indent + 1, out, ctx, state, loop);
      out.push(line('ctrl', indent, '}', cfg.nodes[last].endRow));
      return exit == null ? -1 : exit;
    }

    const tail = cfg.nodes[last];
    const tailCond = tail.cond && tail.condTarget === header ? tail.cond : null;
    if (tailCond) {
      out.push(line('ctrl', indent, 'do  {', node.startRow, addrOf(ctx, node.startRow)));
      if (ctx.beginner) out[out.length - 1].note = '同じ処理を、条件が続くあいだ繰り返します。';
      emitBlockBody(node, indent + 1, out, ctx, state, { skipTerminator: true });
      if (last > header + 1) emitRange(cfg, header + 1, last - 1, indent + 1, out, ctx, state, loop);
      if (last !== header) emitBlockBody(tail, indent + 1, out, ctx, state, { skipTerminator: true });
      out.push(line('ctrl', indent, '} while (' + condText(tailCond, ctx) + ');', tail.endRow, addrOf(ctx, tail.endRow)));
      return exit == null ? -1 : exit;
    }

    // Unconditional latch: a real infinite loop. Never invent an unreadable condition.
    if (tail.jump === header) {
      out.push(line('ctrl', indent, 'while (1)  {', node.startRow, addrOf(ctx, node.startRow)));
      emitRange(cfg, header, last, indent + 1, out, ctx, state, loop);
      out.push(line('ctrl', indent, '}', tail.endRow));
      return exit == null ? -1 : exit;
    }
    return header;
  } finally {
    state.openLoops.delete(header);
  }
}''', 'emitLoop')

s = regex_once(s,
r"function emitIf\(cfg, i, to, indent, out, ctx, state, loop\) \{.*?\n\}\n\nfunction labelOf",
r'''function branchRegion(cfg, start, merge, to) {
  if (start === merge) return new Set();
  const seen = new Set(), stack = [start];
  while (stack.length) {
    const x = stack.pop();
    if (x === merge || seen.has(x)) continue;
    if (!(x >= 0 && x <= to) || !cfg.reachable.has(x)) return null;
    seen.add(x);
    for (const y of cfg.nodes[x].succ) if (y !== merge) stack.push(y);
  }
  return seen;
}

function contiguousRange(set) {
  if (!set || !set.size) return null;
  const xs = Array.from(set).sort((a, b) => a - b);
  for (let k = 1; k < xs.length; k++) if (xs[k] !== xs[k - 1] + 1) return null;
  return { from: xs[0], to: xs[xs.length - 1] };
}

function disjoint(a, b) {
  for (const x of a || []) if (b && b.has(x)) return false;
  return true;
}

function emitIf(cfg, i, to, indent, out, ctx, state, loop) {
  const n = cfg.nodes[i];
  const taken = n.condTarget, fall = n.fall;
  if (taken == null || fall == null || taken <= i) return null;
  const merge = cfg.ipdom && cfg.ipdom[i] != null ? cfg.ipdom[i] : null;
  if (merge == null || merge <= i || merge > to) return null;

  const takenSet = branchRegion(cfg, taken, merge, to);
  const fallSet = branchRegion(cfg, fall, merge, to);
  if (!takenSet || !fallSet || !disjoint(takenSet, fallSet)) return null;
  const tr = contiguousRange(takenSet), fr = contiguousRange(fallSet);
  if (takenSet.size && !tr) return null;
  if (fallSet.size && !fr) return null;
  if ([...takenSet, ...fallSet].some((x) => state.emitted.has(x))) return null;

  emitBlockBody(n, indent, out, ctx, state, { skipTerminator: true });
  if (!takenSet.size && !fallSet.size) return merge;

  if (!takenSet.size) {
    const cond = negate(n.cond);
    out.push(line('ctrl', indent, 'if (' + condText(cond, ctx) + ')  {', n.endRow, addrOf(ctx, n.endRow)));
    emitRange(cfg, fr.from, fr.to, indent + 1, out, ctx, state, loop);
    out.push(line('ctrl', indent, '}', null));
    return merge;
  }
  if (!fallSet.size) {
    out.push(line('ctrl', indent, 'if (' + condText(n.cond, ctx) + ')  {', n.endRow, addrOf(ctx, n.endRow)));
    emitRange(cfg, tr.from, tr.to, indent + 1, out, ctx, state, loop);
    out.push(line('ctrl', indent, '}', null));
    return merge;
  }

  const cond = negate(n.cond); // fall-through path is the source-level "then" arm
  out.push(line('ctrl', indent, 'if (' + condText(cond, ctx) + ')  {', n.endRow, addrOf(ctx, n.endRow)));
  emitRange(cfg, fr.from, fr.to, indent + 1, out, ctx, state, loop);
  out.push(line('ctrl', indent, '} else {', cfg.nodes[taken].startRow));
  emitRange(cfg, tr.from, tr.to, indent + 1, out, ctx, state, loop);
  out.push(line('ctrl', indent, '}', null));
  return merge;
}

/** Final correctness net: every reachable Basic Block must appear at least once. */
function recoverUnemittedBlocks(cfg, out, ctx, state) {
  const before = Array.from(cfg.reachable).filter((i) => !state.emitted.has(i)).sort((a, b) => a - b);
  for (const i of before) {
    if (state.emitted.has(i)) continue;
    const n = cfg.nodes[i];
    const own = labelOf(n, ctx);
    state.labels.add(own);
    emitBlockBody(n, 1, out, ctx, state, { skipTerminator: true });
    state.recovered++;
    if (n.cond && n.condTarget != null) {
      const t = labelOf(cfg.nodes[n.condTarget], ctx);
      state.labels.add(t);
      out.push(line('ctrl', 1, 'if (' + condText(n.cond, ctx) + ') goto ' + t + ';', n.endRow, addrOf(ctx, n.endRow)));
      state.gotos++;
      if (n.fall != null) {
        const f = labelOf(cfg.nodes[n.fall], ctx);
        state.labels.add(f);
        out.push(line('ctrl', 1, 'goto ' + f + ';', n.endRow)); state.gotos++;
      }
    } else if (n.jump != null) {
      const t = labelOf(cfg.nodes[n.jump], ctx);
      state.labels.add(t);
      out.push(line('ctrl', 1, 'goto ' + t + ';', n.endRow, addrOf(ctx, n.endRow))); state.gotos++;
    } else if (n.fall != null && n.succ.length) {
      const f = labelOf(cfg.nodes[n.fall], ctx);
      state.labels.add(f);
      out.push(line('ctrl', 1, 'goto ' + f + ';', n.endRow)); state.gotos++;
    }
  }
  const missing = Array.from(cfg.reachable).filter((i) => !state.emitted.has(i)).length;
  return { reachable: cfg.reachable.size, emitted: state.emitted.size,
    recovered: state.recovered, missing };
}

function labelOf''', 'emitIf and recovery')

s = replace_once(s,
"function emitBlockBody(node, indent, out, ctx, state, opts) {\n  void opts;",
"function emitBlockBody(node, indent, out, ctx, state, opts) {\n  if (state && state.emitted) state.emitted.add(node.index);\n  void opts;",
'emitBlockBody coverage')
write('js/decompile.js', s)

# Unit regression test: a backwards cleanup jump is not a loop; genuine loop remains one.
CFG_TEST = r'''import { buildSemanticModel } from '../js/blocks.js';
import { buildCfg } from '../js/cfg.js';
import { decompile, decompiledText } from '../js/decompile.js';

const BASE = 0x100000000n;
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function asm(lines) {
  return lines.map((line, i) => {
    const x = String(line).trim(); const p = x.indexOf(' ');
    return { row: i, address: BASE + BigInt(i) * 4n,
      mn: p < 0 ? x : x.slice(0, p), ops: p < 0 ? '' : x.slice(p + 1) };
  });
}
function make(lines) {
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < BigInt(lines.length) * 4n ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(asm(lines), { startRow: 0, endRow: lines.length - 1, rowOfAddress });
  const result = decompile(model, { addr: BASE, rowOfAddress,
    addrOfRow: (r) => BASE + BigInt(r) * 4n, symbolFor: () => null });
  return { model, cfg: buildCfg(model, { rowOfAddress }), result, text: decompiledText(result) };
}

// Optimized cleanup layout: row 5 jumps backwards to row 1, but row 1 does not
// dominate row 5. There is no cycle and therefore no loop.
const cleanup = make([
  'cbz x0, #0x100000010',
  'mov x1, #0x1',
  'b #0x100000018',
  'nop',
  'mov x2, #0x2',
  'b #0x100000004',
  'ret',
]);
assert(cleanup.model.backEdges.length === 0, 'blocks.js misclassified cleanup jump as loop');
assert(cleanup.cfg.backEdges.length === 0, 'cfg.js misclassified cleanup jump as loop');
assert(cleanup.result.coverage && cleanup.result.coverage.missing === 0, 'decompiler dropped reachable blocks');
assert(!cleanup.text.includes('条件は読み取れません */ 1'), 'decompiler invented an infinite loop condition');
assert(!cleanup.text.includes('while (1)'), 'cleanup jump became a fake infinite loop');

const loop = make([
  'mov x0, #0x0',
  'add x0, x0, #0x1',
  'cmp x0, #0xa',
  'b.ne #0x100000004',
  'ret',
]);
assert(loop.model.backEdges.length === 1, 'real natural loop disappeared from semantic model');
assert(loop.cfg.backEdges.length === 1, 'real natural loop disappeared from CFG');
assert(loop.result.coverage.missing === 0, 'real loop decompile lost a block');
assert(/while \(|do\s+\{/.test(loop.text), 'real natural loop was not structured');
console.log('cfg-structuring regression: ok');
'''
write('tests/cfg-structuring.mjs', CFG_TEST)

# Real BattleCats regression pinned to the function from the reported screenshot.
BATTLE_TEST = r'''import { openBinary } from './harness.mjs';
import { decompile, decompiledText } from '../js/decompile.js';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const FN = 0x1001A74E4n;
const world = await openBinary('tests/battlecats', { objc: false, strings: false, texts: false });
const model = await world.analyze(FN);
assert(model, 'BattleCats function could not be analyzed');
const rowOfAddress = (addr) => world.rowOf(BigInt(addr));
const result = decompile(model, {
  addr: FN,
  rowOfAddress,
  addrOfRow: (row) => world.region.vmAddr + BigInt(row) * 4n,
  symbolFor: (addr) => world.symbols.nameAt(BigInt(addr)) || null,
});

for (const [fromAddr, toAddr] of [
  [0x1001A847Cn, 0x1001A7F90n],
  [0x1001A909Cn, 0x1001A7FCCn],
]) {
  const from = rowOfAddress(fromAddr), to = rowOfAddress(toAddr);
  assert(!model.backEdges.some((e) => e.from === from && e.to === to),
    `false natural loop survived: ${fromAddr.toString(16)} -> ${toAddr.toString(16)}`);
}
assert(result.coverage && result.coverage.missing === 0,
  `reachable blocks missing: ${JSON.stringify(result.coverage)}`);
const text = decompiledText(result);
assert(!text.includes('/* 条件は読み取れません */ 1'), 'fake unreadable infinite loop survived');
console.log('BattleCats CFG regression: ok', result.coverage);
'''
write('tests/battlecats-cfg-regression.mjs', BATTLE_TEST)

# Keep the fast synthetic regression in the normal test suite.
pkg = json.loads(read('package.json'))
if 'cfg-structuring.mjs' not in pkg['scripts']['test']:
    pkg['scripts']['test'] = pkg['scripts']['test'].replace('node tests/run.js', 'node tests/run.js && node tests/cfg-structuring.mjs')
write('package.json', json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')

# Run the real BattleCats regression in the existing cross-binary CI before the expensive accuracy pass.
yml = read('.github/workflows/cross-binary-accuracy.yml')
if 'BattleCats CFG regression' not in yml:
    yml = replace_once(yml,
"      - name: BattleCats oracle\n        run: python tests/oracle.py tests/battlecats tests/oracle.battlecats.ci.json.gz",
"      - name: BattleCats CFG regression\n        run: node --max-old-space-size=6000 tests/battlecats-cfg-regression.mjs\n      - name: BattleCats oracle\n        run: python tests/oracle.py tests/battlecats tests/oracle.battlecats.ci.json.gz",
'accuracy workflow regression')
write('.github/workflows/cross-binary-accuracy.yml', yml)

print('CFG repair applied')
