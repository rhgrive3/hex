/*
 * Prompt composition.
 *
 * The system prompt is assembled from independent parts rather than stored as
 * one large string: core -> mode -> style -> task hint -> workbench context.
 * Every part is optional except core, and every part is a plain string, so a
 * composed prompt is fully inspectable in a test without a browser.
 *
 * Pure module. No DOM, no network, no app imports.
 */
import { CORE_PROMPT } from './core.js';
import { CHAT_PROMPT } from './chat.js';
import { AGENT_PROMPT } from './agent.js';
import { BEGINNER_PROMPT } from './beginner.js';
import { ANALYST_PROMPT } from './analyst.js';
import { detectTask, taskHint } from './task.js';

export const MODES = Object.freeze(['chat', 'agent']);
export const STYLES = Object.freeze(['beginner', 'analyst']);
export const SCOPES = Object.freeze([
  'auto', 'function', 'selection', 'neighborhood', 'binary', 'project', 'runtime',
]);

const SCOPE_RULES = Object.freeze({
  auto: 'Scope is Auto: use the narrowest context that can answer the question, and widen only when the narrow context cannot.',
  function: 'Scope is the current function: do not draw conclusions from code outside it. Say so when the answer needs a wider scope.',
  selection: 'Scope is the current selection: explain the selected instructions themselves. Reference surrounding code only to make the selection understandable.',
  neighborhood: 'Scope is the current function plus its direct callers and callees.',
  binary: 'Scope is the whole binary. Prefer indexes and searches over exhaustive per-function analysis.',
  project: 'Scope is the whole project, including saved names, comments, findings, and other loaded binaries.',
  runtime: 'Scope is runtime observation: prefer recorded execution facts, and mark any static inference as such.',
});

const MAX_LIST = 12;
const MAX_TEXT = 400;

function clip(value, limit = MAX_TEXT) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function line(label, value) {
  const text = clip(value);
  return text ? label + ': ' + text : '';
}

/**
 * The `<workbench>` block: what Hex currently has open.
 *
 * This is a factual statement of UI state, never an instruction, and never a
 * place to smuggle analysis results the tools have not produced.
 */
export function composeContextBlock(context = {}) {
  const rows = [];
  const binary = context.binary || null;
  if (binary) {
    rows.push(line('binary', [binary.name, binary.format, binary.architecture].filter(Boolean).join(' · ')));
  }
  const fn = context.function || null;
  if (fn) {
    rows.push(line('current function', [fn.name, fn.address].filter(Boolean).join(' @ ')));
    if (fn.owner) rows.push(line('declared in', fn.owner));
    if (Number.isFinite(fn.instructions)) rows.push(line('instructions', String(fn.instructions)));
    if (Number.isFinite(fn.callers)) rows.push(line('known callers', String(fn.callers)));
  }
  const selection = context.selection || null;
  if (selection) {
    rows.push(line('selection', [selection.kind, selection.address, selection.text].filter(Boolean).join(' · ')));
  }
  const notes = Array.isArray(context.notes) ? context.notes.slice(0, MAX_LIST) : [];
  for (const note of notes) rows.push(line('note', note));

  const body = rows.filter(Boolean).join('\n');
  if (!body) return '';
  return '<workbench>\n' + body + '\n\nThis is the workbench state, not an analysis result. Do not treat any of it as a verified conclusion.\n</workbench>';
}

function scopeBlock(scope) {
  const rule = SCOPE_RULES[scope] || SCOPE_RULES.auto;
  return '<scope name="' + scope + '">\n' + rule + '\n</scope>';
}

/**
 * Compose the full system prompt for one turn.
 *
 * @param {object} input
 * @param {'chat'|'agent'} input.mode
 * @param {'beginner'|'analyst'} input.style
 * @param {string} input.question
 * @param {object} [input.context] workbench state from the UI bridge
 * @param {string} [input.scope]
 * @param {string} [input.task] force a task hint instead of detecting one
 * @returns {{system:string, sections:Array<{id:string,text:string}>, mode:string, style:string, scope:string, task:string|null, question:string}}
 */
export function composePrompt(input = {}) {
  const mode = MODES.includes(input.mode) ? input.mode : 'chat';
  const style = STYLES.includes(input.style) ? input.style : 'beginner';
  const scope = SCOPES.includes(input.scope) ? input.scope : 'auto';
  const question = String(input.question == null ? '' : input.question).trim();
  const context = input.context || {};
  const task = input.task && taskHint(input.task)
    ? input.task
    : detectTask(question, { selection: context.selection ? context.selection.kind : null });

  const sections = [
    { id: 'core', text: CORE_PROMPT },
    { id: 'mode', text: mode === 'agent' ? AGENT_PROMPT : CHAT_PROMPT },
    { id: 'style', text: style === 'analyst' ? ANALYST_PROMPT : BEGINNER_PROMPT },
    { id: 'scope', text: scopeBlock(scope) },
    { id: 'task', text: taskHint(task) },
    { id: 'workbench', text: composeContextBlock(context) },
  ].filter((section) => !!section.text);

  return {
    system: sections.map((section) => section.text).join('\n\n'),
    sections,
    mode,
    style,
    scope,
    task: task || null,
    question,
  };
}

/**
 * The per-turn parts of a composed prompt.
 *
 * Some transports carry their own fixed system instruction and only accept a
 * bounded question (the /api/gemini endpoint caps it at 6000 characters).
 * Sending the core prompt there wastes that budget restating rules the
 * endpoint already sets, so only the parts that change per turn go along.
 */
export function compactGuidance(prompt) {
  const wanted = new Set(['mode', 'style', 'scope', 'task']);
  return (prompt && prompt.sections || [])
    .filter((section) => wanted.has(section.id))
    .map((section) => section.text)
    .join('\n\n');
}

export default composePrompt;
