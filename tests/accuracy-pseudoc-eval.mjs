import { decompile } from '../js/decompile.js';
import { pseudocSamples } from './accuracy-pseudoc-shard-oracle.mjs';

export async function evaluatePseudocSample(w, pair) {
  const [a, end] = pair;
  const analyzeStart = Date.now();
  const model = await w.analyze(BigInt(a), BigInt(end));
  const analyzeMs = Date.now() - analyzeStart;
  if (!model) return { lines: 0, asmLines: 0, done: 0, analyzeMs, decompileMs: 0 };

  let res;
  const decompileStart = Date.now();
  try {
    res = decompile(model, {
      addr: BigInt(a),
      rowOfAddress: (x) => (x == null ? null : Number((x - w.region.vmAddr) / 4n)),
      addrOfRow: (r) => w.region.vmAddr + BigInt(r) * 4n,
      symbolFor: (x) => w.symbols.nameAt(x),
    });
  } catch {
    return {
      lines: 0,
      asmLines: 0,
      done: 0,
      analyzeMs,
      decompileMs: Date.now() - decompileStart,
    };
  }
  const decompileMs = Date.now() - decompileStart;

  let lines = 0;
  let asmLines = 0;
  for (const l of res.lines) {
    if (l.kind !== 'stmt' && l.kind !== 'ctrl') continue;
    lines++;
    // A register-indirect `br` has no statically knowable target. The faithful
    // linear fallback deliberately preserves it as inline asm; that is a
    // translated control-flow fact, not an untranslated opcode.
    if (/__asm\(/.test(l.text) && !/__asm\("br\s+x\d+"\)/.test(l.text)) asmLines++;
  }
  return { lines, asmLines, done: 1, analyzeMs, decompileMs };
}

export async function evaluatePseudocSamples(w, functionStarts) {
  let lines = 0;
  let asmLines = 0;
  let done = 0;
  for (const pair of pseudocSamples(functionStarts)) {
    const result = await evaluatePseudocSample(w, pair);
    lines += result.lines;
    asmLines += result.asmLines;
    done += result.done;
  }
  return pseudocResult(lines, asmLines, done);
}

export function pseudocResult(lines, asmLines, done, ms = undefined) {
  const row = {
    score: lines ? 1 - asmLines / lines : 0,
    detail: `${lines - asmLines}/${lines} 行が C の式になった（関数 ${done} 本）`,
  };
  if (ms !== undefined) row.ms = ms;
  return row;
}
