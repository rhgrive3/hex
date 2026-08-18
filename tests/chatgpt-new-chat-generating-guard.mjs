import assert from 'node:assert/strict';
import { ChatGPTDOMAdapter, ChatGPTTurnController } from '../js/userscript/chatgpt-adapter.js';

testUnrelatedStopControlIsNotGeneration();
await testNewConversationDoesNotHardFailOnPreexistingGlobalStop();
await testExistingConversationStillRejectsPreexistingGeneration();
console.log('chatgpt new-chat generating guard: ok');

function testUnrelatedStopControlIsNotGeneration() {
  const unrelated = control({ ariaLabel: 'Stop voice mode' });
  const doc = {
    querySelector(selector) {
      return selector.includes('aria-label*="Stop"') ? unrelated : null;
    },
  };
  const adapter = new ChatGPTDOMAdapter({ document: doc, location: { href: 'https://chatgpt.com/' } });
  assert.equal(adapter.isGenerating(), false, 'unrelated Stop-labelled UI must not mark ChatGPT as generating');

  const realStop = control({ ariaLabel: 'Stop generating' });
  const realDoc = {
    querySelector(selector) {
      return selector.startsWith('button[data-testid="stop-button"]') ? realStop : null;
    },
  };
  const realAdapter = new ChatGPTDOMAdapter({ document: realDoc, location: { href: 'https://chatgpt.com/' } });
  assert.equal(realAdapter.isGenerating(), true, 'the canonical generation Stop control must remain authoritative');
}

async function testNewConversationDoesNotHardFailOnPreexistingGlobalStop() {
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

async function testExistingConversationStillRejectsPreexistingGeneration() {
  const adapter = minimalBusyAdapter();
  const turns = new ChatGPTTurnController(adapter, { startTimeoutMs: 2, pollMs: 1 });
  await assert.rejects(
    turns.run('bootstrap', { timeoutMs: 8, expectedConversation: { id: 'existing', url: 'https://chatgpt.com/c/existing' }, newConversation: false }),
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

function control({ ariaLabel }) {
  return {
    isConnected: true,
    disabled: false,
    getAttribute(name) {
      if (name === 'aria-disabled') return 'false';
      if (name === 'aria-label') return ariaLabel;
      return null;
    },
  };
}
