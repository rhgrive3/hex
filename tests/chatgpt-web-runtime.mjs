import assert from 'node:assert/strict';
import { ChatGPTConversationRouter, ChatGPTDOMAdapter, ChatGPTModelController, ChatGPTTurnController } from '../js/userscript/chatgpt-adapter.js';
import { installChatGPTWebBridge } from '../js/userscript/chatgpt-bridge.js';

await testConversationRouting();
await testNewConversationRouteWaitsForOldTurns();
await testModelSelection();
await testLogicalTurnCanonicalization();
await testStableTurnIdentityUsesDataTurnId();
await testRoleScopedTurnTextExtraction();
await testCollapsibleUserMessageTextExtraction();
await testTurnCompletionAndStaleProtection();
await testRolelessTurnFallback();
await testCancelTimeoutAndSingleInflight();
await testTransientConversationGapIsNotASwitch();
await testNewConversationIdentityMigration();
await testNewConversationNavigationAwayIsRejected();
await testPersistentConversationGapIsRejected();
await testHistoricalErrorTurnDoesNotPoisonARequest();
await testBridgeErrorsCarryTheirStage();
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

async function testNewConversationRouteWaitsForOldTurns() {
  let current = { id: 'old', url: 'https://chatgpt.com/c/old' };
  let turns = [{ id: 'old-user' }, { id: 'old-assistant' }];
  let clicks = 0;
  const adapter = {
    conversation: () => current,
    conversationTurns: () => turns,
    composer: () => ({}),
    newChatButton: () => ({ click() {
      clicks++;
      current = null;
      setTimeout(() => { turns = []; }, 20);
    } }),
    all: () => [],
  };
  const router = new ChatGPTConversationRouter(adapter, { storage: memoryStorage(), navigationTimeoutMs: 250 });
  const routed = await router.route('fresh-session');
  assert.equal(clicks, 1);
  assert.equal(routed.isNew, true);
  assert.equal(routed.conversation, null);
  assert.equal(turns.length, 0, 'new-chat routing must wait for the old conversation DOM to leave');
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

async function testStableTurnIdentityUsesDataTurnId() {
  let testId = 'conversation-turn-2';
  const node = {
    id: '',
    getAttribute(name) {
      if (name === 'data-turn-id') return 'request-WEB:stable-turn';
      if (name === 'data-testid') return testId;
      return null;
    },
  };
  const adapter = new ChatGPTDOMAdapter({ document: null, location: { href: 'https://chatgpt.com/c/alpha' } });
  assert.equal(adapter.identity(node), 'request-WEB:stable-turn');
  testId = 'conversation-turn-5';
  assert.equal(adapter.identity(node), 'request-WEB:stable-turn', 'renderer test-id churn must not change logical turn identity');
}

async function testRoleScopedTurnTextExtraction() {
  const prompt = 'HEX CONTROL PROTOCOL hex-chatgpt-web-v1\n\n<HEX_DATA>{"messages":[{"role":"user","content":"こんばんは"}]}</HEX_DATA>';
  const response = '{"type":"final","answer":"こんばんは！","confidence":1,"evidenceIds":[],"hypothesisIds":[],"suggestedActions":[],"followups":[]}';
  const user = realChatGPTTurnFixture('user', '1', prompt);
  const assistant = realChatGPTTurnFixture('assistant', '2', response);
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="user"]') return [user.roleNode];
      if (selector === '[data-message-author-role="assistant"]') return [assistant.roleNode];
      if (selector.includes('conversation-turn-') && selector.includes('user')) return [user.root];
      if (selector.includes('conversation-turn-') && selector.includes('assistant')) return [assistant.root];
      if (selector === '[data-testid^="conversation-turn-"]') return [user.root, assistant.root];
      return [];
    },
  };
  const adapter = new ChatGPTDOMAdapter({ document, location: { href: 'https://chatgpt.com/c/alpha' } });
  const controller = new ChatGPTTurnController(adapter);

  assert.match(user.root.innerText, /^あなた:/, 'fixture must include ChatGPT accessibility speaker text outside the message node');
  assert.match(assistant.root.innerText, /^ChatGPT:/, 'fixture must include assistant accessibility speaker text outside the message node');
  assert.equal(adapter.userTurns()[0].text, prompt, 'adapter must read only the user message, not the conversation wrapper heading');
  assert.equal(controller.userTurns()[0].text, prompt, 'canonical turn projection must preserve the exact submitted prompt');
  assert.equal(controller.assistantTurns()[0].text, response, 'assistant capture must exclude the accessibility speaker heading too');
}

