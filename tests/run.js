/*
 * Semantic IR の解析ユニットテスト。
 *
 *   node tests/run.js
 *
 * ブラウザも Capstone も要らない。逆アセンブル済みの文字列（Capstone が
 * 実際に吐く形）を直接食わせて、モデルの中身を確かめる。
 *
 * 見ているのは 3 つ:
 *   1. 正常系  — 入口・引数準備・API 呼び出し・戻り値・条件分岐・ループ・後片付け
 *   2. データフロー — reg→reg / imm→reg / mem→reg / reg→mem / call→reg / reg→引数
 *   3. 異常系  — 壊れた命令列でも落ちず、「分かりません」と言えるか
 */
import {
  buildSemanticModel, attachTexts, apiInfo, ROLE, levelOf, makeInstruction,
} from '../js/blocks.js';
import {
  functionStory, blockTitle, blockSummary, stepLabel, roleTag, buildOverlay,
  describeValue, confidenceText, evidenceText,
} from '../js/narrate.js';

/* ── ごく小さなテストランナー ────────────────────────────── */

let passed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    passed++;
    process.stdout.write('  ok  ' + name + '\n');
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write('FAIL  ' + name + '\n      ' + (err && err.message) + '\n');
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}
function has(haystack, needle, msg) {
  const text = Array.isArray(haystack) ? haystack.join(' / ') : String(haystack);
  if (text.indexOf(needle) < 0) throw new Error((msg || 'missing') + ': ' + JSON.stringify(needle) + ' not in ' + JSON.stringify(text));
}

/* ── 便利道具 ────────────────────────────────────────────── */

const BASE = 0x100000000n;

/** "mov x1, x19" の並びを、逆アセンブル結果の形に変える。 */
function asm(lines, base = BASE) {
  return lines.map((line, i) => {
    const s = String(line).trim();
    const sp = s.indexOf(' ');
    return {
      row: i,
      address: base + BigInt(i) * 4n,
      mn: sp < 0 ? s : s.slice(0, sp),
      ops: sp < 0 ? '' : s.slice(sp + 1).trim(),
    };
  });
}

function build(lines, names, base = BASE) {
  const table = new Map(Object.entries(names || {}));
  return buildSemanticModel(asm(lines, base), {
    startRow: 0,
    endRow: lines.length - 1,
    symbolFor: (addr) => table.get('0x' + addr.toString(16)) || null,
    rowOfAddress: (addr) => {
      const rel = addr - base;
      if (rel < 0n || rel >= BigInt(lines.length) * 4n) return null;
      return Number(rel / 4n);
    },
  });
}

const roles = (m) => m.semantic.map((b) => b.role);
const kinds = (m) => new Set(m.flows.map((f) => f.kind));
const allText = (m) => m.semantic
  .map((b) => [roleTag(b.role), blockTitle(b), ...blockSummary(b, m)].join(' ')).join('\n');

/* ────────────────────────────────────────────────────────────
   ケース A: 単純な関数呼び出し
   ──────────────────────────────────────────────────────────── */

test('A: 関数入口・呼び出し・後片付け・出口を検出できる', () => {
  const m = build([
    'stp x29, x30, [sp, #-0x10]!',
    'mov x29, sp',
    'bl #0x100000100',
    'ldp x29, x30, [sp], #0x10',
    'ret',
  ], { '0x100000100': '_helper' });

  const r = roles(m);
  eq(r[0], ROLE.FUNCTION_ENTRY, '入口');
  ok(r.includes(ROLE.FUNCTION_CALL), '呼び出し');
  ok(r.includes(ROLE.CLEANUP), '後片付け');
  eq(r[r.length - 1], ROLE.FUNCTION_EXIT, '出口');
  eq(m.calls.length, 1);
  eq(m.calls[0].name, '_helper');
  eq(m.facts.returns, 1);
});

