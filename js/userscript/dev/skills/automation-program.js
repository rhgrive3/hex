const PROGRAM_VERSION = 1;
const MAX_STEPS = 128;
const MAX_DEPTH = 6;
const MAX_COLLECTION = 128;
const MAX_SELECTOR = 320;
const MAX_VALUE = 8192;
const MAX_WAIT_MS = 15000;
const MUTATION_OPS = new Set(['focus', 'click', 'setValue', 'dispatchEvent', 'navigate']);
const EVENT_TYPES = new Set(['input', 'change', 'click', 'keydown', 'keyup', 'pointerdown', 'pointerup']);
const ALLOWED_PROPERTY_READS = new Set(['disabled', 'checked', 'selected', 'value', 'type', 'name', 'href', 'pathname']);

export const AUTOMATION_PROGRAM_VERSION = PROGRAM_VERSION;

export function validateAutomationProgram(program, { requireReadOnly = false } = {}) {
  const normalized = normalizeProgram(program);
  let count = 0;
  walkSteps(normalized.steps, 0, (step) => {
    count += 1;
    if (count > MAX_STEPS) throw programError('program-too-large', `AutomationProgram exceeds ${MAX_STEPS} steps.`);
    if (requireReadOnly && MUTATION_OPS.has(step.op)) {
      throw programError('program-not-read-only', `Mutation op is not allowed in validation: ${step.op}`);
    }
    validateStep(step);
  });
  if (requireReadOnly && normalized.readOnly !== true) {
    throw programError('program-not-read-only', 'Validation programs must declare readOnly=true.');
  }
  return normalized;
}

export async function executeAutomationProgram(program, {
  document = globalThis.document,
  location = globalThis.location,
  signal = null,
  now = () => Date.now(),
  sleep = defaultSleep,
  requireReadOnly = false,
} = {}) {
  const normalized = validateAutomationProgram(program, { requireReadOnly });
  if (!document || typeof document.querySelector !== 'function') {
    throw programError('document-unavailable', 'ChatGPT document is unavailable to AutomationProgram.');
  }
  const context = new Map();
  context.set('$document', document);
  const state = { document, location, signal, now, sleep, context, returned: false, returnValue: null, stepCount: 0 };
  await runSteps(normalized.steps, state, 0);
  return sanitizeReturn(state.returned ? state.returnValue : snapshotVars(context));
}

function normalizeProgram(program) {
  if (!plainRecord(program)) throw new TypeError('AutomationProgram must be a plain object.');
  const version = Number(program.version ?? PROGRAM_VERSION);
  if (version !== PROGRAM_VERSION) throw programError('program-version-unsupported', `Unsupported AutomationProgram version: ${program.version}`);
  if (!Array.isArray(program.steps)) throw new TypeError('AutomationProgram steps must be an array.');
  return Object.freeze({
    version: PROGRAM_VERSION,
    name: boundedString(program.name || 'program', 120),
    readOnly: program.readOnly === true,
    steps: clonePlain(program.steps),
  });
}

async function runSteps(steps, state, depth) {
  if (depth > MAX_DEPTH) throw programError('program-depth-exceeded', 'AutomationProgram nesting is too deep.');
  for (const step of steps) {
    throwIfAborted(state.signal);
    if (state.returned) return;
    state.stepCount += 1;
    if (state.stepCount > MAX_STEPS) throw programError('program-too-large', `AutomationProgram exceeds ${MAX_STEPS} steps.`);
    await runStep(step, state, depth);
  }
}

