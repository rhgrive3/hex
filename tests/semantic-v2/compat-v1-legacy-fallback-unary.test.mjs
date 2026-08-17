import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';

const raw = [
  { row: 0, address: 0x1000n, mn: 'rbit', ops: 'x1, x0' },
  { row: 1, address: 0x1004n, mn: 'clz', ops: 'x2, x1' },
  { row: 2, address: 0x1008n, mn: 'ret', ops: '' },
];
const rowByAddress = new Map(raw.map((r) => [r.address.toString(), r.row]));
const opts = {
  startRow: 0,
  endRow: raw.length - 1,
  rowOfAddress: (addr) => rowByAddress.get(BigInt(addr).toString()) ?? null,
  addrOfRow: (row) => raw[row]?.address ?? null,
  symbolFor: () => null,
  name: 'legacy_unary_fallback',
};
const model = buildSemanticModel(raw, opts);
const result = decompile(model, { ...opts, addr: raw[0].address, forceLegacyDecompiler: true });
const text = result.lines.map((line) => line.text || '').join('\n');
assert.match(text, /reverse_bits\(x0\)/);
assert.match(text, /count_leading_zeros\(x1\)/);
assert.doesNotMatch(text, /__asm\([^\n]*(?:rbit|clz)/i);
console.log('semantic-v2 legacy fallback exact unary rendering: PASS');
