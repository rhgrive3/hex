/*
 * Multiple chats in one session: New chat, switching, rename, delete, the
 * conversation id and model metadata that reach the engine, bounded history
 * storage, and the provider/model vocabulary the picker is allowed to show.
 *
 * No DOM: the session and the picker are pure modules, so a full turn runs
 * here with an injected engine and a fake storage.
 */
import assert from 'node:assert/strict';
import { AiSession } from '../js/ai/ui/session.js';
import { createConversationStore, deriveTitle, conversationTitle } from '../js/ai/ui/conversations.js';
import {
  applyStatus, capabilityApi, normalizeCapabilities, selectionForProvider, selectionLabel,
} from '../js/ai/ui/model-picker.js';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + ' — ' + (error && error.message)); }
}

const echoEngine = () => ({
  calls: [],
  async run(input) {
    this.calls.push(input);
    return { answer: 'answer for ' + input.question };
  },
});

/**
 * An engine whose answers settle at once until `hold` is set, so a test can
 * build a transcript first and then leave exactly one turn running.
 */
const pendingEngine = () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    calls: [], hold: false,
    release: () => release({ answer: 'late answer' }),
    async run(input) {
      this.calls.push(input);
      return this.hold ? gate : { answer: 'answer for ' + input.question };
    },
  };
};

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => map,
  };
}

/* ── the old single-chat API still holds ─────────────────────── */

await check('the flat session API keeps working on top of conversations', async () => {
  const engine = echoEngine();
  const session = new AiSession({ engine, mode: 'agent', style: 'analyst', scope: 'auto', storage: null });
  assert.equal(session.mode, 'agent');
  session.setMode('chat');
  session.setStyle('beginner');
  session.setScope('binary');
  assert.deepEqual([session.mode, session.style, session.scope], ['chat', 'beginner', 'binary']);
  const turn = await session.ask('q', { context: {} });
  assert.equal(turn.status, 'done');
  assert.equal(session.turns.length, 2);
  assert.equal(session.visibleTurns().length, 2);
  assert.equal(session.busy, false);
  assert.equal(session.historyFor().length, 2);
  session.clear();
  assert.equal(session.turns.length, 0);
});

/* ── new chat ────────────────────────────────────────────────── */

await check('New chat keeps the old transcript and starts an empty one', async () => {
  const session = new AiSession({ engine: echoEngine(), storage: null });
  await session.ask('最初の質問', { context: {} });
  const first = session.current;
  const second = session.newConversation();
  assert.notEqual(second.id, first.id);
  assert.equal(session.turns.length, 0);
  assert.equal(first.turns.length, 2);
  assert.equal(session.list().length, 2);
});

await check('New chat inherits how the user works, not what was asked', async () => {
  const session = new AiSession({ engine: echoEngine(), storage: null });
  session.setMode('agent');
  session.setStyle('analyst');
  session.setScope('binary');
  session.setSelection({ provider: 'chatgpt-web', model: 'gpt-5.6-sol', reasoning: 'high' });
  await session.ask('q', { context: {} });
  session.newConversation();
  assert.deepEqual([session.mode, session.style, session.scope], ['agent', 'analyst', 'binary']);
  assert.deepEqual(session.selectionOf(), { provider: 'chatgpt-web', model: 'gpt-5.6-sol', reasoning: 'high' });
  assert.equal(session.turns.length, 0);
});

await check('an untouched blank chat is not duplicated', async () => {
  const session = new AiSession({ engine: echoEngine(), storage: null });
  const before = session.current.id;
  session.newConversation();
  assert.equal(session.current.id, before);
  assert.equal(session.list().length, 1);
});

/* ── switching ───────────────────────────────────────────────── */

