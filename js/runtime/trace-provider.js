import { deepFreeze, stableStringify } from '../core/identity/index.js';
import { DebugAdapterError, boundedInteger } from '../debug/adapter.js';
import { RuntimeProviderSession, createRuntimeProviderDescriptor } from './provider.js';
import { createRuntimeEvent, createRuntimeEventBatch } from './events.js';

function required(value, code, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new DebugAdapterError(code, message || code);
  return text;
}

function normalizeRecording(recording = {}, options = {}) {
  if (!recording || typeof recording !== 'object' || Array.isArray(recording)) throw new DebugAdapterError('trace-invalid-recording', 'trace recording must be an object');
  const maxEvents = boundedInteger(options.maxEvents, 100000, 1, 1000000, 'maxEvents');
  const maxBytes = boundedInteger(options.maxBytes, 64 * 1024 * 1024, 4096, 256 * 1024 * 1024, 'maxBytes');
  const events = Array.isArray(recording.events) ? recording.events : Array.isArray(recording.trace?.events) ? recording.trace.events : [];
  if (events.length > maxEvents) throw new DebugAdapterError('resource-limit', `trace recording exceeds event limit (${maxEvents})`);
  if (stableStringify(recording).length * 2 > maxBytes) throw new DebugAdapterError('resource-limit', `trace recording exceeds byte limit (${maxBytes})`);
  const dropped = Number(recording.dropped ?? recording.trace?.dropped ?? 0);
  if (!Number.isSafeInteger(dropped) || dropped < 0) throw new DebugAdapterError('trace-invalid-dropped-count', 'trace dropped count must be a non-negative safe integer');
  const truncated = recording.truncated === true || recording.trace?.truncated === true || dropped > 0;
  return deepFreeze({
    recordingId: required(recording.recordingId ?? recording.id ?? `trace:${recording.sourceProvider ?? 'unknown'}`, 'trace-recording-id-required', 'trace recording id is required'),
    schemaVersion: String(recording.schemaVersion ?? recording.version ?? '1'),
    sourceProvider: String(recording.sourceProvider ?? recording.providerId ?? recording.backend ?? 'unknown'),
    sourceProviderVersion: String(recording.sourceProviderVersion ?? recording.providerVersion ?? 'unknown'),
    binaryId: recording.binaryId ?? recording.binaryHash ?? null,
    sliceId: recording.sliceId ?? recording.sliceIdentity ?? null,
    architecture: recording.architecture ?? null,
    platform: recording.platform ?? null,
    processKey: recording.processKey ?? null,
    modules: Array.isArray(recording.modules) ? recording.modules.slice() : [],
    events: events.slice(),
    interventions: Array.isArray(recording.interventions) ? recording.interventions.slice() : [],
    dropped,
    completeness: truncated ? 'truncated' : String(recording.completeness ?? 'bounded'),
    sourceProvenance: recording.sourceProvenance ?? recording.provenance ?? null,
  });
}

function normalizedEventFromRecord(record, context, index) {
  const source = record && record.type === 'event' && record.event ? record.event : record;
  const rawType = String(source?.kind ?? source?.type ?? 'trace-marker');
  const kindMap = { branch: 'basic-block', trace: 'trace-marker', 'stream-truncated': 'gap' };
  const known = new Set(['session-open','session-close','process-start','process-exit','thread-start','thread-exit','module-load','module-unload','paused','resumed','breakpoint-hit','watchpoint-hit','exception','signal','call','return','basic-block','memory-read','memory-write','register-snapshot','instrumentation-observation','instrumentation-intervention','emulator-checkpoint','trace-marker','gap','dropped-events','provider-warning','provider-error']);
  const kind = known.has(rawType) ? rawType : (kindMap[rawType] || 'trace-marker');
  return createRuntimeEvent({
    ...context,
    eventId: source?.eventId,
    streamId: source?.streamId ?? source?.threadKey ?? 'trace',
    sequence: source?.sequence ?? index,
    providerEventId: source?.providerEventId ?? source?.id,
    timestamp: source?.timestamp,
    processKey: source?.processKey ?? context.processKey,
    threadKey: source?.threadKey,
    moduleBindingKey: source?.moduleBindingKey,
    moduleGeneration: source?.moduleGeneration,
    kind,
    payload: source?.payload ?? source ?? {},
    observationMode: source?.observationMode ?? 'observed',
    completeness: source?.completeness ?? (rawType === 'stream-truncated' || source?.truncated === true ? 'truncated' : context.sourceCompleteness),
    predecessorIds: source?.predecessorIds,
    interventionIds: source?.interventionIds,
  });
}

export class TraceProvider {
  constructor(recording, options = {}) {
    this.recording = normalizeRecording(recording, options);
    this.options = options;
    this.activeSession = null;
    this._descriptor = createRuntimeProviderDescriptor({
      id: options.id ?? `trace:${this.recording.sourceProvider}`,
      version: options.version ?? '1',
      kind: 'trace',
      facets: ['trace'],
      capabilities: { import: true, replay: true, liveMutation: false },
    });
  }

  descriptor() { return this._descriptor; }

