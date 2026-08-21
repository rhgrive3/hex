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

export class AgentToolError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'AgentToolError';
    this.code = code;
    this.details = details;
  }
}

function parseInteger(value, name = 'value', { nonNegative = false } = {}) {
  try {
    if (value == null || typeof value === 'boolean') throw new Error('missing');
    let out;
    if (typeof value === 'bigint') out = value;
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error('unsafe-number');
      out = BigInt(value);
    } else if (typeof value === 'string') {
      const text = value.trim();
      if (!text || !/^[+-]?(?:0[xX][0-9a-fA-F]+|\d+)$/.test(text)) throw new Error('invalid-string');
      out = BigInt(text);
    } else throw new Error('invalid-type');
    if (nonNegative && out < 0n) throw new Error('negative');
    return out;
  } catch {
    throw new AgentToolError('invalid-argument', `${name} must be ${nonNegative ? 'a non-negative ' : 'an '}integer`, { name, value });
  }
}

function asAddress(v) {
  if (v == null) return null;
  try { return parseInteger(v, 'address', { nonNegative: true }); } catch { return null; }
}
function requiredAddress(v, name = 'address') { return parseInteger(v, name, { nonNegative: true }); }
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
function nonNegativeOffset(value) {
  const n = Number(value || 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export function pageRows(value, limit, offset = 0) {
  const meta = !Array.isArray(value) && value && typeof value === 'object' ? value : {};
  const rows = Array.isArray(value) ? value : (Array.isArray(meta.results) ? meta.results : []);
  const start = nonNegativeOffset(offset);
  const reportedRaw = meta.offset ?? meta.pageOffset ?? meta.pagination?.offset;
  const reported = Number.isSafeInteger(Number(reportedRaw)) ? Number(reportedRaw) : null;
  let sourceStart;
  if (reported === start) {
    sourceStart = 0;
  } else if (reported != null && reported !== start) {
    const rel = start - reported;
    sourceStart = rel >= 0 && rel < rows.length ? rel : rows.length;
  } else if (start === 0) {
    sourceStart = 0;
  } else {
    sourceStart = rows.length > limit ? Math.min(start, rows.length) : 0;
  }
  const results = rows.slice(sourceStart, sourceStart + limit);
  const explicitTotal = Number.isFinite(Number(meta.total ?? meta.completeness?.total)) ? Number(meta.total ?? meta.completeness?.total) : null;
  const returned = results.length;
  let complete = meta.complete ?? meta.completeness?.complete;
  const upstreamTruncated = Boolean(meta.truncated) || complete === false;
  if (complete == null) {
    if (explicitTotal != null) complete = start + returned >= explicitTotal && !upstreamTruncated;
    else complete = rows.length < limit && !upstreamTruncated;
  }
  const total = explicitTotal ?? (complete ? start + returned : (rows.length > limit ? rows.length : null));
  let coverage = Number(meta.coverage ?? meta.completeness?.coverage);
  if (!Number.isFinite(coverage)) coverage = total ? Math.min(1, (start + returned) / total) : (complete ? 1 : null);
  const reason = meta.reason ?? meta.completeness?.reason ?? (complete ? null : 'result-limit');
  return {
    results, total, returned, offset: start, complete: Boolean(complete), truncated: !complete,
    coverage: Number.isFinite(coverage) ? Math.max(0, Math.min(1, coverage)) : null, reason,
    ...(meta.scanned != null ? { scanned: meta.scanned } : {}),
    ...(meta.scanTotal != null ? { scanTotal: meta.scanTotal } : {}),
    completeness: { complete: Boolean(complete), returned, total, coverage: Number.isFinite(coverage) ? Math.max(0, Math.min(1, coverage)) : null, reason },
  };
}

class FunctionLoader {
  constructor(ctx, maxEntries, maxFunctions) {
    this.ctx = ctx;
    this.maxEntries = Math.max(8, maxEntries || 64);
    this.maxFunctions = explicitLimit(maxFunctions, 64);
    this.cache = new Map();
    this.analyzed = new Set();
    this.inflight = new Map();
  }
  _put(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
  }
  async get(address) {
    const addr = requiredAddress(address);
    if (typeof this.ctx.analyze !== 'function') throw new AgentToolError('unsupported', 'function analysis is unavailable', { capability: 'analyze' });
    const key = addr.toString();
    if (this.cache.has(key)) {
      const hit = this.cache.get(key); this._put(key, hit); return hit;
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    if (!this.analyzed.has(key) && this.analyzed.size + this.inflight.size >= this.maxFunctions) {
      throw new AgentToolError('function-budget', 'function-budget: function analysis budget exhausted', { maxFunctions: this.maxFunctions });
    }
    const pending = (async () => {
      let range = null;
      if (this.ctx.program && typeof this.ctx.program.functionRange === 'function') {
        try { range = this.ctx.program.functionRange(addr); }
        catch (error) { throw new AgentToolError('tool-failed', 'functionRange failed', { method: 'functionRange', cause: String(error && error.message || error) }); }
      }
      const model = await this.ctx.analyze(addr, range && range.end);
      this.analyzed.add(key);
      this._put(key, model || null);
      return model || null;
    })();
    this.inflight.set(key, pending);
    try { return await pending; }
    finally { this.inflight.delete(key); }
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
  } catch {}
  return null;
}

export function compactFact(f) {
  return {
    id: f.id, kind: f.kind, address: f.address, row: f.row, function: f.function,
    relation: f.relation, location: f.location || null, operation: f.operation || null,
    threshold: f.threshold == null ? null : f.threshold, condition: f.condition || null,
    originalCondition: f.originalCondition || null, operator: f.operator || null, swapped: f.swapped === true,
    subject: f.subject || null, other: f.other || null, operands: f.operands || null, bound: f.bound || null,
    candidate: f.candidate || null, clampKind: f.clampKind || null, compare: f.compare || null,
    source: f.source || null, sink: f.sink || null, value: f.value ?? null,
    confidence: f.confidence, confidenceSource: f.confidenceSource,
    evidence: (f.evidence || []).map((e) => e.id).filter(Boolean),
  };
}

function normalizeLocationSpec(field) {
  if (field == null) throw new AgentToolError('invalid-argument', 'field/location is required');
  if (typeof field === 'string') {
    const key = field.trim();
    if (!key) throw new AgentToolError('invalid-argument', 'field key must not be empty');
    return { key };
  }
  if (typeof field === 'object') {
    const out = {};
    if (field.key != null) {
      out.key = String(field.key).trim();
      if (!out.key) throw new AgentToolError('invalid-argument', 'field key must not be empty');
    }
    if (field.offset != null) out.offset = parseInteger(field.offset, 'field.offset');
    if (field.address != null) out.address = requiredAddress(field.address, 'field.address');
    if (out.key == null && out.offset == null && out.address == null) throw new AgentToolError('invalid-argument', 'field object needs key, offset, or address');
    return out;
  }
  return { offset: parseInteger(field, 'field offset') };
}
function matchesLocation(f, normalized) {
  const loc = f && f.location;
  if (!loc) return false;
  if (normalized.key != null && loc.key !== normalized.key && !textOf(loc.key).includes(textOf(normalized.key))) return false;
  if (normalized.offset != null && loc.disp !== normalized.offset) return false;
  if (normalized.address != null && loc.address !== normalized.address) return false;
  return true;
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
  if (spec && spec.instructionId != null) {
    const id = Number(spec.instructionId);
    if (!Number.isSafeInteger(id) || id < 0) throw new AgentToolError('invalid-argument', 'instructionId must be a non-negative safe integer');
    return ir.instructions.find((i) => i.id === id) || null;
  }
  if (spec && spec.row != null) {
    const row = Number(spec.row);
    if (!Number.isSafeInteger(row) || row < 0) throw new AgentToolError('invalid-argument', 'row must be a non-negative safe integer');
    return ir.instructions.find((i) => i.row === row && (!spec.op || i.op === spec.op)) || null;
  }
  const address = spec && spec.address != null ? requiredAddress(spec.address) : asAddress(spec);
  if (address != null) return ir.instructions.find((i) => i.address === address) || null;
  if (spec && spec.kind === 'last-store') {
    const stores = ir.instructions.filter((i) => i.op === OP.STORE); return stores[stores.length - 1] || null;
  }
  return null;
}
function programQuery(ctx, method, args) {
  const fn = ctx.program && ctx.program[method];
  if (typeof fn !== 'function') return { supported: false, results: [] };
  try { return { supported: true, results: fn.apply(ctx.program, args) || [] }; }
  catch (error) { throw new AgentToolError('tool-failed', `${method} failed`, { method, cause: String(error && error.message || error) }); }
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
    const addr = requiredAddress(address);
    const model = await loader.get(addr);
    const ir = model ? irFor(model) : null;
    return { addr, model, ir };
  };

  const tools = {
    async search_strings(query, options) {
      const limit = bounded(options && options.limit, 50, 1, 200);
      const offset = nonNegativeOffset(options && options.offset);
      if (typeof ctx.searchStrings === 'function') {
        const value = await ctx.searchStrings(query, { ...(options || {}), limit, offset });
        return { tool: 'search_strings', ...pageRows(value, limit, offset), cost:{ functions:0, disassembly:0 } };
      }
      if (ctx.strings && typeof ctx.strings.search === 'function') {
        const value = await ctx.strings.search(query, limit, offset);
        return { tool: 'search_strings', ...pageRows(value, limit, offset), cost:{ functions:0, disassembly:0 } };
      }
      const list = Array.isArray(ctx.strings) ? ctx.strings : [];
      const q = textOf(query);
      const all = list.filter((s) => textOf(s && (s.text != null ? s.text : s)).includes(q)).map((s) => typeof s === 'string' ? { text: s } : s);
      const results = all.slice(offset, offset + limit);
      return { tool: 'search_strings', results, total: all.length, returned: results.length, offset, complete: offset + results.length >= all.length, truncated: offset + results.length < all.length, reason: offset + results.length < all.length ? 'result-limit' : null, coverage: all.length ? Math.min(1, (offset + results.length) / all.length) : 1, cost:{ functions:0, disassembly:0 } };
    },

    async search_functions(query, options) {
      const limit = bounded(options && options.limit, 40, 1, 200);
      const offset = nonNegativeOffset(options && options.offset);
      if (typeof ctx.searchFunctions === 'function') {
        const value = await ctx.searchFunctions(query, { ...(options || {}), limit, offset });
        return { tool: 'search_functions', ...pageRows(value, limit, offset), cost:{ functions:0, disassembly:0 } };
      }
      const q = textOf(query);
      const source = Array.isArray(ctx.functions) ? ctx.functions : [];
      const all = source.filter((f) => textOf(f && (f.name || f.label || '')).includes(q));
      const results = all.slice(offset, offset + limit);
      return { tool: 'search_functions', results, total: all.length, returned: results.length, offset, complete: offset + results.length >= all.length, truncated: offset + results.length < all.length, reason: offset + results.length < all.length ? 'result-limit' : null, coverage: all.length ? Math.min(1, (offset + results.length) / all.length) : 1, cost:{ functions:0, disassembly:0 } };
    },

    async get_function(address) {
      const { addr, model, ir } = await modelAndIr(address);
      if (!model || !ir) return { tool: 'get_function', address: addr, found: false, cost:{ functions:1, disassembly:0 } };
      const summary = await summaries.summaryFor(addr);
      const facts = semanticFacts(ir);
      return { tool: 'get_function', address: addr, name: nameFor(ctx, addr), found: true, instructions: ir.instructions.length, truncated: !!ir.truncated, summary, evidence: semanticEvidenceIds(facts), engine: 'semantic-ir', cost:{ functions:1, disassembly:ir.instructions.length } };
    },

    async get_callers(address, options) {
      const addr = requiredAddress(address); const limit = bounded(options && options.limit, 100, 1, 1000);
      const offset = bounded(options && options.offset, 0, 0, 1000000);
      const request = Math.min(1000000, offset + limit + 1);
      const q = programQuery(ctx, 'callersOf', [addr, request]);
      const raw = Array.isArray(q.results) ? q.results : [];
      const page = raw.slice(offset, offset + limit);
      const results = page.map((r) => ({ ...r, name: nameFor(ctx, r.addr ?? r.function ?? r.functionAddress) }));
      const complete = raw.length < request || offset + results.length >= raw.length;
      const total = raw.length < request ? raw.length : null;
      return { tool: 'get_callers', address: addr, supported:q.supported, results, offset, returned:results.length, total, complete, truncated:!complete, reason:complete ? null : 'result-limit', cost:{ functions:0, disassembly:0 } };
    },
    async get_callees(address, options) {
      const addr = requiredAddress(address); const limit = bounded(options && options.limit, 100, 1, 1000);
      const offset = bounded(options && options.offset, 0, 0, 1000000);
      let range = null;
      if (ctx.program && typeof ctx.program.functionRange === 'function') { const rq = programQuery(ctx, 'functionRange', [addr]); range = rq.results; }
      const request = Math.min(1000000, offset + limit + 1);
      const q = programQuery(ctx, 'calleesOf', [addr, range && range.end, request]);
      const raw = Array.isArray(q.results) ? q.results : [];
      const page = raw.slice(offset, offset + limit);
      const results = page.map((r) => ({ ...r, name: nameFor(ctx, r.addr ?? r.function ?? r.functionAddress) }));
      const complete = raw.length < request || offset + results.length >= raw.length;
      const total = raw.length < request ? raw.length : null;
      return { tool: 'get_callees', address: addr, supported:q.supported, results, offset, returned:results.length, total, complete, truncated:!complete, reason:complete ? null : 'result-limit', cost:{ functions:0, disassembly:0 } };
    },
    async get_xrefs(address, options) {
      const addr = requiredAddress(address); const span = options && options.span != null ? requiredAddress(options.span, 'span') : 1n;
      if (span < 1n) throw new AgentToolError('invalid-argument', 'span must be positive');
      const limit = bounded(options && options.limit, 200, 1, 1000);
      const offset = bounded(options && options.offset, 0, 0, 1000000);
      const request = Math.min(1000000, offset + limit + 1);
      const sites = programQuery(ctx, 'refSitesTo', [addr, span, request]);
      const functions = programQuery(ctx, 'functionsReferencing', [addr, span, request]);
      const rawSites = Array.isArray(sites.results) ? sites.results : [];
      const rawFunctions = Array.isArray(functions.results) ? functions.results : [];
      const siteRows = rawSites.slice(offset, offset + limit);
      const functionRows = rawFunctions.slice(offset, offset + limit);
      const sitesComplete = rawSites.length < request || offset + siteRows.length >= rawSites.length;
      const functionsComplete = rawFunctions.length < request || offset + functionRows.length >= rawFunctions.length;
      const complete = sitesComplete && functionsComplete;
      const siteTotal = rawSites.length < request ? rawSites.length : null;
      const functionTotal = rawFunctions.length < request ? rawFunctions.length : null;
      return { tool: 'get_xrefs', address: addr, supported:{sites:sites.supported,functions:functions.supported}, sites:siteRows, functions:functionRows, offset, returned:Math.max(siteRows.length, functionRows.length), total:siteTotal != null && functionTotal != null ? Math.max(siteTotal, functionTotal) : null, totals:{sites:siteTotal,functions:functionTotal}, complete, truncated:!complete, reason:complete ? null : 'result-limit', cost:{ functions:0, disassembly:0 } };
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
    async find_field_writers(functionAddress, field, options) {
      const normalized = normalizeLocationSpec(field);
      const { addr, ir } = await modelAndIr(functionAddress);
      const facts = ir ? semanticFacts(ir).filter((f) => (f.kind === FACT.WRITE || f.kind === FACT.RMW) && matchesLocation(f, normalized)) : [];
      const limit = bounded(options && options.limit, 100, 1, 1000); const offset = nonNegativeOffset(options && options.offset);
      const page = facts.slice(offset, offset + limit); const complete = offset + page.length >= facts.length;
      return { tool: 'find_field_writers', address: addr, results: page.map(compactFact), total:facts.length, returned:page.length, offset, complete, truncated:!complete, reason:complete ? null : 'result-limit', coverage:facts.length ? Math.min(1, (offset + page.length) / facts.length) : 1, evidence: semanticEvidenceIds(page) };
    },
    async find_field_readers(functionAddress, field, options) {
      const normalized = normalizeLocationSpec(field);
      const { addr, ir } = await modelAndIr(functionAddress);
      const facts = ir ? semanticFacts(ir).filter((f) => f.kind === FACT.READ && matchesLocation(f, normalized)) : [];
      const limit = bounded(options && options.limit, 100, 1, 1000); const offset = nonNegativeOffset(options && options.offset);
      const page = facts.slice(offset, offset + limit); const complete = offset + page.length >= facts.length;
      return { tool: 'find_field_readers', address: addr, results: page.map(compactFact), total:facts.length, returned:page.length, offset, complete, truncated:!complete, reason:complete ? null : 'result-limit', coverage:facts.length ? Math.min(1, (offset + page.length) / facts.length) : 1, evidence: semanticEvidenceIds(page) };
    },
    async find_constant(value, options) {
      const want = parseInteger(value, 'constant');
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
      const truncated = results.length >= resultLimit;
      return { tool: 'find_constant', value: want, results, returned:results.length, total:truncated ? null : results.length, complete:!truncated, truncated, reason:truncated ? 'result-limit' : null, scopedFunctions: addresses.length, requiresScope: addresses.length === 0 };
    },
    async find_thresholds(functionAddress, options) {
      const { addr, ir } = await modelAndIr(functionAddress);
      let facts = ir ? semanticFacts(ir).filter((f) => f.kind === FACT.THRESHOLD) : [];
      if (options && options.value != null) { const want = parseInteger(options.value, 'threshold'); facts = facts.filter((f) => f.threshold === want); }
      const total = facts.length; const limit = bounded(options && options.limit, 300, 1, 1000); const offset = nonNegativeOffset(options && options.offset); const page = facts.slice(offset, offset + limit);
      const complete = offset + page.length >= total;
      return { tool: 'find_thresholds', address: addr, results: page.map(compactFact), total, returned:page.length, offset, complete, truncated:!complete, reason:complete ? null : 'result-limit', coverage:total ? Math.min(1, (offset + page.length) / total) : 1, evidence: semanticEvidenceIds(page) };
    },
    async find_paths(from, to, options) {
      const fromAddress = requiredAddress(from, 'from'); const toAddress = requiredAddress(to, 'to');
      const safe = { maxDepth: bounded(options && options.maxDepth, 6, 1, 12), maxPaths: bounded(options && options.maxPaths, 8, 1, 32), maxVisited: bounded(options && options.maxVisited, 10000, 16, 20000) };
      const paths = functionPaths(ctx.program, fromAddress, toAddress, safe);
      return { tool: 'find_paths', from: fromAddress, to: toAddress, paths, returned:paths.length, total:paths.length, complete:paths.length < safe.maxPaths, truncated:paths.length >= safe.maxPaths, reason:paths.length >= safe.maxPaths ? 'path-limit' : null };
    },
    async get_semantic_facts(functionAddress, options) {
      const { addr, ir } = await modelAndIr(functionAddress);
      let facts = ir ? semanticFacts(ir) : [];
      if (options && options.kinds && options.kinds.length) { const kinds = new Set(options.kinds); facts = facts.filter((f) => kinds.has(f.kind)); }
      const total = facts.length; const limit = bounded(options && options.limit, 300, 1, 1000); const offset = nonNegativeOffset(options && options.offset);
      const page = facts.slice(offset, offset + limit);
      const complete = offset + page.length >= total;
      return { tool: 'get_semantic_facts', address: addr, results: page.map(compactFact), total, returned:page.length, offset, complete, truncated:!complete, reason:complete ? null : 'result-limit', coverage:total ? Math.min(1, (offset + page.length) / total) : 1, evidence: semanticEvidenceIds(page), engine: ir ? 'semantic-ir' : null };
    },
    async verify_field_update(functionAddress, field, options) {
      const normalized = normalizeLocationSpec(field);
      const { addr, ir } = await modelAndIr(functionAddress);
      const facts = ir ? semanticFacts(ir).filter((f) => f.kind === FACT.RMW && matchesLocation(f, normalized)) : [];
      const paths = [];
      const limit = bounded(options && options.limit, 8, 1, 32);
      const pathLimit = bounded(options && options.pathLimit, 8, 2, 32);
      for (const f of facts.slice(0, limit)) {
        const seed = ir.instructions.find((i) => i.row === f.row && i.op === OP.STORE);
        paths.push(minimalCausalPath(ir, seed, { function: addr, limit: pathLimit }));
      }
      const page = facts.slice(0, limit);
      return { tool: 'verify_field_update', address: addr, verified: facts.length > 0, updates: page.map(compactFact), causalPaths: paths, total:facts.length, returned:page.length, complete:page.length >= facts.length, truncated:page.length < facts.length, reason:page.length < facts.length ? 'result-limit' : null, evidence: semanticEvidenceIds(page), engine: 'semantic-ir' };
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
      const truncated = results.length >= resultLimit;
      return { tool: 'explain_evidence', results, returned:results.length, total:truncated ? null : results.length, complete:!truncated, truncated, reason:truncated ? 'result-limit' : null, unresolved: Array.from(ids).filter((id) => !results.some((r) => r.evidence.some((e) => e.id === id))) };
    },
    async symbolic_execute(functionAddress, options) {
      const { addr, ir } = await modelAndIr(functionAddress);
      const safe = { ...(options || {}), maxPaths: bounded(options && options.maxPaths, 16, 1, 32), maxSteps: bounded(options && options.maxSteps, 2000, 8, 5000), maxBranches: bounded(options && options.maxBranches, 32, 1, 64), maxBlockVisits: bounded(options && options.maxBlockVisits, 3, 1, 8), timeoutMs: bounded(options && options.timeoutMs, 250, 10, 1000) };
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
