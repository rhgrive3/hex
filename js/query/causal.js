/*
 * query/causal.js — compact causal paths over SSA / Memory SSA slices.
 */
import { backwardSlice, forwardSlice, causalChain } from '../slice.js';
import { semanticFacts, semanticEvidenceIds } from '../semantic.js';
import { valueInfo } from '../ir.js';

function evidenceAt(facts, row) {
  return semanticEvidenceIds(facts.filter((f) => f.row === row));
}

function nodeOf(step, index, ir, facts, fn) {
  const value = step && step.value ? valueInfo(step.value) : null;
  return {
    id: 'causal:' + index + ':' + String(step && step.row),
    address: step && step.address != null ? step.address : null,
    function: fn != null ? fn : (ir.startAddress != null ? ir.startAddress : null),
    row: step && step.row != null ? step.row : null,
    kind: step && step.kind || 'unknown',
    value,
    relation: index === 0 ? 'source' : 'flows-to',
    evidence: evidenceAt(facts, step && step.row),
    confidence: 1,
    confidenceSource: 'semantic-ir',
    detail: step ? {
      op: step.op || step.sub || null,
      target: step.target == null ? null : step.target,
      location: step.location || null,
      slot: step.slot || null,
    } : null,
  };
}

/** Minimal human-sized causal path for one SSA/Memory-SSA seed. */
export function minimalCausalPath(ir, seed, opts) {
  if (!ir || !seed) return { nodes: [], edges: [], truncated: false, elided: 0, engine: 'semantic-ir' };
  const limit = Math.max(2, opts && opts.limit || 8);
  const chain = causalChain(ir, seed, { ...(opts || {}), limit });
  const facts = semanticFacts(ir);
  const fn = opts && opts.function != null ? opts.function : ir.startAddress;
  const nodes = chain.steps.map((step, i) => nodeOf(step, i, ir, facts, fn));
  const edges = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ from: nodes[i - 1].id, to: nodes[i].id, relation: nodes[i].relation, confidenceSource: 'semantic-ir' });
  }
  return {
    nodes,
    edges,
    source: nodes[0] || null,
    sink: nodes[nodes.length - 1] || null,
    truncated: !!chain.truncated,
    elided: chain.elided || 0,
    engine: 'semantic-ir',
  };
}

export function sliceResult(ir, seed, direction, opts) {
  if (!ir || !seed) return { nodes: [], truncated: false, engine: 'semantic-ir' };
  const result = direction === 'forward' ? forwardSlice(ir, seed, opts) : backwardSlice(ir, seed, opts);
  const facts = semanticFacts(ir);
  const fn = opts && opts.function != null ? opts.function : ir.startAddress;
  const nodes = (result.instructions || []).map((inst, index) => ({
    id: 'slice:' + inst.id,
    instructionId: inst.id,
    address: inst.address == null ? null : inst.address,
    function: fn == null ? null : fn,
    row: inst.row,
    op: inst.op,
    sub: inst.sub || null,
    evidence: evidenceAt(facts, inst.row),
    relation: direction === 'forward' ? 'use' : 'dependency',
    confidence: 1,
    confidenceSource: 'semantic-ir',
    order: index,
  }));
  return { nodes, truncated: !!result.truncated, engine: 'semantic-ir' };
}

/** Bounded call-graph path using ProgramIndex without forcing function analysis. */
export function functionPaths(program, from, to, opts) {
  const maxDepth = Math.max(1, opts && opts.maxDepth || 6);
  const maxPaths = Math.max(1, opts && opts.maxPaths || 8);
  const maxVisited = Math.max(16, opts && opts.maxVisited || 10000);
  if (!program || from == null || to == null) return [];
  const q = [[from]];
  const out = [];
  const seen = new Set();
  let visited = 0;
  while (q.length && out.length < maxPaths && visited++ < maxVisited) {
    const path = q.shift();
    const head = path[path.length - 1];
    if (head === to) { out.push(path); continue; }
    if (path.length >= maxDepth) continue;
    const stateKey = head.toString() + ':' + path.length;
    if (seen.has(stateKey)) continue;
    seen.add(stateKey);
    let range = null;
    try { range = program.functionRange(head); } catch { range = null; }
    let callees = [];
    try { callees = program.calleesOf(head, range && range.end, 200) || []; } catch { callees = []; }
    for (const c of callees) {
      const addr = c && c.addr != null ? c.addr : c;
      if (addr == null || path.some((p) => p === addr)) continue;
      q.push(path.concat([addr]));
    }
  }
  return out.sort((a, b) => a.length - b.length);
}
