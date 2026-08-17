import assert from 'node:assert/strict';
import { ChatGPTConversationRouter } from '../../js/userscript/chatgpt-adapter.js';
import { installChatGPTWebBridge } from '../../js/userscript/chatgpt-bridge.js';

await testDelayedConversationIdentityStaysOnOneSupervisorChat();
console.log('dev-agent supervisor conversation continuity: ok');

async function testDelayedConversationIdentityStaysOnOneSupervisorChat() {
  delete globalThis.__HEX_CHATGPT_BRIDGE__;

  let current = null;
  let turnsInDom = [];
  let newChatClicks = 0;
  let requestCount = 0;
  const adapter = {
    conversation: () => current,
    composer: () => ({}),
    newChatButton: () => ({
      click() {
        newChatClicks++;
        current = null;
        turnsInDom = [];
      },
    }),
    sidebarToggle: () => null,
    assistantTurns: () => turnsInDom,
    conversationTurns: () => turnsInDom,
    all: () => [],
    currentSelection: () => ({ model: null, reasoning: null, observedText: '' }),
    isGenerating: () => false,
    stop: () => false,
    errorState: () => null,
    location: { hostname: 'chatgpt.com' },
  };
  const router = new ChatGPTConversationRouter(adapter, { storage: null, navigationTimeoutMs: 100 });
  const models = { select: async () => ({ model: null, reasoning: null, observedText: '' }) };
  const turns = {
    async run(_prompt, options = {}) {
      requestCount++;
      if (requestCount === 1) {
        assert.equal(options.expectedConversation, null);
        assert.equal(options.newConversation, true);
        turnsInDom = [{ id: 'assistant-supervisor-1', text: '{"type":"tool","tool":"worker.claim"}' }];
        setTimeout(() => {
          current = { id: 'supervisor-chat', url: 'https://chatgpt.com/c/supervisor-chat' };
        }, 20);
        return {
          text: '{"type":"tool","tool":"worker.claim","arguments":{},"purpose":"claim"}',
          conversation: null,
          turnId: 'assistant-supervisor-1',
        };
      }

      assert.equal(options.expectedConversation?.id, 'supervisor-chat', 'the second Supervisor decision must reuse the first ChatGPT conversation');
      assert.equal(options.newConversation, false);
      turnsInDom.push({ id: 'assistant-supervisor-2', text: '{"type":"tool","tool":"worker.create_chat"}' });
      return {
        text: '{"type":"tool","tool":"worker.create_chat","arguments":{},"purpose":"create"}',
        conversation: current,
        turnId: 'assistant-supervisor-2',
      };
    },
  };

  const bridge = installChatGPTWebBridge({
    adapter,
    router,
    models,
    turns,
    lateBindingWaitMs: 5,
  });

  const first = await bridge.request('first supervisor decision', { sessionKey: 'supervisor-session' });
  assert.equal(first.conversation, null, 'fixture must reproduce a response settling before /c/<id> becomes observable');
  await delay(35);

  const second = await bridge.request('second supervisor decision', { sessionKey: 'supervisor-session' });
  assert.equal(second.conversation?.id, 'supervisor-chat');
  assert.equal(bridge.conversationFor('supervisor-session')?.id, 'supervisor-chat');
  assert.equal(newChatClicks, 0, 'late binding must prevent a second Supervisor Chat from being created');
  assert.equal(requestCount, 2);

  delete globalThis.__HEX_CHATGPT_BRIDGE__;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