async function testCollapsibleUserMessageTextExtraction() {
  const prompt = 'HEX CONTROL PROTOCOL hex-chatgpt-web-v1\n\n<HEX_DATA>{"messages":[{"role":"user","content":"解析の始め方を教えて"}]}</HEX_DATA>';
  const content = { innerText: prompt, textContent: prompt };
  let root;
  const roleNode = {
    id: '',
    innerText: `${prompt}\n表示を増やす\n表示を減らす`,
    textContent: `${prompt}\n表示を増やす\n表示を減らす`,
    getAttribute(name) {
      if (name === 'data-message-author-role') return 'user';
      if (name === 'data-message-id') return 'message-collapsible';
      return null;
    },
    closest(selector) {
      if (selector.includes('conversation-turn-')) return root;
      if (selector.includes('data-message-author-role')) return roleNode;
      return null;
    },
    querySelector(selector) {
      if (selector.includes('collapsible-user-message-content')) return content;
      return null;
    },
  };
  root = {
    id: '',
    innerText: `あなた:\n${roleNode.innerText}`,
    textContent: `あなた:\n${roleNode.textContent}`,
    getAttribute(name) {
      if (name === 'data-testid') return 'conversation-turn-collapsible';
      if (name === 'data-turn') return 'user';
      return null;
    },
    closest(selector) { return selector.includes('conversation-turn-') ? root : null; },
    querySelector(selector) {
      if (selector.includes('[data-message-author-role')) return roleNode;
      return null;
    },
  };
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="user"]') return [roleNode];
      if (selector.includes('conversation-turn-') && selector.includes('user')) return [root];
      if (selector === '[data-testid^="conversation-turn-"]') return [root];
      return [];
    },
  };
  const adapter = new ChatGPTDOMAdapter({ document, location: { href: 'https://chatgpt.com/c/alpha' } });
  const controller = new ChatGPTTurnController(adapter);

  assert.match(roleNode.innerText, /表示を増やす/, 'fixture must reproduce ChatGPT collapsible-message UI text inside the user role');
  assert.match(roleNode.innerText, /表示を減らす/, 'fixture must reproduce both localized toggle labels');
  assert.equal(adapter.userTurns()[0].text, prompt, 'adapter must extract only collapsible user message content');
  assert.equal(controller.userTurns()[0].text, prompt, 'exact prompt verification must ignore collapsible toggle labels');
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

function realChatGPTTurnFixture(role, id, text) {
  const speaker = role === 'user' ? 'あなた:' : 'ChatGPT:';
  const content = { innerText: text, textContent: text };
  let root;
  const roleNode = {
    id: '',
    innerText: text,
    textContent: text,
    getAttribute(name) {
      if (name === 'data-message-author-role') return role;
      if (name === 'data-message-id') return `message-${id}`;
      return null;
    },
    closest(selector) {
      if (selector.includes('conversation-turn-')) return root;
      if (selector.includes('data-message-author-role')) return roleNode;
      return null;
    },
    querySelector(selector) {
      if (role === 'assistant' && selector.includes('.markdown')) return content;
      return null;
    },
  };
  root = {
    id: '',
    innerText: `${speaker}\n${text}`,
    textContent: `${speaker}\n${text}`,
    getAttribute(name) {
      if (name === 'data-testid') return `conversation-turn-${id}`;
      if (name === 'data-turn') return role;
      return null;
    },
    closest(selector) { return selector.includes('conversation-turn-') ? root : null; },
    querySelector(selector) {
      if (selector.includes('[data-message-author-role')) return roleNode;
      if (role === 'assistant' && selector.includes('.markdown')) return content;
      return null;
    },
  };
  return { root, roleNode, content };
}

