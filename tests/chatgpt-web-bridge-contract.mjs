import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyStatus, normalizeCapabilities, selectionLabel } from '../js/ai/ui/model-picker.js';
import { installChatGPTWebBridge } from '../js/userscript/chatgpt-bridge.js';
import { CHATGPT_SELECTORS } from '../js/userscript/chatgpt-selectors.js';

const BRIDGE_KEY = '__HEX_CHATGPT_BRIDGE__';

await testRequestContract();
await testSingleInflightAndBusyCleanup();
await testExternalAbortSignal();
await testCancelStopsAdapter();
await testExceptionCleanup();
await testCapabilities();
await testErrorSelectorContract();
await testProviderAvailabilityStatusSemantics();
await testSelectionContract();
await testStatusAndConversationLookup();
await testBridgeDoesNotReachCookiesOrPrivateBackend();

console.log('chatgpt-web-bridge-contract: ok');

async function testRequestContract() {
  const calls = { routes: [], selections: [], runs: [], binds: [] };
  const routedConversation = { id: 'conversation-route', url: 'https://chatgpt.com/c/conversation-route' };
  const interimConversation = { id: 'conversation-interim', url: 'https://chatgpt.com/c/conversation-interim' };
  const finalConversation = { id: 'conversation-final', url: 'https://chatgpt.com/c/conversation-final' };
  const selected = { model: 'chatgpt-web/sol', reasoning: 'high', observedText: 'GPT-5.6 Sol High' };
  const adapter = fakeAdapter();
  const router = {
    async route(sessionKey, requestOptions) {
      calls.routes.push({ sessionKey, ...requestOptions });
      return { conversation: routedConversation, isNew: false };
    },
    bind(sessionKey, conversation) {
      calls.binds.push({ sessionKey, conversation });
      return conversation;
    },
    binding: () => null,
  };
  const models = {
    async select(selection, requestOptions) {
      calls.selections.push({ selection, ...requestOptions });
      return selected;
    },
    capabilities: async () => ({ models: [], reasoning: [] }),
  };
  const turns = {
    async run(prompt, requestOptions) {
      calls.runs.push({ prompt, ...requestOptions });
      requestOptions.onConversation(interimConversation);
      return { text: 'contract result', conversation: finalConversation, turnId: 'turn-contract-1' };
    },
  };

  const bridge = freshBridge({ adapter, router, models, turns });
  const result = await bridge.request('inspect this function', {
    sessionKey: 'session-contract',
    model: 'chatgpt-web/sol',
    reasoning: 'high',
    timeoutMs: 4321,
  });

  assert.equal(calls.routes.length, 1);
  assert.equal(calls.routes[0].sessionKey, 'session-contract');
  assert.ok(calls.routes[0].signal instanceof AbortSignal);

  assert.equal(calls.selections.length, 1);
  assert.deepEqual(calls.selections[0].selection, { model: 'chatgpt-web/sol', reasoning: 'high' });
  assert.equal(calls.selections[0].signal, calls.routes[0].signal);

  assert.equal(calls.runs.length, 1);
  assert.equal(calls.runs[0].prompt, 'inspect this function');
  assert.equal(calls.runs[0].signal, calls.routes[0].signal);
  assert.equal(calls.runs[0].timeoutMs, 4321);
  assert.equal(calls.runs[0].expectedConversation, routedConversation);

  assert.deepEqual(calls.binds, [
    { sessionKey: 'session-contract', conversation: interimConversation },
    { sessionKey: 'session-contract', conversation: finalConversation },
  ]);
  assert.deepEqual(result, {
    text: 'contract result',
    conversation: finalConversation,
    selection: selected,
    turnId: 'turn-contract-1',
  });
  assert.equal(bridge.status().busy, false);
  clearBridge();
}

async function testSingleInflightAndBusyCleanup() {
  const entered = deferred();
  const release = deferred();
  const bridge = freshBridge({
    adapter: fakeAdapter(),
    router: fakeRouter(),
    models: fakeModels(),
    turns: {
      async run(_prompt, requestOptions) {
        entered.resolve(requestOptions.signal);
        return release.promise;
      },
    },
  });

  const first = bridge.request('first', { sessionKey: 'session-one' });
  await entered.promise;
  assert.equal(bridge.status().busy, true);
  await assert.rejects(
    bridge.request('second', { sessionKey: 'session-two' }),
    /ChatGPT Web is already handling another Hex turn\./,
  );

  release.resolve({ text: 'first result', conversation: null, turnId: 'turn-one' });
  assert.equal((await first).text, 'first result');
  assert.equal(bridge.status().busy, false);
  clearBridge();
}

