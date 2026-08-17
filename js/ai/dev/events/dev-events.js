export const DEV_EVENT_TYPE = Object.freeze({
  WORKER_REGISTERED: 'worker.registered',
  WORKER_STARTED: 'worker.started',
  WORKER_PROGRESS: 'worker.progress',
  WORKER_COMPLETED: 'worker.completed',
  WORKER_FAILED: 'worker.failed',
  WORKER_CANCELLED: 'worker.cancelled',
  HUMAN_RESPONDED: 'human.responded',
});

export const DEV_EVENT_TYPES = Object.freeze(Object.values(DEV_EVENT_TYPE));

export function createDevEvent(type, data = {}, { now = () => new Date().toISOString() } = {}) {
  if (!DEV_EVENT_TYPES.includes(type)) throw new TypeError(`Unsupported Dev event: ${type}`);
  if (!isPlainRecord(data)) throw new TypeError('Dev event data must be a plain object.');
  return deepFreeze({ type, data: clonePlain(data), observedAt: normalizeTimestamp(now()) });
}

export class DevRunEventHost {
  constructor({ supervisor } = {}) {
    if (!supervisor || typeof supervisor.applyDecision !== 'function' || typeof supervisor.resume !== 'function') {
      throw new TypeError('DevRunEventHost requires a DevSupervisor.');
    }
    this.supervisor = supervisor;
    this.waiting = new Map();
  }

  yieldDecision(run, input) {
    const applied = this.supervisor.applyDecision(run, input);
    if (applied.decision.type === 'wait') {
      this.waiting.set(applied.run.runId, Object.freeze({
        kind: 'event',
        events: Object.freeze([...applied.decision.events]),
      }));
      return Object.freeze({ ...applied, yielded: true });
    }
    if (applied.decision.type === 'human') {
      this.waiting.set(applied.run.runId, Object.freeze({
        kind: 'human',
        events: Object.freeze([DEV_EVENT_TYPE.HUMAN_RESPONDED]),
      }));
      return Object.freeze({ ...applied, yielded: true });
    }
    this.waiting.delete(applied.run.runId);
    return Object.freeze({ ...applied, yielded: false });
  }

  async waitForWorkerDecision(run, input, { signal } = {}) {
    const yielded = this.yieldDecision(run, input);
    if (yielded.decision.type !== 'wait') return yielded;
    if (!this.supervisor.workerTools || typeof this.supervisor.workerTools.waitEvent !== 'function') {
      throw new TypeError('Dev Worker event transport is unavailable.');
    }
    const event = await this.supervisor.workerTools.waitEvent(yielded.decision.events, {
      runId: yielded.run.runId,
      signal,
    });
    return Object.freeze({
      ...this.acceptEvent(yielded.run, event),
      decision: yielded.decision,
      yielded: true,
    });
  }

  resumeHuman(run, data = {}) {
    return this.acceptEvent(run, createDevEvent(DEV_EVENT_TYPE.HUMAN_RESPONDED, data));
  }

  acceptEvent(run, event) {
    if (!run?.runId) throw new TypeError('A DevRun is required.');
    const record = this.waiting.get(run.runId);
    if (!record) return Object.freeze({ run, resumed: false, event });
    const normalized = normalizeEvent(event);
    if (record.kind === 'human' && normalized.type !== DEV_EVENT_TYPE.HUMAN_RESPONDED) {
      return Object.freeze({ run, resumed: false, event: normalized });
    }
    if (record.kind === 'event' && !record.events.includes(normalized.type)) {
      return Object.freeze({ run, resumed: false, event: normalized });
    }
    this.waiting.delete(run.runId);
    return Object.freeze({ run: this.supervisor.resume(run), resumed: true, event: normalized });
  }

  waitingFor(runId) {
    return this.waiting.get(String(runId || '')) || null;
  }
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') throw new TypeError('A structured Dev event is required.');
  if (!DEV_EVENT_TYPES.includes(String(event.type || ''))) throw new TypeError(`Unsupported Dev event: ${event.type}`);
  return deepFreeze({
    type: String(event.type),
    data: isPlainRecord(event.data) ? clonePlain(event.data) : {},
    observedAt: normalizeTimestamp(event.observedAt || new Date().toISOString()),
  });
}
function normalizeTimestamp(value) {
  const text = String(value);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`Invalid timestamp: ${value}`);
  return text;
}
function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function clonePlain(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