test('A: 説明にレジスタ名も命令名も出てこない', () => {
  const m = build([
    'stp x29, x30, [sp, #-0x10]!',
    'mov x29, sp',
    'ret',
  ]);
  const entry = m.semantic[0];
  const text = blockSummary(entry, m).join(' ');
  ok(!/x29|x30|\bstp\b|\bmov\b/.test(text), '入口の説明に生のレジスタ名が混ざっている: ' + text);
});

/* ────────────────────────────────────────────────────────────
   ケース B: memcpy — 仕様の完成判定そのもの
   ──────────────────────────────────────────────────────────── */

test('B: adrp+add+mov+mov+bl memcpy が 1 つの「データをコピー」になる', () => {
  const m = build([
    'adrp x0, #0x100004000',
    'add x0, x0, #0x10',
    'mov x1, x19',
    'mov x2, #0x10',
    'bl #0x100000200',
    'ret',
  ], { '0x100000200': '_memcpy' });

  const call = m.semantic.find((b) => b.facts.api && b.facts.api.id === 'memcpy');
  ok(call, 'memcpy のまとまりが作られていない: ' + roles(m).join(','));
  eq(call.startRow, 0, '準備の行から始まっていない');
  eq(call.endRow, 4, '呼び出しの行で終わっていない');
  eq(call.instructions.length, 5);

  eq(blockTitle(call), 'データをコピー');
  const text = blockSummary(call, m).join('\n');
  has(text, 'データを別の場所へコピーする処理です');
  has(text, '16 バイト', 'サイズを読み取れていない');
  // 「何のデータか」は分からない。分からないと言えているか。
  has(text, '特定できません');
  ok(!/memcpy/.test(text), '説明に API 名がそのまま出ている');
  ok(!/\bx1\b|\bx2\b/.test(text), '説明にレジスタ名が出ている');
});

test('B: 呼び出しの引数がデータフローとして残る', () => {
  const m = build([
    'mov x2, #0x10',
    'bl #0x100000200',
  ], { '0x100000200': '_memcpy' });
  const call = m.calls[0];
  const size = call.args.find((a) => a.index === 2);
  ok(size, '第 3 引数を捕まえられていない');
  eq(size.role, 'size');
  eq(size.value.kind, 'imm');
  eq(String(size.value.value), '16');
});

/* ────────────────────────────────────────────────────────────
   ケース C: 条件分岐
   ──────────────────────────────────────────────────────────── */

test('C: 比較と条件分岐が 1 つの「条件を確認」になる', () => {
  const m = build([
    'mov x8, #0x1',
    'cmp x8, #0x0',
    'b.eq #0x100000018',
    'mov x0, #0x1',
    'ret',
    'mov x0, #0x0',
    'ret',
  ]);
  const check = m.semantic.find((b) => b.role === ROLE.CONDITION_CHECK);
  ok(check, '条件確認が見つからない: ' + roles(m).join(','));
  ok(check.branch, '分岐情報がない');
  eq(check.branch.conditional, true);
  eq(m.facts.conditionals, 1);
  has(blockSummary(check, m), '見比べて');
});

/* ────────────────────────────────────────────────────────────
   ケース D: ループ
   ──────────────────────────────────────────────────────────── */

test('D: 前へ戻る分岐をループとして検出できる', () => {
  const m = build([
    'mov x0, #0x0',
    'add x0, x0, #0x1',
    'cmp x0, #0xa',
    'b.ne #0x100000004',
    'ret',
  ]);
  eq(m.backEdges.length, 1, '後ろ向き分岐が拾えていない');
  eq(m.backEdges[0].to, 1);
  ok(roles(m).includes(ROLE.LOOP), 'ループ役が付いていない: ' + roles(m).join(','));
  eq(m.facts.loops, 1);
  has(allText(m), '繰り返');
});

/* ────────────────────────────────────────────────────────────
   ケース E: 文字列参照
   ──────────────────────────────────────────────────────────── */

