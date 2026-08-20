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

const pending = [];

function test(name, fn) {
  currentTest = name;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed++; process.stdout.write('  ok  ' + name + '\n'); },
        (err) => { failures.push({ name, err }); process.stdout.write('FAIL  ' + name + '\n      ' + (err && err.message) + '\n'); }));
      return;
    }
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
  if (a !== b) throw new Error((msg || 'not equal') + ': got ' + show(a) + ', want ' + show(b));
}
/** BigInt は JSON にできないので、表示は自前で。 */
function show(v) {
  if (typeof v === 'bigint') return '0x' + v.toString(16) + 'n';
  try { return JSON.stringify(v); } catch { return String(v); }
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

/* ────────────────────────────────────────────────────────────
   Objective-C のクラス表 → 関数の本当の名前
   ──────────────────────────────────────────────────────────── */

const { buildObjcNames, sanitizePointer } = await import('../js/objc.js');

/**
 * 仮想アドレス空間を 1 枚の配列で用意して、そこに構造体を置いていく。
 *
 * @param {boolean} relative    メソッド一覧を相対形式で置く（iOS 14 以降）
 * @param {boolean} corruptName クラス名を読めないバイト列にする
 * @param {boolean} chained     ポインタを chained fixups の形で置く（iOS 15 以降）。
 *   実機のアプリはこちらしかない。生のアドレスではなく
 *   「イメージ先頭からの距離」が下位 36 ビットに入り、上位に印が付く。
 */
function objcMemory(relative, corruptName, chained) {
  const base = 0x100000000n;
  const mem = new Uint8Array(0x20000);
  const at = (addr) => Number(addr - base);
  const ptr = (addr, value) => {
    let v = BigInt(value);
    /*
     * chained fixups（_64_OFFSET 形式）。next に 2 を入れて実機と同じ形にする。
     * ここで大事なのは、書かれるのが **アドレスそのものではない** こと。
     */
    if (chained && v !== 0n) v = (2n << 51n) | (v - base);
    for (let i = 0; i < 8; i++) { mem[at(addr) + i] = Number(v & 0xffn); v >>= 8n; }
  };
  const u32w = (addr, value) => {
    let v = value >>> 0;
    for (let i = 0; i < 4; i++) { mem[at(addr) + i] = v & 0xff; v >>>= 8; }
  };
  const str = (addr, text) => {
    for (let i = 0; i < text.length; i++) mem[at(addr) + i] = text.charCodeAt(i);
    mem[at(addr) + text.length] = 0;
  };

  const A = {
    classList: 0x100010000n, cls: 0x100011000n, meta: 0x100011100n,
    ro: 0x100012000n, metaRo: 0x100012100n,
    clsName: 0x100013000n, selName: 0x100013100n, selName2: 0x100013200n,
    methods: 0x100014000n, metaMethods: 0x100014100n,
    selRef: 0x100015000n, imp: 0x100002000n, metaImp: 0x100002100n,
  };

  ptr(A.classList, A.cls);
  ptr(A.cls + 0n, A.meta);          // isa → メタクラス
  ptr(A.cls + 32n, A.ro);           // data
  ptr(A.ro + 24n, A.clsName);       // name
  ptr(A.ro + 32n, A.methods);       // baseMethods
  ptr(A.meta + 32n, A.metaRo);
  ptr(A.metaRo + 24n, A.clsName);
  ptr(A.metaRo + 32n, A.metaMethods);
  if (corruptName) mem.fill(0xff, at(A.clsName), at(A.clsName) + 32);
  else str(A.clsName, 'LoginViewController');
  str(A.selName, 'loginButtonTapped:');
  str(A.selName2, 'sharedInstance');

  if (relative) {
    // 相対形式: 名前はセレクタのポインタを指す（iOS 14 以降）
    u32w(A.methods, 12 | 0x80000000);
    u32w(A.methods + 4n, 1);
    ptr(A.selRef, A.selName);
    u32w(A.methods + 8n, Number(A.selRef - (A.methods + 8n)));
    u32w(A.methods + 12n, 0);
    u32w(A.methods + 16n, Number(A.imp - (A.methods + 16n)));

    // クラスメソッド側は、名前を直接指す古い相対形式で置く
    u32w(A.metaMethods, 12 | 0x80000000);
    u32w(A.metaMethods + 4n, 1);
    u32w(A.metaMethods + 8n, Number(A.selName2 - (A.metaMethods + 8n)));
    u32w(A.metaMethods + 12n, 0);
    u32w(A.metaMethods + 16n, Number(A.metaImp - (A.metaMethods + 16n)));
  } else {
    // 従来形式: 1 件 24 バイトのポインタ 3 本
    u32w(A.methods, 24);
    u32w(A.methods + 4n, 1);
    ptr(A.methods + 8n, A.selName);
    ptr(A.methods + 16n, 0);
    ptr(A.methods + 24n, A.imp);
    u32w(A.metaMethods, 24);
    u32w(A.metaMethods + 4n, 1);
    ptr(A.metaMethods + 8n, A.selName2);
    ptr(A.metaMethods + 16n, 0);
    ptr(A.metaMethods + 24n, A.metaImp);
  }

  const read = async (addr, len) => {
    const off = Number(addr - base);
    if (off < 0 || off >= mem.length) return null;
    return mem.subarray(off, Math.min(mem.length, off + len));
  };
  return { read, A, section: { vmAddr: A.classList, size: 8n } };
}

test('OBJC: 相対形式のクラス表から -[Class method] を取り出せる', async () => {
  const { read, A, section } = objcMemory(true);
  const res = await buildObjcNames(read, section);
  eq(res.classes, 1);
  const inst = res.names.find((n) => n.name.startsWith('-'));
  const clsm = res.names.find((n) => n.name.startsWith('+'));
  ok(inst, 'インスタンスメソッドが取れていない: ' + res.names.map((n) => n.name).join(', '));
  eq(inst.name, '-[LoginViewController loginButtonTapped:]');
  eq(inst.addr, A.imp, '実装のアドレスが違う');
  ok(clsm, 'クラスメソッドが取れていない');
  eq(clsm.name, '+[LoginViewController sharedInstance]');
  eq(clsm.addr, A.metaImp);
});

test('OBJC: 従来形式のクラス表も読める', async () => {
  const { read, A, section } = objcMemory(false);
  const res = await buildObjcNames(read, section);
  eq(res.names.length, 2);
  eq(res.names[0].name, '-[LoginViewController loginButtonTapped:]');
  eq(res.names[0].addr, A.imp);
});

test('OBJC: 壊れた表では名前を付けずに黙って飛ばす', async () => {
  const empty = async () => null;
  const res = await buildObjcNames(empty, { vmAddr: 0x100010000n, size: 800n });
  eq(res.names.length, 0);
  eq(res.classes, 0);

  const none = await buildObjcNames(empty, null);
  eq(none.names.length, 0);

  // クラス名が読めないバイト列なら、そのクラスごと捨てる
  const broken = objcMemory(true, true);
  const res2 = await buildObjcNames(broken.read, broken.section);
  eq(res2.names.length, 0, '読めない名前を名前として採用している');
  eq(res2.classes, 0);
});

test('OBJC: chained fixups で上位ビットが立ったポインタをほどく', () => {
  eq(sanitizePointer(0x100004000n), 0x100004000n);
  eq(sanitizePointer(0x8010000100004000n), 0x100004000n);
  eq(sanitizePointer(0n), null);
});

/*
 * ここが実機でいちばん効くところ。iOS 15 以降のアプリのポインタは
 * 「イメージ先頭からの距離」で書かれているので、下位ビットを取り出しただけでは
 * 先頭（0x100000000）が抜け落ちる。実際に The Battle Cats では、これを直すまで
 * クラスが 1 個も読めていなかった（0 個 → 3144 個）。
 */
test('OBJC: chained fixups の距離形式は、イメージ先頭を足して初めて読める', () => {
  // 距離形式の生の値。下位 36 ビットには 0x4000 しか入っていない。
  const raw = (2n << 51n) | 0x4000n;
  eq(sanitizePointer(raw, 0x100000000n), 0x100004000n, 'イメージ先頭を足していない');
  // 先頭が分からないなら、距離をアドレスとして返すしかない（作り話はしない）
  eq(sanitizePointer(raw), 0x4000n);
  // bind（他のライブラリの記号）は、番号をアドレスと取り違えない
  eq(sanitizePointer(0x8010000000000ac4n, 0x100000000n), null, 'bind をアドレスとして採っている');
  // Some ObjC metadata emits the image-relative target without chained high bits.
  eq(sanitizePointer(0x18ba120n, 0x100000000n), 0x1018ba120n, 'bare image-relative pointerを復元できない');
});

test('OBJC: 距離形式で書かれたクラス表から、名前とフィールドを取り戻せる', async () => {
  const { read, A, section } = objcMemory(true, false, true);
  // 先頭を渡さなくても、クラス表の位置から推定して読めること（呼び出し元が古いままでも動く）
  const guessed = await buildObjcNames(read, section);
  eq(guessed.classes, 1, 'イメージ先頭を推定できていない');

  const res = await buildObjcNames(read, section, null, 0x100000000n);
  eq(res.classes, 1);
  const inst = res.names.find((n) => n.name.startsWith('-'));
  ok(inst, 'メソッド名が取れていない');
  eq(inst.name, '-[LoginViewController loginButtonTapped:]');
  eq(inst.addr, A.imp);
});

const { SymbolIndex } = await import('../js/symbols.js');

test('SYMBOLS: 復元した名前と関数の先頭を、順番を保ったまま足せる', () => {
  const idx = new SymbolIndex({
    addrs: BigUint64Array.from([0x100n, 0x300n]),
    kinds: Uint8Array.from([0, 0]),
    names: '_start\n_end',
    funcs: BigUint64Array.from([0x100n]),
  });
  const before = idx.gen;
  const added = idx.addNames([
    { addr: 0x200n, name: '-[A b]' },
    { addr: 0x100n, name: 'かぶり' },       // 既にある方を優先
    { addr: 0x080n, name: '+[A c]' },
  ]);
  eq(added, 2);
  eq(idx.nameAt(0x200n), '-[A b]');
  eq(idx.nameAt(0x100n), '_start', '既存の名前を上書きしている');
  eq(idx.nameAt(0x080n), '+[A c]');
  eq(idx.symbolCount, 4);
  ok(idx.gen > before, '解説キャッシュの世代が上がっていない');
  // 二分探索が壊れていないこと（＝アドレス順が保たれている）
  eq(idx.label(0x210n), '-[A b]+0x10');

  eq(idx.addFunctions([0x200n, 0x080n, 0x100n]), 2);
  eq(idx.functionCount, 3);
  eq(idx.isFunctionStart(0x200n), true);
  eq(idx.functionAt(0x200n).start, 0x200n, 'exact function starts remain identifiable');
  eq(idx.functionAt(0x204n), null, 'unknown last-function extent must not absorb trailing bytes');
  eq(idx.addNames([]), 0);
  eq(idx.addFunctions(null), 0);
});

test('SYMBOLS: 部分的なmetadata関数一覧をLC_FUNCTION_STARTS完全表と取り違えない', () => {
  const partial = new SymbolIndex({ funcs: BigUint64Array.from([0x100n, 0x300n]) });
  eq(partial.functionStartsExact, false, '部分的なObjC等の関数だけで推定を止めてしまう');
  partial.addFunctions([0x200n]);
  partial.guessed = true;
  eq(partial.functionCount, 3, '推定関数をmetadata由来の関数へマージできていない');

  const exact = new SymbolIndex({
    funcs: BigUint64Array.from([0x100n, 0x200n]),
    functionStartsExact: true,
  });
  eq(exact.functionStartsExact, true, 'LC_FUNCTION_STARTSの完全表フラグを保持していない');
});

/* ────────────────────────────────────────────────────────────
   ARM64 の語を直接読む層（js/words.js）

   ここが間違うと、参照関係も呼び出しグラフも全部ずれる。
   命令の並びは llvm-mc が実際に吐いたバイト列をそのまま使っている。
   ──────────────────────────────────────────────────────────── */

await import('../js/words.js');
const W = globalThis.Words;
const PC = 0x100000000n;

test('WORDS: 実物のエンコードを正しく分類できる', () => {
  const cases = [
    ['bl',        0x94000040, 'CALL'],
    ['blr',       0xd63f0100, 'INDCALL'],
    ['ret',       0xd65f03c0, 'RET'],
    ['b',         0x14000010, 'BRANCH'],
    ['b.lt',      0x5400010b, 'CONDBR'],
    ['cbz',       0x34000080, 'CONDBR'],
    ['tbz',       0x36180080, 'CONDBR'],
    ['ldr w',     0xb9402008, 'LOAD'],
    ['str w',     0xb9002008, 'STORE'],
    ['ldp',       0xa9417bfd, 'LOAD'],
    ['stp!',      0xa9bf7bfd, 'STORE'],
    ['add imm',   0x11002908, 'ARITH'],
    ['mul',       0x1b027c20, 'MUL'],
    ['madd',      0x1b020c20, 'MUL'],
    ['sdiv',      0x1ac20c20, 'DIV'],
    ['fmul',      0x1e220820, 'FMUL'],
    ['fadd',      0x1e622820, 'FARITH'],
    ['cmp imm',   0x7101911f, 'CMP'],
    ['cmp reg',   0xeb02003f, 'CMP'],
    ['tst',       0x7200001f, 'CMP'],
    ['adrp',      0xb0000000, 'ADRP'],
    ['mov #5',    0x528000a0, 'MOVIMM'],
    ['mov reg',   0xaa0203e1, 'MOVREG'],
    ['nop',       0xd503201f, 'NOP'],
    ['brk',       0xd4200020, 'TRAP'],
    ['ldr lit',   0x58000040, 'LITERAL'],
    ['csel',      0x1a820020, 'CSEL'],
    ['and',       0x0a020020, 'LOGIC'],
    ['lsl',       0x531e7420, 'SHIFT'],
  ];
  for (const [name, word, want] of cases) {
    eq(W.decodeWord(word >>> 0, PC).kindName, want, name);
  }
});

test('WORDS: 分岐と呼び出しの飛び先を計算できる', () => {
  eq(W.decodeWord(0x94000040, PC).target, PC + 0x100n, 'bl');
  eq(W.decodeWord(0x14000010, PC).target, PC + 0x40n, 'b');
  eq(W.decodeWord(0x5400010b, PC).target, PC + 0x20n, 'b.lt');
  eq(W.decodeWord(0x58000040, PC).target, PC + 8n, 'ldr literal');
  // 後ろ向きの分岐（ループ）も符号つきで解ける
  const back = (0x14000000 | ((-4 >>> 0) & 0x3ffffff)) >>> 0;
  eq(W.branchImm26(back, PC), PC - 16n, '後ろ向きの b');
});

test('WORDS: メモリアクセスの大きさとずらし幅を正しく読む', () => {
  const m = (w) => W.memoryAccess(w >>> 0);
  eq(m(0xb9402008).disp, 32n, 'ldr w8, [x0,#32]');
  eq(m(0xb9402008).size, 4);
  eq(m(0xb9402008).load, true);
  eq(m(0xb9002008).load, false, 'str は書き込み');
  eq(m(0xf9400909).disp, 16n, 'ldr x9, [x8,#16]');
  eq(m(0x39400c41).disp, 3n, 'ldrb は倍率 1');
  eq(m(0xa9417bfd).disp, 16n, 'ldp のずらし幅');
  eq(m(0xa9bf7bfd).disp, -16n, 'stp の負のずらし幅');
  eq(m(0xb85fc020).disp, -4n, 'ldur は符号つき');
  eq(m(0xb8626820).indexed, true, 'レジスタ添字は場所を特定しない');
  eq(m(0xb8626820).disp, null);
  // SIMD の 128 ビット転送は size ビットだけでは分からない
  eq(m(0x3d800400).size, 16, 'str q0 は 16 バイト');
  eq(m(0x3d800400).disp, 16n, 'str q0, [x0,#16]');
});

test('WORDS: adrp + add / adrp + ldr でアドレスを組み立てられる', () => {
  const adrp = W.pcRelTarget(0xb0000000, 0x100000000n);   // adrp x0, #4096
  eq(adrp.page, true);
  eq(adrp.value, 0x100001000n);
  eq(adrp.reg, 0);
  const pair = W.pairedOffset(0x9110f000);                // add x0, x0, #1084
  eq(pair.rn, 0); eq(pair.rd, 0); eq(pair.imm, 1084n);
  eq(adrp.value + pair.imm, 0x10000143cn, '最終アドレス');
  // SIMD の ldr で倍率を間違えると、まったく別の場所を指してしまう
  eq(W.pairedOffset(0x3dc00841).imm, 32n, 'ldr q1, [x2,#32]');
});

test('WORDS: 分からない語は分類しない（でっちあげない）', () => {
  eq(W.classifyWord(0), W.KIND.OTHER, '0 埋めは命令として数えない');
  eq(W.decodeWord(0, PC).target, null);
  eq(W.classifyWord(0x0000abcd), W.KIND.TRAP, 'udf を見落としている');
  // どんな 32 ビットでも、落ちずに何かしらの分類を返す
  for (const w of [0xffffffff, 0x00000001, 0x7fffffff, 0x9fffffff]) {
    const d = W.decodeWord(w >>> 0, PC);
    ok(typeof d.kind === 'number' && d.kindName, '0x' + w.toString(16) + ' で落ちている');
  }
});

/* ────────────────────────────────────────────────────────────
   プログラム全体の索引（js/program.js）
   ──────────────────────────────────────────────────────────── */

const { ProgramIndex } = await import('../js/program.js');

/** 走査結果を手で組み立てる。worker を動かさずに索引の中身を確かめる。 */
function fakeScan({ calls = [], refs = [], kinds = [], base = PC, words = 64 }) {
  const callFrom = BigUint64Array.from(calls.map((c) => c[0]));
  const callTo = BigUint64Array.from(calls.map((c) => c[1]));
  const refFrom = BigUint64Array.from(refs.map((r) => r[0]));
  const refTo = BigUint64Array.from(refs.map((r) => r[1]));
  const refKind = Uint8Array.from(refs.map((r) => r[2] || 0));
  const kindArr = new Uint8Array(words);
  for (const [i, k] of kinds) kindArr[i] = k;
  return {
    vmAddr: base, words,
    callFrom, callTo, refFrom, refTo, refKind,
    kinds: kindArr, kindsCovered: words,
    callsCapped: false, refsCapped: false,
  };
}

test('PROGRAM: 呼び出し元・呼び出し先を辺からたどれる', () => {
  const symbols = new SymbolIndex({
    addrs: BigUint64Array.from([PC, PC + 0x40n, PC + 0x80n]),
    kinds: Uint8Array.from([0, 0, 0]),
    names: '_battle\n_calcDamage\n_applyDamage',
    funcs: BigUint64Array.from([PC, PC + 0x40n, PC + 0x80n]),
  });
  const scan = fakeScan({
    calls: [
      [PC + 0x10n, PC + 0x40n],       // battle → calcDamage
      [PC + 0x20n, PC + 0x40n],       // battle → calcDamage（2 回目）
      [PC + 0x50n, PC + 0x80n],       // calcDamage → applyDamage
    ],
    words: 64,
  });
  const p = new ProgramIndex(scan, symbols, { vmAddr: PC, size: 0x100n });

  const callers = p.callersOf(PC + 0x40n);
  eq(callers.length, 1, '呼び出し元は 1 つの関数にまとまる');
  eq(callers[0].addr, PC, '呼び出し元が関数の先頭に解決されていない');
  eq(callers[0].count, 2, '同じ関数からの 2 回が数えられていない');
  eq(p.callCountOf(PC + 0x40n), 2);

  const callees = p.calleesOf(PC + 0x40n, PC + 0x80n);
  eq(callees.length, 1);
  eq(callees[0].addr, PC + 0x80n);
  eq(p.callersOf(PC).length, 0, '誰も呼んでいない関数');
});

test('PROGRAM: 文字列を参照している関数を、参照命令から特定できる', () => {
  const symbols = new SymbolIndex({
    addrs: BigUint64Array.from([PC]),
    kinds: Uint8Array.from([0]),
    names: '_calcDamage',
    funcs: BigUint64Array.from([PC, PC + 0x40n]),
  });
  const STR = 0x200000000n;
  const scan = fakeScan({
    refs: [[PC + 0x08n, STR, 0], [PC + 0x50n, STR + 4n, 0]],
  });
  const p = new ProgramIndex(scan, symbols, { vmAddr: PC, size: 0x100n });

  eq(p.refSitesTo(STR).length, 1, 'ちょうどそのアドレスだけを拾う');
  // 文字列の長さぶんを 1 つの対象として扱えば、途中を指す参照も拾える
  eq(p.refSitesTo(STR, 16n).length, 2);
  const users = p.functionsReferencing(STR, 16n);
  eq(users.length, 2, '2 つの関数が参照している');
  eq(users[0].addr, PC);
  eq(users[1].addr, null, 'end不明の最後の関数へ参照siteを誤帰属しない');
  eq(users[1].site, PC + 0x50n, '関数帰属が不明でも参照site自体は失わない');
  eq(p.refsFrom(PC, PC + 0x40n).length, 1, 'この関数が指しているデータ');
});

test('PROGRAM: 関数ごとの命令の内訳を数えられる（推測ではなく計数）', () => {
  const K = W.KIND;
  const symbols = new SymbolIndex({
    addrs: new BigUint64Array(0), kinds: new Uint8Array(0), names: '',
    funcs: BigUint64Array.from([PC, PC + 0x20n]),
  });
  const scan = fakeScan({
    kinds: [[0, K.LOAD], [1, K.MUL], [2, K.MUL], [3, K.STORE], [4, K.CMP], [5, K.RET],
      [8, K.FMUL], [9, K.CALL]],
    words: 32,
  });
  const p = new ProgramIndex(scan, symbols, { vmAddr: PC, size: 0x80n });
  const s = p.statsOf(PC, PC + 0x20n);
  eq(s.mul, 2); eq(s.load, 1); eq(s.store, 1); eq(s.cmp, 1);
  eq(s.numeric, 2, '掛け算は数値計算として数える');
  eq(s.total, 8, '関数の語数');
  const rest = p.statsOf(PC + 0x20n, PC + 0x30n);
  eq(rest.fmul, 1); eq(rest.call, 1);
});

test('PROGRAM: 索引がなくても落ちない', () => {
  const p = new ProgramIndex(null, null, null);
  eq(p.callCount, 0);
  eq(p.callersOf(PC).length, 0);
  eq(p.refSitesTo(PC).length, 0);
  eq(p.functionStartOf(PC), null);
  eq(p.statsOf(PC, PC + 4n).covered, false);
  eq(p.mostCalled().length, 0);
});

/* ────────────────────────────────────────────────────────────
   目的から探す（js/goals.js, js/rank.js）
   ──────────────────────────────────────────────────────────── */

const { parseGoal, goalFromPreset, matchText, expandTerms } = await import('../js/goals.js');
const { rankCandidates, breakdown, REASON, scoreToConfidence } = await import('../js/rank.js');

test('GOAL: 自由入力を、探せる語に開ける', () => {
  const g = parseGoal('敵にダメージを与える処理');
  ok(g, '目的が作れていない');
  eq(g.id, 'damage', 'ダメージのプリセットに寄せられていない');
  ok(matchText(g, 'damage_calc'), '英語の識別子に当たらない');
  ok(matchText(g, 'ダメージ計算'), '日本語の文言に当たらない');
  eq(matchText(g, 'zzz'), null);

  const free = parseGoal('ほげほげ');
  eq(free.free, true, '知らない言葉は自由目的として扱う');
  ok(matchText(free, 'ほげほげ設定'), '入力そのものは手がかりとして使う');

  const terms = expandTerms('コインを増やしたい');
  ok(terms.some((t2) => t2.word === 'coin'), '日本語から英語の語に開けていない');
  eq(parseGoal('  '), null);
});

test('GOAL: 手がかりの濃さで点が変わる（記号だらけは下げる）', () => {
  const g = goalFromPreset('login');
  const good = matchText(g, 'ログインに失敗しました');
  const junk = matchText(g, '%@/login/%@%@%@%@%@%@%@%@%@%@%@%@%@%@%@%@');
  ok(good.score > 0, '文言に当たらない');
  ok(good.score > junk.score, '記号だらけの文字列を下げていない');
});

test('RANK: 名前だけの一致より、参照と命令の裏づけがある関数を上に出す', () => {
  const NAMED = PC;              // 名前だけが一致する関数
  const REAL = PC + 0x40n;       // 文字列を参照し、計算して書き戻している関数
  const STR = 0x200000000n;
  const symbols = new SymbolIndex({
    addrs: BigUint64Array.from([NAMED, REAL]),
    kinds: Uint8Array.from([0, 0]),
    names: '_damageLabelText\nsub_realwork',
    funcs: BigUint64Array.from([NAMED, REAL, PC + 0x80n]),
  });
  const K = W.KIND;
  const scan = fakeScan({
    refs: [[REAL + 8n, STR, 0]],
    calls: [[PC + 0x84n, REAL], [PC + 0x88n, REAL], [PC + 0x8cn, REAL]],
    kinds: [[16, K.LOAD], [17, K.MUL], [18, K.MUL], [19, K.STORE], [20, K.CMP]],
    words: 64,
  });
  const program = new ProgramIndex(scan, symbols, { vmAddr: PC, size: 0x100n });
  const goal = goalFromPreset('damage');
  const res = rankCandidates({
    goal,
    strings: [{ addr: STR, text: 'damage dealt to enemy' }],
    program, symbols, region: { vmAddr: PC, size: 0x100n },
  });

  ok(res.candidates.length >= 2, '候補が足りない');
  eq(res.candidates[0].addr, REAL, '名前だけの一致が上に来てしまっている');
  const codes = res.candidates[0].reasons.map((r) => r.code);
  ok(codes.includes(REASON.STRING_REF), '文字列の参照が根拠に入っていない');
  ok(codes.includes(REASON.NUMERIC), '計算の実在が根拠に入っていない');
  ok(codes.includes(REASON.STORE), '書き戻しが根拠に入っていない');
  ok(codes.includes(REASON.POPULAR), '呼ばれる回数が根拠に入っていない');
  ok(res.candidates[0].score > res.candidates[1].score);
  ok(res.candidates[0].stars >= res.candidates[1].stars);
});

test('RANK: 点数の内訳の合計が、表示している点数と一致する', () => {
  const STR = 0x200000000n;
  const symbols = new SymbolIndex({
    addrs: BigUint64Array.from([PC]), kinds: Uint8Array.from([0]),
    names: '_coinCount', funcs: BigUint64Array.from([PC]),
  });
  const program = new ProgramIndex(fakeScan({ refs: [[PC + 4n, STR, 0]] }), symbols,
    { vmAddr: PC, size: 0x100n });
  const res = rankCandidates({
    goal: goalFromPreset('money'),
    strings: [{ addr: STR, text: 'not enough coins' }],
    program, symbols, region: { vmAddr: PC, size: 0x100n },
  });
  const c = res.candidates[0];
  ok(c, '候補がない');
  const sum = breakdown(c).reduce((a, r) => a + r.points, 0);
  ok(Math.abs(sum - Math.round(c.score)) <= breakdown(c).length,
    '内訳の合計 (' + sum + ') が点数 (' + c.score + ') と合わない');
  // 確度は 100% にはならない（静的解析だけで「確実」とは言わない）
  ok(c.confidence < 1);
  ok(scoreToConfidence(0) === 0);
});

test('RANK: 手がかりがなければ候補を作らない（無理に埋めない）', () => {
  const symbols = new SymbolIndex({ funcs: BigUint64Array.from([PC]) });
  const program = new ProgramIndex(fakeScan({}), symbols, { vmAddr: PC, size: 0x100n });
  const res = rankCandidates({
    goal: goalFromPreset('gacha'),
    strings: [{ addr: 0x300000000n, text: 'hello world' }],
    program, symbols, region: { vmAddr: PC, size: 0x100n },
  });
  eq(res.candidates.length, 0);
  eq(res.matchedStrings.length, 0);
});

test('RANK: 一致した文字列を誰も参照していないときは、そう言える', () => {
  const symbols = new SymbolIndex({ funcs: BigUint64Array.from([PC]) });
  const program = new ProgramIndex(fakeScan({ calls: [[PC, PC]] }), symbols,
    { vmAddr: PC, size: 0x100n });
  const res = rankCandidates({
    goal: goalFromPreset('gacha'),
    strings: [{ addr: 0x300000000n, text: 'ガチャを引く' }],
    program, symbols, region: { vmAddr: PC, size: 0x100n },
  });
  eq(res.candidates.length, 0, '参照がないのに候補を作っている');
  eq(res.matchedStrings.length, 1);
  ok(res.notes.includes('strings-unreferenced'), '理由を説明していない');
});

/* ────────────────────────────────────────────────────────────
   データフロー（js/dataflow.js）
   ──────────────────────────────────────────────────────────── */

const {
  findValueUpdates, traceForward, traceBackward, constantComparisons, hotLocations,
} = await import('../js/dataflow.js');

test('FLOW: 読む → 足す → 同じ場所へ書き戻す、をひとつながりに拾える', () => {
  const m = build([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #0xa',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const ups = findValueUpdates(m);
  eq(ups.length, 1, '変更の連鎖が 1 つ見つからない');
  const u = ups[0];
  eq(u.kind, 'read-modify-write');
  eq(u.location.base, 'x0');
  eq(u.location.disp, 0x20n);
  eq(u.location.size, 4);
  eq(u.from.row, 0, '読み出しの行が違う');
  eq(u.store.row, 2, '書き込みの行が違う');
  eq(u.steps.length, 1);
  eq(u.steps[0].op, 'add');
  eq(u.steps[0].imm, 10n);
  eq(u.level, 'confirmed', '往復が閉じているのに確度が低い');
});

test('FLOW: 別の場所へ移しているだけなら「往復」と言わない', () => {
  const m = build([
    'ldr w8, [x0, #0x20]',
    'str w8, [x1, #0x30]',
    'ret',
  ]);
  const u = findValueUpdates(m)[0];
  ok(u, '連鎖が拾えていない');
  eq(u.kind, 'move', '別の場所への書き込みを往復と誤認している');
  ok(u.confidence < 1);
});

test('FLOW: ARC property helper への tail-call setter を getter と逆判定しない', () => {
  const m = build([
    'adrp x8, #0x100004000',
    'ldrsw x2, [x8, #0x20]',
    'b #0x100000100',
  ], { '0x100000100': '_objc_setProperty_nonatomic_copy' });
  const ups = findValueUpdates(m);
  eq(ups.length, 1, '薄い property setter を拾えていない');
  eq(ups[0].kind, 'write', 'objc_setProperty* を getter と逆判定している');
  eq(ups[0].register, 'x3', 'setter の newValue register は x3 でなければならない');
  ok(ups[0].location.indexAddr != null, 'ivar offset variable の場所を失っている');
});

test('FLOW: lazy getter は同じ field への書き込みがあっても return-read を残す', () => {
  const m = build([
    'mov x19, x0',
    'ldr x8, [x19, #0x10]',
    'str x0, [x19, #0x10]',
    'ldr x0, [x19, #0x10]',
    'ret',
  ]);
  const ups = findValueUpdates(m).filter((u) => u.location && u.location.disp === 0x10n);
  ok(ups.some((u) => u.kind === 'read'), '返り値として読む getter の事実が write/move に消されている');
  ok(ups.some((u) => u.kind === 'write' || u.kind === 'move'), 'lazy 初期化の書き込みまで消している');
});

test('FLOW: 掛け算をはさむ計算も追える（ダメージ計算の形）', () => {
  const m = build([
    'ldr w8, [x0, #0x10]',
    'ldr w9, [x0, #0x14]',
    'mul w8, w8, w9',
    'str w8, [x1, #0x8]',
    'ret',
  ]);
  const u = findValueUpdates(m)[0];
  ok(u, '連鎖が拾えていない');
  eq(u.steps[0].op, 'mul');
  eq(u.from.disp, 0x10n, '読み出し元をさかのぼれていない');
});

test('FLOW: この値が次にどこで使われるかを追える', () => {
  const m = build([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'str w8, [x0, #0x20]',
    'cmp w8, #0x64',
    'mov x0, x8',
    'ret',
  ]);
  const uses = traceForward(m, 0, 'x8');
  const kinds2 = uses.map((u) => u.use);
  has(kinds2.join(','), 'compute', '計算に使われていることを見ていない');
  has(kinds2.join(','), 'store', '書き込みに使われていることを見ていない');
  has(kinds2.join(','), 'compare', '比較に使われていることを見ていない');
  eq(traceForward(m, 0, null).length, 0, 'レジスタ不明なら何も言わない');

  const back = traceBackward(m, 2, 'x8');
  ok(back.length >= 1, '作り主をさかのぼれていない');
  eq(back[0].kind, 'compute');
});

test('FLOW: しきい値との比較を拾える', () => {
  const m = build([
    'cmp w8, #0x64',
    'b.lt #0x100000000',
    'fcmp s0, #0.0',
    'ret',
  ]);
  const cs = constantComparisons(m);
  ok(cs.length >= 1, '定数との比較を拾えていない');
  eq(cs[0].value, 0x64n);
  eq(cs[0].register, 'x8');
});

test('FLOW: よく触っている場所をまとめられる', () => {
  const m = build([
    'ldr w8, [x19, #0x40]',
    'add w8, w8, #1',
    'str w8, [x19, #0x40]',
    'ldr w9, [x19, #0x40]',
    'ret',
  ]);
  const hot = hotLocations(m);
  ok(hot.length >= 1);
  eq(hot[0].base, 'x19');
  eq(hot[0].loads, 2);
  eq(hot[0].stores, 1);
});

test('FLOW 異常: 読み出しのない書き込み・壊れた列でも落ちない', () => {
  const m = build([
    'str w8, [x0, #0x20]',
    '.byte 0x00, 0x01, 0x02, 0x03',
    'ldr w8, [x0]',
    'ret',
  ]);
  const ups = findValueUpdates(m);
  ok(Array.isArray(ups), '落ちている');
  for (const u of ups) ok(u.location, '場所のない連鎖を返している');
  eq(traceForward(m, 999, 'x8').length, 0, '存在しない行でも空で返す');
  eq(traceBackward(m, 999, 'x8').length, 0);
  ok(Array.isArray(findValueUpdates({ instructions: [] })));
});

/* ────────────────────────────────────────────────────────────
   制御フロー（js/cfg.js）
   ──────────────────────────────────────────────────────────── */

const { buildCfg, outline } = await import('../js/cfg.js');

const rowOfBase = (base, count) => (addr) => {
  if (addr == null) return null;
  const rel = addr - base;
  if (rel < 0n || rel >= BigInt(count) * 4n) return null;
  return Number(rel / 4n);
};

test('CFG: if / else と合流を見分けられる', () => {
  const lines = [
    'cmp w0, #0',            // 0
    'b.eq #0x100000010',     // 1 → row 4
    'mov w1, #1',            // 2  … 条件に合わなかった道
    'b #0x100000014',        // 3 → row 5
    'mov w1, #2',            // 4  … 条件に合った道
    'add w1, w1, #1',        // 5  … 合流
    'ret',                   // 6
  ];
  const m = build(lines);
  const cfg = buildCfg(m, { rowOfAddress: rowOfBase(BASE, lines.length) });
  ok(cfg.nodes.length >= 3, 'ブロックに割れていない');
  const kinds3 = cfg.shapes.map((s) => s.kind);
  ok(kinds3.includes('if') || kinds3.includes('if-else'), '枝分かれを見つけられていない: ' + kinds3.join(','));
  // 合流点には 2 本の入り口がある
  const join = cfg.nodes.find((n) => n.pred.length >= 2);
  ok(join, '合流点が見つからない');
});

test('CFG: ループ（後ろへの分岐）を見分けられる', () => {
  const lines = [
    'mov w0, #0',            // 0
    'add w0, w0, #1',        // 1  ← ループの入口
    'cmp w0, #0xa',          // 2
    'b.lt #0x100000004',     // 3 → row 1
    'ret',                   // 4
  ];
  const m = build(lines);
  const cfg = buildCfg(m, { rowOfAddress: rowOfBase(BASE, lines.length) });
  const loop = cfg.shapes.find((s) => s.kind === 'loop');
  ok(loop, 'ループを見つけられていない');
  eq(cfg.nodes[loop.header].startRow, 1);
  ok(cfg.backEdges.length >= 1);
});

test('CFG: 途中で帰る道（early return）を見分けられる', () => {
  const lines = [
    'cbz x0, #0x10000000c',  // 0 → row 3
    'ldr w8, [x0]',          // 1
    'b #0x100000014',        // 2 → row 5
    'mov w0, #0',            // 3
    'ret',                   // 4
    'ret',                   // 5
  ];
  const m = build(lines);
  const cfg = buildCfg(m, { rowOfAddress: rowOfBase(BASE, lines.length) });
  ok(cfg.shapes.some((s) => s.kind === 'early-return' || s.kind === 'if'),
    '途中で帰る形を見分けられていない');
  ok(cfg.exits.length >= 1, '出口がない');
});

test('CFG: 行き先が実行時に決まる分岐は「分からない」ままにする', () => {
  const m = build(['ldr x8, [x0]', 'br x8']);
  const cfg = buildCfg(m, { rowOfAddress: rowOfBase(BASE, 2) });
  const last = cfg.nodes[cfg.nodes.length - 1];
  ok(last.succ.some((s) => s.kind === 'unknown'), '行き先不明を握りつぶしている');
  ok(outline(cfg).length >= 1);
});

/* ────────────────────────────────────────────────────────────
   関数レポート（js/report.js）— 事実 / 推測 / 不明の分離
   ──────────────────────────────────────────────────────────── */

const { buildFunctionReport, CERTAINTY } = await import('../js/report.js');
const {
  factText, inferenceText, unknownText, nextStepText, reasonText, updateLines,
  useText, shapeText, starsText, certaintyWord,
  findingTitle, findingWhy, notableReasonText, autoStepText,
} = await import('../js/narrate.js');

const REGION = { vmAddr: BASE, size: 0x1000n };

test('REPORT: 事実・推測・不明が混ざらない', () => {
  const m = build([
    'stp x29, x30, [sp, #-0x10]!',
    'mov x29, sp',
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #0xa',
    'str w8, [x0, #0x20]',
    'cmp w8, #0x64',
    'bl #0x100000100',
    'ldp x29, x30, [sp], #0x10',
    'ret',
  ], { '0x100000100': '_applyDamage' });

  const rep = buildFunctionReport({ model: m, region: REGION, name: '-[Battle calc]' });
  ok(rep, 'レポートが作れていない');
  ok(rep.facts.every((f) => f.certainty === CERTAINTY.FACT), '事実の欄に事実でないものが混ざっている');
  ok(rep.inferences.every((i) => i.certainty === CERTAINTY.INFERENCE), '推測の欄が汚れている');
  ok(rep.unknowns.every((u) => u.certainty === CERTAINTY.UNKNOWN), '不明の欄が汚れている');
  ok(rep.inferences.every((i) => i.confidence > 0 && i.confidence <= 1), '確度のない推測がある');
  ok(rep.inferences.every((i) => Array.isArray(i.evidence)), '根拠のない推測がある');

  const codes = rep.facts.map((f) => f.code);
  ok(codes.includes('value-update'), '値の書き換えを事実として拾っていない');
  ok(codes.includes('compare-const'), 'しきい値の比較を拾っていない');
  ok(codes.includes('call-named'), '呼んでいる相手を拾っていない');
  // 静的解析の限界は必ず書く
  ok(rep.unknowns.some((u) => u.code === 'runtime-meaning'), '限界を言っていない');
});

test('REPORT: 変更候補には必ず但し書きが付く', () => {
  const m = build([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #0xa',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const rep = buildFunctionReport({ model: m, region: REGION });
  eq(rep.editTargets.length, 1);
  eq(rep.editTargets[0].caveat, 'runtime-unverified', '保証できないことを明示していない');
  ok(rep.editTargets[0].evidence.length >= 3, '根拠が足りない');
  const lines = updateLines(rep.editTargets[0]);
  eq(lines.length, 4, '変更対象・変更前・演算・変更後の 4 行になっていない');
  has(lines, '変更対象');
  has(lines, '10 を足す');
});

test('REPORT: 目的を渡すと、関係の有無を根拠つきで言う', () => {
  const m = build(['adrp x0, #0x100001000', 'add x0, x0, #0x10', 'bl #0x100000100', 'ret'],
    { '0x100000100': '_log' });
  attachTexts(m, new Map([['' + 0x100001010n, 'damage applied: %d']]), new Set());
  const rep = buildFunctionReport({
    model: m, region: REGION, goal: goalFromPreset('damage'), name: 'sub_1',
  });
  const rel = rep.inferences.find((i) => i.code === 'goal-related');
  ok(rel, '目的との関係を言っていない');
  ok(rel.evidence.length >= 1, '関係があると言いながら根拠がない');
  ok(rel.confidence < 1, '静的解析だけで断定している');

  const other = buildFunctionReport({ model: m, region: REGION, goal: goalFromPreset('ads') });
  ok(other.unknowns.some((u) => u.code === 'goal-unrelated'), '関係がないときにそう言えていない');
});

test('REPORT: 次に何をすればいいかを必ず出す', () => {
  const m = build(['ldr w8, [x0, #0x20]', 'str w8, [x0, #0x20]', 'ret']);
  const rep = buildFunctionReport({ model: m, region: REGION });
  ok(rep.nextSteps.length >= 2, '案内が足りない');
  ok(rep.nextSteps.every((s) => nextStepText(s).length > 0), '文にできない案内がある');
  ok(rep.nextSteps.some((s) => s.code === 'verify-runtime'), '最後に実機で確かめる案内がない');
});

test('REPORT 異常: 空の関数でも落ちず、分からないと言える', () => {
  const m = build(['.byte 0x00, 0x00, 0x00, 0x00']);
  const rep = buildFunctionReport({ model: m, region: REGION });
  ok(rep, '落ちている');
  ok(rep.unknowns.length >= 1);
  eq(rep.editTargets.length, 0, '根拠なく変更候補を出している');
  eq(buildFunctionReport({}), null, 'モデルなしでも null を返す');
});

test('NARRATE: 新しいコードがすべて日本語になる（言い漏らしがない）', () => {
  const factCodes = ['instructions', 'calls', 'call-named', 'selector', 'string-ref', 'loops',
    'conditionals', 'memory', 'returns-value', 'arguments', 'numeric', 'value-update',
    'compare-const', 'callers', 'no-callers', 'indirect-calls'];
  const details = {
    instructions: { n: 1 }, calls: { n: 1, named: 1 }, 'call-named': { name: '_x' },
    selector: { selector: 's' }, 'string-ref': { text: 'a', addr: 1n }, loops: { n: 1 },
    conditionals: { n: 1 }, memory: { loads: 1, stores: 1 }, 'returns-value': null,
    arguments: { regs: [0] }, numeric: { mul: 1 },
    'value-update': { kind: 'read-modify-write', base: 'x0', disp: 8n, ops: [{ op: 'add', imm: 1n }] },
    'compare-const': { value: 1n, register: 'x0' }, callers: { n: 1 }, 'no-callers': null,
    'indirect-calls': { n: 1 },
  };
  for (const code of factCodes) {
    ok(factText({ code, detail: details[code] }).length > 0, code + ' の文がない');
  }
  for (const code of ['purpose-feature', 'purpose-selector', 'value-holder', 'threshold-check', 'goal-related']) {
    const text = inferenceText({
      code, detail: { features: ['data'], selectors: ['a'], base: 'x0', disp: 8n, label: 'HP' },
    });
    ok(text.length > 0, code + ' の文がない');
  }
  for (const code of ['indirect-target', 'unnamed-calls', 'no-strings', 'truncated',
    'stats-partial', 'goal-unrelated', 'runtime-meaning']) {
    ok(unknownText({ code, detail: { n: 1 } }).length > 0, code + ' の文がない');
  }
  for (const code of Object.values(REASON)) {
    if (code === 'no-evidence') continue;
    const text = reasonText({
      code, detail: { text: 'a', name: '_n', mul: 1, n: 2, toName: 'x', fromName: 'y' },
    });
    ok(text.length > 0, code + ' の理由の文がない');
  }
  for (const use of ['argument', 'store', 'compare', 'compute', 'address', 'returned',
    'overwritten', 'join', 'read']) {
    ok(useText({ use, detail: {} }).length > 0, use + ' の文がない');
  }
  for (const kind of ['loop', 'if', 'if-else', 'early-return']) {
    ok(shapeText({ kind }).length > 0, kind + ' の文がない');
  }
  eq(starsText(5), '★★★★★');
  eq(starsText(0), '★☆☆☆☆', '星は最低 1 つ');
  ok(certaintyWord('fact').length > 0);
  ok(certaintyWord('inference').length > 0);
  ok(certaintyWord('unknown').length > 0);
});

/* ────────────────────────────────────────────────────────────
   自動解析（js/auto.js）— 何も指示しなくても分かることを全部やる
   ──────────────────────────────────────────────────────────── */

const { autoAnalyze, autoNextSteps, notableFunctions, findings } = await import('../js/auto.js');

/** 目的つきの小さな世界を 1 つ作る。 */
function tinyWorld() {
  const CALC = PC;                 // ダメージ計算らしい関数
  const CALLER = PC + 0x40n;       // それを呼ぶ関数
  const STR = 0x200000000n;
  const URL = 0x200000100n;
  const symbols = new SymbolIndex({
    addrs: BigUint64Array.from([CALC, CALLER]),
    kinds: Uint8Array.from([0, 0]),
    names: '_calcDamage\n_battleTurn',
    funcs: BigUint64Array.from([CALC, CALLER, PC + 0x80n]),
  });
  const K = W.KIND;
  const scan = fakeScan({
    refs: [[CALC + 8n, STR, 0], [CALLER + 8n, URL, 0]],
    calls: [[CALLER + 0x10n, CALC], [PC + 0x84n, CALC], [PC + 0x88n, CALC]],
    kinds: [[0, K.LOAD], [1, K.MUL], [2, K.STORE], [3, K.CMP], [4, K.RET],
      [16, K.LOAD], [17, K.STORE], [18, K.CALL]],
    words: 64,
  });
  const region = { vmAddr: PC, size: 0x100n };
  return {
    symbols, region,
    program: new ProgramIndex(scan, symbols, region),
    strings: [
      { addr: STR, text: 'damage dealt to enemy: %d' },
      { addr: URL, text: 'https://api.example.com/v1/battle' },
      { addr: 0x200000200n, text: 'jailbreak detected' },
    ],
    CALC, CALLER,
  };
}

test('AUTO: 何も指示しなくても、目的ごとの最有力候補まで出す', async () => {
  const w = tinyWorld();
  const report = await autoAnalyze({
    strings: w.strings, program: w.program, symbols: w.symbols, region: w.region,
    deepLimit: 0,
  });
  ok(report.goals.length >= 1, '目的が 1 つも採点されていない');
  const dmg = report.goals.find((g) => g.goal.id === 'damage');
  ok(dmg, 'ダメージの目的が出ていない');
  eq(dmg.best.addr, w.CALC, '最有力候補が違う');
  ok(dmg.best.reasons.length >= 2, '根拠が 1 本しかない');
  // 強い目的が先に来る
  ok(report.goals[0].best.score >= report.goals[report.goals.length - 1].best.score);
  eq(report.stats.calls, 3);
  eq(report.stats.strings, 3);
});

test('AUTO: 通信先や改造検知を、参照元つきで拾う', () => {
  const w = tinyWorld();
  const f = findings(w.strings, w.program, w.symbols);
  const endpoint = f.find((x) => x.id === 'endpoint');
  ok(endpoint, '通信先を拾えていない');
  eq(endpoint.users.length, 1, '参照元をたどれていない');
  eq(endpoint.users[0].name, '_battleTurn');
  ok(f.some((x) => x.id === 'anticheat'), '改造検知の手がかりを拾えていない');
  // 参照元が見つからないものも捨てずに残す（ただし後ろに回す）
  const anti = f.find((x) => x.id === 'anticheat');
  eq(anti.users.length, 0);
  ok(f.indexOf(endpoint) < f.indexOf(anti), '参照元つきを先に出していない');
});

test('AUTO: 名前や文字列に頼らず「注目すべき処理」を選べる', () => {
  const w = tinyWorld();
  const notable = notableFunctions(w.program, w.symbols, w.region);
  ok(notable.length >= 1, '注目すべき処理が出ていない');
  eq(notable[0].addr, w.CALC, 'よく呼ばれ、計算している関数が先頭に来ていない');
  const codes = notable[0].reasons.map((r) => r.code);
  ok(codes.includes('called'), '呼ばれた回数を根拠にしていない');
  ok(codes.includes('numeric'), '計算の実在を根拠にしていない');
  ok(notable[0].reasons.every((r) => notableReasonText(r).length > 0), '文にできない根拠がある');
});

test('AUTO: 上位だけ中身まで読み、値の書き換えを自動で見つける', async () => {
  const w = tinyWorld();
  const asked = [];
  const model = build([
    'ldr w8, [x0, #0x20]',
    'mul w8, w8, w1',
    'str w8, [x0, #0x20]',
    'cmp w8, #0x64',
    'ret',
  ]);
  const report = await autoAnalyze({
    strings: w.strings, program: w.program, symbols: w.symbols, region: w.region,
    deepLimit: 2,
    // 特定（pinpoint）にも逆アセンブルの予算があるので、ここでは切って
    // 深掘りの上限だけを見る。特定側の上限は PINPOINT のテストで見ている。
    pinpointBudget: 0,
    analyze: async (addr) => { asked.push(addr); return model; },
  });
  ok(asked.length > 0, '深掘りをしていない');
  ok(asked.length <= 2, '深掘りの上限を守っていない');
  ok(report.deep.length >= 1, '深掘りの結果がない');
  const hit = report.deep.find((d) => d.updates.length);
  ok(hit, '値の書き換えを見つけられていない');
  eq(hit.updates[0].location.disp, 0x20n);
  ok(hit.compares.length >= 1, 'しきい値を拾えていない');

  const steps = autoNextSteps(report);
  ok(steps.length >= 2);
  eq(steps[0].code, 'open-update', '最初の案内が「書き換えている場所を見る」になっていない');
  ok(steps.every((s) => autoStepText(s).length > 0), '文にできない案内がある');
});

test('AUTO: 途中でやめられる（大きなファイルで待たせない）', async () => {
  const w = tinyWorld();
  let n = 0;
  const report = await autoAnalyze({
    strings: w.strings, program: w.program, symbols: w.symbols, region: w.region,
    deepLimit: 4,
    analyze: async () => { n++; return null; },
    isCancelled: () => n >= 1,
  });
  ok(report.notes.includes('deep-cancelled') || report.deep.length === 0, '中断できていない');
  ok(n <= 2, '中断後も解析を続けている');
});

test('AUTO 異常: 手がかりが何もなくても落ちず、そう言える', async () => {
  const symbols = new SymbolIndex({ funcs: BigUint64Array.from([PC]) });
  const report = await autoAnalyze({
    strings: [], program: new ProgramIndex(fakeScan({}), symbols, { vmAddr: PC, size: 0x100n }),
    symbols, region: { vmAddr: PC, size: 0x100n }, deepLimit: 0,
  });
  eq(report.goals.length, 0);
  eq(report.findings.length, 0);
  const steps = autoNextSteps(report);
  ok(steps.some((s) => s.code === 'nothing-found'), '見つからなかったことを言えていない');
  // 索引そのものがなくても落ちない
  const empty = await autoAnalyze({});
  ok(empty && Array.isArray(empty.goals));
});

/* ────────────────────────────────────────────────────────────
   クラスとフィールド（js/objc.js, js/fields.js）

   [x0, #0x20] を self.hp と言えるかどうか。ここがこのツールの分かりやすさの要。
   ──────────────────────────────────────────────────────────── */

const { buildObjcModel, decodeTypeEncoding, parsePropertyAttributes } = await import('../js/objc.js');
const { FieldIndex, plainFieldName } = await import('../js/fields.js');
const { buildSampleBinary } = await import('../js/sample.js');

/** 練習用サンプルを 1 枚のメモリとして読む（本物と同じ経路で確かめる）。 */
function sampleReader() {
  const bytes = buildSampleBinary();
  const base = 0x100000000n;
  return async (addr, len) => {
    const off = Number(addr - base);
    if (off < 0 || off >= bytes.length) return null;
    return bytes.subarray(off, Math.min(bytes.length, off + len));
  };
}
const SAMPLE_CLASSLIST = { vmAddr: 0x100004100n, size: 8n };

test('OBJC: クラス表から、値の名前・型・位置まで取り出せる', async () => {
  const model = await buildObjcModel(sampleReader(), SAMPLE_CLASSLIST);
  eq(model.count, 1, 'クラスが読めていない');
  const c = model.classes[0];
  eq(c.name, 'BattleManager');
  eq(c.instanceSize, 0x28);
  eq(c.methods.length, 2, 'メソッドが読めていない');
  eq(c.methods[0].sel, 'applyDamage:');
  eq(c.methods[0].kind, '-');

  eq(c.ivars.length, 2, '値（ivar）が読めていない');
  eq(c.ivars[0].name, '_hp');
  eq(c.ivars[0].offset, 0x20, '位置が違う');
  eq(c.ivars[0].size, 4);
  eq(c.ivars[0].type.kind, 'int');
  eq(c.ivars[0].type.bytes, 4);
  eq(c.ivars[1].name, '_attack');
  eq(c.ivars[1].offset, 0x24);
});

test('OBJC: プロパティの属性から、型と裏の ivar 名を取り出せる', () => {
  const a = parsePropertyAttributes('Ti,N,V_hp');
  eq(a.type, 'i');
  eq(a.ivar, '_hp');
  eq(a.readonly, false);

  const b = parsePropertyAttributes('T@"NSString",R,C,V_name');
  eq(b.type, '@"NSString"');
  eq(b.ivar, '_name');
  eq(b.readonly, true);

  // 別名のアクセサ
  const c = parsePropertyAttributes('TB,N,Gready,SsetReady:,V_ready');
  eq(c.getter, 'ready');
  eq(c.setter, 'setReady:');

  // 構造体の型にはカンマが入る。区切りに巻き込まない。
  const d = parsePropertyAttributes('T{CGRect={CGPoint=dd}{CGSize=dd}},N,V_frame');
  eq(d.type, '{CGRect={CGPoint=dd}{CGSize=dd}}');
  eq(d.ivar, '_frame');

  // 読めないものは、読めたことにしない
  eq(parsePropertyAttributes('').ivar, null);
  eq(parsePropertyAttributes(null).type, null);
});

test('OBJC: 型の書き方を、意味の分かる形にほどける', () => {
  eq(decodeTypeEncoding('i').kind, 'int');
  eq(decodeTypeEncoding('i').bytes, 4);
  eq(decodeTypeEncoding('q').bytes, 8);
  eq(decodeTypeEncoding('f').kind, 'float');
  eq(decodeTypeEncoding('B').kind, 'bool');
  eq(decodeTypeEncoding('@"NSString"').kind, 'object');
  eq(decodeTypeEncoding('@"NSString"').className, 'NSString');
  eq(decodeTypeEncoding('@?').kind, 'block');
  eq(decodeTypeEncoding('^i').kind, 'pointer');
  eq(decodeTypeEncoding('{CGRect=dddd}').kind, 'struct');
  eq(decodeTypeEncoding('{CGRect=dddd}').name, 'CGRect');
  eq(decodeTypeEncoding('').kind, 'unknown', '読めないものを読めたことにしている');
  eq(decodeTypeEncoding('zzz').kind, 'unknown');
});

test('FIELDS: [x0, #0x20] を self の hp として解決できる', async () => {
  const model = await buildObjcModel(sampleReader(), SAMPLE_CLASSLIST);
  const fields = new FieldIndex(model);
  eq(fields.classCount, 1);
  eq(fields.fieldCount, 2);

  const owner = fields.ownerOf(model.classes[0].methods[0].addr);
  ok(owner, 'メソッドの持ち主が分からない');
  eq(owner.className, 'BattleManager');
  eq(owner.sel, 'applyDamage:');

  const hit = fields.resolveAccess({ base: 'x0', disp: 0x20n }, 'BattleManager');
  ok(hit, '解決できていない');
  eq(hit.plain, 'hp');
  eq(hit.certain, false, 'physical x0 alone must not prove self');
  eq(hit.exact, true);
  const provenX0 = fields.resolveAccess({ base: 'x0', disp: 0x20n, self: true }, 'BattleManager');
  ok(provenX0 && provenX0.certain === true, 'entry-self provenance should make x0 certain');

  // 別のレジスタ経由は「self とは限らない」ので確定させない
  const viaX19 = fields.resolveAccess({ base: 'x19', disp: 0x20n }, 'BattleManager');
  ok(viaX19 && viaX19.certain === false, 'self でないものを self と言い切っている');
  // dataflow が x19 に self を持ち回っていることまで証明した場合は、x0 と同じく確定できる。
  const provenX19 = fields.resolveAccess({ base: 'x19', disp: 0x20n, self: true }, 'BattleManager');
  ok(provenX19 && provenX19.certain === true, 'self 追跡済みのレジスタを未確定に戻している');
  eq(fields.resolveAccess({ base: 'x8', disp: 0x20n }, 'BattleManager'), null,
    '関係のないレジスタまで self 扱いしている');
  eq(fields.resolveAccess({ base: 'x0', disp: 0x99n }, 'BattleManager'), null,
    '存在しない位置に名前を付けている');
  eq(fields.resolveAccess({ base: 'x0', disp: 0x20n }, 'NoSuchClass'), null);
});

test('FIELDS: 名前で値を探せる（HP を探したい、に答える）', async () => {
  const fields = new FieldIndex(await buildObjcModel(sampleReader(), SAMPLE_CLASSLIST));
  const hp = fields.findFields(/hp/i);
  eq(hp.length, 1);
  eq(hp[0].className, 'BattleManager');
  eq(hp[0].field.offset, 0x20);
  eq(fields.findFields('zzz').length, 0);
  eq(fields.findClasses(/battle/i).length, 1);
  eq(plainFieldName('_hp'), 'hp');
  eq(plainFieldName('__attack'), 'attack');
});

test('FIELDS 異常: クラス表がなくても落ちない', () => {
  const empty = new FieldIndex(null);
  eq(empty.classCount, 0);
  eq(empty.ownerOf(1n), null);
  eq(empty.fieldAt('X', 0), null);
  eq(empty.resolveAccess({ base: 'x0', disp: 0n }, 'X'), null);
  eq(empty.findFields('a').length, 0);
});

/* ────────────────────────────────────────────────────────────
   アプリの地図（js/appmap.js）
   ──────────────────────────────────────────────────────────── */

const { buildAppMap, buildStringMap, classifyClassName } = await import('../js/appmap.js');

/** クラス名だけを持つ、簡単な索引を作る。 */
function classIndex(names) {
  return new FieldIndex({
    classes: names.map((n, i) => ({
      name: n, addr: BigInt(i + 1), superName: null, instanceSize: 8,
      methods: [{ addr: BigInt(0x1000 + i * 0x10), sel: 'run', kind: '-' }],
      ivars: [],
    })),
  });
}

test('MAP: クラス名から担当を見分けられる', () => {
  const of = (name) => {
    const hits = classifyClassName(name);
    return hits.length ? hits.sort((a, b) => b.points - a.points)[0].id : null;
  };
  eq(of('BattleManager'), 'battle');
  eq(of('ShopViewController'), 'purchase', 'ViewController の語に引っぱられている');
  eq(of('APIClient'), 'network');
  eq(of('GachaResultView'), 'gacha');
  eq(of('JailbreakDetector'), 'anticheat');
  eq(of('SaveDataManager'), 'save');
  eq(of('ZzzThing'), null, '当たらない名前に無理やり分類を付けている');
});

test('MAP: アプリを部品ごとに束ねる（1 画面に出るものを減らす）', () => {
  const fields = classIndex([
    'BattleManager', 'EnemyUnit', 'ShopViewController', 'APIClient', 'ZzzThing',
  ]);
  const map = buildAppMap({ fields, strings: [] });
  ok(map.hasClasses);
  eq(map.classCount, 5);
  const battle = map.subsystems.find((s) => s.id === 'battle');
  ok(battle, 'バトルの部品がない');
  eq(battle.classCount, 2, 'BattleManager と EnemyUnit がまとまっていない');
  ok(battle.icon.length > 0, '見出しの絵文字がない');
  ok(map.subsystems.every((s) => s.id !== 'unknown'), '未分類を部品として出している');
  eq(map.unclassified, 1, '分類できなかったものを数えていない');
  // どの部品にも、なぜそう分類したかの根拠が残っている
  ok(battle.classes[0].why.length >= 1, '分類の根拠がない');
});

test('MAP: クラスがないバイナリでも、文字列から粗い地図を作れる', () => {
  const symbols = new SymbolIndex({
    addrs: BigUint64Array.from([PC]), kinds: Uint8Array.from([0]),
    names: 'sub_a', funcs: BigUint64Array.from([PC, PC + 0x40n]),
  });
  const STR = 0x200000000n;
  const program = new ProgramIndex(fakeScan({ refs: [[PC + 4n, STR, 0]] }), symbols,
    { vmAddr: PC, size: 0x100n });
  const map = buildStringMap({
    program, symbols,
    strings: [{ addr: STR, text: 'ガチャを引く' }],
  });
  eq(map.hasClasses, false);
  eq(map.byStrings, true);
  const gacha = map.subsystems.find((s) => s.id === 'gacha');
  ok(gacha, 'ガチャの部品がない');
  eq(gacha.functions.length, 1, '参照している関数を結びつけていない');
  eq(gacha.functions[0].addr, PC);
});

/* ────────────────────────────────────────────────────────────
   説明の 1 段目（ひとこと）
   ──────────────────────────────────────────────────────────── */

const { oneLiner, whatItDoes, changeVerb, typeWord, placeName, fieldName } =
  await import('../js/narrate.js');

test('ONELINER: 値の変更を、まず 1 行で言える', async () => {
  const fields = new FieldIndex(await buildObjcModel(sampleReader(), SAMPLE_CLASSLIST));
  const m = build([
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, #0xa',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const rep = buildFunctionReport({
    model: m, region: REGION, fields,
    owner: { className: 'BattleManager', sel: 'applyDamage:', kind: '-' },
  });
  const line = oneLiner(rep, null);
  has(line, 'hp', 'フィールド名が出ていない');
  has(line, '10 減らす', '何をどれだけ変えるのかが出ていない');
  ok(line.indexOf('x0 + 0x20') < 0, 'レジスタとずらし幅のまま説明している');

  const what = whatItDoes(rep);
  ok(what.length >= 1);
  has(what.join('\n'), 'hp');
});

test('ONELINER: 変更がなければ、別の言い方に落とす', () => {
  const m = build(['bl #0x100000100', 'ret'], { '0x100000100': '_NSLog' });
  const rep = buildFunctionReport({ model: m, region: REGION });
  ok(oneLiner(rep, null).length > 0, '1 行の説明が作れていない');

  const empty = buildFunctionReport({ model: build(['ret']), region: REGION });
  has(oneLiner(empty, null), '特定できません', '分からないときに分からないと言えていない');
});

test('ONELINER: 演算の言い換えに漏れがない', () => {
  for (const op of ['add', 'sub', 'mul', 'sdiv', 'fmul', 'lsl', 'mov', 'and', 'zzz']) {
    ok(changeVerb({ op, imm: 3n }).length > 0, op + ' の言い換えがない');
    ok(changeVerb({ op, imm: null }).length > 0, op + '（数なし）の言い換えがない');
  }
  ok(changeVerb(null).length > 0);
  has(changeVerb({ op: 'add', imm: 5n }), '5 増やす');
  has(changeVerb({ op: 'sub', imm: 5n }), '5 減らす');
  has(changeVerb({ op: 'lsl', imm: 2n }), '4 倍');
});

test('ONELINER: 型と場所の言い換え', () => {
  eq(typeWord({ kind: 'int', bytes: 4 }), '4 バイトの整数');
  eq(typeWord({ kind: 'object', className: 'NSString' }), 'NSString のオブジェクト');
  eq(typeWord({ kind: 'unknown' }), null, '分からない型に名前を付けている');
  eq(typeWord(null), null);
  eq(fieldName({ plain: 'hp', className: 'BattleManager' }), 'BattleManager の hp');
  eq(placeName(null, 'x0', 0x20n), 'x0 + 0x20', 'フィールドが分からないのに名前を作っている');
  eq(placeName({ plain: 'hp', className: 'C' }, 'x0', 0x20n), 'C の hp');
});

/* ────────────────────────────────────────────────────────────
   証拠の合成（js/evidence.js）

   点を足すのではなく、尤度比を掛ける。ここが正しくないと
   「87%」がまた意味のない数字に戻ってしまうので、境目を細かく見る。
   ──────────────────────────────────────────────────────────── */

const {
  evidence, fuse, decide, explain, starsOf, verdictRank, VERDICT, FAMILY,
} = await import('../js/evidence.js');

test('EVIDENCE: 候補が多いほど、同じ証拠でも確からしさは低くなる', () => {
  const ev = [evidence('field-name-exact', 1, {})];
  const few = fuse(ev, { candidates: 10 });
  const many = fuse(ev, { candidates: 20000 });
  ok(few.probability > many.probability,
    '候補が 2 万個あっても、10 個のときと同じ確からしさになっている');
  ok(many.probability < 0.05, '名前が当たっただけで確定に近づいている: ' + many.probability);
  ok(few.prior < 0.2, '「どれでもない」を選択肢に入れていない');
});

test('EVIDENCE: 同じ系統の証拠をいくら並べても確定にはならない', () => {
  const only名前 = fuse([
    evidence('field-name-exact', 1, {}),
    evidence('field-name-strong', 1, {}),
    evidence('property-name', 1, {}),
    evidence('accessor-name', 1, {}),
  ], { candidates: 200 });
  const withOthers = fuse([
    evidence('field-name-exact', 1, {}),
    evidence('getter-verified', 1, {}),
    evidence('class-category', 1, {}),
  ], { candidates: 200 });
  ok(withOthers.logOdds > only名前.logOdds,
    '名前ばかり 4 つの方が、種類の違う 3 つより強くなっている');
  ok(only名前.families.length === 1, '名前だけなのに系統が複数あることになっている');
});

test('EVIDENCE: 打ち消す証拠は確からしさを下げる', () => {
  const plain = fuse([evidence('field-name-exact', 1, {})], { candidates: 200 });
  const conflict = fuse([
    evidence('field-name-exact', 1, {}),
    evidence('type-conflict', 1, {}),
  ], { candidates: 200 });
  ok(conflict.logOdds < plain.logOdds, '型が合わないのに点が下がっていない');
});

test('EVIDENCE: 確定を名乗るには、検証・独立性・差の 3 つがそろう必要がある', () => {
  const strong = () => [
    evidence('field-name-exact', 1, {}),
    evidence('getter-verified', 1, {}),
    evidence('setter-verified', 1, {}),
    evidence('class-category', 1, {}),
    evidence('type-numeric', 1, {}),
  ];
  const mk = (ev) => ({ fusion: fuse(ev, { candidates: 200 }) });

  // そろっていれば確定
  const good = decide([mk(strong()), mk([evidence('field-name-weak', 0.4, {})])]);
  eq(good.verdict, VERDICT.CONFIRMED);

  // 逆アセンブルでの裏取りがなければ、点がいくら高くても確定にしない
  const noVerify = decide([
    mk([evidence('field-name-exact', 1, {}), evidence('class-category', 1, {}),
      evidence('type-numeric', 1, {}), evidence('sibling-fields', 1, {}),
      evidence('selector-match', 1, {})]),
    mk([evidence('field-name-weak', 0.3, {})]),
  ]);
  ok(noVerify.verdict !== VERDICT.CONFIRMED, '命令で確かめずに確定と言っている');
  ok(noVerify.missing.includes('need-verification'));

  // 2 位が拮抗していれば確定にしない
  const tie = decide([mk(strong()), mk(strong())]);
  ok(tie.verdict !== VERDICT.CONFIRMED, '同点なのに 1 位を確定と言っている');
  ok(tie.missing.includes('need-separation'));
});

test('EVIDENCE: 名前が読めない相手を「確定」と呼ばせない', () => {
  const mk = (ev) => ({ fusion: fuse(ev, { candidates: 60 }) });
  const list = [
    mk([evidence('loc-rmw', 1, {}), evidence('loc-in-goal-fn', 1, {}),
      evidence('loc-shared', 1, {}), evidence('loc-size', 1, {}),
      evidence('loc-not-stack', 1, {})]),
    mk([evidence('loc-size', 0.4, {})]),
  ];
  const capped = decide(list, { maxVerdict: VERDICT.LIKELY });
  ok(verdictRank(capped.verdict) <= verdictRank(VERDICT.LIKELY),
    '名前が無いのに確定と言っている');
  ok(capped.missing.includes('no-name'));
});

test('EVIDENCE: 内訳の掛け算が、出している確からしさと一致する', () => {
  const f = fuse([
    evidence('field-name-exact', 1, {}),
    evidence('getter-verified', 1, {}),
    evidence('class-category', 1, {}),
  ], { candidates: 500 });
  let logOdds = Math.log(f.prior / (1 - f.prior));
  for (const item of f.items) logOdds += item.applied;
  ok(Math.abs(logOdds - f.logOdds) < 1e-9,
    '内訳を足しても、出している数字にならない');
  const byExplain = explain(f).reduce((n, x) => n + x.applied, 0);
  ok(Math.abs((logOdds - Math.log(f.prior / (1 - f.prior))) - byExplain) < 1e-9,
    '画面に出す内訳と、実際の計算が食い違っている');
  eq(starsOf(f.probability, VERDICT.CONFIRMED), 5);
  eq(starsOf(0.05, null), 1);
  void FAMILY;
});

/* ────────────────────────────────────────────────────────────
   検証（js/verify.js）

   「表にそう書いてある」を「命令が本当にそう動く」に上げる層。
   ここが甘いと、確定の意味がなくなる。
   ──────────────────────────────────────────────────────────── */

const {
  verifyAccessor, fieldUse, verifyGuard, verifyFunctionHandlesField, selfRegisters,
} = await import('../js/verify.js');

test('VERIFY: getter を逆アセンブルして、位置が合っているか確かめられる', () => {
  const getter = build(['ldr w0, [x0, #0x20]', 'ret']);
  const hit = verifyAccessor(getter, { offset: 0x20n, size: 4 });
  eq(hit.getter, true);
  eq(hit.setter, false);
  eq(hit.exclusive, true, 'ほかの位置を触っていないことを見ていない');
  eq(hit.size, 4);

  // 位置が違えば、確かめられなかったと言う
  const miss = verifyAccessor(getter, { offset: 0x28n, size: 4 });
  eq(miss.getter, false, '位置が違うのに一致したことにしている');
});

test('VERIFY: setter が、引数の値を書いているところまで見る', () => {
  const setter = build(['str w2, [x0, #0x20]', 'ret']);
  const hit = verifyAccessor(setter, { offset: 0x20n, size: 4 });
  eq(hit.setter, true);
  eq(hit.fromArgument, true, '引数から来た値かどうかを見ていない');

  // self の別の値を写しているだけの関数は、setter とは呼ばない
  const copy = build(['ldr w8, [x0, #0x24]', 'str w8, [x0, #0x20]', 'ret']);
  const c = verifyAccessor(copy, { offset: 0x20n, size: 4 });
  eq(c.setter, true);
  eq(!!c.fromArgument, false, '引数でない値を引数から来たことにしている');
  eq(c.exclusive, false, 'ほかの位置も触っているのに専用扱いしている');
});

test('VERIFY: 長すぎる関数をアクセサとは呼ばない', () => {
  const lines = ['ldr w0, [x0, #0x20]'];
  for (let i = 0; i < 60; i++) lines.push('add w1, w1, #1');
  lines.push('ret');
  const hit = verifyAccessor(build(lines), { offset: 0x20n, size: 4 });
  eq(hit.getter, false, '60 命令の関数をアクセサと言っている');
});

test('VERIFY: self を持ち回っているレジスタだけを self として数える', () => {
  const m = build([
    'mov x19, x0',
    'ldr w8, [x19, #0x20]',
    'ldr w9, [x21, #0x20]',
    'ret',
  ]);
  const { set } = selfRegisters(m);
  ok(set.has('x19'), 'mov x19, x0 で写した self を追えていない');
  ok(!set.has('x21'), '関係のないレジスタを self とみなしている');

  const use = fieldUse(m, 0x20n);
  eq(use.loads, 1, 'よそのオブジェクトの同じ位置まで数えている');
});

test('VERIFY: 読んで計算して書き戻す形と、しきい値の判定を拾える', () => {
  const m = build([
    'mov x19, x0',
    'ldr w8, [x19, #0x20]',
    'sub w8, w8, w2',
    'str w8, [x19, #0x20]',
    'cmp w8, #0',
    'b.gt #0x100000030',
    'ret',
  ]);
  const use = fieldUse(m, 0x20n);
  eq(use.loads, 1);
  eq(use.stores, 1);
  eq(use.rmw.length, 1, '読んで計算して書き戻す形を見つけられていない');
  eq(use.compares.length, 1, 'しきい値の判定を拾えていない');
  eq(use.compares[0].value, 0n);

  const g = verifyGuard(m, 0x20n);
  eq(g.guards.length, 1);

  const handled = verifyFunctionHandlesField(m, 0x20n);
  eq(handled.touches, true);
  eq(handled.writes, true);
  eq(handled.rmw, true);
  eq(handled.guard, true);

  // 触っていない位置については、触っていないと言う
  eq(verifyFunctionHandlesField(m, 0x40n).touches, false);
});

test('VERIFY 異常: 空・壊れた命令列でも落ちない', () => {
  const empty = build([]);
  eq(verifyAccessor(empty, { offset: 0x20n }).getter, false);
  eq(verifyAccessor(null, { offset: 0x20n }).getter, false);
  eq(verifyAccessor(empty, null).getter, false);
  eq(fieldUse(empty, 0x20n).sites.length, 0);
  eq(fieldUse(null, 0x20n).sites.length, 0);
  const junk = build(['.byte 0x00, 0x01', 'zzz x0, x1', 'ldr w0, [']);
  ok(verifyAccessor(junk, { offset: 0x20n }) !== null);
});

/* ────────────────────────────────────────────────────────────
   特定（js/pinpoint.js）

   このツールの新しい中心。「選ぶだけで 1 個に決まる」が本当に成り立つか、
   そして **決まらないときに決まったと言わないか** を見る。
   ──────────────────────────────────────────────────────────── */

const { pinpointField, pinpointLocation, pinpointFunction } = await import('../js/pinpoint.js');
const { matchField, normalizeFieldName, fieldRole, typeFits, accessorKind } =
  await import('../js/goals.js');
const { EVIDENCE } = await import('../js/evidence.js');
const {
  verdictText, verdictLead, missingText, proofText, factorText, probabilityText,
  roleProofText, roleMissingText, fnRoleTitle, fnRoleShort, fnRoleLead,
  fnRoleTargetLine, fnRoleAlternative, fnRoleTopicLine, actionPhrase, topicLabel,
} = await import('../js/narrate.js');
const { inferRole, roleFromReport, ACTION, changesValue, actionDirection } =
  await import('../js/role.js');

const INT4 = { kind: 'int', bytes: 4, signed: true, enc: 'i' };
const OBJ = { kind: 'object', bytes: 8, enc: '@"NSString"', className: 'NSString' };

/* proofText はどのコードでも文にできなければならない。
   足りない材料があっても落ちないことまで、まとめて見る。 */
const PROOF_DETAIL = {
  name: '_hp', term: 'hp', className: 'BattleManager', sel: 'setHp:',
  offset: 0x20, size: 4, n: 2, value: 0n, type: INT4, addr: BASE, address: BASE,
  getter: 'hp', setter: 'setHp:', exclusive: true, base: 'x19', op: 'sub',
};

/** 名前・値・メソッドを持つクラス表を、手で組み立てる。 */
function classTable(defs) {
  return new FieldIndex({
    classes: defs.map((d, i) => ({
      name: d.name, addr: BigInt(i + 1), superName: d.superName || null,
      instanceSize: d.size || 0x40,
      ivars: d.ivars || [],
      properties: d.properties || [],
      methods: d.methods || [],
      classMethods: [],
    })),
  });
}

/** 逆アセンブル役。アドレスごとに命令列を返す。 */
function reader(bodies) {
  const calls = [];
  const fn = async (addr) => {
    calls.push(addr);
    const lines = bodies[addr.toString()];
    return lines ? build(lines, addr) : null;
  };
  fn.calls = calls;
  return fn;
}

const GETTER = 0x100001000n, SETTER = 0x100001100n, APPLY = 0x100001200n, OTHER = 0x100002000n;

function battleWorld() {
  const fields = classTable([
    {
      name: 'BattleManager',
      ivars: [
        { name: '_hp', offset: 0x20, size: 4, type: INT4 },
        { name: '_maxHp', offset: 0x24, size: 4, type: INT4 },
        { name: '_attack', offset: 0x28, size: 4, type: INT4 },
        { name: '_title', offset: 0x8, size: 8, type: OBJ },
      ],
      methods: [
        { addr: GETTER, sel: 'hp', kind: '-' },
        { addr: SETTER, sel: 'setHp:', kind: '-' },
        { addr: APPLY, sel: 'applyDamage:', kind: '-' },
      ],
    },
    {
      name: 'HealthBarView',
      ivars: [{ name: '_health', offset: 0x20, size: 4, type: INT4 }],
      methods: [{ addr: OTHER, sel: 'layout', kind: '-' }],
    },
  ]);
  const bodies = {
    [GETTER]: ['ldr w0, [x0, #0x20]', 'ret'],
    [SETTER]: ['str w2, [x0, #0x20]', 'ret'],
    [APPLY]: [
      'mov x19, x0',
      'ldr w8, [x19, #0x20]',
      'sub w8, w8, w2',
      'str w8, [x19, #0x20]',
      'cmp w8, #0',
      'ret',
    ],
    [OTHER]: ['ldr w0, [x0, #0x18]', 'ret'],
  };
  const map = {
    classes: [
      { name: 'BattleManager', category: 'battle' },
      { name: 'HealthBarView', category: 'ui' },
    ],
  };
  return { fields, bodies, map };
}

test('PINPOINT: HP を選ぶだけで BattleManager.hp が 1 個に決まる', async () => {
  const w = battleWorld();
  const analyze = reader(w.bodies);
  const res = await pinpointField({
    goal: goalFromPreset('hp'), fields: w.fields, map: w.map, analyze,
  });

  eq(res.verdict, VERDICT.CONFIRMED, '確定できていない: ' + res.missing.join(', '));
  eq(res.top.className, 'BattleManager');
  eq(res.top.plain, 'hp');
  eq(res.top.offset, 0x20);
  ok(res.marginRatio > 20, '2 位との差が小さいのに確定と言っている');
  ok(res.top.fusion.probability > 0.99);

  // 決め手が、名前ではなく逆アセンブルの結果であること
  const codes = res.top.why.map((x) => x.code);
  ok(codes.includes('getter-verified'), 'getter を確かめた証拠が残っていない');
  ok(codes.includes('setter-verified'), 'setter を確かめた証拠が残っていない');
  ok(res.top.why.every((x) => proofText(x).length > 0), '文にできない証拠がある');
});

test('PINPOINT: 上限（maxHp）を、今の値（hp）より上に出さない', async () => {
  const w = battleWorld();
  const res = await pinpointField({
    goal: goalFromPreset('hp'), fields: w.fields, map: w.map, analyze: reader(w.bodies),
  });
  const hp = res.candidates.findIndex((c) => c.plain === 'hp');
  const max = res.candidates.findIndex((c) => c.plain === 'maxHp');
  ok(hp >= 0 && max >= 0, '候補が足りない');
  ok(hp < max, '上限の方を上に出している（増やしたい値は上限ではない）');
  eq(res.candidates[hp].role, 'plain');
  eq(res.candidates[max].role, 'max');
});

test('PINPOINT: 目的に結びつかない値を「確定」と言わない（防御力を探して HP を出さない）', async () => {
  /*
   * BattleManager には防御力の値が無い。ところが _hp は
   *   ・バトルを担当するクラスにある
   *   ・4 バイトの整数である
   *   ・読んで計算して書き戻されているのを命令で確かめられる
   * を全部満たしてしまう。これを「防御力の確定」と言ってしまうのが、
   * このツールでいちばんやってはいけない間違い。
   */
  const w = battleWorld();
  const res = await pinpointField({
    goal: goalFromPreset('defense'), fields: w.fields, map: w.map, analyze: reader(w.bodies),
  });
  ok(res.verdict !== VERDICT.CONFIRMED,
    '防御力を探して、名前の裏づけがない値を確定と言っている');
  if (res.top) {
    ok(!(res.top.fusion.identifying > 0) || res.top.plain !== 'hp',
      'HP を防御力に結びつける手がかりがあることになっている');
    ok(res.missing.includes('need-name-evidence'),
      '目的に結びつく手がかりが無いことを言えていない');
  }

  // 名前が当たる目的では、これまでどおり確定できること（締めすぎていないか）
  const hp = await pinpointField({
    goal: goalFromPreset('hp'), fields: w.fields, map: w.map, analyze: reader(w.bodies),
  });
  eq(hp.verdict, VERDICT.CONFIRMED, '締めすぎて、当たる目的まで確定できなくなっている');
});

test('PINPOINT: 裏づけだけの証拠は、目的への結びつきが無いと効かない', () => {
  const corroborationOnly = fuse([
    evidence('class-category', 1, {}),
    evidence('type-numeric', 1, {}),
    evidence('size-fits', 1, {}),
    evidence('getter-verified', 1, {}),
    evidence('rmw-verified', 1, {}),
    evidence('written-in-class', 1, {}),
  ], { candidates: 2000 });
  const withName = fuse([
    evidence('field-name-exact', 1, {}),
    evidence('class-category', 1, {}),
    evidence('type-numeric', 1, {}),
    evidence('size-fits', 1, {}),
    evidence('getter-verified', 1, {}),
    evidence('rmw-verified', 1, {}),
    evidence('written-in-class', 1, {}),
  ], { candidates: 2000 });

  eq(corroborationOnly.identifying, 0, '結びつける証拠が無いのに 0 になっていない');
  ok(corroborationOnly.corroborationScale < 0.3, '結びつきが無いのに裏づけを満額で効かせている');
  ok(corroborationOnly.probability < 0.5,
    '名前の裏づけが無いのに確からしいことになっている: ' + corroborationOnly.probability);
  ok(withName.corroborationScale > 0.99, '名前が当たっているのに裏づけを割り引いている');
  // 名前 1 つの差が、裏づけ全部より大きく効く
  ok(withName.logOdds - corroborationOnly.logOdds > Math.log(50));
});

test('PINPOINT: 型が合わない値は候補から外す', async () => {
  const w = battleWorld();
  const res = await pinpointField({
    goal: goalFromPreset('money'), fields: w.fields, map: w.map, analyze: reader(w.bodies),
  });
  ok(!res.candidates.some((c) => c.plain === 'title'),
    '文字列のオブジェクトを、所持金の候補にしている');
});

test('PINPOINT: アクセサが位置と食い違うときは確定させない', async () => {
  const w = battleWorld();
  // getter が別の位置を読んでいる＝表と実装が食い違っている
  const bodies = Object.assign({}, w.bodies, {
    [GETTER]: ['ldr w0, [x0, #0x30]', 'ret'],
    [SETTER]: ['str w2, [x0, #0x30]', 'ret'],
    [APPLY]: ['ldr w0, [x0, #0x30]', 'ret'],
  });
  const res = await pinpointField({
    goal: goalFromPreset('hp'), fields: w.fields, map: w.map, analyze: reader(bodies),
  });
  ok(res.verdict !== VERDICT.CONFIRMED,
    '命令が表と食い違っているのに確定と言っている');
  ok(res.missing.includes('need-verification') || res.missing.includes('need-separation'));
});

test('PINPOINT: 逆アセンブルできないときは、確定ではなく「足りない」と言う', async () => {
  const w = battleWorld();
  const res = await pinpointField({
    goal: goalFromPreset('hp'), fields: w.fields, map: w.map,   // analyze なし
  });
  ok(res.top, '名前だけでも候補は出るはず');
  eq(res.top.plain, 'hp');
  ok(res.verdict !== VERDICT.CONFIRMED, '命令を 1 つも読まずに確定と言っている');
  ok(res.missing.includes('need-verification'));
  ok(res.missing.every((m) => missingText(m).length > 0), '文にできない不足がある');
});

test('PINPOINT: 逆アセンブルの回数は予算で頭打ちになる', async () => {
  const w = battleWorld();
  const analyze = reader(w.bodies);
  await pinpointField({
    goal: goalFromPreset('hp'), fields: w.fields, map: w.map, analyze,
    budget: { left: 2 },
  });
  ok(analyze.calls.length <= 2, '予算を超えて逆アセンブルしている: ' + analyze.calls.length);
});

test('PINPOINT: 途中でやめられる', async () => {
  const w = battleWorld();
  const analyze = reader(w.bodies);
  const res = await pinpointField({
    goal: goalFromPreset('hp'), fields: w.fields, map: w.map, analyze,
    isCancelled: () => true,
  });
  eq(analyze.calls.length, 0, 'やめると言われたのに読み始めている');
  ok(res.top, '中断しても、名前から分かることは返すべき');
});

test('PINPOINT: 当てはまる値がなければ、無いと言う', async () => {
  const w = battleWorld();
  const res = await pinpointField({
    goal: goalFromPreset('ads'), fields: w.fields, map: w.map, analyze: reader(w.bodies),
  });
  eq(res.verdict, VERDICT.NONE);
  eq(res.top, null, '当てはまらないのに 1 位をでっち上げている');

  // クラス表そのものが無いとき
  const none = await pinpointField({ goal: goalFromPreset('hp'), fields: new FieldIndex(null) });
  eq(none.verdict, VERDICT.NONE);
  ok(none.missing.includes('no-class-table'));
});

test('PINPOINT: 書き換えている場所まで出す', async () => {
  const w = battleWorld();
  const sites = [
    { addr: 0x10000120cn, kind: 'load', base: 'x19', size: 4 },
    { addr: 0x100001214n, kind: 'store', base: 'x19', size: 4 },
  ];
  const res = await pinpointField({
    goal: goalFromPreset('hp'), fields: w.fields, map: w.map, analyze: reader(w.bodies),
    program: {
      functionStartOf: () => APPLY,
      functionRange: (a) => ({ start: a, end: a + 0x40n }),
    },
    scanAccess: async (list) => {
      eq(list.length, 1, '決まった 1 個だけを走査するべき');
      eq(list[0].offset, 0x20);
      return new Map([['32', sites]]);
    },
  });
  eq(res.changeSites.length, 1, '関数ごとにまとめられていない');
  eq(res.changeSites[0].stores, 1);
  eq(res.changeSites[0].loads, 1);
  eq(res.changeSites[0].sameClass, true, '同じクラスの中であることを見ていない');
});

test('PINPOINT: プロパティ表から、潰された ivar 名を補える', async () => {
  const fields = classTable([{
    name: 'Wallet',
    ivars: [{ name: '_a1', offset: 0x10, size: 8, type: { kind: 'int', bytes: 8, enc: 'q' } }],
    properties: [{
      name: 'coin', ivar: '_a1', getter: 'coin', setter: 'setCoin:',
      type: { kind: 'int', bytes: 8, enc: 'q' },
    }],
    methods: [
      { addr: GETTER, sel: 'coin', kind: '-' },
      { addr: SETTER, sel: 'setCoin:', kind: '-' },
    ],
  }]);
  const res = await pinpointField({
    goal: goalFromPreset('money'), fields,
    analyze: reader({
      [GETTER]: ['ldr x0, [x0, #0x10]', 'ret'],
      [SETTER]: ['str x2, [x0, #0x10]', 'ret'],
    }),
  });
  ok(res.top, 'ivar 名が潰されていると何も出せていない');
  eq(res.top.offset, 0x10);
  const codes = res.top.why.map((x) => x.code);
  ok(codes.includes('property-name'), 'プロパティ名を根拠に使えていない');
  ok(codes.includes('getter-verified'), '別名のアクセサを追えていない');
});

test('PINPOINT: クラス表がなくても、形から場所を特定できる', async () => {
  const addr = 0x100003000n;
  const analyze = reader({
    [addr]: [
      'mov x19, x0',
      'ldr w8, [x19, #0x30]',
      'sub w8, w8, w1',
      'str w8, [x19, #0x30]',
      'cmp w8, #0',
      'ret',
    ],
  });
  const res = await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr, name: null, strings: [{ text: 'ダメージ %d', addr: 1n }] }],
    program: { functionRange: (a) => ({ start: a, end: a + 0x40n }) },
    analyze,
  });
  ok(res.top, '形から場所を決められていない');
  eq(res.top.kind, 'location');
  eq(res.top.offset, 0x30n);
  // 名前が読めない以上「確定」とは呼ばない
  ok(verdictRank(res.verdict) <= verdictRank(VERDICT.LIKELY),
    '名前が無いのに確定と言っている');
  ok(res.missing.includes('no-name'));
  const codes = res.top.why.map((x) => x.code);
  ok(codes.includes('loc-rmw'), '読んで計算して書き戻す形を根拠にできていない');
  ok(res.top.why.every((x) => proofText(x).length > 0), '文にできない証拠がある');
});

test('PINPOINT: スタックの一時置き場を「アプリが持っている値」と言わない', async () => {
  const addr = 0x100003100n;
  const res = await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr, name: null, strings: [] }],
    analyze: reader({
      [addr]: [
        'ldr w8, [sp, #0x8]',
        'add w8, w8, #1',
        'str w8, [sp, #0x8]',
        'ret',
      ],
    }),
  });
  eq(res.top, null, 'スタックの一時変数を値として出している');
  ok(res.missing.includes('no-value-change'));
});

