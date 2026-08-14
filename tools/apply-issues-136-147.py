from pathlib import Path
import re


def sub(path, pattern, repl, flags=0, count=1):
    p = Path(path)
    text = p.read_text()
    new, n = re.subn(pattern, repl, text, count=count, flags=flags)
    if n != count:
        raise SystemExit(f"{path}: expected {count} replacement(s), got {n}: {pattern[:80]}")
    p.write_text(new)


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected exactly one occurrence, got {text.count(old)}: {old[:80]!r}")
    p.write_text(text.replace(old, new))

# #135/#136: iterative SCC + O(N+E) immediate-dominator representation.
control = Path('js/controlflow.js')
text = control.read_text()
start = text.index('function sameSet(')
end = text.index('/**\n * @param {number[][]}', start)
new_graph = r'''function reversePostOrder(succ, entry, allowed = null) {
  if (!(entry >= 0 && entry < succ.length) || (allowed && !allowed.has(entry))) return [];
  const seen = new Set([entry]);
  const post = [];
  const stack = [{ node: entry, next: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const xs = succ[frame.node] || [];
    if (frame.next < xs.length) {
      const next = xs[frame.next++];
      if ((allowed && !allowed.has(next)) || seen.has(next)) continue;
      seen.add(next);
      stack.push({ node: next, next: 0 });
      continue;
    }
    post.push(frame.node);
    stack.pop();
  }
  post.reverse();
  return post;
}

/* Cooper-Harvey-Kennedy immediate dominators: O(N) memory, no Set-per-node. */
function immediateDominatorsOf(succ, pred, reachable, entry) {
  const idom = new Array(succ.length).fill(-1);
  const rpo = reversePostOrder(succ, entry, reachable);
  if (!rpo.length) return { idom, rpo };
  const rank = new Array(succ.length).fill(-1);
  rpo.forEach((node, i) => { rank[node] = i; });
  idom[entry] = entry;
  const intersect = (a, b) => {
    let guard = succ.length * 2 + 4;
    while (a !== b && guard-- > 0) {
      while (rank[a] > rank[b]) a = idom[a];
      while (rank[b] > rank[a]) b = idom[b];
      if (a < 0 || b < 0) return -1;
    }
    return a === b ? a : -1;
  };
  let changed = true;
  for (let round = 0; changed && round < succ.length * 2 + 4; round++) {
    changed = false;
    for (let ri = 1; ri < rpo.length; ri++) {
      const node = rpo[ri];
      const ps = (pred[node] || []).filter((p) => reachable.has(p) && idom[p] >= 0);
      if (!ps.length) continue;
      let next = ps[0];
      for (let i = 1; i < ps.length && next >= 0; i++) next = intersect(next, ps[i]);
      if (next >= 0 && idom[node] !== next) { idom[node] = next; changed = true; }
    }
  }
  idom[entry] = -1;
  return { idom, rpo };
}

function dominanceIndex(idom, reachable) {
  const children = idom.map(() => []);
  const roots = [];
  for (let i = 0; i < idom.length; i++) {
    if (!reachable.has(i)) continue;
    if (idom[i] >= 0) children[idom[i]].push(i); else roots.push(i);
  }
  const tin = new Array(idom.length).fill(-1);
  const tout = new Array(idom.length).fill(-1);
  const depth = new Array(idom.length).fill(0);
  let clock = 0;
  for (const root of roots) {
    const stack = [{ node: root, exit: false }];
    while (stack.length) {
      const frame = stack.pop();
      if (frame.exit) { tout[frame.node] = clock++; continue; }
      tin[frame.node] = clock++;
      stack.push({ node: frame.node, exit: true });
      const kids = children[frame.node];
      for (let i = kids.length - 1; i >= 0; i--) {
        depth[kids[i]] = depth[frame.node] + 1;
        stack.push({ node: kids[i], exit: false });
      }
    }
  }
  return { tin, tout, depth };
}

class DominanceView {
  constructor(node, idom, reachable, index, excluded = -1) {
    this.node = node; this.idom = idom; this.reachable = reachable; this.index = index; this.excluded = excluded;
  }
  has(candidate) {
    if (!Number.isInteger(candidate) || candidate < 0 || candidate >= this.idom.length) return false;
    if (!this.reachable.has(this.node)) return candidate === this.node;
    if (!this.reachable.has(candidate) || candidate === this.excluded) return false;
    const { tin, tout } = this.index;
    return tin[candidate] >= 0 && tin[candidate] <= tin[this.node] && tout[this.node] <= tout[candidate];
  }
  get size() {
    if (!this.reachable.has(this.node)) return 1;
    return Math.max(1, this.index.depth[this.node] + 1 - (this.excluded >= 0 ? 1 : 0));
  }
  *[Symbol.iterator]() {
    if (!this.reachable.has(this.node)) { yield this.node; return; }
    let cur = this.node, guard = this.idom.length + 2;
    while (cur >= 0 && guard-- > 0) {
      if (cur !== this.excluded) yield cur;
      cur = this.idom[cur];
    }
  }
}

function dominanceViews(idom, reachable, excluded = -1) {
  const index = dominanceIndex(idom, reachable);
  return idom.map((_, node) => new DominanceView(node, idom, reachable, index, excluded));
}

/* Iterative Kosaraju SCC. Avoids JS call-stack overflow on giant functions. */
function strongComponents(succ, pred, reachable) {
  const seen = new Set();
  const finish = [];
  for (const root of reachable) {
    if (seen.has(root)) continue;
    seen.add(root);
    const stack = [{ node: root, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const xs = succ[frame.node] || [];
      if (frame.next < xs.length) {
        const next = xs[frame.next++];
        if (!reachable.has(next) || seen.has(next)) continue;
        seen.add(next); stack.push({ node: next, next: 0 });
      } else { finish.push(frame.node); stack.pop(); }
    }
  }
  const components = [];
  const componentOf = new Array(succ.length).fill(-1);
  const assigned = new Set();
  for (let fi = finish.length - 1; fi >= 0; fi--) {
    const root = finish[fi];
    if (assigned.has(root)) continue;
    const comp = [];
    const stack = [root]; assigned.add(root);
    while (stack.length) {
      const node = stack.pop(); comp.push(node); componentOf[node] = components.length;
      for (const next of pred[node] || []) {
        if (!reachable.has(next) || assigned.has(next)) continue;
        assigned.add(next); stack.push(next);
      }
    }
    components.push(comp);
  }
  return { components, componentOf };
}

function postDominatorsOf(succ, pred, reachable, components, componentOf) {
  const n = succ.length;
  const EXIT = n;
  const internal = (i) => succ[i].filter((j) => reachable.has(j));

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
  const reverse = Array.from({ length: n + 1 }, () => []);
  for (const i of eligible) {
    const xs = succ[i].filter((j) => eligible.has(j));
    if (!xs.length) reverse[EXIT].push(i);
    for (const j of xs) reverse[j].push(i);
  }
  const reversePred = predecessorsOf(reverse);
  const reverseReachable = reachableFrom(reverse, EXIT);
  const { idom: reverseIdom } = immediateDominatorsOf(reverse, reversePred, reverseReachable, EXIT);
  const views = dominanceViews(reverseIdom, reverseReachable, EXIT);
  const ipdom = new Array(n).fill(null);
  for (const i of eligible) {
    const d = reverseIdom[i];
    ipdom[i] = d >= 0 && d !== EXIT ? d : null;
  }
  return {
    postDominators: views.slice(0, n),
    immediatePostDominators: ipdom,
    nonTerminatingReachable: bad,
  };
}

'''
text = text[:start] + new_graph + text[end:]
text = text.replace(
"  const dominators = dominatorsOf(succ, predecessors, reachable, entry);\n  const { components, componentOf } = tarjan(succ, reachable);",
"  const { idom: immediateDominators } = immediateDominatorsOf(succ, predecessors, reachable, entry);\n  const dominators = dominanceViews(immediateDominators, reachable);\n  const { components, componentOf } = strongComponents(succ, predecessors, reachable);")
text = text.replace(
"    dominators,\n    components,",
"    dominators,\n    immediateDominators,\n    components,")
control.write_text(text)

