/*
 * The assistant surface.
 *
 * Owns the launcher, the panel, the session, and the wiring between an answer
 * and the workbench. Everything else in js/ai/ui is a part this file composes.
 *
 * Install order matters: the launcher exists from boot so the assistant is one
 * tap away with no file open, while the engine (and therefore the AI core) is
 * only touched on the first question.
 */
import { pick, isJa } from '../../i18n.js';
import { toast } from '../../ui.js';
import { AiSession } from './session.js';
import { createPanel } from './panel.js';
import { createLauncher } from './launcher.js';
import { createAiEngine } from './bridge.js';
import { workbenchContext } from './workbench.js';
import { createActionRunner } from '../interaction/actions.js';
import { renderProposal } from '../render/proposal.js';
import { showTerm } from '../../panels.js';
import { uiRoot } from '../../ui-root.js';

const DOCK_MIN_WIDTH = 900;
const SHEET_MIN_WIDTH = 600;

function layoutFor(width) {
  if (width >= DOCK_MIN_WIDTH) return 'dock';
  if (width >= SHEET_MIN_WIDTH) return 'sheet';
  return 'full';
}

function suggestionsFor(app) {
  const info = app.store.get('fileInfo');
  if (!info) {
    return [
      pick('Hex で何ができるの？', 'What can Hex do?'),
      pick('解析の始め方を教えて', 'How do I start an investigation?'),
    ];
  }
  return [
    pick('この関数は何をしている？', 'What does this function do?'),
    pick('コインが増える処理はどこ？', 'Where do coins increase?'),
    pick('セーブしている場所を探して', 'Find where the game saves'),
  ];
}

