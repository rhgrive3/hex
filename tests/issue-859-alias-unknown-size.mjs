import assert from 'node:assert/strict';
import { MK, VK, mustAlias, mayAliasProvenance } from '../js/ir.js';

function verifyFamily(label, make) {
  const unknownAtA = make(0n, null);
  const size4AtA = make(0n, 4);
  const size8AtA = make(0n, 8);
  const size8AtAPlus8 = make(8n, 8);

  assert.equal(mustAlias(unknownAtA, size4AtA), false, `${label}: unknown extent must not prove MustAlias`);
  assert.equal(mustAlias(size4AtA, unknownAtA), false, `${label}: MustAlias must remain conservative when operands are swapped`);
  assert.equal(mayAliasProvenance(unknownAtA, size8AtAPlus8), true, `${label}: unknown extent must not prove NoAlias`);
  assert.equal(mayAliasProvenance(size8AtAPlus8, unknownAtA), true, `${label}: may-alias result must be order independent`);
  assert.equal(mayAliasProvenance(size8AtA, size8AtAPlus8), false, `${label}: known adjacent extents remain proven disjoint`);
  assert.equal(mustAlias(size8AtA, make(0n, 8)), true, `${label}: known equal extent at identical identity remains MustAlias`);
}

verifyFamily('global', (delta, size) => ({
  kind: MK.GLOBAL,
  address: 0x1000n + delta,
  size,
}));

verifyFamily('stack', (delta, size) => ({
  kind: MK.STACK,
  disp: 0x20n + delta,
  size,
}));

const root = { id: 0x859, kind: VK.ARG, reg: 'x0', bits: 64, def: null };
verifyFamily('same-root-field', (delta, size) => ({
  kind: MK.FIELD,
  base: root,
  disp: 0x30n + delta,
  size,
}));

console.log('issue #859 unknown alias extent regression: PASS');
