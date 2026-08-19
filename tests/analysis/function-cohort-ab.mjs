import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const p = `--${name}=`;
  const hit = argv.find((x) => x.startsWith(p));
  return hit ? hit.slice(p.length) : dflt;
};
const TARGET = arg('target');
const ORACLE = arg('oracle');
const NAME = arg('name', path.basename(TARGET));
const MODE = arg('mode', 'baseline');
const OUT = arg('out', `cohort-${NAME}-${MODE}.json`);
if (!TARGET || !ORACLE) throw new Error('need --target and --oracle');

const thresholds = { baseline: 0.02, ratio01: 0.01, ratio005: 0.005, absolute: 0 };
if (!(MODE in thresholds)) throw new Error(`unknown mode ${MODE}`);
const threshold = thresholds[MODE];
const workerPath = path.join(ROOT, 'js/worker-legacy.js');
const original = fs.readFileSync(workerPath, 'utf8');

const gateRe = /const suppressIndirectFallthrough = dataCandidates\.size >= 1000 &&\s*indirectFallthroughData\.size >= 1000 &&\s*\(indirectFallthroughData\.size \/ dataCandidates\.size\) >= 0\.02;/;
if (!gateRe.test(original)) throw new Error('cohort gate not found');
let patched = original.replace(gateRe,
  `const suppressIndirectFallthrough = dataCandidates.size >= 1000 &&\n` +
  `    indirectFallthroughData.size >= 1000 &&\n` +
  `    (indirectFallthroughData.size / dataCandidates.size) >= ${threshold};`);
const returnNeedle = 'starts, cancelled: false, capped, truncated: capped, complete: !capped, cap, truncationReason,';
if (!patched.includes(returnNeedle)) throw new Error('return hook not found');
patched = patched.replace(returnNeedle,
  returnNeedle + '\n    analysisDataCandidates: dataCandidates.size, analysisIndirectFallthroughData: indirectFallthroughData.size, analysisSuppressIndirectFallthrough: suppressIndirectFallthrough,');

const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(ROOT, ORACLE))).toString('utf8'));
try {
  fs.writeFileSync(workerPath, patched);
  const { openBinary } = await import('../harness.mjs');
  const w = await openBinary(TARGET, { strings: false, objc: false, texts: false });
  const res = await w.backend.guessFunctions(w.region.id, 400000);
  const got = Array.from(res.starts || res.addrs || [], Number);
  const truth = oracle.functionStarts.map(Number);
  const truthSet = new Set(truth);
  let tp = 0;
  for (const a of got) if (truthSet.has(a)) tp++;
  const fp = got.length - tp;
  const fn = truth.length - tp;
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  const f1 = 2 * precision * recall / (precision + recall);
  const dataCandidates = Number(res.analysisDataCandidates ?? -1);
  const indirectFallthroughData = Number(res.analysisIndirectFallthroughData ?? -1);
  const report = {
    target: NAME, mode: MODE, threshold,
    tp, fp, fn, precision, recall, f1,
    dataCandidates, indirectFallthroughData,
    cohortRatio: dataCandidates > 0 ? indirectFallthroughData / dataCandidates : null,
    suppressionActive: !!res.analysisSuppressIndirectFallthrough,
    capped: !!res.capped,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  fs.writeFileSync(workerPath, original);
}
