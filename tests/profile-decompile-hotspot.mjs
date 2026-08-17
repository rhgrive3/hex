import { openBinary } from './harness.mjs';
import { irFor, readModifyWrite, getSemanticMigrationMode } from '../js/ir.js';
import { analyzeGraph } from '../js/controlflow.js';
import { inferSemanticTypes } from '../js/decompiler/type-recovery.js';
import { decompileSemantic as decompileSemanticCore } from '../js/decompiler/semantic-core.js';
import { decompile as legacyDecompile } from '../js/decompile-legacy.js';

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

console.error(`DECOMPILE_PROFILE addr=${rawAddress} bytes=${bytes} instructions=${model?.instructions?.length ?? 0} migration=${getSemanticMigrationMode()}`);
const ir = timed('irFor', () => irFor(model, { rowOfAddress: opts.rowOfAddress }));
if (!ir) throw new Error('IR construction failed');
console.error(`DECOMPILE_PROFILE ir instructions=${ir.instructions?.length ?? 0} values=${ir.values?.length ?? 0} blocks=${ir.blocks?.length ?? 0}`);
timed('type-recovery', () => inferSemanticTypes(ir, model));
timed('graph', () => analyzeGraph(ir.blocks.map((b) => b.succ), ir.entry || 0));
timed('rmw', () => readModifyWrite(ir));
timed('semantic-core-with-prebuilt-ir', () => decompileSemanticCore(model, { ...opts, ir }));
timed('legacy', () => legacyDecompile(model, opts));
