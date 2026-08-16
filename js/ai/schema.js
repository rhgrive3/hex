/* Public, provider-neutral contract consumed by the AI UI and runtimes. */

export const AI_MODES = Object.freeze(['chat', 'agent']);
export const AI_STYLES = Object.freeze(['beginner', 'analyst']);
export const AI_SCOPES = Object.freeze(['auto', 'selection', 'function', 'neighborhood', 'binary', 'project', 'runtime']);
export const EVIDENCE_STATUSES = Object.freeze(['verified', 'supported', 'hypothesis', 'unknown']);
export const HYPOTHESIS_STATUSES = Object.freeze(['open', 'supported', 'rejected', 'verified']);
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'applied', 'failed']);
export const AI_ACTION_KINDS = Object.freeze([
  'open-function', 'open-address', 'show-xrefs', 'show-callers', 'show-callees',
  'show-cfg', 'show-pseudocode', 'open-evidence', 'trace-value', 'run-agent', 'review-proposal',
]);
export const AI_ERROR_TYPES = Object.freeze([
  'model_timeout', 'provider_error', 'invalid_model_output', 'invalid_tool_call',
  'tool_failed', 'scope_violation', 'budget_exhausted', 'cancelled',
  'context_too_large', 'approval_required',
]);

export const EVIDENCE_SCHEMA = Object.freeze({
  type: 'object', required: ['id', 'kind', 'status', 'title', 'sourceTool'],
  properties: {
    id: { type: 'string', minLength: 1 }, kind: { type: 'string', minLength: 1 }, status: { enum: EVIDENCE_STATUSES },
    address: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' }, functionAddress: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
    functionName: { type: 'string' }, title: { type: 'string', minLength: 1 }, summary: { type: 'string' },
    sourceTool: { type: 'string', minLength: 1 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
});

export const HYPOTHESIS_SCHEMA = Object.freeze({
  type: 'object', required: ['id', 'claim', 'confidence', 'status', 'supportEvidenceIds', 'contradictionEvidenceIds', 'missingEvidence', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' }, claim: { type: 'string', minLength: 1 }, confidence: { type: 'number', minimum: 0, maximum: 1 }, status: { enum: HYPOTHESIS_STATUSES },
    supportEvidenceIds: { type: 'array', items: { type: 'string' } }, contradictionEvidenceIds: { type: 'array', items: { type: 'string' } },
    missingEvidence: { type: 'array', items: { type: 'string' } }, createdAt: { type: 'string' }, updatedAt: { type: 'string' },
  },
});

export const ACTION_SCHEMA = Object.freeze({
  type: 'object', required: ['kind'],
  properties: { kind: { enum: AI_ACTION_KINDS }, target: { anyOf: [{ type: 'string' }, { type: 'null' }] }, label: { type: 'string' }, evidenceId: { type: 'string' } },
});

/* These are both defaults and hard browser-side ceilings. Turn/request options
   may reduce work for latency or battery reasons, but untrusted callers cannot
   enlarge an investigation beyond the mode's reviewed iPad-safe envelope. */
export const AI_BUDGETS = Object.freeze({
  chat: Object.freeze({ maxModelCalls: 2, maxToolCalls: 2, maxFunctions: 4, maxDisassembly: 8000, maxCost: 12, timeoutMs: 240000, contextBytes: 64 * 1024 }),
  agent: Object.freeze({ maxModelCalls: 12, maxToolCalls: 24, maxFunctions: 48, maxDisassembly: 50000, maxCost: 160, timeoutMs: 600000, contextBytes: 128 * 1024 }),
});

export const AI_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['mode', 'style', 'answer'],
  properties: {
    mode: { enum: AI_MODES },
    style: { enum: AI_STYLES },
    answer: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'array', items: EVIDENCE_SCHEMA },
    hypotheses: { type: 'array', items: HYPOTHESIS_SCHEMA },
    actions: { type: 'array', items: ACTION_SCHEMA },
    followups: { type: 'array', items: { type: 'string' } },
    activity: { type: 'array', items: { type: 'object' } },
    usage: { type: 'object' },
    limits: { type: 'object' },
  },
});

export const MODEL_DECISION_SCHEMA = Object.freeze({
  oneOf: [
    {
      type: 'object', required: ['type', 'tool', 'arguments'],
      properties: {
        type: { const: 'tool' }, tool: { type: 'string' }, arguments: { type: 'object' },
        purpose: { type: 'string' },
      },
    },
    {
      type: 'object', required: ['type', 'answer'],
      properties: {
        type: { const: 'final' }, answer: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
        evidenceIds: { type: 'array', items: { type: 'string' } },
        hypothesisIds: { type: 'array', items: { type: 'string' } },
        hypotheses: { type: 'array', items: { type: 'object' } },
        suggestedActions: { type: 'array', items: { type: 'object' } },
        followups: { type: 'array', items: { type: 'string' } },
      },
    },
  ],
});

export function aiBudget(mode, overrides = {}) {
  const base = AI_BUDGETS[AI_MODES.includes(mode) ? mode : 'chat'];
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (overrides[key] == null) continue;
    const value = Number(overrides[key]);
    if (!Number.isFinite(value)) continue;
    const minimum = key === 'timeoutMs' || key === 'contextBytes' ? 1 : 0;
    out[key] = Math.min(base[key], Math.max(minimum, Math.floor(value)));
  }
  return out;
}

export class AIError extends Error {
  constructor(type, message, details = null) {
    super(message);
    this.name = 'AIError';
    this.type = AI_ERROR_TYPES.includes(type) ? type : 'provider_error';
    this.details = details;
  }
}
