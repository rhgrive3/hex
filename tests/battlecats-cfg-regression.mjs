import { openBinary } from './harness.mjs';
import { decompile, decompiledText } from '../js/decompile.js';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const FN = 0x1001A74E4n;
const world = await openBinary('tests/battlecats', { objc: false, strings: false, texts: false });
const model = await world.analyze(FN);
assert(model, 'BattleCats function could not be analyzed');
const rowOfAddress = (addr) => world.rowOf(BigInt(addr));
const result = decompile(model, {
  addr: FN,
  rowOfAddress,
  addrOfRow: (row) => world.region.vmAddr + BigInt(row) * 4n,
  symbolFor: (addr) => world.symbols.nameAt(BigInt(addr)) || null,
});

for (const [fromAddr, toAddr] of [
  [0x1001A847Cn, 0x1001A7F90n],
  [0x1001A909Cn, 0x1001A7FCCn],
]) {
  const from = rowOfAddress(fromAddr), to = rowOfAddress(toAddr);
  assert(!model.backEdges.some((e) => e.from === from && e.to === to),
    `false natural loop survived: ${fromAddr.toString(16)} -> ${toAddr.toString(16)}`);
}
assert(result.coverage && result.coverage.missing === 0,
  `function blocks missing: ${JSON.stringify(result.coverage)}`);
assert(result.coverage.emitted === result.coverage.total,
  `not every function block was emitted: ${JSON.stringify(result.coverage)}`);
assert(result.coverage.mode === 'linear',
  `complex optimized function did not select faithful linear mode: ${JSON.stringify(result.coverage)}`);
const addresses = result.lines.filter((l) => l.addr != null).map((l) => BigInt(l.addr));
for (let i = 1; i < addresses.length; i++) {
  assert(addresses[i] >= addresses[i - 1],
    `decompiler address order jumped backwards at ${addresses[i - 1].toString(16)} -> ${addresses[i].toString(16)}`);
}
const text = decompiledText(result);
assert(!text.includes('/* 条件は読み取れません */ 1'), 'fake unreadable infinite loop survived');
console.log('BattleCats CFG regression: ok', result.coverage);
