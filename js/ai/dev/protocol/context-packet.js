/* Typed, JSON-safe handoff representations.

   This is a representation migration, not a selection or pruning optimization:
   everything the caller supplies survives normalization. Deciding what a packet
   should contain is CARD I2's job, and nothing here drops data to make a packet
   smaller.

   Two rules the shapes exist to enforce:

   - A Worker's report is evidence, never authority. `contextDelta` is data the
     host may consider; it never becomes an instruction, and normalizing it does
     not promote it.
   - `terminalReason` belongs to the runtime that owned the work, not to the
     Worker's prose. A persuasive "I'm done" cannot outrank a host-side timeout
     or a stale lease.

   No storage, no model call, no embedding, no summarizer.
*/

export const DEV_CONTEXT_PACKET_SCHEMA = 'hex-dev-context-packet/v1';
export const DEV_WORKER_RESULT_SCHEMA = 'hex-dev-worker-result/v1';

/* Small, stable, machine-readable. Enough for the host and the Supervisor to
   decide retry and verification without parsing prose. Provider- and
   tool-specific detail stays in the bounded `error` payload. */
export const DEV_TERMINAL_REASON = Object.freeze({
  COMPLETED: 'completed',
  WORKER_ERROR: 'worker-error',
  CANCELLED: 'cancelled',
  TASK_TIMEOUT: 'task-timeout',
  LEASE_STALE: 'lease-stale',
  RESULT_INVALID: 'result-invalid',
  RUNTIME_INVALIDATED: 'runtime-invalidated',
});
export const DEV_TERMINAL_REASONS = Object.freeze(Object.values(DEV_TERMINAL_REASON));

const MAX_LIST = 64;
const MAX_TEXT = 4096;
const MAX_SHORT = 512;

export function createDevContextPacket(input = {}) {
  if (!plainRecord(input)) throw new TypeError('ContextPacket requires a plain object.');
  const taskId = text(input.taskId, MAX_SHORT);
  if (!taskId) throw new TypeError('ContextPacket requires a taskId.');
  const objective = text(input.objective, MAX_TEXT);
  if (!objective) throw new TypeError('ContextPacket requires an objective.');
  return freezeDeep({
    schemaVersion: DEV_CONTEXT_PACKET_SCHEMA,
    orchestrationRunId: text(input.orchestrationRunId, MAX_SHORT) || null,
    graphId: text(input.graphId, MAX_SHORT) || null,
    taskId,
    attempt: positiveInteger(input.attempt),
    leaseId: text(input.leaseId, MAX_SHORT) || null,
    role: text(input.role, MAX_SHORT) || null,
    objective,
    successCriteria: list(input.successCriteria, (value) => text(value, MAX_TEXT)),
    scope: text(input.scope, MAX_TEXT) || null,
    constraints: list(input.constraints, (value) => text(value, MAX_TEXT)),
    authoritativeFacts: list(input.authoritativeFacts, authoritativeFact),
    dependencyResults: list(input.dependencyResults, dependencyResult),
    artifactRefs: list(input.artifactRefs, artifactRef),
    knownFailures: list(input.knownFailures, (value) => text(value, MAX_TEXT)),
    unknowns: list(input.unknowns, (value) => text(value, MAX_TEXT)),
    requiredEvidence: list(input.requiredEvidence, (value) => text(value, MAX_TEXT)),
    forbiddenActions: list(input.forbiddenActions, (value) => text(value, MAX_TEXT)),
    stopConditions: list(input.stopConditions, (value) => text(value, MAX_TEXT)),
    budget: budget(input.budget),
  });
}

export function createDevWorkerResult(input = {}) {
  if (!plainRecord(input)) throw new TypeError('WorkerResult requires a plain object.');
  const taskId = text(input.taskId, MAX_SHORT);
  if (!taskId) throw new TypeError('WorkerResult requires a taskId.');
  return freezeDeep({
    schemaVersion: DEV_WORKER_RESULT_SCHEMA,
    orchestrationRunId: text(input.orchestrationRunId, MAX_SHORT) || null,
    graphId: text(input.graphId, MAX_SHORT) || null,
    taskId,
    attempt: positiveInteger(input.attempt),
    leaseId: text(input.leaseId, MAX_SHORT) || null,
    workerId: text(input.workerId, MAX_SHORT) || null,
    state: text(input.state, MAX_SHORT) || null,
    terminalReason: terminalReason(input.terminalReason),
    // Never invented. An unknown completion time stays unknown.
    completedAt: timestamp(input.completedAt),
    summary: text(input.summary, MAX_TEXT) || null,
    claims: list(input.claims, (value) => text(value, MAX_TEXT)),
    evidenceRefs: list(input.evidenceRefs, artifactRef),
    /* Lineage only: which evidence a supplied compact summary already accounts
       for, so I2 can avoid injecting both the summary and its sources. It grants
       no authority and never marks evidence as verified. */
    coveredEvidenceRefs: list(input.coveredEvidenceRefs, (value) => text(value, MAX_SHORT)),
    changedPaths: list(input.changedPaths, (value) => text(value, MAX_SHORT)),
    commitOrBranchRefs: list(input.commitOrBranchRefs, (value) => text(value, MAX_SHORT)),
    tests: list(input.tests, testRecord),
    unknowns: list(input.unknowns, (value) => text(value, MAX_TEXT)),
    blockers: list(input.blockers, (value) => text(value, MAX_TEXT)),
    error: errorRecord(input.error),
    contextDelta: list(input.contextDelta, contextDeltaEntry),
    suggestedNext: list(input.suggestedNext, (value) => text(value, MAX_TEXT)),
  });
}

