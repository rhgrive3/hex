import fs from 'node:fs';
function edit(path,fn){const a=fs.readFileSync(path,'utf8'),b=fn(a);if(a===b)throw new Error('no change '+path);fs.writeFileSync(path,b)}
function once(s,a,b,label){const i=s.indexOf(a);if(i<0)throw new Error('missing '+label);if(s.indexOf(a,i+a.length)>=0)throw new Error('ambiguous '+label);return s.slice(0,i)+b+s.slice(i+a.length)}

edit('js/ir-core.js',s=>{
  const anchor=`export function mayAlias(a, b) {
  if (!a || !b) return true;
  if (a.key === b.key) return true;
  if (a.kind === MK.UNKNOWN || b.kind === MK.UNKNOWN) return true;
  if (a.kind !== b.kind) {
    // stack と global は決して重ならない。field は何にでも化けうる。
    if (a.kind === MK.FIELD || b.kind === MK.FIELD) return true;
    return false;
  }
  if (a.kind === MK.STACK || a.kind === MK.GLOBAL) {
    if (a.kind === MK.STACK && (a.baseReg !== b.baseReg || a.frameEpoch !== b.frameEpoch)) return true;
    const pa = a.kind === MK.STACK ? a.disp : a.address;
    const pb = b.kind === MK.STACK ? b.disp : b.address;
    if (pa == null || pb == null) return true;
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(pa + sa <= pb || pb + sb <= pa);
  }
  // field 同士: ベースが同じ SSA 値なら、オフセットの重なりだけで判定できる
  if (a.base && b.base && a.base.id === b.base.id) {
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(a.disp + sa <= b.disp || b.disp + sb <= a.disp);
  }
  return true;
}`;
  const replacement=anchor+`

/**
 * A concrete store may *define/clobber* another Memory-SSA range only when
 * overlap is established, not merely possible. mayAlias() intentionally answers
 * conservatively for query safety (e.g. an object pointer could theoretically
 * point at a stack slot); using that predicate for every store destroys stack
 * promotion. Unknown-address stores remain conservative and clobber all ranges.
 */
function storeOverlapsRange(storeLoc, otherLoc) {
  if (!storeLoc || !otherLoc) return true;
  if (storeLoc.kind === MK.UNKNOWN) return true;
  if (otherLoc.kind === MK.UNKNOWN) return false;
  if (storeLoc.kind !== otherLoc.kind) return false;
  const overlap = (pa, sa, pb, sb) => !(pa + sa <= pb || pb + sb <= pa);
  const sa=BigInt(storeLoc.size || 8), sb=BigInt(otherLoc.size || 8);
  if (storeLoc.kind === MK.GLOBAL) {
    if (storeLoc.address == null || otherLoc.address == null) return false;
    return overlap(storeLoc.address,sa,otherLoc.address,sb);
  }
  if (storeLoc.kind === MK.STACK) {
    if (storeLoc.baseReg !== otherLoc.baseReg || storeLoc.frameEpoch !== otherLoc.frameEpoch) return false;
    if (storeLoc.disp == null || otherLoc.disp == null) return false;
    return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
  }
  if (storeLoc.kind === MK.FIELD) {
    if (!storeLoc.base || !otherLoc.base || storeLoc.base.id !== otherLoc.base.id) return false;
    if (storeLoc.disp == null || otherLoc.disp == null) return false;
    return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
  }
  return false;
}`;
  s=once(s,anchor,replacement,'#359 definite overlap helper');
  s=once(s,
`      if (!mayAlias(inst.loc, loc)) continue;
      let defs = defSites.get(key);`,
`      if (!storeOverlapsRange(inst.loc, loc)) continue;
      let defs = defSites.get(key);`,'#359 defsite overlap scope');
  s=once(s,
`          if (!mayAlias(inst.loc, loc)) continue;
          const exact = key === inst.loc.key;`,
`          if (!storeOverlapsRange(inst.loc, loc)) continue;
          const exact = inst.loc.kind !== MK.UNKNOWN && key === inst.loc.key;`,'#359 rename overlap scope');
  return s;
});

edit('tests/issues-350-399.mjs',s=>{
  const anchor=`await test('#359 overlapping partial store kills wider reaching store',()=>{const ir=build(['str x1, [x0]','strb w2, [x0]','ldr x3, [x0]','ret']);const load=ir.instructions.find(x=>x.op===OP.LOAD);eq(load.reachingStore,undefined)});`;
  const extra=anchor+`
await test('#359 field stores do not clobber private stack slots',()=>{const ir=build(['sub sp, sp, #32','str x0, [sp, #16]','str w2, [x0, #32]','ldr x3, [sp, #16]','add sp, sp, #32','ret']);const load=ir.instructions.find(x=>x.op===OP.LOAD&&x.dst?.reg==='x3');ok(load?.reachingStore,'stack reaching store was lost');eq(load.reachingStore.args[0].value.reg,'x0')});`;
  return once(s,anchor,extra,'#359 stack preservation regression');
});
