/*
 * IR / SSA / Memory SSA / Slice / Goal Compiler のテスト。
 *
 *   node tests/ir.mjs
 *
 * ここで守りたいのは 2 つだけ。
 *   1. 意味の単位が正しく組み上がること（読んで足して書き戻す、が 1 つに見える）
 *   2. 分からないものを分かったことにしないこと（unknown が unknown のまま残る）
 */
import { buildSemanticModel } from '../js/blocks.js';
import {
  buildIR, irText, OP, VK, MK, readModifyWrite, writersOf, readersOf, mayAlias,
} from '../js/ir.js';
import { backwardSlice, forwardSlice, valueChain, causalChain } from '../js/slice.js';
import { compileGoal, describeQuery } from '../js/goalc.js';
import { groupedFusion, brierScore, expectedCalibrationError, accuracyReport } from '../js/calib.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ok  ' + name + '\n'); }
  catch (err) {
    failures.push({ name, err });
    process.stdout.write('FAIL  ' + name + '\n      ' + (err && err.message) + '\n');
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': got ' + show(a) + ', want ' + show(b));
}
function show(v) {
  if (typeof v === 'bigint') return '0x' + v.toString(16) + 'n';
  try { return JSON.stringify(v); } catch { return String(v); }
}

const BASE = 0x100000000n;

function asm(lines, base = BASE) {
  return lines.map((line, i) => {
    const s = String(line).trim();
    const sp = s.indexOf(' ');
    return { row: i, address: base + BigInt(i) * 4n, mn: sp < 0 ? s : s.slice(0, sp), ops: sp < 0 ? '' : s.slice(sp + 1).trim() };
  });
}

function build(lines, base = BASE) {
  const rowOfAddress = (addr) => {
    const rel = addr - base;
    if (rel < 0n || rel >= BigInt(lines.length) * 4n) return null;
    return Number(rel / 4n);
  };
  const model = buildSemanticModel(asm(lines, base), {
    startRow: 0, endRow: lines.length - 1, rowOfAddress,
  });
  return { model, ir: buildIR(model, { rowOfAddress }) };
}

const insts = (ir, op) => ir.instructions.filter((i) => i.op === op);

/* ────────────────────────────────────────────────────────────
   1. 素の SSA
   ──────────────────────────────────────────────────────────── */

test('SSA: 同じレジスタへの再代入に別々の版が付く', () => {
  const { ir } = build([
    'mov w8, #1',
    'add w8, w8, #2',
    'add w8, w8, #3',
    'ret',
  ]);
  const defs = ir.values.filter((v) => v.reg === 'x8' && v.kind === VK.DEF);
  eq(defs.length, 3, 'x8 の定義数');
  eq(defs[0].version < defs[1].version && defs[1].version < defs[2].version, true, '版が増える');
});

test('SSA: 定数が畳まれて最後の値まで届く', () => {
  const { ir } = build([
    'mov w8, #1',
    'add w8, w8, #2',
    'lsl w8, w8, #3',
    'ret',
  ]);
  const last = ir.values.filter((v) => v.reg === 'x8').pop();
  eq(last.const, 24n, '(1+2)<<3');
});

test('SSA: use-def が張られる', () => {
  const { ir } = build(['mov w8, #7', 'add w9, w8, #1', 'ret']);
  const movDst = ir.values.find((v) => v.reg === 'x8' && v.kind === VK.DEF);
  ok(movDst.uses.some((u) => u.op === OP.BIN), 'mov の結果が add に使われている');
});

test('SSA: 合流点に φ が立ち、両方の道の値を持つ', () => {
  const { ir } = build([
    'cmp w0, #0',
    'b.eq #0x100000014',      // row 5
    'mov w8, #1',
    'b #0x100000018',         // row 6
    'nop',
    'mov w8, #2',             // row 5
    'add w9, w8, #1',         // row 6
    'ret',
  ]);
  const phis = insts(ir, OP.PHI).filter((p) => p.reg === 'x8');
  ok(phis.length >= 1, 'x8 の φ がある: \n' + irText(ir));
  const phi = phis[0];
  eq(phi.incoming.length >= 2, true, 'φ が 2 本以上の道を持つ');
  eq(phi.dst.const, null, '値の違う φ は定数にならない');
});

test('SSA: 分からない命令は unknown のまま残る（埋めない）', () => {
  const { ir } = build(['frint64z d0, d1', 'ret']);
  const unknown = insts(ir, OP.UNKNOWN);
  ok(unknown.length >= 1, 'unknown が残る');
  ok(unknown[0].dst == null || unknown[0].dst.const == null, 'unknown に値を作らない');
});