/* The runtime that owned the work decides how it ended. A Worker's own words are
   an input to `summary` and `claims`, never to this. */
export function devTerminalReasonFrom({ runtimeReason = null, workerState = null } = {}) {
  const owned = terminalReason(runtimeReason);
  if (owned) return owned;
  const state = String(workerState || '').toUpperCase();
  if (state === 'COMPLETED') return DEV_TERMINAL_REASON.COMPLETED;
  if (state === 'CANCELLED') return DEV_TERMINAL_REASON.CANCELLED;
  if (state === 'FAILED') return DEV_TERMINAL_REASON.WORKER_ERROR;
  // Unknown stays unknown rather than being guessed from prose.
  return null;
}

function authoritativeFact(value) {
  if (!plainRecord(value)) return null;
  const statement = text(value.statement ?? value.fact, MAX_TEXT);
  if (!statement) return null;
  return {
    statement,
    // Provenance is part of the fact. A fact whose source or freshness is
    // unknown must stay visibly unknown, never quietly authoritative.
    source: text(value.source, MAX_SHORT) || null,
    authority: text(value.authority, MAX_SHORT) || null,
    observedAt: timestamp(value.observedAt),
    supersedes: list(value.supersedes, (item) => text(item, MAX_SHORT)),
    conflictsWith: list(value.conflictsWith, (item) => text(item, MAX_SHORT)),
  };
}

function dependencyResult(value) {
  if (!plainRecord(value)) return null;
  const taskId = text(value.taskId, MAX_SHORT);
  if (!taskId) return null;
  return {
    taskId,
    state: text(value.state, MAX_SHORT) || null,
    terminalReason: terminalReason(value.terminalReason),
    summary: text(value.summary, MAX_TEXT) || null,
    evidenceRefs: list(value.evidenceRefs, artifactRef),
    coveredEvidenceRefs: list(value.coveredEvidenceRefs, (item) => text(item, MAX_SHORT)),
  };
}

function artifactRef(value) {
  if (typeof value === 'string') {
    const ref = text(value, MAX_SHORT);
    return ref ? { ref, kind: null, excerpt: null, observedAt: null } : null;
  }
  if (!plainRecord(value)) return null;
  const ref = text(value.ref ?? value.path ?? value.url, MAX_SHORT);
  if (!ref) return null;
  return {
    ref,
    kind: text(value.kind, MAX_SHORT) || null,
    // A bounded excerpt, so a reference never becomes bulk content by accident.
    excerpt: text(value.excerpt, MAX_TEXT) || null,
    observedAt: timestamp(value.observedAt),
  };
}

function testRecord(value) {
  if (typeof value === 'string') {
    const command = text(value, MAX_SHORT);
    return command ? { command, outcome: null, detail: null } : null;
  }
  if (!plainRecord(value)) return null;
  const command = text(value.command ?? value.name, MAX_SHORT);
  if (!command) return null;
  return {
    command,
    outcome: text(value.outcome ?? value.status, MAX_SHORT) || null,
    detail: text(value.detail, MAX_SHORT) || null,
  };
}

/* Data the host may consider. Explicitly labelled as evidence so no later stage
   can mistake it for something the Supervisor was told to do. */
function contextDeltaEntry(value) {
  if (typeof value === 'string') {
    const statement = text(value, MAX_TEXT);
    return statement ? { statement, source: null, observedAt: null, authority: 'worker-reported-evidence' } : null;
  }
  if (!plainRecord(value)) return null;
  const statement = text(value.statement ?? value.fact ?? value.note, MAX_TEXT);
  if (!statement) return null;
  return {
    statement,
    source: text(value.source, MAX_SHORT) || null,
    observedAt: timestamp(value.observedAt),
    authority: 'worker-reported-evidence',
  };
}

function errorRecord(value) {
  if (!plainRecord(value)) return null;
  const code = text(value.code, MAX_SHORT);
  const message = text(value.message, MAX_TEXT);
  if (!code && !message) return null;
  return { code: code || null, message: message || null, detail: text(value.detail, MAX_TEXT) || null };
}

function budget(value) {
  if (!plainRecord(value)) return null;
  const record = {
    maxBytes: positiveInteger(value.maxBytes),
    maxToolCalls: positiveInteger(value.maxToolCalls),
    deadlineMs: positiveInteger(value.deadlineMs),
  };
  return Object.values(record).some((item) => item != null) ? record : null;
}

function terminalReason(value) {
  const reason = String(value ?? '').trim();
  return DEV_TERMINAL_REASONS.includes(reason) ? reason : null;
}
function timestamp(value) {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function positiveInteger(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}
function text(value, max) {
  if (value == null) return '';
  const string = typeof value === 'string' ? value : String(value);
  return string.trim().slice(0, max);
}
function list(value, normalize) {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of items) {
    if (out.length >= MAX_LIST) break;
    const normalized = normalize(item);
    if (normalized === null || normalized === '') continue;
    out.push(normalized);
  }
  return out;
}
function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function freezeDeep(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}
