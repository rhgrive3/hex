from pathlib import Path

# #173 + #542 runtime evidence identity/replayability.
p=Path('js/runtime-evidence/index.js'); s=p.read_text()
s=s.replace("backend:String(input.backend || 'unknown').slice(0,128), binaryHash:input.binaryHash || null,", "backend:String(input.backend || 'unknown').slice(0,128), binaryHash:input.binaryHash || null, sliceIdentity:input.sliceIdentity || null,")
old="""export function evidenceFromExperiment({ experiment, testCase, observation, comparison, backend = 'unknown', binaryHash = null, sessionId = null }) {
  const group = `runtime:${idPart(sessionId || 'session')}:${idPart(experiment.id)}:${idPart(testCase.id)}`;
  return createRuntimeEvidenceRecord({
    backend, binaryHash:binaryHash || experiment.binaryHash, function:experiment.functionAddress, input:testCase.input,"""
new="""export function evidenceFromExperiment({ experiment, testCase, observation, comparison, backend = 'unknown', binaryHash = null, sliceIdentity = null, sessionId = null, replayable = false }) {
  const group = `runtime:${idPart(sessionId || 'session')}:${idPart(experiment.id)}:${idPart(testCase.id)}`;
  return createRuntimeEvidenceRecord({
    backend, binaryHash:binaryHash || experiment.binaryHash, sliceIdentity, function:experiment.functionAddress, input:testCase.input,"""
if old not in s: raise SystemExit('evidenceFromExperiment anchor missing')
s=s.replace(old,new,1)
s=s.replace("kind:'experiment', provenanceGroup:group, reproducibility:{ replayable:true, runs:1, consistent:null }", "kind:'experiment', provenanceGroup:group, reproducibility:{ replayable:!!replayable, runs:1, consistent:null }")
# Fusion: when runtime evidence is slice-scoped, a static candidate must explicitly match that slice.
old="""  const candidateFunction = staticCandidate && staticCandidate.functionAddress != null ? staticCandidate.functionAddress : null;
  const evidence = runtimeEvidence.filter"""
new="""  const candidateFunction = staticCandidate && staticCandidate.functionAddress != null ? staticCandidate.functionAddress : null;
  const candidateSlice = staticCandidate && staticCandidate.sliceIdentity || null;
  const evidence = runtimeEvidence.filter"""
s=s.replace(old,new,1)
old="""    if (candidateHash && item.binaryHash !== candidateHash) { ignoredEvidence++; continue; }
    if (candidateFunction != null && (item.function == null || !sameAddress(candidateFunction,item.function))) { ignoredEvidence++; continue; }
    compatible.push(item);"""
new="""    if (candidateHash && item.binaryHash !== candidateHash) { ignoredEvidence++; continue; }
    if (item.sliceIdentity && (!candidateSlice || item.sliceIdentity !== candidateSlice)) { ignoredEvidence++; continue; }
    if (candidateFunction != null && (item.function == null || !sameAddress(candidateFunction,item.function))) { ignoredEvidence++; continue; }
    compatible.push(item);"""
