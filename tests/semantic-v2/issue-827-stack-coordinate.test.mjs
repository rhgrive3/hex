import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP, mustAlias, mayAliasProvenance } from '../../js/ir.js';

const BASE = 0x720000000n;
function built(lines) {
  const rows = lines.map((line, row) => {
    const text = String(line).trim();
    const split = text.indexOf(' ');
    return {
      row,
      address:BASE + BigInt(row) * 4n,
      mn:split < 0 ? text : text.slice(0, split),
      ops:split < 0 ? '' : text.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => Number((BigInt(address) - BASE) / 4n);
  const model = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
  return buildIR(model, { rowOfAddress });
}
function accesses(ir) {
  return ir.instructions.filter((inst) => inst.op === OP.LOAD || inst.op === OP.STORE);
}
function assertCanonical(loc, offset) {
  assert.equal(loc.disp, offset);
  assert.ok(String(loc.key).startsWith(`stack:${BigInt.asUintN(64, offset).toString()}`), `key ${loc.key} must encode ${offset}`);
}

// frame base sp+16, local disp -8 => total sp+8; same coordinate must alias,
// direct sp-8 must not.
{
  const ir = built([
    'add x29, sp, #16',
    'str x0, [x29, #-8]',
    'ldr x1, [sp, #8]',
    'ldr x2, [sp, #-8]',
    'ret',
  ]);
  const [frameStore, directPlus, directMinus] = accesses(ir);
  assertCanonical(frameStore.loc, 8n);
  assertCanonical(directPlus.loc, 8n);
  assertCanonical(directMinus.loc, -8n);
  assert.equal(mustAlias(frameStore.loc, directPlus.loc), true);
  assert.equal(mustAlias(frameStore.loc, directMinus.loc), false);
  assert.equal(frameStore.loc.key, directPlus.loc.key, 'same-size same-coordinate public keys are identical');
  assert.equal(frameStore.loc.regionId, directPlus.loc.regionId, 'same stack coordinate remains in one canonical region');
}

// Nested SP-derived temporary: x9=sp+32, x10=x9-16, [x10-8] => sp+8.
{
  const ir = built([
    'add x9, sp, #32',
    'sub x10, x9, #16',
    'str x0, [x10, #-8]',
    'ldr x1, [sp, #8]',
    'ret',
  ]);
  const [nested, direct] = accesses(ir);
  assertCanonical(nested.loc, 8n);
  assertCanonical(direct.loc, 8n);
  assert.equal(mustAlias(nested.loc, direct.loc), true);
  assert.equal(nested.loc.key, direct.loc.key);
  assert.equal(nested.loc.regionId, direct.loc.regionId);
}

// Negative total offset remains signed in loc.disp while key uses canonical
// modulo-u64 spelling. sp+16-24 == sp-8.
{
  const ir = built([
    'add x29, sp, #16',
    'str x0, [x29, #-24]',
    'ldr x1, [sp, #-8]',
    'ret',
  ]);
  const [frameStore, direct] = accesses(ir);
  assertCanonical(frameStore.loc, -8n);
  assertCanonical(direct.loc, -8n);
  assert.equal(mustAlias(frameStore.loc, direct.loc), true);
  assert.equal(frameStore.loc.key, direct.loc.key);
  assert.equal(frameStore.loc.regionId, direct.loc.regionId);
}

// Same byte start but different widths overlap without becoming MustAlias.
// The coordinate remains canonical even when a separate size-qualified public
// location object is required.
{
  const ir = built([
    'add x29, sp, #16',
    'str x0, [x29, #-8]',
    'ldr w1, [sp, #8]',
    'ret',
  ]);
  const [wide, narrow] = accesses(ir);
  assertCanonical(wide.loc, 8n);
  assertCanonical(narrow.loc, 8n);
  assert.equal(wide.loc.size, 8);
  assert.equal(narrow.loc.size, 4);
  assert.equal(wide.loc.regionId, narrow.loc.regionId, 'different-width accesses still refer to the same stack region');
  assert.equal(mustAlias(wide.loc, narrow.loc), false);
  assert.equal(mayAliasProvenance(wide.loc, narrow.loc), true);
}

console.log('issue #827 canonical stack coordinate regressions: ok');
