import assert from 'node:assert/strict';
import { ChatGPTConversationRouter } from '../js/userscript/chatgpt-adapter.js';

await alreadyFreshSurfaceNeedsNoButton();
await collapsedMobileSidebarCanCreateNewChat();
await collapsedMobileSidebarCanRestoreKnownConversation();
console.log('chatgpt-new-chat-routing: ok');

async function alreadyFreshSurfaceNeedsNoButton() {
  const adapter = {
    conversation: () => null,
    conversationTurns: () => [],
    composer: () => ({}),
    newChatButton: () => null,
    sidebarToggle: () => null,
    all: () => [],
  };
  const router = new ChatGPTConversationRouter(adapter, { storage: null, navigationTimeoutMs: 40 });
  const routed = await router.route('fresh');
  assert.equal(routed.isNew, true);
  assert.equal(routed.conversation, null);
}

async function collapsedMobileSidebarCanCreateNewChat() {
  let current = { id: 'old', url: 'https://chatgpt.com/c/old' };
  let turns = [{ id: 'old-user' }];
  let revealed = false;
  let clicks = 0;
  const newControl = { click() { clicks++; current = null; turns = []; } };
  const adapter = {
    conversation: () => current,
    conversationTurns: () => turns,
    composer: () => ({}),
    newChatButton: () => revealed ? newControl : null,
    sidebarToggle: () => ({ click() { revealed = true; } }),
    all: () => [],
  };
  const router = new ChatGPTConversationRouter(adapter, { storage: null, navigationTimeoutMs: 100 });
  const routed = await router.route('new-hex-chat');
  assert.equal(revealed, true, 'mobile navigation must be revealed before failing New Chat discovery');
  assert.equal(clicks, 1);
  assert.equal(routed.isNew, true);
}

async function collapsedMobileSidebarCanRestoreKnownConversation() {
  let current = { id: 'worker', url: 'https://chatgpt.com/c/worker' };
  let revealed = false;
  const known = { id: 'supervisor', url: 'https://chatgpt.com/c/supervisor' };
  const link = {
    getAttribute(name) { return name === 'href' ? '/c/supervisor' : null; },
    click() { current = known; },
  };
  const adapter = {
    conversation: () => current,
    conversationTurns: () => [],
    composer: () => ({}),
    newChatButton: () => null,
    sidebarToggle: () => ({ click() { revealed = true; } }),
    all(kind) { return kind === 'conversationLink' && revealed ? [link] : []; },
  };
  const router = new ChatGPTConversationRouter(adapter, { storage: null, navigationTimeoutMs: 100 });
  router.bind('supervisor-session', known);
  const routed = await router.route('supervisor-session');
  assert.equal(revealed, true);
  assert.equal(routed.conversation.id, 'supervisor');
}
