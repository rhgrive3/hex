/*
 * calib.js — 「確からしさ」を、飾りではなく測れる数にする。
 *
 * ここには 2 つの仕事がある。
 *
 * 1. 独立した証拠群（Evidence Group）
 *
 *    evidence.js は系統（family）ごとに割引と上限を持っているが、系統はまだ細かい。
 *
 *        field 名 = hp
 *        getter 名 = hp
 *        setter 名 = setHp
 *
 *    これは 3 つの証拠に見えて、出どころは 1 つ（Objective-C のメタデータ）。
 *    相関した証拠を独立した証拠として掛けると、必ず過信する。
 *    だから系統をさらに「出どころ」でまとめ、群ごとに上限を置く。
 *
 *        metadata     クラス表・シンボル・セレクタ  ← 1 つの出どころ
 *        structural   型・大きさ・オフセットの整合
 *        dataflow     読み書きの形・値の流れ
 *        controlflow  分岐・ループの形
 *        runtime      実際に動かして確かめた
 *        semantic     開発者が書いた文言・復元した計算式
 *        external     AI や外部の知識
 *
 *    「確定」を名乗るのに要るのは、証拠の**数**ではなく、独立した**群の数**。
 *
 * 2. 校正（calibration）
 *
 *    「99.9%」と出すなら、そう出したものの 999/1000 が当たっていなければ嘘。
 *    Brier / ECE / 誤確定率をここで測る。とくに大事なのは
 *
 *        「確定」と表示したものの誤答率
 *
 *    これを 0 に近づけることが、このツールの信用そのもの。
 */

/*
 * 群の定義そのものは evidence.js が持つ（証拠の表と同じ場所に置く）。
 * ここは、その群を使って合成し、当たり具合を測る側。
 */
import { GROUP, groupOf } from './evidence.js';

export { GROUP, groupOf };

/*
 * 群 1 つだけで到達できる尤度比の上限。
 *
 * メタデータがどれだけ一致しても、それだけでは 60 倍を超えられない。
 * 実際に動かして確かめた（runtime）だけは強い。ただし群が 1 つしかないときは
 * decide() 側が確定を名乗らせない。
 */
const GROUP_CAP = {
  [GROUP.METADATA]: 60,
  [GROUP.STRUCTURAL]: 12,
  [GROUP.DATAFLOW]: 4000,
  [GROUP.CONTROLFLOW]: 20,
  [GROUP.RUNTIME]: 5000,
  [GROUP.SEMANTIC]: 1e9,
  [GROUP.EXTERNAL]: 8,
};

/* 同じ群のなかで重なった証拠の割引。1 件目はそのまま、2 件目から効きを落とす。 */
function damp(nth) { return 1 / (1 + nth * 1.2); }

const LN = Math.log;

/**
 * 独立した証拠群にまとめてから合成する。
 *
 * evidence.js の fuse() と違うのは、系統ではなく**出どころ**で束ねること。
 * 相関した証拠を掛け算しないので、過信しにくい。
 *
 * @param {Array} items evidence() の配列（code / lr / strength / family）
 * @param {object} opts { candidates, absent, prior }
 * @returns {{probability, logOdds, groups, byGroup, verified}}
 */
export function groupedFusion(items, opts) {
  const o = opts || {};
  const absent = o.absent != null ? o.absent : 40;
  const n = Math.max(2, (o.candidates != null ? o.candidates : 200) + absent);
  const prior = o.prior != null ? Math.max(1e-9, Math.min(0.5, o.prior)) : 1 / n;
  let logOdds = LN(prior / (1 - prior));

  const byGroup = new Map();
  const counted = new Map();
  const applied = [];
  let verified = 0;

  const sorted = (items || []).filter((x) => x && x.code).slice().sort((a, b) => {
    const ea = Math.abs(LN(Math.max(1e-6, a.lr || 1)) * (a.strength == null ? 1 : a.strength));
    const eb = Math.abs(LN(Math.max(1e-6, b.lr || 1)) * (b.strength == null ? 1 : b.strength));
    return eb - ea;
  });

  for (const item of sorted) {
    const group = groupOf(item);
    const nth = counted.get(group) || 0;
    counted.set(group, nth + 1);

    let delta = LN(Math.max(1e-6, item.lr || 1)) * (item.strength == null ? 1 : item.strength);
    // 打ち消す証拠（尤度比 < 1）は割り引かない。危険側に倒さないため。
    if (delta > 0) delta *= damp(nth);

    const cap = LN(GROUP_CAP[group] != null ? GROUP_CAP[group] : 20);
    const already = byGroup.get(group) || 0;
    if (delta > 0) {
      const room = Math.max(0, cap - already);
      if (delta > room) delta = room;
    }
    if (delta === 0) continue;
    byGroup.set(group, already + delta);
    logOdds += delta;
    if (item.kind === 'verified' && delta > 0) verified++;
    applied.push(Object.assign({}, item, { group, applied: delta, factor: Math.exp(delta), nth }));
  }

  const groups = Array.from(byGroup.entries())
    .filter(([, v]) => v > 0)
    .map(([g, v]) => ({ group: g, logOdds: v, factor: Math.exp(v) }))
    .sort((a, b) => b.logOdds - a.logOdds);

  return {
    logOdds,
    probability: 1 / (1 + Math.exp(-logOdds)),
    prior,
    groups,
    independentGroups: groups.length,
    byGroup: Object.fromEntries(byGroup),
    items: applied.sort((a, b) => b.applied - a.applied),
    verified,
  };
}

