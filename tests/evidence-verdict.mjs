/*
 * 決着（confirmed / likely / ambiguous / none）の判定テスト。
 *
 *   node tests/evidence-verdict.mjs
 *
 * ここで守りたいのは 1 つだけ。
 *
 *   **相関した証拠だけで「確定」と言わせない。**
 *
 * 独立性は系統 (family) ではなく出どころ (group) で数える。
 * 名前・プロパティ名・クラスの担当は系統としては 3 つだが、
 * どれも Objective-C のクラス表 1 つから読んだものなので、独立ではない。
 * 片方が間違っていれば、もう片方も一緒に間違う。
 *
 * 以前ここは families.length で数えていた。つまり
 *
 *     NAME + CONTEXT + VERIFIED → 系統 3 つ → 確定
 *
 * が、実際には metadata + metadata + dataflow の 2 出どころしか無いのに
 * 通っていた。このファイルはその穴が二度と開かないようにするためのもの。
 */
import {
  fuse, evidence, decide, groupOf, independentGroupCount,
  VERDICT, GROUP, FAMILY, UNVERIFIED_CEIL,
} from '../js/evidence.js';
import { groupedFusion, fitCalibration } from '../js/calib.js';
import { calibrateProbability } from '../js/evidence.js';
import { missingText } from '../js/narrate.js';

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
  if (a !== b) throw new Error((msg || 'not equal') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}

/* ── 足場 ───────────────────────────────────────────────────── */

const ev = (code, strength) => evidence(code, strength == null ? 1 : strength, {});
const CANDIDATES = { candidates: 200 };

/** 候補 1 つぶんを組む。 */
const cand = (codes, opts) => ({ fusion: fuse(codes.map((c) => ev(c)), opts || CANDIDATES) });

/** 1 位が圧倒的に強くなるよう、明らかに弱い 2 位を添える。 */
const weakRunnerUp = () => cand(['field-name-weak']);

/** 判定の内訳を、失敗時にそのまま読める形で出す。 */
function show(res) {
  const f = res.top ? res.top.fusion : null;
  return [
    'verdict=' + res.verdict,
    f ? 'p=' + f.probability.toFixed(5) : 'p=-',
    f ? 'families=' + JSON.stringify(f.families) : '',
    f ? 'groups=' + JSON.stringify(f.groups) : '',
    f ? 'verified=' + f.verified : '',
    'margin=' + (Number.isFinite(res.margin) ? res.margin.toFixed(2) : '∞'),
    'missing=[' + res.missing.join(', ') + ']',
  ].filter(Boolean).join('  ');
}

/* ── 前提: 表の中身が想定どおりに割り振られている ─────────────── */

test('前提: 名前とクラスの担当は、同じ出どころ (metadata) になる', () => {
  eq(groupOf('field-name-exact'), GROUP.METADATA);
  eq(groupOf('class-category'), GROUP.METADATA);
  eq(groupOf('property-name'), GROUP.METADATA);
  // 系統としては別物であることも確認しておく（family と group を混同していない）
  eq(evidence('field-name-exact', 1, {}).family, FAMILY.NAME);
  eq(evidence('class-category', 1, {}).family, FAMILY.CONTEXT);
});

test('前提: 命令での裏取りは dataflow、開発者の文言は semantic', () => {
  eq(groupOf('getter-verified'), GROUP.DATAFLOW);
  eq(groupOf('rmw-verified'), GROUP.DATAFLOW);
  eq(groupOf('type-declared'), GROUP.STRUCTURAL);
  eq(groupOf('role-formula-verified'), GROUP.SEMANTIC);
});

/* ────────────────────────────────────────────────────────────
   A. 系統 3 つ / 独立した出どころ 2 つ / 裏取りあり → 確定にしない
   ──────────────────────────────────────────────────────────── */

const TWO_GROUPS = [
  'field-name-asked',   // metadata / NAME     / id
  'class-name',         // metadata / CONTEXT  / id
  'getter-verified',    // dataflow / VERIFIED
  'setter-verified',    // dataflow / VERIFIED
  'rmw-verified',       // dataflow / VERIFIED
];

