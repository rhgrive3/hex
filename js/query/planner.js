/*
 * query/planner.js — AnalysisQuery -> bounded whole-program semantic search.
 *
 * Candidate generation uses cheap whole-program indexes; expensive Semantic IR is
 * built lazily only for the bounded candidate set. Verification always comes
 * from deterministic tools, never from an LLM assertion.
 */
import { compileGoal } from '../goalc.js';
import { FACT } from '../semantic.js';
import { createAgentTools } from '../agent/tools.js';

function asAddr(v) {
  try { return v == null ? null : (typeof v === 'bigint' ? v : BigInt(v)); } catch { return null; }
}
function lower(v) { return String(v == null ? '' : v).toLowerCase(); }

function resultAddress(row) {
  if (!row) return null;
  for (const k of ['function', 'functionAddress', 'addr', 'address', 'start']) {
    const a = asAddr(row[k]); if (a != null) return a;
  }
  return null;
}
function explicitFunctionAddress(row) {
  if (!row) return null;
  let a=asAddr(row.functionAddress); if (a != null) return a;
  if (row.function && typeof row.function === 'object') a=asAddr(row.function.address ?? row.function.addr ?? row.function.start);
  else a=asAddr(row.function);
  return a;
}

function addCandidate(map, address, source, term, weight) {
  const addr = asAddr(address);
  if (addr == null) return;
  const key = addr.toString();
  let c = map.get(key);
  if (!c) {
    c = {
      address: addr, score: 0, sources: [], terms: new Set(), semantic: null, verification: null,
      scoreComponents: { lexicalScore: 0, semanticScore: 0, graphScore: 0, evidenceScore: 0, runtimeScore: 0 },
    };
    map.set(key, c);
  }
  const amount = weight || 0;
  c.score += amount;
  if (source === 'caller' || source === 'callee') c.scoreComponents.graphScore += amount;
  else c.scoreComponents.lexicalScore += amount;
  c.sources.push(source);
  if (term) c.terms.add(term);
}

function desiredFactKinds(query) {
  const a = query && query.action;
  if (a === 'increase') return new Set([FACT.RMW, FACT.INCREMENT, FACT.WRITE, FACT.CLAMP]);
  if (a === 'decrease') return new Set([FACT.RMW, FACT.DECREMENT, FACT.WRITE, FACT.CLAMP]);
  if (a === 'set' || a === 'save') return new Set([FACT.WRITE, FACT.TRANSFER, FACT.RMW]);
  if (a === 'read') return new Set([FACT.READ, FACT.RETURN]);
  if (a === 'decide' || a === 'check' || a === 'detect') return new Set([FACT.BRANCH, FACT.THRESHOLD, FACT.ZERO_NULL]);
  if (a === 'send') return new Set([FACT.TRANSFER, FACT.CALL_RESULT]);
  return new Set([FACT.RMW, FACT.READ, FACT.WRITE, FACT.BRANCH, FACT.THRESHOLD]);
}

function semanticScore(query, facts) {
  const desired = desiredFactKinds(query);
  let score = 0;
  const hits = [];
  for (const f of facts || []) {
    if (!desired.has(f.kind)) continue;
    let w = 8;
    if (f.kind === FACT.RMW) w = 22;
    else if (f.kind === FACT.INCREMENT && query.action === 'increase') w = 35;
    else if (f.kind === FACT.DECREMENT && query.action === 'decrease') w = 35;
    else if (f.kind === FACT.CLAMP) w = 12;
    else if (f.kind === FACT.THRESHOLD) w = 14;
    else if (f.kind === FACT.BRANCH) w = 10;
    else if (f.kind === FACT.TRANSFER) w = 12;
    score += w;
    hits.push(f);
  }
  if (query && query.dataflow && query.dataflow.shape === 'read-modify-write' && hits.some((f) => f.kind === FACT.RMW)) score += 30;
  return { score, hits };
}

function lexicalScore(query, candidate, name) {
  const hay = lower(name) + ' ' + Array.from(candidate.terms).join(' ').toLowerCase();
  let score = 0;
  for (const t of query.entity && query.entity.terms || []) if (t && hay.includes(lower(t))) score += 6;
  for (const t of query.context && query.context.terms || []) if (t && hay.includes(lower(t))) score += 3;
  return score;
}

function uniqueTerms(query) {
  const out = [];
  const seen = new Set();
  for (const t of [
    ...(query.entity && query.entity.terms || []),
    ...(query.context && query.context.terms || []),
    ...(query.event && query.event.terms || []),
  ]) {
    const s = String(t || '').trim();
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out.slice(0, 16);
}

function explicitBudget(value, fallback, minimum = 0) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(minimum, Math.floor(n));
}

