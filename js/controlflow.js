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

function reversePostOrder(succ, entry, allowed = null) {
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

/**
 * @param {number[][]} successors internal CFG successor indices
 * @param {number} entry entry node index
 */
export function analyzeGraph(successors, entry = 0) {
  const succ = normalizedSuccessors(successors || []);
  const predecessors = predecessorsOf(succ);
  const reachable = reachableFrom(succ, entry);
  const { idom: immediateDominators } = immediateDominatorsOf(succ, predecessors, reachable, entry);
  const dominators = dominanceViews(immediateDominators, reachable);
  const { components, componentOf } = strongComponents(succ, predecessors, reachable);
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
    immediateDominators,
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
