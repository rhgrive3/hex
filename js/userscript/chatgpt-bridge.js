const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'textarea[data-id="root"]',
  'div[contenteditable="true"][data-id]',
  'div[contenteditable="true"][role="textbox"]',
];
const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label*="Send" i]',
  'button[aria-label*="送信"]',
  'form button[type="submit"]',
];
const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop" i]',
  'button[aria-label*="停止"]',
];
const ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
];

const DEFAULT_TIMEOUT_MS = 110000;
const START_TIMEOUT_MS = 8000;
const QUIET_MS = 650;

export function installChatGPTWebBridge(options = {}) {
  const existing = globalThis.__HEX_CHATGPT_BRIDGE__;
  if (existing && typeof existing.request === 'function') return existing;

  let active = null;
  const bridge = {
    async request(prompt, requestOptions = {}) {
      if (active) throw new Error('ChatGPT Web is already handling another Hex turn.');
      const controller = new AbortController();
      const externalSignal = requestOptions.signal;
      const onExternalAbort = () => controller.abort(externalSignal?.reason || 'cancelled');
      if (externalSignal) {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        if (externalSignal.aborted) onExternalAbort();
      }
      active = controller;
      try {
        return await runTurn(String(prompt || ''), {
          signal: controller.signal,
          timeoutMs: requestOptions.timeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS,
        });
      } finally {
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
        if (active === controller) active = null;
      }
    },

    cancel() {
      if (!active) return;
      active.abort('cancelled');
      clickStop();
    },

    status() {
      return {
        ready: !!findComposer(),
        busy: !!active,
        host: location.hostname,
      };
    },
  };

  globalThis.__HEX_CHATGPT_BRIDGE__ = bridge;
  return bridge;
}

async function runTurn(prompt, { signal, timeoutMs }) {
  if (!prompt.trim()) throw new Error('Hex produced an empty ChatGPT prompt.');
  if (location.hostname !== 'chatgpt.com') throw new Error('ChatGPT Web bridge only runs on chatgpt.com.');

  const startedAt = Date.now();
  const composer = await waitFor(() => findComposer(), Math.min(START_TIMEOUT_MS, timeoutMs), signal);
  if (!composer) throw new Error('ChatGPT composer was not found. Open a normal ChatGPT conversation and try again.');
  if (isGenerating()) throw new Error('ChatGPT is already generating a response. Stop it before running Hex AI.');

  const before = assistantTurns();
  const beforeCount = before.length;
  setComposerText(composer, prompt);

  const send = await waitFor(() => {
    const button = findFirst(SEND_SELECTORS);
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
  }, Math.min(START_TIMEOUT_MS, remaining(startedAt, timeoutMs)), signal);
  if (!send) throw new Error('ChatGPT send button did not become available.');

  send.click();
  await waitForSendAccepted(composer, beforeCount, Math.min(START_TIMEOUT_MS, remaining(startedAt, timeoutMs)), signal);

  try {
    return await waitForAssistantResponse(beforeCount, remaining(startedAt, timeoutMs), signal);
  } catch (error) {
    if (signal?.aborted) clickStop();
    throw error;
  }
}

async function waitForAssistantResponse(beforeCount, timeoutMs, signal) {
  const startedAt = Date.now();
  let latest = '';
  let lastChangedAt = Date.now();
  let sawGenerating = isGenerating();
  let sawNewTurn = false;

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(tick);
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(signal?.reason));
    const sample = () => {
      if (done) return;
      if (signal?.aborted) return onAbort();
      const turns = assistantTurns();
      if (turns.length > beforeCount) sawNewTurn = true;
      const node = turns.length ? turns[turns.length - 1] : null;
      if (!sawNewTurn || !node) return;
      const text = assistantText(node);
      if (text !== latest) {
        latest = text;
        lastChangedAt = Date.now();
      }
      if (isGenerating()) {
        sawGenerating = true;
        return;
      }
      /* ChatGPT can briefly remove the Stop button between UI phases. Require
         both non-empty output and a quiet period before accepting the turn. */
      if (latest.trim() && Date.now() - lastChangedAt >= QUIET_MS && (sawGenerating || Date.now() - startedAt >= QUIET_MS)) {
        finish(resolve, latest.trim());
      }
    };

    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const tick = setInterval(sample, 120);
    const deadline = setTimeout(() => finish(reject, new Error('ChatGPT response timed out.')), Math.max(1, timeoutMs));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    sample();
  });
}

async function waitForSendAccepted(composer, beforeCount, timeoutMs, signal) {
  await waitFor(() => {
    if (assistantTurns().length > beforeCount || isGenerating()) return true;
    const current = composerText(composer).trim();
    return current.length === 0;
  }, timeoutMs, signal);
}

function setComposerText(composer, text) {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(composer, text);
    else composer.value = text;
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);
  let inserted = false;
  try { inserted = document.execCommand('insertText', false, text); } catch { inserted = false; }
  if (!inserted) {
    composer.textContent = text;
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  selection?.removeAllRanges();
  composer.dispatchEvent(new Event('change', { bubbles: true }));
}

function composerText(node) {
  if (!node) return '';
  if ('value' in node && typeof node.value === 'string') return node.value;
  return node.innerText || node.textContent || '';
}

function assistantTurns() {
  const seen = new Set();
  const out = [];
  for (const selector of ASSISTANT_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) {
      const canonical = node.closest?.('[data-message-author-role="assistant"]') || node;
      if (!seen.has(canonical)) { seen.add(canonical); out.push(canonical); }
    }
  }
  return out;
}

function assistantText(node) {
  const body = node.querySelector?.('.markdown, [class*="markdown"], [data-message-content]') || node;
  return body.innerText || body.textContent || '';
}

function findComposer() { return findFirst(COMPOSER_SELECTORS); }
function isGenerating() { return !!findFirst(STOP_SELECTORS); }
function clickStop() { try { findFirst(STOP_SELECTORS)?.click(); } catch { /* best effort */ } }

function findFirst(selectors) {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node) return node;
  }
  return null;
}

function waitFor(probe, timeoutMs, signal) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  return new Promise((resolve, reject) => {
    const check = () => {
      if (signal?.aborted) { reject(abortError(signal.reason)); return; }
      let value = null;
      try { value = probe(); } catch { value = null; }
      if (value) { resolve(value); return; }
      if (Date.now() >= deadline) { resolve(null); return; }
      setTimeout(check, 80);
    };
    check();
  });
}

function remaining(startedAt, timeoutMs) { return Math.max(1, timeoutMs - (Date.now() - startedAt)); }

function abortError(reason) {
  const error = new DOMException(String(reason || 'cancelled'), 'AbortError');
  return error;
}