function option(label, click) { return { label, model: /Sol/.test(label) ? 'chatgpt-web/sol' : null, reasoning: /High/.test(label) ? 'high' : null, node: { click } }; }
function conversationLink(id, click) { return { getAttribute: (name) => name === 'href' ? `/c/${id}` : null, click }; }
function memoryStorage() { const values = new Map(); return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; }
async function testTransientConversationGapIsNotASwitch() {
  /*
   * ChatGPT can briefly report no conversation at all while its SPA router is
   * between routes. "Unknown" is not "somewhere else": inventing a conversation
   * switch from a missing reading throws away a healthy, in-flight model turn.
   */
  const conversation = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' };
  const state = { generating: false, assistants: [], users: [], conversation };
  const adapter = turnAdapter(state, () => {
    state.users.push({ id: 'hex-user', text: 'prompt' });
    state.generating = true;
    setTimeout(() => { state.conversation = null; }, 4);
    setTimeout(() => { state.conversation = conversation; }, 12);
    setTimeout(() => { state.assistants.push({ id: 'new', text: '{"type":"final"}' }); state.generating = false; }, 20);
  });
  const result = await new ChatGPTTurnController(adapter, { quietMs: 5, pollMs: 2, startTimeoutMs: 40 })
    .run('prompt', { timeoutMs: 400, expectedConversation: conversation });
  assert.equal(result.turnId, 'new');
  assert.equal(result.conversation.id, 'alpha');

  /* A different, concretely identified conversation is still a hard failure. */
  const switched = { generating: false, assistants: [], users: [], conversation };
  const switchedAdapter = turnAdapter(switched, () => {
    switched.users.push({ id: 'hex-user', text: 'prompt' });
    switched.generating = true;
    setTimeout(() => { switched.conversation = { id: 'beta', url: 'https://chatgpt.com/c/beta' }; }, 4);
  });
  await assert.rejects(
    new ChatGPTTurnController(switchedAdapter, { quietMs: 5, pollMs: 2, startTimeoutMs: 40 }).run('prompt', { timeoutMs: 200, expectedConversation: conversation }),
    (error) => error.code === 'conversation-switched' && error.stage === 'turn-controller',
  );
}

async function testNewConversationIdentityMigration() {
  const alpha = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' };
  const beta = { id: 'beta', url: 'https://chatgpt.com/c/beta' };
  const state = { generating: false, assistants: [], users: [], turns: [], conversation: null };
  const user = { id: 'hex-user-turn', text: 'prompt', node: plainNode('hex-user-turn') };
  const assistant = { id: 'hex-assistant-turn', text: '', node: plainNode('hex-assistant-turn') };
  const adapter = turnAdapter(state, () => {
    state.users.push(user);
    state.assistants.push(assistant);
    state.turns.push(user, assistant);
    state.generating = true;
    setTimeout(() => { state.conversation = alpha; }, 4);
    setTimeout(() => { state.conversation = beta; }, 12);
    setTimeout(() => { assistant.text = '{"type":"final"}'; state.generating = false; }, 24);
  });
  const seen = [];
  const result = await new ChatGPTTurnController(adapter, { quietMs: 5, pollMs: 2, startTimeoutMs: 40, conversationGraceMs: 20 })
    .run('prompt', { timeoutMs: 400, newConversation: true, onConversation: (conversation) => seen.push(conversation.id) });
  assert.equal(result.conversation.id, 'beta', 'the final CID must replace the provisional CID');
  assert.equal(result.turnId, 'hex-assistant-turn');
  assert.ok(seen.includes('alpha'));
  assert.ok(seen.includes('beta'));
}

async function testNewConversationNavigationAwayIsRejected() {
  const alpha = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' };
  const beta = { id: 'beta', url: 'https://chatgpt.com/c/beta' };
  const state = { generating: false, assistants: [], users: [], turns: [], conversation: null };
  const requestUser = { id: 'hex-user-turn', text: 'prompt', node: plainNode('hex-user-turn') };
  const requestAssistant = { id: 'hex-assistant-turn', text: 'partial', node: plainNode('hex-assistant-turn') };
  const adapter = turnAdapter(state, () => {
    state.users.push(requestUser);
    state.assistants.push(requestAssistant);
    state.turns.push(requestUser, requestAssistant);
    state.generating = true;
    setTimeout(() => { state.conversation = alpha; }, 4);
    // The URL can change before ChatGPT replaces the old DOM. This first looks
    // like bootstrap migration; the disappearing request turn proves navigation.
    setTimeout(() => { state.conversation = beta; }, 12);
    setTimeout(() => {
      const otherUser = { id: 'other-user', text: 'other prompt', node: plainNode('other-user') };
      const otherAssistant = { id: 'other-assistant', text: 'other response', node: plainNode('other-assistant') };
      state.users = [otherUser];
      state.assistants = [otherAssistant];
      state.turns = [otherUser, otherAssistant];
      state.generating = false;
    }, 24);
  });
  await assert.rejects(
    new ChatGPTTurnController(adapter, { quietMs: 20, pollMs: 2, startTimeoutMs: 40, conversationGraceMs: 20 })
      .run('prompt', { timeoutMs: 300, newConversation: true }),
    (error) => error.code === 'conversation-switched' && error.stage === 'turn-controller',
  );
}

