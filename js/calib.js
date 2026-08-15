/*
 * calib.js — 「確からしさ」を、飾りではなく測れる数にする。
 *
 * 相関した証拠を独立扱いしない group fusion と、Brier/ECE/誤確定率を
 * 測る calibration utilities をここに集約する。
 */
import { GROUP, groupOf, UNVERIFIED_CEIL } from './evidence.js';

export { GROUP, groupOf };

const GROUP_CAP = {
  [GROUP.METADATA]: 60,
  [GROUP.STRUCTURAL]: 12,
  [GROUP.DATAFLOW]: 4000,
  [GROUP.CONTROLFLOW]: 20,
  [GROUP.RUNTIME]: 5000,
  [GROUP.SEMANTIC]: 1e9,
  [GROUP.EXTERNAL]: 8,
};

function damp(nth) { return 1 / (1 + nth * 1.2); }
const LN = Math.log;

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
    if (delta > 0) delta *= damp(nth);
    const cap = LN(GROUP_CAP[group] != null ? GROUP_CAP[group] : 20);
    const already = byGroup.get(group) || 0;
    if (delta > 0) delta = Math.min(delta, Math.max(0, cap - already));
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
  if (!verified) logOdds = Math.min(logOdds, UNVERIFIED_CEIL);
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

function finiteProbabilityRows(samples) {
  return (samples || []).filter((s) => s && Number.isFinite(s.probability));
}

export function brierScore(samples) {
  const rows = finiteProbabilityRows(samples);
  if (!rows.length) return null;
  let sum = 0;
  for (const s of rows) {
    const p = Math.max(0, Math.min(1, s.probability));
    const y = s.correct ? 1 : 0;
    sum += (p - y) ** 2;
  }
  return sum / rows.length;
}

export function expectedCalibrationError(samples, binCount = 10) {
  const rows = finiteProbabilityRows(samples);
  if (!rows.length) return null;
  const count = normalizeBinCount(binCount);
  const bins = Array.from({ length: count }, () => ({ n: 0, conf: 0, hits: 0 }));
  for (const s of rows) {
    const p = Math.max(0, Math.min(0.999999, s.probability));
    const b = bins[Math.min(count - 1, Math.floor(p * count))];
    b.n++; b.conf += p; b.hits += s.correct ? 1 : 0;
  }
  let ece = 0;
  for (const b of bins) {
    if (!b.n) continue;
    ece += (b.n / rows.length) * Math.abs(b.hits / b.n - b.conf / b.n);
  }
  return ece;
}

export function reliabilityBins(samples, binCount = 10) {
  const rows = finiteProbabilityRows(samples);
  const count = normalizeBinCount(binCount);
  const bins = Array.from({ length: count }, (_, i) => ({
    from: i / count, to: (i + 1) / count, n: 0, confidence: 0, accuracy: 0,
  }));
  for (const s of rows) {
    const p = Math.max(0, Math.min(0.999999, s.probability));
    const b = bins[Math.min(count - 1, Math.floor(p * count))];
    b.n++; b.confidence += p; b.accuracy += s.correct ? 1 : 0;
  }
  for (const b of bins) {
    if (!b.n) continue;
    b.confidence /= b.n;
    b.accuracy /= b.n;
  }
  return bins;
}

function normalizeBinCount(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 2 && n <= 100 ? n : 10;
}

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
    falseConfirmRate: confirmed.length ? confirmedWrong.length / confirmed.length : null,
    abstentions: total - answered.length,
    abstentionAccuracy: (total - answered.length)
      ? all.filter((r) => (!r.verdict || r.verdict === 'none') && !r.correct).length / (total - answered.length)
      : null,
  };
}

/**
 * Weighted pool-adjacent-violators (PAV) isotonic regression.
 * Raw empirical bins can go 0.90 -> 0.55 merely from sampling noise. A
 * calibration function must be monotone: raising the model score must never
 * lower the fitted correctness probability. Adjacent violating bins are pooled
 * using their sample counts as weights.
 */
function isotonic(points) {
  const blocks = [];
  for (const point of points) {
    const weight = Math.max(1, Number(point.n) || 1);
    blocks.push({
      scoreWeight: point.score * weight,
      hitWeight: point.observed * weight,
      weight,
      fromScore: point.score,
      toScore: point.score,
    });
    while (blocks.length >= 2) {
      const right = blocks[blocks.length - 1];
      const left = blocks[blocks.length - 2];
      if (left.hitWeight / left.weight <= right.hitWeight / right.weight) break;
      blocks.splice(blocks.length - 2, 2, {
        scoreWeight: left.scoreWeight + right.scoreWeight,
        hitWeight: left.hitWeight + right.hitWeight,
        weight: left.weight + right.weight,
        fromScore: left.fromScore,
        toScore: right.toScore,
      });
    }
  }
  return blocks.map((block) => ({
    score: block.scoreWeight / block.weight,
    observed: block.hitWeight / block.weight,
    n: block.weight,
    fromScore: block.fromScore,
    toScore: block.toScore,
  }));
}

/**
 * Return the exact array shape consumed by evidence.js calibrateProbability().
 * At least 40 samples and 3 populated raw bins are required; otherwise we keep
 * the uncalibrated probability rather than fitting noise.
 */
export function fitCalibration(samples, binCount = 10) {
  const rows = finiteProbabilityRows(samples);
  if (rows.length < 40) return null;
  const raw = reliabilityBins(rows, binCount)
    .filter((b) => b.n >= 3)
    .map((b) => ({ score: b.confidence, observed: b.accuracy, n: b.n }))
    .sort((a, b) => a.score - b.score);
  if (raw.length < 3) return null;
  const curve = isotonic(raw);
  return curve.length >= 2 ? curve : null;
}
