import { createMatchBudget } from './match-budget.js';

function candidateComponents(candidates) {
  const left = new Map(), right = new Map();
  for (const c of candidates) {
    let a = left.get(c.i); if (!a) left.set(c.i, a = []); a.push(c);
    let b = right.get(c.j); if (!b) right.set(c.j, b = []); b.push(c);
  }
  const seenLeft = new Set(), seenRight = new Set(), components = [];
  for (const start of [...left.keys()].sort((a,b)=>a-b)) {
    if (seenLeft.has(start)) continue;
    const queue = [{ side:'left', id:start }], edges = new Set();
    seenLeft.add(start);
    for (let q = 0; q < queue.length; q++) {
      const node = queue[q];
      const list = node.side === 'left' ? left.get(node.id) || [] : right.get(node.id) || [];
      for (const c of list) {
        edges.add(c);
        if (!seenLeft.has(c.i)) { seenLeft.add(c.i); queue.push({ side:'left', id:c.i }); }
        if (!seenRight.has(c.j)) { seenRight.add(c.j); queue.push({ side:'right', id:c.j }); }
      }
    }
    components.push([...edges].sort((a,b)=>a.i-b.i || a.j-b.j));
  }
  return components;
}

function componentShape(candidates) {
  const left = new Set(), right = new Set();
  for (const c of candidates) { left.add(c.i); right.add(c.j); }
  return { left, right, nodes:left.size + right.size, edges:candidates.length };
}

function maximumWeightComponent(candidates, budget) {
  const leftIds = [...new Set(candidates.map((c)=>c.i))].sort((a,b)=>a-b);
  const rightIds = [...new Set(candidates.map((c)=>c.j))].sort((a,b)=>a-b);
  const leftIndex = new Map(leftIds.map((id,k)=>[id,k]));
  const rightIndex = new Map(rightIds.map((id,k)=>[id,k]));
  const source = 0, leftBase = 1, rightBase = leftBase + leftIds.length, sink = rightBase + rightIds.length;
  const graph = Array.from({length:sink+1},()=>[]);
  const addEdge = (from,to,capacity,cost,candidate=null) => {
    const forward = { to, rev:graph[to].length, capacity, cost, candidate };
    const reverse = { to:from, rev:graph[from].length, capacity:0, cost:-cost, candidate:null };
    graph[from].push(forward); graph[to].push(reverse);
    return forward;
  };
  for (let k=0;k<leftIds.length;k++) addEdge(source,leftBase+k,1,0);
  for (let k=0;k<rightIds.length;k++) addEdge(rightBase+k,sink,1,0);
  const candidateEdges = [];
  for (const c of candidates) candidateEdges.push(addEdge(leftBase+leftIndex.get(c.i),rightBase+rightIndex.get(c.j),1,-Number(c.confidence),c));

  const EPS = 1e-12;
  while (true) {
    const dist = Array(graph.length).fill(Infinity);
    const prevNode = Array(graph.length).fill(-1), prevEdge = Array(graph.length).fill(-1), inQueue = Array(graph.length).fill(false);
    const queue = [source]; dist[source]=0; inQueue[source]=true;
    for (let head=0; head<queue.length; head++) {
      const u=queue[head]; inQueue[u]=false;
      for (let ei=0; ei<graph[u].length; ei++) {
        if (!budget.solverRelaxation()) return { selected:[], truncated:true };
        const edge=graph[u][ei]; if (edge.capacity<=0) continue;
        const nd=dist[u]+edge.cost;
        if (nd + EPS < dist[edge.to]) {
          dist[edge.to]=nd; prevNode[edge.to]=u; prevEdge[edge.to]=ei;
          if (!inQueue[edge.to]) { inQueue[edge.to]=true; queue.push(edge.to); }
        }
      }
    }
    if (!Number.isFinite(dist[sink]) || dist[sink] >= -EPS) break;
    if (!budget.solverAugmentation()) return { selected:[], truncated:true };
    for (let v=sink; v!==source; v=prevNode[v]) {
      const u=prevNode[v], edge=graph[u][prevEdge[v]];
      edge.capacity--; graph[v][edge.rev].capacity++;
    }
  }
  return { selected:candidateEdges.filter((edge)=>edge.capacity===0).map((edge)=>edge.candidate), truncated:false };
}

export function solveCandidateMatching(candidates = [], budget = createMatchBudget()) {
  const selected = [], ambiguousLeft = new Set(), ambiguousRight = new Set(), truncatedComponents = [];
  const components = candidateComponents(candidates);
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    const shape = componentShape(component);
    const markAmbiguous = (reason) => {
      for (const id of shape.left) ambiguousLeft.add(id);
      for (const id of shape.right) ambiguousRight.add(id);
      truncatedComponents.push({ index, left:shape.left.size, right:shape.right.size, nodes:shape.nodes, edges:shape.edges, reason });
    };
    if (budget.truncated) { markAmbiguous(budget.reason || 'solver-budget'); continue; }
    if (!budget.allowComponent(shape.nodes, shape.edges)) {
      markAmbiguous(budget.truncated ? (budget.reason || 'solver-budget') : 'component-budget');
      continue;
    }
    const solved = maximumWeightComponent(component, budget);
    if (solved.truncated) { markAmbiguous(budget.reason || 'solver-budget'); continue; }
    selected.push(...solved.selected);
  }
  selected.sort((a,b)=>a.i-b.i || a.j-b.j);
  return { selected, ambiguousLeft, ambiguousRight, truncatedComponents, budget:budget.snapshot() };
}

export function maximumWeightCandidateMatchingBounded(candidates = [], options = {}) {
  const budget = options?.candidate ? options : createMatchBudget(options.matchBudget || options);
  return solveCandidateMatching(candidates, budget).selected;
}