test('E: adrp+add がアドレスになり、文字列を流し込める', () => {
  const m = build([
    'adrp x0, #0x100004000',
    'add x0, x0, #0x123',
    'ret',
  ]);
  eq(m.addressRefs.length, 1);
  eq(m.addressRefs[0].addr, 0x100004123n);
  eq(m.addressRefs[0].value.kind, 'address');

  attachTexts(m, new Map([['' + 0x100004123n, 'Hello']]));
  eq(m.addressRefs[0].value.kind, 'string');
  has(describeValue(m.addressRefs[0].value), '「Hello」');
  has(allText(m), 'Hello', '文字列がブロックの説明に反映されていない');
  eq(m.facts.strings.length, 1);
});

test('E: adrp 単体では「完成していない住所」として扱う', () => {
  const m = build(['adrp x0, #0x100004000', 'ret']);
  eq(m.addressRefs.length, 0, 'ページだけのアドレスを参照として数えている');
  has(describeValue(m.flows[0].value), '上半分');
});

/* ────────────────────────────────────────────────────────────
   ケース F: malloc → 書き込み → 使用
   ──────────────────────────────────────────────────────────── */

test('F: 確保したメモリが別レジスタへ渡っても意味を保つ', () => {
  const m = build([
    'mov x0, #0x40',
    'bl #0x100000300',
    'mov x19, x0',
    'str x20, [x19]',
    'ret',
  ], { '0x100000300': '_malloc' });

  const alloc = m.semantic.find((b) => b.facts.api && b.facts.api.id === 'malloc');
  ok(alloc, 'malloc のまとまりがない');
  has(blockSummary(alloc, m), '置き場所を確保');

  const copy = m.flows.find((f) => f.kind === 'reg->reg' && f.to === 'x19');
  ok(copy, 'x0 → x19 のコピーが追えていない');
  eq(copy.value.kind, 'callResult');
  eq(describeValue(copy.value), '確保されたメモリ');

  const store = m.flows.find((f) => f.kind === 'reg->mem');
  ok(store, 'メモリへの書き込みが追えていない');
});

/* ────────────────────────────────────────────────────────────
   ケース G: 関数戻り値の判定
   ──────────────────────────────────────────────────────────── */

test('G: 呼び出し直後の判定を「結果を確認」にする', () => {
  const m = build([
    'bl #0x100000400',
    'cbz x0, #0x100000010',
    'mov x0, #0x1',
    'ret',
    'mov x0, #0x0',
    'ret',
  ], { '0x100000400': '_open' });

  const check = m.semantic.find((b) => b.role === ROLE.RETURN_VALUE);
  ok(check, '戻り値の確認が見つからない: ' + roles(m).join(','));
  ok(check.facts.checkedCall, '確認対象の呼び出しが記録されていない');
  eq(check.facts.checkedCall.name, '_open');
  has(blockSummary(check, m), '成功したとき');
  eq(m.facts.setsReturnValue, true);
});

/* ────────────────────────────────────────────────────────────
   データフロー: 仕様が挙げた 6 種類すべて
   ──────────────────────────────────────────────────────────── */

test('DF: register→register / immediate→register', () => {
  const m = build(['mov x2, #0x10', 'mov x1, x2', 'ret']);
  const k = kinds(m);
  ok(k.has('imm->reg'), 'immediate→register');
  ok(k.has('reg->reg'), 'register→register');
  const copy = m.flows.find((f) => f.kind === 'reg->reg');
  eq(copy.value.kind, 'imm');
  eq(String(copy.value.value), '16');
});

test('DF: memory→register / register→memory / stack local', () => {
  const m = build([
    'str x19, [sp, #0x8]',
    'ldr x20, [sp, #0x8]',
    'ldr x21, [x0, #0x10]',
    'ret',
  ]);
  const k = kinds(m);
  ok(k.has('reg->mem'), 'register→memory');
  ok(k.has('stack->reg') || k.has('mem->reg'), 'memory→register');
  const reload = m.flows.find((f) => f.kind === 'stack->reg');
  ok(reload, 'スタックに置いた値を読み直せていない');
});

