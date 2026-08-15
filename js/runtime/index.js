import { DebugSessionManager } from './session.js';
import { LocalFunctionSandboxAdapter, EmulatorAdapter, SymbolicAdapter, RemoteDebugAdapter, LLDBCompatibleAdapter, FridaCompatibleAdapter, ReplayAdapter } from '../adapters/index.js';
import { compileExperiment, HypothesisVerifier } from '../dynamic/experiments.js';
import { createRuntimeEvidenceRecord, evidenceFromExperiment, fuseStaticDynamic, traceToSemanticFacts } from '../runtime-evidence/index.js';
import { DebugAdapterError, asAddress, boundedInteger } from '../debug/adapter.js';

function operationController(session, externalSignal) {
  const controller = session.controller();
  let listener = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason || 'cancelled');
    else {
      listener = () => controller.abort(externalSignal.reason || 'cancelled');
      externalSignal.addEventListener('abort', listener, { once:true });
    }
  }
  return {
    signal:controller.signal,
    release() {
      if (externalSignal && listener) externalSignal.removeEventListener('abort',listener);
      session.releaseController(controller);
    }
  };
}

function launchOptionsForTrace(functionAddress, options) {
  const source = options && options.launch ? options.launch : options || {};
  const launch = { ...source };
  for (const key of ['maxSteps','limit','timeoutMs','signal','onProgress','launch']) delete launch[key];
  launch.address = asAddress(functionAddress);
  delete launch.functionAddress;
  return launch;
}

