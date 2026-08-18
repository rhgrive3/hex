import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildValues, constOf } from '../../js/expr.js';

function evaluate(rows, resultRow = rows.length - 1, resultReg = 'x2') {
  const raw = rows.map((r, row) => ({ row, address:0x1000n + BigInt(row * 4), mn:r.mn, ops:r.ops }));
  const rowByAddress = new Map(raw.map((r) => [r.address.toString(), r.row]));
  const model = buildSemanticModel(raw, {
    startRow:0,
    endRow:raw.length - 1,
    rowOfAddress:(addr) => rowByAddress.get(BigInt(addr).toString()) ?? null,
    addrOfRow:(row) => raw[row]?.address ?? null,
    symbolFor:() => null,
    name:'issue_798_variable_shift',
  });
  const node = buildValues(model).defAt(resultRow, resultReg);
  assert.ok(node, `missing ${resultReg} definition at row ${resultRow}`);
  const value = constOf(node);
  assert.notEqual(value, null, `expected a folded constant, got ${JSON.stringify(node)}`);
  return value;
}

function run32(mn, value, count) {
  return evaluate([
    { mn:'mov', ops:`w0, #${value}` },
    { mn:'mov', ops:`w1, #${count}` },
    { mn, ops:'w2, w0, w1' },
  ]);
}

function run64(mn, value, count) {
  return evaluate([
    { mn:'mov', ops:`x0, #${value}` },
    { mn:'mov', ops:`x1, #${count}` },
    { mn, ops:'x2, x0, x1' },
  ]);
}

// A64 variable shifts consume only the low 5 bits for W operations.
for (const [mn, value, expected32, expected33] of [
  ['lslv', 3, 3n, 6n],
  ['lsrv', 8, 8n, 4n],
  ['asrv', 8, 8n, 4n],
]) {
  assert.equal(run32(mn, value, 31), mn === 'lslv' ? 0x80000000n : 0n);
  assert.equal(run32(mn, value, 32), expected32, `${mn} W count 32 must alias count 0`);
  assert.equal(run32(mn, value, 33), expected33, `${mn} W count 33 must alias count 1`);
}

// A64 variable shifts consume only the low 6 bits for X operations.
for (const [mn, value, expected64, expected65] of [
  ['lslv', 3, 3n, 6n],
  ['lsrv', 8, 8n, 4n],
  ['asrv', 8, 8n, 4n],
]) {
  assert.equal(run64(mn, value, 63), mn === 'lslv' ? 0x8000000000000000n : 0n);
  assert.equal(run64(mn, value, 64), expected64, `${mn} X count 64 must alias count 0`);
  assert.equal(run64(mn, value, 65), expected65, `${mn} X count 65 must alias count 1`);
}

console.log('issue #798 expr variable-shift width contract: PASS');
