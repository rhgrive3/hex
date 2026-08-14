/*
 * Omnibox intent classification.
 *
 * One field replaces the old search / jump / command / question split. The
 * rules stay small and predictable on purpose: a user must be able to guess
 * what pressing Enter will do before pressing it.
 *
 *   0x100458c00        -> address
 *   sub_100458C00      -> symbol
 *   "reward"           -> string
 *   > rename           -> command
 *   ? コインはどこで増える -> ai
 *   reward             -> search (symbol + string index)
 *
 * Pure module — no DOM. Tested by tests/ai-ui-omnibox.mjs.
 */

export const KINDS = Object.freeze(['empty', 'address', 'symbol', 'string', 'command', 'ai', 'search']);

export const COMMANDS = Object.freeze([
  { id: 'code', ja: 'コードを開く', en: 'Open code', match: /^(code|コード|asm|アセンブリ)$/i },
  { id: 'explorer', ja: '索引を開く', en: 'Open explorer', match: /^(index|explorer|索引|一覧)$/i },
  { id: 'results', ja: '結果を開く', en: 'Open results', match: /^(results?|結果)$/i },
  { id: 'settings', ja: '設定', en: 'Settings', match: /^(settings?|setting|設定|環境設定)$/i },
  { id: 'help', ja: 'ヘルプ', en: 'Help', match: /^(help|ヘルプ|使い方)$/i },
  { id: 'learn', ja: '学ぶ', en: 'Learn', match: /^(learn|学ぶ|学習)$/i },
  { id: 'advanced', ja: '高度な機能', en: 'Advanced', match: /^(advanced|lab|高度)$/i },
  { id: 'ai', ja: 'AIに聞く', en: 'Ask AI', match: /^(ai|ask|聞く|質問)$/i },
  { id: 'agent', ja: 'エージェントで調べる', en: 'Investigate with Agent', match: /^(agent|investigate|調査|調べる)$/i },
]);

const HAS_JA = /[぀-ヿ㐀-鿿]/;
const QUESTION_TAIL = /[?？]\s*$/;
const JA_QUESTION = /(どこ|どれ|なに|何|なぜ|どうやって|教えて|ですか|でしょうか|してる|している|したい|探して|調べて)/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:(?:::|\.|->)[\w$]+)*$/;
const OBJC_METHOD = /^[+-]\s*\[[^\]]+\]$/;

function stripPrefix(value, re) {
  return value.replace(re, '').trim();
}

/**
 * @param {string} input raw omnibox text
 * @returns {{kind:string, value:string, raw:string, command?:string}}
 */
export function classifyOmnibox(input) {
  const raw = String(input == null ? '' : input);
  const value = raw.trim();
  if (!value) return { kind: 'empty', value: '', raw };

  if (/^[?？]/.test(value)) {
    const q = stripPrefix(value, /^[?？]+\s*/);
    return q ? { kind: 'ai', value: q, raw } : { kind: 'empty', value: '', raw };
  }
  if (/^[>＞]/.test(value)) {
    const body = stripPrefix(value, /^[>＞]+\s*/);
    const hit = COMMANDS.find((command) => command.match.test(body));
    return { kind: 'command', value: body, command: hit ? hit.id : null, raw };
  }
  const quoted = /^["'“”「](.*)["'“”」]$/.exec(value);
  if (quoted) return { kind: 'string', value: quoted[1], raw };

  if (/^0[xX][0-9a-fA-F]+$/.test(value) || /^[0-9a-fA-F]{6,16}$/.test(value)) {
    return { kind: 'address', value, raw };
  }
  if (/^sub_[0-9a-fA-F]+$/i.test(value) || OBJC_METHOD.test(value)) {
    return { kind: 'symbol', value, raw };
  }

  const words = value.split(/\s+/);
  const naturalLanguage = QUESTION_TAIL.test(value)
    || (HAS_JA.test(value) && (JA_QUESTION.test(value) || value.length >= 8))
    || words.length >= 4;
  if (naturalLanguage) return { kind: 'ai', value, raw };

  if (words.length === 1 && IDENTIFIER.test(value) && (/[_$]|::|\./.test(value) || value.length >= 12)) {
    return { kind: 'symbol', value, raw };
  }
  return { kind: 'search', value, raw };
}

/** Short label describing what Enter will do. Used by the omnibox hint chip. */
export function intentLabel(kind, ja = true) {
  switch (kind) {
    case 'address': return ja ? 'アドレスへ移動' : 'Go to address';
    case 'symbol': return ja ? 'シンボルを開く' : 'Open symbol';
    case 'string': return ja ? '文字列を探す' : 'Find string';
    case 'command': return ja ? 'コマンド' : 'Command';
    case 'ai': return ja ? 'AIに聞く' : 'Ask AI';
    case 'search': return ja ? '検索' : 'Search';
    default: return '';
  }
}

export default classifyOmnibox;
