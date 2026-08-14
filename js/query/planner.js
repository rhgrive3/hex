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

function addCandidate(map, address, source, term, weight) {
  const addr = asAddr(address);
  if (addr == null) return;
  const key = addr.toString();
  let c = map.get(key);
  if (!c) {
    c = { address: addr, score: 0, sources: [], terms: new Set(), semantic: null, verification: null };
    map.set(key, c);
  }
  c.score += weight || 0;
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
  return {
    maxFunctions: explicitBudget(opts && opts.maxFunctions, 48, 0),
    maxDisassembly: explicitBudget(opts && opts.maxDisassembly, 50000, 0),
    maxSearchResults: explicitBudget(opts && opts.maxSearchResults, 40, 1),
    maxExpansions: explicitBudget(opts && opts.maxExpansions, 20, 0),
    timeoutMs: explicitBudget(opts && opts.timeoutMs, 3000, 50),
    started: Date.now(),
    isCancelled: opts && opts.isCancelled || (() => false),
    analyzedInstructions: 0,
    disassemblyExhausted: false,
  };
}

function expired(b) { return b.isCancelled() || Date.now() - b.started > b.timeoutMs || b.disassemblyExhausted; }

async function lexicalCandidates(query, tools, ctx, b) {
  const map = new Map();
  const terms = uniqueTerms(query);
  for (const term of terms) {
    if (expired(b)) break;
    const fs = await tools.search_functions(term, { limit: b.maxSearchResults });
    for (const row of fs.results || []) addCandidate(map, resultAddress(row), 'function-name', term, 12);

    const ss = await tools.search_strings(term, { limit: b.maxSearchResults });
    for (const row of ss.results || []) {
      const direct = resultAddress(row);
      if (direct != null) addCandidate(map, direct, 'string-reference', term, 8);
      const target = asAddr(row && (row.stringAddress != null ? row.stringAddress : row.target));
      if (target != null) {
        const xr = await tools.get_xrefs(target, { limit: b.maxSearchResults });
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
    const callers = await tools.get_callers(c.address, { limit: 12 });
    for (const row of callers.results || []) addCandidate(map, row.addr, 'caller', null, 2);
    const callees = await tools.get_callees(c.address, { limit: 12 });
    for (const row of callees.results || []) addCandidate(map, row.addr, 'callee', null, 1);
  }
}

async function analyzeCandidates(query, map, tools, b) {
  const list = Array.from(map.values()).sort((a, b2) => b2.score - a.score).slice(0, b.maxFunctions);
  const analyzed = [];
  for (const c of list) {
    if (expired(b)) break;
    let fn;
    try { fn = await tools.get_function(c.address); }
    catch (error) {
      if ((error && error.message) === 'disassembly-budget') { b.disassemblyExhausted = true; break; }
      continue;
    }
    const cost = Math.max(0, Number(fn && fn.instructions || 0));
    if (b.analyzedInstructions + cost > b.maxDisassembly) { b.disassemblyExhausted = true; break; }
    b.analyzedInstructions += cost;
    c.name = fn.name || null;
    c.summary = fn.summary || null;
    c.score += lexicalScore(query, c, c.name);

    const factsResult = await tools.get_semantic_facts(c.address, { limit: 500 });
    const semantic = semanticScore(query, factsResult.results || []);
    c.score += semantic.score;
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
      const verified = await tools.verify_field_update(c.address, rmw.location.key || { offset: rmw.location.disp }, { pathLimit: 8 });
      c.verification = verified;
      if (verified.verified) {
        c.score += 45;
        return c;
      }
      continue;
    }
    if (query.action === 'decide' || query.action === 'check' || query.action === 'detect') {
      const thresholds = await tools.find_thresholds(c.address);
      if ((thresholds.results || []).length) {
        c.verification = thresholds;
        c.score += 20;
        return c;
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
    sources: c.sources,
    semanticFacts: c.semantic || [],
    summary: c.summary || null,
    verification: c.verification || null,
    evidence: Array.from(c.evidence || []),
  };
}

export async function planAnalysisGoal(goalOrQuery, context, opts) {
  const query = typeof goalOrQuery === 'string' ? compileGoal(goalOrQuery) : goalOrQuery;
  const ctx = context || {};
  const b = budgetState(opts);
  const tools = opts && opts.tools || createAgentTools(ctx, { maxFunctions: Math.max(1, b.maxFunctions) });
  if (!query) return { query: null, candidates: [], best: null, evidence: [], missingEvidence: ['query'], engine: 'deterministic-goal-planner' };

  const candidates = await lexicalCandidates(query, tools, ctx, b);
  if (!expired(b)) await expandCallNeighborhood(candidates, tools, b);
  let ranked = await analyzeCandidates(query, candidates, tools, b);
  let best = await verifyBest(query, ranked, tools, b);
  ranked = ranked.sort((a, b2) => b2.score - a.score);
  if (best) best = ranked.find((x) => x.address === best.address) || best;

  const evidence = new Set();
  if (best) for (const e of best.evidence || []) evidence.add(e);
  if (best && best.verification && best.verification.evidence) for (const e of best.verification.evidence) evidence.add(e);
  const missingEvidence = [];
  if (!best) missingEvidence.push('no-candidate-function');
  else if (!best.verification) missingEvidence.push('no-runtime-or-causal-verification');
  if (b.disassemblyExhausted) missingEvidence.push('disassembly-budget');
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
}

export const runGoalPlanner = planAnalysisGoal;