  async openSession(request = {}, options = {}) {
    if (this.activeSession && !this.activeSession.closed) throw new DebugAdapterError('runtime-session-active', 'trace provider already has an open session');
    const binaryId = this.recording.binaryId ?? request.binaryId ?? request.binaryHash;
    if (!binaryId) throw new DebugAdapterError('trace-binary-identity-required', 'trace provider requires source binary identity for a canonical runtime session');
    let session;
    session = new RuntimeProviderSession({
      provider: this,
      request: {
        ...request,
        binaryId,
        sliceId: this.recording.sliceId ?? request.sliceId,
        architecture: this.recording.architecture ?? request.architecture,
        platform: this.recording.platform ?? request.platform,
        processKey: this.recording.processKey ?? request.processKey,
        targetIdentity: request.targetIdentity ?? { recordingId: this.recording.recordingId, processKey: this.recording.processKey ?? null },
        sessionNonce: request.sessionNonce ?? this.recording.recordingId,
      },
      close: async () => { if (this.activeSession === session) this.activeSession = null; },
    });

    for (let i = 0; i < this.recording.modules.length; i++) {
      const module = this.recording.modules[i] || {};
      if (module.runtimeBase == null && module.base == null) continue;
      if (module.runtimeSize == null && module.size == null) continue;
      const identityEvidenceIds = Array.isArray(module.identityEvidenceIds) ? module.identityEvidenceIds : [];
      const hasProvenStaticIdentity = module.binaryId != null && (module.identityState === 'exact' || module.identityState === 'resolved' || identityEvidenceIds.length > 0);
      session.modules.load({
        bindingKey: module.bindingKey ?? module.moduleKey ?? module.id ?? module.uuid ?? module.name ?? `trace-module:${i}`,
        runtimeBase: module.runtimeBase ?? module.base,
        runtimeSize: module.runtimeSize ?? module.size,
        staticBase: module.staticBase ?? module.imageBase ?? null,
        pathHint: module.pathHint ?? module.path ?? module.name ?? null,
        binaryId: hasProvenStaticIdentity ? module.binaryId : null,
        sliceId: hasProvenStaticIdentity ? (module.sliceId ?? null) : null,
        imageId: hasProvenStaticIdentity ? (module.imageId ?? null) : null,
        buildIdentity: module.buildIdentity ?? module.uuid ?? null,
        identityState: hasProvenStaticIdentity ? (module.identityState ?? 'resolved') : 'unresolved',
        identityEvidenceIds,
        loadedSequence: module.loadedSequence,
      });
    }

    const context = {
      runtimeSessionId: session.runtimeSessionId,
      providerId: this._descriptor.id,
      providerVersion: this._descriptor.version,
      sessionEpoch: session.epoch,
      processKey: this.recording.processKey,
      sourceCompleteness: this.recording.completeness,
    };
    const normalized = this.recording.events.map((event, index) => normalizedEventFromRecord(event, context, index));
    if (this.recording.dropped > 0 && !normalized.some((event) => event.kind === 'gap' || event.kind === 'dropped-events')) {
      normalized.unshift(createRuntimeEvent({
        ...context,
        kind: 'dropped-events',
        payload: { dropped: this.recording.dropped, source: 'trace-recording' },
        completeness: 'truncated',
      }));
    }
    session.normalizedEvents = Object.freeze(normalized);
    session.sourceCompleteness = this.recording.completeness;
    session.facets = Object.freeze({ trace: this.#createTraceFacet(session) });
    session.setState('ready');
    this.activeSession = session;
    return session;
  }

  #createTraceFacet(session) {
    return Object.freeze({
      source: deepFreeze({
        recordingId: this.recording.recordingId,
        schemaVersion: this.recording.schemaVersion,
        providerId: this.recording.sourceProvider,
        providerVersion: this.recording.sourceProviderVersion,
        provenance: this.recording.sourceProvenance,
      }),
      async *events(options = {}) {
        const batchSize = boundedInteger(options.batchSize, 256, 1, 4096, 'batchSize');
        const signal = options.signal;
        for (let i = 0; i < session.normalizedEvents.length; i += batchSize) {
          if (signal?.aborted) throw new DebugAdapterError('cancelled', 'trace event stream cancelled');
          const events = session.normalizedEvents.slice(i, i + batchSize);
          const loss = events.some((event) => event.completeness === 'truncated' || event.kind === 'gap' || event.kind === 'dropped-events');
          yield createRuntimeEventBatch({
            runtimeSessionId: session.runtimeSessionId,
            providerId: session.providerId,
            sessionEpoch: session.epoch,
            events,
            completeness: loss ? 'truncated' : session.sourceCompleteness,
            dropped: events.filter((event) => event.kind === 'dropped-events').reduce((sum, event) => sum + Number(event.payload?.dropped || 0), 0),
          });
        }
      },
      replay: async () => createRuntimeEventBatch({
        runtimeSessionId: session.runtimeSessionId,
        providerId: session.providerId,
        sessionEpoch: session.epoch,
        events: session.normalizedEvents,
        completeness: session.sourceCompleteness,
        dropped: this.recording.dropped,
      }),
      resolveAddress: (runtimeAddress, resolutionOptions = {}) => session.modules.resolve(runtimeAddress, resolutionOptions),
    });
  }
}

export function createTraceProvider(recording, options = {}) { return new TraceProvider(recording, options); }
