import { boundedInteger } from '../debug/adapter.js';
import { GROUP } from '../evidence.js';

function nowIso() { return new Date().toISOString(); }
function safeConfidence(value, fallback = 0.5) { const n=Number(value); return Number.isFinite(n) ? Math.max(0,Math.min(1,n)) : fallback; }
function idPart(value) { return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_.:-]/g,'_').slice(0,160); }

export function createRuntimeEvidenceRecord(input = {}) {
  const traceGroup = input.provenanceGroup || `runtime:${idPart(input.sessionId || 'session')}:${idPart(input.experimentId || input.function || 'observation')}:${idPart(input.caseId || 'case')}`;
  return {
    id:input.id || `${traceGroup}:${idPart(input.kind || 'observation')}`,
    source:'runtime', backend:String(input.backend || 'unknown').slice(0,128), binaryHash:input.binaryHash || null,
    function:input.function == null ? null : input.function, address:input.address == null ? null : input.address,
    input:input.input || null, initialState:input.initialState || null, observedState:input.observedState || null,
    branchPath:input.branchPath || [], timestamp:input.timestamp || nowIso(), sessionId:input.sessionId || null,
    reproducibility:input.reproducibility || { replayable:false, runs:1, consistent:null },
    confidence:safeConfidence(input.confidence), verdict:input.verdict || 'inconclusive', kind:input.kind || 'observation',
    provenance:{ group:GROUP.RUNTIME, observationGroup:traceGroup, independent:false, parent:input.parentEvidenceId || null },
  };
}

export function evidenceFromExperiment({ experiment, testCase, observation, comparison, backend = 'unknown', binaryHash = null, sessionId = null }) {
  const group = `runtime:${idPart(sessionId || 'session')}:${idPart(experiment.id)}:${idPart(testCase.id)}`;
  return createRuntimeEvidenceRecord({
    backend, binaryHash:binaryHash || experiment.binaryHash, function:experiment.functionAddress, input:testCase.input,
    initialState:testCase.initialState, observedState:{ returnValue:observation.returnValue, registerDelta:observation.registerDelta, memoryDelta:observation.memoryDelta, stop:observation.stop },
    branchPath:observation.branches || [], sessionId, experimentId:experiment.id, caseId:testCase.id, verdict:comparison.status,
    confidence:comparison.status === 'supported' ? 0.8 : comparison.status === 'contradicted' ? 0.9 : 0.35,
    kind:'experiment', provenanceGroup:group, reproducibility:{ replayable:true, runs:1, consistent:null }
  });
}

export function traceToSemanticFacts(trace, context = {}) {
  const events = trace && Array.isArray(trace.events) ? trace.events : Array.isArray(trace) ? trace : [];
  const limit = boundedInteger(context.limit, 10000, 1, 50000, 'fact limit');
  const group = context.provenanceGroup || `trace:${idPart(context.sessionId || 'session')}:${idPart(context.traceId || 'trace')}`;
  const facts = [];
  for (const event of events) {
    if (facts.length >= limit) break;
    const common = { runtime:true, sessionId:context.sessionId || null, binaryHash:context.binaryHash || null, provenance:{ group:GROUP.RUNTIME, observationGroup:group, independent:false }, address:event.address ?? null, confidence:safeConfidence(context.confidence,0.8) };
    if (event.type === 'memory-read') facts.push({ ...common, kind:'reads-field', location:{ address:event.address, region:event.region, size:event.size }, value:event.value });
    else if (event.type === 'memory-write') facts.push({ ...common, kind:'writes-field', location:{ address:event.address, region:event.region, size:event.size }, before:event.before, value:event.after });
    else if (event.type === 'call') facts.push({ ...common, kind:'calls-target', target:event.target ?? null, text:event.text || null });
    else if (event.type === 'branch') facts.push({ ...common, kind:'branch-taken', target:event.next ?? null, taken:event.taken !== false, text:event.text || null });
    else if (event.type === 'return') facts.push({ ...common, kind:'returns-value', value:event.value ?? null, text:event.text || null });
    else if (event.type === 'objc-dispatch') facts.push({ ...common, kind:'objc-dispatch', className:event.className || null, selector:event.selector || null, imp:event.imp || null });
    else if (event.type === 'swift-dispatch') facts.push({ ...common, kind:'swift-dispatch', dynamicType:event.dynamicType || null, metadata:event.metadata || null, witnessTarget:event.witnessTarget || null, vtableTarget:event.vtableTarget || null, asyncContext:event.asyncContext || null });
  }
  return facts;
}

