import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP, irText } from '../js/ir.js';

const BASE = 0x100000000n;
function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = String(line).trim();
    const p = s.indexOf(' ');
    return { row:i, address:BASE + BigInt(i * 4), mn:p < 0 ? s : s.slice(0, p), ops:p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
}
function irOf(lines) {
  const model = modelOf(lines);
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildIR(model, { rowOfAddress });
}
function loadAt(ir, row) { return ir.instructions.find((i) => i.op === OP.LOAD && i.row === row); }
function callAt(ir, row) { return ir.instructions.find((i) => i.op === OP.CALL && i.row === row); }

{
  const ir = irOf(['str w1, [sp, #0x18]','add x9, sp, #0x18','mov x10, x9','ldr w2, [sp, #0x18]','ret']);
  assert.equal(loadAt(ir, 3)?.reachingStore?.row, 0);
}
{
  const ir = irOf(['str w1, [sp, #0x18]','add x0, sp, #0x18','bl 0x100001000','ldr w2, [sp, #0x18]','ret']);
  const call = callAt(ir, 2);
  assert.ok(call?.args?.some((a) => a.value?.reg === 'x0'));
  assert.equal(loadAt(ir, 3)?.reachingStore, undefined);
  assert.equal(loadAt(ir, 3)?.memUse?.kind, 'clobber');
}
{
  const ir = irOf(['str w1, [sp, #0x18]','add x9, sp, #0x18','mov x0, x9','bl 0x100001000','ldr w2, [sp, #0x18]','ret']);
  assert.equal(loadAt(ir, 4)?.reachingStore, undefined);
  assert.equal(loadAt(ir, 4)?.memUse?.kind, 'clobber');
}
{
  const join = BASE + 5n * 4n;
  const elseAddr = BASE + 4n * 4n;
  const ir = irOf([
    'str w1, [sp, #0x18]',
    `cbz w2, 0x${elseAddr.toString(16)}`,
    'add x0, sp, #0x18',
    `b 0x${join.toString(16)}`,
    'mov x0, x3',
    'bl 0x100001000',
    'ldr w4, [sp, #0x18]',
    'ret',
  ]);
  const call = callAt(ir, 5);
  const x0 = call?.args?.find((a) => a.value?.reg === 'x0')?.value;
  if (x0?.kind !== 'phi') {
    console.error('PHI fixture IR:\n' + irText(ir, { slots:true }));
    console.error('row5 calls:', ir.instructions.filter((i) => i.row === 5).map((i) => ({op:i.op,args:i.args?.map((a)=>({reg:a.value?.reg,kind:a.value?.kind,id:a.value?.id}))})));
  }
  assert.equal(x0?.kind, 'phi', 'call argument should retain the control-flow merge');
  assert.equal(loadAt(ir, 6)?.reachingStore, undefined);
  assert.equal(loadAt(ir, 6)?.memUse?.kind, 'clobber');
}

console.log('issue #430 stack escape regressions passed');
