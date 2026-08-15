/*
 * The assistant panel.
 *
 * Layout is decided by width, not by device sniffing: a docked column beside
 * the code on a wide screen, a bottom sheet on a tablet, full screen on a
 * phone. The code never becomes unreachable — the docked column shrinks the
 * workspace instead of covering it, and the sheet layouts collapse as soon as
 * an action navigates somewhere.
 *
 * Rendering is incremental. Only the turn that changed is rebuilt, so a long
 * investigation with a streaming answer does not re-create the transcript on
 * every chunk.
 */
import { h, uiButton } from '../../ui/primitives.js';
import { pick, isJa } from '../../i18n.js';
import { menu } from '../../ui.js';
import { MODE_ITEMS, STYLE_ITEMS, SCOPE_ITEMS, scopeLabel } from './modes.js';
import { renderTurn } from '../render/message.js';
import { conversationTitle } from './conversations.js';
import { applyStatus, capabilityApi, callSafely, normalizeCapabilities, selectionLabel } from './model-picker.js';
import { openModelMenu, openSessionMenu } from './session-menu.js';

const MAX_RENDERED_TURNS = 40;

function segmented(items, active, onPick, label) {
  const root = h('div', 'ai-segmented');
  root.setAttribute('role', 'tablist');
  root.setAttribute('aria-label', label);
  for (const item of items) {
    const selected = item.id === active;
    const button = uiButton(isJa() ? item.ja : item.en, {
      cls: 'ai-seg' + (selected ? ' active' : ''),
      onClick: () => onPick(item.id),
    });
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(selected));
    button.dataset.value = item.id;
    button.title = isJa() ? item.hintJa : item.hintEn;
    root.append(button);
  }
  return root;
}

