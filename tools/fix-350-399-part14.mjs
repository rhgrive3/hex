import fs from 'node:fs';
function edit(path,fn){const a=fs.readFileSync(path,'utf8'),b=fn(a);if(a===b)throw new Error('no change '+path);fs.writeFileSync(path,b)}
function once(s,a,b,label){const i=s.indexOf(a);if(i<0)throw new Error('missing '+label);if(s.indexOf(a,i+a.length)>=0)throw new Error('ambiguous '+label);return s.slice(0,i)+b+s.slice(i+a.length)}

edit('js/ir.js',s=>once(s,
`  let blocked = 0;
  for (const load of ir.instructions) {
    if (load.op !== OP.LOAD || !load.reachingStore) continue;
    const barrier = unknownStoreBetween(ir, load.reachingStore, load);
    if (!barrier) continue;
    load.reachingStore = null;
    load.memUse = {
      kind: 'clobber',
      key: load.loc ? load.loc.key : 'unknown',
      inst: barrier,
      block: barrier.block,
      unknownAlias: true,
    };
    load.unknownAliasBarrier = barrier;
    blocked++;
  }`,
`  let blocked = 0;
  for (const load of ir.instructions) {
    if (load.op !== OP.LOAD) continue;
    // Core Memory-SSA may already have materialized the unknown indexed store as
    // the reaching clobber. Count that blocked proof instead of requiring a stale
    // reachingStore to still be attached (#358). This keeps telemetry aligned
    // with the actual proof state without re-running alias inference.
    if (load.memUse?.kind === 'clobber' && load.memUse.unknownAlias) {
      load.unknownAliasBarrier = load.memUse.inst || null;
      blocked++;
      continue;
    }
    if (!load.reachingStore) continue;
    const barrier = unknownStoreBetween(ir, load.reachingStore, load);
    if (!barrier) continue;
    load.reachingStore = null;
    load.memUse = {
      kind: 'clobber',
      key: load.loc ? load.loc.key : 'unknown',
      inst: barrier,
      block: barrier.block,
      unknownAlias: true,
    };
    load.unknownAliasBarrier = barrier;
    blocked++;
  }`,'#358 blocked-load accounting'));

edit('tests/issues-350-399.mjs',s=>{
  s=once(s,
`import { buildIR, OP } from '../js/ir.js';`,
`import { buildIR, OP, irFor } from '../js/ir.js';`,'#358 focused import');
  const anchor=`await test('#359 field stores do not clobber private stack slots',()=>{const ir=build(['sub sp, sp, #32','str x0, [sp, #16]','str w2, [x0, #32]','ldr x3, [sp, #16]','add sp, sp, #32','ret']);const load=ir.instructions.find(x=>x.op===OP.LOAD&&x.dst?.reg==='x3');ok(load?.reachingStore,'stack reaching store was lost');eq(load.reachingStore.args[0].value.reg,'x0')});`;
  const extra=anchor+`
await test('#358 unknown indexed store is counted as a blocked concrete proof',()=>{const lines=['str w1, [x19, #0x20]','str w2, [x19, x3, lsl #2]','ldr w8, [x19, #0x20]','ret'];const rows=asm(lines);const rowOfAddress=a=>{const d=a-BASE;return d<0n||d>=BigInt(lines.length*4)?null:Number(d/4n)};const model=buildSemanticModel(rows,{startRow:0,endRow:lines.length-1,rowOfAddress});const ir=irFor(model,{rowOfAddress});const load=ir.instructions.find(x=>x.op===OP.LOAD&&x.row===2);ok(load?.memUse?.unknownAlias,'missing unknown-alias barrier');eq(ir.memorySafety.blockedLoads,1)});`;
  return once(s,anchor,extra,'#358 blocked-load focused regression');
});
