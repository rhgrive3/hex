import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';

function makeModel(rows) {
  const raw = rows.map((r, row) => ({
    row,
    address: BigInt(r.address),
    mn: r.mn,
    ops: r.ops || '',
  }));
  const rowByAddress = new Map(raw.map((r) => [r.address.toString(), r.row]));
  const rowOfAddress = (addr) => rowByAddress.get(BigInt(addr).toString()) ?? null;
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const opts = {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress,
    addrOfRow,
    symbolFor: () => null,
    name: 'test_cfg',
  };
  return { raw, opts, model: buildSemanticModel(raw, opts) };
}

// Regression for optimized shared cleanup. The last block is physically after
// the cleanup block but jumps backward into it. There is no cycle, so this must
// remain a goto/structured join and never become a do-while.
{
  const { raw, opts, model } = makeModel([
    { address: 0x1000, mn: 'cbnz', ops: 'x0, 0x100c' },
    { address: 0x1004, mn: 'mov',  ops: 'x0, #0' },
    { address: 0x1008, mn: 'ret',  ops: '' },
    { address: 0x100c, mn: 'mov',  ops: 'x1, #1' },
    { address: 0x1010, mn: 'b',    ops: '0x1004' },
  ]);

  assert.equal(model.backEdges.length, 0, 'backward address jump is not a natural loop');
  const result = decompile(model, { ...opts, addr: raw[0].address, beginner: false });
  assert.equal(result.lines.some((l) => /\bwhile\s*\(/.test(l.text || '')), false,
    'shared cleanup was incorrectly rendered as a loop');
  assert.ok(result.lines.some((l) => (l.text || '').includes('loc_1004')),
    'cleanup edge was not preserved');
}

console.log('decompile-cfg: ok');