test('PINPOINT: 特定した値を書き換えている処理を、命令で確かめて選ぶ', async () => {
  const hit = 0x100004000n, miss = 0x100004100n;
  const analyze = reader({
    [hit]: ['mov x19, x0', 'ldr w8, [x19, #0x20]', 'sub w8, w8, w2', 'str w8, [x19, #0x20]', 'ret'],
    [miss]: ['ldr w0, [x0, #0x80]', 'ret'],
  });
  const res = await pinpointFunction({
    goal: goalFromPreset('hp'),
    // わざと「触っていない方」を先頭にしておく
    ranked: [
      { addr: miss, name: 'sub_miss', reasons: [{ code: 'name-match', points: 25, detail: {} }], strings: [] },
      { addr: hit, name: 'sub_hit', reasons: [{ code: 'numeric', points: 12, detail: {} }], strings: [] },
    ],
    field: { offset: 0x20, className: 'BattleManager', plain: 'hp', name: '_hp' },
    program: { functionRange: (a) => ({ start: a, end: a + 0x40n }) },
    functionCount: 5000,
    analyze,
  });
  ok(res.top, '処理を決められていない');
  eq(res.top.addr, hit, '名前だけの候補が、値を実際に書き換えている処理より上に来ている');
  ok(res.top.why.some((x) => x.code === 'fn-writes-field'),
    '値を書き換えていることを根拠にできていない');
});

