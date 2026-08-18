import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildCfg, EDGE } from '../js/cfg.js';
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

function cfgFixture({ instructions, blocks, rowOfAddress }) {
  return buildCfg({ instructions, basicBlocks: blocks, semantic: [] }, { rowOfAddress });
}
const block = (startRow, endRow = startRow) => ({ startRow, endRow, rows: [] });
const insn = (row, address, patch = {}) => ({
  row, address: BigInt(address), mnemonic: patch.mnemonic || 'mov', data: false,
  isBranch: false, isCall: false, isReturn: false, isConditional: false, branchTarget: null,
  ...patch,
});

// #836: basicBlocks array order is not physical fallthrough order.
{
  const instructions = [
    insn(0, 0x2000, { mnemonic: 'cbnz', isBranch: true, isConditional: true, branchTarget: 0x200cn }),
    insn(1, 0x2004),
    insn(2, 0x2008, { mnemonic: 'ret', isReturn: true }),
    insn(3, 0x200c),
    insn(4, 0x2010, { mnemonic: 'ret', isReturn: true }),
  ];
  const rows = new Map(instructions.map((x) => [x.address.toString(), x.row]));
  // Deliberately shuffled: array index 1 is the taken/cold block, while physical
  // fallthrough from row 0 is row 1 in array index 2.
  const cfg = cfgFixture({
    instructions,
    blocks: [block(0), block(3, 4), block(1, 2)],
    rowOfAddress: (addr) => rows.get(BigInt(addr).toString()) ?? null,
  });
  const taken = cfg.nodes[0].succ.find((e) => e.kind === EDGE.TAKEN);
  const fall = cfg.nodes[0].succ.find((e) => e.kind === EDGE.FALL);
  assert.equal(taken?.to, 1, 'taken edge must target the cold block containing the branch target');
  assert.equal(fall?.to, 2, 'fallthrough must target the block containing the next physical row');
  assert.notEqual(taken?.to, fall?.to, 'conditional edges must not collapse onto blocks[index+1]');
  assert.deepEqual(cfg.nodes[2].pred, [{ from: 0, kind: EDGE.FALL }]);
}

// A non-branch terminator also falls through by physical row, not array index.
{
  const instructions = [
    insn(0, 0x3000),
    insn(1, 0x3004, { mnemonic: 'ret', isReturn: true }),
    insn(2, 0x3008, { mnemonic: 'ret', isReturn: true }),
  ];
  const cfg = cfgFixture({
    instructions,
    blocks: [block(0), block(2), block(1)],
    rowOfAddress: () => null,
  });
  assert.deepEqual(cfg.nodes[0].succ, [{ to: 2, kind: EDGE.FALL }]);
}

// A truncated/gapped listing must fail closed instead of inventing a fall edge.
{
  const cfg = cfgFixture({
    instructions: [insn(0, 0x4000), insn(2, 0x4008, { mnemonic: 'ret', isReturn: true })],
    blocks: [block(0), block(2)],
    rowOfAddress: () => null,
  });
  assert.equal(cfg.nodes[0].succ.length, 0);
  assert.equal(cfg.nodes[0].isExit, true);
}

// A conditional branch outside the function still keeps its local physical fallthrough.
{
  const cfg = cfgFixture({
    instructions: [
      insn(0, 0x5000, { mnemonic: 'cbnz', isBranch: true, isConditional: true, branchTarget: 0x9000n }),
      insn(1, 0x5004, { mnemonic: 'ret', isReturn: true }),
    ],
    blocks: [block(0), block(1)],
    rowOfAddress: () => null,
  });
  assert.ok(cfg.nodes[0].succ.some((e) => e.kind === EDGE.TAKEN && e.outside === true));
  assert.ok(cfg.nodes[0].succ.some((e) => e.kind === EDGE.FALL && e.to === 1));
  assert.equal(cfg.nodes[0].isExit, false);
}

console.log('decompile-cfg / #836 physical fallthrough regressions: ok');
