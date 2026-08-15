/*
 * agent/tools.js — deterministic analysis tools for LLMs and the local planner.
 *
 * Tools discover and prove; model prose is never evidence. Every semantic result
 * is backed by Semantic IR fact/instruction IDs where available.
 */
import { irFor, OP } from '../ir.js';
import { semanticFacts, FACT, semanticEvidenceIds } from '../semantic.js';
import { createFunctionSummaryCache } from '../interproc.js';
import { sliceResult, minimalCausalPath, functionPaths } from '../query/causal.js';
import { symbolicExecute } from '../symbolic/executor.js';

function asAddress(v) {
  if (v == null) return null;
  try { return typeof v === 'bigint' ? v : BigInt(v); } catch { return null; }
}
function textOf(v) { return String(v == null ? '' : v).toLowerCase(); }
function explicitLimit(value, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}
function bounded(value, fallback, min, max) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

class FunctionLoader {
  constructor(ctx, maxEntries, maxFunctions) {
    this.ctx = ctx;
    this.maxEntries = Math.max(8, maxEntries || 64);
    this.maxFunctions = explicitLimit(maxFunctions, 64);
    this.cache = new Map();
    this.analyzed = new Set();
  }
  _put(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
  }
  async get(address) {
    const addr = asAddress(address);
    if (addr == null || typeof this.ctx.analyze !== 'function') return null;
    const key = addr.toString();
    if (this.cache.has(key)) {
      const hit = this.cache.get(key); this._put(key, hit); return hit;
    }
    if (!this.analyzed.has(key)) {
      if (this.analyzed.size >= this.maxFunctions) throw new Error('function-budget');
      this.analyzed.add(key);
    }
    let range = null;
    try { range = this.ctx.program && this.ctx.program.functionRange ? this.ctx.program.functionRange(addr) : null; } catch { range = null; }
    const model = await this.ctx.analyze(addr, range && range.end);
    this._put(key, model || null);
    return model || null;
  }
  analysisCount() { return this.analyzed.size; }
}

function nameFor(ctx, addr) {
  if (addr == null) return null;
  try {
    if (typeof ctx.functionName === 'function') return ctx.functionName(addr) || null;
    if (ctx.symbols && typeof ctx.symbols.nameAt === 'function') return ctx.symbols.nameAt(addr) || null;
    if (ctx.symbols && typeof ctx.symbols.symbolAt === 'function') {
      const s = ctx.symbols.symbolAt(addr); return s && (s.name || s.label) || null;
    }
  } catch { /* no name */ }
  return null;
}

export function compactFact(f) {
  return {
    id: f.id,
    kind: f.kind,
    address: f.address,
    row: f.row,
    function: f.function,
    relation: f.relation,
    location: f.location || null,
    operation: f.operation || null,
    threshold: f.threshold == null ? null : f.threshold,
    condition: f.condition || null,
    originalCondition: f.originalCondition || null,
    operator: f.operator || null,
    swapped: f.swapped === true,
    subject: f.subject || null,
    other: f.other || null,
    operands: f.operands || null,
    bound: f.bound || null,
    candidate: f.candidate || null,
    clampKind: f.clampKind || null,
    compare: f.compare || null,
    source: f.source || null,
    sink: f.sink || null,
    value: f.value || null,
    confidence: f.confidence,
    confidenceSource: f.confidenceSource,
    evidence: (f.evidence || []).map((e) => e.id).filter(Boolean),
  };
}

function matchesLocation(f, field) {
  const loc = f && f.location;
  if (!loc || field == null) return false;
  if (typeof field === 'string') return loc.key === field || textOf(loc.key).includes(textOf(field));
  if (typeof field === 'object') {
    if (field.key && loc.key !== field.key) return false;
    if (field.offset != null && loc.disp !== BigInt(field.offset)) return false;
    if (field.address != null && loc.address !== BigInt(field.address)) return false;
    return true;
  }
  try { return loc.disp != null && loc.disp === BigInt(field); } catch { return false; }
}

function functionCandidateAddresses(ctx, requested, limit) {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const a = asAddress(v && v.addr != null ? v.addr : v);
    if (a == null) return;
    const key = a.toString();
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key); out.push(a);
  };
  for (const v of requested || []) add(v);
  for (const v of ctx.candidateFunctions || []) add(v);
  return out;
}

