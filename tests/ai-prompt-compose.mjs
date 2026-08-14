/*
 * Prompt composition contract.
 *
 * The prompt layer is pure so this runs without a browser: what the assistant
 * is told is as testable as what it renders.
 */
import assert from 'node:assert/strict';
import { CORE_PROMPT } from '../js/ai/prompts/core.js';
import { CHAT_PROMPT } from '../js/ai/prompts/chat.js';
import { AGENT_PROMPT } from '../js/ai/prompts/agent.js';
import { BEGINNER_PROMPT } from '../js/ai/prompts/beginner.js';
import { ANALYST_PROMPT } from '../js/ai/prompts/analyst.js';
import { detectTask, taskHint, TASKS } from '../js/ai/prompts/task.js';
import { composePrompt, composeContextBlock, compactGuidance, MODES, STYLES, SCOPES } from '../js/ai/prompts/compose.js';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + ' — ' + error.message); }
}

const context = {
  binary: { name: 'battlecats', format: 'Mach-O', architecture: 'arm64' },
  function: { address: '0x100458c00', name: 'sub_100458C00', callers: 2, instructions: 41 },
  selection: { kind: 'instruction', address: '0x100458c10', text: 'str w1, [x0, #0xc030]' },
  notes: ['open region: __text'],
};

check('core rules are always present', () => {
  const prompt = composePrompt({ mode: 'chat', style: 'beginner', question: 'これは？' });
  assert.ok(prompt.system.includes('Hex AI Analyst'));
  assert.ok(prompt.system.includes('<evidence>'));
  assert.ok(prompt.system.includes('Never expose hidden chain-of-thought'));
  assert.equal(prompt.sections[0].id, 'core');
});

check('chat and agent modes contribute different instructions', () => {
  const chat = composePrompt({ mode: 'chat', question: 'x' });
  const agent = composePrompt({ mode: 'agent', question: 'x' });
  assert.ok(chat.system.includes(CHAT_PROMPT));
  assert.ok(!chat.system.includes(AGENT_PROMPT));
  assert.ok(agent.system.includes(AGENT_PROMPT));
  assert.ok(!agent.system.includes(CHAT_PROMPT));
});

check('beginner and analyst styles contribute different instructions', () => {
  const beginner = composePrompt({ style: 'beginner', question: 'x' });
  const analyst = composePrompt({ style: 'analyst', question: 'x' });
  assert.ok(beginner.system.includes(BEGINNER_PROMPT));
  assert.ok(analyst.system.includes(ANALYST_PROMPT));
  assert.ok(!analyst.system.includes(BEGINNER_PROMPT));
});

check('unknown mode, style and scope fall back instead of leaking through', () => {
  const prompt = composePrompt({ mode: 'wizard', style: 'poet', scope: 'galaxy', question: 'x' });
  assert.equal(prompt.mode, 'chat');
  assert.equal(prompt.style, 'beginner');
  assert.equal(prompt.scope, 'auto');
  assert.ok(!/wizard|poet|galaxy/.test(prompt.system));
});

check('every scope states its boundary', () => {
  for (const scope of SCOPES) {
    const prompt = composePrompt({ scope, question: 'x' });
    const section = prompt.sections.find((item) => item.id === 'scope');
    assert.ok(section, scope + ' has no scope section');
    assert.ok(section.text.includes('name="' + scope + '"'));
  }
});

check('the workbench block is labelled as state, not as a result', () => {
  const block = composeContextBlock(context);
  assert.ok(block.includes('0x100458c00'));
  assert.ok(block.includes('str w1, [x0, #0xc030]'));
  assert.ok(block.includes('not an analysis result'));
});

check('an empty workbench contributes no block at all', () => {
  assert.equal(composeContextBlock({}), '');
  const prompt = composePrompt({ question: 'x' });
  assert.ok(!prompt.sections.some((section) => section.id === 'workbench'));
});

check('task detection covers the documented intents', () => {
  const cases = [
    ['この命令は何をしていますか？', 'explain_instruction'],
    ['What does this instruction do?', 'explain_instruction'],
    ['この関数は何をしている？', 'explain_function'],
    ['コインが増える処理はどこ？', 'locate_behavior'],
    ['where does the coin counter increase', 'locate_behavior'],
    ['0xC030 に書き込んでいる処理は？', 'find_field_writer'],
    ['この値をどこまで追える？', 'trace_value'],
    ['この文字列はどこで使われている？', 'understand_string'],
    ['この2つの関数を比較して', 'compare_functions'],
    ['本当にXPを書いているか検証して', 'verify_hypothesis'],
    ['この関数に名前を提案して', 'rename_suggestion'],
    ['実行して確かめて', 'runtime_verification'],
    ['バージョン間の差分を出して', 'binary_diff'],
  ];
  for (const [question, expected] of cases) {
    assert.equal(detectTask(question), expected, question);
  }
});

check('a bare "explain" follows the current selection', () => {
  assert.equal(detectTask('explain', { selection: 'instruction' }), 'explain_instruction');
  assert.equal(detectTask('explain', { selection: null }), 'explain_function');
});

check('an unclassifiable question adds no task hint', () => {
  assert.equal(detectTask('hmm'), null);
  const prompt = composePrompt({ question: 'hmm' });
  assert.equal(prompt.task, null);
  assert.ok(!prompt.sections.some((section) => section.id === 'task'));
});

check('every task id has a hint and every hint has an id', () => {
  for (const task of TASKS) assert.ok(taskHint(task).includes('name="' + task + '"'), task);
  assert.equal(taskHint('not-a-task'), '');
});

check('a forced task overrides detection', () => {
  const prompt = composePrompt({ question: 'anything at all', task: 'binary_diff' });
  assert.equal(prompt.task, 'binary_diff');
  assert.ok(prompt.system.includes('name="binary_diff"'));
});

check('compact guidance drops the core prompt but keeps per-turn parts', () => {
  const prompt = composePrompt({ mode: 'agent', style: 'analyst', scope: 'function', question: 'この関数は何をしている？' });
  const compact = compactGuidance(prompt);
  assert.ok(!compact.includes(CORE_PROMPT));
  assert.ok(compact.includes(AGENT_PROMPT));
  assert.ok(compact.includes(ANALYST_PROMPT));
  assert.ok(compact.includes('name="function"'));
  assert.ok(compact.length < CORE_PROMPT.length);
});

check('composition is deterministic', () => {
  const first = composePrompt({ mode: 'agent', style: 'analyst', scope: 'binary', question: 'q', context });
  const second = composePrompt({ mode: 'agent', style: 'analyst', scope: 'binary', question: 'q', context });
  assert.equal(first.system, second.system);
});

check('modes and styles are the two documented pairs', () => {
  assert.deepEqual([...MODES], ['chat', 'agent']);
  assert.deepEqual([...STYLES], ['beginner', 'analyst']);
});

console.log(failures ? `\n${failures} failed` : '\nai-prompt-compose: PASS');
if (failures) process.exit(1);
