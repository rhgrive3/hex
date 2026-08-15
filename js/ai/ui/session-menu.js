/*
 * The two menus above the composer: recent chats, and the model picker.
 *
 * Both are popovers rather than a permanent sidebar. A sidebar costs width the
 * transcript needs and, on iPad, is one more thing between a question and its
 * answer — a menu opens where the finger already is and returns focus to the
 * button it came from.
 *
 * Every destructive step is a separate, explicit tap: delete asks first, and a
 * running turn disables switching, deleting and model changes so an answer can
 * never be filed under the wrong chat.
 */
import { h, uiButton } from '../../ui/primitives.js';
import { menu } from '../../ui.js';
import { conversationTitle } from './conversations.js';
import { findProvider, selectionForProvider } from './model-picker.js';

const MAX_LISTED = 10;

function anchorPoint(node) {
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.bottom + 4 };
}

/**
 * `menu()` builds its own buttons, so the current row is marked afterwards.
 * The tick in the label is for sighted users; aria-current is for the rest.
 */
function markCurrent(index) {
  if (index < 0 || typeof document === 'undefined') return;
  const items = document.querySelectorAll('#overlays .menu [role="menuitem"]');
  const node = items[index];
  if (node) node.setAttribute('aria-current', 'true');
}

function expand(button, open) {
  button.setAttribute('aria-expanded', String(!!open));
}

/*
 * A menu can be dismissed by a tap anywhere, by Escape, or by another menu
 * opening, and `menu()` reports none of that. Polling for its absence is the
 * one way to keep aria-expanded honest that cannot leak a listener.
 */
let expandedButton = null;
function trackExpanded(button) {
  if (expandedButton && expandedButton !== button) expand(expandedButton, false);
  expandedButton = button;
  expand(button, true);
  const poll = () => {
    if (expandedButton !== button) return;
    if (document.querySelector('#overlays .menu')) { setTimeout(poll, 150); return; }
    expand(button, false);
    expandedButton = null;
  };
  setTimeout(poll, 150);
}

export function openSessionMenu({ button, session, ja = true, onChange = () => {} }) {
  const busy = session.busy;
  const conversations = session.list().slice(0, MAX_LISTED);
  const items = [];
  items.push({
    label: (ja ? '＋ 新しいチャット' : '＋ New chat'),
    disabled: busy,
    action: () => { session.newConversation(); onChange(); },
  });
  if (conversations.length) items.push('-');
  let currentIndex = -1;
  for (const conversation of conversations) {
    const isCurrent = conversation === session.current;
    if (isCurrent) currentIndex = items.length;
    items.push({
      label: (isCurrent ? '✓ ' : '') + conversationTitle(conversation, ja),
      disabled: busy && !isCurrent,
      action: () => { if (session.switchTo(conversation.id)) onChange(); },
    });
  }
  items.push('-');
  items.push({
    label: ja ? '名前を変更…' : 'Rename…',
    action: () => openRename({ session, ja, onChange }),
  });
  items.push({
    label: ja ? '削除…' : 'Delete…',
    disabled: busy,
    action: () => openDelete({ session, ja, onChange }),
  });

  const point = anchorPoint(button);
  menu(items, point.x, point.y);
  markCurrent(currentIndex);
  trackExpanded(button);
}