function seedInstruction(ir, spec) {
  if (!ir || !ir.instructions) return null;
  if (spec && spec.instructionId != null) return ir.instructions.find((i) => i.id === Number(spec.instructionId)) || null;
  if (spec && spec.row != null) return ir.instructions.find((i) => i.row === Number(spec.row) && (!spec.op || i.op === spec.op)) || null;
  const address = spec && spec.address != null ? asAddress(spec.address) : asAddress(spec);
  if (address != null) return ir.instructions.find((i) => i.address === address) || null;
  if (spec && spec.kind === 'last-store') {
    const stores = ir.instructions.filter((i) => i.op === OP.STORE); return stores[stores.length - 1] || null;
  }
  return null;
}

export function createAgentTools(context, opts) {
  const ctx = context || {};
  const maxFunctions = explicitLimit(opts && opts.maxFunctions, 64);
  const loader = new FunctionLoader(ctx, Math.max(8, maxFunctions || 8), maxFunctions);
  const summaries = createFunctionSummaryCache({ ...ctx, analyze: (a) => loader.get(a) }, {
    maxEntries: bounded(opts && opts.summaryCache, 128, 16, 512),
    maxDepth: bounded(opts && opts.summaryDepth, 3, 0, 8),
  });

  const modelAndIr = async (address) => {
    const addr = asAddress(address);
    const model = await loader.get(addr);
    const ir = model ? irFor(model) : null;
    return { addr, model, ir };
  };

  const tools = {
    async search_strings(query, options) {
      const limit = bounded(options && options.limit, 50, 1, 200);
      if (typeof ctx.searchStrings === 'function') {
        const rows = await ctx.searchStrings(query, { ...(options || {}), limit });
        return { tool: 'search_strings', results: (rows || []).slice(0, limit) };
      }
      if (ctx.strings && typeof ctx.strings.search === 'function') {
        const rows = await ctx.strings.search(query, limit);
        return { tool: 'search_strings', results: (rows || []).slice(0, limit) };
      }
      const list = Array.isArray(ctx.strings) ? ctx.strings : [];
      const q = textOf(query);
      const results = list.filter((s) => textOf(s && (s.text != null ? s.text : s)).includes(q)).slice(0, limit)
        .map((s) => typeof s === 'string' ? { text: s } : s);
      return { tool: 'search_strings', results };
    },

    async search_functions(query, options) {
      // Searching an index is cheap and does not consume the function-analysis
      // budget; only loading/analyzing a candidate does.
      const limit = bounded(options && options.limit, 40, 1, 200);
      if (typeof ctx.searchFunctions === 'function') {
        const rows = await ctx.searchFunctions(query, { ...(options || {}), limit });
        return { tool: 'search_functions', results: (rows || []).slice(0, limit) };
      }
      const q = textOf(query);
      const source = Array.isArray(ctx.functions) ? ctx.functions : [];
      const results = source.filter((f) => textOf(f && (f.name || f.label || '')).includes(q)).slice(0, limit);
      return { tool: 'search_functions', results };
    },

    async get_function(address) {
      const { addr, model, ir } = await modelAndIr(address);
      if (!model || !ir) return { tool: 'get_function', address: addr, found: false };
      const summary = await summaries.summaryFor(addr);
      const facts = semanticFacts(ir);
      return {
        tool: 'get_function', address: addr, name: nameFor(ctx, addr), found: true,
        instructions: ir.instructions.length, truncated: !!ir.truncated, summary,
        evidence: semanticEvidenceIds(facts), engine: 'semantic-ir',
      };
    },

    async get_callers(address, options) {
      const addr = asAddress(address); const limit = bounded(options && options.limit, 100, 1, 500);
      let rows = [];
      try { rows = ctx.program && ctx.program.callersOf ? ctx.program.callersOf(addr, limit) : []; } catch { rows = []; }
      return { tool: 'get_callers', address: addr, results: (rows || []).slice(0, limit).map((r) => ({ ...r, name: nameFor(ctx, r.addr) })) };
    },

    async get_callees(address, options) {
      const addr = asAddress(address); const limit = bounded(options && options.limit, 100, 1, 500);
      let range = null, rows = [];
      try { range = ctx.program && ctx.program.functionRange ? ctx.program.functionRange(addr) : null; } catch { range = null; }
      try { rows = ctx.program && ctx.program.calleesOf ? ctx.program.calleesOf(addr, range && range.end, limit) : []; } catch { rows = []; }
      return { tool: 'get_callees', address: addr, results: (rows || []).slice(0, limit).map((r) => ({ ...r, name: nameFor(ctx, r.addr) })) };
    },

    async get_xrefs(address, options) {
      const addr = asAddress(address); const span = asAddress(options && options.span) || 1n;
      const limit = bounded(options && options.limit, 200, 1, 1000);
      let sites = [], functions = [];
      try { sites = ctx.program && ctx.program.refSitesTo ? ctx.program.refSitesTo(addr, span, limit) : []; } catch { sites = []; }
      try { functions = ctx.program && ctx.program.functionsReferencing ? ctx.program.functionsReferencing(addr, span, limit) : []; } catch { functions = []; }
      return { tool: 'get_xrefs', address: addr, sites: (sites || []).slice(0, limit), functions: (functions || []).slice(0, limit) };
    },

    async slice_backward(functionAddress, seed, options) {
      const { addr, ir } = await modelAndIr(functionAddress);
      if (!ir) return { tool: 'slice_backward', address: addr, nodes: [] };
      const inst = seedInstruction(ir, seed);
      const result = sliceResult(ir, inst, 'backward', { ...(options || {}), limit: bounded(options && options.limit, 400, 1, 2000), function: addr });
      return { tool: 'slice_backward', address: addr, seed: inst && inst.id, ...result };
    },

    async slice_forward(functionAddress, seed, options) {
      const { addr, ir } = await modelAndIr(functionAddress);
      if (!ir) return { tool: 'slice_forward', address: addr, nodes: [] };
      const inst = seedInstruction(ir, seed);
      const result = sliceResult(ir, inst, 'forward', { ...(options || {}), limit: bounded(options && options.limit, 400, 1, 2000), function: addr });
      return { tool: 'slice_forward', address: addr, seed: inst && inst.id, ...result };
    },

    async find_field_writers(functionAddress, field) {
      const { addr, ir } = await modelAndIr(functionAddress);
      const facts = ir ? semanticFacts(ir).filter((f) => (f.kind === FACT.WRITE || f.kind === FACT.RMW) && matchesLocation(f, field)) : [];
      return { tool: 'find_field_writers', address: addr, results: facts.map(compactFact), evidence: semanticEvidenceIds(facts) };
    },

    async find_field_readers(functionAddress, field) {
      const { addr, ir } = await modelAndIr(functionAddress);
      const facts = ir ? semanticFacts(ir).filter((f) => f.kind === FACT.READ && matchesLocation(f, field)) : [];
      return { tool: 'find_field_readers', address: addr, results: facts.map(compactFact), evidence: semanticEvidenceIds(facts) };
    },

    async find_constant(value, options) {
      const want = BigInt(value);
      const addresses = functionCandidateAddresses(ctx, options && options.functions, maxFunctions);
      const resultLimit = bounded(options && options.limit, 100, 1, 1000);
      const results = [];
      for (const addr of addresses) {
        const { ir } = await modelAndIr(addr); if (!ir) continue;
        for (const v of ir.values || []) {
          if (v.const !== want || !v.def) continue;
          results.push({ function: addr, address: v.def.address, row: v.def.row, value: want, instructionId: v.def.id, evidence: ['ir:' + v.def.id] });
          if (results.length >= resultLimit) break;
        }
        if (results.length >= resultLimit) break;
      }
      return { tool: 'find_constant', value: want, results, scopedFunctions: addresses.length, requiresScope: addresses.length === 0 };
    },

    async find_thresholds(functionAddress, options) {
      const { addr, ir } = await modelAndIr(functionAddress);
      let facts = ir ? semanticFacts(ir).filter((f) => f.kind === FACT.THRESHOLD) : [];
      if (options && options.value != null) facts = facts.filter((f) => f.threshold === BigInt(options.value));
      facts = facts.slice(0, bounded(options && options.limit, 300, 1, 1000));
      return { tool: 'find_thresholds', address: addr, results: facts.map(compactFact), evidence: semanticEvidenceIds(facts) };
    },

    async find_paths(from, to, options) {
      const safe = {
        maxDepth: bounded(options && options.maxDepth, 6, 1, 12),
        maxPaths: bounded(options && options.maxPaths, 8, 1, 32),
        maxVisited: bounded(options && options.maxVisited, 10000, 16, 20000),
      };
      const paths = functionPaths(ctx.program, asAddress(from), asAddress(to), safe);
      return { tool: 'find_paths', from: asAddress(from), to: asAddress(to), paths };
    },

    async get_semantic_facts(functionAddress, options) {
      const { addr, ir } = await modelAndIr(functionAddress);
      let facts = ir ? semanticFacts(ir) : [];
      if (options && options.kinds && options.kinds.length) {
        const kinds = new Set(options.kinds); facts = facts.filter((f) => kinds.has(f.kind));
      }
      const limit = bounded(options && options.limit, 300, 1, 1000);
      facts = facts.slice(0, limit);
      return { tool: 'get_semantic_facts', address: addr, results: facts.map(compactFact), evidence: semanticEvidenceIds(facts), engine: ir ? 'semantic-ir' : null };
    },

    async verify_field_update(functionAddress, field, options) {
      const { addr, ir } = await modelAndIr(functionAddress);
      const facts = ir ? semanticFacts(ir).filter((f) => f.kind === FACT.RMW && matchesLocation(f, field)) : [];
      const paths = [];
      const limit = bounded(options && options.limit, 8, 1, 32);
      const pathLimit = bounded(options && options.pathLimit, 8, 2, 32);
      for (const f of facts.slice(0, limit)) {
        const seed = ir.instructions.find((i) => i.row === f.row && i.op === OP.STORE);
        paths.push(minimalCausalPath(ir, seed, { function: addr, limit: pathLimit }));
      }
      return {
        tool: 'verify_field_update', address: addr, verified: facts.length > 0,
        updates: facts.slice(0, limit).map(compactFact), causalPaths: paths,
        evidence: semanticEvidenceIds(facts.slice(0, limit)), engine: 'semantic-ir',
      };
    },

    async explain_evidence(evidenceIds, options) {
      if (typeof ctx.explainEvidence === 'function') return ctx.explainEvidence(evidenceIds, options);
      const ids = new Set(Array.isArray(evidenceIds) ? evidenceIds : [evidenceIds]);
      const addresses = functionCandidateAddresses(ctx, options && options.functions, maxFunctions);
      const resultLimit = bounded(options && options.limit, 200, 1, 1000);
      const results = [];
      for (const addr of addresses) {
        const { ir } = await modelAndIr(addr); if (!ir) continue;
        for (const f of semanticFacts(ir)) {
          const hits = (f.evidence || []).filter((e) => ids.has(e.id));
          if (hits.length) results.push({ function: addr, fact: compactFact(f), evidence: hits });
          if (results.length >= resultLimit) break;
        }
        if (results.length >= resultLimit) break;
      }
      return { tool: 'explain_evidence', results, unresolved: Array.from(ids).filter((id) => !results.some((r) => r.evidence.some((e) => e.id === id))) };
    },

    async symbolic_execute(functionAddress, options) {
      const { addr, ir } = await modelAndIr(functionAddress);
      const safe = {
        ...(options || {}),
        maxPaths: bounded(options && options.maxPaths, 16, 1, 32),
        maxSteps: bounded(options && options.maxSteps, 2000, 8, 5000),
        maxBranches: bounded(options && options.maxBranches, 32, 1, 64),
        maxBlockVisits: bounded(options && options.maxBlockVisits, 3, 1, 8),
        timeoutMs: bounded(options && options.timeoutMs, 250, 10, 1000),
      };
      return { tool: 'symbolic_execute', address: addr, ...(ir ? symbolicExecute(ir, safe) : { paths: [], truncated: false, engine: null }) };
    },
  };

  if (typeof ctx.decompile === 'function') tools.decompile = async (...args) => ({ tool: 'decompile', result: await ctx.decompile(...args) });
  if (typeof ctx.resolveType === 'function') tools.resolve_type = async (...args) => ({ tool: 'resolve_type', result: await ctx.resolveType(...args) });
  if (typeof ctx.emulate === 'function') tools.emulate = async (...args) => ({ tool: 'emulate', result: await ctx.emulate(...args) });

  Object.defineProperty(tools, '__loader', { value: loader, enumerable: false });
  Object.defineProperty(tools, '__summaries', { value: summaries, enumerable: false });
  return tools;
}

export const DETERMINISTIC_TOOL_NAMES = Object.freeze([
  'search_strings', 'search_functions', 'get_function', 'get_callers', 'get_callees', 'get_xrefs',
  'slice_backward', 'slice_forward', 'find_field_writers', 'find_field_readers', 'find_constant',
  'find_thresholds', 'find_paths', 'get_semantic_facts', 'verify_field_update', 'explain_evidence',
  'decompile', 'resolve_type', 'emulate', 'symbolic_execute',
]);
