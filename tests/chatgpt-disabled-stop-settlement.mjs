import assert from 'node:assert/strict';
import { ChatGPTDOMAdapter, ChatGPTTurnController } from '../js/userscript/chatgpt-adapter.js';
import { CHATGPT_SELECTORS } from '../js/userscript/chatgpt-selectors.js';

for (const selector of CHATGPT_SELECTORS.stop) {
  assert.match(selector, /:not\(:disabled\)/, 'every Stop selector must ignore a native-disabled control');
  assert.match(selector, /:not\(\[aria-disabled="true"\]\)/, 'every Stop selector must ignore an aria-disabled control');
  assert.doesNotMatch(selector, /aria-label\*=/, 'generation Stop selectors must not use broad aria-label substring matching');
}

const enabled = stopButton({ disabled: false, ariaDisabled: null });
assert.equal(adapterFor(enabled).isGenerating(), true, 'an actionable Stop control means ChatGPT is generating');

const nativeDisabled = stopButton({ disabled: true, ariaDisabled: null });
assert.equal(
  adapterFor(nativeDisabled).isGenerating(),
  false,
  'iPad/WebKit may leave data-testid=stop-button mounted after settlement; native-disabled must not keep the turn alive',
);

const ariaDisabled = stopButton({ disabled: false, ariaDisabled: 'true' });
assert.equal(
  adapterFor(ariaDisabled).isGenerating(),
  false,
  'an aria-disabled lingering Stop control must not keep the turn alive',
);

await assertNewConversationDoesNotHardFailOnPreexistingGlobalStop();
await assertExistingConversationStillRejectsPreexistingGeneration();

console.log('chatgpt-disabled-stop-settlement: ok');

function adapterFor(button) {
  const document = {
    querySelector(selector) {
      if (!String(selector).startsWith('button')) return null;
      if (!looksLikeStopSelector(selector)) return null;
      if (selector.includes(':not(:disabled)') && button.disabled) return null;
      if (selector.includes(':not([aria-disabled="true"])') && button.getAttribute('aria-disabled') === 'true') return null;
      return button;
    },
    querySelectorAll() { return []; },
  };
  return new ChatGPTDOMAdapter({ document, location: { href: 'https://chatgpt.com/c/test' } });
}

async function assertNewConversationDoesNotHardFailOnPreexistingGlobalStop() {
  const adapter = minimalBusyAdapter();
  const turns = new ChatGPTTurnController(adapter, { startTimeoutMs: 2, pollMs: 1 });
  await assert.rejects(
    turns.run('bootstrap', { timeoutMs: 8, expectedConversation: null, newConversation: true }),
    (error) => {
      assert.notEqual(error?.code, 'already-generating');
      assert.equal(error?.code, 'send-unavailable');
      return true;
    },
  );
}

async function assertExistingConversationStillRejectsPreexistingGeneration() {
  const adapter = minimalBusyAdapter();
  const turns = new ChatGPTTurnController(adapter, { startTimeoutMs: 2, pollMs: 1 });
  await assert.rejects(
    turns.run('bootstrap', {
      timeoutMs: 8,
      expectedConversation: { id: 'existing', url: 'https://chatgpt.com/c/existing' },
      newConversation: false,
    }),
    (error) => error?.code === 'already-generating',
  );
}

function minimalBusyAdapter() {
  const composer = { text: '', isConnected: true };
  return {
    composer: () => composer,
    isGenerating: () => true,
    assistantTurns: () => [],
    userTurns: () => [],
    conversationTurns: () => [],
    composerText: (node) => node.text,
    setComposerText: (node, value) => { node.text = String(value); },
    sendButton: () => null,
  };
}

function looksLikeStopSelector(selector) {
  return /stop-button|Stop generating|Stop streaming|生成を停止|応答の生成を停止|ストリーミングを停止/.test(String(selector));
}

function stopButton({ disabled, ariaDisabled }) {
  return {
    disabled,
    getAttribute(name) {
      if (name === 'data-testid') return 'stop-button';
      if (name === 'aria-disabled') return ariaDisabled;
      return null;
    },
  };
}