function budgetState(opts) {
  const controller = new AbortController();
  const timeoutMs = explicitBudget(opts && opts.timeoutMs, 3000, 1);
  const b = {
    maxFunctions: explicitBudget(opts && opts.maxFunctions, 48, 0),
    maxDisassembly: explicitBudget(opts && opts.maxDisassembly, 50000, 0),
    maxSearchResults: explicitBudget(opts && opts.maxSearchResults, 40, 1),
    maxExpansions: explicitBudget(opts && opts.maxExpansions, 20, 0),
    timeoutMs,
    started: Date.now(),
    isCancelled: opts && opts.isCancelled || (() => false),
    analyzedInstructions: 0,
    disassemblyExhausted: false,
    functionExhausted: false,
    unaccountedToolCost: false,
    analysisAccountedExternally: !!(opts && opts.tools),
    controller,
    signal: controller.signal,
    timeout: null,
    externalSignal: opts && opts.signal || null,
    externalAbort: null,
  };
  b.timeout = setTimeout(() => {
    if (!b.signal.aborted) controller.abort('timeout');
  }, timeoutMs);
  if (b.externalSignal) {
    b.externalAbort = () => { if (!b.signal.aborted) controller.abort(b.externalSignal.reason || 'cancelled'); };
    if (b.externalSignal.aborted) b.externalAbort();
    else b.externalSignal.addEventListener('abort', b.externalAbort, { once:true });
  }
  return b;
}

function disposeBudget(b) {
  if (b.timeout) clearTimeout(b.timeout);
  if (b.externalSignal && b.externalAbort) b.externalSignal.removeEventListener('abort', b.externalAbort);
}

function timedOut(b) { return b.signal.aborted && String(b.signal.reason || '') === 'timeout' || Date.now() - b.started >= b.timeoutMs; }
function cancelled(b) {
  if (!b.signal.aborted && b.isCancelled()) b.controller.abort('cancelled');
  return b.signal.aborted && !timedOut(b);
}
function expired(b) { return cancelled(b) || timedOut(b) || b.disassemblyExhausted || b.functionExhausted; }

function abortError(b) {
  const code = timedOut(b) ? 'timeout' : 'cancelled';
  const error = new Error(code);
  error.code = code;
  return error;
}

async function awaitBudget(promise, b) {
  if (expired(b)) throw abortError(b);
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(abortError(b));
    b.signal.addEventListener('abort', onAbort, { once:true });
  });
  try { return await Promise.race([Promise.resolve(promise), abortPromise]); }
  finally { b.signal.removeEventListener('abort', onAbort); }
}

async function invokeTool(tools, name, b, ...args) {
  const fn = tools && tools[name];
  if (typeof fn !== 'function') {
    const error = new Error(`missing-tool:${name}`); error.code = 'missing-tool'; throw error;
  }
  // Pass the same AbortSignal down when the tool accepts an options object. The
  // Promise race still guarantees the planner itself is preemptible if a custom
  // tool ignores cancellation.
  if (args.length && args[args.length - 1] && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) && typeof args[args.length - 1] !== 'bigint') {
    args[args.length - 1] = { ...args[args.length - 1], signal:b.signal };
  } else {
    args.push({ signal:b.signal });
  }
  return awaitBudget(fn.apply(tools, args), b);
}

function consumeExternalCost(result, b) {
  if (!b.analysisAccountedExternally) return true;
  if (result && result.found === false) return true;
  const raw = result && result.cost && result.cost.disassembly;
  if (!Number.isSafeInteger(raw) || raw < 0) {
    b.unaccountedToolCost = true;
    b.disassemblyExhausted = true;
    return false;
  }
  if (b.analyzedInstructions + raw > b.maxDisassembly) {
    b.disassemblyExhausted = true;
    return false;
  }
  b.analyzedInstructions += raw;
  return true;
}