export function createPanel({ session, handlers }) {
  const root = h('aside', 'ai-panel');
  root.id = 'ai-panel';
  root.hidden = true;
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', pick('AI アシスタント', 'AI assistant'));

  /* ── header ─────────────────────────────────────────────── */
  const head = h('header', 'ai-panel-head');
  /*
   * Which chat you are in comes first, because it is the one thing the
   * transcript itself never tells you. The title button carries the whole
   * history menu, so New chat stays a single tap next to it instead of
   * hiding one level down.
   */
  const sessionButton = uiButton('', { cls: 'ai-session-button' });
  sessionButton.setAttribute('aria-haspopup', 'menu');
  sessionButton.setAttribute('aria-expanded', 'false');
  const sessionTitle = h('span', 'ai-session-title', '');
  sessionButton.replaceChildren(sessionTitle, h('span', 'ai-caret', '▾'));
  sessionButton.addEventListener('click', () => {
    openSessionMenu({ button: sessionButton, session, ja: isJa(), onChange: () => refresh() });
  });
  const newChat = uiButton('＋', {
    cls: 'ai-icon-button ai-new-chat',
    ariaLabel: pick('新しいチャット', 'New chat'),
    onClick: () => { if (session.newConversation()) refresh({ focus: true }); },
  });
  const modes = segmented(MODE_ITEMS, session.mode, (id) => handlers.onMode(id), pick('モード', 'Mode'));
  const styles = segmented(STYLE_ITEMS, session.style, (id) => handlers.onStyle(id), pick('答え方', 'Answer style'));
  const close = uiButton('✕', {
    cls: 'ai-icon-button', ariaLabel: pick('閉じる', 'Close'), onClick: () => handlers.onClose(),
  });
  /*
   * Mode is the primary decision and stays in the header with Close, now
   * behind which chat you are in. Style and scope are turn settings and live
   * in the scrollable context row: at a 340px docked width all four controls
   * in one row clipped their own labels.
   */
  head.append(sessionButton, newChat, modes, close);

  /* ── context bar ────────────────────────────────────────── */
  const contextBar = h('div', 'ai-context-bar');
  const scopeChip = uiButton('', { cls: 'ai-chip ai-scope-chip' });
  scopeChip.setAttribute('aria-haspopup', 'menu');
  scopeChip.addEventListener('click', (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    menu(SCOPE_ITEMS.map((item) => ({
      label: (isJa() ? item.ja : item.en) + (item.id === session.scope ? ' ✓' : ''),
      action: () => handlers.onScope(item.id),
    })), rect.left + rect.width / 2, rect.bottom + 4);
  });
  const contextChip = uiButton('', { cls: 'ai-chip ai-context-chip', onClick: () => handlers.onContextTap() });
  contextBar.append(styles, scopeChip, contextChip);

  /* ── conversation ───────────────────────────────────────── */
  const body = h('div', 'ai-conversation');
  body.tabIndex = -1;
  body.setAttribute('role', 'log');
  body.setAttribute('aria-live', 'polite');
  body.setAttribute('aria-label', pick('AI との会話', 'Assistant conversation'));

  const empty = h('div', 'ai-empty');
  empty.append(h('p', 'ai-empty-title', pick('いま開いているコードについて聞けます。', 'Ask about the code you have open.')));
  const suggestions = h('div', 'ai-empty-suggestions');
  empty.append(suggestions);
  body.append(empty);

  /* ── composer ───────────────────────────────────────────── */
  const composer = h('form', 'ai-composer');
  const input = h('textarea', 'ai-input');
  input.rows = 1;
  input.placeholder = pick('この画面について聞く', 'Ask about this screen');
  input.setAttribute('aria-label', pick('AI への質問', 'Question for the assistant'));
  input.autocapitalize = 'off';
  input.spellcheck = false;
  const send = uiButton('↑', { cls: 'ai-send', ariaLabel: pick('送る', 'Send') });
  send.type = 'submit';
  const stop = uiButton(pick('停止', 'Stop'), { cls: 'ai-chip ai-stop', onClick: () => handlers.onCancel() });
  stop.hidden = true;
  /*
   * The model sits under the box you type into, where it is read as a property
   * of the next question rather than as another top-bar control competing with
   * mode. Stop takes the same row, so nothing moves while an answer runs.
   */
  const composerBar = h('div', 'ai-composer-bar');
  const modelChip = uiButton('', { cls: 'ai-chip ai-model-chip' });
  modelChip.setAttribute('aria-haspopup', 'menu');
  modelChip.setAttribute('aria-expanded', 'false');
  modelChip.addEventListener('click', () => {
    openModelMenu({ button: modelChip, session, capabilities, ja: isJa(), onChange: () => applySelection() });
  });
  composerBar.append(modelChip, stop);
  composer.append(input, send, composerBar);

  const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  const grow = () => {
    input.style.height = 'auto'; // composer geometry
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    /* Touch keyboards put Enter where a newline is expected; there the send
       button is the only thing that sends. */
    if (coarse) return;
    event.preventDefault();
    composer.requestSubmit ? composer.requestSubmit() : submit();
  });
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    /* Clear only once the session has taken the question. Clearing first meant
       a question typed while the previous one was still running vanished. */
    const accepted = handlers.onAsk(value);
    if (accepted === false) return;
    input.value = '';
    grow();
  };
  composer.addEventListener('submit', (event) => { event.preventDefault(); submit(); });

  root.append(head, contextBar, body, composer);

  /*
   * Focus stays inside the sheet and full-screen layouts, which announce
   * themselves as modal. The docked column is not modal: Tab must be able to
   * leave it and reach the code.
   */
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || root.dataset.layout === 'dock') return;
    const focusable = [...root.querySelectorAll('button, textarea, input, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.disabled && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  /* ── provider / model ───────────────────────────────────── */
  /*
   * Nothing here assumes the engine has a selection API yet. When it does not,
   * the picker still records provider/model/reasoning on the conversation and
   * hands them to engine.run(); when it does, that API is the truth and this
   * only mirrors it.
   */
  const capabilityFns = capabilityApi(session.engine);
  let capabilities = normalizeCapabilities(null);
  let capabilityRequest = null;

  function loadCapabilities() {
    if (capabilityRequest) return capabilityRequest;
    capabilityRequest = (async () => {
      const advertised = await callSafely(capabilityFns.capabilities);
      const status = await callSafely(capabilityFns.status);
      capabilities = applyStatus(normalizeCapabilities(advertised), status);
      const current = await callSafely(capabilityFns.get);
      if (current && typeof current === 'object' && !session.current.provider) {
        session.setSelection({
          provider: current.provider == null ? null : current.provider,
          model: current.model == null ? null : current.model,
          reasoning: current.reasoning == null ? null : current.reasoning,
        });
      }
      update({ stick: false });
    })().catch(() => {});
    return capabilityRequest;
  }

  /** A pick is conversation metadata first; the engine is told if it listens. */
  function applySelection() {
    callSafely(capabilityFns.set, session.selectionOf());
    update({ stick: false });
  }

  function refresh({ focus = false } = {}) {
    update({ stick: false });
    if (focus) input.focus();
  }

  /* ── incremental rendering ──────────────────────────────── */
  const rendered = new Map();
  let renderedConversation = null;

  function renderConversation() {
    /*
     * A chat switch is the only time the transcript is thrown away: within a
     * chat the cache keeps a streaming answer from re-creating every turn.
     */
    if (renderedConversation !== session.current.id) {
      for (const entry of rendered.values()) entry.node.remove();
      rendered.clear();
      renderedConversation = session.current.id;
    }
    const turns = session.visibleTurns().slice(-MAX_RENDERED_TURNS);
    empty.hidden = turns.length > 0;
    const seen = new Set();
    let previous = empty;
    for (const turn of turns) {
      seen.add(turn.id);
      const cached = rendered.get(turn.id);
      const signature = turnSignature(turn);
      let node;
      if (cached && cached.signature === signature) {
        node = cached.node;
      } else {
        node = renderTurn(turn, handlers);
        node.dataset.turn = turn.id;
        if (cached) cached.node.replaceWith(node);
        rendered.set(turn.id, { node, signature });
      }
      if (node.previousElementSibling !== previous) previous.after(node);
      previous = node;
    }
    for (const [id, entry] of rendered) {
      if (seen.has(id)) continue;
      entry.node.remove();
      rendered.delete(id);
    }
  }

  function turnSignature(turn) {
    if (turn.role === 'user') return 'u:' + turn.text;
    return [turn.status, turn.activity.length, turn.text.length, turn.response ? 'r' : '-', turn.error || ''].join('|');
  }

  function atBottom() {
    return body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  }

  function update({ stick = true } = {}) {
    const shouldStick = stick && atBottom();
    if (typeof session.syncNamespace === 'function') session.syncNamespace();
    loadCapabilities();
    for (const button of modes.querySelectorAll('.ai-seg')) {
      const on = button.dataset.value === session.mode;
      button.classList.toggle('active', on);
      button.setAttribute('aria-selected', String(on));
    }
    for (const button of styles.querySelectorAll('.ai-seg')) {
      const on = button.dataset.value === session.style;
      button.classList.toggle('active', on);
      button.setAttribute('aria-selected', String(on));
    }
    scopeChip.textContent = pick('範囲: ', 'Scope: ') + scopeLabel(session.scope, isJa());
    const context = handlers.contextLabel();
    contextChip.textContent = context.label;
    contextChip.hidden = !context.label;
    contextChip.disabled = !context.actionable;
    const ja = isJa();
    sessionTitle.textContent = conversationTitle(session.current, ja);
    sessionButton.setAttribute('aria-label',
      (ja ? '会話: ' : 'Conversation: ') + conversationTitle(session.current, ja));
    sessionButton.dataset.conversation = session.current.id;
    /* A running turn owns this chat: switching or renaming the model under it
       would file the answer somewhere the question never was. */
    newChat.disabled = session.busy;
    const model = selectionLabel(capabilities, session.selectionOf(), ja);
    modelChip.textContent = model.text;
    modelChip.title = model.note ? model.text + ' · ' + model.note : model.text;
    modelChip.dataset.unavailable = String(!!model.unavailable);
    modelChip.setAttribute('aria-label', (ja ? 'モデル: ' : 'Model: ') + modelChip.title);
    modelChip.disabled = session.busy;
    root.dataset.mode = session.mode;
    root.dataset.style = session.style;
    send.disabled = session.busy;
    stop.hidden = !session.busy;
    input.disabled = false;
    renderConversation();
    if (shouldStick) body.scrollTop = body.scrollHeight;
  }

  function setSuggestions(items) {
    suggestions.replaceChildren();
    for (const item of items) {
      suggestions.append(uiButton(item, { cls: 'ai-chip', onClick: () => handlers.onAsk(item) }));
    }
  }

  return {
    root,
    input,
    update,
    setSuggestions,
    focusComposer() { input.focus(); },
    scrollToProposal(id) {
      const node = root.querySelector('[data-proposal="' + CSS.escape(String(id)) + '"]');
      if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    header: head,
    body,
    refresh,
    capabilities: () => capabilities,
    describeState() {
      return {
        mode: session.mode, style: session.style, scope: session.scope, busy: session.busy,
        turns: session.turns.length,
        conversationId: session.current.id,
        conversationTitle: conversationTitle(session.current, isJa()),
        conversations: session.list().length,
        selection: session.selectionOf(),
      };
    },
  };
}

export default createPanel;