test('PINPOINT 語彙: 変数名を正規化してから当てる', () => {
  eq(normalizeFieldName('_currentHP'), 'current hp');
  eq(normalizeFieldName('m_hitPoint'), 'hit point');
  eq(normalizeFieldName('maxHP'), 'max hp');
  eq(normalizeFieldName('__attack_power'), 'attack power');

  // `\bhp\b` が `_hp` に当たらない問題が直っていること
  const hp = goalFromPreset('hp');
  ok(matchField(hp, '_hp'), '_hp に当たっていない（ここが当たらないと何も始まらない）');
  eq(matchField(hp, '_hp').exact, true);
  ok(matchField(hp, '_currentHP'), '_currentHP に当たっていない');
  eq(matchField(hp, '_maxHp').score < matchField(hp, '_hp').score, true,
    '上限と今の値を同じ強さで当てている');
  eq(matchField(hp, '_coinCount'), null, '関係のない名前に当てている');

  const fcm = parseGoal('fcm token');
  const fcmExactWords = matchField(fcm, '_cachedFCMToken');
  const genericToken = matchField(fcm, '_accessToken');
  ok(fcmExactWords && (fcmExactWords.sequence || fcmExactWords.words), '入力した fcm/token の両方を literal match として扱えていない');
  ok(genericToken && fcmExactWords.score > genericToken.score,
    '具体的な複数語入力より汎用語彙 token を強く扱っている');

  eq(fieldRole('_maxHp'), 'max');
  eq(fieldRole('_baseAttack'), 'base');
  eq(fieldRole('_hp'), 'plain');

  eq(typeFits(hp, INT4), 'fit');
  eq(typeFits(hp, OBJ), 'conflict');
  eq(typeFits(hp, { kind: 'int', bytes: 1, bool: true }), 'conflict', 'BOOL を HP 扱いしている');
  eq(typeFits(goalFromPreset('purchase'), INT4), 'unknown');

  eq(accessorKind('hp', '_hp'), 'getter');
  eq(accessorKind('setHp:', '_hp'), 'setter');
  eq(accessorKind('somethingElse', '_hp'), null);
});

