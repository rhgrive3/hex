/*
 * Agent activity.
 *
 * What is shown: which step ran and what it found. What is never shown: the
 * model's reasoning. Consecutive events with the same label collapse into one
 * row so a long investigation reads as four lines, not forty.
 */
import { h } from '../../ui/primitives.js';
import { pick } from '../../i18n.js';

export function collapseActivity(activity) {
  const out = [];
  for (const item of activity || []) {
    const last = out[out.length - 1];
    if (last && last.label === item.label) {
      last.detail = item.detail || last.detail;
      last.state = item.state || last.state;
      last.error = item.error || last.error;
      continue;
    }
    out.push({ ...item });
  }
  return out;
}

export function renderActivity(activity, { running = false } = {}) {
  const items = collapseActivity(activity);
  if (!items.length && !running) return null;
  const root = h('section', 'ai-activity');
  root.setAttribute('aria-live', 'polite');
  const list = h('ol', 'ai-activity-list');
  for (const item of items.slice(-8)) {
    const row = h('li', 'ai-activity-row' + (item.error ? ' error' : ''));
    row.append(h('span', 'ai-activity-label', item.label));
    if (item.detail) row.append(h('span', 'ai-activity-detail', item.detail));
    list.append(row);
  }
  if (running) {
    const row = h('li', 'ai-activity-row running');
    const spinner = h('span', 'ai-activity-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    row.append(spinner, h('span', 'ai-activity-label', pick('調べています…', 'Working…')));
    list.append(row);
  }
  root.append(list);
  return root;
}

export default renderActivity;