async function testExternalAbortSignal() {
  const entered = deferred();
  const external = new AbortController();
  let internalSignal = null;
  const bridge = freshBridge({
    adapter: fakeAdapter(),
    router: fakeRouter(),
    models: fakeModels(),
    turns: {
      run(_prompt, requestOptions) {
        internalSignal = requestOptions.signal;
        entered.resolve();
        return rejectOnAbort(requestOptions.signal);
      },
    },
  });

  const pending = bridge.request('abort me', { sessionKey: 'session-abort', signal: external.signal });
  await entered.promise;
  assert.equal(bridge.status().busy, true);
  external.abort('caller-requested-stop');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(internalSignal.aborted, true);
  assert.equal(internalSignal.reason, 'caller-requested-stop');
  assert.equal(bridge.status().busy, false);
  clearBridge();
}

async function testCancelStopsAdapter() {
  const entered = deferred();
  let stopCalls = 0;
  let internalSignal = null;
  const adapter = fakeAdapter({ stop: () => { stopCalls++; } });
  const bridge = freshBridge({
    adapter,
    router: fakeRouter(),
    models: fakeModels(),
    turns: {
      run(_prompt, requestOptions) {
        internalSignal = requestOptions.signal;
        entered.resolve();
        return rejectOnAbort(requestOptions.signal);
      },
    },
  });

  const pending = bridge.request('cancel me', { sessionKey: 'session-cancel' });
  await entered.promise;
  bridge.cancel();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(stopCalls, 1);
  assert.equal(internalSignal.aborted, true);
  assert.equal(internalSignal.reason, 'cancelled');
  assert.equal(bridge.status().busy, false);
  clearBridge();
}

async function testExceptionCleanup() {
  const sentinel = new Error('synthetic adapter failure');
  let runs = 0;
  const bridge = freshBridge({
    adapter: fakeAdapter(),
    router: fakeRouter(),
    models: fakeModels(),
    turns: {
      async run() {
        runs++;
        if (runs === 1) throw sentinel;
        return { text: 'recovered', conversation: null, turnId: 'turn-recovered' };
      },
    },
  });

  await assert.rejects(bridge.request('fail', { sessionKey: 'session-failure' }), (error) => error === sentinel);
  assert.equal(bridge.status().busy, false);
  const recovered = await bridge.request('retry', { sessionKey: 'session-failure' });
  assert.equal(recovered.text, 'recovered');
  assert.equal(bridge.status().busy, false);
  clearBridge();
}

async function testCapabilities() {
  const current = { model: 'chatgpt-web/sol', reasoning: 'high', observedText: 'GPT-5.6 Sol High' };
  let discoveryCalls = 0;
  const bridge = freshBridge({
    adapter: fakeAdapter({ composer: () => ({}), currentSelection: () => current }),
    router: fakeRouter(),
    models: {
      ...fakeModels(),
      async capabilities() {
        discoveryCalls++;
        throw new Error('capability polling must not open the model picker');
      },
    },
    turns: fakeTurns(),
  });

  assert.deepEqual(await bridge.capabilities({ probe: 'contract' }), {
    provider: 'chatgpt-web',
    ready: true,
    maxConcurrentRequests: 1,
    conversationRouting: true,
    models: [{ id: 'chatgpt-web/sol', displayName: 'chatgpt-web/sol', current: true }],
    reasoning: [{ id: 'high', displayName: 'high', current: true }],
    current,
  });
  assert.equal(discoveryCalls, 0, 'capability polling is passive');
  clearBridge();
}

async function testErrorSelectorContract() {
  assert.deepEqual(CHATGPT_SELECTORS.error, ['[data-testid="conversation-turn-error"]']);
  assert.ok(!CHATGPT_SELECTORS.error.some((selector) => selector.includes('[role="alert"]')));
  assert.ok(!CHATGPT_SELECTORS.error.some((selector) => selector.includes('*="error"')));
}