# #137: stack identity is base register + signed displacement + SSA frame epoch.
replace('js/ir-core.js',
"  if (a.stack) {\n    return { key: 'stack:' + a.disp.toString(), kind: MK.STACK, disp: a.disp, size: a.size };\n  }",
"  if (a.stack) {\n    const baseReg = a.baseReg || a.base?.reg || 'stack';\n    const frameEpoch = a.base?.id ?? -1;\n    return {\n      key: `stack:${baseReg}:e${frameEpoch}:${a.disp.toString()}`,\n      kind: MK.STACK, baseReg, frameEpoch, disp: a.disp, size: a.size,\n    };\n  }")
replace('js/ir-core.js',
"  if (a.kind === MK.STACK || a.kind === MK.GLOBAL) {\n    const pa = a.kind === MK.STACK ? a.disp : a.address;\n    const pb = b.kind === MK.STACK ? b.disp : b.address;\n    if (pa == null || pb == null) return true;\n    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);\n    return !(pa + sa <= pb || pb + sb <= pa);\n  }",
"  if (a.kind === MK.STACK || a.kind === MK.GLOBAL) {\n    if (a.kind === MK.STACK && (a.baseReg !== b.baseReg || a.frameEpoch !== b.frameEpoch)) return true;\n    const pa = a.kind === MK.STACK ? a.disp : a.address;\n    const pb = b.kind === MK.STACK ? b.disp : b.address;\n    if (pa == null || pb == null) return true;\n    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);\n    return !(pa + sa <= pb || pb + sb <= pa);\n  }")
replace('js/ir-core.js',
"      key, disp: loc.disp, size: loc.size || 8,\n      reads: 0, writes: 0, name: null, escapes: false,",
"      key, baseReg: loc.baseReg || 'stack', frameEpoch: loc.frameEpoch ?? -1, disp: loc.disp, size: loc.size || 8,\n      reads: 0, writes: 0, name: null, escapes: false,")
replace('js/ir-core.js',
"  ordered.forEach((s) => {\n    const d = s.disp == null ? 0n : (s.disp < 0n ? -s.disp : s.disp);\n    s.name = 'var_' + d.toString(16);\n  });",
"  ordered.forEach((s) => {\n    const disp = s.disp == null ? 0n : s.disp;\n    const d = disp < 0n ? -disp : disp;\n    const sign = disp < 0n ? 'm' : 'p';\n    const base = String(s.baseReg || 'stack').replace(/[^A-Za-z0-9_]/g, '_');\n    s.name = `var_${base}_e${s.frameEpoch}_${sign}${d.toString(16)}`;\n  });")