/* ────────────────────────────────────────────────────────────
   2. Memory SSA
   ──────────────────────────────────────────────────────────── */

test('MemSSA: フィールドへの store を、同じフィールドの load が指す', () => {
  const { ir } = build([
    'str w1, [x0, #0x20]',
    'ldr w8, [x0, #0x20]',
    'ret',
  ]);
  const load = insts(ir, OP.LOAD)[0];
  ok(load.reachingStore, 'load が store を指している: \n' + irText(ir));
  eq(load.reachingStore.row, 0, '指している store の行');
});

test('MemSSA: 別のオフセットは別の場所（誤って結びつけない）', () => {
  const { ir } = build([
    'str w1, [x0, #0x20]',
    'ldr w8, [x0, #0x28]',
    'ret',
  ]);
  const load = insts(ir, OP.LOAD)[0];
  ok(!load.reachingStore, '別オフセットの store は届かない');
});

test('MemSSA: 呼び出しをまたぐとフィールドは壊れる（古い値を使い回さない）', () => {
  const { ir } = build([
    'str w1, [x19, #0x20]',
    'bl #0x100001000',
    'ldr w8, [x19, #0x20]',
    'ret',
  ]);
  const load = insts(ir, OP.LOAD)[0];
  ok(!load.reachingStore, '呼び出し後は store が届かない');
});

test('MemSSA: スタック変数は呼び出しをまたいでも生き残る（番地を渡していないとき）', () => {
  const { ir } = build([
    'mov w8, #5',
    'str w8, [sp, #0x8]',
    'bl #0x100001000',
    'ldr w9, [sp, #0x8]',
    'ret',
  ]);
  const load = insts(ir, OP.LOAD)[0];
  ok(load.reachingStore, 'スタックの値は残る: \n' + irText(ir));
  eq(load.dst.const, 5n, 'スタック経由で定数が届く');
});

test('MemSSA: スタック変数に名前が付く', () => {
  const { ir } = build(['str w8, [sp, #0x18]', 'ldr w9, [sp, #0x18]', 'ret']);
  ok(ir.stackSlots.length >= 1, 'スロットが復元される');
  eq(ir.stackSlots[0].name, 'var_18');
  eq(ir.stackSlots[0].reads, 1);
  eq(ir.stackSlots[0].writes, 1);
});

test('MemSSA: 添字つきアクセスは unknown の場所（言い切らない）', () => {
  const { ir } = build(['ldr w8, [x0, x1, lsl #2]', 'ret']);
  const load = insts(ir, OP.LOAD)[0];
  eq(load.loc.kind, MK.UNKNOWN);
});

test('alias: 同じベースの別オフセットは「別」と言い切れる', () => {
  const a = { key: 'field:1+32', kind: MK.FIELD, base: { id: 1 }, disp: 32n, size: 4 };
  const b = { key: 'field:1+40', kind: MK.FIELD, base: { id: 1 }, disp: 40n, size: 4 };
  const c = { key: 'field:2+32', kind: MK.FIELD, base: { id: 2 }, disp: 32n, size: 4 };
  eq(mayAlias(a, b), false, '同ベース別オフセット');
  eq(mayAlias(a, c), true, 'ベースが違えば言い切れない');
  eq(mayAlias(a, a), true, '同じ場所');
});

/* ────────────────────────────────────────────────────────────
   3. 意味の単位: 読んで、計算して、書き戻す
   ──────────────────────────────────────────────────────────── */

test('RMW: self->coins = min(self->coins + amount, max) を 1 つの意味として拾う', () => {
  const { ir } = build([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, w21',
    'cmp w8, w22',
    'csel w8, w22, w8, gt',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const rmw = readModifyWrite(ir);
  eq(rmw.length, 1, '更新が 1 つ: \n' + irText(ir));
  eq(rmw[0].load.row, 0);
  eq(rmw[0].store.row, 4);
  eq(rmw[0].kind, 'add', '足し算として分類');
  ok(rmw[0].chain.some((c) => c.op === OP.SEL), '上限で丸める選択が経路にある');
});

test('RMW: 読んだ場所と書いた場所が違えば、更新ではない', () => {
  const { ir } = build([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x30]',
    'ret',
  ]);
  eq(readModifyWrite(ir).length, 0);
});

test('writers / readers: 場所から命令を引ける', () => {
  const { ir } = build([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x20]',
    'str w9, [x19, #0x20]',
    'ret',
  ]);
  const key = insts(ir, OP.LOAD)[0].loc.key;
  eq(writersOf(ir, key).length, 2);
  eq(readersOf(ir, key).length, 1);
});

