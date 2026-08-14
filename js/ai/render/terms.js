/*
 * Glossary decoration for Beginner answers.
 *
 * A beginner does not need every term defined — they need the one term that
 * just blocked them. So each term is marked at most once per answer, the
 * definition opens inline under the paragraph instead of over the code, and
 * the whole pass is skipped in Analyst style where it would only add noise.
 *
 * Code spans are never touched: `str w1, [x0]` must stay assembly.
 */
import { GLOSSARY } from '../../glossary.js';
import { h } from '../../ui/primitives.js';
import { pick } from '../../i18n.js';

const MIN_LENGTH = 2;
const MAX_TERMS_PER_ANSWER = 4;

let index = null;

/** Longest-first term list, so 「仮想アドレス」 wins over 「アドレス」. */
export function termIndex() {
  if (index) return index;
  const entries = [];
  for (const [id, entry] of Object.entries(GLOSSARY)) {
    if (!entry || !entry.term) continue;
    const term = String(entry.term);
    if (term.length < MIN_LENGTH) continue;
    entries.push({ id, term, short: String(entry.short || '') });
  }
  entries.sort((a, b) => b.term.length - a.term.length);
  index = entries;
  return index;
}

function definition(entry, onOpen) {
  const box = h('div', 'ai-term-def');
  box.append(h('strong', 'ai-term-def-name', entry.term));
  box.append(h('span', 'ai-term-def-text', entry.short));
  if (onOpen) {
    const more = h('button', 'ai-term-more', pick('くわしく', 'More'));
    more.type = 'button';
    more.addEventListener('click', () => onOpen(entry.id));
    box.append(more);
  }
  return box;
}

/**
 * Wrap the first occurrence of known terms inside an answer.
 *
 * @param {HTMLElement} root the rendered `.ai-answer`
 * @param {{onOpen?: function}} handlers opens the full glossary entry
 */
export function decorateTerms(root, { onOpen } = {}) {
  if (!root) return 0;
  const entries = termIndex();
  const used = new Set();
  let marked = 0;

  const hosts = root.querySelectorAll('.ai-answer-p, .ai-answer-list li');
  for (const host of hosts) {
    if (marked >= MAX_TERMS_PER_ANSWER) break;
    for (const node of Array.from(host.childNodes)) {
      if (marked >= MAX_TERMS_PER_ANSWER) break;
      if (node.nodeType !== 3) continue; // element children are code/strong: leave them
      const text = node.nodeValue;
      const hit = entries.find((entry) => !used.has(entry.id) && text.includes(entry.term));
      if (!hit) continue;
      const at = text.indexOf(hit.term);
      const before = text.slice(0, at);
      const after = text.slice(at + hit.term.length);
      const button = h('button', 'ai-term', hit.term);
      button.type = 'button';
      button.setAttribute('aria-expanded', 'false');
      button.title = hit.short;
      let box = null;
      button.addEventListener('click', () => {
        if (box) {
          box.remove();
          box = null;
          button.setAttribute('aria-expanded', 'false');
          return;
        }
        box = definition(hit, onOpen);
        host.after(box);
        button.setAttribute('aria-expanded', 'true');
      });
      const fragment = document.createDocumentFragment();
      if (before) fragment.append(document.createTextNode(before));
      fragment.append(button);
      if (after) fragment.append(document.createTextNode(after));
      node.replaceWith(fragment);
      used.add(hit.id);
      marked++;
    }
  }
  return marked;
}

export default decorateTerms;