test('PINPOINT: 自動解析に組み込まれ、決着したものが先に出る', async () => {
  const w = battleWorld();
  const symbols = new SymbolIndex({ funcs: BigUint64Array.from([GETTER, SETTER, APPLY, OTHER]) });
  const report = await autoAnalyze({
    strings: [], symbols, fields: w.fields,
    program: new ProgramIndex(fakeScan({}), symbols, { vmAddr: GETTER, size: 0x4000n }),
    region: { vmAddr: GETTER, size: 0x4000n },
    deepLimit: 0,
    analyze: reader(w.bodies),
  });
  ok(report.pinned.length >= 1, '特定の結果が report に入っていない');
  const hp = report.pinned.find((p) => p.goal.id === 'hp');
  ok(hp, 'HP を特定できていない');
  eq(hp.top.plain, 'hp');
  ok(report.confirmed.some((p) => p.goal.id === 'hp'), '確定したものが confirmed にない');
  // 決着したものが、確率の低いものより先に来る
  eq(report.pinned[0].verdict, VERDICT.CONFIRMED);

  const steps = autoNextSteps(report);
  eq(steps[0].code, 'open-pinned', '確定したのに、それを最初の案内にしていない');
  ok(steps.every((s) => autoStepText(s).length > 0), '文にできない案内がある');
});

