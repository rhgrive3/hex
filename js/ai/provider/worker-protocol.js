import { boundedText, byteLength, HttpError, MAX_CONTEXT_CHARS } from './worker-transport.js';

const MAX_QUESTION_CHARS = 6000;
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);
const AI_MODES = new Set(['chat', 'agent']);
const AI_STYLES = new Set(['beginner', 'analyst']);
const AI_SCOPES = new Set(['auto', 'selection', 'function', 'neighborhood', 'binary', 'project', 'runtime']);
const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const RESERVED_TOOL_NAMES = new Set(['submit_hex_result']);

export function normalizeAITurnRequest(value) {
  if (!isObject(value)) throw new HttpError(400, 'invalid_request', 'The request body must be an object.');
  const mode = String(value.mode || 'chat'), style = String(value.style || 'analyst');
  const legacyScope = String(value.scope || 'auto');
  const requestedScope = String(value.requestedScope || legacyScope);
  const effectiveScope = String(value.effectiveScope || (legacyScope === 'auto' ? 'auto' : legacyScope));
  if (!AI_MODES.has(mode)) throw new HttpError(422, 'invalid_mode', 'mode must be chat or agent.');
  if (!AI_STYLES.has(style)) throw new HttpError(422, 'invalid_style', 'style must be beginner or analyst.');
  if (!AI_SCOPES.has(requestedScope) || !AI_SCOPES.has(effectiveScope)) throw new HttpError(422, 'invalid_scope', 'scope is unsupported.');
  if (!isObject(value.context)) throw new HttpError(422, 'missing_context', 'A bounded model context object is required.');
  rejectBinaryPayload(value.context);
  const messages = Array.isArray(value.messages) ? value.messages.slice(-12).map((message) => ({ role: message?.role === 'assistant' ? 'assistant' : 'user', content: boundedText(message?.content, 12000) })) : [];
  const goal = boundedText(value.context?.request?.goal, MAX_QUESTION_CHARS).trim() || [...messages].reverse().find((message) => message.role === 'user' && message.content.trim())?.content.trim();
  if (!goal) throw new HttpError(422, 'missing_question', 'A non-empty AI goal is required.');
  const context = sanitizeValue(value.context, 0), tools = normalizeAITools(value.tools);
  const intent = boundedText(value.intent || value.context?.request?.intent, 100), task = boundedText(value.task || value.context?.request?.task, 100);
  const serialized = JSON.stringify({ messages, context, tools, requestedScope, effectiveScope, intent, task });
  if (byteLength(serialized) > MAX_CONTEXT_CHARS) throw new HttpError(413, 'request_too_large', 'The bounded AI context is too large.');
  return { sessionId: boundedText(value.sessionId, 200) || null, mode, style, scope: effectiveScope, requestedScope, effectiveScope, intent: intent || null, task: task || null, goal, messages, context, tools };
}

export function normalizeAITools(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(), out = [];
  for (const raw of value.slice(0, 40)) {
    if (!isObject(raw)) continue;
    const name = boundedText(raw.name, 64);
    // The browser ToolRegistry is the authority for which read-only tools are
    // visible in this turn. The Worker validates the transport surface rather
    // than duplicating a static tool-name list that would make future Registry
    // additions unreachable. The Worker-owned final-result tool is reserved.
    if (!TOOL_NAME.test(name) || RESERVED_TOOL_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name); out.push({ name, description: boundedText(raw.description, 2000), inputSchema: sanitizeToolSchema(raw.inputSchema) });
  }
  return out;
}

/*
 * `target[key] = value` with key '__proto__' runs the inherited
 * Object.prototype.__proto__ setter rather than creating an own property: the
 * input's own '__proto__' entry is dropped and the sanitized object's
 * prototype is replaced by attacker-supplied data (#1304). Every key that
 * comes from outside is therefore defined, never assigned.
 */
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  return target;
}

