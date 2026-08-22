import {
  AI_ACTION_KINDS, AI_MODES, AI_RESULT_SCHEMA, AI_SCOPES, AI_STYLES, AIError,
  MODEL_DECISION_SCHEMA,
} from './schema.js';

export function validateSchema(value, schema, path = '$') {
  const errors = [];
  visit(value, schema || {}, path, errors);
  return { ok: errors.length === 0, errors };
}

function visit(value, schema, path, errors) {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateSchema(value, candidate, path).ok);
    if (matches.length !== 1) errors.push(`${path} must match exactly one schema`);
    return;
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((candidate) => validateSchema(value, candidate, path).ok)) errors.push(`${path} does not match any schema`);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} has an unsupported value`);
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} is below minimum`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} is above maximum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${path} has an invalid format`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.items) value.forEach((item, index) => visit(item, schema.items, `${path}[${index}]`, errors));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && schema.properties[key]) visit(item, schema.properties[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
}

function typeMatches(value, type) {
  if (type === 'object') return value != null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

export function assertSchema(value, schema, type = 'invalid_model_output') {
  const checked = validateSchema(value, schema);
  if (!checked.ok) throw new AIError(type, checked.errors.join('; '), { errors: checked.errors });
  return value;
}

export function normalizeTurnRequest(input = {}) {
  const mode = AI_MODES.includes(input.mode) ? input.mode : 'chat';
  const style = AI_STYLES.includes(input.style) ? input.style : 'analyst';
  const scope = AI_SCOPES.includes(input.scope) ? input.scope : 'auto';
  const goal = String(input.goal ?? input.question ?? '').trim();
  if (!goal) throw new AIError('invalid_model_output', 'A non-empty AI goal is required.');
  return { ...input, mode, style, scope, goal };
}

export function validateModelDecision(value, allowedTools = []) {
  assertSchema(value, MODEL_DECISION_SCHEMA);
  if (value.type === 'tool' && !allowedTools.includes(value.tool)) {
    throw new AIError('invalid_tool_call', `Unknown tool: ${value.tool}`);
  }
  return value;
}

export function validateAIResult(result) {
  assertSchema(result, AI_RESULT_SCHEMA);
  if (!AI_MODES.includes(result.mode) || !AI_STYLES.includes(result.style)) throw new AIError('invalid_model_output', 'Invalid AI result mode or style.');
  return result;
}

export function addressText(value) {
  if (value == null) return null;
  // BigInt('') and BigInt('   ') are 0n, so a missing or blank address would
  // become a legitimate-looking action target at 0x0 (#1301). Blank input is
  // absent input, not address zero; only an explicit '0' means 0x0.
  if (typeof value === 'string' && value.trim() === '') return null;
  try {
    const n = typeof value === 'bigint' ? value : BigInt(value);
    return n < 0n ? null : `0x${n.toString(16)}`;
  } catch { return null; }
}

export function sanitizeActions(actions, { evidenceStore, proposalStore, addressExists } = {}) {
  const out = [];
  for (const value of Array.isArray(actions) ? actions : []) {
    if (!value || !AI_ACTION_KINDS.includes(value.kind)) continue;
    const action = { kind: value.kind };
    if (typeof value.label === 'string') action.label = value.label.slice(0, 240);
    if (value.kind === 'run-agent') { action.target = typeof value.target === 'string' ? value.target.slice(0, 1000) : null; out.push(action); continue; }
    if (value.kind === 'review-proposal') {
      const id = String(value.target ?? value.proposalId ?? '');
      if (id && proposalStore && proposalStore.has(id)) { action.target = id; out.push(action); }
      continue;
    }
    const target = addressText(value.target ?? value.address ?? value.functionAddress);
    if (!target) continue;
    const evidenced = evidenceStore && evidenceStore.hasAddress(target);
    const exists = typeof addressExists === 'function' && addressExists(target);
    if (!evidenced || exists === false) continue;
    action.target = target;
    if (value.evidenceId && evidenceStore.has(String(value.evidenceId))) action.evidenceId = String(value.evidenceId);
    out.push(action);
  }
  return out;
}

export function jsonSafe(value, depth = 0) {
  if (depth > 10) return '[truncated]';
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => jsonSafe(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      // `out[key] = ...` with key '__proto__' runs the inherited
      // Object.prototype.__proto__ setter instead of creating an own property:
      // the input's own '__proto__' data is dropped and the *result's*
      // prototype is replaced by whatever the input carried (#1300). Defining
      // the property never reaches that setter.
      Object.defineProperty(out, key, {
        value: jsonSafe(item, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return String(value);
}