# #138 and #142 plus #139 conservative branch successor handling in semantic decompiler.
replace('js/decompiler/semantic.js',
"function feedsReturn(value, ctx) {\n  if (!value || !ctx.returnInst) return false;\n  const rv = reachingRegisterValue(ctx.ir, ctx.returnInst, 'x0') || valueOf(ctx.returnInst.args?.[0]);\n  return sameValue(value, rv);\n}",
"function feedsReturn(value, ctx) {\n  if (!value) return false;\n  for (const ret of ctx.returnInsts || []) {\n    const rv = reachingRegisterValue(ctx.ir, ret, 'x0') || valueOf(ret.args?.[0]);\n    if (sameValue(value, rv)) return true;\n  }\n  return false;\n}")
replace('js/decompiler/semantic.js',
"    let cond = inst.cond || inst.extra?.cond || 'ne';\n    if (invert) cond = inverseCondition(cond) || cond;\n    const flags = valueOf(inst.args?.[inst.args.length - 1]);\n    return renderCmp(cmpFromFlags(flags), cond, ctx, inst);",
"    let cond = inst.cond || inst.extra?.cond || null;\n    if (!cond || !Object.prototype.hasOwnProperty.call(COND, cond) || !COND[cond]) {\n      return `__arm64_condition_${safeIdent(cond || 'unknown')}(/* NZCV */)`;\n    }\n    if (invert) {\n      const inverse = inverseCondition(cond);\n      if (!inverse || !Object.prototype.hasOwnProperty.call(COND, inverse) || !COND[inverse]) {\n        return `!(__arm64_condition_${safeIdent(cond)}(/* NZCV */))`;\n      }\n      cond = inverse;\n    }\n    const flags = valueOf(inst.args?.[inst.args.length - 1]);\n    return renderCmp(cmpFromFlags(flags), cond, ctx, inst);")
replace('js/decompiler/semantic.js',
"  if (term?.op !== OP.CBR || succ.length < 2) return { yes: succ[0] ?? null, no: succ[1] ?? null };\n  const yes = targetBlock(ir, term, ctx.opts.rowOfAddress);\n  if (yes == null || !succ.includes(yes)) return { yes: succ[0], no: succ[1] };\n  return { yes, no: succ.find((x) => x !== yes) ?? null };",
"  if (term?.op !== OP.CBR || succ.length < 2) return { yes: succ[0] ?? null, no: succ[1] ?? null, exact: term?.op !== OP.CBR };\n  const yes = targetBlock(ir, term, ctx.opts.rowOfAddress);\n  if (yes == null || !succ.includes(yes)) return { yes: null, no: null, exact: false };\n  return { yes, no: succ.find((x) => x !== yes) ?? null, exact: true };")
replace('js/decompiler/semantic.js',
"    returnInst: [...(ir.instructions || [])].reverse().find((i) => i.op === OP.RET) || null,",
"    returnInsts: (ir.instructions || []).filter((i) => i.op === OP.RET),")