test('DF: function return→register / register→call argument', () => {
  const m = build([
    'mov x0, #0x1',
    'bl #0x100000500',
    'ret',
  ], { '0x100000500': '_strlen' });
  const k = kinds(m);
  ok(k.has('reg->arg'), 'register→call argument');
  ok(k.has('call->reg'), 'function return→register');
  const ret = m.flows.find((f) => f.kind === 'call->reg');
  eq(ret.value.kind, 'callResult');
  eq(describeValue(ret.value), '長さ');
});

test('DF: address calculation', () => {
  const m = build(['adrp x8, #0x100008000', 'add x8, x8, #0x40', 'ret']);
  ok(kinds(m).has('addr-calc'), 'address calculation');
});

test('DF: 引数レジスタを、書く前に読んでいれば引数とみなす', () => {
  const m = build(['add x2, x0, x1', 'ret']);
  eq(m.argRegs.join(','), '0,1');
  const m2 = build(['mov x0, #0x1', 'add x2, x0, x0', 'ret']);
  eq(m2.argRegs.length, 0, '自分で書いたレジスタを引数と誤認している');
});

test('DF: 分岐で飛び込まれる場所では推測を捨てる', () => {
  const m = build([
    'mov x0, #0x1',
    'b #0x10000000c',
    'mov x0, #0x2',
    'mov x1, x0',       // ここは 2 方向から来る
    'ret',
  ]);
  const copy = m.flows.find((f) => f.kind === 'reg->reg' && f.to === 'x1');
  ok(copy, 'コピー自体は追えているべき');
  eq(copy.value.kind, 'unknown', '合流点で古い前提を持ち越している');
});

/* ────────────────────────────────────────────────────────────
   API の知識
   ──────────────────────────────────────────────────────────── */

test('API: 名前から意味を引ける／知らない名前は null', () => {
  eq(apiInfo('_memcpy').id, 'memcpy');
  eq(apiInfo('_objc_msgSend').id, 'objc_msgSend');
  eq(apiInfo('_NSURLSession_dataTaskWithRequest').cat, 'network');
  eq(apiInfo('_sub_100001234'), null);
  eq(apiInfo(null), null);
  eq(apiInfo(''), null);
});

test('API: 機能（アプリから見た分類）まで集約される', () => {
  const m = build([
    'bl #0x100000600',
    'bl #0x100000700',
    'ret',
  ], { '0x100000600': '_CCCrypt', '0x100000700': '_send' });
  ok(m.facts.features.includes('security'));
  ok(m.facts.features.includes('network'));
  const story = functionStory(m, null);
  has(story.purpose, 'ネットワーク通信');
  has(story.evidence.join(' '), '呼んでいる');
});

/* ────────────────────────────────────────────────────────────
   関数のあらすじ
   ──────────────────────────────────────────────────────────── */

test('STORY: 流れが日本語のステップとして並ぶ', () => {
  const m = build([
    'stp x29, x30, [sp, #-0x10]!',
    'mov x29, sp',
    'ldr x0, [x0, #0x8]',
    'cmp x0, #0x0',
    'b.eq #0x100000024',
    'mov x2, #0x20',
    'bl #0x100000800',
    'ldp x29, x30, [sp], #0x10',
    'ret',
    'ret',
  ], { '0x100000800': '_memcpy' });

  const story = functionStory(m, null);
  ok(story.steps.length >= 3, 'ステップが少なすぎる: ' + story.steps.join(' → '));
  has(story.steps, 'データを取得');
  has(story.steps, '条件を確認');
  has(story.steps, 'データをコピー');
  ok(story.confidence > 0 && story.confidence <= 1);
  has(confidenceText(story.confidence), '確度');
});

test('STORY: 手がかりがなければ「特定できません」と言う', () => {
  const m = build(['add x0, x0, #0x1', 'ret']);
  const story = functionStory(m, null);
  has(story.purpose, '特定できませんでした');
  eq(levelOf(story.confidence), 'unknown');
});

/* ────────────────────────────────────────────────────────────
   ビューア用オーバーレイ
   ──────────────────────────────────────────────────────────── */

