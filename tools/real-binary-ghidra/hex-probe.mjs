import fs from 'node:fs';
import zlib from 'node:zlib';
import { openBinary } from '../../tests/harness.mjs';
import { decompile } from '../../js/decompile.js';

const argv = process.argv.slice(2);
const opt = (name) => {
  const hit = argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const target = opt('target');
const oraclePath = opt('oracle');
const samplePath = opt('sample');
const outPath = opt('out');
if (!target || !oraclePath || !samplePath || !outPath) {
  console.error('usage: node hex-probe.mjs --target=... --oracle=... --sample=... --out=...');
  process.exit(2);
}

const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
const truthFunctions = new Set(oracle.functionStarts.map(Number));
const truthCalls = new Set(oracle.calls.map(([a, b]) => `${Number(a)}:${Number(b)}`));

function scoreSet(have, truth) {
  let tp = 0;
  let fp = 0;
  for (const key of have) {
    if (truth.has(key)) tp++;
    else fp++;
  }
  const fn = truth.size - tp;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

function stride(list, n) {
  if (list.length <= n) return list.slice();
  const step = list.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

const w = await openBinary(target, { log: (m) => process.stderr.write(`[hex] ${m}\n`) });

const guess = await w.backend.guessFunctions(w.region.id, 400000);
const guessStarts = new Set(Array.from(guess.starts || guess.addrs || [], Number));
const functionGuess = scoreSet(guessStarts, truthFunctions);

const callEdges = new Set();
for (let i = 0; i < w.scan.callFrom.length; i++) {
  callEdges.add(`${Number(w.scan.callFrom[i])}:${Number(w.scan.callTo[i])}`);
}
const calls = scoreSet(callEdges, truthCalls);

const starts = oracle.functionStarts.map(Number);
const candidates = [];
for (let i = 0; i + 1 < starts.length; i++) {
  const size = starts[i + 1] - starts[i];
  if (size >= 64 && size <= 2048) candidates.push([starts[i], starts[i + 1]]);
}
const samples = stride(candidates, 80);
fs.writeFileSync(samplePath, samples.map(([a]) => a.toString(16)).join('\n') + '\n');

let success = 0;
let statementLines = 0;
let asmFallbacks = 0;
let gotos = 0;
let totalLines = 0;
const perFunction = [];
for (const [a, end] of samples) {
  let status = 'fail';
  let lines = 0;
  let asm = 0;
  let fnGotos = 0;
  try {
    const model = await w.analyze(BigInt(a), BigInt(end));
    if (model) {
      const res = decompile(model, {
        addr: BigInt(a),
        rowOfAddress: (x) => (x == null ? null : Number((x - w.region.vmAddr) / 4n)),
        addrOfRow: (r) => w.region.vmAddr + BigInt(r) * 4n,
        symbolFor: (x) => w.symbols.nameAt(x),
      });
      const text = res.lines.map((line) => line.text || '').join('\n');
      fnGotos = (text.match(/\bgoto\b/g) || []).length;
      for (const line of res.lines) {
        if (line.kind !== 'stmt' && line.kind !== 'ctrl') continue;
        lines++;
        if (/__asm\(/.test(line.text) && !/__asm\("br\s+x\d+"\)/.test(line.text)) asm++;
      }
      status = 'ok';
      success++;
      statementLines += lines;
      asmFallbacks += asm;
      gotos += fnGotos;
      totalLines += res.lines.length;
    }
  } catch {}
  perFunction.push({ addr: a, status, lines, asmFallbacks: asm, gotos: fnGotos });
}

const result = {
  schema: 1,
  target,
  truth: { functionStarts: truthFunctions.size, directCalls: truthCalls.size },
  structural: { functionGuess, calls },
  decompile: {
    attempted: samples.length,
    success,
    successRate: samples.length ? success / samples.length : 0,
    statementLines,
    asmFallbacks,
    cLikeRate: statementLines ? 1 - asmFallbacks / statementLines : 0,
    gotos,
    totalLines,
    perFunction,
  },
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
