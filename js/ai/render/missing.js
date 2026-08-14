/*
 * "What is still missing", in words.
 *
 * The planner and the AI core report open questions as machine codes
 * (`no-runtime-or-causal-verification`, `entity`, `timeout`). Those are the
 * honest content of a follow-up chip, but a chip labelled "entity" that sends
 * the word "entity" back as a question is worse than no chip at all.
 *
 * Each known code gets two strings: what is missing, and the question that
 * would resolve it. Anything that does not look like a code is already a
 * sentence from the model and passes through untouched.
 */
import { pick } from '../../i18n.js';
import { missingText } from '../../narrate.js';

const CODE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function entry(labelJa, labelEn, askJa, askEn) {
  return { label: pick(labelJa, labelEn), ask: pick(askJa, askEn) };
}

const TABLE = {
  entity: entry('調べる対象がはっきりしていません', 'The subject is unclear',
    '何の値について調べればよいか、具体例を挙げて聞き直したいです', 'Ask me which value to investigate, with examples'),
  action: entry('どんな動作を探すのかが決まっていません', 'The behaviour to look for is unclear',
    '増える・減る・保存するなど、どの動作を探すべきか整理して', 'Help me narrow down which behaviour to look for'),
  'no-candidate-function': entry('候補になる関数が見つかっていません', 'No candidate function was found',
    '別の手がかり（文字列や定数）から候補を探して', 'Look for candidates from other clues such as strings or constants'),
  'no-verified-candidate': entry('確認できた候補がありません', 'No candidate is verified yet',
    '候補を 1 つに絞るために、あと何を調べればよいか教えて', 'Tell me what else to check to narrow this to one candidate'),
  'no-runtime-or-causal-verification': entry('値の更新経路が未確認です', 'The update path is not verified',
    'この候補の更新経路をたどって確かめて', 'Trace and verify the update path for this candidate'),
  'no-deterministic-evidence': entry('Hex が確認できた根拠がまだありません', 'Hex has confirmed no evidence yet',
    '確認できる根拠が取れる場所から調べ直して', 'Restart from somewhere that can produce confirmable evidence'),
  'disassembly-budget': entry('解析量の上限で打ち切りました', 'Stopped at the disassembly budget',
    '範囲を絞ってもう一度調べて', 'Investigate again with a narrower scope'),
  'function-budget': entry('調べた関数の数が上限に達しました', 'Stopped at the function budget',
    '候補を絞ってもう一度調べて', 'Investigate again with fewer candidates'),
  'tool-call-budget': entry('ツール実行の上限に達しました', 'Stopped at the tool-call budget',
    '手順を絞ってもう一度調べて', 'Investigate again with fewer steps'),
  'model-call-budget': entry('思考の回数が上限に達しました', 'Stopped at the model-call budget',
    '質問を分けてもう一度聞きたいです', 'Split the question and ask again'),
  'repeated-tool-loop': entry('同じ調べ方を繰り返したため止めました', 'Stopped after repeating the same step',
    '別の角度から調べ直して', 'Investigate this from a different angle'),
  timeout: entry('時間の上限で打ち切りました', 'Stopped at the time limit',
    '範囲を絞ってもう一度調べて', 'Investigate again with a narrower scope'),
  cancelled: entry('途中で停止しました', 'Stopped by request',
    '続きから調べて', 'Continue the investigation'),
  'provider_error': entry('AI サービスに接続できませんでした', 'The AI service was unreachable',
    'もう一度試して', 'Try again'),
  'budget_exhausted': entry('解析の予算に達しました', 'The investigation budget ran out',
    '範囲を絞ってもう一度調べて', 'Investigate again with a narrower scope'),
};

/**
 * @param {string} value a missing-evidence code or a sentence from the model
 * @returns {{label: string, ask: string, code: string|null}}
 */
export function missingLabel(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { label: '', ask: '', code: null };
  if (!CODE.test(text)) return { label: text, ask: text, code: null };
  const known = TABLE[text];
  if (known) return { ...known, code: text };
  const narrated = missingText(text);
  if (narrated) return { label: narrated, ask: narrated, code: text };
  /* An unknown code is still shown — hiding it would hide the uncertainty —
     but it is marked as raw so it never reads as a finished sentence. */
  return { label: pick('未確認: ', 'Unresolved: ') + text, ask: pick(`${text} について詳しく教えて`, `Tell me more about ${text}`), code: text };
}

export default missingLabel;
