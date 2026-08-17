import assert from 'node:assert/strict';
import { ChatGPTConversationRouter } from '../../js/userscript/chatgpt-adapter.js';
import { installChatGPTWebBridge } from '../../js/userscript/chatgpt-bridge.js';

await testDelayedConversationIdentityStaysOnOneSupervisorChat();
await testUnboundSupervisorSurfaceNeverCreatesAnotherChat();
console.log('dev-agent supervisor conversation continuity: ok');

async function testDelayedConversationIdentityStaysOnOneSupervisorChat() {
  delete globalThis.__HEX_CHATGPT_BRIDGE__;

  let current = null;
  let turnsInDom = [];
  let newChatClicks = 0;
  let requestCount = 0;
  const adapter = fixtureAdapter({
    current: () => current,
    turns: () => turnsInDom,
    onNewChat() { newChatClicks++; current = null; turnsInDom = []; },
  });
  const router = new ChatGPTConversationRouter(adapter, { storage: null, navigationTimeoutMs: 100 });
  const models = fixtureModels();
  const turns = {
    async run(_prompt, options = {}) {
      requestCount++;
      if (requestCount === 1) {
        assert.equal(options.expectedConversation, null);
        assert.equal(options.newConversation, true);
        turnsInDom = [{ id: 'assistant-supervisor-1', text: '{"type":"tool","tool":"worker.claim"}' }];
        setTimeout(() => {
          current = { id: 'supervisor-chat', url: 'https://chatgpt.com/c/supervisor-chat' };
        }, 100);
        return supervisorResult('assistant-supervisor-1', null, 'worker.claim');
      }

      assert.equal(options.expectedConversation?.id, 'supervisor-chat', 'the second Supervisor decision must reuse the first ChatGPT conversation');
      assert.equal(options.newConversation, false);
      turnsInDom.push({ id: 'assistant-supervisor-2', text: '{"type":"tool","tool":"worker.create_chat"}' });
      return supervisorResult('assistant-supervisor-2', current, 'worker.create_chat');
    },
  };

  const bridge = installChatGPTWebBridge({ adapter, router, models, turns, lateBindingWaitMs: 1 });
  const first = await bridge.request('first supervisor decision', { sessionKey: 'supervisor-session' });
  assert.equal(first.conversation, null, 'fixture must reproduce a response settling before /c/<id> becomes observable');
  await delay(40);

  const second = await bridge.request('second supervisor decision', { sessionKey: 'supervisor-session' });
  assert.equal(second.conversation?.id, 'supervisor-chat');
  assert.equal(bridge.conversationFor('supervisor-session')?.id, 'supervisor-chat');
  assert.equal(newChatClicks, 0, 'late binding must prevent a second Supervisor Chat from being created');
  assert.equal(requestCount, 2);
  delete globalThis.__HEX_CHATGPT_BRIDGE__;
}

async function testUnboundSupervisorSurfaceNeverCreatesAnotherChat() {
  delete globalThis.__HEX_CHATGPT_BRIDGE__;

  let turnsInDom = [];
  let newChatClicks = 0;
  let requestCount = 0;
  const adapter = fixtureAdapter({
    current: () => null,
    turns: () => turnsInDom,
    onNewChat() { newChatClicks++; turnsInDom = []; },
  });
  const router = new ChatGPTConversationRouter(adapter, { storage: null, navigationTimeoutMs: 20 });
  const turns = {
    async run(_prompt, options = {}) {
      requestCount++;
      assert.equal(options.expectedConversation, null);
      assert.equal(options.newConversation, true);
      const id = `assistant-unbound-${requestCount}`;
      turnsInDom.push({ id, text: `supervisor-${requestCount}` });
      return supervisorResult(id, null, requestCount === 1 ? 'worker.claim' : 'worker.create_chat');
    },
  };
  const bridge = installChatGPTWebBridge({ adapter, router, models: fixtureModels(), turns, lateBindingWaitMs: 1 });

  await bridge.request('first supervisor decision', { sessionKey: 'unbound-supervisor-session' });
  assert.ok(turnsInDom.some((turn) => turn.id === 'assistant-unbound-1'));
  await bridge.request('second supervisor decision', { sessionKey: 'unbound-supervisor-session' });

  assert.equal(requestCount, 2);
  assert.equal(newChatClicks, 0, 'an exact prior Supervisor turn on the current unbound surface must suppress redundant New Chat');
  assert.ok(turnsInDom.some((turn) => turn.id === 'assistant-unbound-1'), 'continuity must preserve the first Supervisor turn');
  assert.ok(turnsInDom.some((turn) => turn.id === 'assistant-unbound-2'), 'the second decision must append to the same surface');
  delete globalThis.__HEX_CHATGPT_BRIDGE__;
}

function fixtureAdapter({ current, turns, onNewChat }) {
  return {
    conversation: current,
    composer: () => ({}),
    newChatButton: () => ({ click: onNewChat }),
    sidebarToggle: () => null,
    assistantTurns: turns,
    conversationTurns: turns,
    all: () => [],
    currentSelection: () => ({ model: null, reasoning: null, observedText: '' }),
    isGenerating: () => false,
    stop: () => false,
    errorState: () => null,
    location: { hostname: 'chatgpt.com' },
  };
}
function fixtureModels() { return { select: async () => ({ model: null, reasoning: null, observedText: '' }) }; }
function supervisorResult(turnId, conversation, tool) {
  return {
    text: `{"type":"tool","tool":"${tool}","arguments":{},"purpose":"test"}`,
    conversation,
    turnId,
  };
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
