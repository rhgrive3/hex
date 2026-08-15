/* Canonical prompt composition for core, worker and fallback transports. */
import { CORE_PROMPT } from './core.js';
import { CHAT_PROMPT } from './chat.js';
import { AGENT_PROMPT } from './agent.js';
import { BEGINNER_PROMPT } from './beginner.js';
import { ANALYST_PROMPT } from './analyst.js';
import { detectTask, taskHint } from './task.js';
import { RUNTIME_SAFETY_PROMPT } from './runtime-safety.js';

export const MODES = Object.freeze(['chat', 'agent']);
export const STYLES = Object.freeze(['beginner', 'analyst']);
export const SCOPES = Object.freeze(['auto', 'function', 'selection', 'neighborhood', 'binary', 'project', 'runtime']);
const SCOPE_RULES = Object.freeze({
  auto: 'Scope is Auto: use the narrowest context that can answer the question, and widen only through the control-plane expansion policy.',
  function: 'Scope is the current function: do not read or draw conclusions from addresses outside its snapshotted range.',
  selection: 'Scope is the current selection: explain only the snapshotted selected instructions. Full-function reads require scope expansion.',
  neighborhood: 'Scope is the current function plus the explicitly admitted caller/callee neighborhood.',
  binary: 'Scope is the current binary. Prefer indexes and bounded searches over exhaustive per-function analysis.',
  project: 'Scope is the current project, including saved names, comments, findings, and loaded binary metadata.',
  runtime: 'Scope is the bound runtime session: prefer observed execution facts and distinguish static inference.',
});
const MAX_LIST = 12, MAX_TEXT = 400;
function clip(value, limit = MAX_TEXT) { const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); return text.length > limit ? text.slice(0, limit - 1) + '…' : text; }
function line(label, value) { const text = clip(value); return text ? label + ': ' + text : ''; }
export function composeContextBlock(context = {}) {
  const rows = [], binary = context.binary || null;
  if (binary) rows.push(line('binary', [binary.name, binary.format, binary.architecture].filter(Boolean).join(' · ')));
  const fn = context.function || null;
  if (fn) { rows.push(line('current function', [fn.name, fn.address].filter(Boolean).join(' @ '))); if (fn.owner) rows.push(line('declared in', fn.owner)); if (Number.isFinite(fn.instructions)) rows.push(line('instructions', String(fn.instructions))); if (Number.isFinite(fn.callers)) rows.push(line('known callers', String(fn.callers))); }
  const selection = context.selection || null;
  if (selection) rows.push(line('selection', [selection.kind, selection.address, selection.text].filter(Boolean).join(' · ')));
  for (const note of Array.isArray(context.notes) ? context.notes.slice(0, MAX_LIST) : []) rows.push(line('note', note));
  const body = rows.filter(Boolean).join('\n');
  return body ? '<workbench>\n' + body + '\n\nThis is workbench state, not an analysis result.\n</workbench>' : '';
}
function scopeBlock(scope) { return '<scope name="' + scope + '">\n' + (SCOPE_RULES[scope] || SCOPE_RULES.auto) + '\n</scope>'; }
function intentBlock(intent) { return intent ? `<intent>\n${clip(intent, 120)}\n</intent>` : ''; }
export function composePrompt(input = {}) {
  const mode = MODES.includes(input.mode) ? input.mode : 'chat';
  const style = STYLES.includes(input.style) ? input.style : 'beginner';
  const scope = SCOPES.includes(input.scope) ? input.scope : 'auto';
  const question = String(input.question == null ? '' : input.question).trim();
  const context = input.context || {};
  const task = input.task && taskHint(input.task) ? input.task : detectTask(question, { selection: context.selection ? context.selection.kind : null });
  const sections = [
    { id: 'core', text: CORE_PROMPT }, { id: 'mode', text: mode === 'agent' ? AGENT_PROMPT : CHAT_PROMPT },
    { id: 'style', text: style === 'analyst' ? ANALYST_PROMPT : BEGINNER_PROMPT }, { id: 'scope', text: scopeBlock(scope) },
    { id: 'task', text: taskHint(task) }, { id: 'intent', text: intentBlock(input.intent) },
    { id: 'runtime-safety', text: RUNTIME_SAFETY_PROMPT }, { id: 'workbench', text: composeContextBlock(context) },
  ].filter((section) => !!section.text);
  return { system: sections.map((section) => section.text).join('\n\n'), sections, mode, style, scope, task: task || null, intent: input.intent || null, question };
}
export function compactGuidance(prompt) {
  const wanted = new Set(['mode', 'style', 'scope', 'task', 'intent', 'runtime-safety']);
  return (prompt?.sections || []).filter((section) => wanted.has(section.id)).map((section) => section.text).join('\n\n');
}
export default composePrompt;
