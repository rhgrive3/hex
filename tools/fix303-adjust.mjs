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

// Goal evidence correlation is independently testable and reused by FunctionReport.
{
  const p='js/report.js'; let s=fs.readFileSync(p,'utf8');
  s=s.replace(`function unknown(code, detail) {
  return { certainty: CERTAINTY.UNKNOWN, code, detail: detail || null };
}`, `function unknown(code, detail) {
  return { certainty: CERTAINTY.UNKNOWN, code, detail: detail || null };
}

export function goalEvidenceConfidence(hits) {
  const groups = new Set((hits || []).map((h) => h.group || GROUP.EXTERNAL));
  const n = groups.size;
  if (!n) return 0;
  return n === 1 ? 0.52 : n === 2 ? 0.76 : Math.min(0.91, 0.76 + 0.15 * (n - 2));
}`);
  const inline=`      const groups = new Set(hits.map((h) => h.group || GROUP.EXTERNAL));
      const groupCount = groups.size;
      // Same-source repeats only improve trace detail, never confidence. Heterogeneous groups do.
      const conf = groupCount <= 1 ? 0.52 : groupCount === 2 ? 0.76 : Math.min(0.91, 0.76 + 0.15 * (groupCount - 2));`;
  if(!s.includes(inline)) throw new Error('goal confidence inline anchor missing');
  s=s.replace(inline, `      // Same-source repeats only improve trace detail, never confidence. Heterogeneous groups do.
      const conf = goalEvidenceConfidence(hits);`);
  s=s.replace(`      fieldCandidate: u.field && !u.field.certain ? null : undefined,\n`, '');
  fs.writeFileSync(p,s);
}

// Repair calibration regression fixture to the actual fitCalibration input contract.
{
  const p='tests/issue-283-plus.mjs'; let s=fs.readFileSync(p,'utf8');
  s=s.replace(`    rows.push({score,verified});`, `    rows.push({ probability: score, correct: !!verified });`);
  fs.writeFileSync(p,s);
}