async function runStep(step, state, depth) {
  const op = step.op;
  if (op === 'query') {
    const root = resolveNodeOrDocument(state, step.root);
    const node = queryFirst(root, selectorList(step.selector ?? step.selectors));
    setVar(state, step.as, node);
    return;
  }
  if (op === 'queryAll') {
    const root = resolveNodeOrDocument(state, step.root);
    const selector = selectorText(step.selector);
    const nodes = [...(root.querySelectorAll?.(selector) || [])].slice(0, boundedInteger(step.limit, 1, MAX_COLLECTION, MAX_COLLECTION));
    setVar(state, step.as, nodes);
    return;
  }
  if (op === 'closest') {
    const node = resolveNode(state, step.target);
    setVar(state, step.as, node?.closest?.(selectorText(step.selector)) || null);
    return;
  }
  if (op === 'findText') {
    const items = resolveCollection(state, step.from);
    const needle = boundedString(resolveValue(state, step.text), 512);
    const exact = step.exact === true;
    const caseSensitive = step.caseSensitive === true;
    const wanted = caseSensitive ? needle : needle.toLowerCase();
    const found = items.find((node) => {
      const raw = String(node?.textContent || '').replace(/\s+/g, ' ').trim();
      const value = caseSensitive ? raw : raw.toLowerCase();
      return exact ? value === wanted : value.includes(wanted);
    }) || null;
    setVar(state, step.as, found);
    return;
  }
  if (op === 'readText') {
    const node = resolveNode(state, step.target);
    setVar(state, step.as, boundedString(node?.textContent || '', boundedInteger(step.maxChars, 1, MAX_VALUE, 2048)));
    return;
  }
  if (op === 'readAttribute') {
    const node = resolveNode(state, step.target);
    const name = safeAttributeName(step.name);
    setVar(state, step.as, boundedString(node?.getAttribute?.(name) ?? '', boundedInteger(step.maxChars, 1, MAX_VALUE, 2048)) || null);
    return;
  }
  if (op === 'readProperty') {
    const node = resolveNode(state, step.target);
    const name = String(step.name || '');
    if (!ALLOWED_PROPERTY_READS.has(name)) throw programError('property-not-allowed', `Property read is not allowed: ${name}`);
    setVar(state, step.as, primitive(node?.[name]));
    return;
  }
  if (op === 'collect') {
    const items = resolveCollection(state, step.from).slice(0, boundedInteger(step.limit, 1, MAX_COLLECTION, MAX_COLLECTION));
    const fields = normalizeCollectFields(step.fields);
    const rows = items.map((node) => collectNode(node, fields));
    setVar(state, step.as, rows);
    return;
  }
  if (op === 'focus') {
    resolveNodeRequired(state, step.target).focus?.();
    return;
  }
  if (op === 'click') {
    const node = resolveNodeRequired(state, step.target);
    if (isDisabled(node)) throw programError('target-disabled', 'AutomationProgram click target is disabled.');
    node.click?.();
    return;
  }
  if (op === 'setValue') {
    const node = resolveNodeRequired(state, step.target);
    const value = boundedString(resolveValue(state, step.value), MAX_VALUE);
    setEditableValue(node, value);
    return;
  }
  if (op === 'dispatchEvent') {
    const node = resolveNodeRequired(state, step.target);
    const type = String(step.type || '');
    if (!EVENT_TYPES.has(type)) throw programError('event-not-allowed', `Event type is not allowed: ${type}`);
    const init = normalizeEventInit(step.init);
    const event = createEvent(type, init);
    node.dispatchEvent?.(event);
    return;
  }
  if (op === 'waitFor') {
    const timeoutMs = boundedInteger(step.timeoutMs, 1, MAX_WAIT_MS, 5000);
    const pollMs = boundedInteger(step.pollMs, 10, 1000, 50);
    const root = resolveNodeOrDocument(state, step.root);
    const selectors = selectorList(step.selector ?? step.selectors);
    const started = state.now();
    let found = null;
    while (state.now() - started <= timeoutMs) {
      throwIfAborted(state.signal);
      found = queryFirst(root, selectors);
      if (found && (!step.visible || isVisible(found))) break;
      found = null;
      await state.sleep(pollMs, state.signal);
    }
    if (!found && step.optional !== true) throw programError('wait-timeout', `waitFor timed out after ${timeoutMs} ms.`);
    setVar(state, step.as, found);
    return;
  }
  if (op === 'assert') {
    assertCondition(step, state);
    return;
  }
  if (op === 'if') {
    const branch = conditionValue(step.condition, state) ? step.then : step.else;
    await runSteps(Array.isArray(branch) ? branch : [], state, depth + 1);
    return;
  }
  if (op === 'forEach') {
    const items = resolveCollection(state, step.from);
    const maxIterations = boundedInteger(step.maxIterations, 1, 64, 32);
    const varName = variableName(step.item || 'item');
    let index = 0;
    for (const item of items.slice(0, maxIterations)) {
      setVar(state, varName, item);
      if (step.index) setVar(state, step.index, index);
      await runSteps(step.steps, state, depth + 1);
      if (state.returned) return;
      index += 1;
    }
    return;
  }
  if (op === 'navigate') {
    const value = boundedString(resolveValue(state, step.url), 2048);
    const url = safeChatGptUrl(value, state.location?.href);
    if (!url) throw programError('navigation-not-allowed', 'AutomationProgram navigation is limited to ChatGPT HTTPS origins.');
    if (typeof state.location?.assign === 'function') state.location.assign(url.href);
    else if (state.location) state.location.href = url.href;
    else throw programError('location-unavailable', 'ChatGPT location is unavailable.');
    return;
  }
  if (op === 'return') {
    state.returnValue = resolveTemplate(state, step.value);
    state.returned = true;
    return;
  }
  throw programError('op-unsupported', `Unsupported AutomationProgram op: ${op}`);
}