async function testPersistentConversationGapIsRejected() {
  const alpha = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' };
  const state = { generating: false, assistants: [], users: [], turns: [], conversation: alpha };
  const user = { id: 'hex-user', text: 'prompt', node: plainNode('hex-user') };
  const assistant = { id: 'hex-assistant', text: 'partial', node: plainNode('hex-assistant') };
  const adapter = turnAdapter(state, () => {
    state.users.push(user);
    state.assistants.push(assistant);
    state.turns.push(user, assistant);
    state.generating = true;
    setTimeout(() => { state.conversation = null; }, 4);
    setTimeout(() => { assistant.text = '{"type":"final"}'; state.generating = false; }, 8);
  });
  await assert.rejects(
    new ChatGPTTurnController(adapter, { quietMs: 3, pollMs: 2, startTimeoutMs: 40, conversationGraceMs: 12 })
      .run('prompt', { timeoutMs: 200, expectedConversation: alpha }),
    (error) => error.code === 'conversation-switched',
    'a persistent /c/<id> -> / transition must not finalize against the old conversation',
  );
}

async function testHistoricalErrorTurnDoesNotPoisonARequest() {
  /*
   * A conversation keeps every failed turn in the DOM forever. Only an error
   * marker inside a turn created by THIS request may abort it; a failure from
   * an earlier turn must not.
   */
  const conversation = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' };
  const historical = errorTurn('conversation-turn-old', 'Something went wrong. Try again.');
  const state = { generating: false, assistants: [], users: [], turns: [historical], conversation, scopes: [] };
  const adapter = turnAdapter(state, () => {
    state.users.push({ id: 'hex-user', text: 'prompt' });
    state.turns.push({ id: 'hex-user', text: 'prompt', node: plainNode('hex-user') });
    state.generating = true;
    setTimeout(() => {
      state.assistants.push({ id: 'new', text: '{"type":"final"}' });
      state.turns.push({ id: 'new', text: '{"type":"final"}', node: plainNode('new') });
      state.generating = false;
    }, 8);
  });
  const result = await new ChatGPTTurnController(adapter, { quietMs: 5, pollMs: 2, startTimeoutMs: 40 })
    .run('prompt', { timeoutMs: 400, expectedConversation: conversation });
  assert.equal(result.turnId, 'new');
  assert.ok(state.scopes.length, 'the controller must ask for a turn-scoped error reading');
  assert.ok(state.scopes.every((scope) => Array.isArray(scope)), 'error detection must be scoped to explicit turn nodes');
  assert.ok(state.scopes.every((scope) => !scope.includes(historical.node)), 'a historical error turn must never be in the active error scope');

  /* An error marker inside the live response is still fatal. */
  const live = { generating: false, assistants: [], users: [], turns: [], conversation, scopes: [], liveError: false };
  const liveAdapter = turnAdapter(live, () => {
    live.users.push({ id: 'hex-user', text: 'prompt' });
    live.turns.push({ id: 'hex-user', text: 'prompt', node: plainNode('hex-user') });
    live.generating = true;
    setTimeout(() => { live.liveError = true; }, 4);
  });
  await assert.rejects(
    new ChatGPTTurnController(liveAdapter, { quietMs: 5, pollMs: 2, startTimeoutMs: 40 }).run('prompt', { timeoutMs: 200, expectedConversation: conversation }),
    (error) => error.code === 'response-error' && error.stage === 'turn-controller',
  );
}

async function testBridgeErrorsCarryTheirStage() {
  const adapter = { composer: () => null };
  await assert.rejects(
    new ChatGPTTurnController(adapter, { startTimeoutMs: 5, pollMs: 2 }).run('prompt', { timeoutMs: 40 }),
    (error) => error.code === 'composer-not-found' && error.stage === 'turn-controller',
  );
  const router = new ChatGPTConversationRouter({ conversation: () => null, newChatButton: () => null, all: () => [] }, { storage: memoryStorage() });
  await assert.rejects(router.route(''), (error) => error.code === 'session-required' && error.stage === 'conversation-router');
  await assert.rejects(router.route('key'), (error) => error.code === 'new-chat-unavailable' && error.stage === 'conversation-router');
}

function plainNode(id) { return { id, querySelectorAll: () => [], matches: () => false }; }
function errorTurn(id, text) {
  const node = { id, matches: (selector) => selector.includes('conversation-turn-error'), querySelectorAll: () => [] };
  return { id, text, node };
}

function turnAdapter(state, onSend) {
  const composer = { value: '' };
  return {
    composer: () => composer, setComposerText: (_node, text) => { composer.value = text; }, composerText: () => composer.value,
    sendButton: () => ({ disabled: false, getAttribute: () => null, click: () => { composer.value = ''; onSend(); } }),
    assistantTurns: () => state.assistants, userTurns: () => state.users, conversationTurns: () => state.turns || [], isGenerating: () => state.generating,
    errorState: (scopeNodes) => {
      if (state.scopes) state.scopes.push(scopeNodes);
      if (state.liveError) return 'Something went wrong. Try again.';
      return null;
    },
    conversation: () => state.conversation,
  };
}