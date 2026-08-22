import { DebugAdapterError, boundedInteger } from '../debug/adapter.js';
import { deepFreeze } from '../core/identity/index.js';
import { RuntimeProviderSession, createRuntimeProviderDescriptor } from './provider.js';
import { createRuntimeEvent, createRuntimeEventBatch } from './events.js';
import { RuntimeEvidenceBridge } from './evidence-bridge.js';

const TERMINATIONS = Object.freeze(['return', 'halted', 'paused', 'fault', 'unsupported', 'timeout', 'cancelled', 'exception']);

function terminationOf(result = {}) {
  const raw = String(result.termination ?? result.stop?.kind ?? result.status ?? 'paused').toLowerCase();
  if (TERMINATIONS.includes(raw)) return raw;
  if (/unsupported/.test(raw)) return 'unsupported';
  if (/timeout|limit/.test(raw)) return 'timeout';
  if (/cancel/.test(raw)) return 'cancelled';
  if (/fault|crash|oob|unmapped/.test(raw)) return 'fault';
  if (/return|complete|success/.test(raw)) return 'return';
  return 'exception';
}

function completenessFor(termination) {
  if (termination === 'unsupported') return 'unsupported';
  if (termination === 'timeout' || termination === 'cancelled' || termination === 'exception') return 'truncated';
  return 'bounded';
}

function normalizeEngineDescriptor(engine, options) {
  const source = typeof engine?.descriptor === 'function' ? engine.descriptor() : {};
  return deepFreeze({
    id: String(options.engineId ?? source.id ?? engine?.id ?? 'emulator'),
    version: String(options.engineVersion ?? source.version ?? engine?.version ?? 'unknown'),
    architecture: options.architecture ?? source.architecture ?? null,
    environment: options.environment ?? source.environment ?? 'unknown',
    deterministic: options.deterministic ?? source.deterministic ?? engine?.deterministic !== false,
  });
}

export class EmulatorProvider {
  constructor(engine, options = {}) {
    if (!engine || (typeof engine.execute !== 'function' && (typeof engine.launch !== 'function' || typeof engine.resume !== 'function'))) {
      throw new DebugAdapterError('emulator-engine-required', 'EmulatorProvider requires execute() or launch()+resume()');
    }
    this.engine = engine;
    this.options = options;
    this.engineDescriptor = normalizeEngineDescriptor(engine, options);
    this.activeSession = null;
    this._descriptor = createRuntimeProviderDescriptor({
      id: options.id ?? `emulator:${this.engineDescriptor.id}`,
      version: options.version ?? '1',
      kind: 'emulator',
      facets: ['emulator'],
      capabilities: {
        execute: true,
        replay: this.engineDescriptor.deterministic === true,
        syntheticEvidence: true,
      },
    });
  }

  descriptor() { return this._descriptor; }

