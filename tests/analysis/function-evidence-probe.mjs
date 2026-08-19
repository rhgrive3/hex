import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { NodeBackend } from '../harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const p = `--${name}=`;
  const hit = argv.find((x) => x.startsWith(p));
  return hit ? hit.slice(p.length) : fallback;
};
const target = arg('target');
const oraclePath = arg('oracle');
const outPath = arg('out', 'function-evidence.json');
if (!target || !oraclePath) throw new Error('need --target and --oracle');

function fileShim(p) {
  const buf = fs.readFileSync(p);
  return {
    name: path.basename(p), size: buf.length,
    slice(a, b) {
      const s = buf.subarray(a, b);
      return { arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) };
    },
  };
}
const backend = new NodeBackend();
const info = await backend.open(fileShim(path.resolve(target)));
// Match openBinary()/UI initialization: analyze the Mach-O slice before asking
// the worker for function guesses so slice metadata/function tables are ready.
await backend.analyze(0);
const regions = [].concat(...info.slices.map((s) => s.regions), [info.raw]);
const region = regions.find((r) => r.section === '__text' && r.size > 0n) || regions.find((r) => r.exec && r.size > 0n);
if (!region) throw new Error('executable region not found');
const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
const truth = oracle.functionStarts.map(Number);
const truthSet = new Set(truth);
const result = await backend.guessFunctions(region.id, 400000);
if (!result.analysisEvidenceMasks || result.analysisEvidenceMasks.length !== result.starts.length) {
  throw new Error('analysisEvidenceMasks missing or misaligned');
}
const starts = Array.from(result.starts, Number);
const masks = result.analysisEvidenceMasks;

const bitNames = [
  'data','structured','exactMetadata','unwind','directCall','prologue','terminalStart',
  'indirectTerminalStart','conditionalTarget','tailCall','exceptionLandingPad',
  'interiorFrameSetup','denseAddressLeaf','trapTerminalStart','indirectThunk','repeatedThunkOrTail',
];
const decodeMask = (m) => bitNames.filter((_, i) => m & (1 << i));
const fmt = (n) => '0x' + n.toString(16);

const cache = new Map();
async function insn(addr) {
  const row = Math.floor((addr - Number(region.vmAddr)) / 4);
  if (row < 0) return null;
  const chunk = Math.floor(row / 1024);
  if (!cache.has(chunk)) cache.set(chunk, backend.fetchChunk(region.id, chunk, true));
  const c = await cache.get(chunk);
  const i = row % 1024;
  if (!c?.mn || i < 0 || i >= c.mn.length) return null;
  return { mn: (c.mn[i] || '').trim().toLowerCase(), ops: (c.ops[i] || '').trim() };
}
function nearestTruth(addr) {
  let lo = 0, hi = truth.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (truth[m] < addr) lo = m + 1; else hi = m; }
  return {
    prev: lo ? { addr: fmt(truth[lo - 1]), delta: addr - truth[lo - 1] } : null,
    next: lo < truth.length ? { addr: fmt(truth[lo]), delta: truth[lo] - addr } : null,
  };
}

const fpByMask = new Map(), tpByMask = new Map();
const fpByPrev = new Map(), fpByMaskPrev = new Map();
const examples = new Map();
let tp = 0, fp = 0;
for (let i = 0; i < starts.length; i++) {
  const a = starts[i], m = masks[i];
  const isTrue = truthSet.has(a);
  const map = isTrue ? tpByMask : fpByMask;
  map.set(m, (map.get(m) || 0) + 1);
  if (isTrue) { tp++; continue; }
  fp++;
  const prev = await insn(a - 4);
  const cur = await insn(a);
  const prevKey = prev?.mn || '?';
  fpByPrev.set(prevKey, (fpByPrev.get(prevKey) || 0) + 1);
  const pairKey = `${m}:${prevKey}`;
  fpByMaskPrev.set(pairKey, (fpByMaskPrev.get(pairKey) || 0) + 1);
  if (!examples.has(pairKey)) {
    examples.set(pairKey, {
      addr: fmt(a), mask: m, evidence: decodeMask(m), prev, current: cur, nearestTruth: nearestTruth(a),
    });
  }
}
const gotSet = new Set(starts);
const fnList = truth.filter((a) => !gotSet.has(a));
const fnTransitions = new Map();
const fnExamples = [];
for (const a of fnList) {
  const prev = await insn(a - 4), cur = await insn(a);
  const key = `${prev?.mn || '?'}->${cur?.mn || '?'}`;
  fnTransitions.set(key, (fnTransitions.get(key) || 0) + 1);
  if (fnExamples.length < 30) fnExamples.push({ addr: fmt(a), prev, current: cur });
}
const rankMask = (map) => [...map.entries()].sort((a,b)=>b[1]-a[1]).map(([mask,count])=>({ mask, evidence: decodeMask(mask), count }));
const topMaskPrev = [...fpByMaskPrev.entries()].sort((a,b)=>b[1]-a[1]).slice(0,80).map(([key,count]) => {
  const [maskText, prev] = key.split(':'); const mask = Number(maskText);
  return { mask, evidence: decodeMask(mask), prev, count, example: examples.get(key) };
});
const precision = tp / (tp + fp), recall = tp / truth.length;
const report = {
  region: { id: region.id, vmAddr: fmt(Number(region.vmAddr)), size: Number(region.size) },
  totals: { truth: truth.length, got: starts.length, tp, fp, fn: fnList.length, precision, recall, f1: 2*precision*recall/(precision+recall) },
  fpMaskRanking: rankMask(fpByMask),
  tpMaskRanking: rankMask(tpByMask),
  fpPredecessorRanking: [...fpByPrev.entries()].sort((a,b)=>b[1]-a[1]).map(([mn,count])=>({mn,count})),
  fpMaskPredecessorRanking: topMaskPrev,
  falseNegativeTransitions: [...fnTransitions.entries()].sort((a,b)=>b[1]-a[1]).slice(0,80).map(([pattern,count])=>({pattern,count})),
  falseNegativeExamples: fnExamples,
};
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