/* ────────────────────────────────────────────────────────────
   4. スライス
   ──────────────────────────────────────────────────────────── */

test('slice: 後ろ向きスライスが、書いた値の由来だけを残す', () => {
  const { ir } = build([
    'ldr w8, [x19, #0x20]',   // 関係する
    'ldr w10, [x19, #0x40]',  // 関係しない
    'add w8, w8, w21',        // 関係する
    'str w8, [x19, #0x20]',   // 起点
    'ret',
  ]);
  const store = insts(ir, OP.STORE)[0];
  const slice = backwardSlice(ir, store);
  const rows = new Set(slice.instructions.map((i) => i.row));
  ok(rows.has(0) && rows.has(2) && rows.has(3), '由来が入る');
  ok(!rows.has(1), '関係ない load は入らない: ' + Array.from(rows).join(','));
});

test('slice: 前向きスライスが、その値の行き先を集める', () => {
  const { ir } = build([
    'mov w8, #3',
    'add w9, w8, #1',
    'mov w11, #99',
    'str w9, [x19, #0x20]',
    'ret',
  ]);
  const seed = ir.instructions.find((i) => i.op === OP.CONST && i.dst.const === 3n);
  const slice = forwardSlice(ir, seed);
  const rows = new Set(slice.instructions.map((i) => i.row));
  ok(rows.has(1) && rows.has(3), '行き先が入る');
  ok(!rows.has(2), '関係ない定数は入らない');
});

