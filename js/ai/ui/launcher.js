/*
 * The launcher.
 *
 * One 48px target, bottom-right, above the safe area and clear of the bottom
 * navigation. It is the assistant's entire footprint while closed: no banner,
 * no permanent sidebar, no hero. State is carried by shape and text as well as
 * colour — a ring while working, a dot when there is something unread — and it
 * never flashes or animates on error, because an analyst reading assembly
 * should not be interrupted by a widget.
 */
import { h } from '../../ui/primitives.js';
import { pick } from '../../i18n.js';

const MARK = 'M12 3.2 19.4 7.4v9.2L12 20.8 4.6 16.6V7.4z';

export function createLauncher({ onToggle }) {
  const root = h('button', 'ai-launcher');
  root.type = 'button';
  root.id = 'ai-launcher';
  root.setAttribute('aria-expanded', 'false');
  root.setAttribute('aria-controls', 'ai-panel');
  root.setAttribute('aria-label', pick('AI アシスタントを開く', 'Open AI assistant'));
  root.title = pick('AI アシスタント', 'AI assistant');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ai-launcher-mark');
  const hex = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hex.setAttribute('d', MARK);
  hex.setAttribute('fill', 'none');
  hex.setAttribute('stroke', 'currentColor');
  hex.setAttribute('stroke-width', '1.6');
  hex.setAttribute('stroke-linejoin', 'round');
  const spark = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  spark.setAttribute('d', 'M12 8.6v6.8M9.1 10.3l5.8 3.4M14.9 10.3l-5.8 3.4');
  spark.setAttribute('fill', 'none');
  spark.setAttribute('stroke', 'currentColor');
  spark.setAttribute('stroke-width', '1.6');
  spark.setAttribute('stroke-linecap', 'round');
  svg.append(hex, spark);

  const badge = h('span', 'ai-launcher-badge');
  badge.setAttribute('aria-hidden', 'true');
  root.append(svg, badge);
  root.addEventListener('click', onToggle);

  return {
    root,
    setOpen(open) {
      root.setAttribute('aria-expanded', String(!!open));
      root.setAttribute('aria-label', open
        ? pick('AI アシスタントを閉じる', 'Close AI assistant')
        : pick('AI アシスタントを開く', 'Open AI assistant'));
      root.classList.toggle('open', !!open);
    },
    /** @param {'idle'|'running'|'attention'} state */
    setState(state) {
      root.dataset.state = state;
      if (state === 'running') root.setAttribute('aria-busy', 'true');
      else root.removeAttribute('aria-busy');
    },
    setUnread(count) {
      root.dataset.unread = count > 0 ? String(count) : '';
      badge.textContent = count > 0 ? String(Math.min(9, count)) : '';
    },
    destroy() { root.remove(); },
  };
}

export default createLauncher;