if old not in s: raise SystemExit('fusion compatibility anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

# #540 verifier coverage contract: exhaustive success required for confirmed.
p=Path('js/dynamic/experiments.js'); s=p.read_text()
start=s.index('export function classifyHypothesis(caseResults) {')
end=s.index('\nexport class HypothesisVerifier',start)
new_classify=r'''export function classifyHypothesis(caseResults, coverage = null) {
  const results = Array.isArray(caseResults) ? caseResults : [];
  const cov = coverage || { planned:results.length, executed:results.length, complete:true, truncated:false, reasons:[] };
  if (!results.length) return { status:'inconclusive', confidence:0, reason:'no-runtime-cases', coverage:cov };
  const usable = results.filter((r) => r.comparison && r.comparison.status !== 'unsupported');
  const contradicted = usable.filter((r) => r.comparison.status === 'contradicted').length;
  const supported = usable.filter((r) => r.comparison.status === 'supported').length;
  if (contradicted) return { status:'contradicted', confidence:Math.min(0.99, 0.7 + contradicted * 0.08), supported, contradicted, total:results.length, coverage:cov };
  if (!usable.length) return { status:'unsupported', confidence:0, supported:0, contradicted:0, total:results.length, coverage:cov };
  if (supported && supported === results.length && cov.complete === true && supported === cov.planned) {
    return { status:'confirmed', confidence:Math.min(0.98, 0.75 + supported * 0.04), supported, contradicted:0, total:results.length, coverage:cov };
  }
  if (supported) return { status:'supported', confidence:Math.min(0.85, 0.55 + supported * 0.05), supported, contradicted:0, total:results.length, coverage:cov, reason:cov.complete ? 'supported-observations' : 'partial-runtime-coverage' };
  return { status:'inconclusive', confidence:0.25, supported:0, contradicted:0, total:results.length, coverage:cov };
}
'''
s=s[:start]+new_classify+s[end:]
old="""  async verify(experiment, options = {}) {
    const results = []; const maxCases = boundedInteger(options.maxCases, experiment.cases.length, 1, 64, 'maxCases');
    for (const testCase of experiment.cases.slice(0,maxCases)) {"""
new="""  async verify(experiment, options = {}) {
    const results = []; const maxCases = boundedInteger(options.maxCases, experiment.cases.length, 1, 64, 'maxCases');
    const planned = experiment.cases.length;
    const reasons = [];
    if (maxCases < planned) reasons.push('max-cases');
    let cancelled = false, stoppedOnContradiction = false;
    for (const testCase of experiment.cases.slice(0,maxCases)) {"""
if old not in s: raise SystemExit('verifier start anchor missing')
s=s.replace(old,new,1)
old="""      if (comparison.status === 'unsupported' && observation.stop && observation.stop.kind === 'cancelled') break;
      if (options.stopOnContradiction !== false && comparison.status === 'contradicted') break;
    }
    return { experimentId:experiment.id, verdict:classifyHypothesis(results), cases:results };"""
new="""      if (comparison.status === 'unsupported' && observation.stop && observation.stop.kind === 'cancelled') { cancelled=true; reasons.push('cancelled'); break; }
      if (options.stopOnContradiction !== false && comparison.status === 'contradicted') { stoppedOnContradiction=true; reasons.push('stop-on-contradiction'); break; }
    }
    const unsupported=results.filter((r)=>r.comparison?.status==='unsupported').length;
    if(unsupported) reasons.push('unsupported-cases');
    const complete=results.length===planned && unsupported===0 && !cancelled;
    const coverage={planned,executed:results.length,complete,truncated:results.length<planned,cancelled,stoppedOnContradiction,unsupported,reasons:[...new Set(reasons)]};
    return { experimentId:experiment.id, verdict:classifyHypothesis(results,coverage), coverage, cases:results };"""
if old not in s: raise SystemExit('verifier return anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

# #173 RuntimeAnalysisPlatform derives experiment replayability from actual adapter/recording.
p=Path('js/runtime/index.js'); s=p.read_text()
old="""    const verifier = new HypothesisVerifier(session.adapter, ({experiment:testExperiment,testCase,observation,comparison}) => evidenceFromExperiment({ experiment:testExperiment,testCase,observation,comparison,backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id }));"""
new="""    const verifier = new HypothesisVerifier(session.adapter, ({experiment:testExperiment,testCase,observation,comparison}) => evidenceFromExperiment({
      experiment:testExperiment,testCase,observation,comparison,backend:session.backend,binaryHash:session.binaryHash,
      sliceIdentity:this.options.sliceIdentity || null,sessionId:session.id,
      replayable:isReplayable(session.adapter,observation,observation?.trace || null)
    }));"""
if old not in s: raise SystemExit('experiment evidence factory anchor missing')
s=s.replace(old,new,1)
s=s.replace("backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id,\n      experimentId:`trace", "backend:session.backend,binaryHash:session.binaryHash,sliceIdentity:this.options.sliceIdentity || null,sessionId:session.id,\n      experimentId:`trace",1)
s=s.replace("backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id,\n      experimentId:`read", "backend:session.backend,binaryHash:session.binaryHash,sliceIdentity:this.options.sliceIdentity || null,sessionId:session.id,\n      experimentId:`read",1)
p.write_text(s)

# #542 App runtime identity = authoritative content hash + exact active slice.
p=Path('js/runtime/app-runtime.js'); s=p.read_text()
start=s.index('function currentFileToken(app) {')
end=s.index('\n/**\n * Build the narrow I/O surface',start)
identity=r'''function currentFileToken(app) {
  return app?.store?.get?.('fileInfo') || null;
}
function activeSliceIdentity(app) {
  const info=currentFileToken(app);
  const index=Number(app?.store?.get?.('sliceIndex') ?? -1);
  const slice=index>=0 ? info?.slices?.[index] : null;
  const detail=slice?.info || {};
  const arch=String(slice?.capability?.architecture || detail.architecture || detail.cpuSub || detail.cpu || app?.store?.get?.('architecture') || 'unknown');
  const uuid=detail.uuid || null;
  return `slice:${index}:${uuid || '-'}:${arch}`;
}
async function binaryHashOf(app) {
  const info=currentFileToken(app);
  const existing=info?.hash || info?.sha256 || app?.project?.binaryHash || app?.backend?.contentHash || null;
  if(existing) return existing;
  if(typeof app?.backend?.ensureContentHash === 'function') {
    try { return await app.backend.ensureContentHash(); } catch { return null; }
  }
  return null;
}
export async function runtimeIdentityForApp(app) {
  const contentHash=await binaryHashOf(app);
  const sliceIdentity=activeSliceIdentity(app);
  return {contentHash,sliceIdentity,key:`${contentHash || 'unhashed'}|${sliceIdentity}`};
}
'''
s=s[:start]+identity+s[end:]
# Runtime platform identity logic.
start=s.index('export async function runtimePlatformForApp(app) {')
end=s.index('\nexport function runtimeEvidenceForApp',start)
platform=r'''export async function runtimePlatformForApp(app) {
  if (!app) throw new Error('runtime app is required');
  const identity = await runtimeIdentityForApp(app);
  if (!identity.contentHash) throw new Error('runtime binary identity is unavailable');
  let state = states.get(app);
  if (state && state.identityKey !== identity.key) {
    await disposeState(state);
    states.delete(app);
    state = null;
  }
  if (!state) {
    const platform = new RuntimeAnalysisPlatform({
      localIO: createAppRuntimeIO(app),
      sessions: { maxSessions: 2 },
      sliceIdentity: identity.sliceIdentity,
    });
    state = { platform, fileToken:currentFileToken(app), identityKey:identity.key, identity };
    states.set(app, state);
  }
  if (!state.platform.sessions.current) {
    await state.platform.startSession({ adapter:'local', binaryHash:identity.contentHash, connect:true });
  }
  return state.platform;
}
'''
s=s[:start]+platform+s[end:]
old="""export function runtimeEvidenceForApp(app, functionAddress = null) {
  const state = states.get(app);
  if (!state || state.fileToken !== currentFileToken(app)) return [];
  const evidence = Array.isArray(state.platform?.evidence) ? state.platform.evidence : [];"""
new="""export function runtimeEvidenceForApp(app, functionAddress = null) {
  const state = states.get(app);
  const sliceIdentity=activeSliceIdentity(app);
  if (!state || state.fileToken !== currentFileToken(app) || state.identity?.sliceIdentity !== sliceIdentity) return [];
  const evidence = (Array.isArray(state.platform?.evidence) ? state.platform.evidence : []).filter((item)=>item?.sliceIdentity===sliceIdentity && item?.binaryHash===state.identity?.contentHash);"""
if old not in s: raise SystemExit('runtimeEvidenceForApp anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

# #255 Product AI must not promote any observation's existence to verified.
p=Path('js/ai/ui/hex-context.js'); s=p.read_text()
old="""        const results = runtimeEvidenceForApp(app, addr).slice(-limit);
        return { results, returned: results.length, verified: results.length > 0 };"""
new="""        const results = runtimeEvidenceForApp(app, addr).slice(-limit);
        const completeConfirmed = results.filter((item)=>item?.verdict==='confirmed' && item?.observedState?.factsComplete !== false && item?.reproducibility?.replayable === true);
        const contradicted = results.filter((item)=>item?.verdict==='contradicted').length;
        return {
          results, returned:results.length,
          status:contradicted ? 'contradicted' : completeConfirmed.length ? 'confirmed' : results.length ? 'observed' : 'none',
          verified:completeConfirmed.length > 0 && contradicted === 0,
          verification:{confirmedCompleteReplayable:completeConfirmed.length,contradictions:contradicted,total:results.length}
        };"""
if old not in s: raise SystemExit('AI runtime observations anchor missing')
s=s.replace(old,new,1)
p.write_text(s)