function validateStep(step) {
  if (!plainRecord(step)) throw new TypeError('AutomationProgram step must be a plain object.');
  const op = String(step.op || '');
  const supported = new Set(['query','queryAll','closest','findText','readText','readAttribute','readProperty','collect','focus','click','setValue','dispatchEvent','waitFor','assert','if','forEach','navigate','return']);
  if (!supported.has(op)) throw programError('op-unsupported', `Unsupported AutomationProgram op: ${op}`);
  if (['query','queryAll','closest','waitFor'].includes(op)) {
    const source = step.selector ?? step.selectors;
    if (source != null) selectorList(source);
  }
  if (['query','queryAll','closest','findText','readText','readAttribute','readProperty','collect','waitFor'].includes(op) && step.as != null) variableName(step.as);
  if (op === 'forEach') {
    if (!Array.isArray(step.steps)) throw new TypeError('forEach steps must be an array.');
    boundedInteger(step.maxIterations, 1, 64, 32);
  }
  if (op === 'if') {
    if (step.then != null && !Array.isArray(step.then)) throw new TypeError('if.then must be an array.');
    if (step.else != null && !Array.isArray(step.else)) throw new TypeError('if.else must be an array.');
  }
  if (op === 'dispatchEvent' && !EVENT_TYPES.has(String(step.type || ''))) throw programError('event-not-allowed', `Event type is not allowed: ${step.type}`);
}

function walkSteps(steps, depth, visit) {
  if (depth > MAX_DEPTH) throw programError('program-depth-exceeded', 'AutomationProgram nesting is too deep.');
  for (const step of steps) {
    visit(step);
    if (step.op === 'if') {
      walkSteps(Array.isArray(step.then) ? step.then : [], depth + 1, visit);
      walkSteps(Array.isArray(step.else) ? step.else : [], depth + 1, visit);
    }
    if (step.op === 'forEach') walkSteps(Array.isArray(step.steps) ? step.steps : [], depth + 1, visit);
  }
}

function queryFirst(root, selectors) {
  for (const selector of selectors) {
    let node = null;
    try { node = root.querySelector?.(selector) || null; } catch {}
    if (node) return node;
  }
  return null;
}

