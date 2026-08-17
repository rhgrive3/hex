import assert from 'node:assert/strict';
import { ChatGPTDOMAdapter } from '../js/userscript/chatgpt-adapter.js';
import { CHATGPT_SELECTORS } from '../js/userscript/chatgpt-selectors.js';

// Real iPad Safari forensic regression: while the composer was still enabling
// its genuine Send button, the page already contained this history-row control.
// A document-wide aria-label*=送信 fallback selected it immediately, opened the
// conversation options menu, and left the Hex prompt sitting unsent in composer.
const historyOptions = fakeButton({
  id: 'radix-_r_d0_',
  testId: 'history-item-1-options',
  ariaLabel: 'Worker指示送信 の会話オプションを開く',
});
const genuineSend = fakeButton({
  id: 'composer-submit-button',
  testId: 'send-button',
  ariaLabel: 'プロンプトを送信する',
});
const composer = { id: 'prompt-textarea' };
let genuineMounted = false;

const document = {
  querySelector(selector) {
    if (selector === '#prompt-textarea') return composer;
    if (genuineMounted && (selector === '#composer-submit-button' || selector === 'button[data-testid="send-button"]')) {
      return genuineSend;
    }

    // Model the exact unsafe fallbacks that caused the production incident.
    // Safe selector tables never ask the document for these selectors.
    if (selector.includes('aria-label*="送信"') || selector.includes('aria-label*="Send"')) return historyOptions;
    if (selector === 'form button[type="submit"]') return historyOptions;
    return null;
  },
};

const adapter = new ChatGPTDOMAdapter({
  document,
  location: { href: 'https://chatgpt.com/' },
  history: null,
});

assert.equal(
  adapter.sendButton(),
  null,
  'history/sidebar controls containing 送信 must not stand in for a composer Send control while the real button is still mounting',
);

genuineMounted = true;
assert.equal(
  adapter.sendButton(),
  genuineSend,
  'the genuine composer submit control must be selected as soon as it mounts',
);

assert.ok(CHATGPT_SELECTORS.send.includes('#composer-submit-button'), 'the production iPad composer-submit-button identity must be first-class');
assert.ok(CHATGPT_SELECTORS.send.includes('button[data-testid="send-button"]'), 'the stable Send test id must remain supported');
assert.ok(CHATGPT_SELECTORS.send.includes('button[aria-label="プロンプトを送信する"]'), 'the observed Japanese Send accessibility name must be supported exactly');
assert.ok(
  CHATGPT_SELECTORS.send.every((selector) => !/aria-label\*=(?:"|')(?:[^"']*Send|[^"']*送信)/i.test(selector)),
  'Send accessibility fallbacks must never use broad substring matching',
);
assert.ok(
  CHATGPT_SELECTORS.send.every((selector) => selector !== 'form button[type="submit"]'),
  'generic document-wide form submit fallback must not be accepted',
);
assert.ok(
  CHATGPT_SELECTORS.send.some((selector) => selector.startsWith('form:has(')),
  'submit-button fallback must be scoped to a form that owns a ChatGPT composer',
);

console.log('chatgpt-send-control-resolution: ok');

function fakeButton({ id, testId, ariaLabel }) {
  const attrs = new Map([
    ['data-testid', testId],
    ['aria-label', ariaLabel],
  ]);
  return {
    id,
    tagName: 'BUTTON',
    disabled: false,
    isConnected: true,
    getAttribute(name) { return attrs.get(name) ?? null; },
    click() {},
  };
}