test('A: 系統 3 つでも、出どころが 2 つなら確定にしない', () => {
  const top = cand(TWO_GROUPS);
  const res = decide([top, weakRunnerUp()]);

  // 前提が崩れていたらテストの意味が無いので、まずそこを確かめる
  eq(top.fusion.families.length, 3, '系統は 3 つのはず: ' + show(res));
  eq(top.fusion.independentGroups, 2, '出どころは 2 つのはず: ' + show(res));
  ok(top.fusion.verified > 0, '裏取りがあるはず: ' + show(res));
  ok(top.fusion.probability >= 0.99, '確からしさは足りているはず: ' + show(res));
  ok(res.margin >= Math.log(20), '2 位との差も足りているはず: ' + show(res));

  // ここが本題。足りないのは「出どころの数」だけ。
  ok(res.verdict !== VERDICT.CONFIRMED, '出どころ 2 つで確定になっている: ' + show(res));
  ok(res.missing.includes('need-independent-evidence'),
    '足りない理由が「独立した根拠」になっていない: ' + show(res));
  eq(res.missing.length, 1, '足りないのは独立性だけのはず: ' + show(res));
});

/* ────────────────────────────────────────────────────────────
   B. 独立した出どころ 3 つ / 裏取り / 確からしさ / 差 → 確定できる
   ──────────────────────────────────────────────────────────── */

const THREE_GROUPS = TWO_GROUPS.concat(['type-declared']);   // + structural

test('B: 出どころが 3 つそろえば確定できる', () => {
  const top = cand(THREE_GROUPS);
  const res = decide([top, weakRunnerUp()]);
  eq(top.fusion.independentGroups, 3, '出どころは 3 つのはず: ' + show(res));
  eq(res.verdict, VERDICT.CONFIRMED, '確定にならない: ' + show(res));
  eq(res.missing.length, 0, '足りないものがあってはいけない: ' + show(res));
  eq(res.independentGroups, 3, 'decide が出どころの数を返していない');
});

test('B2: 出どころが増えるのは A に 1 件足しただけ（他の条件は同じ）', () => {
  const two = cand(TWO_GROUPS).fusion;
  const three = cand(THREE_GROUPS).fusion;
  ok(three.independentGroups === two.independentGroups + 1, '増えたのは出どころ 1 つぶん');
  ok(three.verified === two.verified, '裏取りの数は変わっていない');
});

/* ────────────────────────────────────────────────────────────
   C. 名前系をいくら積んでも、出どころが 1 つなら確定にしない
   ──────────────────────────────────────────────────────────── */

test('C: 名前系の証拠を大量に足しても、出どころ 1 つでは確定にしない', () => {
  const many = [
    'field-name-asked', 'field-name-contains', 'field-name-exact', 'field-name-words',
    'field-name-strong', 'property-name', 'accessor-name', 'role-accessor-match',
    'role-subject-field', 'role-topic-name', 'role-topic-selector',
    'class-name', 'class-string', 'selector-match', 'class-category', 'sibling-fields',
  ];
  const top = cand(many);
  const res = decide([top, weakRunnerUp()]);
  eq(top.fusion.independentGroups, 1, '出どころは 1 つのはず: ' + show(res));
  ok(res.verdict !== VERDICT.CONFIRMED, '名前だけで確定になっている: ' + show(res));
  ok(res.missing.includes('need-independent-evidence'), show(res));
  /* 命令まで降りていないので、確からしさにも天井が掛かっている。 */
  ok(top.fusion.probability <= 0.97 + 1e-9, '未検証なのに 97% を超えている: ' + show(res));
});

test('C2: 名前系を足しても、確からしさは天井 (metadata の上限) を超えない', () => {
  const few = cand(['field-name-asked']).fusion;
  const lots = cand(['field-name-asked', 'field-name-contains', 'field-name-exact',
    'field-name-words', 'field-name-strong', 'property-name']).fusion;
  ok(lots.logOdds - few.logOdds < Math.log(3),
    '同じ出どころの証拠を並べただけで、大きく強くなっている');
});

/* ────────────────────────────────────────────────────────────
   D. 2 位との差が足りなければ確定にしない
   ──────────────────────────────────────────────────────────── */