function selectorList(value) {
  const list = Array.isArray(value) ? value : [value];
  const normalized = list.map(selectorText);
  if (!normalized.length || normalized.length > 16) throw new TypeError('Selector list must contain 1-16 selectors.');
  return normalized;
}
function selectorText(value) {
  const text = String(value || '').trim();
  if (!text || text.length > MAX_SELECTOR) throw new TypeError(`CSS selector must be 1-${MAX_SELECTOR} characters.`);
  return text;
}
function variableName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/.test(name)) throw new TypeError(`Invalid AutomationProgram variable: ${value}`);
  return name;
}
function setVar(state, name, value) {
  if (name == null || name === '') return value;
  state.context.set(variableName(name), value);
  return value;
}
function resolveNodeOrDocument(state, name) {
  if (name == null || name === '' || name === '$document') return state.document;
  const value = state.context.get(variableName(name));
  if (!value || (!value.querySelector && !value.querySelectorAll)) throw programError('target-not-queryable', `Target is not queryable: ${name}`);
  return value;
}
function resolveNode(state, name) {
  if (name == null) return null;
  const value = state.context.get(variableName(name));
  return value && !Array.isArray(value) ? value : null;
}
function resolveNodeRequired(state, name) {
  const value = resolveNode(state, name);
  if (!value) throw programError('target-missing', `AutomationProgram target is missing: ${name}`);
  return value;
}
function resolveCollection(state, name) {
  const value = state.context.get(variableName(name));
  if (!Array.isArray(value)) throw programError('collection-missing', `AutomationProgram collection is missing: ${name}`);
  return value;
}
function resolveValue(state, value) {
  if (plainRecord(value) && typeof value.var === 'string') return state.context.get(variableName(value.var));
  return value == null ? '' : value;
}
function resolveTemplate(state, value) {
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(state, item));
  if (plainRecord(value)) {
    if (typeof value.var === 'string' && Object.keys(value).length === 1) return state.context.get(variableName(value.var));
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveTemplate(state, item);
    return out;
  }
  return value;
}
function assertCondition(step, state) {
  const condition = step.condition || { type: 'exists', target: step.target };
  if (!conditionValue(condition, state)) throw programError('assertion-failed', boundedString(step.message || 'AutomationProgram assertion failed.', 300));
}
function conditionValue(condition, state) {
  if (!plainRecord(condition)) throw new TypeError('AutomationProgram condition must be a plain object.');
  const type = String(condition.type || 'exists');
  if (type === 'exists') return !!resolveNode(state, condition.target);
  if (type === 'missing') return !resolveNode(state, condition.target);
  if (type === 'truthy') return !!state.context.get(variableName(condition.var));
  if (type === 'equals') return primitive(resolveValue(state, condition.left)) === primitive(resolveValue(state, condition.right));
  if (type === 'textIncludes') {
    const node = resolveNode(state, condition.target);
    return String(node?.textContent || '').includes(String(resolveValue(state, condition.text) || ''));
  }
  throw programError('condition-unsupported', `Unsupported AutomationProgram condition: ${type}`);
}
function collectNode(node, fields) {
  const out = {};
  for (const field of fields) {
    if (field.kind === 'text') out[field.as] = boundedString(node?.textContent || '', field.maxChars);
    else if (field.kind === 'attribute') out[field.as] = boundedString(node?.getAttribute?.(field.name) ?? '', field.maxChars) || null;
    else if (field.kind === 'property') out[field.as] = primitive(node?.[field.name]);
  }
  return out;
}
function normalizeCollectFields(value) {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new TypeError('collect.fields must contain 1-16 field descriptors.');
  return value.map((field) => {
    if (!plainRecord(field)) throw new TypeError('collect field must be a plain object.');
    const kind = String(field.kind || 'text');
    const as = variableName(field.as || kind);
    const maxChars = boundedInteger(field.maxChars, 1, 2048, 512);
    if (kind === 'text') return { kind, as, maxChars };
    if (kind === 'attribute') return { kind, as, name: safeAttributeName(field.name), maxChars };
    if (kind === 'property') {
      const name = String(field.name || '');
      if (!ALLOWED_PROPERTY_READS.has(name)) throw programError('property-not-allowed', `Property read is not allowed: ${name}`);
      return { kind, as, name, maxChars };
    }
    throw new TypeError(`Unsupported collect field kind: ${kind}`);
  });
}
function safeAttributeName(value) {
  const name = String(value || '').trim();
  if (!/^(?:id|class|role|title|name|type|placeholder|href|for|tabindex|disabled|checked|selected|aria-[\w-]+|data-[\w-]+)$/i.test(name)) {
    throw programError('attribute-not-allowed', `Attribute read is not allowed: ${name}`);
  }
  if (/(?:token|auth|session|csrf|nonce|secret|password|credential|cookie)/i.test(name)) throw programError('attribute-not-allowed', `Sensitive attribute is not allowed: ${name}`);
  return name;
}
function setEditableValue(node, value) {
  const tag = String(node?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    node.value = value;
    return;
  }
  if (node?.isContentEditable === true || node?.getAttribute?.('contenteditable') === 'true' || node?.getAttribute?.('contenteditable') === '') {
    node.textContent = value;
    return;
  }
  throw programError('target-not-editable', 'AutomationProgram setValue target is not editable.');
}
function normalizeEventInit(value) {
  if (value == null) return { bubbles: true, cancelable: true };
  if (!plainRecord(value)) throw new TypeError('Event init must be a plain object.');
  const out = { bubbles: value.bubbles !== false, cancelable: value.cancelable !== false };
  if (value.key != null) out.key = boundedString(value.key, 64);
  if (value.code != null) out.code = boundedString(value.code, 64);
  return out;
}
function createEvent(type, init) {
  try {
    if ((type === 'keydown' || type === 'keyup') && typeof KeyboardEvent !== 'undefined') return new KeyboardEvent(type, init);
    if (typeof Event !== 'undefined') return new Event(type, init);
  } catch {}
  return { type, ...init };
}
function safeChatGptUrl(value, base) {
  try {
    const url = new URL(value, base || 'https://chatgpt.com/');
    if (url.protocol !== 'https:') return null;
    if (!['chatgpt.com', 'chat.openai.com'].includes(url.hostname)) return null;
    return url;
  } catch { return null; }
}
function isDisabled(node) { return !!node?.disabled || node?.getAttribute?.('aria-disabled') === 'true'; }
function isVisible(node) {
  if (!node || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
  try { const rect = node.getBoundingClientRect?.(); return !rect || rect.width > 0 || rect.height > 0; } catch { return true; }
}
function snapshotVars(context) {
  const out = {};
  for (const [key, value] of context.entries()) {
    if (key === '$document') continue;
    if (isDomLike(value) || (Array.isArray(value) && value.some(isDomLike))) continue;
    out[key] = value;
  }
  return out;
}
function sanitizeReturn(value, depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (depth > 12) throw programError('return-too-deep', 'AutomationProgram return value is too deep.');
  if (isDomLike(value)) return describeDomRef(value);
  if (Array.isArray(value)) return value.slice(0, MAX_COLLECTION).map((item) => sanitizeReturn(item, depth + 1));
  if (plainRecord(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 128)) out[key] = sanitizeReturn(item, depth + 1);
    return out;
  }
  return primitive(value);
}
function describeDomRef(node) {
  return {
    node: String(node?.tagName || node?.nodeName || '').toLowerCase() || 'element',
    role: boundedString(node?.getAttribute?.('role') || '', 80) || null,
    testId: boundedString(node?.getAttribute?.('data-testid') || '', 120) || null,
    ariaLabel: boundedString(node?.getAttribute?.('aria-label') || '', 160) || null,
  };
}
function isDomLike(value) { return !!value && typeof value === 'object' && (typeof value.querySelector === 'function' || typeof value.tagName === 'string'); }
function primitive(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return boundedString(value, 1024);
}
function boundedString(value, max) { return String(value ?? '').slice(0, max); }
function boundedInteger(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('Expected a finite numeric bound.');
  return Math.min(max, Math.max(min, Math.floor(number)));
}
function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function clonePlain(value) { return JSON.parse(JSON.stringify(value)); }
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = programError('cancelled', String(signal.reason || 'cancelled'));
  error.name = 'AbortError';
  throw error;
}
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(programError('cancelled', String(signal.reason || 'cancelled')));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); reject(programError('cancelled', String(signal.reason || 'cancelled'))); }, { once: true });
  });
}
function programError(code, message) { const error = new Error(message); error.code = code; return error; }