async function lexicalCandidates(query, tools, ctx, b) {
  const map = new Map();
  const terms = uniqueTerms(query);
  for (const term of terms) {
    if (expired(b)) break;
    const fs = await invokeTool(tools, 'search_functions', b, term, { limit: b.maxSearchResults });
    if (expired(b)) break;
    for (const row of fs.results || []) addCandidate(map, resultAddress(row), 'function-name', term, 12);

    const ss = await invokeTool(tools, 'search_strings', b, term, { limit: b.maxSearchResults });
    if (expired(b)) break;
    for (const row of ss.results || []) {
      const direct = explicitFunctionAddress(row);
      if (direct != null) addCandidate(map, direct, 'string-reference', term, 8);
      const target = asAddr(row && (row.stringAddress != null ? row.stringAddress : row.target));
      if (target != null) {
        const xr = await invokeTool(tools, 'get_xrefs', b, target, { limit: b.maxSearchResults });
        if (expired(b)) break;
        for (const fn of xr.functions || []) addCandidate(map, fn.addr != null ? fn.addr : fn.function, 'string-xref', term, 10);
      }
    }
  }
  for (const c of ctx.candidateFunctions || []) addCandidate(map, c.addr != null ? c.addr : c, 'caller-scope', null, 1);
  return map;
}

async function expandCallNeighborhood(map, tools, b) {
  if (b.maxFunctions === 0) return;
  const initial = Array.from(map.values()).sort((a, b2) => b2.score - a.score).slice(0, b.maxExpansions);
  for (const c of initial) {
    if (expired(b) || map.size >= b.maxFunctions * 3) break;
    const callers = await invokeTool(tools, 'get_callers', b, c.address, { limit: 12 });
    if (expired(b)) break;
    for (const row of callers.results || []) addCandidate(map, row.addr, 'caller', null, 2);
    const callees = await invokeTool(tools, 'get_callees', b, c.address, { limit: 12 });
    if (expired(b)) break;
    for (const row of callees.results || []) addCandidate(map, row.addr, 'callee', null, 1);
  }
}

async function analyzeCandidates(query, map, tools, b) {
  const list = Array.from(map.values()).sort((a, b2) => b2.score - a.score).slice(0, b.maxFunctions);
  const analyzed = [];
  for (const c of list) {
    if (expired(b)) break;
    let fn;
    try { fn = await invokeTool(tools, 'get_function', b, c.address); }
    catch (error) {
      const code = String(error && (error.code || error.message) || '');
      if (code === 'disassembly-budget') { b.disassemblyExhausted = true; break; }
      if (code === 'function-budget') { b.functionExhausted = true; break; }
      if (code === 'timeout' || code === 'cancelled') break;
      continue;
    }
    if (expired(b)) break;
    if (!consumeExternalCost(fn, b)) break;
    c.name = fn.name || null;
    c.summary = fn.summary || null;
    const lexical = lexicalScore(query, c, c.name);
    c.score += lexical;
    c.scoreComponents.lexicalScore += lexical;

    const factsResult = await invokeTool(tools, 'get_semantic_facts', b, c.address, { limit: 500 });
    if (expired(b)) break;
    const semantic = semanticScore(query, factsResult.results || []);
    c.score += semantic.score;
    c.scoreComponents.semanticScore += semantic.score;
    c.semantic = semantic.hits;
    c.evidence = new Set();
    for (const f of semantic.hits) for (const e of f.evidence || []) c.evidence.add(e);

    if (query.expect && query.expect.calls && query.expect.calls.length && c.summary) {
      const names = (c.summary.calls || []).map((x) => lower(x.name || x.selector || ''));
      if (query.expect.calls.some((expected) => names.some((n) => n.includes(lower(expected))))) c.score += 20;
    }
    analyzed.push(c);
  }
  return analyzed.sort((a, b2) => b2.score - a.score);
}

async function verifyBest(query, ranked, tools, b) {
  for (const c of ranked.slice(0, 8)) {
    if (expired(b)) break;
    const rmw = (c.semantic || []).find((f) => f.kind === FACT.RMW ||
      (query.action === 'increase' && f.kind === FACT.INCREMENT) ||
      (query.action === 'decrease' && f.kind === FACT.DECREMENT));
    if (rmw && rmw.location) {
      const verified = await invokeTool(tools, 'verify_field_update', b, c.address, rmw.location.key || { offset: rmw.location.disp }, { pathLimit: 8 });
      if (expired(b)) break;
      c.verification = verified;
      if (verified.verified) {
        c.score += 45;
        c.scoreComponents.evidenceScore += 45;
        return c;
      }
      continue;
    }
    if (query.action === 'decide' || query.action === 'check' || query.action === 'detect') {
      const thresholds = await invokeTool(tools, 'find_thresholds', b, c.address, {});
      if (expired(b)) break;
      if ((thresholds.results || []).length) {
        // A static threshold fact is useful semantic evidence, not causal/runtime
        // verification. Keep it visible without occupying the proof slot (#386).
        c.thresholdEvidence = thresholds;
        c.score += 8;
        c.scoreComponents.semanticScore += 8;
      }
    }
  }
  return ranked[0] || null;
}