export function sanitizeToolSchema(value, depth = 0) {
  if (depth > 8 || !isObject(value)) return { type: 'object', properties: {} };
  const allowed = new Set(['type','description','enum','const','properties','required','items','oneOf','anyOf','minimum','maximum','minLength','maxLength','pattern','additionalProperties']);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (!allowed.has(key)) continue;
    if (key === 'properties' && isObject(item)) { out.properties = {}; for (const [prop, schema] of Object.entries(item).slice(0, 80)) defineOwn(out.properties, boundedText(prop, 80), sanitizeToolSchema(schema, depth + 1)); }
    else if (key === 'items' && isObject(item)) out.items = sanitizeToolSchema(item, depth + 1);
    else if ((key === 'oneOf' || key === 'anyOf') && Array.isArray(item)) out[key] = item.slice(0, 8).map((schema) => sanitizeToolSchema(schema, depth + 1));
    else if (key === 'required' && Array.isArray(item)) out.required = item.slice(0, 80).map((name) => boundedText(name, 80));
    else if (key === 'enum' && Array.isArray(item)) out.enum = item.slice(0, 100).map((entry) => typeof entry === 'string' ? boundedText(entry, 300) : entry);
    else if (['type','description','pattern'].includes(key)) out[key] = boundedText(item, key === 'description' ? 1000 : 300);
    else if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string') out[key] = item;
  }
  if (depth === 0 && out.type !== 'object') out.type = 'object'; out.properties ||= {}; return out;
}

export function finalResultTool() {
  return { name: 'submit_hex_result', description: 'Submit the final user-facing answer. Cite only IDs present in Hex context.', inputSchema: {
    type: 'object', required: ['answer'], properties: {
      answer: { type: 'string', maxLength: 30000 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
      evidenceIds: { type: 'array', items: { type: 'string' } }, hypothesisIds: { type: 'array', items: { type: 'string' } },
      hypotheses: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, claim: { type: 'string' }, confidence: { type: 'number' }, status: { type: 'string' }, supportEvidenceIds: { type: 'array', items: { type: 'string' } }, contradictionEvidenceIds: { type: 'array', items: { type: 'string' } }, missingEvidence: { type: 'array', items: { type: 'string' } } } } },
      suggestedActions: { type: 'array', items: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' }, target: { type: 'string' }, label: { type: 'string' }, evidenceId: { type: 'string' } } } }, followups: { type: 'array', items: { type: 'string' } },
    },
  } };
}

export function normalizeAIInteraction(value, allowedTools) {
  const steps = [];
  if (Array.isArray(value?.steps)) steps.push(...value.steps);
  if (Array.isArray(value?.output)) steps.push(...value.output);
  if (Array.isArray(value?.response?.steps)) steps.push(...value.response.steps);
  const call = steps.find((step) => step && (step.type === 'function_call' || step.type === 'tool_call'));
  if (!call) throw new Error('The model did not return a complete function call.');
  const name = String(call.name || call.function?.name || '');
  let args = call.arguments ?? call.input ?? call.function?.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw new Error('The model returned malformed function arguments.'); } }
  if (!isObject(args)) throw new Error('The model function arguments must be an object.');
  if (name === 'submit_hex_result') {
    const answer = boundedText(args.answer, 30000).trim(); if (!answer) throw new Error('The final answer is empty.');
    return { type: 'final', answer, confidence: finiteConfidence(args.confidence), evidenceIds: stringList(args.evidenceIds, 100), hypothesisIds: stringList(args.hypothesisIds, 100), hypotheses: normalizeList(args.hypotheses, 30), suggestedActions: normalizeList(args.suggestedActions, 30), followups: stringList(args.followups, 20) };
  }
  if (!allowedTools.includes(name)) throw new Error('The model requested an unknown tool.');
  return { type: 'tool', tool: name, arguments: sanitizeValue(args, 0), purpose: boundedText(call.purpose, 1000) };
}