test('valueChain: 値の流れを人に見せられる段に畳む', () => {
  const { ir } = build([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, w1',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const store = insts(ir, OP.STORE)[0];
  const chain = valueChain(ir, store);
  const kinds = chain.steps.map((s) => s.kind);
  ok(chain.steps.length >= 3, '3 段以上: ' + JSON.stringify(kinds));
  ok(['arg', 'read', 'const', 'call'].includes(kinds[0]), '最初は出どころ: ' + kinds.join('→'));
  eq(kinds[kinds.length - 1], 'write', '最後は書き込み: ' + kinds.join('→'));
  ok(kinds.includes('read'), '読み出しがある: ' + kinds.join('→'));
  ok(kinds.includes('compute'), '途中に計算がある: ' + kinds.join('→'));
  // self の置き場でしかない x19 は、値の流れの段にしない
  ok(!chain.steps.some((s) => s.kind === 'arg' && s.reg === 'x19'), '番地レジスタは段にしない');
});

test('causalChain: 段数の上限を守り、途中を畳む', () => {
  const lines = ['ldr w8, [x19, #0x20]'];
  for (let i = 0; i < 20; i++) lines.push('add w8, w8, #1');
  lines.push('str w8, [x19, #0x20]', 'ret');
  const { ir } = build(lines);
  const store = insts(ir, OP.STORE)[0];
  const chain = causalChain(ir, store, { limit: 6 });
  ok(chain.steps.length <= 6, '段数が上限以内: ' + chain.steps.length);
  ok(chain.elided > 0, '畳んだ数を正直に持つ');
});

/* ────────────────────────────────────────────────────────────
   5. Goal Compiler
   ──────────────────────────────────────────────────────────── */

test('goalc: 「戦闘終了時にXPが増える場所」を問い合わせに変える', () => {
  const q = compileGoal('戦闘終了時にXPが増える場所');
  eq(q.action, 'increase', '増える');
  ok(q.entity.terms.some((t) => /exp|xp|経験/i.test(t)), '実体が経験値: ' + q.entity.terms.join(','));
  ok(q.context.terms.some((t) => /battle|戦闘|クリア|result/i.test(t)), '文脈が戦闘: ' + q.context.terms.join(','));
  eq(q.dataflow.shape, 'read-modify-write', '期待する形');
  eq(q.sink, 'persistent-state');
});

test('goalc: 「コインはどこで増える？」も同じ形に落ちる', () => {
  const q = compileGoal('コインはどこで増える？');
  eq(q.action, 'increase');
  ok(q.entity.terms.includes('coin'), 'coin が入る: ' + q.entity.terms.join(','));
  eq(q.dataflow.shape, 'read-modify-write');
});

test('goalc: 「ガチャでレア度を決めてるところ」は乱数と分岐を期待する', () => {
  const q = compileGoal('ガチャでレア度を決めてるところ探して');
  eq(q.action, 'decide');
  ok(q.expect.calls.some((c) => /random|rand|arc4/i.test(c)), '乱数を期待: ' + q.expect.calls.join(','));
  ok(q.expect.control.includes('branch'), '分岐を期待');
});

test('goalc: 分からない問いは、分からないと言う（でっち上げない）', () => {
  const q = compileGoal('あ');
  eq(q.confident, false, '自信なしと申告する');
  ok(q.missing.length > 0, '何が足りないかを言う: ' + q.missing.join(','));
});

test('goalc: 問い合わせを日本語で説明できる', () => {
  const q = compileGoal('HPが減る場所');
  const text = describeQuery(q);
  ok(/HP|体力/.test(text), '実体が出る: ' + text);
  ok(/減/.test(text), '動きが出る: ' + text);
});

/* ────────────────────────────────────────────────────────────
   6. 証拠の独立群と校正
   ──────────────────────────────────────────────────────────── */

test('calib: 同じ出どころの証拠は、独立した証拠として数えない', () => {
  const correlated = groupedFusion([
    { code: 'role-subject-field', strength: 1, lr: 22, family: 'name', kind: 'fact', id: true },
    { code: 'role-topic-name', strength: 1, lr: 18, family: 'name', kind: 'fact', id: true },
    { code: 'role-topic-selector', strength: 1, lr: 9, family: 'name', kind: 'fact', id: true },
  ], { candidates: 200 });
  const independent = groupedFusion([
    { code: 'role-subject-field', strength: 1, lr: 22, family: 'name', kind: 'fact', id: true },
    { code: 'role-formula-verified', strength: 1, lr: 260, family: 'verified', kind: 'verified', id: true },
    { code: 'role-accessor-verified', strength: 1, lr: 40, family: 'verified', kind: 'verified' },
  ], { candidates: 200 });
  ok(independent.groups.length > correlated.groups.length,
    '独立群の数: ' + independent.groups.length + ' vs ' + correlated.groups.length);
  ok(independent.probability > correlated.probability, '独立な証拠の方が強い');
});

test('calib: 群ごとの上限が効く（名前だけでは確定しない）', () => {
  const many = [];
  for (let i = 0; i < 12; i++) {
    many.push({ code: 'role-topic-name', strength: 1, lr: 18, family: 'name', kind: 'fact', id: true });
  }
  const f = groupedFusion(many, { candidates: 200 });
  eq(f.groups.length, 1, '群は 1 つ');
  ok(f.probability < 0.99, '名前だけでは 99% に届かない: ' + f.probability);
});

test('calib: Brier / ECE が計算できる', () => {
  const samples = [
    { probability: 0.9, correct: true }, { probability: 0.9, correct: true },
    { probability: 0.1, correct: false }, { probability: 0.1, correct: false },
  ];
  const b = brierScore(samples);
  ok(b < 0.02, 'よく当たっている: ' + b);
  const ece = expectedCalibrationError(samples, 5);
  ok(ece < 0.15, '校正できている: ' + ece);
});

test('calib: 「確定」と言って外した率を出せる', () => {
  const report = accuracyReport([
    { probability: 0.995, verdict: 'confirmed', correct: true, rank: 1 },
    { probability: 0.995, verdict: 'confirmed', correct: false, rank: 4 },
    { probability: 0.7, verdict: 'likely', correct: true, rank: 1 },
    { probability: 0.2, verdict: 'none', correct: false, rank: 9 },
  ]);
  eq(report.falseConfirmRate, 0.5, '確定 2 件のうち 1 件が誤り');
  eq(report.top1, 0.5, 'top-1');
  eq(report.top3, 0.5, 'top-3');
  eq(report.abstentions, 1, '答えを出さなかった数');
});

/* ────────────────────────────────────────────────────────────
   7. 壊れた入力
   ──────────────────────────────────────────────────────────── */

test('壊れた命令列でも落ちない', () => {
  const { ir } = build(['.byte 0xff', 'zzz x0, x1', 'ldr w8, [', 'ret']);
  ok(ir, 'IR ができる');
  ok(irText(ir).length > 0, '表示できる');
});

test('命令が無ければ null（空の IR を作らない）', () => {
  const model = buildSemanticModel([], {});
  eq(buildIR(model, {}), null);
});

/* ── まとめ ─────────────────────────────────────────────── */

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
