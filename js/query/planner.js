/*
 * query/planner.js — AnalysisQuery -> bounded whole-program semantic search.
 *
 * Candidate generation uses cheap source-isolated pools. Expensive Semantic IR
 * is built lazily only for a quota-merged shortlist, leaving turn resources for
 * later LLM refinement and deterministic verification.
 */
import { compileGoal } from '../goalc.js';
import { FACT } from '../semantic.js';
import { createAgentTools } from '../agent/tools.js';

const POOL_ORDER = Object.freeze(['lexical', 'string', 'graph', 'recognition', 'runtime', 'semantic', 'exploration']);
const POOL_SHARE = Object.freeze({ lexical: 0.29, string: 0.17, graph: 0.21, recognition: 0.17, runtime: 0.06, semantic: 0.06, exploration: 0.04 });

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
  let a = asAddr(row.functionAddress); if (a != null) return a;
  if (row.function && typeof row.function === 'object') a = asAddr(row.function.address ?? row.function.addr ?? row.function.start);
  else a = asAddr(row.function);
  return a;
}
function newCandidate(addr) {
  return {
    address: addr, score: 0, sources: [], terms: new Set(), semantic: null, verification: null,
    scoreComponents: { lexicalScore: 0, semanticScore: 0, graphScore: 0, evidenceScore: 0, runtimeScore: 0 },
    sourcePoolScores: {}, coverageSum: 0, coverageWeight: 0,
  };
}
function poolMap(pools, name) {
  if (!pools[name]) pools[name] = new Map();
  return pools[name];
}
function sourceComponent(pool) {
  if (pool === 'graph') return 'graphScore';
  if (pool === 'runtime') return 'runtimeScore';
  if (pool === 'semantic') return 'semanticScore';
  return 'lexicalScore';
}
function addCandidate(pools, pool, address, source, term, weight, coverage = 1, cap = Infinity) {
  const addr = asAddr(address);
  if (addr == null) return;
  const map = poolMap(pools, pool);
  const key = addr.toString();
  let c = map.get(key);
  const quality = Number.isFinite(Number(coverage)) ? Math.max(0.2, Math.min(1, Number(coverage))) : 0.7;
  const amount = (weight || 0) * quality;
  if (!c) {
    if (map.size >= cap) {
      // Keep the strongest bounded subset instead of whichever candidates happened
      // to arrive first. Recognition inputs are often large and not guaranteed to
      // be pre-sorted.
      let worstKey = null;
      let worstScore = Infinity;
      for (const [candidateKey, candidate] of map) {
        if (candidate.score < worstScore) { worstScore = candidate.score; worstKey = candidateKey; }
      }
      if (worstKey == null || amount <= worstScore) return;
      map.delete(worstKey);
    }
    c = newCandidate(addr);
    map.set(key, c);
  }
  c.score += amount;
  c.scoreComponents[sourceComponent(pool)] += amount;
  c.sourcePoolScores[pool] = (c.sourcePoolScores[pool] || 0) + amount;
  c.sources.push(source);
  if (term) c.terms.add(term);
  c.coverageSum += quality * Math.max(1, Math.abs(weight || 1));
  c.coverageWeight += Math.max(1, Math.abs(weight || 1));
}
function mergeCandidateInto(target, source) {
  target.score += source.score;
  for (const key of Object.keys(target.scoreComponents)) target.scoreComponents[key] += source.scoreComponents[key] || 0;
  for (const [pool, value] of Object.entries(source.sourcePoolScores || {})) target.sourcePoolScores[pool] = (target.sourcePoolScores[pool] || 0) + value;
  target.sources.push(...source.sources);
  for (const term of source.terms) target.terms.add(term);
  target.coverageSum += source.coverageSum || 0;
  target.coverageWeight += source.coverageWeight || 0;
  return target;
}
function mergedCandidates(pools) {
  const merged = new Map();
  for (const pool of POOL_ORDER) {
    for (const c of poolMap(pools, pool).values()) {
      const key = c.address.toString();
      const target = merged.get(key) || newCandidate(c.address);
      if (!merged.has(key)) merged.set(key, target);
      mergeCandidateInto(target, c);
    }
  }
  return merged;
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
function plannerShare(total, ratio = 0.4) {
  if (total <= 0) return 0;
  if (total <= 2) return total;
  return Math.max(1, Math.min(total - 1, Math.floor(total * ratio)));
}
function plannerDisassemblyShare(total, ratio = 0.4) {
  if (total <= 0) return 0;
  if (total <= 64) return total;
  return Math.max(64, Math.min(total - 1, Math.floor(total * ratio)));
}
function budgetState(opts) {
  const controller = new AbortController();
  const timeoutMs = explicitBudget(opts && opts.timeoutMs, 3000, 1);
  const requestedMaxFunctions = explicitBudget(opts && opts.maxFunctions, 48, 0);
  const requestedMaxDisassembly = explicitBudget(opts && opts.maxDisassembly, 50000, 0);
  const ratioRaw = Number(opts?.plannerBudgetFraction);
  const ratio = Number.isFinite(ratioRaw) ? Math.max(0.1, Math.min(0.8, ratioRaw)) : 0.4;
  const maxFunctions = plannerShare(requestedMaxFunctions, ratio);
  const maxDisassembly = plannerDisassemblyShare(requestedMaxDisassembly, ratio);
  const b = {
    requestedMaxFunctions, requestedMaxDisassembly, maxFunctions, maxDisassembly,
    reservedFunctions: Math.max(0, requestedMaxFunctions - maxFunctions),
    reservedDisassembly: Math.max(0, requestedMaxDisassembly - maxDisassembly),
    maxSearchResults: explicitBudget(opts && opts.maxSearchResults, 40, 1),
    maxExpansions: explicitBudget(opts && opts.maxExpansions, 20, 0),
    timeoutMs, started: Date.now(), isCancelled: opts && opts.isCancelled || (() => false),
    analyzedInstructions: 0, disassemblyExhausted: false, functionExhausted: false,
    candidateTruncated: false, candidateCount: 0, unaccountedToolCost: false,
    analysisAccountedExternally: !!(opts && opts.tools),
    searchIncomplete: false, searchReports: [], sourceTotals: Object.fromEntries(POOL_ORDER.map((name) => [name, 0])),
    controller, signal: controller.signal, timeout: null, externalSignal: opts && opts.signal || null, externalAbort: null,
  };
  b.timeout = setTimeout(() => { if (!b.signal.aborted) controller.abort('timeout'); }, timeoutMs);
  if (b.externalSignal) {
    b.externalAbort = () => { if (!b.signal.aborted) controller.abort(b.externalSignal.reason ?? 'cancelled'); };
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
  const error = new Error(code); error.code = code; return error;
}
async function awaitBudget(promise, b) {
  if (expired(b)) throw abortError(b);
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(abortError(b)); b.signal.addEventListener('abort', onAbort, { once:true });
  });
  try { return await Promise.race([Promise.resolve(promise), abortPromise]); }
  finally { b.signal.removeEventListener('abort', onAbort); }
}
async function invokeTool(tools, name, b, ...args) {
  const fn = tools && tools[name];
  if (typeof fn !== 'function') { const error = new Error(`missing-tool:${name}`); error.code = 'missing-tool'; throw error; }
  if (args.length && args[args.length - 1] && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) && typeof args[args.length - 1] !== 'bigint') {
    args[args.length - 1] = { ...args[args.length - 1], signal:b.signal };
  } else args.push({ signal:b.signal });
  return awaitBudget(fn.apply(tools, args), b);
}
function consumeExternalCost(result, b) {
  if (!b.analysisAccountedExternally) return true;
  if (result && result.found === false) return true;
  const raw = result && result.cost && result.cost.disassembly;
  if (!Number.isSafeInteger(raw) || raw < 0) { b.unaccountedToolCost = true; b.disassemblyExhausted = true; return false; }
  if (b.analyzedInstructions + raw > b.maxDisassembly) { b.disassemblyExhausted = true; return false; }
  b.analyzedInstructions += raw;
  return true;
}
function searchCompleteness(result, requestedLimit) {
  const complete = result?.completeness?.complete ?? result?.complete ?? (!result?.truncated && (result?.results?.length || 0) < requestedLimit);
  let coverage = Number(result?.completeness?.coverage ?? result?.coverage);
  const returned = Number(result?.completeness?.returned ?? result?.returned ?? result?.results?.length ?? 0);
  const totalRaw = result?.completeness?.total ?? result?.total;
  const total = totalRaw == null ? null : Number(totalRaw);
  if (!Number.isFinite(coverage)) {
    if (Number.isFinite(total) && total > 0) coverage = Math.min(1, returned / total);
    else if (Number.isFinite(Number(result?.scanned)) && Number.isFinite(Number(result?.scanTotal)) && Number(result.scanTotal) > 0) coverage = Math.min(1, Number(result.scanned) / Number(result.scanTotal));
    else coverage = complete ? 1 : 0.65;
  }
  return { complete: Boolean(complete), coverage: Math.max(0, Math.min(1, coverage)), reason: result?.completeness?.reason ?? result?.reason ?? (complete ? null : 'result-limit'), returned, total: Number.isFinite(total) ? total : null };
}
function noteSearch(b, tool, term, result) {
  const report = { tool, term, ...searchCompleteness(result, b.maxSearchResults) };
  b.searchReports.push(report);
  if (!report.complete) b.searchIncomplete = true;
  return report.coverage;
}
function sourcePoolCap(b, pool) {
  const factor = pool === 'recognition' ? 10 : 8;
  return Math.max(48, b.maxFunctions * factor, b.maxSearchResults * 2);
}
function classifyPrior(c) {
  const text = lower(c?.source ?? c?.kind ?? c?.reason ?? '');
  if (text.includes('runtime')) return 'runtime';
  if (text.includes('semantic')) return 'semantic';
  if (text.includes('explor')) return 'exploration';
  return 'recognition';
}
async function candidatePools(query, tools, ctx, b) {
  const pools = Object.fromEntries(POOL_ORDER.map((name) => [name, new Map()]));
  const terms = uniqueTerms(query);
  for (const term of terms) {
    if (expired(b)) break;
    const fs = await invokeTool(tools, 'search_functions', b, term, { limit: b.maxSearchResults });
    if (expired(b)) break;
    const fCoverage = noteSearch(b, 'search_functions', term, fs);
    for (const row of fs.results || []) addCandidate(pools, 'lexical', resultAddress(row), 'function-name', term, 12, fCoverage, sourcePoolCap(b, 'lexical'));

    const ss = await invokeTool(tools, 'search_strings', b, term, { limit: b.maxSearchResults });
    if (expired(b)) break;
    const sCoverage = noteSearch(b, 'search_strings', term, ss);
    for (const row of ss.results || []) {
      const direct = explicitFunctionAddress(row);
      if (direct != null) addCandidate(pools, 'string', direct, 'string-reference', term, 8, sCoverage, sourcePoolCap(b, 'string'));
      const target = asAddr(row && (row.stringAddress != null ? row.stringAddress : row.target));
      if (target != null) {
        const xr = await invokeTool(tools, 'get_xrefs', b, target, { limit: b.maxSearchResults });
        if (expired(b)) break;
        const xCoverage = searchCompleteness({ ...xr, results: xr.functions || [] }, b.maxSearchResults).coverage;
        for (const fn of xr.functions || []) addCandidate(pools, 'string', fn.addr != null ? fn.addr : fn.function, 'string-xref', term, 10, xCoverage, sourcePoolCap(b, 'string'));
      }
    }
  }
  const priors = Array.isArray(ctx.candidateFunctions) ? ctx.candidateFunctions : [];
  for (const c of priors) {
    const pool = classifyPrior(c);
    b.sourceTotals[pool]++;
    addCandidate(pools, pool, c?.addr != null ? c.addr : c?.address != null ? c.address : c, c?.source || `${pool}-prior`, null, Number(c?.score || 1), Number(c?.coverage ?? 1), sourcePoolCap(b, pool));
  }
  for (const pool of POOL_ORDER) b.sourceTotals[pool] = Math.max(b.sourceTotals[pool], pools[pool].size);
  return pools;
}
function seedCandidates(pools, limit) {
  const merged = mergedCandidates(pools);
  return Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}