async function testProviderAvailabilityStatusSemantics() {
  const advertised = normalizeCapabilities({
    providers: [{ id: 'chatgpt-web', displayName: 'ChatGPT Web', available: true }],
  });
  assert.equal(advertised.providers[0].label, 'ChatGPT Web');

  const settling = applyStatus(advertised, { provider: 'chatgpt', ready: false });
  assert.equal(
    selectionLabel(settling, { provider: 'chatgpt-web' }, true).unavailable,
    false,
    'transient composer readiness must not turn a proven bridge into 利用不可',
  );

  const unavailable = applyStatus(advertised, { provider: 'chatgpt', available: false, ready: false });
  assert.equal(selectionLabel(unavailable, { provider: 'chatgpt-web' }, true).unavailable, true);
}

async function testSelectionContract() {
  const current = { model: 'chatgpt-web/terra', reasoning: 'standard', observedText: 'GPT-5.6 Terra Standard' };
  const desired = { model: 'chatgpt-web/sol', reasoning: 'xhigh' };
  const selectionOptions = { signal: new AbortController().signal };
  const calls = [];
  const bridge = freshBridge({
    adapter: fakeAdapter({ currentSelection: () => current }),
    router: fakeRouter(),
    models: {
      ...fakeModels(),
      async select(selection, options) {
        calls.push({ selection, options });
        return { ...selection, observedText: 'selected' };
      },
    },
    turns: fakeTurns(),
  });

  assert.equal(bridge.getSelection(), current);
  assert.deepEqual(await bridge.setSelection(desired, selectionOptions), { ...desired, observedText: 'selected' });
  assert.deepEqual(calls, [{ selection: desired, options: selectionOptions }]);
  clearBridge();
}

async function testStatusAndConversationLookup() {
  const conversation = { id: 'status-conversation', url: 'https://chatgpt.com/c/status-conversation' };
  const selection = { model: 'chatgpt-web/luna', reasoning: 'auto' };
  const binding = { id: 'bound-conversation', url: 'https://chatgpt.com/c/bound-conversation' };
  const adapter = fakeAdapter({
    composer: () => ({}),
    location: { hostname: 'chatgpt.com' },
    isGenerating: () => true,
    conversation: () => conversation,
    currentSelection: () => selection,
    errorState: () => 'synthetic status error',
  });
  const seenKeys = [];
  const router = fakeRouter({
    binding(sessionKey) {
      seenKeys.push(sessionKey);
      return sessionKey === 'session-status' ? binding : null;
    },
  });
  const bridge = freshBridge({ adapter, router, models: fakeModels(), turns: fakeTurns() });

  assert.deepEqual(bridge.status(), {
    ready: true,
    busy: false,
    host: 'chatgpt.com',
    generating: true,
    conversation,
    selection,
    error: 'synthetic status error',
  });
  assert.equal(bridge.conversationFor('session-status'), binding);
  assert.deepEqual(seenKeys, ['session-status']);
  clearBridge();
}

async function testBridgeDoesNotReachCookiesOrPrivateBackend() {
  const source = await readFile(new URL('../js/userscript/chatgpt-bridge.js', import.meta.url), 'utf8');
  const importSpecifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

  assert.deepEqual(importSpecifiers, ['./chatgpt-adapter.js']);
  assert.doesNotMatch(source, /\bdocument\s*\.\s*cookie\b|\bcookieStore\b|\bcookies?\s*[:=]/i);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\s*\(|\/backend-api\b|\/api\/(?:auth|conversation|models?)\b/i);
}

function freshBridge(options) {
  clearBridge();
  return installChatGPTWebBridge(options);
}

function clearBridge() {
  delete globalThis[BRIDGE_KEY];
}

function fakeAdapter(overrides = {}) {
  return {
    composer: () => ({}),
    location: { hostname: 'chatgpt.com' },
    isGenerating: () => false,
    conversation: () => null,
    currentSelection: () => ({ model: null, reasoning: null }),
    errorState: () => null,
    stop: () => {},
    ...overrides,
  };
}

function fakeRouter(overrides = {}) {
  return {
    route: async () => ({ conversation: null, isNew: true }),
    bind: (_sessionKey, conversation) => conversation,
    binding: () => null,
    ...overrides,
  };
}

function fakeModels(overrides = {}) {
  return {
    select: async (selection) => selection,
    capabilities: async () => ({ models: [], reasoning: [] }),
    ...overrides,
  };
}

function fakeTurns(overrides = {}) {
  return {
    run: async () => ({ text: 'ok', conversation: null, turnId: 'turn-default' }),
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rejectOnAbort(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error(String(signal.reason || 'aborted'));
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