test('PINPOINT: 本物のクラス表（練習用サンプル）から、アクセサ無しでも確定できる', async () => {
  const model = await buildObjcModel(sampleReader(), SAMPLE_CLASSLIST);
  const fields = new FieldIndex(model);
  eq(fields.classCount, 1);
  const apply = model.classes[0].methods.find((m) => m.sel === 'applyDamage:');
  ok(apply, 'サンプルの applyDamage: が読めていない');

  /*
   * サンプルの apply_damage は、ゲームの数値変更でいちばんよくある形をしている。
   * アクセサ（getter / setter）は無いので、決め手はこの本体を読むことだけになる。
   */
  const body = [
    'stp x29, x30, [sp, #-0x20]!',
    'mov x29, sp',
    'str x0, [sp, #0x10]',
    'ldr w8, [x0, #0x20]',
    'ldr w9, [x0, #0x24]',
    'mul w9, w1, w9',
    'sub w8, w8, w9',
    'str w8, [x0, #0x20]',
    'cmp w8, #0',
    'ret',
  ];
  const res = await pinpointField({
    goal: goalFromPreset('hp'),
    fields,
    map: { classes: [{ name: 'BattleManager', category: 'battle' }] },
    analyze: async (addr) => (addr === apply.addr ? build(body, addr) : null),
  });

  eq(res.verdict, VERDICT.CONFIRMED, '確定できていない: ' + res.missing.join(', '));
  eq(res.top.className, 'BattleManager');
  eq(res.top.plain, 'hp');
  eq(res.top.offset, 0x20);
  const codes = res.top.why.map((x) => x.code);
  ok(codes.includes('access-verified'), 'クラス自身のメソッドで確かめた証拠がない');
  ok(codes.includes('rmw-verified'), '読んで計算して書き戻す形を確かめられていない');
  ok(codes.includes('guard-verified'), 'しきい値の判定を拾えていない');
  // 攻撃力の方は、HP としては上に来ない
  ok(res.top.plain !== 'attack');
});

test('NARRATE: 特定まわりの言葉に、言い漏らしがない', () => {
  for (const v of ['confirmed', 'likely', 'ambiguous', 'none']) {
    ok(verdictText(v).length > 0, v + ' の言葉がない');
    ok(verdictLead(v).length > 0, v + ' の説明がない');
  }
  for (const m of ['need-verification', 'need-independent-evidence', 'need-more-evidence',
    'need-separation', 'no-class-table', 'no-match', 'no-name', 'no-value-change', 'no-candidate']) {
    ok(missingText(m).length > 0, m + ' の説明がない');
  }
  // 証拠のコードは、すべて日本語にできること（コードが画面に漏れない）
  for (const code of Object.keys(EVIDENCE)) {
    ok(roleProofText({ code, detail: PROOF_DETAIL, count: 1, factor: 2 }).length > 0,
      code + ' を文にできない');
  }
  eq(factorText(12).startsWith('×'), true);
  eq(factorText(0.5).startsWith('÷'), true);
  ok(probabilityText(0.9995).length > 0);
});

/* ────────────────────────────────────────────────────────────
   ケース R: 関数の役割 — 「sub_100A3C0 は何の処理か」を名指しできるか
   ────────────────────────────────────────────────────────────

   ここが崩れると、このツールは「命令は読めるが、何の処理かは分からない」
   ものに戻る。見ているのは 4 つ:

     1. 名前が読めるとき  … 機能・対象・動作の 3 つがそろって出るか
     2. 名前が無いとき    … 動作までは言い、機能を名乗らずに済ませられるか
     3. 動詞だけのとき    … 「+1 しているからアイテム獲得」と言い出さないか
     4. 手がかりが無いとき … 「名指しできません」と言えるか                */

/** アイテムの所持数を 1 増やすメソッド。獲得の文言も参照している。 */
const ITEM_BODY = [
  'stp x29, x30, [sp, #-0x10]!',
  'mov x29, sp',
  'ldr w8, [x0, #0x28]',
  'add w8, w8, #0x1',
  'str w8, [x0, #0x28]',
  'adrp x1, #0x100004000',
  'add x1, x1, #0x10',
  'bl #0x100000200',
  'ldp x29, x30, [sp], #0x10',
  'ret',
];

function itemModel() {
  const m = build(ITEM_BODY, { '0x100000200': '_NSLog' });
  attachTexts(m, new Map([['' + 0x100004010n, 'アイテムを獲得しました (%d 個)']]), new Set());
  return m;
}

