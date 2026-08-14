import { DebugSessionManager } from './session.js';
import { LocalFunctionSandboxAdapter, SymbolicAdapter, RemoteDebugAdapter, LLDBCompatibleAdapter, FridaCompatibleAdapter, ReplayAdapter } from '../adapters/index.js';
import { compileExperiment, HypothesisVerifier } from '../dynamic/experiments.js';
import { createRuntimeEvidenceRecord, evidenceFromExperiment, fuseStaticDynamic, traceToSemanticFacts } from '../runtime-evidence/index.js';
import { DebugAdapterError, asAddress, boundedInteger } from '../debug/adapter.js';

export class RuntimeAnalysisPlatform {
  constructor(options = {}) {
    this.options = options;
    this.sessions = new DebugSessionManager();
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
    if (connect) await session.connect();
    return session;
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
    session.addExperiment(experiment);
    const verifier = new HypothesisVerifier(session.adapter, ({experiment,testCase,observation,comparison}) => evidenceFromExperiment({ experiment,testCase,observation,comparison,backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id }));
    const result = await verifier.verify(experiment, options);
    const evidence = [];
    for (const item of result.cases) {
      if (item.evidence) { evidence.push(this._recordEvidence(item.evidence)); session.addObservation({ experimentId:experiment.id, caseId:item.case.id, evidenceId:item.evidence.id, verdict:item.comparison.status }); }
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
      fieldOffset:options.fieldOffset ?? null, fieldSize:options.fieldSize || 8, initial:options.initial ?? 100,
      argumentIndex:options.argumentIndex ?? 1, operation:options.operation || 'set' };
    // Without a semantic expectation this is an execution observation, not a
    // semantic confirmation. compileExperiment emits cases with expected=null.
    return this.verifyHypothesis(hypothesis, options);
  }
  async traceFunction(functionAddress, options = {}) {
    const session = this.currentSession();
    await session.adapter.launch({ address:functionAddress, ...(options.launch || options) });
    const observation = await session.adapter.resume({ maxSteps:options.maxSteps || 20000 });
    const trace = observation.trace || await session.adapter.trace({ limit:boundedInteger(options.limit,4096,1,50000,'limit') });
    for (const event of trace.events || []) session.acceptEvent(event);
    const facts = traceToSemanticFacts(trace,{sessionId:session.id,binaryHash:session.binaryHash,traceId:`fn:${asAddress(functionAddress).toString(16)}`});
    const evidence = createRuntimeEvidenceRecord({ backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id,
      experimentId:`trace:${asAddress(functionAddress).toString(16)}`,caseId:'trace',function:asAddress(functionAddress),
      input:options.launch || options,observedState:{stop:observation.stop,returnValue:observation.returnValue},branchPath:observation.branches || [],
      verdict:'inconclusive',confidence:0.5,kind:'trace',reproducibility:{replayable:true,runs:1,consistent:null} });
    this._recordEvidence(evidence);
    return { functionAddress:asAddress(functionAddress), observation, trace, facts, evidence:[evidence] };
  }
  async readRuntimeField(address, size = 8) {
    const session = this.currentSession();
    const bytes = await session.adapter.readMemory(address, boundedInteger(size,8,1,4096,'size'));
    const evidence = createRuntimeEvidenceRecord({ backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id,
      experimentId:`read:${asAddress(address).toString(16)}`,caseId:'read',address:asAddress(address),input:{address:asAddress(address),size},
      observedState:{bytes:[...bytes]},verdict:'inconclusive',confidence:0.5,kind:'memory-read',reproducibility:{replayable:true,runs:1,consistent:null} });
    this._recordEvidence(evidence);
    return { address:asAddress(address), bytes, evidence:[evidence] };
  }
  fuse(staticCandidate, runtimeEvidence = null) { return fuseStaticDynamic(staticCandidate, runtimeEvidence || this.evidence); }
  replayShape(experimentId = null) { return this.currentSession().replayShape(experimentId); }
}

export { DebugSessionManager } from './session.js';
export { LocalFunctionSandboxAdapter, SymbolicAdapter, RemoteDebugAdapter, LLDBCompatibleAdapter, FridaCompatibleAdapter, ReplayAdapter } from '../adapters/index.js';
export { compileExperiment, generateDifferentialInputs, compareExpected, classifyHypothesis, HypothesisVerifier } from '../dynamic/experiments.js';
export { createRuntimeEvidenceRecord, evidenceFromExperiment, traceToSemanticFacts, dynamicTypeAnnotation, fuseStaticDynamic, createRuntimeAgentTools, registerRuntimeAgentTools, RUNTIME_TOOL_NAMES } from '../runtime-evidence/index.js';