# #139/#140: exact target mapping and dominance-selected controlling branch.
for path in ['js/decompiler/passes/stack-phi-recovery.js', 'js/decompiler/passes/stack-return-recovery.js']:
    p = Path(path); t = p.read_text()
    if path.endswith('stack-phi-recovery.js'):
        t = t.replace(
"  if (term?.op !== 'cbr' || successors.length < 2) return { yes: successors[0] ?? null, no: successors[1] ?? null };\n  const yes = targetBlock(ir, term, opts);\n  if (yes == null || !successors.includes(yes)) return { yes: successors[0] ?? null, no: successors[1] ?? null };\n  return { yes, no: successors.find((x) => x !== yes) ?? null };",
"  if (term?.op !== 'cbr' || successors.length < 2) return { yes: successors[0] ?? null, no: successors[1] ?? null, exact: term?.op !== 'cbr' };\n  const yes = targetBlock(ir, term, opts);\n  if (yes == null || !successors.includes(yes)) return { yes: null, no: null, exact: false };\n  return { yes, no: successors.find((x) => x !== yes) ?? null, exact: true };")
        old = """function controllerForMerge(ir, mergeBlock, predecessors, opts) {\n  const candidates = [];\n  for (const block of ir.blocks || []) {\n    const term = terminal(block);\n    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;\n    const { yes, no } = branchSuccessors(ir, block, term, opts);\n    const yesIndex = armIndex(ir, block, yes, mergeBlock, predecessors);\n    const noIndex = armIndex(ir, block, no, mergeBlock, predecessors);\n    if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) continue;\n    candidates.push({ term, yesIndex, noIndex, row: term.row ?? -1 });\n  }\n  candidates.sort((a, b) => b.row - a.row);\n  return candidates[0] || null;\n}\n"""
        new = """function dominates(ir, candidate, node) {\n  if (candidate == null || node == null) return false;\n  const view = ir.dominators?.[node];\n  if (view?.has) return view.has(candidate);\n  let cur = node, guard = (ir.blocks?.length || 0) + 2;\n  while (cur != null && cur >= 0 && guard-- > 0) {\n    if (cur === candidate) return true;\n    cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1;\n  }\n  return false;\n}\n\nfunction domDepth(ir, block) {\n  let depth = 0, cur = block, guard = (ir.blocks?.length || 0) + 2;\n  while (cur != null && cur >= 0 && guard-- > 0) { depth++; cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1; }\n  return depth;\n}\n\nfunction controllerForMerge(ir, mergeBlock, predecessors, opts) {\n  const candidates = [];\n  for (const block of ir.blocks || []) {\n    if (!dominates(ir, block.index, mergeBlock)) continue;\n    const term = terminal(block);\n    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;\n    const arms = branchSuccessors(ir, block, term, opts);\n    if (!arms.exact) continue;\n    const yesIndex = armIndex(ir, block, arms.yes, mergeBlock, predecessors);\n    const noIndex = armIndex(ir, block, arms.no, mergeBlock, predecessors);\n    if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) continue;\n    candidates.push({ term, yesIndex, noIndex, depth: domDepth(ir, block.index) });\n  }\n  candidates.sort((a, b) => b.depth - a.depth);\n  if (!candidates.length) return null;\n  if (candidates.length > 1 && candidates[0].depth === candidates[1].depth) return null;\n  return candidates[0];\n}\n"""
        if old not in t: raise SystemExit(f'{path}: controller block not found')
        t = t.replace(old, new)
    else:
        t = t.replace(
"  if (term?.op !== 'cbr' || succ.length < 2) return { yes:succ[0] ?? null, no:succ[1] ?? null };\n  const yes = targetBlock(ir, term, opts);\n  return yes != null && succ.includes(yes)\n    ? { yes, no:succ.find((x) => x !== yes) ?? null }\n    : { yes:succ[0] ?? null, no:succ[1] ?? null };",
"  if (term?.op !== 'cbr' || succ.length < 2) return { yes:succ[0] ?? null, no:succ[1] ?? null, exact:term?.op !== 'cbr' };\n  const yes = targetBlock(ir, term, opts);\n  return yes != null && succ.includes(yes)\n    ? { yes, no:succ.find((x) => x !== yes) ?? null, exact:true }\n    : { yes:null, no:null, exact:false };")
        old = """function controller(ir, merge, predecessors, opts) {\n  const candidates = [];\n  for (const block of ir.blocks || []) {\n    const term = terminal(block);\n    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;\n    const arms = branchArms(ir, block, term, opts);\n    const yesIndex = armPredecessorIndex(ir, block, arms.yes, merge, predecessors);\n    const noIndex = armPredecessorIndex(ir, block, arms.no, merge, predecessors);\n    if (yesIndex >= 0 && noIndex >= 0 && yesIndex !== noIndex) {\n      candidates.push({ term, yesIndex, noIndex, row:term.row ?? -1 });\n    }\n  }\n  candidates.sort((a,b) => b.row - a.row);\n  return candidates[0] || null;\n}\n"""
        new = """function dominates(ir, candidate, node) {\n  const view = ir.dominators?.[node];\n  if (view?.has) return view.has(candidate);\n  let cur = node, guard = (ir.blocks?.length || 0) + 2;\n  while (cur != null && cur >= 0 && guard-- > 0) {\n    if (cur === candidate) return true;\n    cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1;\n  }\n  return false;\n}\n\nfunction domDepth(ir, block) {\n  let depth = 0, cur = block, guard = (ir.blocks?.length || 0) + 2;\n  while (cur != null && cur >= 0 && guard-- > 0) { depth++; cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1; }\n  return depth;\n}\n\nfunction controller(ir, merge, predecessors, opts) {\n  const candidates = [];\n  for (const block of ir.blocks || []) {\n    if (!dominates(ir, block.index, merge)) continue;\n    const term = terminal(block);\n    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;\n    const arms = branchArms(ir, block, term, opts);\n    if (!arms.exact) continue;\n    const yesIndex = armPredecessorIndex(ir, block, arms.yes, merge, predecessors);\n    const noIndex = armPredecessorIndex(ir, block, arms.no, merge, predecessors);\n    if (yesIndex >= 0 && noIndex >= 0 && yesIndex !== noIndex) candidates.push({ term, yesIndex, noIndex, depth:domDepth(ir, block.index) });\n  }\n  candidates.sort((a,b) => b.depth - a.depth);\n  if (!candidates.length) return null;\n  if (candidates.length > 1 && candidates[0].depth === candidates[1].depth) return null;\n  return candidates[0];\n}\n"""
        if old not in t: raise SystemExit(f'{path}: controller block not found')
        t = t.replace(old, new)
        # #141: only a register definition that dominates the selected RET may anchor committed return recovery.
        marker = "function latestStoreTo(ir, blockIndex, beforeRow, key) {"
        insert = """function reachingRegisterDefinition(ir, atInst, reg) {\n  let best = null, bestDepth = -1, bestRow = -Infinity;\n  for (const value of ir?.values || []) {\n    if (value?.reg !== reg || !value.def || value.clobbered) continue;\n    const def = value.def;\n    if (def.block === atInst.block) {\n      if (def.row == null || atInst.row == null || def.row >= atInst.row) continue;\n      if (def.row > bestRow) { best = value; bestRow = def.row; bestDepth = Number.MAX_SAFE_INTEGER; }\n      continue;\n    }\n    if (!dominates(ir, def.block, atInst.block)) continue;\n    const depth = domDepth(ir, def.block);\n    if (bestDepth !== Number.MAX_SAFE_INTEGER && (depth > bestDepth || (depth === bestDepth && (def.row ?? -Infinity) > bestRow))) {\n      best = value; bestDepth = depth; bestRow = def.row ?? -Infinity;\n    }\n  }\n  return best;\n}\n\n"""
        if marker not in t: raise SystemExit(f'{path}: latestStore marker missing')
        t = t.replace(marker, insert + marker)
        old2 = """  const load = [...(result.ir.instructions || [])].reverse().find((inst) =>\n    inst?.op === 'load' && inst.loc?.key === root.location.key && inst.row < ret.row && inst.dst?.reg === 'x0');\n  if (!load) return null;\n  const stackStore = latestStoreTo(result.ir, load.block, load.row, root.location.key);\n"""
        new2 = """  const reaching = reachingRegisterDefinition(result.ir, ret, 'x0');\n  const load = reaching?.def;\n  if (load?.op !== 'load' || load.loc?.key !== root.location.key) return null;\n  const stackStore = load.reachingStore || latestStoreTo(result.ir, load.block, load.row, root.location.key);\n"""
        if old2 not in t: raise SystemExit(f'{path}: committed return lookup missing')
        t = t.replace(old2, new2)
    p.write_text(t)

