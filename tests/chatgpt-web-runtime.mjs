import assert from 'node:assert/strict';
import { ChatGPTConversationRouter, ChatGPTDOMAdapter, ChatGPTModelController, ChatGPTTurnController } from '../js/userscript/chatgpt-adapter.js';
import { installChatGPTWebBridge } from '../js/userscript/chatgpt-bridge.js';

await testConversationRouting();
await testModelSelection();
await testLogicalTurnCanonicalization();
await testTurnCompletionAndStaleProtection();
await testRolelessTurnFallback();
await testCancelTimeoutAndSingleInflight();
console.log('chatgpt-web-runtime: ok');

async function testConversationRouting() {
  let current = null, fresh = 0;
  const links = new Map();
  const adapter = {
    conversation: () => current,
    composer: () => ({}),
    newChatButton: () => ({ click() { current = null; fresh++; } }),
    location: { assign(url) { const id = /\/c\/([^/?]+)/.exec(url)?.[1]; current = id ? { id, url: `https://chatgpt.com/c/${id}` } : null; } },
    all: () => [...links.values()],
  };
  const storage = memoryStorage();
  const router = new ChatGPTConversationRouter(adapter, { storage, navigationTimeoutMs: 30 });
  await router.route('A'); assert.equal(fresh, 1);
  current = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' }; router.bind('A', current);
  links.set('alpha', conversationLink('alpha', () => { current = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' }; }));
  await router.route('B'); assert.equal(fresh, 2);
  current = { id: 'beta', url: 'https://chatgpt.com/c/beta' }; router.bind('B', current);
  links.set('beta', conversationLink('beta', () => { current = { id: 'beta', url: 'https://chatgpt.com/c/beta' }; }));
  await router.route('A'); assert.equal(current.id, 'alpha');
  await router.route('B'); assert.equal(current.id, 'beta');
  assert.equal(JSON.parse(storage.getItem('hex.chatgpt.conversations.v1')).A.url, 'https://chatgpt.com/c/alpha');
}

async function testModelSelection() {
  let selection = { model: 'chatgpt-web/terra', reasoning: 'standard', observedText: 'GPT-5.6 Terra Standard' };
  const options = [
    option('GPT-5.6 Sol', () => { selection = { ...selection, model: 'chatgpt-web/sol', observedText: 'GPT-5.6 Sol Standard' }; }),
    option('High', () => { selection = { ...selection, reasoning: 'high', observedText: 'GPT-5.6 Sol High' }; }),
  ];
  const adapter = { currentSelection: () => selection, visibleOptions: async () => options, modelPicker: () => null, reasoningControl: () => null };
  const controller = new ChatGPTModelController(adapter, { settleMs: 0 });
  const capabilities = await controller.capabilities();
  assert.ok(capabilities.models.some((item) => item.id === 'chatgpt-web/sol'));
  assert.ok(capabilities.reasoning.some((item) => item.id === 'high'));
  const chosen = await controller.select({ model: 'chatgpt-web/sol', reasoning: 'high' });
  assert.equal(chosen.model, 'chatgpt-web/sol'); assert.equal(chosen.reasoning, 'high');
  await assert.rejects(controller.select({ model: 'chatgpt-web/luna' }), (error) => error.code === 'model-unavailable');
  selection = { model: 'chatgpt-web/terra', reasoning: 'high', observedText: 'GPT-5.6 Terra High' };
  options[0].node.click = () => {};
  await assert.rejects(controller.select({ model: 'chatgpt-web/sol' }), (error) => error.code === 'model-mismatch');
}

async function testLogicalTurnCanonicalization() {
  const fixture = logicalTurnFixture('assistant', '42', '{"type":"final","answer":"ok"}');
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [fixture.roleNode];
      if (selector.includes('conversation-turn-') && selector.includes('assistant')) return [fixture.root];
      return [];
    },
  };
  const adapter = new ChatGPTDOMAdapter({ document, location: { href: 'https://chatgpt.com/c/alpha' } });
  const turns = adapter.assistantTurns();
  assert.equal(turns.length, 1, 'role node + conversation wrapper must be one logical assistant turn');
  assert.equal(turns[0].id, 'conversation-turn-42');
  assert.equal(turns[0].text, '{"type":"final","answer":"ok"}');
  assert.equal(turns[0].node, fixture.root);
}

async function testTurnCompletionAndStaleProtection() {
  const state = { generating: false, assistants: [{ id: 'old', text: 'old response' }], users: [], sent: false, conversation: { id: 'alpha', url: 'https://chatgpt.com/c/alpha' } };
  const adapter = turnAdapter(state, () => {
    state.users.push({ id: 'hex-user', text: 'prompt' }); state.generating = true;
    setTimeout(() => { state.assistants.push({ id: 'new', text: '{"type":"final"}' }); state.generating = false; }, 8);
  });
  const controller = new ChatGPTTurnController(adapter, { quietMs: 5, pollMs: 2, startTimeoutMs: 30 });
  const result = await controller.run('prompt', { timeoutMs: 100, expectedConversation: state.conversation });
  assert.equal(result.turnId, 'new'); assert.notEqual(result.text, 'old response');

  const stale = { ...state, assistants: [{ id: 'old', text: 'old response' }], users: [], generating: false };
  const staleAdapter = turnAdapter(stale, () => { stale.users.push({ id: 'u', text: 'prompt' }); stale.assistants.push({ id: 'first', text: 'one' }); setTimeout(() => stale.assistants.push({ id: 'second', text: 'two' }), 2); });
  await assert.rejects(new ChatGPTTurnController(staleAdapter, { quietMs: 20, pollMs: 2 }).run('prompt', { timeoutMs: 50, expectedConversation: stale.conversation }), (error) => error.code === 'manual-interference');
}

async function testRolelessTurnFallback() {
  const state = {
    generating: false,
    assistants: [],
    users: [],
    turns: [{ id: 'old-general', text: 'old response' }],
    conversation: null,
  };
  const adapter = turnAdapter(state, () => {
    state.turns.push({ id: 'hex-user-general', text: 'prompt' });
    state.generating = true;
    setTimeout(() => {
      state.turns.push({ id: 'assistant-general', text: '{"type":"final","answer":"ok","confidence":1,"evidenceIds":[]}' });
      state.generating = false;
    }, 8);
  });
  const controller = new ChatGPTTurnController(adapter, {
    quietMs: 5,
    pollMs: 2,
    startTimeoutMs: 30,
    conversationGraceMs: 8,
  });
  const result = await controller.run('prompt', { timeoutMs: 100 });
  assert.equal(result.turnId, 'assistant-general');
  assert.match(result.text, /"answer":"ok"/);
  assert.equal(result.conversation, null, 'a captured model response must not be discarded solely because the SPA URL has not settled');
}

async function testCancelTimeoutAndSingleInflight() {
  const state = { generating: false, assistants: [], users: [], conversation: { id: 'alpha', url: 'https://chatgpt.com/c/alpha' } };
  const adapter = turnAdapter(state, () => { state.users.push({ id: 'u', text: 'prompt' }); state.generating = true; });
  await assert.rejects(new ChatGPTTurnController(adapter, { pollMs: 2, quietMs: 3 }).run('prompt', { timeoutMs: 15, expectedConversation: state.conversation }), (error) => error.code === 'timeout');
  state.generating = false; state.users = [];
  const controller = new AbortController();
  const pending = new ChatGPTTurnController(adapter, { pollMs: 2 }).run('prompt', { timeoutMs: 100, signal: controller.signal, expectedConversation: state.conversation });
  controller.abort('cancel'); await assert.rejects(pending, (error) => error.name === 'AbortError');

  delete globalThis.__HEX_CHATGPT_BRIDGE__;
  let release;
  const bridge = installChatGPTWebBridge({
    adapter: { composer: () => ({}), currentSelection: () => ({}), isGenerating: () => false, conversation: () => null, errorState: () => null, stop() {} },
    router: { route: async () => ({ conversation: null, isNew: true }), bind: () => ({ id: 'x', url: 'https://chatgpt.com/c/x' }), binding: () => null },
    models: { select: async () => ({}), capabilities: async () => ({ models: [], reasoning: [] }) },
    turns: { run: () => new Promise((resolve) => { release = resolve; }) },
  });
  const first = bridge.request('one', { sessionKey: 'A' });
  await assert.rejects(bridge.request('two', { sessionKey: 'B' }), /already handling another Hex turn/);
  release({ text: 'ok', conversation: { id: 'x', url: 'https://chatgpt.com/c/x' }, turnId: 't' }); await first;
  delete globalThis.__HEX_CHATGPT_BRIDGE__;
}

function logicalTurnFixture(role, id, text) {
  const content = { innerText: text, textContent: text };
  const root = {
    id: '',
    getAttribute(name) { return name === 'data-testid' ? `conversation-turn-${id}` : null; },
    closest(selector) { return selector.includes('conversation-turn-') ? root : null; },
    querySelector() { return content; },
  };
  const roleNode = {
    id: '',
    getAttribute(name) { return name === 'data-message-author-role' ? role : null; },
    closest(selector) {
      if (selector.includes('conversation-turn-')) return root;
      if (selector.includes('data-message-author-role')) return roleNode;
      return null;
    },
  };
  return { root, roleNode, content };
}

function option(label, click) { return { label, model: /Sol/.test(label) ? 'chatgpt-web/sol' : null, reasoning: /High/.test(label) ? 'high' : null, node: { click } }; }
function conversationLink(id, click) { return { getAttribute: (name) => name === 'href' ? `/c/${id}` : null, click }; }
function memoryStorage() { const values = new Map(); return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; }
function turnAdapter(state, onSend) {
  const composer = { value: '' };
  return {
    composer: () => composer, setComposerText: (_node, text) => { composer.value = text; }, composerText: () => composer.value,
    sendButton: () => ({ disabled: false, getAttribute: () => null, click: () => { composer.value = ''; onSend(); } }),
    assistantTurns: () => state.assistants, userTurns: () => state.users, conversationTurns: () => state.turns || [], isGenerating: () => state.generating,
    errorState: () => null, conversation: () => state.conversation,
  };
}