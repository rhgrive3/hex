export const DEV_SUPERVISOR_PROTOCOL = 'hex-dev-supervisor-v1';
export const DEV_SUPERVISOR_DECISION_TYPES = Object.freeze(['tool', 'human', 'wait', 'final']);

const SHAPES = Object.freeze({
  tool: ['type', 'tool', 'arguments', 'purpose'],
  human: ['type', 'question', 'blocking'],
  wait: ['type', 'events', 'reason'],
  final: ['type', 'answer', 'completedTasks', 'remaining'],
});

export function parseDevSupervisorDecision(text, options) {
  let value;
  try { value = JSON.parse(String(text)); }
  catch { throw new TypeError('Dev Supervisor decision must be exactly one JSON object.'); }
  return validateDevSupervisorDecision(value, options);
}

export function validateDevSupervisorDecision(value, { availableTools = null } = {}) {
  if (!isPlainObject(value)) throw new TypeError('Dev Supervisor decision must be an object.');
  const type = String(value.type || '');
  if (!DEV_SUPERVISOR_DECISION_TYPES.includes(type)) throw new TypeError(`Unsupported Dev Supervisor decision type: ${type}`);
  assertExactKeys(value, SHAPES[type]);

  if (type === 'tool') {
    const tool = nonEmpty(value.tool, 'tool');
    if (!isPlainObject(value.arguments)) throw new TypeError('tool.arguments must be an object.');
    if (availableTools != null && !new Set(availableTools).has(tool)) throw new TypeError(`Unavailable Dev tool: ${tool}`);
    return freezeDecision({ type, tool, arguments: cloneJson(value.arguments), purpose: nonEmpty(value.purpose, 'purpose') });
  }
  if (type === 'human') {
    if (typeof value.blocking !== 'boolean') throw new TypeError('human.blocking must be boolean.');
    return freezeDecision({ type, question: nonEmpty(value.question, 'question'), blocking: value.blocking });
  }
  if (type === 'wait') {
    if (!Array.isArray(value.events) || value.events.some((event) => typeof event !== 'string' || !event.trim())) {
      throw new TypeError('wait.events must be an array of non-empty strings.');
    }
    return freezeDecision({ type, events: [...value.events], reason: nonEmpty(value.reason, 'reason') });
  }
  if (!Array.isArray(value.completedTasks) || !Array.isArray(value.remaining)) {
    throw new TypeError('final.completedTasks and final.remaining must be arrays.');
  }
  return freezeDecision({
    type,
    answer: String(value.answer ?? ''),
    completedTasks: cloneJson(value.completedTasks),
    remaining: cloneJson(value.remaining),
  });
}

function assertExactKeys(value, allowed) {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`Malformed ${value.type || 'unknown'} decision shape.`);
  }
}
function nonEmpty(value, field) { const text = String(value || '').trim(); if (!text) throw new TypeError(`${field} is required.`); return text; }
function isPlainObject(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; }
function cloneJson(value) { try { return JSON.parse(JSON.stringify(value)); } catch { throw new TypeError('Dev Supervisor decision must be JSON-safe.'); } }
function freezeDecision(value) { for (const child of Object.values(value)) if (child && typeof child === 'object') Object.freeze(child); return Object.freeze(value); }
