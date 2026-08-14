/*
 * One conversation turn.
 *
 * Beginner and Analyst are not two skins over the same block order: Beginner
 * leads with the conclusion and the next tap, and keeps proof one disclosure
 * away; Analyst front-loads identity, evidence and cost. Both end in actions,
 * because an answer that leads nowhere is where an investigation stalls.
 */
import { h, uiButton } from '../../ui/primitives.js';
import { pick } from '../../i18n.js';
import { renderAnswer } from './answer.js';
import { renderEvidence } from './evidence.js';
import { renderHypotheses } from './hypothesis.js';
import { renderActivity } from './activity.js';
import { confidencePill } from './status.js';
import { confidenceDisplay } from './normalize.js';
import { decorateTerms } from './terms.js';
import { missingLabel } from './missing.js';

function actionsRow(actions, handlers) {
  if (!actions || !actions.length) return null;
  const root = h('div', 'ai-actions');
  root.append(h('span', 'ai-actions-label', pick('次にできること', 'Next')));
  const row = h('div', 'ai-actions-row');
  for (const action of actions) {
    row.append(uiButton(action.label, { cls: 'ai-chip primary', onClick: () => handlers.onAction(action) }));
  }
  root.append(row);
  return root;
}

function followupsRow(followups, handlers) {
  if (!followups || !followups.length) return null;
  const root = h('div', 'ai-followups');
  root.append(h('span', 'ai-actions-label', pick('未確認・追加で調べる', 'Open questions')));
  const row = h('div', 'ai-actions-row');
  for (const text of followups) {
    const item = missingLabel(text);
    if (!item.label) continue;
    row.append(uiButton(item.label, { cls: 'ai-chip', onClick: () => handlers.onFollowup(item.ask) }));
  }
  root.append(row);
  return root;
}

function usageLine(response) {
  const usage = response.usage;
  if (!usage) return null;
  const parts = [];
  if (Number.isFinite(usage.toolCalls)) parts.push(usage.toolCalls + pick(' ツール', ' tools'));
  if (Number.isFinite(usage.candidateCount)) parts.push(usage.candidateCount + pick(' 候補', ' candidates'));
  if (Number.isFinite(usage.analyzedFunctions)) parts.push(usage.analyzedFunctions + pick(' 関数を解析', ' functions analysed'));
  if (Number.isFinite(usage.elapsedMs)) parts.push((usage.elapsedMs / 1000).toFixed(1) + 's');
  if (!parts.length) return null;
  return h('p', 'ai-usage', parts.join(' · '));
}

function limitLine(response) {
  const limits = response.limits;
  if (!limits || !limits.exhausted) return null;
  return h('p', 'ai-limit', pick('予算上限で調査を打ち切りました: ', 'Investigation stopped at its budget: ') + (limits.reason || ''));
}

export function renderUserTurn(turn) {
  const root = h('article', 'ai-turn ai-turn-user');
  root.append(h('p', 'ai-turn-text', turn.text));
  return root;
}

/**
 * @param {object} turn session turn
 * @param {{onAction:function,onFollowup:function,onRetry:function,onVerify:function,proposalsFor:function}} handlers
 */
export function renderAssistantTurn(turn, handlers) {
  const root = h('article', 'ai-turn ai-turn-assistant');
  root.dataset.status = turn.status;
  root.dataset.mode = turn.mode;
  root.dataset.style = turn.style;

  const running = turn.status === 'running';
  if (turn.mode === 'agent' || running) {
    const activity = renderActivity(turn.activity, { running });
    if (activity) root.append(activity);
  }

  if (running && turn.text) root.append(renderAnswer([{ type: 'p', segments: [{ t: 'text', v: turn.text }] }]));

  if (turn.status === 'error') {
    const error = h('div', 'ai-error');
    error.setAttribute('role', 'alert');
    error.append(h('p', null, pick('答えを出せませんでした。', 'The answer could not be produced.')));
    error.append(h('p', 'ai-error-detail mono', turn.error || ''));
    error.append(uiButton(pick('もう一度', 'Retry'), { cls: 'ai-chip primary', onClick: () => handlers.onRetry(turn) }));
    root.append(error);
    return root;
  }
  if (turn.status === 'cancelled') {
    root.append(h('p', 'ai-note', pick('停止しました。ここまでの結果は残っています。', 'Stopped. What was found so far is kept.')));
    return root;
  }

  const response = turn.response;
  if (!response) return root;
  const analyst = response.style === 'analyst';

  const answer = renderAnswer(response.answer);
  if (!analyst) {
    answer.classList.add('ai-lead');
    /* Beginner style explains the jargon it could not avoid, in place. */
    decorateTerms(answer, { onOpen: handlers.onTerm });
  }
  root.append(answer);

  const meta = h('div', 'ai-turn-meta');
  const confidence = confidencePill(confidenceDisplay({ confidence: response.confidence, status: response.verdict }));
  if (confidence) meta.append(confidence);
  if (analyst) {
    const usage = usageLine(response);
    if (usage) meta.append(usage);
  }
  if (meta.childNodes.length) root.append(meta);

  const limit = limitLine(response);
  if (limit) root.append(limit);

  const hypotheses = renderHypotheses(response.hypotheses, handlers);
  if (hypotheses) root.append(hypotheses);

  const evidence = renderEvidence(response.evidence, handlers);
  if (evidence) {
    if (analyst) root.append(evidence);
    else {
      const wrap = h('details', 'ai-more ai-evidence-fold');
      wrap.append(h('summary', null, pick(`なぜそう言えるか（根拠 ${response.evidence.length} 件）`, `Why (${response.evidence.length} evidence)`)));
      wrap.append(evidence);
      root.append(wrap);
    }
  }

  const proposals = handlers.proposalsFor ? handlers.proposalsFor(response) : [];
  for (const node of proposals) root.append(node);

  const actions = actionsRow(response.actions, handlers);
  if (actions) root.append(actions);
  const followups = followupsRow(response.followups, handlers);
  if (followups) root.append(followups);

  if (response.unknownFields.length) {
    root.append(h('p', 'ai-note', pick('この回答には、この画面がまだ表示できない項目が含まれています: ', 'This answer carries fields this build cannot render yet: ') + response.unknownFields.join(', ')));
  }
  return root;
}

export function renderTurn(turn, handlers) {
  return turn.role === 'user' ? renderUserTurn(turn) : renderAssistantTurn(turn, handlers);
}

export default renderTurn;
