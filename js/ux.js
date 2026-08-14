/*
 * Small interaction layer for the app shell.
 *
 * Keep the analysis engine and its original buttons as the source of truth,
 * while making the shell easier to use on touch devices and for first-time
 * users. This layer owns presentation only; it delegates actual actions back
 * to the existing App bindings.
 */

import { menu } from './ui.js';
import { pick } from './i18n.js';

const $ = (id) => document.getElementById(id);

function menuItem(button) {
  return {
    label: button.textContent,
    disabled: button.disabled,
    action: () => button.click(),
  };
}

function makeHub(id, label, sourceButtons, { strong = false } = {}) {
  const b = document.createElement('button');
  b.id = id;
  b.type = 'button';
  b.className = 'tb-btn nav-item ux-hub' + (strong ? ' strong' : '');
  b.textContent = label();
  b.setAttribute('aria-haspopup', 'menu');

  const sync = () => {
    b.disabled = sourceButtons.every((source) => source.disabled);
    b.textContent = label();
  };

  b.addEventListener('click', (e) => {
    if (b.disabled) return;
    const r = e.currentTarget.getBoundingClientRect();
    menu(sourceButtons.map(menuItem), r.left + r.width / 2, r.bottom + 2);
  });

  const observer = new MutationObserver(sync);
  for (const source of sourceButtons) {
    observer.observe(source, {
      attributes: true,
      attributeFilter: ['disabled'],
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
  sync();
  return b;
}

function hideSourceAction(button) {
  button.classList.add('ux-source-action');
  button.setAttribute('aria-hidden', 'true');
  button.tabIndex = -1;
}

function configureEmptyState(app, empty) {
  const title = empty.querySelector('.empty-title');
  const text = empty.querySelector('.empty-text');
  const note = empty.querySelector('.empty-note');
  const actions = empty.querySelector('.empty-actions');
  const open = $('btn-open-2');
  const sample = $('btn-sample');
  const learn = $('btn-learn-2');

  if (!title || !text || !note || !actions || !open || !sample || !learn) return;

  // Opening a real file is the primary job. The sample is useful, but it must
  // never push the actual file picker below the first viewport on iPad Safari.
  if (actions.firstElementChild !== open) actions.insertBefore(open, actions.firstElementChild);
  open.classList.remove('btn-secondary');
  open.classList.add('btn-primary');
  sample.classList.remove('btn-primary');
  sample.classList.add('btn-secondary');

  const refreshCopy = () => {
    title.textContent = pick('解析するファイルを開く', 'Open a file to analyse');
    text.textContent = pick(
      'Mach-O / ARM64 の実行ファイルや生バイナリを読み込み、命令・関数・文字列・参照関係を確認できます。\n解析はこの端末内で完結します。',
      'Open a Mach-O / ARM64 executable or raw binary to inspect instructions, functions, strings, and references.\nAnalysis stays on this device.',
    );
    open.textContent = pick('ファイルを開く…', 'Open file…');
    sample.textContent = pick('サンプルを開く', 'Open sample');
    learn.textContent = pick('使い方を見る', 'View guide');
    note.textContent = pick('試すだけならサンプルを開けます。', 'Use the sample if you only want to try the interface.');
  };

  const syncState = () => app.classList.toggle('empty-state', !empty.hidden);
  const emptyObserver = new MutationObserver(syncState);
  emptyObserver.observe(empty, { attributes: true, attributeFilter: ['hidden'] });

  // app.js localises first; MutationObserver runs afterwards, so this copy stays
  // in sync when the user changes language without duplicating App state.
  const langObserver = new MutationObserver(refreshCopy);
  langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  refreshCopy();
  syncState();
}

function init() {
  if (document.documentElement.classList.contains('ux-v2')) return;

  const app = $('app');
  const empty = $('empty');
  const nav = document.querySelector('.workspace-nav');
  const investigate = $('btn-investigate');
  const tools = $('btn-tools');
  const functions = $('btn-functions');
  const search = $('btn-search');
  const jump = $('btn-jump');
  const overflow = $('btn-overflow');
  const strings = $('btn-strings');
  const sections = $('btn-sections');
  const struct = $('btn-struct');
  const select = $('btn-select');

  const required = [
    app, empty, nav, investigate, tools, functions, search, jump, overflow,
    strings, sections, struct, select,
  ];
  if (required.some((node) => !node)) return;

  const findHub = makeHub(
    'btn-find-hub',
    () => pick('探す', 'Find'),
    [search, functions, strings, jump],
  );
  const analyzeHub = makeHub(
    'btn-analyze-hub',
    () => pick('解析', 'Analyze'),
    [tools, sections, struct, select],
  );

  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', pick('解析の入口', 'Analysis entry points'));
  nav.append(findHub, analyzeHub);
  for (const source of [tools, functions, search, jump, overflow]) hideSourceAction(source);

  investigate.classList.add('ux-primary');
  investigate.setAttribute('aria-label', pick(
    '目的から調べる — 初めてならここから',
    'Investigate by goal — start here',
  ));

  configureEmptyState(app, empty);
  document.documentElement.classList.add('ux-v2');
}

// app.js is the first module in index.html. Defer one frame so its constructor
// has finished binding source buttons and applying the selected language.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(init), { once: true });
} else {
  requestAnimationFrame(init);
}