test('D: 2 位が拮抗していれば、条件がそろっていても確定にしない', () => {
  const top = cand(THREE_GROUPS);
  const rival = cand(THREE_GROUPS);          // まったく同じ材料の 2 位
  const res = decide([top, rival]);
  eq(res.margin, 0, '差は 0 のはず: ' + show(res));
  ok(res.verdict !== VERDICT.CONFIRMED, '拮抗しているのに確定になっている: ' + show(res));
  ok(res.missing.includes('need-separation'), show(res));
});

test('D2: 差がわずかに足りないだけでも確定にしない', () => {
  const top = cand(THREE_GROUPS);
  // 1 位の logOdds から 20 倍にわずかに届かない差を作る
  const nearly = { fusion: Object.assign({}, top.fusion, {
    logOdds: top.fusion.logOdds - Math.log(19),
  }) };
  const res = decide([top, nearly]);
  ok(res.verdict !== VERDICT.CONFIRMED, '19 倍で確定になっている: ' + show(res));
  ok(res.missing.includes('need-separation'), show(res));
});

/* ────────────────────────────────────────────────────────────
   E. 目的に結びつく証拠が無ければ確定にしない
   ──────────────────────────────────────────────────────────── */

test('E: 目的に結びつく証拠が無ければ、出どころが 3 つでも確定にしない', () => {
  const anonymous = [
    'accessor-name',      // metadata   / id なし
    'class-category',     // metadata   / id なし
    'type-declared',      // structural / id なし
    'getter-verified',    // dataflow   / id なし
    'setter-verified',
    'rmw-verified',
  ];
  const top = cand(anonymous);
  const res = decide([top, weakRunnerUp()]);
  eq(top.fusion.identifying, 0, '結びつける証拠が入ってしまっている: ' + show(res));
  ok(top.fusion.independentGroups >= 3, '出どころは 3 つ以上のはず: ' + show(res));
  ok(res.verdict !== VERDICT.CONFIRMED, '名指しの根拠なしで確定になっている: ' + show(res));
  ok(res.missing.includes('need-name-evidence'), show(res));
  /* 結びつきが無いものは、有力にも上げない（「ゲームの数値らしい」だけなので）。 */
  ok(res.verdict === VERDICT.AMBIGUOUS || res.verdict === VERDICT.NONE, show(res));
});

test('E2: 命令での裏取りだけでは確定にしない（dataflow 1 出どころ）', () => {
  const top = cand(['getter-verified', 'setter-verified', 'rmw-verified',
    'guard-verified', 'access-verified']);
  const res = decide([top, weakRunnerUp()]);
  eq(top.fusion.independentGroups, 1, '出どころは dataflow だけのはず: ' + show(res));
  ok(res.verdict !== VERDICT.CONFIRMED, '裏取りだけで確定になっている: ' + show(res));
  ok(res.missing.includes('need-name-evidence'), show(res));
  ok(res.missing.includes('need-independent-evidence'), show(res));
});

test('E3: 裏取りが無ければ確定にしない', () => {
  const top = cand(['field-name-asked', 'class-name', 'type-declared',
    'rmw-observed', 'compare-observed']);
  const res = decide([top, weakRunnerUp()]);
  eq(top.fusion.verified, 0, '裏取りが入ってしまっている: ' + show(res));
  ok(res.verdict !== VERDICT.CONFIRMED, '裏取りなしで確定になっている: ' + show(res));
  ok(res.missing.includes('need-verification'), show(res));
});

/* ────────────────────────────────────────────────────────────
   独立性の数え方そのもの（API 互換のための後方互換路も含む）
   ──────────────────────────────────────────────────────────── */

test('independentGroupCount: fuse の結果をそのまま読める', () => {
  const f = cand(THREE_GROUPS).fusion;
  eq(independentGroupCount(f), f.independentGroups);
});

test('independentGroupCount: 群が入っていない古い結果は、証拠から数え直す', () => {
  const f = cand(THREE_GROUPS).fusion;
  const legacy = Object.assign({}, f);
  delete legacy.independentGroups;
  delete legacy.groups;
  eq(independentGroupCount(legacy), 3, '証拠から数え直せていない');
});

test('independentGroupCount: 何も分からないときは 0（緩いほうへ倒さない）', () => {
  eq(independentGroupCount(null), 0);
  eq(independentGroupCount({}), 0);
  eq(independentGroupCount({ families: ['name', 'context', 'verified'] }), 0,
    '系統の数を独立性として読んでしまっている');
});