export function normalizeRequest(value) {
  if (!isObject(value)) throw new HttpError(400, 'invalid_request', 'The request body must be an object.');
  const question = boundedText(value.question, MAX_QUESTION_CHARS).trim(); if (!question) throw new HttpError(422, 'missing_question', 'A non-empty question is required.');
  const thinkingLevel = value.thinkingLevel == null ? 'high' : String(value.thinkingLevel); if (!THINKING_LEVELS.has(thinkingLevel)) throw new HttpError(422, 'invalid_thinking_level', 'thinkingLevel must be minimal, low, medium, or high.');
  const currentFunction = normalizeCurrentFunction(value.currentFunction);
  const context = { question, currentFunction, xrefs: normalizeList(value.xrefs, 60), callers: normalizeList(value.callers, 60), callees: normalizeList(value.callees, 60), strings: normalizeList(value.strings, 60), globals: normalizeList(value.globals, 60) };
  if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) throw new HttpError(413, 'request_too_large', 'The selected analysis context is too large.');
  return { thinkingLevel, context };
}

export function normalizeCurrentFunction(value) {
  if (!isObject(value)) throw new HttpError(422, 'missing_function', 'Current function context is required.');
  const address = boundedText(value.address, 80).trim(), assembly = boundedText(value.assembly, 120000).trim();
  if (!address || !assembly) throw new HttpError(422, 'missing_function', 'Current function address and assembly are required.');
  const rawMeta = isObject(value.assemblyMeta) ? value.assemblyMeta : {};
  const nonNegativeInt = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback; };
  const totalInstructions = nonNegativeInt(rawMeta.totalInstructions), includedInstructions = nonNegativeInt(rawMeta.includedInstructions);
  return { address, name: boundedText(value.name, 500).trim() || null, assembly, assemblyMeta: { totalInstructions, includedInstructions, startRow: rawMeta.startRow == null ? null : nonNegativeInt(rawMeta.startRow), endRow: rawMeta.endRow == null ? null : nonNegativeInt(rawMeta.endRow), truncated: rawMeta.truncated === true || totalInstructions > includedInstructions, omittedInstructions: Math.max(0, nonNegativeInt(rawMeta.omittedInstructions, Math.max(0, totalInstructions - includedInstructions))), selection: boundedText(rawMeta.selection, 40).trim() || 'unknown' }, pseudocode: boundedText(value.pseudocode, 30000).trim() || null };
}

export function promptWorkbench(context) {
  const fn = context?.current?.function || null, selection = context?.current?.selection || null;
  return { binary: context?.current?.binaryIdentity ? { name: context.current.binaryId, architecture: context?.turn?.architecture } : null, function: fn ? { address: fn.address, name: fn.name } : null, selection: selection ? { kind: 'snapshot', address: selection.start, text: selection.instructions?.[0]?.mnemonic } : null };
}
export function rejectBinaryPayload(value, depth = 0) { if (depth > 10 || !value || typeof value !== 'object') return; const forbidden = new Set(['binary','binaryBytes','fileBytes','rawBinary','byteSource','arrayBuffer']); for (const [key, item] of Object.entries(value)) { if (forbidden.has(key)) throw new HttpError(422, 'binary_upload_forbidden', 'Binary content cannot be sent to the AI worker.'); rejectBinaryPayload(item, depth + 1); } }
export function normalizeList(value, maxItems) { return Array.isArray(value) ? value.slice(0, maxItems).map((item) => sanitizeValue(item, 0)).filter((item) => item != null) : []; }
export function sanitizeValue(value, depth) { if (depth > 6) return null; if (typeof value === 'string') return boundedText(value, 6000); if (typeof value === 'number' || typeof value === 'boolean') return value; if (value == null) return null; if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeValue(item, depth + 1)).filter((item) => item != null); if (!isObject(value)) return null; const out = {}; for (const [key, item] of Object.entries(value).slice(0, 40)) { const clean = sanitizeValue(item, depth + 1); if (clean != null) defineOwn(out, boundedText(key, 80), clean); } return out; }
export function stringList(value, max) { return Array.isArray(value) ? value.slice(0, max).map((item) => boundedText(item, 2000)).filter(Boolean) : []; }
export function finiteConfidence(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined; }
export function isObject(value) { return value != null && typeof value === 'object' && !Array.isArray(value); }