  async openSession(request = {}, options = {}) {
    if (this.activeSession && !this.activeSession.closed) throw new DebugAdapterError('runtime-session-active', 'emulator provider already has an open session');
    let session;
    session = new RuntimeProviderSession({
      provider: this,
      request,
      close: async () => {
        try { if (typeof this.engine.disconnect === 'function') await this.engine.disconnect(); }
        finally { if (this.activeSession === session) this.activeSession = null; }
      },
    });
    if (options.connect !== false && typeof this.engine.connect === 'function') await this.engine.connect(options.connectOptions || {});
    const evidence = new RuntimeEvidenceBridge();
    let lastRun = null;

    const run = async (input = {}, runOptions = {}) => {
      const maxSteps = boundedInteger(runOptions.maxSteps, 20000, 1, 1000000, 'maxSteps');
      const timeoutMs = boundedInteger(runOptions.timeoutMs, 2000, 10, 60000, 'timeoutMs');
      const controller = session.controller();
      let externalAbort = null;
      if (runOptions.signal) {
        externalAbort = () => controller.abort(runOptions.signal.reason ?? 'cancelled');
        if (runOptions.signal.aborted) externalAbort();
        else runOptions.signal.addEventListener('abort', externalAbort, { once: true });
      }
      let timer = null;
      if (!controller.signal.aborted) timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
      session.setState('running');
      let raw;
      try {
        if (controller.signal.aborted) raw = { stop: { kind: String(controller.signal.reason || 'cancelled') } };
        else if (typeof this.engine.execute === 'function') raw = await this.engine.execute(input, { ...runOptions, maxSteps, timeoutMs, signal: controller.signal });
        else {
          await this.engine.launch(input, { signal: controller.signal });
          raw = await this.engine.resume({ ...runOptions, maxSteps, timeoutMs, signal: controller.signal });
        }
      } catch (error) {
        if (controller.signal.aborted) raw = { stop: { kind: String(controller.signal.reason || 'cancelled') }, error: String(error?.message || error) };
        else raw = { stop: { kind: 'exception' }, error: String(error?.message || error) };
      } finally {
        if (timer) clearTimeout(timer);
        if (runOptions.signal && externalAbort) runOptions.signal.removeEventListener('abort', externalAbort);
        session.releaseController(controller);
      }

      const termination = terminationOf(raw || {});
      const completeness = completenessFor(termination);
      session.setState(termination === 'paused' ? 'paused' : termination === 'exception' ? 'degraded' : 'ready');
      const sourceEvents = Array.isArray(raw?.events) ? raw.events : Array.isArray(raw?.trace?.events) ? raw.trace.events : [];
      const events = sourceEvents.map((source, index) => createRuntimeEvent({
        runtimeSessionId: session.runtimeSessionId,
        providerId: session.providerId,
        providerVersion: session.providerVersion,
        sessionEpoch: session.epoch,
        streamId: source.streamId ?? 'emulator',
        sequence: source.sequence ?? index,
        providerEventId: source.providerEventId ?? source.id,
        timestamp: source.timestamp,
        processKey: session.target.processKey,
        moduleBindingKey: source.moduleBindingKey,
        moduleGeneration: source.moduleGeneration,
        kind: source.kind ?? source.type ?? 'emulator-checkpoint',
        payload: source.payload ?? source,
        observationMode: 'synthetic',
        completeness,
        interventionIds: source.interventionIds,
      }));
      if (!events.length) {
        events.push(createRuntimeEvent({
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          providerVersion: session.providerVersion,
          sessionEpoch: session.epoch,
          streamId: 'emulator',
          sequence: 0,
          processKey: session.target.processKey,
          kind: 'emulator-checkpoint',
          payload: { termination, result: raw ?? null, engine: this.engineDescriptor },
          observationMode: 'synthetic',
          completeness,
        }));
      }
      const batch = createRuntimeEventBatch({
        runtimeSessionId: session.runtimeSessionId,
        providerId: session.providerId,
        sessionEpoch: session.epoch,
        events,
        completeness,
        dropped: 0,
      });
      const resolution = runOptions.resolution ?? null;
      const evidenceNodes = events.map((event) => evidence.eventToEvidence(event, resolution, { binaryId: request.binaryId ?? request.binaryHash ?? null, semanticKind: 'emulator-observation' }));
      lastRun = deepFreeze({ input, options: { maxSteps, timeoutMs }, termination, completeness, raw: raw ?? null, eventIds: events.map((event) => event.eventId) });
      return deepFreeze({ termination, completeness, raw: raw ?? null, batch, evidence: evidenceNodes, recording: lastRun });
    };

    const emulator = Object.freeze({
      engine: this.engineDescriptor,
      run,
      replay: async (recording = null, replayOptions = {}) => {
        if (!this.engineDescriptor.deterministic) throw new DebugAdapterError('unsupported', 'emulator engine does not advertise deterministic replay');
        const source = recording ?? lastRun;
        if (!source) throw new DebugAdapterError('emulator-replay-missing', 'no emulator recording is available to replay');
        return run(source.input, { ...source.options, ...replayOptions });
      },
      evidence,
    });
    session.facets = Object.freeze({ emulator });
    session.setState('ready');
    this.activeSession = session;
    return session;
  }
}

export function createEmulatorProvider(engine, options = {}) { return new EmulatorProvider(engine, options); }
