import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildValues, constOf, render } from '../../js/expr.js';

const BASE = 0x710000000n;
function model(lines) {
  const rows = lines.map((line, row) => {
    const s = String(line).trim();
    const sp = s.indexOf(' ');
    return { row, address:BASE + BigInt(row) * 4n, mn:sp < 0 ? s : s.slice(0,sp), ops:sp < 0 ? '' : s.slice(sp + 1).trim() };
  });
  const rowOfAddress = (addr) => Number((BigInt(addr) - BASE) / 4n);
  return buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
}

const conditions = ['eq','ne','cs','cc','hi','ls','vs','vc','ge','lt','gt','le'];
function expected(nzcv, cc) {
  const { n,z,c,v } = nzcv;
  return ({
    eq:z, ne:!z, cs:c, cc:!c, hi:c&&!z, ls:!c||z,
    vs:v, vc:!v, ge:n===v, lt:n!==v, gt:!z&&n===v, le:z||n!==v,
  })[cc];
}
function producerLine(kind) {
  switch (kind) {
    case 'adds': return 'adds w8, w0, w1';
    case 'cmn': return 'cmn w0, w1';
    case 'subs': return 'subs w8, w0, w1';
    case 'cmp': return 'cmp w0, w1';
    case 'ands': return 'ands w8, w0, w1';
    case 'tst': return 'tst w0, w1';
    case 'bics': return 'bics w8, w0, w1';
    case 'negs': return 'negs w8, w0';
    default: throw new Error(kind);
  }
}
function runConstant(kind, a, b, cc) {
  const lines = [`mov w0, #${a}`, `mov w1, #${b}`, producerLine(kind), `cset w2, ${cc}`, 'ret'];
  const values = buildValues(model(lines));
  return constOf(values.defAt(3, 'x2'));
}

// Hard-coded NZCV outcomes at boundary values. These deliberately cover carry,
// signed overflow, logical C/V=0, BICS complement semantics, and NEG INT_MIN.
const cases = [
  { kind:'adds', a:'0xffffffff', b:'1', nzcv:{n:false,z:true,c:true,v:false} },
  { kind:'cmn',  a:'0x7fffffff', b:'1', nzcv:{n:true,z:false,c:false,v:true} },
  { kind:'subs', a:'0', b:'1', nzcv:{n:true,z:false,c:false,v:false} },
  { kind:'cmp',  a:'0x80000000', b:'1', nzcv:{n:false,z:false,c:true,v:true} },
  { kind:'ands', a:'0x80000000', b:'0xffffffff', nzcv:{n:true,z:false,c:false,v:false} },
  { kind:'tst',  a:'0', b:'0xffffffff', nzcv:{n:false,z:true,c:false,v:false} },
  { kind:'bics', a:'1', b:'1', nzcv:{n:false,z:true,c:false,v:false} },
  { kind:'negs', a:'0x80000000', b:'0', nzcv:{n:true,z:false,c:false,v:true} },
];
for (const entry of cases) {
  for (const cc of conditions) {
    assert.equal(runConstant(entry.kind, entry.a, entry.b, cc), expected(entry.nzcv, cc) ? 1n : 0n,
      `${entry.kind} ${cc} must follow architectural NZCV`);
  }
}

// Non-constant flag state is retained as producer + width, not collapsed into
// a fabricated ordinary compare. SUBS/CMP retain the safe compare projection.
{
  const v = buildValues(model(['adds w8, w0, w1','cset w2, cs','ret']));
  const n = v.defAt(1,'x2');
  assert.equal(n.k,'sel');
  assert.equal(n.predicate?.producer,'adds');
  assert.equal(n.predicate?.bits,32);
  assert.equal(n.predicate?.semantics,'aarch64-nzcv-exact');
  assert.ok(n.cmp == null);
  assert.match(render(n), /C_adds32\(/);
}
{
  const v = buildValues(model(['bics w8, w0, w1','cset w2, ne','ret']));
  const n = v.defAt(1,'x2');
  assert.equal(n.predicate?.producer,'bics');
  assert.match(render(n), /Z_bics32\(/);
  assert.ok(n.cmp == null);
}
{
  const v = buildValues(model(['subs w8, w0, w1','csel w2, w3, w4, hi','ret']));
  const n = v.defAt(1,'x2');
  assert.equal(n.predicate?.producer,'subs');
  assert.ok(n.cmp?.a && n.cmp?.b, 'SUBS remains compare-compatible for min/max and readable comparisons');
}

console.log('issue #822 exact NZCV regressions: ok');
