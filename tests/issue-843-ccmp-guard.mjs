import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { fieldUse, verifyGuard, verifyFunctionHandlesField } from '../js/verify.js';

const BASE = 0x100000000n;

function build(lines) {
  return buildSemanticModel(lines.map((line, row) => {
    const text = String(line).trim();
    const split = text.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? text : text.slice(0, split),
      ops: split < 0 ? '' : text.slice(split + 1),
    };
  }), { startRow: 0, endRow: lines.length - 1 });
}

// Ordinary CMP is unconditional and must remain valid guard evidence.
{
  const model = build([
    'ldr w8, [x0, #0x20]',
    'cmp w8, #100',
    'b.ne #0x100000010',
    'ret',
    'ret',
  ]);
  const use = fieldUse(model, 0x20n);
  assert.equal(use.compares.length, 1);
  assert.equal(use.compares[0].mnemonic, 'cmp');
  assert.equal(use.compares[0].value, 100n);
  assert.equal(verifyGuard(model, 0x20n).guards.length, 1);
  assert.equal(verifyFunctionHandlesField(model, 0x20n).guard, true);
}

// CCMP is conditional: when EQ is false it writes fallback NZCV and never
// compares the field. A local scan cannot prove that predicate, so it must not
// promote the field comparison to unconditional guard evidence.
{
  const model = build([
    'ldr w8, [x0, #0x20]',
    'cmp w0, #0',
    'ccmp w8, #100, #0, eq',
    'b.ne #0x100000014',
    'ret',
    'ret',
  ]);
  assert.equal(model.instructions[2].mnemonic, 'ccmp');
  assert.ok(model.instructions[2].reads.includes('x8'), 'regression must exercise a decoded field operand');
  assert.equal(fieldUse(model, 0x20n).compares.length, 0);
  assert.equal(verifyGuard(model, 0x20n).guards.length, 0);
  assert.equal(verifyFunctionHandlesField(model, 0x20n).guard, false);
}

// Chained conditional compares are also path-sensitive; neither can become an
// unconditional field guard merely because the loaded register is an operand.
{
  const model = build([
    'ldr w8, [x0, #0x20]',
    'cmp w0, #0',
    'ccmp w8, #100, #0, eq',
    'ccmp w8, #200, #0, ne',
    'b.eq #0x100000018',
    'ret',
    'ret',
  ]);
  assert.equal(fieldUse(model, 0x20n).compares.length, 0);
}

console.log('issue 843 CCMP guard regression: ok');
