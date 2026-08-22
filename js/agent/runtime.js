/*
 * agent/runtime.js — model-independent plan/tool/observe loop.
 * Deterministic tools are the evidence boundary; LLM text never upgrades a fact.
 */
import { compileGoal } from '../goalc.js';
import { createAgentTools } from './tools.js';
import { planAnalysisGoal } from '../query/planner.js';

function addressFromArgs(args) {
  if (!args || !args.length) return null;
  for (const v of args) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)) { try { return BigInt(v); } catch { /* ignore */ } }
    if (v && typeof v === 'object') {
      for (const k of ['functionAddress', 'address', 'addr']) {
        if (v[k] != null) { try { return BigInt(v[k]); } catch { /* ignore */ } }
      }
    }
  }
  return null;
}

function evidenceFromObservation(obs, set) {
  if (!obs || typeof obs !== 'object') return;
  for (const e of obs.evidence || []) if (typeof e === 'string') set.add(e);
  for (const r of obs.results || []) for (const e of r && r.evidence || []) if (typeof e === 'string') set.add(e);
  for (const u of obs.updates || []) for (const e of u && u.evidence || []) if (typeof e === 'string') set.add(e);
}

function finiteConfidence(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function verificationVerdict(verification) {
  const raw = verification?.verdict;
  const status = typeof raw === 'string' ? raw : (raw?.status || verification?.status || null);
  const confidence = finiteConfidence(raw && typeof raw === 'object' ? raw.confidence : verification?.confidence, null);
  return { status: status ? String(status) : null, confidence };
}

function confidenceFromEvidence({ semanticCount, explicitVerified, verdictStatus, verdictConfidence }) {
  const staticConfidence = semanticCount ? 0.78 : 0.45;
  if (!verdictStatus) return explicitVerified ? 0.98 : staticConfidence;

  if (verdictStatus === 'confirmed') {
    // Runtime confirmation is itself the strongest source. Never manufacture a
    // confidence above the verifier's own calibrated confidence.
    return Math.min(0.98, verdictConfidence ?? 0.98);
  }
  if (verdictStatus === 'supported') {
    // Partial runtime support may strengthen a weak static candidate slightly,
    // but it can never escape the source verdict's confidence envelope.
    const cap = Math.min(0.85, verdictConfidence ?? 0.85);
    return Math.min(cap, staticConfidence + 0.10);
  }
  if (verdictStatus === 'contradicted') {
    // Verdict confidence measures confidence in the contradiction, so invert it
    // when expressing confidence in the candidate conclusion.
    const contradiction = Math.max(0.70, verdictConfidence ?? 0.70);
    return Math.min(staticConfidence, Math.max(0, 1 - contradiction));
  }
  if (verdictStatus === 'inconclusive') {
    return Math.min(staticConfidence, verdictConfidence ?? 0.25, 0.25);
  }
  if (verdictStatus === 'unsupported') return 0;
  // Unknown verifier statuses are evidence, not permission to upgrade.
  return Math.min(staticConfidence, verdictConfidence ?? staticConfidence);
}

export function deterministicAnswer(plan) {
  const best = plan && plan.best;
  if (!best) {
    return {
      conclusion: null,
      reasons: [],
      evidence: plan && plan.evidence || [],
      confidence: 0,
      missingEvidence: plan && plan.missingEvidence && plan.missingEvidence.length ? plan.missingEvidence : ['no-verified-candidate'],
    };
  }
  const { status: verdict, confidence: verdictConfidence } = verificationVerdict(best.verification);
  const explicitVerified = best.verification?.verified === true;
  const verified = explicitVerified || verdict === 'confirmed';
  const semanticCount = (best.semanticFacts || []).length;
  const reasons = [
    { kind: 'semantic-facts', count: semanticCount },
    { kind: 'deterministic-verification', verified },
  ];
  if (verdict) reasons.push({
    kind: `runtime-${verdict}`,
    status: verdict,
    confidence: verdictConfidence,
    verified: verdict === 'confirmed',
  });
  reasons.push({ kind: 'candidate-score', score: best.score });
  return {
    conclusion: { address: best.address, name: best.name || null },
    reasons,
    evidence: plan.evidence || [],
    confidence: confidenceFromEvidence({ semanticCount, explicitVerified, verdictStatus: verdict, verdictConfidence }),
    missingEvidence: plan.missingEvidence || [],
  };
}

function explicitLimit(value, fallback, minimum = 0) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(minimum, Math.floor(n));
}

