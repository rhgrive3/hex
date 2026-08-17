import { openBinary } from './harness.mjs';
import { decompileSemantic } from '../js/decompiler/semantic.js';
import { decompile as legacyDecompile } from '../js/decompile-legacy.js';
import { enhanceSemanticDecompilation } from '../js/decompiler/pipeline.js';
import { structureKnownSwitches } from '../js/decompiler/switch.js';
import { repairCanonicalPostTestLoop } from '../js/decompiler/loop-repair.js';

const target = process.argv[2];
const rawAddress = process.argv[3];
const bytes = Number(process.argv[4]);
if (!target || !rawAddress || !Number.isSafeInteger(bytes) || bytes <= 0) {
  throw new Error('usage: node tests/profile-decompile-hotspot.mjs <binary> <address> <bytes>');
}

const a = BigInt(rawAddress);
const end = a + BigInt(bytes);
const w = await openBinary(target);
const model = await w.analyze(a, end);
const opts = {
  addr: a,
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

console.error(`DECOMPILE_PROFILE addr=${rawAddress} bytes=${bytes} instructions=${model?.instructions?.length ?? 0}`);
const semantic = timed('semantic', () => decompileSemantic(model, opts));
if (semantic) {
  const structured = timed('switches', () => structureKnownSwitches(semantic, model, opts));
  if (structured?.semantic) {
    const enhanced = timed('enhance', () => enhanceSemanticDecompilation(structured, model, opts));
    timed('loop-repair', () => repairCanonicalPostTestLoop(enhanced, (bi) => {
      const block = enhanced?.ir?.blocks?.[bi];
      if (!block) return a;
      return model.instructions?.find((x) => x.row === block.startRow)?.address ?? a;
    }));
  }
}
timed('legacy', () => legacyDecompile(model, opts));
