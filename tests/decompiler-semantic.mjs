import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';
import { buildIR, OP } from '../js/ir.js';
import { recoverInductionVariables } from '../js/decompiler/semantic.js';
import { inferSemanticTypes } from '../js/types.js';

const BASE = 0x100000000n;
function make(lines) {
  const raw = lines.map((text, row) => {
    const p = text.indexOf(' ');
    return { row, address: BASE + BigInt(row * 4), mn: p < 0 ? text : text.slice(0, p), ops: p < 0 ? '' : text.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(raw, { startRow: 0, endRow: raw.length - 1, rowOfAddress, symbolFor: () => null });
  return { raw, rowOfAddress, model };
}

// SSA + Memory SSA read-modify-write -> compound assignment.
{
  const { model, rowOfAddress } = make([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, w1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const r = decompile(model, {
    addr: BASE, name: 'addCoins', rowOfAddress, receiverType: 'PlayerData', beginner: false,
    fieldFor: (_base, off) => off === 0x20n ? { name: 'coins', type: 'int32' } : null,
  });
  assert.equal(r.semantic, true);
  assert.match(r.pseudocode, /self->coins\s*\+=\s*a2/);
  assert.ok(Array.isArray(r.evidence));
  assert.ok(r.summary);
}

// cmp+csel clamp remains one semantic expression.
{
  const { model, rowOfAddress } = make([
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, w1',
    'cmp w8, #0',
    'csel w8, wzr, w8, lt',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const r = decompile(model, {
    addr: BASE, name: 'damage', rowOfAddress, receiverType: 'Player', beginner: false,
    fieldFor: (_base, off) => off === 0x20n ? { name: 'hp', type: 'int32' } : null,
  });
  assert.match(r.pseudocode, /self->hp\s*=\s*max\(/);
  assert.match(r.pseudocode, /self->hp/);
}

// PHI induction must be detected from SSA rather than address-order guesses.
{
  const { model, rowOfAddress } = make([
    'mov w8, #0',
    'cmp w8, w1',
    'b.ge #0x100000014',
    'add w8, w8, #1',
    'b #0x100000004',
    'ret',
  ]);
  const ir = buildIR(model, { rowOfAddress });
  const iv = recoverInductionVariables(ir);
  assert.ok(iv.length >= 1, 'expected SSA PHI induction variable');
  assert.equal(iv[0].step, 1n);
  const r = decompile(model, { addr: BASE, name: 'loop', rowOfAddress, beginner: false });
  assert.ok(/for\s*\(|while\s*\(/.test(r.pseudocode), r.pseudocode);
}

// Signedness comes from semantic operations, not only access width.
{
  const s = make(['sdiv w8, w0, w1', 'mov w0, w8', 'ret']);
  const sir = buildIR(s.model, { rowOfAddress: s.rowOfAddress });
  const st = inferSemanticTypes(sir, s.model);
  const signedValue = sir.instructions.find((i) => i.op === OP.BIN && i.sub === 'sdiv').dst;
  assert.equal(st.values.get(signedValue.id).signed, true);

  const u = make(['udiv w8, w0, w1', 'mov w0, w8', 'ret']);
  const uir = buildIR(u.model, { rowOfAddress: u.rowOfAddress });
  const ut = inferSemanticTypes(uir, u.model);
  const unsignedValue = uir.instructions.find((i) => i.op === OP.BIN && i.sub === 'udiv').dst;
  assert.equal(ut.values.get(unsignedValue.id).signed, false);
}

console.log('decompiler-semantic: ok');