export function installAssistant(app, ui) {
  if (!app || typeof document === 'undefined') return null;
  if (document.getElementById('ai-launcher')) return window.__hexAi || null;

  const engine = createAiEngine(app);
  const session = new AiSession({ engine });
  let open = false;
  let unread = 0;

  /* Bound after the instance exists: an action may collapse the panel it was
     dispatched from, so the runner needs the finished assistant, not a half
     constructed one. */
  let runAction = () => {};

  const handlers = {
    onMode(mode) { session.setMode(mode); panel.update({ stick: false }); },
    onStyle(style) { session.setStyle(style); panel.update({ stick: false }); },
    onScope(scope) { session.setScope(scope); panel.update({ stick: false }); },
    onClose() { close(); },
    onCancel() { session.cancel(); },
    onAsk(question) {
      /* Refuse rather than silently swallow: the composer keeps the text. */
      if (session.busy) { toast(pick('いまの回答が終わってからにしてください。', 'Wait for the current answer to finish.')); return false; }
      ask(question);
      return true;
    },
    onRetry() { session.retry({ context: workbenchContext(app) }); },
    onFollowup(text) { ask(text); },
    onTerm(id) { showTerm(app, id); },
    onAction(action) { runAction(action); },
    onVerify(hypothesis) {
      ask(pick(`次の仮説を確かめてください: ${hypothesis.claim}`, `Verify this hypothesis: ${hypothesis.claim}`), { mode: 'agent' });
    },
    onContextTap() {
      const context = workbenchContext(app);
      if (context.function && context.function.addressValue != null) {
        runAction({ kind: 'open-function', address: context.function.addressValue, target: context.function.address });
      }
    },
    contextLabel() {
      const context = workbenchContext(app);
      if (!context.binary) return { label: pick('ファイル未選択', 'No file open'), actionable: false };
      if (context.selection) return { label: context.selection.address + ' · ' + (context.selection.text || ''), actionable: true };
      if (context.function) return { label: context.function.name, actionable: true };
      return { label: context.binary.name, actionable: false };
    },
    proposalsFor(response) {
      const store = engine.proposals();
      if (!store) return [];
      const nodes = [];
      for (const action of response.actions) {
        if (action.kind !== 'review-proposal' || !action.target) continue;
        const proposal = typeof store.get === 'function' ? store.get(action.target) : null;
        if (!proposal) continue;
        nodes.push(renderProposal(proposal, {
          onApply: (item) => applyProposal(item),
          onReject: (item) => { try { store.reject(item.id); } catch { /* already settled */ } },
        }));
      }
      return nodes;
    },
  };

  const panel = createPanel({ session, handlers });
  const launcher = createLauncher({ onToggle: () => (open ? close() : openPanel()) });
  panel.setSuggestions(suggestionsFor(app));

  const root = uiRoot();
  const host = root === document.documentElement ? document.body : root;
  host.append(panel.root, launcher.root);

  /* ── proposals ────────────────────────────────────────── */
  async function applyProposal(proposal) {
    // `proposals()` is an established UI/test integration seam. Pass the
    // currently exposed store explicitly so custom persistence adapters keep
    // the same approval semantics as AIRuntime-owned stores.
    const executor = engine.proposalExecutor?.(engine.proposals?.());
    if (!executor) throw new Error(pick('提案を適用できる状態ではありません。', 'No proposal executor is available.'));
    await executor.approveAndApply(proposal.id);
    toast(pick('変更を適用しました', 'Change applied'));
  }

  /* ── open / close ─────────────────────────────────────── */
  function applyLayout() {
    const layout = layoutFor(window.innerWidth);
    panel.root.dataset.layout = layout;
    if (layout === 'dock') {
      panel.root.removeAttribute('aria-modal');
      panel.root.removeAttribute('role');
      panel.root.setAttribute('role', 'complementary');
    } else if (open) {
      panel.root.setAttribute('role', 'dialog');
      panel.root.setAttribute('aria-modal', 'true');
    }
    uiRoot()?.classList.toggle('ai-docked', open && layout === 'dock');
  }

  function openPanel({ focus = true } = {}) {
    if (open) return;
    open = true;
    unread = 0;
    launcher.setUnread(0);
    panel.root.hidden = false;
    uiRoot()?.classList.add('ai-open');
    applyLayout();
    launcher.setOpen(true);
    panel.update();
    if (focus) requestAnimationFrame(() => panel.focusComposer());
  }

  function close() {
    if (!open) return;
    open = false;
    panel.root.hidden = true;
    uiRoot()?.classList.remove('ai-open', 'ai-docked');
    launcher.setOpen(false);
    launcher.root.focus({ preventScroll: true });
  }

  function ask(question, options = {}) {
    if (!open) openPanel({ focus: false });
    if (options.mode) session.setMode(options.mode);
    if (options.style) session.setStyle(options.style);
    if (options.scope) session.setScope(options.scope);
    panel.update({ stick: false });
    return session.ask(question, { context: workbenchContext(app) });
  }

  session.on((event) => {
    if (event.type === 'settled') {
      launcher.setState('idle');
      if (!open) { unread += 1; launcher.setUnread(unread); launcher.setState('attention'); }
    } else if (event.type === 'turn') {
      launcher.setState('running');
    }
    panel.update();
  });

  /*
   * Escape closes one thing at a time, innermost first.
   *
   * This runs in the capture phase so it can see a transient menu or sheet
   * that the app's own bubble-phase handler is about to close: without that
   * ordering, dismissing a scope menu also closed the panel behind it.
   */
  const onKey = (event) => {
    if (event.key !== 'Escape' || !open) return;
    if (document.querySelector('#overlays .sheet, #overlays .menu, #overlays .dialog')) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);

  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyLayout, 100);
  };
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });

  /* Keep the context chip honest as the user navigates the code. */
  const unsubscribe = typeof app.store.subscribe === 'function'
    ? app.store.subscribe(() => { if (open) panel.update({ stick: false }); })
    : null;

  function api() {
    return {
      session,
      panel,
      launcher,
      engine,
      open: () => openPanel(),
      close,
      collapse: () => { if (window.innerWidth < DOCK_MIN_WIDTH) close(); },
      toggle: () => (open ? close() : openPanel()),
      isOpen: () => open,
      ask,
      focusProposal: (id) => { openPanel({ focus: false }); panel.scrollToProposal(id); },
      contextFor: () => workbenchContext(app),
      refresh: () => { panel.setSuggestions(suggestionsFor(app)); panel.update({ stick: false }); },
      destroy() {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
        if (unsubscribe) unsubscribe();
        panel.root.remove();
        launcher.destroy();
        uiRoot()?.classList.remove('ai-open', 'ai-docked');
        if (window.__hexAi && window.__hexAi.panel === panel) delete window.__hexAi;
      },
    };
  }

  const instance = api();
  runAction = createActionRunner(app, { ui, assistant: instance });
  launcher.setState('idle');
  panel.root.dataset.locale = isJa() ? 'ja' : 'en';
  window.__hexAi = instance;
  return instance;
}

export default installAssistant;
