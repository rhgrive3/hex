/*
 * Small interaction layer for the app shell.
 *
 * The analysis engine already exposes many useful entry points. The problem was
 * that they were all wired directly into the toolbar, so a beginner had to
 * understand the tool taxonomy before doing any analysis. Keep the original
 * buttons as the single source of truth for enable/disable state and actions,
 * but group their visible entry points into three jobs:
 *
 *   調べる — start from a human goal
 *   探す   — locate something concrete
 *   解析   — use lower-level / expert tools
 *
 * Delegating to the original buttons also avoids a second copy of App logic.
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

function init() {
  if (document.documentElement.classList.contains('ux-v2')) return;

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
    nav, investigate, tools, functions, search, jump, overflow,
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

  // Keep the goal-driven path visually primary. The two hubs are compact
  // secondary routes for users who already know what kind of object/tool they
  // want. Existing source buttons remain in the DOM and retain App bindings.
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', pick('解析の入口', 'Analysis entry points'));
  nav.append(findHub, analyzeHub);
  for (const source of [tools, functions, search, jump, overflow]) hideSourceAction(source);

  investigate.classList.add('ux-primary');
  investigate.setAttribute('aria-label', pick(
    '目的から調べる — 初めてならここから',
    'Investigate by goal — start here',
  ));

  document.documentElement.classList.add('ux-v2');
}

// app.js is the first module in index.html. Defer one frame so its constructor
// has finished binding the source buttons before this layer groups them.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(init), { once: true });
} else {
  requestAnimationFrame(init);
}
