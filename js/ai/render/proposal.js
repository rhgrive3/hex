/*
 * Proposal approval.
 *
 * Reads are free; writes are not. Any change to project state (a name, a
 * comment, a type, a patch) is rendered as a before/after with its reason and
 * evidence, and nothing is applied until the user presses Apply on this card.
 * The card owns its own busy/º result state so an approval cannot be
 * double-submitted by an impatient second tap.
 */
import { h, uiButton } from '../../ui/primitives.js';
import { pick } from '../../i18n.js';

const KIND_LABEL = {
  rename: ['名前の変更', 'Rename'],
  comment: ['メモの追加', 'Comment'],
  type: ['型の変更', 'Type change'],
  'struct-field': ['構造体フィールド', 'Struct field'],
  patch: ['命令の書き換え', 'Patch'],
  'project-annotation': ['プロジェクト注釈', 'Project annotation'],
};

function kindLabel(kind) {
  const item = KIND_LABEL[kind];
  return item ? pick(item[0], item[1]) : kind;
}

function valueText(value) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * @param {object} proposal core proposal record {id, kind, target, before, after, reason, evidenceIds, status}
 * @param {{onApply: function, onReject: function}} handlers
 */
export function renderProposal(proposal, { onApply, onReject } = {}) {
  const root = h('article', 'ai-proposal');
  root.dataset.proposal = proposal.id;
  root.dataset.status = proposal.status || 'pending';
  root.append(h('h3', 'ai-block-title', pick('変更の提案', 'Proposed change') + ' · ' + kindLabel(proposal.kind)));

  const diff = h('dl', 'ai-proposal-diff');
  diff.append(h('dt', null, pick('いま', 'Current')), h('dd', 'mono', valueText(proposal.before)));
  diff.append(h('dt', null, pick('提案', 'Proposed')), h('dd', 'mono strong', valueText(proposal.after)));
  root.append(diff);

  if (proposal.reason) root.append(h('p', 'ai-proposal-reason', proposal.reason));
  const evidenceCount = (proposal.evidenceIds || []).length;
  root.append(h('p', 'ai-proposal-evidence', pick(`根拠 ${evidenceCount} 件`, `${evidenceCount} supporting evidence`)));

  const status = h('p', 'ai-proposal-status');
  status.setAttribute('role', 'status');
  const actions = h('div', 'ai-proposal-actions');
  const apply = uiButton(pick('適用する', 'Apply'), { cls: 'ai-chip primary' });
  const reject = uiButton(pick('却下', 'Reject'), { cls: 'ai-chip' });

  const settle = (text, state) => {
    root.dataset.status = state;
    apply.disabled = true;
    reject.disabled = true;
    status.textContent = text;
  };

  apply.addEventListener('click', async () => {
    apply.disabled = true;
    reject.disabled = true;
    status.textContent = pick('適用しています…', 'Applying…');
    try {
      await onApply(proposal);
      settle(pick('適用しました', 'Applied'), 'applied');
    } catch (error) {
      root.dataset.status = 'failed';
      status.textContent = pick('適用できませんでした: ', 'Could not apply: ') + String((error && error.message) || error);
      reject.disabled = false;
    }
  });
  reject.addEventListener('click', () => {
    try { if (onReject) onReject(proposal); } catch { /* rejection is local state only */ }
    settle(pick('却下しました', 'Rejected'), 'rejected');
  });

  actions.append(apply, reject);
  root.append(actions, status);
  return root;
}

export default renderProposal;
