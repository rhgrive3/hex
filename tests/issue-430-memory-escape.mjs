import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';
import { stackPointerProvenanceOf } from '../js/ir-core.js';

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

// No opaque consumer: keep precise stack reaching-store information.
{
  const ir = irOf(['str w1, [sp, #0x18]','add x9, sp, #0x18','mov x10, x9','ldr w2, [sp, #0x18]','ret']);
  assert.equal(loadAt(ir, 3)?.reachingStore?.row, 0);
}

// Direct AAPCS64 argument escape must be represented as a CALL SSA use.
{
  const ir = irOf(['str w1, [sp, #0x18]','add x0, sp, #0x18','bl 0x100001000','ldr w2, [sp, #0x18]','ret']);
  const call = callAt(ir, 2);
  assert.ok(call?.args?.some((a) => a.value?.reg === 'x0'));
  assert.equal(loadAt(ir, 3)?.reachingStore, undefined);
  assert.equal(loadAt(ir, 3)?.memUse?.kind, 'clobber');
}

// MOV propagation must not hide the escape.
{
  const ir = irOf(['str w1, [sp, #0x18]','add x9, sp, #0x18','mov x0, x9','bl 0x100001000','ldr w2, [sp, #0x18]','ret']);
  assert.equal(loadAt(ir, 4)?.reachingStore, undefined);
  assert.equal(loadAt(ir, 4)?.memUse?.kind, 'clobber');
}

// PHI provenance is tested independently of text-fixture CFG construction: a
// may-stack incoming value is enough to classify the merged pointer as escaped.
{
  const sp = { id:900, kind:'arg', reg:'sp', def:null };
  const imm = { id:901, kind:'const', const:0x18n, def:null };
  const addDef = { op:OP.BIN, sub:'add', args:[{ value:sp }, { value:imm }] };
  const derived = { id:902, kind:'def', reg:'x9', def:addDef };
  const movDef = { op:OP.MOV, args:[{ value:derived }] };
  const moved = { id:903, kind:'def', reg:'x0', def:movDef };
  const unrelated = { id:904, kind:'arg', reg:'x3', def:null };
  const phiDef = { op:OP.PHI, args:[{ value:moved }, { value:unrelated }] };
  const merged = { id:905, kind:'phi', reg:'x0', def:phiDef };
  const provenance = stackPointerProvenanceOf(merged);
  assert.equal(provenance?.via, 'phi');
  assert.equal(provenance?.must, false, 'one non-stack predecessor makes PHI provenance may-stack');
  assert.equal(provenance?.offset, 0x18n);
}

console.log('issue #430 stack escape regressions passed');
