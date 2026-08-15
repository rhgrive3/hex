import fs from 'node:fs';
const path='js/decompiler/pipeline-core.js';
let s=fs.readFileSync(path,'utf8');
const old=`  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits), f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'inv') return expr.select(condition, t, expr.unary('not', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'neg') return expr.select(condition, t, expr.unary('neg', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'set' || d.sub === 'setm') return expr.select(condition, t, f, d.dst?.bits || 1, false, origin(d, d.dst));`;
const neu=`  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits), f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'inv') return expr.select(condition, t, expr.unary('not', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'neg') return expr.select(condition, t, expr.unary('neg', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  // CINC/CINV/CNEG aliases carry one source. The operation applies when the
  // alias condition is true; treating them as ordinary CS* false arms reverses semantics.
  if (d.sub === 'cinc') return expr.select(condition, expr.binary('add', t, expr.constant(1, t.bits), t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'cinv') return expr.select(condition, expr.unary('not', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'cneg') return expr.select(condition, expr.unary('neg', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'set' || d.sub === 'setm') return expr.select(condition, t, f, d.dst?.bits || 1, false, origin(d, d.dst));`;
if(!s.includes(old)) throw new Error('corrected #350 target not found');
s=s.replace(old,neu);
fs.writeFileSync(path,s);