await check('A to B to A keeps both transcripts apart', async () => {
  const session = new AiSession({ engine: echoEngine(), storage: null });
  await session.ask('質問A', { context: {} });
  const a = session.current.id;
  session.newConversation();
  await session.ask('質問B', { context: {} });
  const b = session.current.id;
  assert.notEqual(a, b);
  assert.equal(session.turns[0].text, '質問B');
  assert.ok(session.switchTo(a));
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns[0].text, '質問A');
  assert.ok(session.switchTo(b));
  assert.equal(session.turns[0].text, '質問B');
  assert.equal(session.get(a).turns.length, 2);
});

await check('conversation ids are unique and stable', async () => {
  const session = new AiSession({ engine: echoEngine(), storage: null });
  const ids = new Set();
  for (let i = 0; i < 5; i++) {
    await session.ask('q' + i, { context: {} });
    ids.add(session.current.id);
    session.newConversation();
  }
  assert.equal(ids.size, 5);
});

/* ── titles, rename, delete ──────────────────────────────────── */

await check('the first question titles the chat, without an LLM call', async () => {
  assert.equal(deriveTitle('コインが増える処理はどこ？'), 'コインが増える処理はどこ');
  assert.equal(deriveTitle('  何を  すればいい？ 次は？ '), '何を すればいい');
  assert.equal(deriveTitle(''), '');
  assert.equal(deriveTitle('x'.repeat(80)).length, 28);
  const session = new AiSession({ engine: echoEngine(), storage: null });
  assert.equal(conversationTitle(session.current, true), '新しいチャット');
  await session.ask('コインが増える処理はどこ？', { context: {} });
  assert.equal(session.current.title, 'コインが増える処理はどこ');
  await session.ask('二つ目の質問', { context: {} });
  assert.equal(session.current.title, 'コインが増える処理はどこ');
});

await check('rename replaces the derived title', async () => {
  const session = new AiSession({ engine: echoEngine(), storage: null });
  await session.ask('q', { context: {} });
  assert.ok(session.renameConversation(session.current.id, '  コイン  調査 '));
  assert.equal(session.current.title, 'コイン 調査');
  assert.equal(session.renameConversation('missing', 'x'), false);
});

await check('delete removes one chat and never leaves the session empty', async () => {
  const session = new AiSession({ engine: echoEngine(), storage: null });
  await session.ask('質問A', { context: {} });
  const a = session.current.id;
  session.newConversation();
  await session.ask('質問B', { context: {} });
  const b = session.current.id;
  assert.ok(session.deleteConversation(b));
  assert.equal(session.get(b), null);
  assert.equal(session.current.id, a);
  assert.ok(session.deleteConversation(a));
  assert.equal(session.list().length, 1);
  assert.equal(session.turns.length, 0);
});

/* ── busy ────────────────────────────────────────────────────── */

await check('a running turn blocks New chat, switching and delete', async () => {
  const engine = pendingEngine();
  const session = new AiSession({ engine, storage: null });
  await session.ask('質問A', { context: {} });
  const a = session.current.id;
  session.newConversation();
  const b = session.current.id;
  engine.hold = true;
  const running = session.ask('遅い質問', { context: {} });
  await Promise.resolve();
  assert.equal(session.busy, true);
  assert.equal(session.newConversation(), null);
  assert.equal(session.switchTo(a), false);
  assert.equal(session.deleteConversation(b), false);
  engine.release();
  await running;
  assert.equal(session.busy, false);
  assert.ok(session.switchTo(a));
  assert.ok(session.newConversation());
});

await check('an answer lands in the chat it was asked in', async () => {
  const engine = pendingEngine();
  const session = new AiSession({ engine, storage: null });
  engine.hold = true;
  const running = session.ask('遅い質問', { context: {} });
  const asked = session.current;
  await Promise.resolve();
  engine.release();
  const turn = await running;
  assert.equal(asked.turns[1], turn);
  assert.equal(turn.status, 'done');
});

/* ── what the engine receives ────────────────────────────────── */