function publicCandidate(c) {
  if (!c) return null;
  return {
    address: c.address,
    name: c.name || null,
    score: c.score,
    lexicalScore: c.scoreComponents && c.scoreComponents.lexicalScore || 0,
    semanticScore: c.scoreComponents && c.scoreComponents.semanticScore || 0,
    graphScore: c.scoreComponents && c.scoreComponents.graphScore || 0,
    evidenceScore: c.scoreComponents && c.scoreComponents.evidenceScore || 0,
    runtimeScore: c.scoreComponents && c.scoreComponents.runtimeScore || 0,
    totalScore: c.score,
    reasons: c.sources.slice(),
    sources: c.sources,
    semanticFacts: c.semantic || [],
    summary: c.summary || null,
    verification: c.verification || null,
    thresholdEvidence: c.thresholdEvidence || null,
    evidence: Array.from(c.evidence || []),
  };
}

function guardedContext(ctx, b) {
  if (typeof ctx.analyze !== 'function') return ctx;
  return {
    ...ctx,
    analyze: async (...args) => {
      if (expired(b)) throw abortError(b);
      if (b.analyzedInstructions >= b.maxDisassembly) { b.disassemblyExhausted = true; throw Object.assign(new Error('disassembly-budget'), { code:'disassembly-budget' }); }
      const model = await awaitBudget(ctx.analyze(...args), b);
      if (expired(b)) throw abortError(b);
      const cost = Math.max(0, Array.isArray(model && model.instructions) ? model.instructions.length : 0);
      if (b.analyzedInstructions + cost > b.maxDisassembly) { b.disassemblyExhausted = true; throw Object.assign(new Error('disassembly-budget'), { code:'disassembly-budget' }); }
      b.analyzedInstructions += cost;
      return model;
    },
  };
}

export async function planAnalysisGoal(goalOrQuery, context, opts) {
  const query = typeof goalOrQuery === 'string' ? compileGoal(goalOrQuery) : goalOrQuery;
  const ctx = context || {};
  const b = budgetState(opts);
  try {
    const tools = opts && opts.tools || createAgentTools(guardedContext(ctx, b), {
      maxFunctions: b.maxFunctions,
      maxDisassembly: b.maxDisassembly,
    });
    if (!query) return { query: null, candidates: [], best: null, evidence: [], missingEvidence: ['query'], engine: 'deterministic-goal-planner' };

    let candidates = new Map();
    let ranked = [];
    let best = null;
    try {
      candidates = await lexicalCandidates(query, tools, ctx, b);
      if (!expired(b)) await expandCallNeighborhood(candidates, tools, b);
      ranked = await analyzeCandidates(query, candidates, tools, b);
      best = await verifyBest(query, ranked, tools, b);
    } catch (error) {
      const code = String(error && (error.code || error.message) || '');
      if (code !== 'timeout' && code !== 'cancelled') throw error;
    }
    ranked = ranked.sort((a, b2) => b2.score - a.score);
    if (best) best = ranked.find((x) => x.address === best.address) || best;

    const evidence = new Set();
    if (best) for (const e of best.evidence || []) evidence.add(e);
    if (best && best.verification && best.verification.evidence) for (const e of best.verification.evidence) evidence.add(e);
    const missingEvidence = [];
    if (!best) missingEvidence.push('no-candidate-function');
    else if (!best.verification) missingEvidence.push('no-runtime-or-causal-verification');
    if (b.disassemblyExhausted) missingEvidence.push('disassembly-budget');
    if (b.functionExhausted) missingEvidence.push('function-budget');
    if (b.unaccountedToolCost) missingEvidence.push('unaccounted-tool-cost');
    if (timedOut(b)) missingEvidence.push('timeout');
    if (cancelled(b)) missingEvidence.push('cancelled');
    if (query.confident === false) missingEvidence.push(...(query.missing || []));

    return {
      query,
      candidates: ranked.slice(0, Math.min(20, b.maxFunctions)).map(publicCandidate),
      best: publicCandidate(best),
      evidence: Array.from(evidence),
      missingEvidence: Array.from(new Set(missingEvidence)),
      exhausted: expired(b),
      stats: {
        analyzedFunctions: ranked.length,
        candidateFunctions: candidates.size,
        disassembly: b.analyzedInstructions,
        elapsedMs: Date.now() - b.started,
      },
      engine: 'deterministic-goal-planner',
    };
  } finally {
    disposeBudget(b);
  }
}

export const runGoalPlanner = planAnalysisGoal;
