import { AGENT_PROFILE } from '../policy/agent-profile.js';
import { assertDevDecisionPolicy, DEV_DECISION_POLICY } from '../policy/decision-policy.js';
import { createAnalysisScopeRequest, createDevAnalysisScopeRequest } from './analysis-scope.js';

export const DEV_RUN_STATUS = Object.freeze({
  CREATED: 'CREATED',
  PLANNING: 'PLANNING',
  ACTIVE: 'ACTIVE',
  WAITING_EVENT: 'WAITING_EVENT',
  WAITING_HUMAN: 'WAITING_HUMAN',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});
export const DEV_RUN_STATUSES = Object.freeze(Object.values(DEV_RUN_STATUS));
export const DEV_RUN_IDENTITY_FIELDS = Object.freeze([
  'runId', 'taskId', 'workerId', 'tabNodeId', 'hexConversationId',
  'chatgptConversationId', 'supervisorSessionKey',
]);

const TERMINAL = new Set([DEV_RUN_STATUS.COMPLETED, DEV_RUN_STATUS.FAILED, DEV_RUN_STATUS.CANCELLED]);
const TRANSITIONS = Object.freeze({
  CREATED: new Set(['PLANNING', 'CANCELLED']),
  PLANNING: new Set(['ACTIVE', 'WAITING_HUMAN', 'PAUSED', 'FAILED', 'CANCELLED']),
  ACTIVE: new Set(['WAITING_EVENT', 'WAITING_HUMAN', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED']),
  WAITING_EVENT: new Set(['ACTIVE', 'WAITING_HUMAN', 'PAUSED', 'FAILED', 'CANCELLED']),
  WAITING_HUMAN: new Set(['ACTIVE', 'PAUSED', 'FAILED', 'CANCELLED']),
  PAUSED: new Set(['ACTIVE', 'FAILED', 'CANCELLED']),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
});

export function createDevRun(input = {}) {
  const goal = String(input.goal || '').trim();
  if (!goal) throw new TypeError('DevRun.goal is required.');
  const runId = requiredId(input.runId, 'runId');
  const supervisorSessionKey = requiredId(input.supervisorSessionKey, 'supervisorSessionKey');
  const status = input.status || DEV_RUN_STATUS.CREATED;
  if (!DEV_RUN_STATUSES.includes(status)) throw new TypeError(`Unsupported DevRun status: ${status}`);
  const now = normalizeTimestamp(input.createdAt || input.now || new Date().toISOString());
  const updatedAt = normalizeTimestamp(input.updatedAt || now);
  const analysisScope = input.analysisScope
    ? createAnalysisScopeRequest(input.analysisScope)
    : createDevAnalysisScopeRequest();
  const planItems = Array.isArray(input.plan?.items) ? input.plan.items.map(normalizePlanItem) : [];

  return deepFreeze({
    runId,
    taskId: nullableId(input.taskId),
    workerId: nullableId(input.workerId),
    tabNodeId: nullableId(input.tabNodeId),
    hexConversationId: nullableId(input.hexConversationId),
    chatgptConversationId: nullableId(input.chatgptConversationId),
    supervisorSessionKey,
    goal,
    agentProfile: AGENT_PROFILE.DEV,
    decisionPolicy: assertDevDecisionPolicy(input.decisionPolicy || DEV_DECISION_POLICY.NORMAL),
    analysisScope,
    chatgptProjectContext: input.chatgptProjectContext ?? null,
    plan: { items: planItems },
    status,
    createdAt: now,
    updatedAt,
  });
}

export function transitionDevRun(run, nextStatus, { now = new Date().toISOString(), plan } = {}) {
  if (!run || run.agentProfile !== AGENT_PROFILE.DEV) throw new TypeError('A DevRun is required.');
  if (!DEV_RUN_STATUSES.includes(nextStatus)) throw new TypeError(`Unsupported DevRun status: ${nextStatus}`);
  if (run.status === nextStatus) return run;
  if (!TRANSITIONS[run.status]?.has(nextStatus)) {
    throw new Error(`Invalid DevRun transition: ${run.status} -> ${nextStatus}`);
  }
  const nextPlan = plan == null ? run.plan : { items: (plan.items || []).map(normalizePlanItem) };
  return deepFreeze({ ...run, plan: nextPlan, status: nextStatus, updatedAt: normalizeTimestamp(now) });
}

export function bindDevRunIdentity(run, patch = {}, { now = new Date().toISOString() } = {}) {
  if (!run || run.agentProfile !== AGENT_PROFILE.DEV) throw new TypeError('A DevRun is required.');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('DevRun identity patch must be an object.');
  const mutableFields = new Set(['taskId', 'workerId', 'tabNodeId', 'hexConversationId', 'chatgptConversationId']);
  for (const key of Object.keys(patch)) {
    if (!mutableFields.has(key)) throw new TypeError(`Unsupported DevRun identity field: ${key}`);
  }
  const next = { ...run, updatedAt: normalizeTimestamp(now) };
  for (const key of mutableFields) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = nullableId(patch[key]);
  }
  return deepFreeze(next);
}

export function isTerminalDevRun(run) {
  return TERMINAL.has(run?.status);
}

function normalizePlanItem(item, index) {
  if (typeof item === 'string') return Object.freeze({ id: `step-${index + 1}`, text: item.trim(), status: 'planned' });
  if (!item || typeof item !== 'object') throw new TypeError('Dev plan items must be strings or objects.');
  const text = String(item.text || item.goal || '').trim();
  if (!text) throw new TypeError('Dev plan item text is required.');
  return Object.freeze({
    id: String(item.id || `step-${index + 1}`),
    text,
    status: String(item.status || 'planned'),
  });
}
function requiredId(value, name) { const id = String(value || '').trim(); if (!id) throw new TypeError(`${name} is required.`); return id; }
function nullableId(value) { return value == null || value === '' ? null : String(value); }
function normalizeTimestamp(value) { const text = String(value); if (!Number.isFinite(Date.parse(text))) throw new TypeError(`Invalid timestamp: ${value}`); return text; }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
