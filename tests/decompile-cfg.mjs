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
  console.log('CLEANUP_CFG_DIAG', JSON.stringify({
    modelBlocks: (model.blocks || []).map((b, i) => ({ i, startRow: b.startRow, endRow: b.endRow, succ: b.succ, successors: b.successors })),
    modelInstructions: (model.instructions || []).map((i) => ({ row: i.row, address: String(i.address), mn: i.mnemonic || i.mn, ops: i.operandsText || i.ops, target: i.target == null ? null : String(i.target), branchTarget: i.branchTarget == null ? null : String(i.branchTarget) })),
    irBlocks: (result.ir?.blocks || []).map((b) => ({ index: b.index, startRow: b.startRow, endRow: b.endRow, succ: b.succ, pred: b.pred })),
    dominators: (result.ir?.dominators || []).map((s) => s ? [...s] : null),
    coverage: result.coverage,
    lines: (result.lines || []).map((l) => ({ row: l.row, kind: l.kind, text: l.text })),
    warnings: result.warnings,
  }, (_k, v) => typeof v === 'bigint' ? String(v) : v));
  assert.equal(result.lines.some((l) => /\bwhile\s*\(/.test(l.text || '')), false,
    'shared cleanup was incorrectly rendered as a loop');
  assert.ok(result.lines.some((l) => (l.text || '').includes('loc_1004')),
    'cleanup edge was not preserved');
}

console.log('decompile-cfg: ok');