/* ── 校正の指標 ────────────────────────────────────────────── */

/**
 * Brier score。0 が完璧、0.25 が「いつも 50% と言う」。
 * @param {Array<{probability:number, correct:boolean}>} samples
 */
export function brierScore(samples) {
  const rows = (samples || []).filter((s) => s && typeof s.probability === 'number');
  if (!rows.length) return null;
  let sum = 0;
  for (const s of rows) {
    const y = s.correct ? 1 : 0;
    sum += (s.probability - y) ** 2;
  }
  return sum / rows.length;
}

/**
 * ECE（Expected Calibration Error）。
 * 「90% と言ったものが本当に 9 割当たっているか」のずれの平均。
 */
export function expectedCalibrationError(samples, binCount = 10) {
  const rows = (samples || []).filter((s) => s && typeof s.probability === 'number');
  if (!rows.length) return null;
  const bins = Array.from({ length: binCount }, () => ({ n: 0, conf: 0, hits: 0 }));
  for (const s of rows) {
    const p = Math.max(0, Math.min(0.999999, s.probability));
    const b = bins[Math.min(binCount - 1, Math.floor(p * binCount))];
    b.n++; b.conf += p; b.hits += s.correct ? 1 : 0;
  }
  let ece = 0;
  for (const b of bins) {
    if (!b.n) continue;
    ece += (b.n / rows.length) * Math.abs(b.hits / b.n - b.conf / b.n);
  }
  return ece;
}

/** 校正の中身を、そのまま画面に出せる形で返す。 */
export function reliabilityBins(samples, binCount = 10) {
  const rows = (samples || []).filter((s) => s && typeof s.probability === 'number');
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: i / binCount, to: (i + 1) / binCount, n: 0, confidence: 0, accuracy: 0,
  }));
  for (const s of rows) {
    const p = Math.max(0, Math.min(0.999999, s.probability));
    const b = bins[Math.min(binCount - 1, Math.floor(p * binCount))];
    b.n++; b.confidence += p; b.accuracy += s.correct ? 1 : 0;
  }
  for (const b of bins) {
    if (!b.n) continue;
    b.confidence /= b.n;
    b.accuracy /= b.n;
  }
  return bins;
}

/**
 * 精度の総まとめ。accuracy harness がそのまま出せる形。
 *
 * @param {Array} rows [{ probability, verdict, correct, rank }]
 *   verdict … 'confirmed' | 'likely' | 'ambiguous' | 'none'
 *   rank    … 正解が何位に来たか（1 始まり。見つからなければ null）
 */
export function accuracyReport(rows) {
  const all = (rows || []).filter(Boolean);
  const total = all.length;
  if (!total) {
    return { total: 0, top1: null, top3: null, precision: null, recall: null,
      brier: null, ece: null, falseConfirmRate: null, confirmed: 0, abstentions: 0 };
  }
  const answered = all.filter((r) => r.verdict && r.verdict !== 'none');
  const confirmed = all.filter((r) => r.verdict === 'confirmed');
  const confirmedWrong = confirmed.filter((r) => !r.correct);
  const inTop = (r, k) => r.rank != null && r.rank >= 1 && r.rank <= k;

  return {
    total,
    top1: all.filter((r) => inTop(r, 1)).length / total,
    top3: all.filter((r) => inTop(r, 3)).length / total,
    precision: answered.length ? answered.filter((r) => r.correct).length / answered.length : null,
    recall: all.filter((r) => r.correct).length / total,
    brier: brierScore(all),
    ece: expectedCalibrationError(all),
    confirmed: confirmed.length,
    /* いちばん大事な数。「確定」と言って外した割合。0 に近づけるのが目標。 */
    falseConfirmRate: confirmed.length ? confirmedWrong.length / confirmed.length : null,
    /* 答えを出さなかった数。出さないのは負けではない。間違えるより良い。 */
    abstentions: total - answered.length,
    /* 出さなかったもののうち、そもそも正解が無かった割合（棄権が正しかったか）。 */
    abstentionAccuracy: (total - answered.length)
      ? all.filter((r) => (!r.verdict || r.verdict === 'none') && !r.correct).length / (total - answered.length)
      : null,
  };
}

/**
 * 実測から補正曲線を作る。evidence.js の calibrateProbability に渡せる形。
 * サンプルが足りないときは null（＝補正しない）。嘘の補正はしない。
 */
export function fitCalibration(samples, binCount = 10) {
  const rows = (samples || []).filter((s) => s && typeof s.probability === 'number');
  if (rows.length < 40) return null;
  const bins = reliabilityBins(rows, binCount);
  const points = bins.filter((b) => b.n >= 3).map((b) => ({ from: b.confidence, to: b.accuracy, n: b.n }));
  return points.length >= 3 ? { points } : null;
}
