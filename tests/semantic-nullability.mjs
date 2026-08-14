import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP, rangeOnBranch } from '../js/ir.js';

const BASE = 0x100000000n;
function modelOf(lines) {
  const rows = lines.map((line, row) => {
    const p = line.indexOf(' ');
    return { row, address: BASE + BigInt(row * 4), mn: p < 0 ? line : line.slice(0, p), ops: p < 0 ? '' : line.slice(p + 1) };
  });
  return buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    rowOfAddress(addr) {
      const d = addr - BASE;
      return d >= 0n && d < BigInt(rows.length * 4) ? Number(d / 4n) : null;
    },
  });
}

const ir = irFor(modelOf([
  'cbz x0, #0x10000000c',
  'mov x0, #1',
  'ret',
  'mov x0, #0',
  'ret',
]));
const branch = ir.instructions.find((i) => i.op === OP.CBR);
const taken = rangeOnBranch(ir, branch, true);
const fallthrough = rangeOnBranch(ir, branch, false);
if (!taken || taken.zero !== 'zero' || taken.nullability !== 'null') {
  throw new Error('taken CBZ edge must prove zero/null');
}
if (!fallthrough || fallthrough.zero !== 'non-zero' || fallthrough.nullability !== 'non-null') {
  throw new Error('fallthrough CBZ edge must prove non-zero/non-null');
}
console.log('semantic nullability edge facts: ok');