const ITEM_FIELDS = classTable([{
  name: 'ItemManager',
  ivars: [{ name: '_itemCount', offset: 0x28, size: 4, type: INT4 }],
  methods: [{ addr: BASE, sel: 'addItem:', kind: '-' }],
}]);

test('ROLE: 名前が読めるなら「アイテムを 1 増やす処理」まで名指しできる', () => {
  const m = itemModel();
  const rep = buildFunctionReport({ model: m, region: REGION, fields: ITEM_FIELDS });
  const role = roleFromReport(rep, { apis: m.facts.apis });

  eq(role.action, ACTION.INCREASE, '動作を取り違えている');
  eq(String(role.amount), '1', '増える量を読み取れていない');
  eq(role.topic, 'item', 'アプリのどの機能かを言えていない: ' + role.topic);
  eq(role.subject.kind, 'field');
  eq(role.subject.name, '_itemCount');
  eq(role.subject.className, 'ItemManager');
  ok(verdictRank(role.verdict) >= verdictRank(VERDICT.LIKELY),
    '根拠がそろっているのに言い切れていない: ' + role.verdict + ' / ' + role.missing.join(', '));

  const title = fnRoleTitle(role);
  has(title, 'アイテム');
  has(title, '1 増やす');
  has(title, '処理');
  // 「変えているのはこの値」まで降りられること
  has(fnRoleTargetLine(role), 'ItemManager の itemCount');
  has(fnRoleShort(role), '+1');
  eq(actionDirection(role.action), 'up');
  eq(changesValue(role.action), true);
});

test('ROLE: なぜそう言えるのかを、証拠のまま並べられる', () => {
  const m = itemModel();
  const rep = buildFunctionReport({ model: m, region: REGION, fields: ITEM_FIELDS });
  const role = roleFromReport(rep, { apis: m.facts.apis });

  const codes = role.evidence.map((e) => e.code);
  ok(codes.includes('role-verb-rmw'), '読んで計算して書き戻す形を裏取りできていない: ' + codes.join(','));
  ok(codes.includes('role-subject-field'), '書き換え先の名前を根拠にできていない: ' + codes.join(','));
  ok(codes.some((c) => c === 'role-topic-string' || c === 'role-topic-selector'),
    '機能の手がかり（文言・メソッド名）を根拠にできていない: ' + codes.join(','));
  // 証拠は 1 本残らず日本語にできること（コードが画面に漏れない）
  for (const e of role.evidence) {
    ok(roleProofText(e).length > 0, e.code + ' を文にできない');
  }
  for (const code of role.missing) {
    ok(roleMissingText(code).length > 0, code + ' の理由を文にできない');
  }
});

test('ROLE: 名前が残っていないバイナリでも、動作と場所までは言う', () => {
  const m = itemModel();
  // クラス表なし = 配布用の Swift アプリや、名前を潰したアプリ
  const rep = buildFunctionReport({ model: m, region: REGION });
  const role = roleFromReport(rep, { apis: m.facts.apis });

  eq(role.action, ACTION.INCREASE);
  eq(role.subject.kind, 'location', '場所としてすら言えていない');
  eq(String(role.subject.disp), '40', '+0x28 を取り違えている');
  ok(verdictRank(role.verdict) <= verdictRank(VERDICT.LIKELY),
    '名前が読めないのに確定を名乗っている');
  ok(role.missing.includes('role-no-field-name'), '名前が無いことを言っていない');
  has(fnRoleTitle(role), '1 増やす');
  // 文言は残っているので、機能までは言えてよい
  eq(role.topic, 'item');
});

test('ROLE: 「+1 しているから」だけでは、機能を名乗らない', () => {
  // 文言も名前もない、ただの読んで足して書き戻すだけの関数
  const m = build([
    'ldr w8, [x0, #0x28]',
    'add w8, w8, #0x1',
    'str w8, [x0, #0x28]',
    'ret',
  ]);
  const rep = buildFunctionReport({ model: m, region: REGION });
  const role = roleFromReport(rep, {});

  eq(role.action, ACTION.INCREASE, '動作は命令から言えるはず');
  eq(role.topic, null, '手がかりが無いのに機能を名乗っている: ' + role.topic);
  ok(role.missing.includes('role-no-topic'), '機能を言えない理由を書いていない');
  ok(verdictRank(role.verdict) <= verdictRank(VERDICT.LIKELY),
    '何の値か分からないのに確定を名乗っている');
  const title = fnRoleTitle(role);
  ok(!/アイテム|コイン|HP/.test(title), '手がかりが無いのに機能名が出ている: ' + title);
  has(title, '1 増やす');
});

test('ROLE: 機能の手がかりが割れているときは、言い切らない', () => {
  const m = build([
    'ldr w8, [x0, #0x28]',
    'add w8, w8, #0x1',
    'str w8, [x0, #0x28]',
    'adrp x1, #0x100004000',
    'add x1, x1, #0x10',
    'bl #0x100000200',
    'adrp x1, #0x100004000',
    'add x1, x1, #0x20',
    'bl #0x100000200',
    'ret',
  ], { '0x100000200': '_NSLog' });
  attachTexts(m, new Map([
    ['' + 0x100004010n, 'アイテムを獲得しました'],
    ['' + 0x100004020n, 'ログインボーナスを受け取りました'],
  ]), new Set());
  const rep = buildFunctionReport({ model: m, region: REGION });
  const role = roleFromReport(rep, { apis: m.facts.apis });

  ok(verdictRank(role.verdict) <= verdictRank(VERDICT.LIKELY),
    '手がかりが割れているのに確定を名乗っている');
  ok(role.evidence.some((e) => e.code === 'role-topic-conflict'),
    '別の機能を指す手がかりがあることを、証拠に残していない');
  ok(role.runnerUp, 'ほかの読み方を出していない');
  ok(fnRoleAlternative(role).length > 0, 'もう 1 つの読み方を文にできない');

  /*
   * 本物のアプリで実際に出た事故: 見出しには「アイテム」と書いてあるのに、
   * すぐ下の根拠には「/ranking/ を参照している」と書いてある。
   * 割れているときは、片方を見出しに出さない。
   */
  eq(role.topicSettled, false, '割れているのに決着したことにしている');
  ok(!/アイテム|ログインボーナス/.test(fnRoleTitle(role)),
    '割れているのに機能を名乗っている: ' + fnRoleTitle(role));
  ok(role.missing.includes('role-topic-unsettled'), '割れていることを理由に書いていない');
  // ただし「何と何で迷っているか」は、必ず言う（黙って消さない）
  const line = fnRoleTopicLine(role);
  ok(line && /どちらか|決めていません/.test(line), '迷っている中身を出していない: ' + line);
});

test('ROLE: 手がかりが無ければ「名指しできません」と言う', () => {
  const m = build(['mov x0, #0x0', 'ret']);
  const rep = buildFunctionReport({ model: m, region: REGION });
  const role = roleFromReport(rep, {});

  eq(role.action, ACTION.UNKNOWN, '何も無いのに動作を名乗っている');
  has(fnRoleTitle(role), '名指しできませんでした');
  ok(fnRoleLead(role).length > 0);
  ok(role.missing.length > 0, '何が足りないのかを言っていない');
});

test('ROLE: 減らす処理・保存する処理も、それぞれの言葉になる', () => {
  const spend = build([
    'ldr w8, [x0, #0x30]',
    'sub w8, w8, #0xa',
    'str w8, [x0, #0x30]',
    'adrp x1, #0x100004000',
    'add x1, x1, #0x30',
    'bl #0x100000200',
    'ret',
  ], { '0x100000200': '_NSLog' });
  attachTexts(spend, new Map([['' + 0x100004030n, 'コインが足りません']]), new Set());
  const role = roleFromReport(buildFunctionReport({ model: spend, region: REGION }),
    { apis: spend.facts.apis });
  eq(role.action, ACTION.DECREASE);
  eq(String(role.amount), '10');
  eq(role.topic, 'money');
  eq(actionDirection(role.action), 'down');
  has(fnRoleTitle(role), '10 減らす');
  has(fnRoleShort(role), '−10');

  // 値を触らず、端末に保存しているだけの関数
  const save = build([
    'adrp x0, #0x100004000',
    'add x0, x0, #0x40',
    'bl #0x100000300',
    'ret',
  ], { '0x100000300': '_NSUserDefaults_setObject' });
  attachTexts(save, new Map([['' + 0x100004040n, 'セーブデータを保存しました']]), new Set());
  const srole = roleFromReport(buildFunctionReport({ model: save, region: REGION }),
    { apis: save.facts.apis });
  eq(srole.subject.kind, 'none', '触っていない値を触ったことにしている');
  eq(srole.topic, 'save');
  ok(srole.evidence.some((e) => e.code === 'role-verb-none'),
    '値の書き換えが無いことを、証拠として残していない');
});

test('ROLE: 一覧向けの下見からは、絶対に「確定」を出さない', () => {
  const role = inferRole({
    name: null,
    owner: { className: 'ItemManager', sel: 'addItem:' },
    updates: [],
    apis: [], callees: [{ name: '_addItemCount' }], callers: [], strings: [{ text: 'アイテムを獲得しました' }],
    selectors: ['addItem:'],
    comparisons: 1, conditionals: 1, calls: 2, stores: 1,
    verified: false,
  });
  ok(verdictRank(role.verdict) <= verdictRank(VERDICT.LIKELY),
    '逆アセンブルせずに確定を名乗っている');
  ok(role.missing.includes('role-not-disassembled'), '下見であることを言っていない');
  eq(role.topic, 'item');
  eq(role.depth, 'sketch');
});

test('ROLE: 下見は、関数の先頭でないアドレスには何も言わない', async () => {
  const { ProgramIndex } = await import('../js/program.js');
  const { sketchRole } = await import('../js/role.js');
  const symbols = new SymbolIndex({
    addrs: BigUint64Array.from([PC, PC + 0x40n]),
    kinds: Uint8Array.from([0, 1]),          // 2 つ目は外部への中継地点（スタブ）
    names: '_applyDamage\n_puts',
    funcs: BigUint64Array.from([PC]),        // 関数として登録されているのは 1 つ目だけ
  });
  const program = new ProgramIndex(fakeScan({
    refs: [[PC + 4n, PC + 0x100n, 0]],
  }), symbols, { vmAddr: PC, size: 0x200n, id: 'r' });
  const strings = [{ addr: PC + 0x100n, text: 'damage dealt to enemy: %d' }];

  /*
   * スタブは関数ではない。ここで手前の関数の範囲を借りてしまうと、
   * 一覧の `_puts` の行に隣の関数の役割が出る（実際に出た）。
   */
  eq(sketchRole({ start: PC + 0x40n, program, symbols, strings }), null,
    '関数でないアドレスに役割を付けている');
  ok(sketchRole({ start: PC, program, symbols, strings }), '本物の関数の先頭で何も言えていない');
});

test('ROLE: 値を触らない処理は、日本語として読める形で名指しする', () => {
  const m = build([
    'adrp x0, #0x100004000',
    'add x0, x0, #0x40',
    'bl #0x100000300',
    'ret',
  ], { '0x100000300': '_NSUserDefaults_setObject' });
  attachTexts(m, new Map([['' + 0x100004040n, 'セーブデータを保存しました']]), new Set());
  const role = roleFromReport(buildFunctionReport({ model: m, region: REGION }),
    { apis: m.facts.apis });

  const title = fnRoleTitle(role);
  // 「セーブ・保存を端末に保存する処理」のような、目的語のない言い方をしない
  ok(!/を端末に保存する処理/.test(title), '日本語になっていない: ' + title);
  has(title, 'に関わる処理');
});

test('ROLE: 動作の言葉と、足りない理由に、言い漏らしがない', () => {
  for (const a of Object.values(ACTION)) {
    if (a === ACTION.UNKNOWN) continue;
    ok((actionPhrase(a, null) || '').length > 0, a + ' の言葉がない');
  }
  eq(actionPhrase('unknown', null), null, '知らない動作に言葉を付けている');
  for (const code of ['role-no-topic', 'role-no-field-name', 'role-not-disassembled', 'role-no-clue']) {
    ok(roleMissingText(code).length > 0, code + ' の説明がない');
  }
  for (const id of ['hp', 'money', 'item', 'gacha']) ok(topicLabel(id).length > 0);
  eq(topicLabel(null), null, '無い機能に名前を付けている');
});

/* ────────────────────────────────────────────────────────────
   ケース V: 組み込んだ SDK を、アプリ自身のコードと分ける
   ────────────────────────────────────────────────────────────

   ゲーム本体が C++ で書かれていると、Objective-C のクラス表に残るのは
   広告 SDK だけになる。そこで名前だけを見て「所持金」を探すと、
   LevelPlay（広告 SDK）の「動画報酬の数」が満点で当たってしまう。
   自信満々で間違えるのは、何も言わないより悪い。 */

const { learnVendors, vendorOf, vendorConflicts, swiftModuleOf } =
  await import('../js/vendors.js');

test('VENDORS: Swift の記号名からモジュール名を取り出せる', () => {
  eq(swiftModuleOf('_TtC12VungleAdsSDK14FirstPartyData'), 'VungleAdsSDK');
  eq(swiftModuleOf('_TtC10IronSource21ISNHealthCheckFailure'), 'IronSource');
  eq(swiftModuleOf('BattleManager'), null, '関係ない名前にモジュール名を付けている');
  eq(swiftModuleOf('_TtC99Bogus'), null, '長さが合わないものを読んでいる');
});

test('VENDORS: 名前の分かる SDK は、接頭辞ごとまとめて見分けられる', () => {
  const names = [
    'IronSourceUtils', 'ISBannerAdapter', 'ISBaseAdUnitManager', 'ISServerResponseParser',
    'LPMReward', 'LPMBanner', 'LPMInit', 'LPMConfig',
    'BattleManager', 'EnemyUnit', 'PlayerData',
  ];
  const learned = learnVendors(names);
  ok(vendorOf('ISBannerAdapter', learned), 'IronSource を見分けられていない');
  eq(vendorOf('ISBannerAdapter', learned).vendor, 'IronSource');
  ok(vendorOf('LPMReward', learned), 'LevelPlay を見分けられていない');
  // アプリ自身のクラスは、絶対に SDK 扱いしない
  eq(vendorOf('BattleManager', learned), null, 'アプリ自身のクラスを SDK にしている');
  eq(vendorOf('EnemyUnit', learned), null);
  eq(vendorOf('PlayerData', learned), null);
});

test('VENDORS: 長い接頭辞と短い接頭辞の両方が当たったら、裏の取れているほうを採る', () => {
  const names = ['IronSourceUtils', 'ISBanner', 'ISConfig', 'ISLWSProgRvManager'];
  const learned = learnVendors(names);
  const hit = vendorOf('ISLWSProgRvManager', learned);
  ok(hit, 'ISLWS… を見分けられていない');
  eq(hit.vendor, 'IronSource');
});

test('VENDORS: 名前が分からないライブラリも、まとまり方だけで見分けられる', () => {
  // 同じ 3 文字で始まるクラスが 10 個以上 = 配布ライブラリの名前空間のつけ方
  const names = [];
  for (let i = 0; i < 12; i++) names.push('ZQXThing' + i);
  names.push('BattleManager');
  const learned = learnVendors(names);
  const hit = vendorOf('ZQXThing3', learned);
  ok(hit, 'まとまりを見分けられていない');
  eq(hit.confidence, 'low', '裏が取れていないのに強く言い切っている');
  eq(vendorOf('BattleManager', learned), null);
});

test('VENDORS: 広告を調べているときは、広告 SDK を外さない', () => {
  const v = { vendor: 'IronSource', kind: 'ads' };
  eq(vendorConflicts('money', v), true, 'ゲームの所持金として SDK を通している');
  eq(vendorConflicts('hp', v), true);
  eq(vendorConflicts('ads', v), false, '広告を探しているのに広告 SDK を外している');
  eq(vendorConflicts('purchase', v), false);
  eq(vendorConflicts('money', null), false);
});

test('PINPOINT: 広告 SDK の「報酬の数」を、ゲームの所持金として確定しない', async () => {
  /*
   * 名前は完璧に一致している（LPMReward の _amount）。
   * それでも、これは組み込んだ SDK の値なので答えにしてはいけない。
   */
  const sdk = [];
  for (const n of ['LPMReward', 'LPMBanner', 'LPMInit', 'LPMConfig', 'IronSourceUtils']) sdk.push(n);
  const fields = classTable([
    { name: 'LPMReward', ivars: [{ name: '_amount', offset: 8, size: 4, type: { kind: 'int', bytes: 4 } }] },
    { name: 'LPMBanner', ivars: [] },
    { name: 'LPMInit', ivars: [] },
    { name: 'LPMConfig', ivars: [] },
    { name: 'IronSourceUtils', ivars: [] },
  ]);
  void sdk;
  const pin = await pinpointField({ goal: goalFromPreset('money'), fields });
  const top = pin.top;
  if (top) {
    ok(pin.verdict !== 'confirmed', 'SDK の値を確定にしている');
    ok(top.fusion.probability < 0.5,
      'SDK の値を ' + (top.fusion.probability * 100).toFixed(0) + '% で出している');
  }
});

/* ────────────────────────────────────────────────────────────
   ケース W: 名前も文言も無いアプリで、ふるまいから値を見分ける
   ──────────────────────────────────────────────────────────── */

const { foldShapes, resources, damageSources, evidenceFor, SHAPE, AMOUNT } =
  await import('../js/shapes.js');

/** worker が返す形の走査結果を、手で組み立てる。 */
function shapeScan(events) {
  const n = events.length;
  const out = {
    count: n,
    addr: new BigUint64Array(n), disp: new Int32Array(n), size: new Uint8Array(n),
    flags: new Uint8Array(n), amtKind: new Uint8Array(n), amtDisp: new Int32Array(n),
    span: new Int32Array(n), amtSize: new Uint8Array(n), amtSpan: new Int32Array(n),
  };
  events.forEach((e, i) => {
    out.addr[i] = BigInt(e.addr || 0x100004000 + i * 4);
    out.disp[i] = e.disp;
    out.size[i] = e.size == null ? 4 : e.size;
    out.flags[i] = e.flags || 0;
    out.amtKind[i] = e.amtKind || AMOUNT.NONE;
    out.amtDisp[i] = e.amtDisp || 0;
    out.span[i] = e.span == null ? 0x400 : e.span;
    // 「引く量」の側で観測した大きさと入れ物の大きさ（攻撃力はここにしか出ない）
    out.amtSize[i] = e.amtSize == null ? 4 : e.amtSize;
    out.amtSpan[i] = e.amtSpan == null ? 0x400 : e.amtSpan;
  });
  return out;
}

test('SHAPES: 減って増えて 0 で止まる値を、資源として拾える', () => {
  const ev = [];
  for (let i = 0; i < 8; i++) {
    ev.push({ disp: 0x2c, flags: SHAPE.DECREASE | SHAPE.CLAMP | SHAPE.CROSS,
      amtKind: AMOUNT.FIELD, amtDisp: 0x18 });
  }
  for (let i = 0; i < 5; i++) ev.push({ disp: 0x2c, flags: SHAPE.INCREASE });
  const folded = foldShapes(shapeScan(ev));
  const res = resources(folded);
  ok(res.length > 0, '資源を 1 つも拾えていない');
  eq(res[0].offset, 0x2c);
  eq(res[0].decreases, 8);
  eq(res[0].increases, 5);
  eq(res[0].clamped, 8);
});

test('SHAPES: 他人の資源を減らす量を、攻撃力として拾える', () => {
  const ev = [];
  // +0x2c（体力）が、+0x18（攻撃力）のぶんだけ、別のオブジェクトから減らされる
  for (let i = 0; i < 6; i++) {
    ev.push({ disp: 0x2c, flags: SHAPE.DECREASE | SHAPE.CLAMP | SHAPE.CROSS | SHAPE.SCALED,
      amtKind: AMOUNT.FIELD, amtDisp: 0x18 });
  }
  for (let i = 0; i < 4; i++) ev.push({ disp: 0x2c, flags: SHAPE.INCREASE });
  const folded = foldShapes(shapeScan(ev));
  const res = resources(folded);
  const dmg = damageSources(folded, res);
  ok(dmg.length > 0, '攻撃力の候補を拾えていない');
  eq(dmg[0].offset, 0x18, '攻撃力として体力側を出している');
  eq(dmg[0].usedAsAmount, 6);
  // 体力そのものを「攻撃力」として出してはいけない
  ok(!dmg.some((d) => d.offset === 0x2c), '減らされる側を攻撃力にしている');
});

