/*
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

function postDominatorsOf(succ, pred, reachable, components, componentOf) {
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

  const post = postDominatorsOf(succ, predecessors, reachable, components, componentOf);
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
    nonTerminatingReachable: post.nonTerminatingReachable,
  };
}
