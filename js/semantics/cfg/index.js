import { deepFreeze, jsonSafe, stableStringify } from '../../core/identity/index.js';

export const SEMANTIC_CFG_CONTRACT_VERSION = '2.0.0';
export const SEMANTIC_CFG_EDGE_KINDS = Object.freeze([
  'fallthrough',
  'branch',
  'conditional-true',
  'conditional-false',
  'switch-case',
  'call',
  'tail-call',
  'return',
  'exception',
  'indirect-candidate',
  'unknown',
]);
export const SEMANTIC_CFG_DEFAULT_BUDGET = Object.freeze({
  maxBlocks: 16384,
  maxEdges: 131072,
  maxWorkItems: 4194304,
});

const EDGE_SET = new Set(SEMANTIC_CFG_EDGE_KINDS);

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function assertAllowedKeys(input, allowed, code) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${code}:${key}`);
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-cfg-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function limit(options, key) {
  if (options?.budget?.[key] == null) return SEMANTIC_CFG_DEFAULT_BUDGET[key];
  return positiveInteger(options.budget[key], `semantic-cfg-invalid-budget-${key}`);
}
function workCounter(options) {
  let used = 0;
  const maximum = limit(options, 'maxWorkItems');
  return () => {
    assertNotAborted(options);
    if (++used > maximum) fail('semantic-cfg-budget-exceeded-maxWorkItems');
  };
}

function normalizeEdge(input) {
  input = object(input, 'semantic-cfg-invalid-edge');
  assertAllowedKeys(input, new Set(['to', 'kind', 'metadata']), 'semantic-cfg-unexpected-edge-field');
  const to = nonEmpty(input.to, 'semantic-cfg-edge-target-required');
  const kind = nonEmpty(input.kind, 'semantic-cfg-edge-kind-required');
  if (!EDGE_SET.has(kind)) fail('semantic-cfg-invalid-edge-kind');
  const out = { to, kind };
  if (input.metadata != null) out.metadata = jsonSafe(input.metadata);
  return out;
}

function edgeKey(edge) {
  return `${edge.to}\u0000${edge.kind}\u0000${stableStringify(edge.metadata ?? null)}`;
}

function normalizePredecessors(input) {
  if (input == null) return null;
  const values = array(input, 'semantic-cfg-invalid-predecessors').map((value) => {
    if (typeof value === 'string') return nonEmpty(value, 'semantic-cfg-invalid-predecessor');
    const item = object(value, 'semantic-cfg-invalid-predecessor');
    assertAllowedKeys(item, new Set(['from', 'id']), 'semantic-cfg-unexpected-predecessor-field');
    return nonEmpty(item.from ?? item.id, 'semantic-cfg-invalid-predecessor');
  });
  if (new Set(values).size !== values.length) fail('semantic-cfg-duplicate-predecessor');
  return values.sort();
}

function normalizeBlock(input) {
  input = object(input, 'semantic-cfg-invalid-block');
  assertAllowedKeys(input, new Set(['id', 'successors', 'predecessors']), 'semantic-cfg-unexpected-block-field');
  const successors = array(input.successors ?? [], 'semantic-cfg-invalid-successors')
    .map(normalizeEdge)
    .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const keys = successors.map(edgeKey);
  if (new Set(keys).size !== keys.length) fail('semantic-cfg-duplicate-edge');
  return {
    id: nonEmpty(input.id, 'semantic-cfg-block-id-required'),
    successors,
    declaredPredecessors: normalizePredecessors(input.predecessors),
  };
}

function cfgIndex(cfg) {
  return new Map(cfg.blocks.map((block) => [block.id, block]));
}

export function createSemanticCfg(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'semantic-cfg-invalid-graph');
  assertAllowedKeys(input, new Set(['contractVersion', 'functionId', 'entryBlockId', 'blocks']), 'semantic-cfg-unexpected-graph-field');
  if (input.contractVersion != null && String(input.contractVersion) !== SEMANTIC_CFG_CONTRACT_VERSION) {
    fail('semantic-cfg-contract-version-mismatch');
  }

  const rawBlocks = array(input.blocks, 'semantic-cfg-blocks-required');
  if (rawBlocks.length > limit(options, 'maxBlocks')) fail('semantic-cfg-budget-exceeded-maxBlocks');
  const blocks = rawBlocks.map(normalizeBlock).sort((a, b) => a.id.localeCompare(b.id));
  const blockById = new Map();
  for (const block of blocks) {
    assertNotAborted(options);
    if (blockById.has(block.id)) fail('semantic-cfg-duplicate-block-id');
    blockById.set(block.id, block);
  }

  const entryBlockId = nonEmpty(input.entryBlockId, 'semantic-cfg-entry-block-required');
  if (!blockById.has(entryBlockId)) fail('semantic-cfg-invalid-entry-block');
  let edgeCount = 0;
  const predecessorSets = new Map(blocks.map((block) => [block.id, new Set()]));
  for (const block of blocks) {
    for (const edge of block.successors) {
      if (++edgeCount > limit(options, 'maxEdges')) fail('semantic-cfg-budget-exceeded-maxEdges');
      if (!blockById.has(edge.to)) fail('semantic-cfg-invalid-successor');
      predecessorSets.get(edge.to).add(block.id);
    }
  }

  const normalizedBlocks = blocks.map((block) => {
    const predecessors = [...predecessorSets.get(block.id)].sort();
    if (block.declaredPredecessors != null
      && stableStringify(block.declaredPredecessors) !== stableStringify(predecessors)) {
      fail('semantic-cfg-predecessor-mismatch');
    }
    return deepFreeze({ id: block.id, predecessors, successors: block.successors });
  });

  return deepFreeze({
    contractVersion: SEMANTIC_CFG_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'semantic-cfg-function-id-required'),
    entryBlockId,
    blocks: normalizedBlocks,
  });
}

export function successorsOf(cfg, blockId) {
  const block = cfgIndex(cfg).get(String(blockId));
  return block ? block.successors.map((edge) => edge.to) : [];
}

export function predecessorsOf(cfg, blockId) {
  const block = cfgIndex(cfg).get(String(blockId));
  return block ? block.predecessors.slice() : [];
}

export function reachableBlocks(cfg, startBlockId = cfg.entryBlockId, options = {}) {
  assertNotAborted(options);
  const byId = cfgIndex(cfg);
  const start = String(startBlockId);
  if (!byId.has(start)) fail('semantic-cfg-invalid-reachability-start');
  const tick = workCounter(options);
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    tick();
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const next = byId.get(id).successors.map((edge) => edge.to).slice().sort().reverse();
    for (const target of next) if (!seen.has(target)) stack.push(target);
  }
  return Object.freeze([...seen].sort());
}

function reversePostOrder(cfg, options = {}) {
  const byId = cfgIndex(cfg);
  const tick = workCounter(options);
  const seen = new Set([cfg.entryBlockId]);
  const post = [];
  const stack = [{
    id: cfg.entryBlockId,
    next: 0,
    successors: byId.get(cfg.entryBlockId).successors.map((edge) => edge.to).slice().sort(),
  }];
  while (stack.length) {
    tick();
    const frame = stack[stack.length - 1];
    if (frame.next < frame.successors.length) {
      const target = frame.successors[frame.next++];
      if (seen.has(target)) continue;
      seen.add(target);
      stack.push({
        id: target,
        next: 0,
        successors: byId.get(target).successors.map((edge) => edge.to).slice().sort(),
      });
      continue;
    }
    post.push(frame.id);
    stack.pop();
  }
  return post.reverse();
}

export function deterministicTraversal(cfg, options = {}) {
  const rpo = reversePostOrder(cfg, options);
  const seen = new Set(rpo);
  const unreachable = cfg.blocks.map((block) => block.id).filter((id) => !seen.has(id)).sort();
  return Object.freeze(options.includeUnreachable === false ? rpo : [...rpo, ...unreachable]);
}

function setIntersection(sets) {
  if (!sets.length) return new Set();
  const out = new Set(sets[0]);
  for (const value of [...out]) {
    if (!sets.every((set) => set.has(value))) out.delete(value);
  }
  return out;
}

export function analyzeSemanticDominance(cfg, options = {}) {
  assertNotAborted(options);
  const tick = workCounter(options);
  const byId = cfgIndex(cfg);
  const reachable = new Set(reachableBlocks(cfg, cfg.entryBlockId, options));
  const rpo = reversePostOrder(cfg, options);
  const allReachable = new Set(rpo);
  const dom = new Map();
  for (const block of cfg.blocks) {
    dom.set(block.id, reachable.has(block.id) ? new Set(allReachable) : new Set([block.id]));
  }
  dom.set(cfg.entryBlockId, new Set([cfg.entryBlockId]));

  let changed = true;
  let rounds = 0;
  while (changed) {
    tick();
    if (++rounds > cfg.blocks.length * 2 + 4) fail('semantic-cfg-dominance-did-not-converge');
    changed = false;
    for (const id of rpo) {
      tick();
      if (id === cfg.entryBlockId) continue;
      const predecessors = byId.get(id).predecessors.filter((pred) => reachable.has(pred));
      const next = setIntersection(predecessors.map((pred) => dom.get(pred)));
      next.add(id);
      const prior = dom.get(id);
      if (next.size !== prior.size || [...next].some((value) => !prior.has(value))) {
        dom.set(id, next);
        changed = true;
      }
    }
  }

  const idom = new Map();
  for (const block of cfg.blocks) {
    const id = block.id;
    if (!reachable.has(id) || id === cfg.entryBlockId) {
      idom.set(id, null);
      continue;
    }
    const strict = [...dom.get(id)].filter((candidate) => candidate !== id);
    strict.sort((a, b) => dom.get(b).size - dom.get(a).size || a.localeCompare(b));
    idom.set(id, strict[0] ?? null);
  }

  const frontier = new Map(cfg.blocks.map((block) => [block.id, new Set()]));
  for (const block of cfg.blocks) {
    if (!reachable.has(block.id)) continue;
    const predecessors = block.predecessors.filter((pred) => reachable.has(pred));
    if (predecessors.length < 2) continue;
    for (const pred of predecessors) {
      let runner = pred;
      let guard = cfg.blocks.length + 2;
      while (runner != null && runner !== idom.get(block.id) && guard-- > 0) {
        tick();
        frontier.get(runner).add(block.id);
        runner = idom.get(runner);
      }
      if (guard <= 0) fail('semantic-cfg-invalid-dominator-chain');
    }
  }

  const dominators = {};
  const immediateDominators = {};
  const dominanceFrontier = {};
  for (const block of cfg.blocks) {
    dominators[block.id] = [...dom.get(block.id)].sort();
    immediateDominators[block.id] = idom.get(block.id);
    dominanceFrontier[block.id] = [...frontier.get(block.id)].sort();
  }
  return deepFreeze({
    reachable: [...reachable].sort(),
    reversePostOrder: rpo,
    dominators,
    immediateDominators,
    dominanceFrontier,
  });
}