# #143-145: cover both AAPCS64 register banks, exact entry-stack args and evidence-based return locations.
Path('js/decompiler/types/prototype.js').write_text(r'''/* AAPCS64 prototype recovery driven by actual SSA uses and recovered type evidence. */

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
''')

# #146/#147: semantic numeric dedupe and O(N+M) verified-target indexing.
Path('js/decompiler/switch.js').write_text(r'''/* Conservative switch/jump-table structuring. Verified descriptors only. */

function hex(v) { return BigInt(v).toString(16).toUpperCase(); }
function labelForAddress(addr) { return `loc_${hex(addr)}`; }
function textOf(lines) { return (lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n'); }

function addressForBlock(result, model, opts, block) {
  const b = result?.ir?.blocks?.[Number(block)];
  if (!b) return null;
  return model?.instructions?.find((i) => i.row === b.startRow)?.address ?? opts.addrOfRow?.(b.startRow) ?? null;
}

function normalizedCase(c, result, model, opts) {
  if (!c || c.value == null) return null;
  let address = c.address ?? c.target ?? null;
  if (address == null && c.block != null) address = addressForBlock(result, model, opts, c.block);
  if (address == null) return null;
  try { address = BigInt(address); } catch { return null; }
  return { value:c.value, address, label:labelForAddress(address) };
}

function insertionIndex(lines, row) {
  let i = lines.findIndex((l) => l?.row === row && /__asm\(["']br\s/i.test(l.text || ''));
  if (i >= 0) return { start:i, end:i + 1, indent:lines[i].indent || 1 };
  let last = -1;
  for (let n = 0; n < lines.length; n++) { const r = lines[n]?.row; if (r != null && r <= row) last = n; }
  if (last < 0) return null;
  const next = lines[last + 1];
  const indent = next?.kind === 'label' ? (next.indent || 1) + 1 : (lines[last].indent || 1);
  return { start:last + 1, end:last + 1, indent };
}

function caseLiteral(v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(v.trim())) return v.trim();
  return null;
}

function caseIdentity(literal) {
  try { return `n:${BigInt(literal).toString()}`; } catch { return null; }
}

function targetIndex(result, model) {
  const labels = new Set();
  for (const l of result.lines || []) {
    const m = String(l?.text || '').match(/^\s*(loc_[0-9A-Fa-f]+):\s*$/);
    if (m) labels.add(m[1].toUpperCase());
  }
  const rows = new Map();
  for (const i of model?.instructions || []) {
    if (i?.address == null || i?.row == null) continue;
    try { rows.set(BigInt(i.address).toString(), i.row); } catch { /* malformed instruction address */ }
  }
  return { labels, rows };
}

function materializeVerifiedLabels(result, index, addresses) {
  const missing = [];
  for (const address of addresses) {
    const label = labelForAddress(address);
    if (index.labels.has(label.toUpperCase())) continue;
    const row = index.rows.get(BigInt(address).toString());
    if (row == null) return false;
    missing.push({ address:BigInt(address), label, row });
  }
  if (!missing.length) return true;

  const targets = [...missing].sort((a,b) => a.row - b.row);
  const placements = [];
  let ti = 0;
  for (let li = 0; li < result.lines.length && ti < targets.length; li++) {
    const row = result.lines[li]?.row;
    if (row == null) continue;
    while (ti < targets.length && targets[ti].row <= row) { placements.push({ ...targets[ti++], at:li }); }
  }
  let closing = result.lines.findIndex((l) => l?.kind === 'ctrl' && l.text === '}');
  if (closing < 0) return false;
  while (ti < targets.length) placements.push({ ...targets[ti++], at:closing });

  placements.sort((a,b) => b.at - a.at || b.row - a.row);
  for (const item of placements) {
    const nearby = result.lines[item.at];
    const indent = nearby?.kind === 'label' ? (nearby.indent || 1) : Math.max(1, nearby?.indent || 1);
    result.lines.splice(item.at, 0, { kind:'label', indent, text:`${item.label}:`, row:item.row, addr:item.address, note:null });
    index.labels.add(item.label.toUpperCase());
  }
  return true;
}

export function structureKnownSwitches(result, model, opts = {}) {
  if (!result || !Array.isArray(result.lines)) return result;
  const descriptors = opts.switches || opts.jumpTables || model?.switches || model?.jumpTables || [];
  if (!Array.isArray(descriptors) || !descriptors.length) return result;
  const index = targetIndex(result, model);

  for (const sw of descriptors) {
    if (!sw || sw.row == null || !Array.isArray(sw.cases) || sw.cases.length < 2) continue;
    const cases = sw.cases.map((c) => normalizedCase(c, result, model, opts));
    if (cases.some((c) => !c)) continue;
    const values = cases.map((c) => caseLiteral(c.value));
    const identities = values.map(caseIdentity);
    if (values.some((v) => v == null) || identities.some((v) => v == null) || new Set(identities).size !== identities.length) continue;

    let defaultAddress = sw.defaultAddress ?? sw.defaultTarget ?? null;
    if (defaultAddress == null && sw.defaultBlock != null) defaultAddress = addressForBlock(result, model, opts, sw.defaultBlock);
    try { if (defaultAddress != null) defaultAddress = BigInt(defaultAddress); } catch { defaultAddress = null; }

    const allTargets = cases.map((c) => c.address);
    if (defaultAddress != null) allTargets.push(defaultAddress);
    if (!materializeVerifiedLabels(result, index, allTargets)) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} was not structured because one or more case targets are not exact instruction addresses.`];
      continue;
    }

    const at = insertionIndex(result.lines, sw.row);
    if (!at) continue;
    const expr = String(sw.expr || sw.reg || 'switch_value');
    const repl = [{ kind:'ctrl', indent:at.indent, text:`switch (${expr}) {`, row:sw.row, addr:null, note:null }];
    for (let i = 0; i < cases.length; i++) repl.push({ kind:'ctrl', indent:at.indent + 1, text:`case ${values[i]}: goto ${cases[i].label};`, row:sw.row, addr:cases[i].address, note:null });
    if (defaultAddress != null) repl.push({ kind:'ctrl', indent:at.indent + 1, text:`default: goto ${labelForAddress(defaultAddress)};`, row:sw.row, addr:defaultAddress, note:null });
    repl.push({ kind:'ctrl', indent:at.indent, text:'}', row:sw.row, addr:null, note:null });
    result.lines.splice(at.start, at.end - at.start, ...repl);
    result.evidence = [...(result.evidence || []), { row:sw.row, address:sw.address ?? null, op:'switch', reason:'verified jump-table/switch descriptor', cases:cases.map((c,i) => ({ value:values[i], target:c.address })) }];
    result.pseudocode = textOf(result.lines);
    result.ctx = { ...(result.ctx || {}), structuredSwitches:(result.ctx?.structuredSwitches || 0) + 1 };
  }
  return result;
}
''')

