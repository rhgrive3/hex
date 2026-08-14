import fs from 'node:fs';

// Destination width inference must cover every first-register write path, not only BIN_MN branches.
{
  const p='js/expr.js'; let s=fs.readFileSync(p,'utf8');
  const a=`    const emit = (key, v, writeBits = null) => {
      if (!key || key === 'zr' || !v) return;
      if (writeBits === 32 && /^x\\d+$/.test(key)) v = un('uxt32', v);`;
  const b=`    const emit = (key, v, writeBits = null) => {
      if (!key || key === 'zr' || !v) return;
      if (writeBits == null) {
        const first = insn.ops && insn.ops[0];
        if (first && first.k === 'reg' && regKeyOf(first) === key) writeBits = regBits(first);
      }
      if (writeBits === 32 && /^x\\d+$/.test(key)) v = un('uxt32', v);`;
  if(!s.includes(a)) throw new Error('expr emit width anchor missing');
  fs.writeFileSync(p,s.replace(a,b));
}

// Named zerofill globals need a virtual-sized region view for SymbolIndex queries.
{
  const p='js/linkage.js'; let s=fs.readFileSync(p,'utf8');
  const a=`    for (const r of dataRegions) {
      for (const s of symbols.symbolList({ region: r, kind: 0, max: 2000 })) {`;
  const b=`    for (const r of dataRegions) {
      const virtualRegion = r.size > 0n ? r : { ...r, size: r.declaredSize != null ? r.declaredSize : r.size };
      for (const s of symbols.symbolList({ region: virtualRegion, kind: 0, max: 2000 })) {`;
  if(!s.includes(a)) throw new Error('linkage virtual region anchor missing');
  fs.writeFileSync(p,s.replace(a,b));
}

// Repair calibration regression fixture to the actual fitCalibration input contract.
{
  const p='tests/issue-283-plus.mjs'; let s=fs.readFileSync(p,'utf8');
  s=s.replace(`    rows.push({score,verified});`, `    rows.push({confidence: score, verified});`);
  fs.writeFileSync(p,s);
}