await check('engine.run receives the conversation id and the model selection', async () => {
  const engine = echoEngine();
  const session = new AiSession({ engine, storage: null });
  session.setSelection({ provider: 'gemini', model: 'gemini-3.7-flash', reasoning: 'low' });
  await session.ask('q1', { context: {} });
  const first = engine.calls[0];
  assert.equal(first.conversationId, session.current.id);
  assert.equal(first.provider, 'gemini');
  assert.equal(first.model, 'gemini-3.7-flash');
  assert.equal(first.reasoning, 'low');
  session.newConversation();
  session.setSelection({ provider: 'chatgpt-web', model: 'gpt-5.6-sol', reasoning: null });
  await session.ask('q2', { context: {} });
  const second = engine.calls[1];
  assert.notEqual(second.conversationId, first.conversationId);
  assert.equal(second.provider, 'chatgpt-web');
  assert.equal(second.reasoning, null);
});

/* ── persistence ─────────────────────────────────────────────── */

await check('history is restored per binary and never mixes two binaries', async () => {
  const storage = memoryStorage();
  let binary = 'binary-a';
  const store = createConversationStore({ namespace: () => binary, storage });
  const first = new AiSession({ engine: echoEngine(), storage: store });
  await first.ask('Aのバイナリの質問', { context: {} });
  first.flushSave();

  binary = 'binary-b';
  const second = new AiSession({ engine: echoEngine(), storage: createConversationStore({ namespace: () => binary, storage }) });
  assert.equal(second.list().length, 1, 'binary B starts clean');
  await second.ask('Bのバイナリの質問', { context: {} });
  second.flushSave();

  binary = 'binary-a';
  const back = new AiSession({ engine: echoEngine(), storage: createConversationStore({ namespace: () => binary, storage }) });
  const titles = back.list().map((item) => item.title);
  assert.ok(titles.includes('Aのバイナリの質問'), titles.join('/'));
  assert.ok(!titles.includes('Bのバイナリの質問'), titles.join('/'));
});

await check('a restored transcript carries text, not evidence or binary data', async () => {
  const storage = memoryStorage();
  const store = createConversationStore({ namespace: () => 'bin', storage });
  const engine = {
    async run() {
      return {
        answer: '結論から言うと XP です',
        evidence: [{ id: 'ev', kind: 'field-write', title: 'x'.repeat(500), bytes: 'A'.repeat(5000) }],
      };
    },
  };
  const session = new AiSession({ engine, storage: store });
  await session.ask('XP はどこ？', { context: {} });
  session.flushSave();
  const raw = storage.getItem(store.key);
  assert.ok(!raw.includes('AAAAAAAAAA'), 'binary payload must not be persisted');
  assert.ok(raw.length < 4000, 'stored history stays small: ' + raw.length);
  const restored = new AiSession({ engine, storage: createConversationStore({ namespace: () => 'bin', storage }) });
  const previous = restored.list().find((item) => item.title === 'XP はどこ');
  assert.ok(previous, 'the old chat is listed');
  assert.equal(previous.turns.length, 2);
  assert.equal(previous.turns[1].response.answerText, '結論から言うと XP です');
  assert.deepEqual(previous.turns[1].activity, []);
});

await check('a binary switch swaps the visible history in place', async () => {
  const storage = memoryStorage();
  let binary = 'bin-1';
  const store = createConversationStore({ namespace: () => binary, storage });
  const session = new AiSession({ engine: echoEngine(), storage: store });
  await session.ask('bin-1 の質問', { context: {} });
  session.flushSave();
  binary = 'bin-2';
  assert.equal(session.syncNamespace(), true);
  assert.equal(session.list().length, 1);
  assert.equal(session.turns.length, 0);
  binary = 'bin-1';
  assert.equal(session.syncNamespace(), true);
  assert.ok(session.list().some((item) => item.title === 'bin-1 の質問'));
});

/* ── provider / model vocabulary ─────────────────────────────── */