test('OVERLAY: 行 → 見出しの表ができ、先頭行だけに題が付く', () => {
  const m = build([
    'mov x2, #0x10',
    'bl #0x100000200',
    'ret',
  ], { '0x100000200': '_memcpy' });
  const map = buildOverlay(m);
  eq(map.get(0).title, 'データをコピー');
  eq(map.get(0).pos, 'first');
  eq(map.get(1).title, '');
  eq(map.get(1).pos, 'last');
  eq(map.get(2).pos, 'only');
  ok(map.get(2).title.length > 0);
});

/* ────────────────────────────────────────────────────────────
   異常系: 落ちないこと、そして「分かりません」と言えること
   ──────────────────────────────────────────────────────────── */

test('異常: 空の命令列', () => {
  const m = buildSemanticModel([], {});
  eq(m.instructions.length, 0);
  eq(m.semantic.length, 0);
  const story = functionStory(m, null);
  has(story.purpose, '特定できませんでした');
  eq(buildOverlay(m).size, 0);
});

test('異常: 不完全な命令列（オペランドなし・途中で終わる）', () => {
  const m = build(['mov', 'add x0', 'bl', 'ldr x0, [', 'stp x29,']);
  ok(m.semantic.length >= 1);
  allText(m);            // 説明作りで落ちない
});

test('異常: 知らないニーモニック', () => {
  const m = build(['zorkmid x0, x1', 'mov x0, #0x1', 'ret']);
  const unknown = m.instructions[0];
  eq(unknown.unknownMnemonic, true);
  has(allText(m), '特定できませんでした');
});

test('異常: 命令として読めないデータ (.byte)', () => {
  const m = build(['.byte 0x00, 0x01, 0x02, 0x03', 'ret']);
  eq(m.instructions[0].data, true);
  eq(m.facts.dataRows, 1);
  const b = m.semantic[0];
  eq(levelOf(b.confidence), 'unknown');
  has(evidenceText(b.evidence[0]), '読めない');
});

test('異常: 分岐先が分からない (br/blr)', () => {
  const m = build(['blr x8', 'br x9']);
  eq(m.calls.length, 1);
  eq(m.calls[0].indirect, true);
  eq(m.calls[0].target, null);
  has(allText(m), '実行時に決まる');
  eq(m.facts.indirectCalls, 1);
});

test('異常: シンボルなし・API 名なしでも断定しない', () => {
  const m = build(['bl #0x100000900', 'ret']);   // symbolFor は何も返さない
  eq(m.calls[0].name, null);
  const call = m.semantic.find((b) => b.role === ROLE.FUNCTION_CALL);
  has(blockSummary(call, m), '特定できません');
  ok(call.confidence <= 0.6, '名前が無いのに確度が高い');
});

test('異常: データフローを追えないときは「不明な値」', () => {
  const m = build(['mov x1, x19', 'ret']);   // x19 の中身は関数の外から来ている
  const copy = m.flows.find((f) => f.kind === 'reg->reg');
  eq(copy.value.kind, 'unknown');
  eq(describeValue(copy.value), '不明な値');
  eq(describeValue(null), '不明な値');
  eq(describeValue(undefined), '不明な値');
});

test('異常: 巨大な入力でも上限で打ち切る', () => {
  const lines = new Array(9000).fill('mov x0, #0x1');
  const m = build(lines);
  eq(m.truncated, true);
  ok(m.instructions.length <= 6000);
});

test('異常: 壊れたオペランド文字列でも makeInstruction は落ちない', () => {
  for (const bad of ['[[[', '#', 'x99', '{,,}', ']', 'x0, [x1, #']) {
    const insn = makeInstruction({ row: 0, address: BASE, mn: 'ldr', ops: bad });
    ok(insn && typeof insn.role === 'string');
  }
});