export class RuntimeAnalysisPlatform {
  constructor(options = {}) {
    this.options = options;
    this.sessions = new DebugSessionManager(options.sessions || {});
    this.adapters = new Map();
    this.evidence = [];
    if (options.localIO) this.registerAdapter('local', new LocalFunctionSandboxAdapter(options.localIO, options.local || {}));
    if (options.symbolic !== false) this.registerAdapter('symbolic', new SymbolicAdapter(options.symbolic || {}));
  }
  registerAdapter(name, adapter) {
    if (!adapter) throw new DebugAdapterError('adapter','adapter is required');
    this.adapters.set(String(name), adapter);
    return adapter;
  }
  adapter(name = null) {
    if (name) return this.adapters.get(String(name)) || null;
    const session = this.sessions.current;
    return session ? session.adapter : this.adapters.get('local') || this.adapters.values().next().value || null;
  }
  createRemote(name, transport, options = {}) {
    const kind = options.kind || 'remote';
    const adapter = kind === 'lldb' ? new LLDBCompatibleAdapter(transport, options) : kind === 'frida' ? new FridaCompatibleAdapter(transport, options) : new RemoteDebugAdapter(transport, options);
    return this.registerAdapter(name, adapter);
  }
  createReplay(name, recording, options = {}) { return this.registerAdapter(name, new ReplayAdapter(recording, options)); }
  async startSession({ adapter = 'local', binaryHash = null, trace = {}, connect = true } = {}) {
    const instance = typeof adapter === 'string' ? this.adapter(adapter) : adapter;
    if (!instance) throw new DebugAdapterError('adapter-not-found',`debug adapter not found: ${adapter}`);
    const session = this.sessions.create(instance,{binaryHash,trace});
    if (!connect) return session;
    try { await session.connect(); return session; }
    catch (error) { try { await this.sessions.close(session.id); } catch {} throw error; }
  }
  currentSession(required = true) {
    const session = this.sessions.current;
    if (!session && required) throw new DebugAdapterError('no-session','no active runtime session');
    return session;
  }
  _recordEvidence(record) {
    if (!record) return null;
    this.evidence.push(record);
    if (this.evidence.length > 4096) this.evidence.shift();
    return record;
  }
  async runExperiment(experiment, options = {}) {
    const session = this.currentSession();
    if (!experiment || typeof experiment !== 'object' || !Array.isArray(experiment.cases)) throw new DebugAdapterError('invalid-experiment','experiment must contain cases');
    if (experiment.binaryHash && session.binaryHash && experiment.binaryHash !== session.binaryHash) throw new DebugAdapterError('binary-version-mismatch','experiment binary hash does not match the active runtime session',{experimentHash:experiment.binaryHash,sessionHash:session.binaryHash});
    const scopedExperiment = experiment.binaryHash || !session.binaryHash ? experiment : { ...experiment, binaryHash:session.binaryHash };
    session.addExperiment(scopedExperiment);
    const operation = operationController(session, options.signal);
    const verifier = new HypothesisVerifier(session.adapter, ({experiment:testExperiment,testCase,observation,comparison}) => evidenceFromExperiment({ experiment:testExperiment,testCase,observation,comparison,backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id }));
    let result;
    try { result = await verifier.verify(scopedExperiment, { ...options, signal:operation.signal }); }
    finally { operation.release(); }
    const evidence = [];
    for (const item of result.cases) {
      if (item.evidence) { evidence.push(this._recordEvidence(item.evidence)); session.addObservation({ experimentId:scopedExperiment.id, caseId:item.case.id, evidenceId:item.evidence.id, verdict:item.comparison.status }); }
    }
    return { ...result, evidence };
  }
  async verifyHypothesis(hypothesis, options = {}) {
    const session = this.currentSession();
    const experiment = compileExperiment(hypothesis,{ ...options,binaryHash:session.binaryHash });
    return this.runExperiment(experiment, options);
  }
  async verifyFunction(functionAddress, options = {}) {
    const hypothesis = options.hypothesis || { id:`verify:${asAddress(functionAddress).toString(16)}`, functionAddress,
      fieldOffset:options.fieldOffset ?? null, fieldSize:options.fieldSize ?? 8, initial:options.initial ?? 100,
      argumentIndex:options.argumentIndex ?? 1, operation:options.operation || 'set' };
    // Without a semantic expectation this is an execution observation, not a
    // semantic confirmation. compileExperiment emits cases with expected=null.
    return this.verifyHypothesis(hypothesis, options);
  }
  async traceFunction(functionAddress, options = {}) {
    const session = this.currentSession();
    const requestedAddress = asAddress(functionAddress);
    const launchSpec = launchOptionsForTrace(requestedAddress,options);
    const operation = operationController(session,options.signal);
    let observation, trace;
    const started=Date.now();
    try {
      await session.adapter.launch(launchSpec,{signal:operation.signal});
      observation = await session.adapter.resume({ maxSteps:options.maxSteps ?? 20000, timeoutMs:options.timeoutMs, signal:operation.signal });
      if (observation.trace) trace=observation.trace;
      else {
        const timeoutMs=options.timeoutMs == null ? undefined : Math.max(1, Number(options.timeoutMs) - (Date.now()-started));
        trace = await session.adapter.trace({ limit:boundedInteger(options.limit,4096,1,50000,'limit'), timeoutMs, signal:operation.signal });
      }
    } finally { operation.release(); }
    for (const event of trace.events || []) session.acceptEvent(event);
    const facts = traceToSemanticFacts(trace,{sessionId:session.id,binaryHash:session.binaryHash,traceId:`fn:${requestedAddress.toString(16)}`});
    const evidence = createRuntimeEvidenceRecord({ backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id,
      experimentId:`trace:${requestedAddress.toString(16)}`,caseId:'trace',function:requestedAddress,
      input:launchSpec,observedState:{stop:observation.stop,returnValue:observation.returnValue},branchPath:observation.branches || [],
      verdict:'inconclusive',confidence:0.5,kind:'trace',reproducibility:{replayable:true,runs:1,consistent:null} });
    this._recordEvidence(evidence);
    return { functionAddress:requestedAddress, observation, trace, facts, evidence:[evidence] };
  }
  async readRuntimeField(address, size = 8) {
    const session = this.currentSession();
    const n = Number(size == null ? 8 : size);
    if (!Number.isSafeInteger(n) || n < 1) throw new DebugAdapterError('invalid-size','runtime field size must be a positive safe integer');
    if (n > 4096) throw new DebugAdapterError('too-large','runtime field read exceeds 4096 bytes');
    const bytes = await session.adapter.readMemory(address, n);
    if (!(bytes instanceof Uint8Array) || bytes.length !== n) throw new DebugAdapterError('short-read',`runtime field read returned ${bytes && bytes.length || 0} of ${n} bytes`);
    const evidence = createRuntimeEvidenceRecord({ backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id,
      experimentId:`read:${asAddress(address).toString(16)}`,caseId:'read',address:asAddress(address),input:{address:asAddress(address),size:n},
      observedState:{bytes:[...bytes]},verdict:'inconclusive',confidence:0.5,kind:'memory-read',reproducibility:{replayable:true,runs:1,consistent:null} });
    this._recordEvidence(evidence);
    return { address:asAddress(address), bytes, evidence:[evidence] };
  }
  fuse(staticCandidate, runtimeEvidence = null) { return fuseStaticDynamic(staticCandidate, runtimeEvidence || this.evidence); }
  replayShape(experimentId = null) { return this.currentSession().replayShape(experimentId); }
  async replayExperiment(recording, options = {}) {
    const session = this.currentSession();
    const source = recording || {};
    const original = source.experiment || (Array.isArray(source.experiments) ? source.experiments[0] : null);
    if (!original) throw new DebugAdapterError('replay-missing-experiment','replay recording has no experiment');
    let functionAddress = asAddress(original.functionAddress);
    const sourceHash = source.binaryHash || original.binaryHash || null;
    if (sourceHash && session.binaryHash && sourceHash !== session.binaryHash) {
      const resolveFunction = options.resolveFunction || this.options.resolveFunction;
      if (typeof resolveFunction !== 'function') return { status:'unsupported', reason:'binary-version-mismatch', sourceHash, targetHash:session.binaryHash, evidence:[] };
      const resolved = await resolveFunction({ functionAddress, fingerprint:original.functionFingerprint || source.functionFingerprint || null, sourceBinaryHash:sourceHash, targetBinaryHash:session.binaryHash });
      if (resolved == null) return { status:'unsupported', reason:'function-re-resolution-failed', sourceHash, targetHash:session.binaryHash, evidence:[] };
      functionAddress = asAddress(resolved.address ?? resolved);
    }
    const experiment = { ...original, functionAddress, binaryHash:session.binaryHash || sourceHash };
    return this.runExperiment(experiment,{ ...options,replay:true });
  }
}

export { DebugSessionManager } from './session.js';
export { LocalFunctionSandboxAdapter, EmulatorAdapter, SymbolicAdapter, RemoteDebugAdapter, LLDBCompatibleAdapter, FridaCompatibleAdapter, ReplayAdapter } from '../adapters/index.js';
export { compileExperiment, generateDifferentialInputs, compareExpected, classifyHypothesis, HypothesisVerifier } from '../dynamic/experiments.js';
export { createRuntimeEvidenceRecord, evidenceFromExperiment, traceToSemanticFacts, compareRuntimeDispatch, dynamicTypeAnnotation, fuseStaticDynamic, createRuntimeAgentTools, registerRuntimeAgentTools, RUNTIME_TOOL_NAMES } from '../runtime-evidence/index.js';