await check('capabilities normalize from whatever shape the engine advertises', () => {
  const fromArray = normalizeCapabilities({
    providers: [{
      id: 'chatgpt-web', label: 'ChatGPT Web', defaultModel: 'gpt-5.6-sol',
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', reasoning: ['low', 'high'] }],
    }],
  });
  assert.equal(fromArray.known, true);
  assert.equal(fromArray.providers[0].models[0].label, 'GPT-5.6 Sol');
  assert.equal(fromArray.providers[0].models[0].reasoning[1].id, 'high');

  const fromMap = normalizeCapabilities({ providers: { gemini: { label: 'Gemini', models: { 'gemini-3.7-flash': 'Gemini 3.7 Flash' } } } });
  assert.equal(fromMap.providers[0].id, 'gemini');
  assert.equal(fromMap.providers[0].models[0].label, 'Gemini 3.7 Flash');
});

await check('with no capability API the picker still offers the hosts Hex can use', () => {
  const caps = normalizeCapabilities(null);
  assert.equal(caps.known, false);
  assert.deepEqual(caps.providers.map((item) => item.id), ['chatgpt-web', 'gemini']);
  assert.equal(caps.providers[0].available, false);
  const label = selectionLabel(caps, {}, true);
  assert.equal(label.unavailable, true);
  assert.equal(label.note, '利用不可');
});

await check('the chip names the model, and never renames an unavailable one', () => {
  const caps = normalizeCapabilities({
    providers: [{
      id: 'chatgpt-web', label: 'ChatGPT Web',
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', reasoning: [{ id: 'high', label: 'High' }] }],
    }],
  });
  assert.equal(selectionLabel(caps, { provider: 'chatgpt-web', model: 'gpt-5.6-sol', reasoning: 'high' }, false).text, 'GPT-5.6 Sol · High');
  assert.equal(selectionLabel(caps, { provider: 'chatgpt-web' }, false).text, 'ChatGPT Web');
  const gone = selectionLabel(caps, { provider: 'chatgpt-web', model: 'gpt-4o' }, false);
  assert.equal(gone.text, 'gpt-4o');
  assert.equal(gone.unavailable, true);
  const status = applyStatus(caps, { providers: [{ id: 'chatgpt-web', available: false }] });
  assert.equal(selectionLabel(status, { provider: 'chatgpt-web', model: 'gpt-5.6-sol' }, false).unavailable, true);
});

await check('picking a provider takes its default model and drops a foreign one', () => {
  const caps = normalizeCapabilities({
    providers: [
      { id: 'chatgpt-web', label: 'ChatGPT Web', defaultModel: 'gpt-5.6-sol', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }] },
      { id: 'gemini', label: 'Gemini', models: [{ id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' }] },
    ],
  });
  assert.deepEqual(selectionForProvider(caps, 'chatgpt-web', { provider: 'gemini', model: 'gemini-3.7-flash' }),
    { provider: 'chatgpt-web', model: 'gpt-5.6-sol', reasoning: null });
  assert.deepEqual(selectionForProvider(caps, 'gemini', { provider: 'gemini', model: 'gemini-3.7-flash', reasoning: 'x' }),
    { provider: 'gemini', model: 'gemini-3.7-flash', reasoning: null });
});

await check('the capability API is feature detected, on the engine or globally', () => {
  const absent = capabilityApi({});
  assert.deepEqual([absent.capabilities, absent.status, absent.get, absent.set], [null, null, null, null]);
  const onEngine = capabilityApi({ aiCapabilities: () => ({ providers: [] }), setAISelection: () => true });
  assert.equal(typeof onEngine.capabilities, 'function');
  assert.equal(typeof onEngine.set, 'function');
  assert.equal(onEngine.status, null);
  globalThis.aiStatus = () => ({ available: true });
  try {
    assert.equal(typeof capabilityApi(null).status, 'function');
  } finally { delete globalThis.aiStatus; }
});

console.log(failures ? `\n${failures} failing` : '\nall conversation UI checks passed');
process.exit(failures ? 1 : 0);