test('SHAPES: C++ の容器の頭（要素数・参照カウンタ）を、ゲームの値と間違えない', () => {
  /*
   * std::vector の要素数は +0x0 にあって、減って増えて 0 で止まる。
   * 体力とふるまいがまったく同じ。分かれるのは入れ物の大きさだけ。
   */
  const ev = [];
  for (let i = 0; i < 40; i++) ev.push({ disp: 0, flags: SHAPE.DECREASE, span: 0x10 });
  for (let i = 0; i < 60; i++) ev.push({ disp: 0, flags: SHAPE.INCREASE, span: 0x10 });
  const folded = foldShapes(shapeScan(ev));
  eq(resources(folded).length, 0, '容器の頭を資源として出している');
  const why = evidenceFor(folded, 0, 'hp');
  ok(why && why.codes.some((c) => c.code === 'loc-container-head'),
    '容器の頭だと言えていない');
});

test('SHAPES: 大きな構造体の中にある同じ位置なら、ゲームの値として残す', () => {
  const ev = [];
  for (let i = 0; i < 8; i++) {
    ev.push({ disp: 0, flags: SHAPE.DECREASE | SHAPE.CROSS, span: 0x9f4,
      amtKind: AMOUNT.FIELD, amtDisp: 0x18 });
  }
  for (let i = 0; i < 6; i++) ev.push({ disp: 0, flags: SHAPE.INCREASE, span: 0x9f4 });
  const folded = foldShapes(shapeScan(ev));
  ok(resources(folded).length > 0, '大きな構造体の中の値まで捨てている');
});

test('SHAPES: 8 バイトで持たれている値を、ゲームの数値として出さない', () => {
  // ミリ秒の締め切り（str x8）。減って、0 で止まる。形だけなら体力と同じ。
  const ev = [];
  for (let i = 0; i < 6; i++) {
    ev.push({ disp: 0x3c58, size: 8, flags: SHAPE.DECREASE | SHAPE.CROSS,
      amtKind: AMOUNT.FIELD, amtDisp: 0x3c58, span: 0x3c58 });
  }
  const folded = foldShapes(shapeScan(ev));
  eq(resources(folded).length, 0, '8 バイトの値を資源として出している');
});

test('SHAPES: 目的に合ったふるまいだけを証拠にする', () => {
  const ev = [];
  for (let i = 0; i < 6; i++) {
    ev.push({ disp: 0x2c, flags: SHAPE.DECREASE | SHAPE.CROSS | SHAPE.SCALED,
      amtKind: AMOUNT.FIELD, amtDisp: 0x18 });
  }
  for (let i = 0; i < 4; i++) ev.push({ disp: 0x2c, flags: SHAPE.INCREASE });
  const folded = foldShapes(shapeScan(ev));

  const atk = evidenceFor(folded, 0x18, 'attack');
  ok(atk.codes.some((c) => c.code === 'loc-damage-source'),
    '攻撃力を「他人を減らす量」と言えていない');
  // 攻撃力を探しているときに、体力側を攻撃力の証拠にしない
  const wrong = evidenceFor(folded, 0x2c, 'attack');
  ok(!wrong.codes.some((c) => c.code === 'loc-damage-source'),
    '減らされる側を攻撃力の証拠にしている');
  // 体力を探しているなら、減らされる側が証拠になる
  const hp = evidenceFor(folded, 0x2c, 'hp');
  ok(hp.codes.some((c) => c.code === 'loc-resource-drain'),
    '体力を「よそから減らされる値」と言えていない');
});

test('SHAPES: 所持金は、自分の中だけで増減する値として分ける', () => {
  const ev = [];
  // 誰にも殴られない（CROSS が立たない）= 所持金のふるまい
  for (let i = 0; i < 5; i++) ev.push({ disp: 0x30c, flags: SHAPE.DECREASE | SHAPE.CLAMP });
  for (let i = 0; i < 5; i++) ev.push({ disp: 0x30c, flags: SHAPE.INCREASE });
  // こちらは別オブジェクトから減らされる = 体力のふるまい
  for (let i = 0; i < 5; i++) {
    ev.push({ disp: 0x2c, flags: SHAPE.DECREASE | SHAPE.CROSS,
      amtKind: AMOUNT.FIELD, amtDisp: 0x18 });
  }
  for (let i = 0; i < 5; i++) ev.push({ disp: 0x2c, flags: SHAPE.INCREASE });
  const folded = foldShapes(shapeScan(ev));

  ok(evidenceFor(folded, 0x30c, 'money').codes.some((c) => c.code === 'loc-self-resource'),
    '所持金のふるまいを拾えていない');
  ok(!evidenceFor(folded, 0x2c, 'money').codes.some((c) => c.code === 'loc-self-resource'),
    '殴られる値を所持金として出している');
  ok(!evidenceFor(folded, 0x30c, 'hp').codes.some((c) => c.code === 'loc-resource-drain'),
    '所持金を体力として出している');
});

test('SHAPES: 何も無い走査結果でも落ちない', () => {
  eq(foldShapes(null).size, 0);
  eq(foldShapes({ count: 0 }).size, 0);
  eq(resources(foldShapes(null)).length, 0);
  eq(evidenceFor(foldShapes(null), 0x10, 'attack'), null);
});

/* ────────────────────────────────────────────────────────────
   ケース S: データファイルの表を、命令から読み取る
   ────────────────────────────────────────────────────────────

   現代のモバイルゲームは数値をコードに書かない。CSV で持っていて起動時に読む。
   だから「攻撃力」という言葉はバイナリに 1 つも無いのに、
   **何列目がどこに入るか** は命令にはっきり書いてある。そこを読む。 */

const { decodeSchema, columnToOffset, offsetToColumn, looksLikeDataFile,
  recoverSchemas, schemaForFile } = await import('../js/schema.js');

/* ARM64 の命令語を、必要なぶんだけ組み立てる（逆アセンブラを通さないため）。 */
const A64 = {
  bl: (off) => (0x94000000 | ((off >>> 2) & 0x03ffffff)) >>> 0,
  // str Wt, [Xn, Xm, lsl #2]
  strIdx: (t, n, m) => (0xb8207800 | (m << 16) | (n << 5) | t) >>> 0,
  ldrIdx: (t, n, m) => (0xb8607800 | (m << 16) | (n << 5) | t) >>> 0,
  // str Wt, [Xn, #imm]（12 ビット、4 バイト単位）
  strOff: (t, n, imm) => (0xb9000000 | (((imm / 4) & 0xfff) << 10) | (n << 5) | t) >>> 0,
  addImm: (d, n, imm) => (0x91000000 | ((imm & 0xfff) << 10) | (n << 5) | d) >>> 0,
  cmpImm: (n, imm) => (0xf1000000 | ((imm & 0xfff) << 10) | (n << 5) | 31) >>> 0,
  movz: (d, imm) => (0x52800000 | ((imm & 0xffff) << 5) | d) >>> 0,
  mul: (d, n, m) => (0x1b007c00 | (m << 16) | (n << 5) | d) >>> 0,
  subImm: (d, n, imm) => (0xd1000000 | ((imm & 0xfff) << 10) | (n << 5) | d) >>> 0,
  bcond: (off) => (0x54000000 | (((off >> 2) & 0x7ffff) << 5)) >>> 0,
  ret: () => 0xd65f03c0,
};

/** The Battle Cats の unit%03d.csv 読み込みと同じ形を組み立てる。 */
function unitLoaderWords() {
  return Uint32Array.from([
    A64.addImm(28, 28, 0),          // 表の基点（ここでは何もしない）
    A64.bl(-0x100),                 // 1 列ぶんを整数にする
    A64.strIdx(0, 28, 21),          // str w0, [x28, x21, lsl #2] ← i 列目を +i*4 へ
    A64.addImm(21, 21, 1),          // 列を 1 つ進める
    A64.cmpImm(21, 0x75),           // 117 列
    A64.addImm(28, 28, 0x1d4),      // 次のレコードへ（117 × 4 = 468）
    A64.addImm(25, 25, 1),          // レコードを 1 つ進める
    A64.cmpImm(25, 4),              // 4 レコード
    A64.ret(),
  ]);
}

test('SCHEMA: 読み込みの命令から「何列目がどこか」を読み取れる', () => {
  const s = decodeSchema(unitLoaderWords(), 0x100000000n);
  ok(s, '表を読み取れていない');
  const b = s.best;
  eq(b.kind, 'indexed');
  eq(b.columns, 117, '列数が違う');
  eq(b.columnStride, 4, '1 列の大きさが違う');
  eq(b.recordStride, 0x1d4, 'レコードの大きさが違う');
  eq(b.records, 4, 'レコード数が違う（列の添字を数えていないか）');
  // 117 列 × 4 バイト = 468 バイト。ここが合うので読み違いではない。
  eq(b.consistent, true, 'つじつまが合っていない');
  eq(b.storeAddr, 0x100000008n, '置き場所を決めている命令の位置が違う');
});

test('SCHEMA: 列番号とずらし幅を、どちらからでも引ける', () => {
  const s = decodeSchema(unitLoaderWords(), 0x100000000n);
  eq(columnToOffset(s, 0), 0);
  eq(columnToOffset(s, 3), 0xc, '4 列目が +0xc になっていない');
  eq(columnToOffset(s, 116), 464);
  // 表の外は答えない（作り話をしない）
  eq(columnToOffset(s, 117), null, '表の外の列に答えている');
  eq(columnToOffset(s, -1), null);
  eq(offsetToColumn(s, 0xc), 3);
  eq(offsetToColumn(s, 0xd), null, '割り切れないずらし幅に列番号を付けている');
  eq(offsetToColumn(s, 0x1d4), null, '表の外のずらし幅に答えている');
});

test('SCHEMA: つじつまが合わないときは、合わないと言う', () => {
  // レコードの大きさが 列数 × 列幅 と食い違う表
  const words = Uint32Array.from([
    A64.bl(-0x100),
    A64.strIdx(0, 28, 21),
    A64.addImm(21, 21, 1),
    A64.cmpImm(21, 10),             // 10 列
    A64.addImm(28, 28, 0x100),      // なのにレコードは 256 バイト（10×4=40 のはず）
    A64.ret(),
  ]);
  const s = decodeSchema(words, 0x100000000n);
  ok(s, '表を読み取れていない');
  eq(s.best.consistent, false, '食い違いを黙って通している');
  eq(s.best.columns, 10);
  eq(s.best.recordStride, 0x100);
});

test('SCHEMA: 1 ずつ増えていない添字を、列数として使わない', () => {
  const words = Uint32Array.from([
    A64.bl(-0x100),
    A64.strIdx(0, 28, 21),
    A64.addImm(21, 21, 8),          // 8 ずつ進む = 列の添字ではない
    A64.cmpImm(21, 0x75),
    A64.ret(),
  ]);
  const s = decodeSchema(words, 0x100000000n);
  ok(s, '表そのものは読み取れているはず');
  eq(s.best.columns, null, '列の添字でないものを列数にしている');
});

test('SCHEMA: 読み込んだあとに掛かる倍率を拾える', () => {
  const words = Uint32Array.from([
    A64.bl(-0x100),
    A64.strIdx(0, 28, 21),
    A64.addImm(21, 21, 1),
    A64.cmpImm(21, 0x75),
    A64.addImm(28, 28, 0x1d4),
    A64.movz(10, 100),              // ×100
    A64.ldrIdx(11, 28, 21),
    A64.mul(11, 11, 10),
    A64.ret(),
  ]);
  const s = decodeSchema(words, 0x100000000n);
  ok(s.best.scaled.some((x) => x.factor === 100), '倍率を拾えていない');
});

test('SCHEMA: SUBを増加と扱わず、別tableの倍率・別loopの比較を混ぜない', () => {
  const sub = decodeSchema(Uint32Array.from([
    A64.bl(-0x100), A64.strIdx(0, 28, 21), A64.subImm(21, 21, 1),
    A64.cmpImm(21, 117), A64.ret(),
  ]), 0x100000000n);
  eq(sub.best.columns, null, 'sub xN,xN,#1 を induction variable にしている');

  const mixedScale = decodeSchema(Uint32Array.from([
    A64.bl(-0x100), A64.strIdx(0, 28, 21), A64.addImm(21, 21, 1), A64.cmpImm(21, 117),
    A64.movz(10, 100), A64.ldrIdx(11, 9, 8), A64.mul(11, 11, 10), A64.ret(),
  ]), 0x100000000n);
  eq(mixedScale.best.scaled.length, 0, '別のbase/indexの倍率が混ざっている');

  const loops = decodeSchema(Uint32Array.from([
    A64.bl(-0x100), A64.strIdx(0, 28, 21), A64.addImm(21, 21, 1), A64.bcond(-8),
    A64.addImm(21, 21, 1), A64.cmpImm(21, 117), A64.bcond(-8), A64.ret(),
  ]), 0x100000000n);
  eq(loops.best.columns, null, '別loopで再利用されたregisterのcmpが混ざっている');
});

test('SCHEMA: SP baseの固定storeをtableとして拾わない', () => {
  const s = decodeSchema(Uint32Array.from([
    A64.bl(-0x100), A64.strOff(0, 31, 0x10),
    A64.bl(-0x100), A64.strOff(0, 31, 0x14),
    A64.bl(-0x100), A64.strOff(0, 31, 0x18), A64.ret(),
  ]), 0x100000000n);
  eq(s, null);
});

test('SCHEMA: 展開して書いてある表（添字を使わない形）も読める', () => {
  const words = Uint32Array.from([
    A64.bl(-0x100), A64.strOff(0, 19, 0x10),
    A64.bl(-0x100), A64.strOff(0, 19, 0x14),
    A64.bl(-0x100), A64.strOff(0, 19, 0x18),
    A64.bl(-0x100), A64.strOff(0, 19, 0x1c),
    A64.ret(),
  ]);
  const s = decodeSchema(words, 0x100000000n);
  ok(s, '展開されている表を読み取れていない');
  eq(s.best.kind, 'unrolled');
  eq(s.best.columns, 4);
  eq(columnToOffset(s, 0), 0x10);
  eq(columnToOffset(s, 2), 0x18);
  eq(offsetToColumn(s, 0x1c), 3);
});

test('SCHEMA: 表が無い関数には、表があることにしない', () => {
  const words = Uint32Array.from([A64.addImm(0, 0, 1), A64.ret()]);
  eq(decodeSchema(words, 0x100000000n), null, '無い表をでっち上げている');
  eq(decodeSchema(new Uint32Array(0), 0x100000000n), null);
});

test('SCHEMA: データファイルらしい名前だけを拾う', () => {
  ok(looksLikeDataFile('unit%03d.csv'));
  ok(looksLikeDataFile('Matatabi.tsv'));
  ok(looksLikeDataFile('SpecialRulesMap.json'));
  ok(!looksLikeDataFile('libSystem.dylib'));
  ok(!looksLikeDataFile('attack'));
  ok(!looksLikeDataFile(null));
});

test('SCHEMA: 材料が無くても落ちない', async () => {
  eq((await recoverSchemas({})).length, 0);
  eq((await recoverSchemas({ strings: [], program: null, read: null })).length, 0);
  eq(schemaForFile(null, 'x.csv'), null);
  eq(schemaForFile([], 'x.csv'), null);
});

test('SCHEMA: ファイル名から読み込み処理をたどって表を組み立てる', async () => {
  /*
   * 文字列 → それを参照している関数 → その関数の命令 → 表の形
   * という、実物と同じ順番を通す。
   */
  const words = unitLoaderWords();
  const bytes = new Uint8Array(words.length * 4);
  const dv = new DataView(bytes.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w, true));

  const loader = 0x100004000n;
  const program = {
    functionsReferencing: (addr) => (addr === 0x101000000n ? [{ addr: loader }] : []),
    functionRange: (a) => (a === loader
      ? { start: loader, end: loader + BigInt(bytes.length) } : null),
  };
  const read = async (addr, len) => {
    if (addr !== loader) return null;
    return bytes.subarray(0, len);
  };
  const list2 = await recoverSchemas({
    strings: [
      { addr: 0x101000000n, text: 'unit%03d.csv' },
      { addr: 0x101000100n, text: 'libSystem.dylib' },   // データファイルではない
    ],
    program, read,
  });
  eq(list2.length, 1, '表を 1 つ組み立てられていない');
  const s = schemaForFile(list2, 'unit%03d.csv');
  ok(s, 'ファイル名から引けていない');
  eq(s.loader, loader);
  eq(s.best.columns, 117);
  eq(s.best.consistent, true);
  eq(columnToOffset(s, 3), 0xc, 'ファイル名から引いた表で 4 列目が出ない');
});


/* ────────────────────────────────────────────────────────────
   式の復元（expr.js）— 命令をまたいで 1 つの計算に戻せるか
   ──────────────────────────────────────────────────────────── */

test('EXPR: 掛けてずらす形から、割り算を逆算できる（32 ビット・符号あり）', async () => {
  const { buildValues, render } = await import('../js/expr.js');
  /* clang が `n / 100` に対して吐く定型そのもの。 */
  const m = build([
    'mov w9, #0x851f',
    'movk w9, #0x51eb, lsl #16',
    'smull x8, w0, w9',
    'lsr x9, x8, #0x3f',
    'asr x8, x8, #0x25',
    'add w0, w8, w9',
    'ret',
  ]);
  const vg = buildValues(m, {});
  const v = vg.defAt(5, 'x0');
  ok(v, 'x0 の値が取れていない');
  has(render(v, {}), '/ 100');
});

test('EXPR: 大小を選ぶ定型は、min / max として読む', async () => {
  const { buildValues, render } = await import('../js/expr.js');
  /* ARM64 に min は無い。コンパイラは必ず cmp + csel の 2 命令で書く。 */
  const m = build([
    'cmp x0, x1',
    'csel x2, x0, x1, lt',
    'ret',
  ]);
  const vg = buildValues(m, {});
  const v = vg.defAt(1, 'x2');
  ok(v, 'x2 の値が取れていない');
  has(render(v, {}), 'min(');
});

test('EXPR: 条件つき代入の条件を、比べた式として書く', async () => {
  const { buildValues, render } = await import('../js/expr.js');
  /*
   * 比較の中身を捨てていたころ、ここは `flag_ne ? … : …` としか書けなかった。
   * 何と何を比べたのか出せないなら、条件つき代入はどれも読めない。
   */
  const m = build([
    'cmp x0, #5',
    'csel x2, x1, x3, eq',
    'ret',
  ]);
  const vg = buildValues(m, {});
  const text = render(vg.defAt(1, 'x2'), {});
  has(text, '== 5');
  ok(!/flag_/.test(text), '比較を復元できていない: ' + text);
});

