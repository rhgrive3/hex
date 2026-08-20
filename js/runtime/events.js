import { EVIDENCE_COMPLETENESS } from '../core/evidence/index.js';
import { deepFreeze, jsonSafe, stableDigest, stableStringify } from '../core/identity/index.js';
import { DebugAdapterError } from '../debug/adapter.js';

export const RUNTIME_OBSERVATION_MODES = Object.freeze(['observed', 'intervened', 'synthetic']);
export const RUNTIME_EVENT_KINDS = Object.freeze([
  'session-open', 'session-close',
  'process-start', 'process-exit',
  'thread-start', 'thread-exit',
  'module-load', 'module-unload',
  'paused', 'resumed',
  'breakpoint-hit', 'watchpoint-hit',
  'exception', 'signal',
  'call', 'return', 'basic-block',
  'memory-read', 'memory-write', 'register-snapshot',
  'instrumentation-observation', 'instrumentation-intervention',
  'emulator-checkpoint', 'trace-marker',
  'gap', 'dropped-events', 'provider-warning', 'provider-error',
]);

const COMPLETENESS_RANK = Object.freeze({ unsupported: 0, truncated: 1, partial: 2, bounded: 3, complete: 4 });

function required(value, code, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new DebugAdapterError(code, message || code);
  return text;
}

function safeInteger(value, fallback, name, { min = 0 } = {}) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new DebugAdapterError('runtime-invalid-event-integer', `${name} must be a safe integer >= ${min}`);
  return n;
}

function optionalText(value) { return value == null ? null : String(value); }

function arrayOfStrings(value, name) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new DebugAdapterError('runtime-invalid-event-array', `${name} must be an array`);
  return Object.freeze([...new Set(value.map(String).filter(Boolean))]);
}

function normalizeCompleteness(value, fallback = 'partial') {
  const completeness = String(value ?? fallback);
  if (!EVIDENCE_COMPLETENESS.includes(completeness)) throw new DebugAdapterError('runtime-invalid-completeness', `invalid runtime completeness: ${completeness}`);
  return completeness;
}

function normalizeKind(value) {
  const kind = required(value, 'runtime-event-kind-required', 'runtime event kind is required');
  if (!RUNTIME_EVENT_KINDS.includes(kind)) throw new DebugAdapterError('runtime-invalid-event-kind', `invalid runtime event kind: ${kind}`);
  return kind;
}

function normalizeMode(value) {
  const mode = String(value ?? 'observed');
  if (!RUNTIME_OBSERVATION_MODES.includes(mode)) throw new DebugAdapterError('runtime-invalid-observation-mode', `invalid runtime observation mode: ${mode}`);
  return mode;
}

function dedupeIdentity(input) {
  if (input.providerEventId != null) return `provider:${String(input.providerEventId)}`;
  if (input.streamId != null && input.sequence != null) return `stream:${String(input.streamId)}:${Number(input.sequence)}`;
  return null;
}

export function createRuntimeEvent(input = {}) {
  const runtimeSessionId = required(input.runtimeSessionId, 'runtime-session-id-required', 'runtime event requires runtimeSessionId');
  const providerId = required(input.providerId, 'runtime-provider-required', 'runtime event requires providerId');
  const providerVersion = String(input.providerVersion ?? '1');
  const sessionEpoch = safeInteger(input.sessionEpoch, 1, 'sessionEpoch', { min: 1 });
  const sequence = input.sequence == null ? null : safeInteger(input.sequence, null, 'sequence');
  const moduleGeneration = input.moduleGeneration == null ? null : safeInteger(input.moduleGeneration, null, 'moduleGeneration', { min: 1 });
  const kind = normalizeKind(input.kind);
  const observationMode = normalizeMode(input.observationMode);
  const completeness = normalizeCompleteness(input.completeness, kind === 'gap' || kind === 'dropped-events' ? 'truncated' : 'partial');
  const payload = jsonSafe(input.payload ?? {});
  const identity = {
    runtimeSessionId,
    providerId,
    providerVersion,
    sessionEpoch,
    streamId: optionalText(input.streamId),
    sequence,
    providerEventId: optionalText(input.providerEventId),
    kind,
    processKey: optionalText(input.processKey),
    threadKey: optionalText(input.threadKey),
    moduleBindingKey: optionalText(input.moduleBindingKey),
    moduleGeneration,
    payload,
  };
  const eventId = optionalText(input.eventId) || `runtimeevent_${stableDigest(identity)}`;
  return deepFreeze({
    eventId,
    runtimeSessionId,
    providerId,
    providerVersion,
    sessionEpoch,
    streamId: optionalText(input.streamId),
    sequence,
    predecessorIds: arrayOfStrings(input.predecessorIds, 'predecessorIds'),
    providerEventId: optionalText(input.providerEventId),
    timestamp: input.timestamp == null ? null : String(input.timestamp),
    processKey: optionalText(input.processKey),
    threadKey: optionalText(input.threadKey),
    moduleBindingKey: optionalText(input.moduleBindingKey),
    moduleGeneration,
    kind,
    payload,
    observationMode,
    completeness,
    interventionIds: arrayOfStrings(input.interventionIds, 'interventionIds'),
  });
}

