/*
 * The only ChatGPT DOM selector table used by the userscript bridge.
 * Keep selectors semantic and ordered from stable test ids/roles to resilient
 * accessibility fallbacks. No selector outside this file should target the
 * ChatGPT page.
 */
export const CHATGPT_SELECTORS = Object.freeze({
  composer: Object.freeze([
    '#prompt-textarea',
    'textarea[name="prompt-textarea"]',
    'textarea[data-id="root"]',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-id]',
  ]),
  send: Object.freeze([
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="送信"]',
    'form button[type="submit"]',
  ]),
  stop: Object.freeze([
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
  ]),
  assistantTurn: Object.freeze([
    '[data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  ]),
  userTurn: Object.freeze([
    '[data-message-author-role="user"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
  ]),
  conversationTurn: Object.freeze(['[data-testid^="conversation-turn-"]']),
  newChat: Object.freeze([
    '[data-testid="create-new-chat-button"]',
    'button[aria-label*="New chat" i]',
    'a[aria-label*="New chat" i]',
    'button[aria-label*="新しいチャット"]',
    'a[href="/"]',
  ]),
  conversationLink: Object.freeze(['nav a[href^="/c/"]', 'a[href^="/c/"]']),
  modelPicker: Object.freeze([
    'button[data-testid="model-switcher-dropdown-button"]',
    'button[aria-label^="Model selector" i]',
    'button[aria-label*="model" i][aria-haspopup]',
    'button[aria-label*="GPT" i][aria-haspopup="menu"]',
  ]),
  modelOption: Object.freeze([
    '[role="menuitemradio"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[data-testid*="model-switcher"] button',
  ]),
  currentModel: Object.freeze([
    'button[data-testid="model-switcher-dropdown-button"]',
    'button[aria-label^="Model selector" i]',
    '[data-testid="model-switcher"]',
  ]),
  reasoningControl: Object.freeze([
    'button[data-testid*="reasoning"]',
    'button[aria-label*="reasoning" i]',
    'button[aria-label*="thinking" i]',
  ]),
  selectedOption: Object.freeze([
    '[role="menuitemradio"][aria-checked="true"]',
    '[role="option"][aria-selected="true"]',
    '[data-state="checked"]',
  ]),
  error: Object.freeze([
    '[data-testid="conversation-turn-error"]',
    '[data-testid*="error"]',
    '[role="alert"]',
  ]),
});

export default CHATGPT_SELECTORS;
