/* Answer prose -> DOM. Text only: no HTML from a model ever reaches innerHTML. */
import { h } from '../../ui/primitives.js';

function segments(parent, list) {
  for (const segment of list) {
    if (segment.t === 'code') parent.append(h('code', 'ai-inline-code mono', segment.v));
    else if (segment.t === 'strong') parent.append(h('strong', null, segment.v));
    else parent.append(document.createTextNode(segment.v));
  }
}

/**
 * @param {Array} blocks output of normalize.parseAnswer
 * @returns {HTMLElement}
 */
export function renderAnswer(blocks) {
  const root = h('div', 'ai-answer');
  for (const block of blocks || []) {
    if (block.type === 'heading') {
      root.append(h('h3', 'ai-answer-heading', block.text));
      continue;
    }
    if (block.type === 'code') {
      const pre = h('pre', 'ai-answer-code mono');
      pre.tabIndex = 0;
      pre.textContent = block.text;
      root.append(pre);
      continue;
    }
    if (block.type === 'bullets') {
      const list = h('ul', 'ai-answer-list');
      for (const item of block.items) {
        const li = h('li');
        segments(li, item);
        list.append(li);
      }
      root.append(list);
      continue;
    }
    const p = h('p', 'ai-answer-p');
    segments(p, block.segments || []);
    root.append(p);
  }
  return root;
}

export default renderAnswer;
