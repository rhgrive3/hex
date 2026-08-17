import fs from 'node:fs';
import zlib from 'node:zlib';
import { openBinary } from './harness.mjs';
import { pseudocSamples } from './accuracy-pseudoc-shard-oracle.mjs';
import { decompileSemantic } from '../js/decompiler/semantic.js';
import { decompile as legacyDecompile } from '../js/decompile-legacy.js';
import { enhanceSemanticDecompilation } from '../js/decompiler/pipeline.js';
import { structureKnownSwitches } from '../js/decompiler/switch.js';
import { repairCanonicalPostTestLoop } from '../js/decompiler/loop-repair.js';

const target = process.argv[2];
const oraclePath = process.argv[3];
const index = Number(process.argv[4] ?? 89);
if (!target || !oraclePath || !Number.isInteger(index)) {
  throw new Error('usage: node tests/profile-decompile-hotspot.mjs <binary> <oracle.gz> [sample-index]');
}

const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
const pair = pseudocSamples(oracle.functionStarts)[index];
if (!pair) throw new Error(`sample ${index} is missing`);
const [a, end] = pair;
const w = await openBinary(target);
const model = await w.analyze(BigInt(a), BigInt(end));
const opts = {
  addr: BigInt(a),
  rowOfAddress: (x) => (x == null ? null : Number((x - w.region.vmAddr) / 4n)),
  addrOfRow: (r) => w.region.vmAddr + BigInt(r) * 4n,
  symbolFor: (x) => w.symbols.nameAt(x),
};

function timed(name, fn) {
  const t0 = performance.now();
  const value = fn();
  const ms = performance.now() - t0;
  console.error(`DECOMPILE_PROFILE ${name} ${ms.toFixed(1)}ms`);
  return value;
}

console.error(`DECOMPILE_PROFILE sample=${index} addr=0x${a.toString(16)} bytes=${end - a} instructions=${model?.instructions?.length ?? 0}`);
const semantic = timed('semantic', () => decompileSemantic(model, opts));
if (semantic) {
  const structured = timed('switches', () => structureKnownSwitches(semantic, model, opts));
  if (structured?.semantic) {
    const enhanced = timed('enhance', () => enhanceSemanticDecompilation(structured, model, opts));
    timed('loop-repair', () => repairCanonicalPostTestLoop(enhanced, (bi) => {
      const block = enhanced?.ir?.blocks?.[bi];
      if (!block) return BigInt(a);
      return model.instructions?.find((x) => x.row === block.startRow)?.address ?? BigInt(a);
    }));
  }
}
timed('legacy', () => legacyDecompile(model, opts));