test('EXPR: 比べたものが分からなければ、min とは言わない', async () => {
  const { buildValues, render } = await import('../js/expr.js');
  /* 直前に比較が無い（別の道から来た）ので、大小の定型だと決めつけてはいけない。 */
  const m = build([
    'csel x2, x0, x1, lt',
    'ret',
  ]);
  const vg = buildValues(m, {});
  const text = render(vg.defAt(0, 'x2'), {});
  ok(!/min\(|max\(/.test(text), '根拠なく min と言っている: ' + text);
});

test('EXPR: ずらしが 2 命令に割れていても、割り算に戻せる', async () => {
  const { buildValues, render } = await import('../js/expr.js');
  const m = build([
    'mov w9, #0x851f',
    'movk w9, #0x51eb, lsl #16',
    'smull x8, w0, w9',
    'lsr x10, x8, #0x20',
    'lsr x8, x8, #0x3f',
    'add w0, w8, w10, asr #5',
    'ret',
  ]);
  const vg = buildValues(m, {});
  has(render(vg.defAt(5, 'x0'), {}), '/ 100');
});

test('EXPR: 割り算でないずらしを、割り算だと言わない', async () => {
  const { buildValues, render } = await import('../js/expr.js');
  /* `(a * 17) >> 3`。魔法数ではないので、割り算に読み替えてはいけない。 */
  const m = build([
    'mov w9, #0x11',
    'mul w8, w0, w9',
    'asr w0, w8, #3',
    'ret',
  ]);
  const vg = buildValues(m, {});
  const text = render(vg.defAt(2, 'x0'), {});
  ok(!/\//.test(text), '割り算ではないものを割り算にしている: ' + text);
});

test('EXPR: ずらしと足し算でできた掛け算を、掛け算に戻す', async () => {
  const { buildValues, render } = await import('../js/expr.js');
  const m = build([
    'add x0, x0, x0, lsl #2',
    'ret',
  ]);
  const vg = buildValues(m, {});
  eq(render(vg.defAt(0, 'x0'), {}), 'a1 * 5', '× 5 に戻せていない');
});

test('EXPR: movz と movk で組み立てた定数を 1 つの数にする', async () => {
  const { buildValues, constOf } = await import('../js/expr.js');
  const m = build([
    'mov x9, #0xd70b',
    'movk x9, #0x70a3, lsl #16',
    'ret',
  ]);
  const vg = buildValues(m, {});
  eq(constOf(vg.defAt(1, 'x9')), 0x70a3d70bn, '16 ビットずつの組み立てをまとめていない');
});

test('EXPR: 分岐で飛ばされる範囲が値を壊さないなら、値を持ち越す', async () => {
  const { buildValues, render } = await import('../js/expr.js');
  /* tbz が飛ばすのは x0 を触らない 1 行だけ。x19 は合流点でも生きている。 */
  const m = build([
    'mov x19, x0',
    'tbz w1, #0x1f, #0x100000010',
    'mov x2, #1',
    'add x19, x19, #4',
    'ret',
  ]);
  const vg = buildValues(m, {});
  eq(render(vg.defAt(3, 'x19'), {}), 'a1 + 4', '合流点で値を捨てすぎている');
});

/* ────────────────────────────────────────────────────────────
   関数の理解（comprehend.js）
   ──────────────────────────────────────────────────────────── */

test('COMPREHEND: 持ち回っている値と、その作り変えを並べられる', async () => {
  const { comprehend, stepText } = await import('../js/comprehend.js');
  const m = build([
    'mov x19, x0',
    'mov w9, #0x851f',
    'movk w9, #0x51eb, lsl #16',
    'mul w8, w19, w1',
    'smull x8, w8, w9',
    'lsr x10, x8, #0x3f',
    'asr x8, x8, #0x25',
    'add w19, w8, w10',
    'lsl x19, x19, #1',
    'mov x0, x19',
    'ret',
  ]);
  const c = comprehend({ model: m });
  ok(c, '何も返っていない');
  ok(c.accumulator && c.accumulator.reg === 'x19', '持ち回っている値を見つけられていない');
  /* 割り算のあとに ×2。連続した書き込みは 1 つの工程にまとめられる。 */
  ok(c.steps.length >= 1, '工程が取れていない');
  const all = c.steps.map((st) => stepText(st, {})).join('\n');
  has(all, '/ 100');
  has(all, '* 2');
});

test('COMPREHEND: 文言に書かれた計算式と、復元した式を突き合わせる', async () => {
  const { comprehend } = await import('../js/comprehend.js');
  const m = build([
    'mov x19, x0',
    'adrp x1, #0x100004000',
    'add x1, x1, #0x10',
    'mov w9, #0x851f',
    'movk w9, #0x51eb, lsl #16',
    'mul w8, w19, w1',
    'smull x8, w8, w9',
    'lsr x10, x8, #0x3f',
    'asr x8, x8, #0x25',
    'add w19, w8, w10',
    'lsl x19, x19, #1',
    'ret',
  ]);
  attachTexts(m, new Map([['' + 0x100004010n, '攻撃力アップ:%d 基ダ×2÷100']]), new Set());
  const c = comprehend({ model: m });
  ok(c.formula, '突き合わせができていない');
  ok(c.formula.distinct >= 2, '一致した数の種類が足りない: ' + c.formula.distinct);
});

test('COMPREHEND: 記号 * / が入っているだけの文字列を、計算式と呼ばない', async () => {
  const { formulaOf } = await import('../js/comprehend.js');
  /*
   * ここは role-formula-verified（このツールで最強の証拠）の入口。
   * 外すと「型エンコードの ×16 と、構造体の +16 が合ったから確定」が通る。
   * このアプリでは、式として拾えた 88 本のうち 63 本がこの種の偽物だった。
   */
  const fakes = [
    'v40@0:8@16@24*32',                       // Objective-C の型エンコード
    'video/3gpp',                              // MIME 型
    '/openrtb/2.5',                            // URL の道
    'key_bytes == 128 / 8 || key_bytes == 192 / 8',   // C の表明文
    'MIGHAoGBAMgt6PK9G5WY9RzBROkRVoTwD/4Pttk',        // base64
    'ca-app-pub-5122780296842565/5904342708',         // 広告の枠 ID
    "Non-200/201 HTTP response (%@)",                 // 書式指定はあるが式ではない
  ];
  for (const f of fakes) eq(formulaOf(f), null, '式でないものを式と読んだ: ' + f);

  const real = [
    'クリティカル:%d 基ダ×2',
    'めっぽう強い:%d 基ダ×(1500+[宝:%d])÷1000×(100+[コンボ:%d])÷100',
    'damage: %d base * (100 + %d) / 100',      // 全角でなくても、人に見せる文なら読む
  ];
  for (const r of real) ok(formulaOf(r), '本物の計算式を落とした: ' + r);
  eq(formulaOf('クリティカル:%d 基ダ×2').mul[0], 2n);
});

test('COMPREHEND: 計算式が無ければ、合ったことにしない', async () => {
  const { comprehend } = await import('../js/comprehend.js');
  const m = build([
    'mov x19, x0',
    'adrp x1, #0x100004000',
    'add x1, x1, #0x10',
    'add x19, x19, #1',
    'ret',
  ]);
  attachTexts(m, new Map([['' + 0x100004010n, 'アイテムを獲得しました']]), new Set());
  const c = comprehend({ model: m });
  ok(!c.formula, '式が書かれていないのに一致を名乗っている');
});

test('COMPREHEND: レジスタが別の用途に移ったら、そこで区間を切る', async () => {
  const { comprehend } = await import('../js/comprehend.js');
  /* 前半は数を作り、後半は同じ x19 を配列の添字に使い回している。 */
  const m = build([
    'mov x19, x0',
    'lsl x19, x19, #1',
    'lsl x19, x19, #2',
    'ldr x19, [x1, #0x8]',
    'add x19, x19, #4',
    'add x19, x19, #4',
    'ret',
  ]);
  const c = comprehend({ model: m });
  eq(c.accumulator.reg, 'x19');
  /* ldr で別物が入ったところで区間は終わる。そのあとの `+4` は数に入らない。 */
  ok(c.steps.every((st) => st.row < 3), '別の用途になった先まで 1 つの計算として数えている');
});

/* ────────────────────────────────────────────────────────────
   逆コンパイル（decompile.js）— 中間の行が消えているか
   ──────────────────────────────────────────────────────────── */

test('DECOMPILE: 同じ置き場は、どの書き方で来ても同じ名前になる', async () => {
  const { decompile } = await import('../js/decompile.js');
  /*
   * 1 つの置き場を指す 3 通りの書き方。
   *   [sp, #0x1c]   命令のオペランド（下げたあとの sp から）
   *   [x29, #-0x64] フレームポインタから（0x180 - 0x164 = 0x1c）
   *   add x0, sp, #0x1c → 値グラフでは `sp - 372`（入った時点の sp から）
   * 揃わないと、同じ変数が 3 つの別物に見える。
   */
  const m = build([
    'sub sp, sp, #0x190',
    'add x29, sp, #0x180',
    'str w0, [sp, #0x1c]',
    'add x2, sp, #0x1c',
    'ldur w1, [x29, #-0x164]',
    'ret',
  ]);
  const out = decompile(m, { addr: BASE });
  const text = out.lines.map((l) => l.text).join('\n');
  has(text, 'local_m174');
  ok(!/FFFFFFFF/i.test(text), 'signed stack identity wrapped to u64: ' + text);
  ok(!/\bsp\s*[-+]\s*\d/.test(text), '置き場が番地のまま出ている: ' + text);
  ok(!/var_164|var_88\b/.test(text), '同じ置き場に別の名前が付いている: ' + text);
});

test('DECOMPILE: sp を定数で動かさない関数では、置き場に名前を付けない', async () => {
  const { decompile } = await import('../js/decompile.js');
  /* 可変長スタック。どこが置き場かは決まらないので、名乗らないのが正しい。 */
  const m = build([
    'sub sp, sp, x8',
    'add x0, sp, #0x10',
    'ret',
  ]);
  const out = decompile(m, { addr: BASE });
  const text = out.lines.map((l) => l.text).join('\n');
  ok(!/&var_/.test(text), '決まらない置き場に名前を付けている: ' + text);
});

/* ── まとめ ──────────────────────────────────────────────── */

const { assemble: assemblePatch, parseHexBytes: strictHex, isHexBytes,
  validatePatchRange, PatchSet } = await import('../js/patch.js');

const wordOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);

test('PATCH: SP moveはADD alias、幅違いはerrorになる', () => {
  eq(wordOf(assemblePatch('mov x0, sp', 0x1000n).bytes), 0x910003e0);
  eq(wordOf(assemblePatch('mov sp, x0', 0x1000n).bytes), 0x9100001f);
  ok(assemblePatch('mov w0, x1', 0x1000n).error, 'w/x幅違いを受理している');
});

test('PATCH: branch alignmentとstrict hexを検証する', () => {
  ok(assemblePatch('b 0x1002', 0x1000n).error, '非整列branchを丸めている');
  ok(assemblePatch('b.eq 0x1002', 0x1000n).error, '非整列conditional branchを丸めている');
  ok(isHexBytes('DEADBEEF'));
  eq(Array.from(strictHex('AA BB CC DD')).join(','), '170,187,204,221');
  eq(strictHex('AA BB typo CC'), null, '不正文字を削除してhexとして受理している');
});

test('PATCH: range外を登録・保存成功にしない', async () => {
  const region = { vmAddr: 0x1000n, size: 0x20n, fileOffset: 0x10n };
  ok(validatePatchRange(region, 0x1002n, 4, 0x100, true).error);
  ok(validatePatchRange(region, 0x1020n, 4, 0x100, true).error);
  const set = new PatchSet();
  set.add(0x100n, new Uint8Array(4), new Uint8Array(4));
  let failed = false;
  try { await set.apply(new Blob([new Uint8Array(16)])); } catch { failed = true; }
  ok(failed, '範囲外patchを保存時に黙って捨てている');
});

test('BACKEND: epochで古いrequestを破棄し、progressをrequest単位へ送る', async () => {
  const savedWorker = globalThis.Worker;
  class FakeWorker {
    constructor() { this.sent = []; }
    postMessage(message) { this.sent.push(message); }
  }
  globalThis.Worker = FakeWorker;
  try {
    const { Backend } = await import('../js/backend.js');
    const backend = new Backend();
    let progress = 0;
    const active = backend.call('scanProgram', {}, null, () => { progress++; });
    const msg = backend.worker.sent.at(-1);
    backend.worker.onmessage({ data: { t: 'scanProgress', requestId: msg.id, epoch: msg.epoch, done: 1, all: 2 } });
    eq(progress, 1);
    backend.worker.onmessage({ data: { t: 'ok', id: msg.id, epoch: msg.epoch, result: { ok: true } } });
    ok((await active).ok);

    const stale = backend.call('analyze', {});
    backend.advanceEpoch();
    let rejected = false;
    try { await stale; } catch (err) { rejected = !!err.stale; }
    ok(rejected, '古いrequestがsettleされず、結果を待ち続ける');
  } finally {
    globalThis.Worker = savedWorker;
  }
});

test('NAMES: fingerprintは同名同サイズの別内容・別sliceを分離する', async () => {
  const { noteKeyFor } = await import('../js/names.js');
  const file = (byte) => { const b = new Blob([new Uint8Array(1024).fill(byte)]); b.name = 'same.bin'; return b; };
  const info = { slices: [
    { offset: 0n, info: { uuid: null, cpu: 'arm64', cpuSub: 'all' } },
    { offset: 512n, info: { uuid: null, cpu: 'x86_64', cpuSub: 'all' } },
  ] };
  const a = await noteKeyFor(file(1), info, 0);
  const b = await noteKeyFor(file(2), info, 0);
  const otherSlice = await noteKeyFor(file(1), info, 1);
  ok(a !== b, '同名同サイズの別binaryが同じkeyになった');
  ok(a !== otherSlice, 'Fat binaryのactive sliceがkeyに入っていない');
});

test('NAMES: fingerprint導入前のメモを新しいkeyへ安全に移す', async () => {
  const saved = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => mem.has(k) ? mem.get(k) : null,
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  try {
    const { NoteStore, legacyNoteKeyFor } = await import('../js/names.js');
    const file = { name: 'game.bin', size: 1234 };
    const info = { slices: [{ info: { uuid: 'ABC-123' } }] };
    const old = legacyNoteKeyFor(file, info);
    eq(old, 'game.bin|1234|ABC-123');
    mem.set('hex.notes.' + old, JSON.stringify({
      v: 1, names: { '4096': 'hpUpdate' }, comments: { '4100': 'old note' },
      vars: {}, types: {}, structs: [],
    }));
    const store = new NoteStore('v2|new-fingerprint', [old]);
    eq(store.nameOf(4096n), 'hpUpdate');
    eq(store.comment(4100n), 'old note');
    eq(store.migratedFrom, old);
    ok(mem.has('hex.notes.v2|new-fingerprint'), '新形式へコピーされていない');
    ok(mem.has('hex.notes.' + old), '移行時に旧データを消している');
  } finally {
    if (saved === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = saved;
  }
});

test('SCRIPT: Emulatorはclone可能なhandle RPCで操作できる', async () => {
  const { createApi } = await import('../js/script.js');
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x100n, exec: true };
  const app = {
    codeRegion: () => region,
    store: { get(k) {
      if (k === 'regions') return [region];
      if (k === 'file') return { size: 0x1000 };
      if (k === 'fileInfo') return { slices: [] };
      return null;
    } },
    currentSlice: () => null,
    backend: {
      readAt: async (_addr, len) => ({ found: true, bytes: new Uint8Array(len) }),
      fetchChunk: async () => ({ mn: ['ret'], ops: [''] }),
    },
    symbols: { nameAt: () => null, label: () => null, functionList: () => [] },
  };
  const { api } = createApi(app, () => {});
  const created = api.emulatorCreate(0x1000n, [7n]);
  ok(created.id && typeof created.id === 'string');
  eq(created.state.x0, 7n);
  ok(!Object.values(created).some((v) => typeof v === 'function'), '関数をsandboxへ返している');
  structuredClone(created);
  eq(api.emulatorSetRegister(created.id, 'x1', 99n), 99n);
  eq(api.emulatorGetRegister(created.id, 'x1'), 99n);
  api.emulatorAddBreakpoint(created.id, 0x1010n);
  eq(api.emulatorBreakpoints(created.id)[0], 0x1010n);
  ok(api.emulatorDestroy(created.id));
  let failed = false;
  try { api.emulatorState(created.id); } catch { failed = true; }
  ok(failed, 'destroy後のhandleがまだ使える');
});

test('IL2CPP: 検証できたCodeRegistrationだけMethod→addressへ結ぶ', async () => {
  const { bindMethodAddresses } = await import('../js/il2cpp.js');
  const data = new Uint8Array(0x300);
  const dv = new DataView(data.buffer);
  dv.setBigUint64(0, 3n, true);
  dv.setBigUint64(8, 0x2100n, true);
  // Verified legacy CodeRegistration requires neighboring count/pointer pairs,
  // not just one executable-looking table.
  dv.setBigUint64(16, 1n, true);
  dv.setBigUint64(24, 0x2180n, true);
  dv.setBigUint64(32, 1n, true);
  dv.setBigUint64(40, 0x2190n, true);
  for (let i = 0; i < 3; i++) dv.setBigUint64(0x100 + i * 8, 0x1000n + BigInt(i * 4), true);
  const regions = [
    { vmAddr: 0x1000n, size: 0x100n, exec: true, section: '__text' },
    { vmAddr: 0x2000n, size: 0x300n, exec: false, section: '__const' },
  ];
  const read = async (addr, len) => {
    if (addr < 0x2000n || addr + BigInt(len) > 0x2300n) return null;
    const at = Number(addr - 0x2000n);
    return data.slice(at, at + len);
  };
  const meta = { methods: [0, 1, 2].map((index) => ({ index, full: 'C::m' + index })), warnings: [] };
  const result = await bindMethodAddresses(meta, { regions, read });
  eq(result.bound, 3);
  eq(meta.methods[2].address, 0x1008n);
});

test('IL2CPP: modern codegen moduleをimage名とtokenで結ぶ', async () => {
  const { bindMethodAddresses } = await import('../js/il2cpp.js');
  const data = new Uint8Array(0x500);
  const dv = new DataView(data.buffer);
  dv.setBigUint64(0, 0x2080n, true);       // moduleName
  dv.setUint32(8, 3, true);                // methodPointerCount
  dv.setBigUint64(16, 0x2200n, true);      // methodPointers
  data.set(new TextEncoder().encode('Assembly-CSharp.dll\0'), 0x80);
  for (let i = 0; i < 3; i++) dv.setBigUint64(0x200 + i * 8, 0x1000n + BigInt(i * 4), true);
  const regions = [
    { vmAddr: 0x1000n, size: 0x100n, exec: true, section: '__text' },
    { vmAddr: 0x2000n, size: 0x500n, exec: false, section: '__const' },
  ];
  const read = async (addr, len) => {
    if (addr < 0x2000n || addr + BigInt(len) > 0x2500n) return null;
    return data.slice(Number(addr - 0x2000n), Number(addr - 0x2000n) + len);
  };
  const meta = {
    methods: Array.from({ length: 10 }, (_, index) => ({ index, classIndex: index, token: 0x06000001 + index, full: 'C::m' + index })),
    images: [{ index: 0, name: 'Assembly-CSharp.dll', typeStart: 0, typeCount: 10 }], warnings: [],
  };
  const result = await bindMethodAddresses(meta, { regions, read });
  eq(result.bound, 3);
  eq(meta.methods[1].address, 0x1004n);
  eq(meta.methods[1].binding, 'codegen-module');
});

test('EVIDENCE: hold-out calibrationのBrier/reliabilityを計算できる', async () => {
  const { calibrateProbability, calibrationReport } = await import('../js/evidence.js');
  eq(calibrateProbability(0.5, [{ score: 0, observed: 0.1 }, { score: 1, observed: 0.9 }]), 0.5);
  const report = calibrationReport([{ score: 0.9, outcome: 1 }, { score: 0.8, outcome: 0 }], 2);
  eq(report.count, 2);
  ok(report.brier > 0 && report.bins.length === 1);
});


test('IL2CPP: #496 binding trust regressions stay fail-closed', async () => {
  await import('./issue-496-il2cpp-binding.mjs');
});

await Promise.all(pending);
process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) {
  for (const f of failures) {
    process.stdout.write('\n--- ' + f.name + '\n' + (f.err && f.err.stack ? f.err.stack : f.err) + '\n');
  }
  process.exit(1);
}

for (const aiSuite of [
  './ai-schema.mjs',
  './ai-context.mjs',
  './ai-tools.mjs',
  './ai-runtime.mjs',
  './ai-approval.mjs',
  './ai-worker.mjs',
  './ai-performance.mjs',
  './ai-agent-integration.mjs',
]) {
  await import(aiSuite);
}
void currentTest;