test('families は説明用として残っている（消していない）', () => {
  const f = cand(THREE_GROUPS).fusion;
  ok(Array.isArray(f.families) && f.families.length >= 3, '系統の一覧が消えている');
  ok(Array.isArray(f.groups) && f.groups.length === f.independentGroups, '群の一覧が食い違う');
  ok(f.byGroup && typeof f.byGroup === 'object', '群ごとの内訳が無い');
});

/* ────────────────────────────────────────────────────────────
   足りない理由の言葉が、実際に見ているものと一致しているか
   ──────────────────────────────────────────────────────────── */

test('missing の言葉が「出どころ」の話になっている（系統の話ではない）', () => {
  const text = missingText('need-independent-evidence');
  ok(text.length > 0, '説明が無い');
  ok(/出どころ|independent sources/.test(text),
    '「別々の種類」のままで、出どころの話になっていない: ' + text);
});

/* ────────────────────────────────────────────────────────────
   calib.js との整合
   ──────────────────────────────────────────────────────────── */

test('calib: groupedFusion も、裏取りが無ければ天井で止まる', () => {
  const unverified = groupedFusion([
    { code: 'role-formula-verified', strength: 1, lr: 260, family: FAMILY.VERIFIED, kind: 'fact', id: true },
    { code: 'fn-string-exclusive', strength: 1, lr: 1e5, family: FAMILY.NAMING, kind: 'fact', id: true },
  ], CANDIDATES);
  eq(unverified.verified, 0, '裏取りが入ってしまっている');
  ok(unverified.logOdds <= UNVERIFIED_CEIL + 1e-9,
    '未検証なのに天井を越えている: ' + unverified.probability);
  ok(unverified.probability <= 0.97 + 1e-9, '未検証なのに 97% を超えている: ' + unverified.probability);
});

test('calib: 裏取りがあれば天井は掛からない', () => {
  const verified = groupedFusion([
    { code: 'role-formula-verified', strength: 1, lr: 260, family: FAMILY.VERIFIED, kind: 'verified', id: true },
    { code: 'getter-verified', strength: 1, lr: 40, family: FAMILY.VERIFIED, kind: 'verified' },
  ], CANDIDATES);
  ok(verified.verified > 0);
  ok(verified.probability > 0.97, '裏取りがあるのに天井で止まっている: ' + verified.probability);
});

test('calib: fitCalibration の返り値を calibrateProbability がそのまま食える', () => {
  /* 60 件。低い側は当たらず、高い側は当たる、という素直な標本。 */
  const samples = [];
  for (let i = 0; i < 30; i++) samples.push({ probability: 0.05 + (i % 3) * 0.01, correct: false });
  for (let i = 0; i < 30; i++) samples.push({ probability: 0.90 + (i % 3) * 0.01, correct: i % 10 !== 0 });
  const curve = fitCalibration(samples, 10);
  ok(curve === null || Array.isArray(curve), '配列でも null でもない形を返している');
  if (curve) {
    for (const p of curve) {
      ok(Number.isFinite(p.score) && Number.isFinite(p.observed),
        'calibrateProbability が読める形になっていない: ' + JSON.stringify(p));
    }
    const out = calibrateProbability(0.95, curve);
    ok(Number.isFinite(out) && out >= 0 && out <= 1, '校正が数を返していない: ' + out);
  }
  /* 標本が足りなければ null（嘘の補正はしない）。 */
  eq(fitCalibration([{ probability: 0.5, correct: true }]), null);
});

test('calib: 校正曲線を渡しても fuse が落ちない（形が合っている）', () => {
  const samples = [];
  for (let i = 0; i < 30; i++) samples.push({ probability: 0.05 + (i % 3) * 0.01, correct: false });
  for (let i = 0; i < 30; i++) samples.push({ probability: 0.90 + (i % 3) * 0.01, correct: i % 10 !== 0 });
  const curve = fitCalibration(samples, 10);
  const f = fuse([ev('field-name-asked'), ev('getter-verified')],
    Object.assign({ calibration: curve }, CANDIDATES));
  ok(Number.isFinite(f.probability), '校正つきの合成が数を返していない');
  eq(f.calibrated, !!curve);
});

/* ── まとめ ─────────────────────────────────────────────── */

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
