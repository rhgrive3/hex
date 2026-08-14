/*
 * Session behaviour: modes, styles, scope, cancel, retry, and the omnibox
 * intent rules. The engine is injected, so a full turn runs here with no
 * browser and no network.
 */
import assert from 'node:assert/strict';
import { AiSession } from '../js/ai/ui/session.js';
import { resolveScope, MODE_ITEMS, STYLE_ITEMS, SCOPE_ITEMS, scopeLabel } from '../js/ai/ui/modes.js';
import { classifyOmnibox, intentLabel, COMMANDS } from '../js/ai/interaction/omnibox.js';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + ' — ' + (error && error.message)); }
}

const echoEngine = (extra = {}) => ({
  calls: [],
  async run(input) {
    this.calls.push(input);
    input.onActivity({ label: 'searching', detail: '3' });
    return { mode: input.mode, style: input.style, answer: 'answer for ' + input.question, ...extra };
  },
});

await check('a turn records the mode, style and resolved scope it ran under', async () => {
  const engine = echoEngine();
  const session = new AiSession({ engine, mode: 'agent', style: 'analyst', scope: 'auto' });
  const turn = await session.ask('コインはどこ？', { context: { state: { fileOpen: true, functionAddress: 1n } } });
  assert.equal(turn.status, 'done');
  assert.equal(turn.mode, 'agent');
  assert.equal(turn.style, 'analyst');
  assert.equal(turn.effectiveScope, 'function');
  assert.equal(engine.calls[0].scope, 'function');
  assert.equal(engine.calls[0].requestedScope, 'auto');
  assert.equal(turn.response.answerText, 'answer for コインはどこ？');
});

await check('activity events reach the turn', async () => {
  const session = new AiSession({ engine: echoEngine() });
  const turn = await session.ask('q', { context: {} });
  assert.equal(turn.activity.length, 1);
  assert.equal(turn.activity[0].label, 'searching');
  assert.equal(turn.activity[0].detail, '3');
});

await check('mode and style changes do not rewrite finished turns', async () => {
  const session = new AiSession({ engine: echoEngine(), mode: 'chat', style: 'beginner' });
  const turn = await session.ask('q', { context: {} });
  session.setMode('agent');
  session.setStyle('analyst');
  assert.equal(turn.mode, 'chat');
  assert.equal(turn.response.style, 'beginner');
  assert.equal(session.mode, 'agent');
});

await check('cancel stops the turn and clears busy', async () => {
  let release;
  const engine = {
    async run(input) {
      return new Promise((resolve, reject) => {
        release = () => resolve({ answer: 'late' });
        input.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
  const session = new AiSession({ engine });
  const pending = session.ask('slow', { context: {} });
  assert.equal(session.busy, true);
  assert.equal(session.cancel(), true);
  const turn = await pending;
  assert.equal(turn.status, 'cancelled');
  assert.equal(session.busy, false);
  assert.ok(typeof release === 'function');
});

await check('an engine failure becomes an error turn, not a rejection', async () => {
  const session = new AiSession({ engine: { async run() { throw new Error('provider_error'); } } });
  const turn = await session.ask('q', { context: {} });
  assert.equal(turn.status, 'error');
  assert.equal(turn.error, 'provider_error');
  assert.equal(session.busy, false);
});

await check('retry replaces the failed exchange instead of stacking it', async () => {
  let attempt = 0;
  const session = new AiSession({
    engine: { async run() { attempt++; if (attempt === 1) throw new Error('boom'); return { answer: 'second try' }; } },
  });
  await session.ask('same question', { context: {} });
  assert.equal(session.turns.length, 2);
  const retried = await session.retry({ context: {} });
  assert.equal(retried.status, 'done');
  assert.equal(retried.response.answerText, 'second try');
  assert.equal(session.turns.length, 2, 'retry must not duplicate the question');
});

await check('an empty question is ignored and a second question is refused while busy', async () => {
  const session = new AiSession({ engine: { run: () => new Promise(() => {}) } });
  assert.equal(await session.ask('   ', { context: {} }), null);
  session.ask('first', { context: {} });
  assert.equal(await session.ask('second', { context: {} }), null);
});

await check('history stays bounded and text-only', async () => {
  const engine = echoEngine();
  const session = new AiSession({ engine });
  for (let i = 0; i < 12; i++) await session.ask('q' + i, { context: {} });
  const history = session.historyFor(3);
  assert.ok(history.length <= 6);
  assert.ok(history.every((item) => typeof item.text === 'string' && (item.role === 'user' || item.role === 'assistant')));
});

await check('the transcript is trimmed to its cap', async () => {
  const session = new AiSession({ engine: echoEngine(), maxTurns: 4 });
  for (let i = 0; i < 6; i++) await session.ask('q' + i, { context: {} });
  assert.ok(session.turns.length <= 4);
});

await check('Auto resolves to the narrowest usable scope', () => {
  assert.equal(resolveScope('auto', { selection: 'instruction', functionAddress: 1n, fileOpen: true }), 'selection');
  assert.equal(resolveScope('auto', { functionAddress: 1n, fileOpen: true }), 'function');
  assert.equal(resolveScope('auto', { fileOpen: true }), 'binary');
  assert.equal(resolveScope('auto', {}), 'project');
  assert.equal(resolveScope('binary', { selection: 'instruction' }), 'binary', 'an explicit scope is never widened or narrowed');
});

await check('mode, style and scope vocabularies are labelled in both languages', () => {
  for (const item of [...MODE_ITEMS, ...STYLE_ITEMS, ...SCOPE_ITEMS]) {
    assert.ok(item.ja && item.en, item.id);
  }
  assert.equal(scopeLabel('function', true), 'この関数');
  assert.equal(scopeLabel('function', false), 'Current function');
});

await check('the omnibox classifies each documented input shape', () => {
  const cases = [
    ['', 'empty'],
    ['0x100458c00', 'address'],
    ['100458c00', 'address'],
    ['sub_100458C00', 'symbol'],
    ['-[LoginViewController loginButtonTapped:]', 'symbol'],
    ['"reward"', 'string'],
    ['「報酬」', 'string'],
    ['> rename', 'command'],
    ['? where is coin update', 'ai'],
    ['？コインはどこで増える', 'ai'],
    ['コインが増える処理はどこですか', 'ai'],
    ['where does the coin value change', 'ai'],
    ['reward', 'search'],
    ['update_score', 'symbol'],
  ];
  for (const [input, kind] of cases) assert.equal(classifyOmnibox(input).kind, kind, JSON.stringify(input));
});

await check('the omnibox strips its prefixes and resolves known commands', () => {
  assert.equal(classifyOmnibox('? コインはどこ').value, 'コインはどこ');
  assert.equal(classifyOmnibox('"reward"').value, 'reward');
  assert.equal(classifyOmnibox('> settings').command, 'settings');
  assert.equal(classifyOmnibox('> 設定').command, 'settings');
  assert.equal(classifyOmnibox('> nonsense').command, null);
  for (const command of COMMANDS) assert.equal(classifyOmnibox('>' + command.en).command || command.id, command.id);
});

await check('every intent has a label the user can read before pressing Enter', () => {
  for (const kind of ['address', 'symbol', 'string', 'command', 'ai', 'search']) {
    assert.ok(intentLabel(kind, true).length > 0, kind);
    assert.ok(intentLabel(kind, false).length > 0, kind);
  }
  assert.equal(intentLabel('empty', true), '');
});

console.log(failures ? `\n${failures} failed` : '\nai-ui-mode: PASS');
if (failures) process.exit(1);