export function compareRuntimeDispatch(staticTargets, runtimeEvent) {
  const candidates = (Array.isArray(staticTargets) ? staticTargets : [staticTargets]).filter((v) => v != null).map((v) => {
    try { return typeof v === 'bigint' ? v : BigInt(v); } catch { return null; }
  }).filter((v) => v != null);
  const observedRaw = runtimeEvent && (runtimeEvent.imp ?? runtimeEvent.witnessTarget ?? runtimeEvent.vtableTarget ?? runtimeEvent.target);
  if (observedRaw == null) return { status:'inconclusive', observed:null, candidates };
  let observed; try { observed = typeof observedRaw === 'bigint' ? observedRaw : BigInt(observedRaw); } catch { return { status:'inconclusive', observed:null, candidates }; }
  if (!candidates.length) return { status:'supported', observed, candidates, reason:'runtime-target-observed-without-static-candidate' };
  return candidates.some((c) => c === observed)
    ? { status:'supported', observed, candidates, reason:'runtime-target-matches-static-candidate' }
    : { status:'contradicted', observed, candidates, reason:'runtime-target-not-in-static-candidates' };
}

export function dynamicTypeAnnotation(event, context = {}) {
  if (!event || (!event.dynamicType && !event.className)) return null;
  return {
    kind:'runtime-type-annotation', candidate:event.dynamicType || event.className, address:event.object || event.address || null,
    source:'runtime', binaryHash:context.binaryHash || null, sessionId:context.sessionId || null, backend:context.backend || null,
    confidence:safeConfidence(context.confidence,0.85), permanent:false, timestamp:nowIso(),
  };
}

export function fuseStaticDynamic(staticCandidate, runtimeEvidence = []) {
  const evidence = runtimeEvidence.filter(Boolean);
  const groups = new Map();
  for (const item of evidence) {
    const group = item.provenance && (item.provenance.observationGroup || item.provenance.group) || item.id || Symbol('evidence');
    if (!groups.has(group)) groups.set(group,item);
  }
  const independent = [...groups.values()];
  const contradictions = independent.filter((e) => e.verdict === 'contradicted').length;
  const support = independent.filter((e) => e.verdict === 'supported' || e.verdict === 'confirmed').length;
  const base = safeConfidence(staticCandidate && staticCandidate.confidence,0.5);
  let confidence = base; let status = 'inconclusive';
  if (contradictions) { confidence = Math.max(0.02, base * Math.pow(0.35,contradictions)); status='contradicted'; }
  else if (support) { confidence = Math.min(0.98, 1 - (1-base) * Math.pow(0.55,support)); status='supported'; }
  return { candidate:staticCandidate, status, confidence, runtimeGroups:independent.length, support, contradictions, evidence:independent.map((e) => e.id) };
}

export function createRuntimeAgentTools(platform) {
  const requirePlatform = () => { if (!platform) throw new Error('runtime-platform-unavailable'); return platform; };
  const ensureEvidence = (result) => { if (!result || !result.evidence || (Array.isArray(result.evidence) && !result.evidence.length)) throw new Error('runtime-evidence-required'); return result; };
  return {
    runtime_verify_function: async (functionAddress, options) => ensureEvidence(await requirePlatform().verifyFunction(functionAddress, options || {})),
    run_experiment: async (experiment, options) => ensureEvidence(await requirePlatform().runExperiment(experiment, options || {})),
    trace_function: async (functionAddress, options) => ensureEvidence(await requirePlatform().traceFunction(functionAddress, options || {})),
    read_runtime_field: async (address, size = 8) => ensureEvidence(await requirePlatform().readRuntimeField(address, size)),
    compare_before_after: async (experiment, options) => ensureEvidence(await requirePlatform().runExperiment(experiment, { ...(options || {}), compareOnly:true })),
    verify_hypothesis: async (hypothesis, options) => ensureEvidence(await requirePlatform().verifyHypothesis(hypothesis, options || {})),
  };
}

export function registerRuntimeAgentTools(target, platform) {
  if (!target || typeof target !== 'object') throw new Error('runtime-tool-target-required');
  Object.assign(target, createRuntimeAgentTools(platform));
  return target;
}

export const RUNTIME_TOOL_NAMES = Object.freeze(['runtime_verify_function','run_experiment','trace_function','read_runtime_field','compare_before_after','verify_hypothesis']);