async function expandCallNeighborhood(pools, tools, b) {
  if (b.maxFunctions === 0 || b.maxExpansions === 0) return;
  const initial = seedCandidates(pools, b.maxExpansions);
  const graphCap = Math.max(24, b.maxFunctions * 4, b.maxExpansions * 8);
  for (const c of initial) {
    if (expired(b) || pools.graph.size >= graphCap) break;
    const callers = await invokeTool(tools, 'get_callers', b, c.address, { limit: 12 });
    if (expired(b)) break;
    for (const row of callers.results || []) addCandidate(pools, 'graph', row.addr ?? row.function ?? row.functionAddress, 'caller', null, 2, 1, graphCap);
    const callees = await invokeTool(tools, 'get_callees', b, c.address, { limit: 12 });
    if (expired(b)) break;
    for (const row of callees.results || []) addCandidate(pools, 'graph', row.addr ?? row.function ?? row.functionAddress, 'callee', null, 1, 1, graphCap);
  }
  b.sourceTotals.graph = Math.max(b.sourceTotals.graph, pools.graph.size);
}
function quotaCounts(pools, total) {
  const available = POOL_ORDER.filter((pool) => pools[pool].size > 0);
  const quota = Object.fromEntries(POOL_ORDER.map((pool) => [pool, 0]));
  if (!available.length || total <= 0) return quota;
  if (total >= available.length) for (const pool of available) quota[pool] = 1;
  let assigned = Object.values(quota).reduce((a, n) => a + n, 0);
  const target = {};
  for (const pool of available) target[pool] = Math.max(quota[pool], Math.floor(total * (POOL_SHARE[pool] || 0)));
  while (assigned < total) {
    let best = null;
    let bestNeed = -Infinity;
    for (const pool of available) {
      if (quota[pool] >= pools[pool].size) continue;
      const desired = Math.max(target[pool], total * (POOL_SHARE[pool] || 0));
      const need = desired - quota[pool];
      if (need > bestNeed) { bestNeed = need; best = pool; }
    }
    if (!best) break;
    quota[best]++; assigned++;
  }
  return quota;
}
function quotaMerge(pools, total) {
  const global = mergedCandidates(pools);
  const quota = quotaCounts(pools, total);
  const selected = new Set();
  for (const pool of POOL_ORDER) {
    const rows = Array.from(pools[pool].values()).sort((a, b) => b.score - a.score);
    let used = 0;
    for (const row of rows) {
      if (used >= quota[pool] || selected.size >= total) break;
      const key = row.address.toString();
      if (selected.has(key)) continue;
      selected.add(key); used++;
    }
  }
  if (selected.size < total) {
    const spill = Array.from(global.values()).sort((a, b) => b.score - a.score);
    for (const row of spill) {
      if (selected.size >= total) break;
      selected.add(row.address.toString());
    }
  }
  return { candidates: Array.from(selected).map((key) => global.get(key)).filter(Boolean).sort((a, b) => b.score - a.score), all: global, quotas: quota };
}
function sourceCompleteness(pools, b) {
  const bySource = {};
  let supplied = 0;
  let stored = 0;
  for (const pool of POOL_ORDER) {
    const suppliedCount = Math.max(Number(b.sourceTotals[pool] || 0), pools[pool].size);
    const storedCount = pools[pool].size;
    supplied += suppliedCount;
    stored += Math.min(storedCount, suppliedCount);
    bySource[pool] = {
      supplied: suppliedCount,
      stored: storedCount,
      complete: storedCount >= suppliedCount,
      coverage: suppliedCount ? Math.min(1, storedCount / suppliedCount) : 1,
    };
  }
  return {
    complete: Object.values(bySource).every((entry) => entry.complete),
    supplied,
    stored,
    coverage: supplied ? Math.min(1, stored / supplied) : 1,
    bySource,
  };
}

