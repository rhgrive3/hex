import { buildSemanticModel, attachTexts } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';

const base = 0x100000490n;
const PUTS = 0x100001000n;
const lines = [
  'stp x29, x30, [sp, #-32]!', 'mov x29, sp', 'str x0, [sp, #16]',
  'ldr w8, [x0, #0x20]', 'ldr w9, [x0, #0x24]', 'mul w9, w1, w9',
  'sub w8, w8, w9', 'str w8, [x0, #0x20]', 'cmp w8, #0',
  'b.gt #0x1000004C4', 'mov w8, #0', 'ldr x0, [sp, #16]',
  'str w8, [x0, #0x20]', 'str w8, [sp, #12]', 'adrp x0, #0x100000000',
  'add x0, x0, #0x5B4', `bl #0x${PUTS.toString(16)}`, 'ldr w0, [sp, #12]',
  'ldp x29, x30, [sp], #32', 'ret',
];
const raw = lines.map((text, row) => {
  const p = text.indexOf(' ');
  return { row, address: base + BigInt(row * 4), mn: p < 0 ? text : text.slice(0, p), ops: p < 0 ? '' : text.slice(p + 1) };
});
const rowOfAddress = (addr) => {
  const d = BigInt(addr) - base;
  return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
};
const symbolFor = (addr) => BigInt(addr) === PUTS ? '_puts' : null;
const model = buildSemanticModel(raw, { startRow: 0, endRow: raw.length - 1, rowOfAddress, symbolFor, name: 'apply_damage' });
console.log('refs before', model.addressRefs.map((x) => ({ row:x.row, addr:String(x.addr), text:x.text })));
attachTexts(model, new Map([[String(0x1000005B4n), 'damage dealt to enemy']]));
console.log('refs after', model.addressRefs.map((x) => ({ row:x.row, addr:String(x.addr), text:x.text })));
const r = decompile(model, {
  addr: base, name:'apply_damage', rowOfAddress, receiverType:'Unit', beginner:false, symbolFor,
  fieldFor: (_b, off) => off === 0x20n ? {name:'hp',type:'int32'} : off === 0x24n ? {name:'damageRate',type:'uint32'} : null,
});
console.log(r.pseudocode);
console.log('stack slots', r.ir.stackSlots);
for (const i of r.ir.instructions.filter((x) => x.row >= 13)) {
  console.log('IR', { id:i.id,row:i.row,address:String(i.address),block:i.block,op:i.op,sub:i.sub,loc:i.loc,
    dst:i.dst && {id:i.dst.id,reg:i.dst.reg,bits:i.dst.bits},
    args:(i.args||[]).map((a)=>a?.value ? {id:a.value.id,reg:a.value.reg,kind:a.value.kind,def:a.value.def?.id} : a),
    reachingStore:i.reachingStore?.id ?? null });
}
console.log('outputs', r.semanticAst?.outputs?.map((x)=>({name:x.name,kind:x.expression?.kind,text:x.expression?.text,loc:x.expression?.location,source:x.expression?.source})));
console.log('lines', r.lines.map((l)=>({text:l.text, rows:l.source?.rows, addrs:l.source?.addresses?.map(String)})));
