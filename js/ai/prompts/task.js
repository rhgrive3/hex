/*
 * Dynamic task hints.
 *
 * A single giant prompt that tries to cover every question makes every answer
 * slightly wrong. Instead the composer detects one intent and appends one
 * short hint. Detection is deliberately conservative: when nothing matches
 * clearly the answer is `null` and no hint is appended.
 *
 * Pure module — no DOM, no imports. Tested by tests/ai-prompt-compose.mjs.
 */

export const TASKS = Object.freeze([
  'explain_instruction',
  'explain_function',
  'trace_value',
  'locate_behavior',
  'find_field_writer',
  'understand_string',
  'compare_functions',
  'verify_hypothesis',
  'rename_suggestion',
  'runtime_verification',
  'binary_diff',
]);

const HINTS = Object.freeze({
  explain_instruction: `<task name="explain_instruction">
Explain what this single instruction does to registers, flags, and memory, then what it means in the surrounding routine. Name the operand roles rather than transliterating the mnemonic.
</task>`,

  explain_function: `<task name="explain_function">
Say what the routine is for before describing how it works. Cover its inputs, the state it changes, and its callers when known. Ground each claim in a specific address, field, or call.
</task>`,

  trace_value: `<task name="trace_value">
Follow the value along real data flow: where it is produced, every place it is transformed, and where it is finally stored or consumed. State clearly where the trace stops and why.
</task>`,

  locate_behavior: `<task name="locate_behavior">
The user is looking for code by behaviour, not by name. Work from observable evidence — strings, field writes, call structure, constants — toward a small ranked candidate set, and say what separates the top candidate from the rest.
</task>`,

  find_field_writer: `<task name="find_field_writer">
Identify every routine that writes the field, distinguish read-modify-write from plain assignment, and mark which writers are confirmed by data flow versus merely reachable.
</task>`,

  understand_string: `<task name="understand_string">
Start from who references the string, then explain what that code does with it. A string alone proves a reference, never a behaviour.
</task>`,

  compare_functions: `<task name="compare_functions">
Compare structure and semantics, not text. Report what is the same, what differs, and whether the difference changes behaviour.
</task>`,

  verify_hypothesis: `<task name="verify_hypothesis">
Test the stated hypothesis against evidence. Report supporting evidence, contradicting evidence, and the one check that would settle it. Do not confirm a hypothesis you only failed to disprove.
</task>`,

  rename_suggestion: `<task name="rename_suggestion">
Propose a name that describes what the routine does, justified by evidence. A rename changes project state, so present it as a proposal for approval rather than applying it.
</task>`,

  runtime_verification: `<task name="runtime_verification">
Prefer observed runtime facts over static inference, and label which is which. Say what the observation does and does not prove.
</task>`,

  binary_diff: `<task name="binary_diff">
Compare the two versions by identity and semantics. Report only differences that matter to behaviour, and note where matching is uncertain.
</task>`,
});

const PATTERNS = [
  ['binary_diff', /\b(diff|binary\s*diff|version\s*(compare|diff)|changed between|between versions)\b|差分|バージョン間|前のバージョン/i],
  ['runtime_verification', /\b(run(time)?|execute|emulat|trace at runtime|observe)\b.*\b(verify|check|confirm)\b|実行して(確|試)|動かして(確|試)|実行時に/i],
  ['compare_functions', /\b(compare|difference between|same as)\b.*\b(function|routine|sub_)|比較|どこが違/i],
  ['rename_suggestion', /\b(rename|suggest a? ?name|better name|name this)\b|名前を(付|つ|提案)|命名/i],
  ['verify_hypothesis', /\b(verify|confirm|is it true|prove|check whether)\b|本当に|確かめ|検証/i],
  /* 「書き込んでいる処理」「書き換えている場所」「更新しているのは」。活用は
     追わず、動詞の語幹と直後の名詞だけを見る。 */
  ['find_field_writer', /\b(who|what|which)\b.*\b(writes?|updates?|modifies?)\b|\b(writers?|write to)\b.*\b(field|offset|global|0x[0-9a-f]+)|(書き(込|換|替|出)|書いて|更新して|セットして)[^。？?]{0,8}(処理|場所|関数|コード|命令|の)/i],
  /* 追って / 追える / 追いたい。「追加」に当たらないよう、送り仮名を明示する。 */
  ['trace_value', /\b(trace|follow|where does .* (go|come from)|data ?flow)\b|追[っいえうわ]|たどっ|どこへ行|どこから来|流れを/i],
  ['understand_string', /\b(string|文字列)\b.*\b(used|usage|referenc|where)\b|この文字列|文字列.*(使わ|参照)/i],
  ['locate_behavior', /\b(where|find|locate|which function)\b|どこ|探し|見つけ|どの関数/i],
  ['explain_instruction', /\b(this instruction|this line|this opcode|what does .* do here)\b|この命令|この行/i],
  ['explain_function', /\b(what does this (function|routine)|explain this (function|routine)|purpose of)\b|この関数|何をして|役割/i],
];

/**
 * Best-effort intent for a question.
 *
 * @param {string} question raw user text
 * @param {{selection?: string}} [context] what the user currently has selected;
 *   an instruction selection biases a bare "explain" toward the instruction.
 * @returns {string|null} one of TASKS, or null when nothing matches clearly.
 */
export function detectTask(question, context = {}) {
  const text = String(question || '').trim();
  if (!text) return null;
  if (/^(explain|explain this|説明|これは？|これは\?|何これ)$/i.test(text)) {
    return context.selection === 'instruction' ? 'explain_instruction' : 'explain_function';
  }
  for (const [id, re] of PATTERNS) {
    if (re.test(text)) {
      if (id === 'explain_function' && context.selection === 'instruction' && /この行|this line/i.test(text)) {
        return 'explain_instruction';
      }
      return id;
    }
  }
  return null;
}

/** The hint block for a task id, or '' when there is no hint. */
export function taskHint(task) {
  return task && HINTS[task] ? HINTS[task] : '';
}

export default { TASKS, detectTask, taskHint };
