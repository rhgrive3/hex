/*
 * Evidence cards.
 *
 * Evidence is separated from the prose because a claim and its proof have
 * different lifetimes: the sentence is read once, the proof is navigated.
 * Only the first few are rendered; the rest stay behind one disclosure so a
 * 100-item list never becomes 100 DOM nodes on an iPad.
 */
import { h, uiButton } from '../../ui/primitives.js';
import { pick } from '../../i18n.js';
import { statusPill } from './status.js';

const HEAD_COUNT = 3;
const MAX_RENDERED = 40;

function evidenceCard(item, { onAction }) {
  const card = h('article', 'ai-evidence');
  card.dataset.status = item.status;
  const head = h('div', 'ai-evidence-head');
  const where = item.address || item.functionAddress;
  if (where) head.append(h('span', 'ai-evidence-addr mono', where));
  head.append(statusPill(item.status, { detail: item.title }));
  card.append(head);

  card.append(h('p', 'ai-evidence-title', item.title));
  if (item.summary) card.append(h('p', 'ai-evidence-summary', item.summary));
  if (item.code) {
    const code = h('code', 'ai-evidence-code mono', item.code);
    card.append(code);
  }
  const tail = h('div', 'ai-evidence-actions');
  if (item.addressValue != null) {
    tail.append(uiButton(pick('命令へ', 'Go to instruction'), {
      cls: 'ai-chip', onClick: () => onAction({ kind: 'open-address', address: item.addressValue, target: item.address }),
    }));
  }
  if (item.functionAddressValue != null) {
    tail.append(uiButton(pick('関数を開く', 'Open function'), {
      cls: 'ai-chip', onClick: () => onAction({ kind: 'open-function', address: item.functionAddressValue, target: item.functionAddress }),
    }));
    tail.append(uiButton(pick('参照元', 'Xrefs'), {
      cls: 'ai-chip', onClick: () => onAction({ kind: 'show-xrefs', address: item.functionAddressValue, target: item.functionAddress }),
    }));
  }
  if (tail.childNodes.length) card.append(tail);
  if (item.sourceTool) {
    card.append(h('p', 'ai-evidence-source', pick('出どころ: ', 'Source: ') + item.sourceTool));
  }
  return card;
}

/**
 * @param {Array} evidence normalized evidence items
 * @param {{onAction: function}} handlers
 * @returns {HTMLElement|null}
 */
export function renderEvidence(evidence, handlers) {
  const items = Array.isArray(evidence) ? evidence : [];
  if (!items.length) return null;
  const root = h('section', 'ai-evidence-block');
  root.append(h('h3', 'ai-block-title', pick('根拠', 'Evidence')));
  for (const item of items.slice(0, HEAD_COUNT)) root.append(evidenceCard(item, handlers));
  const rest = items.slice(HEAD_COUNT, MAX_RENDERED);
  if (!rest.length) {
    if (items.length > MAX_RENDERED) root.append(h('p', 'ai-note', pick(`ほか ${items.length - MAX_RENDERED} 件`, `${items.length - MAX_RENDERED} more`)));
    return root;
  }
  const more = h('details', 'ai-more');
  const summary = h('summary', null, pick(`根拠をあと ${rest.length} 件見る`, `Show ${rest.length} more`));
  more.append(summary);
  let filled = false;
  more.addEventListener('toggle', () => {
    if (!more.open || filled) return;
    filled = true;
    for (const item of rest) more.append(evidenceCard(item, handlers));
    if (items.length > MAX_RENDERED) more.append(h('p', 'ai-note', pick(`ほか ${items.length - MAX_RENDERED} 件は省略`, `${items.length - MAX_RENDERED} further items omitted`)));
  });
  root.append(more);
  return root;
}

export default renderEvidence;
