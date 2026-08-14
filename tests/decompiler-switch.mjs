import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';

const raw = [
  { row: 0, address: 0x1000n, mn: 'br',  ops: 'x8' },
  { row: 1, address: 0x1004n, mn: 'mov', ops: 'x0, #1' },
  { row: 2, address: 0x1008n, mn: 'ret', ops: '' },
  { row: 3, address: 0x100cn, mn: 'mov', ops: 'x0, #2' },
  { row: 4, address: 0x1010n, mn: 'ret', ops: '' },
  { row: 5, address: 0x1014n, mn: 'mov', ops: 'x0, #3' },
  { row: 6, address: 0x1018n, mn: 'ret', ops: '' },
];
const byAddr = new Map(raw.map((x) => [x.address.toString(), x.row]));
const rowOfAddress = (addr) => byAddr.get(BigInt(addr).toString()) ?? null;
const addrOfRow = (row) => raw[row]?.address ?? null;
const model = buildSemanticModel(raw, { startRow: 0, endRow: raw.length - 1, rowOfAddress, addrOfRow });

const result = decompile(model, {
  addr: 0x1000n, rowOfAddress, addrOfRow, beginner: false,
  jumpTables: [{
    row: 0,
    expr: 'kind',
    cases: [
      { value: 0, address: 0x1004n },
      { value: 1, address: 0x100cn },
    ],
    defaultAddress: 0x1014n,
  }],
});

assert.match(result.pseudocode, /switch \(kind\)/);
assert.match(result.pseudocode, /case 0: goto loc_1004;/);
assert.match(result.pseudocode, /case 1: goto loc_100C;/i);
assert.match(result.pseudocode, /default: goto loc_1014;/);
assert.ok(result.evidence.some((e) => e.reason === 'verified jump-table/switch descriptor'));

// With no verified descriptor the same indirect branch must remain explicit,
// never be invented as a switch.
const unknown = decompile(model, { addr: 0x1000n, rowOfAddress, addrOfRow, beginner: false });
assert.equal(/switch\s*\(/.test(unknown.pseudocode), false);
assert.match(unknown.pseudocode, /br x8|__asm/);

console.log('decompiler-switch: ok');
