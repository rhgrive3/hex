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
  // ChatGPT on iPad/WebKit can keep the Stop control mounted after a response
  // settles, but marks it disabled. Only an actionable Stop control is evidence
  // that generation is still active; otherwise TurnController would wait until
  // the outer RPC timeout even though the assistant answer already completed.
  stop: Object.freeze([
    'button[data-testid="stop-button"]:not(:disabled):not([aria-disabled="true"])',
    'button[aria-label="Stop generating"]:not(:disabled):not([aria-disabled="true"])',
    'button[aria-label="Stop streaming"]:not(:disabled):not([aria-disabled="true"])',
    'button[aria-label*="Stop" i]:not(:disabled):not([aria-disabled="true"])',
    'button[aria-label*="停止"]:not(:disabled):not([aria-disabled="true"])',
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
    '[data-testid*="new-chat" i]',
    '[data-testid*="new_chat" i]',
    'button[aria-label*="New chat" i]',
    'a[aria-label*="New chat" i]',
    'button[aria-label*="新しいチャット"]',
    'a[aria-label*="新しいチャット"]',
    'button[aria-label*="新規チャット"]',
    'a[aria-label*="新規チャット"]',
    'button[title*="New chat" i]',
    'a[title*="New chat" i]',
    'button[title*="新しいチャット"]',
    'a[title*="新しいチャット"]',
    'a[href="/"]',
    'a[href^="/?"]',
  ]),
  sidebarToggle: Object.freeze([
    'button[data-testid*="sidebar" i]',
    'button[aria-label*="sidebar" i]',
    'button[aria-controls*="sidebar" i]',
    'button[title*="sidebar" i]',
    'button[aria-label*="サイドバー"]',
    'button[title*="サイドバー"]',
    'button[aria-label*="メニュー"]',
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
  // Only a turn-scoped hard-error marker is authoritative. ChatGPT keeps
  // global role=alert / aria-live nodes for accessibility announcements; those
  // are not model failures and must never terminate a successful Hex turn.
  error: Object.freeze([
    '[data-testid="conversation-turn-error"]',
  ]),
  // Page-level failures (for example a transient invalid-input toast) are only
  // authoritative when they are newly observed after Hex submits its turn.
  // The turn controller baselines these nodes before send, so historical ARIA
  // announcements cannot poison later requests.
  pageError: Object.freeze([
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[data-testid*="error"]',
  ]),
});

export default CHATGPT_SELECTORS;
