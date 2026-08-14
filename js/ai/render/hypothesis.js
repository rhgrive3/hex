/*
 * Hypothesis cards (Agent mode).
 *
 * A hypothesis is shown with what supports it, what contradicts it, and what
 * has not been checked — the three together are the whole point. A claim with
 * only supporting bullets is a sales pitch, not an analysis.
 */
import { h, uiButton } from '../../ui/primitives.js';
import { pick } from '../../i18n.js';
import { confidencePill, statusPill } from './status.js';
import { confidenceDisplay } from './normalize.js';
import { missingLabel } from './missing.js';

function checkRow(mark, text, cls) {
  const row = h('li', 'ai-check ' + cls);
  const glyph = h('span', 'ai-check-mark', mark);
  glyph.setAttribute('aria-hidden', 'true');
  row.append(glyph, h('span', 'ai-check-text', text));
  return row;
}

export function renderHypotheses(hypotheses, { onAction, onVerify }) {
  const items = Array.isArray(hypotheses) ? hypotheses : [];
  if (!items.length) return null;
  const root = h('section', 'ai-hypothesis-block');
  root.append(h('h3', 'ai-block-title', pick('仮説', 'Hypotheses')));
  for (const item of items.slice(0, 6)) {
    const card = h('article', 'ai-hypothesis');
    card.dataset.status = item.status;
    const head = h('div', 'ai-hypothesis-head');
    head.append(statusPill(item.status, { detail: item.claim }));
    const confidence = confidencePill(confidenceDisplay({ confidence: item.confidence, status: item.status }));
    if (confidence) head.append(confidence);
    card.append(head, h('p', 'ai-hypothesis-claim', item.claim));

    const checks = h('ul', 'ai-check-list');
    for (const support of item.support.slice(0, 4)) checks.append(checkRow('✓', support.title || support.id, 'yes'));
    for (const against of item.contradictions.slice(0, 4)) checks.append(checkRow('✕', against.title || against.id, 'no'));
    for (const missing of item.missing.slice(0, 4)) checks.append(checkRow('?', missingLabel(missing).label, 'unknown'));
    if (checks.childNodes.length) card.append(checks);

    const actions = h('div', 'ai-hypothesis-actions');
    if (onVerify) {
      actions.append(uiButton(pick('この仮説を確かめる', 'Verify this'), {
        cls: 'ai-chip primary', onClick: () => onVerify(item),
      }));
    }
    for (const action of item.actions || []) {
      actions.append(uiButton(action.label, { cls: 'ai-chip', onClick: () => onAction(action) }));
    }
    if (actions.childNodes.length) card.append(actions);
    root.append(card);
  }
  return root;
}

export default renderHypotheses;