export function openModelMenu({ button, session, capabilities, ja = true, onChange = () => {} }) {
  const selection = session.selectionOf();
  const items = [];
  let currentIndex = -1;
  if (session.busy) {
    items.push({ label: ja ? '回答中は変更できません' : 'Not while answering', disabled: true, action: () => {} });
    const busyPoint = anchorPoint(button);
    menu(items, busyPoint.x, busyPoint.y);
    trackExpanded(button);
    return;
  }
  for (const provider of capabilities.providers) {
    const isCurrent = provider.id === selection.provider;
    if (isCurrent) currentIndex = items.length;
    const note = provider.available === false ? (ja ? '（利用不可）' : ' (unavailable)') : '';
    items.push({
      label: (isCurrent ? '✓ ' : '') + provider.label + note,
      action: () => { session.setSelection(selectionForProvider(capabilities, provider.id, selection)); onChange(); },
    });
  }

  const provider = findProvider(capabilities, selection.provider);
  if (provider && provider.models.length) {
    items.push('-');
    for (const model of provider.models) {
      const isCurrent = model.id === selection.model;
      const note = model.available === false ? (ja ? '（利用不可）' : ' (unavailable)') : '';
      items.push({
        label: (isCurrent ? '✓ ' : '') + model.label + note,
        action: () => { session.setSelection({ provider: provider.id, model: model.id }); onChange(); },
      });
    }
  }

  const model = provider ? provider.models.find((item) => item.id === selection.model) : null;
  const levels = (model && model.reasoning && model.reasoning.length) ? model.reasoning : (provider ? provider.reasoning : []);
  if (levels && levels.length) {
    items.push('-');
    for (const level of levels) {
      const isCurrent = level.id === selection.reasoning;
      items.push({
        label: (isCurrent ? '✓ ' : '') + level.label,
        action: () => { session.setSelection({ reasoning: level.id }); onChange(); },
      });
    }
  }

  if (!capabilities.known) {
    items.push('-');
    items.push({ label: ja ? 'モデル一覧を取得できません' : 'No model list advertised', disabled: true, action: () => {} });
  }

  const point = anchorPoint(button);
  menu(items, point.x, point.y);
  markCurrent(currentIndex);
  trackExpanded(button);
}

/* ── small dialogs ──────────────────────────────────────────── */

function overlayHost() {
  return document.getElementById('overlays') || document.body;
}

function dialogShell(titleText) {
  const backdrop = h('div', 'backdrop');
  const root = h('div', 'dialog ai-dialog');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.append(h('h3', null, titleText));
  return { backdrop, root };
}

function openDialog({ title, build, ja }) {
  const returnFocus = document.activeElement;
  const { backdrop, root } = dialogShell(title);
  const actions = h('div', 'actions');
  const close = () => {
    document.removeEventListener('keydown', key, true);
    backdrop.remove();
    root.remove();
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
      try { returnFocus.focus({ preventScroll: true }); } catch { /* best effort */ }
    }
  };
  const key = (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
  const cancel = uiButton(ja ? 'やめる' : 'Cancel', { cls: 'ai-dialog-cancel', onClick: close });
  const { body, confirm } = build({ close });
  if (body) root.append(body);
  actions.append(cancel, confirm);
  root.append(actions);
  overlayHost().append(backdrop, root);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', key, true);
  return { root, close };
}

export function openRename({ session, ja = true, onChange = () => {} }) {
  const conversation = session.current;
  const input = h('input', 'ai-dialog-input');
  input.type = 'text';
  input.value = conversation.title || '';
  input.setAttribute('aria-label', ja ? 'チャットの名前' : 'Chat name');
  input.maxLength = 80;
  const dialog = openDialog({
    title: ja ? 'チャットの名前を変える' : 'Rename chat',
    ja,
    build: ({ close }) => {
      const apply = () => { session.renameConversation(conversation.id, input.value); onChange(); close(); };
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        apply();
      });
      return { body: input, confirm: uiButton(ja ? '変える' : 'Rename', { cls: 'ai-dialog-confirm', onClick: apply }) };
    },
  });
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return dialog;
}

export function openDelete({ session, ja = true, onChange = () => {} }) {
  const conversation = session.current;
  return openDialog({
    title: ja ? 'このチャットを消す' : 'Delete this chat',
    ja,
    build: ({ close }) => ({
      body: h('p', null, ja
        ? `「${conversationTitle(conversation, true)}」を消します。元に戻せません。`
        : `“${conversationTitle(conversation, false)}” will be deleted. This cannot be undone.`),
      confirm: uiButton(ja ? '消す' : 'Delete', {
        cls: 'ai-dialog-confirm danger',
        onClick: () => { session.deleteConversation(conversation.id); onChange(); close(); },
      }),
    }),
  });
}

export default { openSessionMenu, openModelMenu, openRename, openDelete };