export function normalizeLegacyRuntimeEvent(input, context = {}) {
  const source = input && input.type === 'event' && input.event ? input.event : input;
  if (!source || typeof source !== 'object') throw new DebugAdapterError('runtime-invalid-event', 'legacy runtime event must be an object');
  const legacyType = String(source.kind ?? source.type ?? 'trace-marker');
  const kindMap = {
    branch: 'basic-block',
    trace: 'trace-marker',
    warning: 'provider-warning',
    error: 'provider-error',
    'stream-truncated': 'gap',
  };
  const kind = RUNTIME_EVENT_KINDS.includes(legacyType) ? legacyType : (kindMap[legacyType] || 'trace-marker');
  const truncated = source.truncated === true || legacyType === 'stream-truncated';
  return createRuntimeEvent({
    runtimeSessionId: context.runtimeSessionId,
    providerId: context.providerId,
    providerVersion: context.providerVersion,
    sessionEpoch: source.epoch ?? context.sessionEpoch ?? 1,
    streamId: source.streamId ?? context.streamId,
    sequence: source.sequence,
    providerEventId: source.providerEventId ?? source.id,
    timestamp: source.timestamp,
    processKey: source.processKey ?? context.processKey,
    threadKey: source.threadKey,
    moduleBindingKey: source.moduleBindingKey,
    moduleGeneration: source.moduleGeneration,
    kind,
    payload: source.payload ?? source,
    observationMode: source.observationMode ?? context.observationMode ?? 'observed',
    completeness: source.completeness ?? (truncated ? 'truncated' : context.completeness ?? 'partial'),
    predecessorIds: source.predecessorIds,
    interventionIds: source.interventionIds,
  });
}

export function createRuntimeEventBatch(input = {}) {
  const events = Array.isArray(input.events) ? input.events.map((event) => createRuntimeEvent(event)) : [];
  const dropped = safeInteger(input.dropped, 0, 'dropped');
  const hasLoss = dropped > 0 || events.some((event) => event.kind === 'gap' || event.kind === 'dropped-events' || event.completeness === 'truncated');
  const requested = normalizeCompleteness(input.completeness, hasLoss ? 'truncated' : 'partial');
  let strongestAllowed = hasLoss ? 'truncated' : 'complete';
  for (const event of events) {
    if (COMPLETENESS_RANK[event.completeness] < COMPLETENESS_RANK[strongestAllowed]) strongestAllowed = event.completeness;
  }
  if (COMPLETENESS_RANK[requested] > COMPLETENESS_RANK[strongestAllowed]) {
    throw new DebugAdapterError('runtime-completeness-upgrade', `event batch cannot upgrade ${strongestAllowed} source evidence to ${requested}`);
  }
  return deepFreeze({
    runtimeSessionId: required(input.runtimeSessionId ?? events[0]?.runtimeSessionId, 'runtime-session-id-required', 'runtime event batch requires runtimeSessionId'),
    providerId: required(input.providerId ?? events[0]?.providerId, 'runtime-provider-required', 'runtime event batch requires providerId'),
    sessionEpoch: safeInteger(input.sessionEpoch ?? events[0]?.sessionEpoch, 1, 'sessionEpoch', { min: 1 }),
    events: Object.freeze(events),
    completeness: requested,
    dropped,
  });
}

export class RuntimeEventNormalizer {
  #queue = [];
  #seen = new Set();
  #dropped = 0;

  constructor(context = {}, options = {}) {
    this.context = { ...context };
    this.maxEvents = safeInteger(options.maxEvents, 4096, 'maxEvents', { min: 1 });
    this.maxBytes = safeInteger(options.maxBytes, 4 * 1024 * 1024, 'maxBytes', { min: 1024 });
    this.queuedBytes = 0;
  }

  push(input) {
    const event = input?.runtimeSessionId ? createRuntimeEvent(input) : normalizeLegacyRuntimeEvent(input, this.context);
    if (event.sessionEpoch !== Number(this.context.sessionEpoch ?? event.sessionEpoch)) return null;
    const dedupe = dedupeIdentity(event);
    if (dedupe) {
      const scoped = `${event.sessionEpoch}:${dedupe}`;
      if (this.#seen.has(scoped)) return null;
      this.#seen.add(scoped);
    }
    const bytes = stableStringify(event).length * 2;
    if (this.#queue.length >= this.maxEvents || this.queuedBytes + bytes > this.maxBytes) {
      this.#dropped++;
      return null;
    }
    this.#queue.push(event);
    this.queuedBytes += bytes;
    return event;
  }

  flush() {
    const events = this.#queue;
    this.#queue = [];
    this.queuedBytes = 0;
    const dropped = this.#dropped;
    this.#dropped = 0;
    if (dropped > 0) {
      events.unshift(createRuntimeEvent({
        ...this.context,
        kind: 'dropped-events',
        payload: { dropped },
        observationMode: 'observed',
        completeness: 'truncated',
      }));
    }
    return createRuntimeEventBatch({
      runtimeSessionId: this.context.runtimeSessionId,
      providerId: this.context.providerId,
      sessionEpoch: this.context.sessionEpoch ?? 1,
      events,
      completeness: dropped > 0 ? 'truncated' : (events.length ? 'partial' : 'bounded'),
      dropped,
    });
  }

  resetEpoch(epoch) {
    this.context.sessionEpoch = safeInteger(epoch, null, 'sessionEpoch', { min: 1 });
    this.#queue = [];
    this.queuedBytes = 0;
    this.#dropped = 0;
    this.#seen.clear();
  }
}
