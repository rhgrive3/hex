/*
 * Status pill.
 *
 * State is carried by a glyph and a word as well as colour, so the four
 * evidence states stay distinguishable without colour vision, in high
 * contrast mode, and in a screenshot pasted into a bug report.
 */
import { h } from '../../ui/primitives.js';
import { statusMark, statusText } from './normalize.js';

export function statusPill(status, { ja = true, detail } = {}) {
  const node = h('span', 'ai-status ai-status-' + status);
  node.dataset.status = status;
  const mark = h('span', 'ai-status-mark', statusMark(status));
  mark.setAttribute('aria-hidden', 'true');
  node.append(mark, h('span', 'ai-status-label', statusText(status, ja)));
  node.setAttribute('aria-label', statusText(status, ja) + (detail ? ': ' + detail : ''));
  return node;
}

/** Stars for a model/rank score; a percentage only for a fused probability. */
export function confidencePill(display, { ja = true } = {}) {
  if (!display) return null;
  const node = h('span', 'ai-confidence');
  const stars = h('span', 'ai-confidence-stars', '★'.repeat(display.stars) + '☆'.repeat(Math.max(0, 5 - display.stars)));
  stars.setAttribute('aria-hidden', 'true');
  node.append(stars);
  const label = display.percent == null
    ? (ja ? '確度 ' : 'confidence ') + display.stars + '/5'
    : display.percent + '%';
  node.append(h('span', 'ai-confidence-text', label));
  node.setAttribute('aria-label', (ja ? '確からしさ: ' : 'Confidence: ') + label);
  return node;
}

export default statusPill;
