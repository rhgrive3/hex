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

function deterministicAnswer(plan) {
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
  const verified = !!(best.verification && (best.verification.verified || (best.verification.results && best.verification.results.length)));
  const semanticCount = (best.semanticFacts || []).length;
  return {
    conclusion: { address: best.address, name: best.name || null },
    reasons: [
      { kind: 'semantic-facts', count: semanticCount },
      { kind: 'deterministic-verification', verified },
      { kind: 'candidate-score', score: best.score },
    ],
    evidence: plan.evidence || [],
    confidence: verified ? 0.98 : (semanticCount ? 0.78 : 0.45),
    missingEvidence: plan.missingEvidence || [],
  };
}

function budgetOf(opts) {
  return {
    maxToolCalls: Math.max(1, opts && opts.maxToolCalls || 24),
    maxFunctions: Math.max(1, opts && opts.maxFunctions || 48),
    maxDisassembly: Math.max(100, opts && opts.maxDisassembly || 50000),
    timeoutMs: Math.max(100, opts && opts.timeoutMs || 10000),
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
  const tools = createAgentTools(context, { maxFunctions: budget.maxFunctions });
  const availableTools = Object.keys(tools).filter((k) => typeof tools[k] === 'function');
  const observations = [];
  const evidence = new Set();
  const functions = new Set();
  let disassembly = 0;
  const started = Date.now();
  let proposedAnswer = null;
  let stopReason = null;

  for (let call = 0; call < budget.maxToolCalls; call++) {
    if (budget.isCancelled()) { stopReason = 'cancelled'; break; }
    if (Date.now() - started > budget.timeoutMs) { stopReason = 'timeout'; break; }
    let step;
    try {
      step = await llm.next({
        goal, query, observations: observations.slice(), availableTools,
        budget: {
          remainingToolCalls: budget.maxToolCalls - call,
          remainingFunctions: budget.maxFunctions - functions.size,
          remainingDisassembly: budget.maxDisassembly - disassembly,
        },
      });
    } catch (err) {
      stopReason = 'model-error:' + ((err && err.message) || String(err));
      break;
    }
    if (step && step.answer) { proposedAnswer = step.answer; break; }
    const req = normalizeToolRequest(step);
    if (!req || !Object.prototype.hasOwnProperty.call(tools, req.tool) || typeof tools[req.tool] !== 'function') {
      stopReason = 'invalid-tool-request'; break;
    }
    const addr = addressFromArgs(req.args);
    if (addr != null) {
      functions.add(addr.toString());
      if (functions.size > budget.maxFunctions) { stopReason = 'function-budget'; break; }
    }
    let result;
    try { result = await tools[req.tool](...req.args); }
    catch (err) { result = { tool: req.tool, error: (err && err.message) || String(err) }; }
    if (result && result.instructions != null) disassembly += Number(result.instructions) || 0;
    if (disassembly > budget.maxDisassembly) { stopReason = 'disassembly-budget'; break; }
    evidenceFromObservation(result, evidence);
    observations.push({ request: req, result });
  }

  // Always run the deterministic planner as the final verifier. It can reuse the
  // same context but it does not accept the model's conclusion as evidence.
  const plan = await planAnalysisGoal(query, context, {
    maxFunctions: Math.max(4, budget.maxFunctions - functions.size),
    maxSearchResults: cfg.maxSearchResults,
    timeoutMs: Math.max(100, budget.timeoutMs - (Date.now() - started)),
    isCancelled: budget.isCancelled,
    tools,
  });
  for (const e of plan.evidence || []) evidence.add(e);
  const deterministic = deterministicAnswer(plan);

  let conclusion = deterministic.conclusion;
  let reasons = deterministic.reasons;
  let confidence = deterministic.confidence;
  let missingEvidence = deterministic.missingEvidence.slice();
  if (proposedAnswer) {
    // The model may phrase/choose among already-proved candidates, but cannot
    // create evidence or raise confidence beyond deterministic verification.
    if (proposedAnswer.conclusion != null) conclusion = proposedAnswer.conclusion;
    if (Array.isArray(proposedAnswer.reasons)) reasons = proposedAnswer.reasons;
    if (Array.isArray(proposedAnswer.missingEvidence)) missingEvidence = Array.from(new Set([...missingEvidence, ...proposedAnswer.missingEvidence]));
    if (typeof proposedAnswer.confidence === 'number') confidence = Math.min(confidence, Math.max(0, proposedAnswer.confidence));
  }
  if (!evidence.size) {
    confidence = Math.min(confidence, 0.5);
    if (!missingEvidence.includes('no-deterministic-evidence')) missingEvidence.push('no-deterministic-evidence');
  }
  if (stopReason && !missingEvidence.includes(stopReason)) missingEvidence.push(stopReason);

  return {
    conclusion,
    reasons,
    evidence: Array.from(evidence),
    confidence,
    missingEvidence,
    query,
    plan,
    observations,
    mode: 'agent',
    stats: { toolCalls: observations.length, functions: functions.size, disassembly, elapsedMs: Date.now() - started },
  };
}
