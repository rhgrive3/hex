/*
 * Contextual "Ask AI" entries.
 *
 * The instruction menu is already long, so the assistant adds exactly one row
 * to it and keeps its own verbs one level down. Each verb is a real question
 * with the target already filled in — the point of asking from a context menu
 * is not having to describe where you are.
 */
import { menu } from '../../ui.js';
import { pick } from '../../i18n.js';
import { addrHex } from '../../format.js';

function ask(assistant, question, options) {
  assistant.open();
  assistant.ask(question, options);
}

export function instructionAiItems(assistant, { address, text }) {
  const at = address != null ? addrHex(address) : '';
  const asm = text ? '`' + text + '`' : '';
  return [
    {
      label: pick('この命令を説明して', 'Explain this instruction'),
      action: () => ask(assistant, pick(`${at} の命令 ${asm} は何をしていますか？`, `What does the instruction ${asm} at ${at} do?`), { scope: 'selection' }),
    },
    {
      label: pick('この値を追って', 'Trace this value'),
      action: () => ask(assistant, pick(`${at} で扱っている値は、どこから来てどこへ行きますか？`, `Trace the value handled at ${at}: where does it come from and where does it go?`), { scope: 'function' }),
    },
    {
      label: pick('なぜここに来るの？', 'Why is this reached?'),
      action: () => ask(assistant, pick(`${at} に到達する条件を教えてください。`, `Under what conditions is ${at} reached?`), { scope: 'function' }),
    },
  ];
}

export function functionAiItems(assistant, { address, name }) {
  const at = address != null ? addrHex(address) : '';
  const who = name || at;
  return [
    {
      label: pick('この関数は何をしている？', 'What does this function do?'),
      action: () => ask(assistant, pick(`${who} は何をする関数ですか？`, `What does ${who} do?`), { scope: 'function' }),
    },
    {
      label: pick('役割を調べて（エージェント）', 'Investigate purpose (Agent)'),
      action: () => ask(assistant, pick(`${who} の役割を、呼び出し元と書き込み先まで含めて調べてください。`, `Investigate the role of ${who}, including its callers and what it writes.`), { mode: 'agent', scope: 'neighborhood' }),
    },
    {
      label: pick('名前を提案して', 'Suggest a name'),
      action: () => ask(assistant, pick(`${who} にふさわしい名前を、根拠つきで提案してください。`, `Propose a name for ${who} with evidence.`), { scope: 'function' }),
    },
  ];
}

export function stringAiItems(assistant, { text, address }) {
  const at = address != null ? addrHex(address) : '';
  const quoted = '"' + String(text || '').slice(0, 60) + '"';
  return [
    {
      label: pick('この文字列の使われ方', 'How this string is used'),
      action: () => ask(assistant, pick(`文字列 ${quoted}（${at}）を使っているのはどの処理ですか？`, `Which code uses the string ${quoted} (${at})?`), { mode: 'agent', scope: 'binary' }),
    },
  ];
}

export function fieldAiItems(assistant, { label }) {
  return [
    {
      label: pick('このフィールドを書いている場所', 'Who writes this field'),
      action: () => ask(assistant, pick(`${label} に書き込んでいる処理を全部調べてください。`, `Find every routine that writes ${label}.`), { mode: 'agent', scope: 'binary' }),
    },
    {
      label: pick('このフィールドを読んでいる場所', 'Who reads this field'),
      action: () => ask(assistant, pick(`${label} を読んでいる処理を調べてください。`, `Find the routines that read ${label}.`), { mode: 'agent', scope: 'binary' }),
    },
  ];
}

/** One row for a host menu; opens the assistant's own verbs next to it. */
export function askAiMenuItem(assistant, items, position) {
  return {
    label: pick('AI に聞く…', 'Ask AI…'),
    action: () => {
      const x = position && position.x != null ? position.x : window.innerWidth / 2;
      const y = position && position.y != null ? position.y : window.innerHeight / 2;
      menu(items, x, y);
    },
  };
}

export default askAiMenuItem;