test('異常: すべての役割で説明文が作れる（欠けがない）', () => {
  for (const role of Object.values(ROLE)) {
    const fake = {
      role, instructions: [{ row: 0 }], inputs: [], refs: [], calls: [],
      facts: {}, evidence: [], confidence: 0.8, branch: null,
    };
    ok(blockTitle(fake).length > 0, role + ' の見出しがない');
    ok(stepLabel(fake).length > 0, role + ' の短い言い方がない');
    ok(blockSummary(fake, null).length > 0, role + ' の説明がない');
    ok(roleTag(role).length > 0);
  }
});


/* ────────────────────────────────────────────────────────────
   機能から探す（文字列 → 機能）
   ──────────────────────────────────────────────────────────── */

const { classifyString, groupByFeature, detectEngine } = await import('../js/features.js');

test('FEATURE: ゲームの言葉を機能に振り分けられる', () => {
  eq(classifyString('LoginViewController')[0].id, 'login');
  eq(classifyString('ガチャを引く')[0].id, 'gacha');
  ok(classifyString('purchase_receipt_verify').some((h) => h.id === 'purchase'));
  ok(classifyString('ダメージ計算').some((h) => h.id === 'battle'));
  ok(classifyString('https://api.example.com/v1/user').some((h) => h.id === 'network'));
  ok(classifyString('jailbreak detected').some((h) => h.id === 'anticheat'));
  eq(classifyString('ab').length, 0, '短すぎる文字列は拾わない');
  eq(classifyString('%@%@%@').length, 0, '記号だけの文字列を拾っている');
});

test('FEATURE: 機能ごとに束ね、濃い手がかりを先に出す', () => {
  const strings = [
    { addr: 1n, text: 'login' },
    { addr: 2n, text: 'ログインに失敗しました' },
    { addr: 3n, text: 'ガチャ結果' },
    { addr: 4n, text: 'zzzz' },
  ];
  const g = groupByFeature(strings);
  const login = g.find((f) => f.id === 'login');
  ok(login, 'ログインの束がない');
  eq(login.items.length, 2);
  eq(login.items[0].text, 'ログインに失敗しました', '日本語の文言を先に出していない');
  ok(login.items[0].score > login.items[1].score);
  ok(g.every((f) => f.items.length > 0), '空の機能を出している');
});

test('FEATURE: 実行エンジンの見当がつく／分からなければ null', () => {
  eq(detectEngine([{ addr: 1n, text: 'libil2cpp.so' }]).id, 'unity');
  eq(detectEngine([{ addr: 1n, text: 'nothing here' }]), null);
});

test('OBJC: セレクタをポインタごしに解決して「何を呼ぶか」まで言える', () => {
  const m = build([
    'adrp x8, #0x100008000',
    'ldr x1, [x8, #0x10]',      // __objc_selrefs の枠 → メソッド名を指す
    'adrp x0, #0x100009000',
    'ldr x0, [x0, #0x8]',
    'bl #0x100000700',
  ], { '0x100000700': '_objc_msgSend' });

  const ref = m.addressRefs.find((r) => r.addr === 0x100008010n);
  ok(ref, 'selrefs の枠を参照として拾えていない');

  // worker が 1 段たどって持ってきた名前を流し込む
  attachTexts(m, new Map([['' + 0x100008010n, 'loginWithPassword:']]),
    new Set(['' + 0x100008010n]));

  eq(m.calls[0].selector, 'loginWithPassword:', 'セレクタが呼び出しに結びついていない');
  const b = m.semantic.find((x) => x.facts.selector);
  ok(b, 'まとまりにセレクタが載っていない');
  eq(blockTitle(b), '「loginWithPassword:」を呼ぶ');
  has(blockSummary(b, m), 'loginWithPassword:');
  has(functionStory(m, null).purpose, 'メソッドを呼んでいます');
});

/* ── まとめ ──────────────────────────────────────────────── */

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) {
  for (const f of failures) {
    process.stdout.write('\n--- ' + f.name + '\n' + (f.err && f.err.stack ? f.err.stack : f.err) + '\n');
  }
  process.exit(1);
}
void currentTest;
