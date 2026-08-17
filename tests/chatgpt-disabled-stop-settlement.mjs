import assert from 'node:assert/strict';
import { ChatGPTDOMAdapter } from '../js/userscript/chatgpt-adapter.js';
import { CHATGPT_SELECTORS } from '../js/userscript/chatgpt-selectors.js';

for (const selector of CHATGPT_SELECTORS.stop) {
  assert.match(selector, /:not\(:disabled\)/, 'every Stop selector must ignore a native-disabled control');
  assert.match(selector, /:not\(\[aria-disabled="true"\]\)/, 'every Stop selector must ignore an aria-disabled control');
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

function looksLikeStopSelector(selector) {
  return /stop-button|Stop generating|Stop streaming|Stop|停止/.test(String(selector));
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