async function analyzeCandidates(query, pools, tools, b) {
  const merged = quotaMerge(pools, b.maxFunctions);
  b.candidateCount = merged.all.size;
  b.shortlistLimited = merged.all.size > b.maxFunctions;
  b.candidateTruncated = b.shortlistLimited; // compatibility alias for older diagnostics
  b.sourceCompleteness = sourceCompleteness(pools, b);
  b.sourcePoolTruncated = !b.sourceCompleteness.complete;
  b.quotas = merged.quotas;
  const analyzed = [];
  for (const c of merged.candidates) {
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
    c.score += lexical; c.scoreComponents.lexicalScore += lexical;
    const factsResult = await invokeTool(tools, 'get_semantic_facts', b, c.address, { limit: 500 });
    if (expired(b)) break;
    const semantic = semanticScore(query, factsResult.results || []);
    c.score += semantic.score; c.scoreComponents.semanticScore += semantic.score; c.semantic = semantic.hits;
    c.evidence = new Set();
    for (const f of semantic.hits) for (const e of f.evidence || []) c.evidence.add(e);
    c.semanticCompleteness = factsResult.completeness || { complete: !factsResult.truncated, coverage: factsResult.coverage ?? null, reason: factsResult.reason || null };
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
      if (verified.verified) { c.score += 45; c.scoreComponents.evidenceScore += 45; return c; }
      continue;
    }
    if (query.action === 'decide' || query.action === 'check' || query.action === 'detect') {
      const thresholds = await invokeTool(tools, 'find_thresholds', b, c.address, {});
      if (expired(b)) break;
      if ((thresholds.results || []).length) { c.thresholdEvidence = thresholds; c.score += 8; c.scoreComponents.semanticScore += 8; }
    }
  }
  return ranked[0] || null;
}
function publicCandidate(c, completeness = null) {
  if (!c) return null;
  const discoveryCoverage = c.coverageWeight ? c.coverageSum / c.coverageWeight : 1;
  return {
    address: c.address, name: c.name || null, score: c.score,
    lexicalScore: c.scoreComponents?.lexicalScore || 0, semanticScore: c.scoreComponents?.semanticScore || 0,
    graphScore: c.scoreComponents?.graphScore || 0, evidenceScore: c.scoreComponents?.evidenceScore || 0,
    runtimeScore: c.scoreComponents?.runtimeScore || 0, totalScore: c.score,
    discoveryCoverage, sourcePoolScores: { ...c.sourcePoolScores }, reasons: Array.from(new Set(c.sources)), sources: Array.from(new Set(c.sources)),
    semanticFacts: c.semantic || [], semanticCompleteness: c.semanticCompleteness || null, summary: c.summary || null,
    verification: c.verification || null, thresholdEvidence: c.thresholdEvidence || null, evidence: Array.from(c.evidence || []),
    complete: completeness ? completeness.complete === true : true, budgetLimited: completeness ? completeness.budgetLimited === true : false,
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
function aggregateSearchCoverage(reports) {
  if (!reports.length) return { complete: true, coverage: 1, reason: null, reports: [] };
  const coverage = reports.reduce((sum, report) => sum + report.coverage, 0) / reports.length;
  const incomplete = reports.filter((report) => !report.complete);
  return { complete: incomplete.length === 0, coverage, reason: incomplete[0]?.reason || null, reports };
}
export async function planAnalysisGoal(goalOrQuery, context, opts) {
  const query = typeof goalOrQuery === 'string' ? compileGoal(goalOrQuery) : goalOrQuery;
  const ctx = context || {};
  const b = budgetState(opts);
  try {
    const tools = opts && opts.tools || createAgentTools(guardedContext(ctx, b), { maxFunctions: b.maxFunctions, maxDisassembly: b.maxDisassembly });
    if (!query) return { query: null, candidates: [], best: null, evidence: [], missingEvidence: ['query'], engine: 'deterministic-goal-planner' };
    let pools = Object.fromEntries(POOL_ORDER.map((name) => [name, new Map()]));
    let ranked = [];
    let best = null;
    try {
      pools = await candidatePools(query, tools, ctx, b);
      if (!expired(b)) await expandCallNeighborhood(pools, tools, b);
      ranked = await analyzeCandidates(query, pools, tools, b);
      best = await verifyBest(query, ranked, tools, b);
    } catch (error) {
      const code = String(error && (error.code || error.message) || '');
      if (code !== 'timeout' && code !== 'cancelled') throw error;
    }
    ranked = ranked.sort((a, b2) => b2.score - a.score);
    if (best) best = ranked.find((x) => x.address === best.address) || best;
    const evidence = new Set();
    if (best) for (const e of best.evidence || []) evidence.add(e);
    if (best?.verification?.evidence) for (const e of best.verification.evidence) evidence.add(e);
    const missingEvidence = [];
    if (!best) missingEvidence.push('no-candidate-function');
    else if (!best.verification) missingEvidence.push('no-runtime-or-causal-verification');
    if (b.disassemblyExhausted) missingEvidence.push('disassembly-budget');
    if (b.functionExhausted) missingEvidence.push('function-budget');
    if (b.shortlistLimited) missingEvidence.push('planner-shortlist-limit');
    if (b.sourcePoolTruncated) missingEvidence.push('candidate-source-limit');
    if (b.searchIncomplete) missingEvidence.push('search-incomplete');
    if (b.unaccountedToolCost) missingEvidence.push('unaccounted-tool-cost');
    if (timedOut(b)) missingEvidence.push('timeout');
    if (cancelled(b)) missingEvidence.push('cancelled');
    if (query.confident === false) missingEvidence.push(...(query.missing || []));
    const search = aggregateSearchCoverage(b.searchReports);
    const sourceCompletenessInfo = b.sourceCompleteness || sourceCompleteness(pools, b);
    const incomplete = expired(b) || b.shortlistLimited || b.sourcePoolTruncated || b.searchIncomplete;
    const budgetLimited = b.disassemblyExhausted || b.functionExhausted;
    const all = mergedCandidates(pools);
    const candidateCount = all.size;
    const analyzedCount = ranked.length;
    const storedCandidateCoverage = candidateCount === 0 ? 1 : Math.min(1, analyzedCount / candidateCount);
    const candidateCoverage = storedCandidateCoverage * search.coverage * sourceCompletenessInfo.coverage;
    const reason = b.functionExhausted ? 'function-budget'
      : b.disassemblyExhausted ? 'disassembly-budget'
        : timedOut(b) ? 'timeout'
          : cancelled(b) ? 'cancelled'
            : b.sourcePoolTruncated ? 'candidate-source-limit'
              : b.shortlistLimited ? 'planner-shortlist-limit'
                : b.searchIncomplete ? (search.reason || 'search-incomplete') : null;
    const completeness = {
      complete: !incomplete, partial: incomplete, budgetLimited, reason, candidateCoverage,
      storedCandidateCoverage, candidateSourceCoverage: sourceCompletenessInfo.coverage,
      searchCoverage: search.coverage, searchComplete: search.complete,
      analyzedFunctions: analyzedCount, candidateFunctions: candidateCount, unanalyzedFunctions: Math.max(0, candidateCount - analyzedCount),
    };
    return {
      query,
      candidates: ranked.slice(0, Math.min(20, b.maxFunctions)).map((c) => publicCandidate(c, completeness)),
      best: publicCandidate(best, completeness), evidence: Array.from(evidence), missingEvidence: Array.from(new Set(missingEvidence)),
      exhausted: budgetLimited || timedOut(b) || cancelled(b), partial: incomplete, completeness,
      refinementAvailable: !budgetLimited && (b.reservedFunctions > 0 || b.reservedDisassembly > 0),
      candidateSources: {
        quotas: b.quotas || quotaCounts(pools, b.maxFunctions), stored: Object.fromEntries(POOL_ORDER.map((pool) => [pool, pools[pool].size])), supplied: { ...b.sourceTotals },
        completeness: sourceCompletenessInfo,
      },
      budget: {
        requested: { functions: b.requestedMaxFunctions, disassembly: b.requestedMaxDisassembly },
        planner: { functions: b.maxFunctions, disassembly: b.maxDisassembly },
        reserved: { functions: b.reservedFunctions, disassembly: b.reservedDisassembly },
      },
      searchCompleteness: search,
      stats: {
        analyzedFunctions: analyzedCount, candidateFunctions: candidateCount, unanalyzedFunctions: Math.max(0, candidateCount - analyzedCount),
        disassembly: b.analyzedInstructions, elapsedMs: Date.now() - b.started,
        plannerFunctionBudget: b.maxFunctions, requestedFunctionBudget: b.requestedMaxFunctions,
        plannerDisassemblyBudget: b.maxDisassembly, requestedDisassemblyBudget: b.requestedMaxDisassembly,
      },
      engine: 'deterministic-goal-planner',
    };
  } finally { disposeBudget(b); }
}
export const runGoalPlanner = planAnalysisGoal;