# Targeted regression tests for #135-147 delegated to this workstream.
Path('tests/issues-136-147.mjs').write_text(r'''import assert from 'node:assert/strict';
import { analyzeGraph } from '../js/controlflow.js';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, MK } from '../js/ir.js';
import { decompileSemantic, renderBranchCondition } from '../js/decompiler/semantic.js';
import { recoverFunctionPrototype } from '../js/decompiler/types/prototype.js';
import { structureKnownSwitches } from '../js/decompiler/switch.js';

// #135/#136: deep graph must not recurse, and dominators are lazy views rather than materialized Sets.
{
  const n = 12000;
  const succ = Array.from({length:n}, (_, i) => i + 1 < n ? [i + 1] : []);
  const g = analyzeGraph(succ, 0);
  assert.equal(g.components.length, n);
  assert.equal(g.dominators[n - 1].has(0), true);
  assert.equal(g.dominators[n - 1] instanceof Set, false);
  assert.equal(g.immediateDominators[n - 1], n - 2);
}

function make(lines, base=0x100000000n) {
  const raw = lines.map((text,row) => { const p=text.indexOf(' '); return {row,address:base+BigInt(row*4),mn:p<0?text:text.slice(0,p),ops:p<0?'':text.slice(p+1)}; });
  const rowOfAddress = (addr) => { const d=BigInt(addr)-base; return d>=0n && d<BigInt(raw.length*4) ? Number(d/4n) : null; };
  return { model:buildSemanticModel(raw,{startRow:0,endRow:raw.length-1,rowOfAddress}), rowOfAddress, base };
}

// #137: signed displacement + base register + SSA frame epoch are part of stack identity.
{
  const {model,rowOfAddress}=make(['str x0, [sp, #32]','str x1, [sp, #-32]','ret']);
  const ir=buildIR(model,{rowOfAddress});
  const stack=[...ir.locations.values()].filter((x)=>x.kind===MK.STACK);
  assert.equal(stack.length,2);
  assert.notEqual(stack[0].key,stack[1].key);
  assert.notEqual(ir.stackSlots[0].name,ir.stackSlots[1].name);
  assert.ok(ir.stackSlots.some((s)=>s.name.includes('_p20')));
  assert.ok(ir.stackSlots.some((s)=>s.name.includes('_m20')));
}

// #138: unsupported condition codes stay explicit; they never become !=.
{
  const fakeCtx={};
  const inst={op:'cbr',cond:'vs',extra:{kind:'cond'},args:[]};
  const text=renderBranchCondition(inst,fakeCtx);
  assert.match(text,/arm64_condition_vs/);
  assert.doesNotMatch(text,/!=/);
}

// #143/#144: both FP register bank and entry-SP stack arguments are represented.
{
  const v0={id:20,uses:[{}]}, x0={id:10,uses:[{}]}, sp={id:30,uses:[]};
  const ir={args:new Map([['x0',x0],['v0',v0],['sp',sp]]),instructions:[{op:'load',loc:{kind:'stack',baseReg:'sp',frameEpoch:30,disp:0n,key:'stack:sp:e30:0'},memUse:{kind:'entry'},dst:{id:40}}]};
  const p=recoverFunctionPrototype(ir,{values:new Map(),ret:{kind:'double',name:'double',bits:64,confidence:0.9}});
  assert.ok(p.argumentBanks.integer.some((a)=>a.reg==='x0'));
  assert.ok(p.argumentBanks.fp.some((a)=>a.reg==='v0'));
  assert.equal(p.argumentBanks.stack[0].stackOffset,0n);
  assert.equal(p.returnLocations[0].reg,'v0');
}

// #145: <=128-bit aggregate return occupies x0/x1 when type evidence proves it.
{
  const p=recoverFunctionPrototype({args:new Map(),instructions:[]},{values:new Map(),ret:{kind:'aggregate',name:'Pair',bits:128,confidence:0.8}});
  assert.deepEqual(p.returnLocations.map((x)=>x.reg),['x0','x1']);
}

// #146: numerically identical decimal/hex case values reject the descriptor.
{
  const result={lines:[{kind:'sig',indent:0,text:'f()'},{kind:'stmt',indent:1,text:'__asm("br x8");',row:0},{kind:'ctrl',indent:0,text:'}'}],ir:{blocks:[]}};
  const model={instructions:[{row:0,address:0x1000n},{row:1,address:0x1004n},{row:2,address:0x1008n}]};
  structureKnownSwitches(result,model,{switches:[{row:0,cases:[{value:'16',address:0x1004n},{value:'0x10',address:0x1008n}]}]});
  assert.doesNotMatch(result.pseudocode||'',/switch/);
}

console.log('issues-136-147: ok');
''')
print('patched issues 135-147 workstream')