function budgetOf(opts) {
  return {
    maxToolCalls: explicitLimit(opts && opts.maxToolCalls, 24, 0),
    maxFunctions: explicitLimit(opts && opts.maxFunctions, 48, 0),
    maxDisassembly: explicitLimit(opts && opts.maxDisassembly, 50000, 0),
    timeoutMs: explicitLimit(opts && opts.timeoutMs, 10000, 1),
    isCancelled: opts && opts.isCancelled || (() => false),
  };
}

function normalizeToolRequest(step) {
  if (!step || typeof step !== 'object') return null;
  const tool = step.tool || step.name;
  if (!tool) return null;
  let args = step.args || step.arguments || [];
  if (!Array.isArray(args)) args = [args];
  return { tool: String(tool), args };
}

function instructionCost(model) {
  const n = model && Array.isArray(model.instructions) ? model.instructions.length : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Deterministic mode: no model required. */
export async function runDeterministicAgent(goal, context, opts) {
  const plan = await planAnalysisGoal(goal, context, opts);
  return { ...deterministicAnswer(plan), query: plan.query, plan, mode: 'deterministic' };
}

/**
 * Optional model adapter contract:
 *   llm.next({goal, query, observations, availableTools, budget})
 *     -> {tool, args} | {answer:{conclusion,reasons,confidence,missingEvidence}}
 */
export async function runAgent(config) {
  const cfg = config || {};
  const goal = cfg.goal || '';
  const context = cfg.context || {};
  const llm = cfg.llm || null;
  const budget = budgetOf(cfg.budget || cfg);
  if (!llm || typeof llm.next !== 'function') return runDeterministicAgent(goal, context, { ...cfg, ...budget });

  const query = typeof goal === 'string' ? compileGoal(goal) : goal;
  const started = Date.now();
  const deadlineExceeded = () => Date.now() - started >= budget.timeoutMs;
  const cancelled = () => budget.isCancelled() || deadlineExceeded();
  let disassembly = 0;
  const countedContext = typeof context.analyze === 'function' ? {
    ...context,
    analyze: async (...args) => {
      if (budget.isCancelled()) throw new Error('cancelled');
      if (deadlineExceeded()) throw new Error('timeout');
      if (disassembly >= budget.maxDisassembly) throw new Error('disassembly-budget');
      const model = await context.analyze(...args);
      if (budget.isCancelled()) throw new Error('cancelled');
      if (deadlineExceeded()) throw new Error('timeout');
      disassembly += instructionCost(model);
      if (disassembly > budget.maxDisassembly) throw new Error('disassembly-budget');
      return model;
    },
  } : context;
  const tools = createAgentTools(countedContext, { maxFunctions: budget.maxFunctions });
  const availableTools = Object.keys(tools).filter((k) => typeof tools[k] === 'function');
  const observations = [];
  const evidence = new Set();
  const functions = new Set();
  const loadedFunctionCount = () => tools.__loader && typeof tools.__loader.analysisCount === 'function' ? tools.__loader.analysisCount() : 0;
  const usedFunctionCount = () => Math.max(functions.size, loadedFunctionCount());
  let proposedAnswer = null;
  let stopReason = null;

  for (let call = 0; call < budget.maxToolCalls; call++) {
    if (budget.isCancelled()) { stopReason = 'cancelled'; break; }
    if (deadlineExceeded()) { stopReason = 'timeout'; break; }
    let step;
    try {
      const remainingMs = Math.max(1, budget.timeoutMs - (Date.now() - started));
      const controller = new AbortController();
      const external = cfg.signal;
      const abort = () => controller.abort(external?.reason ?? 'cancelled');
      if (external?.aborted) abort(); else external?.addEventListener?.('abort', abort, {once:true});
      let timer;
      try {
        step = await Promise.race([
          Promise.resolve(llm.next({
            goal, query, observations: observations.slice(), availableTools, signal:controller.signal,
            budget: {
              remainingToolCalls: budget.maxToolCalls - call,
              remainingFunctions: Math.max(0, budget.maxFunctions - usedFunctionCount()),
              remainingDisassembly: Math.max(0, budget.maxDisassembly - disassembly),
              remainingMs,
            },
          })),
          new Promise((_, reject) => { timer=setTimeout(() => { controller.abort('timeout'); reject(new Error('timeout')); }, remainingMs); }),
        ]);
      } finally {
        clearTimeout(timer); external?.removeEventListener?.('abort', abort);
      }
    } catch (err) {
      stopReason = 'model-error:' + ((err && err.message) || String(err));
      break;
    }
    if (budget.isCancelled()) { stopReason = 'cancelled'; break; }
    if (deadlineExceeded()) { stopReason = 'timeout'; break; }
    if (step && step.answer) { proposedAnswer = step.answer; break; }
    const req = normalizeToolRequest(step);
    if (!req || !Object.prototype.hasOwnProperty.call(tools, req.tool) || typeof tools[req.tool] !== 'function') {
      stopReason = 'invalid-tool-request'; break;
    }
    const addr = addressFromArgs(req.args);
    if (addr != null) {
      functions.add(addr.toString());
      if (usedFunctionCount() > budget.maxFunctions) { stopReason = 'function-budget'; break; }
    }
    let result;
    try { result = await tools[req.tool](...req.args); }
    catch (err) {
      const message = (err && err.message) || String(err);
      result = { tool: req.tool, error: message };
      if (message === 'disassembly-budget' || message === 'function-budget' || message === 'timeout' || message === 'cancelled') stopReason = message;
    }
    if (deadlineExceeded() && !stopReason) stopReason = 'timeout';
    if (disassembly > budget.maxDisassembly && !stopReason) stopReason = 'disassembly-budget';
    evidenceFromObservation(result, evidence);
    observations.push({ request: req, result });
    if (stopReason) break;
  }

  // Always ask the deterministic planner for the final proof, but never extend
  // the caller's deadline or resource budget to do so. Once the deadline has
  // expired, the combined cancellation predicate makes the planner return
  // without starting new analysis work.
  const remainingFunctions = Math.max(0, budget.maxFunctions - usedFunctionCount());
  const remainingDisassembly = Math.max(0, budget.maxDisassembly - disassembly);
  const remainingTimeout = Math.max(0, budget.timeoutMs - (Date.now() - started));
  const plan = await planAnalysisGoal(query, countedContext, {
    maxFunctions: remainingFunctions,
    maxDisassembly: remainingDisassembly,
    maxSearchResults: cfg.maxSearchResults,
    timeoutMs: remainingTimeout,
    isCancelled: cancelled,
    tools,
  });
  for (const e of plan.evidence || []) evidence.add(e);
  const deterministic = deterministicAnswer(plan);

  // The deterministic conclusion and reasons are immutable proof output. The
  // model may only lower confidence or report additional missing evidence; its
  // prose is returned separately and never promoted to a verified conclusion.
  const conclusion = deterministic.conclusion;
  const reasons = deterministic.reasons;
  let confidence = deterministic.confidence;
  let missingEvidence = deterministic.missingEvidence.slice();
  if (proposedAnswer) {
    if (Array.isArray(proposedAnswer.missingEvidence)) missingEvidence = Array.from(new Set([...missingEvidence, ...proposedAnswer.missingEvidence]));
    if (typeof proposedAnswer.confidence === 'number') confidence = Math.min(confidence, Math.max(0, proposedAnswer.confidence));
  }
  if (!evidence.size) {
    confidence = Math.min(confidence, 0.5);
    if (!missingEvidence.includes('no-deterministic-evidence')) missingEvidence.push('no-deterministic-evidence');
  }
  if (!stopReason && deadlineExceeded()) stopReason = 'timeout';
  if (stopReason && !missingEvidence.includes(stopReason)) missingEvidence.push(stopReason);

  return {
    conclusion,
    reasons,
    evidence: Array.from(evidence),
    confidence,
    missingEvidence,
    modelAnswer: proposedAnswer,
    query,
    plan,
    observations,
    mode: 'agent',
    stats: { toolCalls: observations.length, functions: usedFunctionCount(), disassembly, elapsedMs: Date.now() - started },
  };
}
