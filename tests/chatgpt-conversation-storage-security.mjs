import assert from 'node:assert/strict';
import { installChatGPTWebBridge } from '../js/userscript/chatgpt-bridge.js';

const STORAGE_KEY = 'hex.chatgpt.conversations.v1';
const poisoned = {
  victim: { id: 'attacker-chat', url: 'https://chatgpt.com/c/attacker-chat' },
};
let pageReads = 0;
let pageWrites = 0;
const pageStorage = {
  getItem(key) {
    if (key === STORAGE_KEY) pageReads++;
    return key === STORAGE_KEY ? JSON.stringify(poisoned) : null;
  },
  setItem() { pageWrites++; },
};

const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: pageStorage });

try {
  delete globalThis.__HEX_CHATGPT_BRIDGE__;
  const bridge = installChatGPTWebBridge({ adapter: {}, models: {}, turns: {} });
  assert.equal(
    bridge.conversationFor('victim'),
    null,
    'production bridge must not accept a page-origin persisted conversation binding',
  );
  assert.equal(pageReads, 0, 'production bridge must not read page-origin conversation routing storage');
  assert.equal(pageWrites, 0, 'production bridge must not write conversation routing state to page-origin storage');

  delete globalThis.__HEX_CHATGPT_BRIDGE__;
  const trustedStorage = memoryStorage({
    trusted: { id: 'trusted-chat', url: 'https://chatgpt.com/c/trusted-chat' },
  });
  const trustedBridge = installChatGPTWebBridge({
    adapter: {},
    models: {},
    turns: {},
    storage: trustedStorage,
  });
  assert.deepEqual(
    trustedBridge.conversationFor('trusted'),
    { id: 'trusted-chat', url: 'https://chatgpt.com/c/trusted-chat' },
    'explicitly injected trusted storage must remain supported',
  );
} finally {
  delete globalThis.__HEX_CHATGPT_BRIDGE__;
  if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
  else delete globalThis.localStorage;
}

console.log('chatgpt conversation storage security: ok');

function memoryStorage(initial = {}) {
  const data = new Map([[STORAGE_KEY, JSON.stringify(initial)]]);
  return {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, String(value)); },
  };
}
