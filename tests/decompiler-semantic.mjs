import assert from 'node:assert/strict';
import { buildSemanticModel, attachTexts } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';
import { buildIR, OP } from '../js/ir.js';
import { recoverInductionVariables } from '../js/decompiler/semantic.js';
import { inferSemanticTypes } from '../js/types.js';
import { decompilerSourceAddresses, formatDecompilerSource, fullDecompilerSourceText } from '../js/decompiler/provenance.js';

const BASE = 0x100000000n;
function make(lines, opts = {}) {
  const base = opts.base ?? BASE;
  const raw = lines.map((text, row) => {
    const p = text.indexOf(' ');
    return { row, address: base + BigInt(row * 4), mn: p < 0 ? text : text.slice(0, p), ops: p < 0 ? '' : text.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - base;
    return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(raw, {
    startRow: 0, endRow: raw.length - 1, rowOfAddress,
    symbolFor: opts.symbolFor || (() => null), name: opts.name || null,
  });
  return { raw, rowOfAddress, model, base };
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
  assert.match(r.pseudocode, /self->coins\s*\+=\s*(?:\(uint32_t\))?a2/);
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

// Exact apply_damage screenshot regression: 20 ARM64 instructions at 0x100000490..4DC.
{
  const base = 0x100000490n;
  const PUTS = 0x100001000n;
  const { model, rowOfAddress } = make([
    'stp x29, x30, [sp, #-32]!',
    'mov x29, sp',
    'str x0, [sp, #16]',
    'ldr w8, [x0, #0x20]',
    'ldr w9, [x0, #0x24]',
    'mul w9, w1, w9',
    'sub w8, w8, w9',
    'str w8, [x0, #0x20]',
    'cmp w8, #0',
    'b.gt #0x1000004C4',
    'mov w8, #0',
    'ldr x0, [sp, #16]',
    'str w8, [x0, #0x20]',
    'str w8, [sp, #12]',
    'adrp x0, #0x100000000',
    'add x0, x0, #0x5B4',
    `bl #0x${PUTS.toString(16)}`,
    'ldr w0, [sp, #12]',
    'ldp x29, x30, [sp], #32',
    'ret',
  ], { base, name: 'apply_damage', symbolFor: (addr) => BigInt(addr) === PUTS ? '_puts' : null });
  attachTexts(model, new Map([['4294968756', 'damage dealt to enemy']])); // 0x1000005B4

  const r = decompile(model, {
    addr: base, name: 'apply_damage', rowOfAddress, receiverType: 'Unit', beginner: false,
    symbolFor: (addr) => BigInt(addr) === PUTS ? '_puts' : null,
    fieldFor: (_base, off) => off === 0x20n ? { name: 'hp', type: 'int32' }
      : off === 0x24n ? { name: 'damageRate', type: 'uint32' } : null,
  });
  assert.equal(r.semantic, true, r.warnings?.join('\n'));
  assert.equal(r.legacyFallback, undefined);
  assert.doesNotMatch(r.pseudocode, /\b(?:var_|local_phi|phi_)\w*/i, r.pseudocode);
  assert.match(r.pseudocode, /self->hp\s*-=\s*(?:\(uint32_t\))?a2\s*\*\s*self->damageRate/);
  assert.match(r.pseudocode, /if\s*\(\s*self->hp\s*<=\s*0\s*\)/);
  assert.doesNotMatch(r.pseudocode, /if\s*\([^\n]*self->hp\s*-\s*[^\n]*damageRate/, r.pseudocode);
  assert.doesNotMatch(r.pseudocode, /if\s*\([^\n]+\)\s*\{\s*\}\s*else/s, r.pseudocode);

  const callLine = r.lines.find((l) => /\bputs\(/.test(l.text));
  assert.ok(callLine, r.pseudocode);
  assert.equal(callLine.text, 'puts("damage dealt to enemy");');
  assert.doesNotMatch(callLine.text, /\ba[234]\b/);
  assert.match(r.pseudocode, /return\s+self->hp;/);

  const update = r.lines.find((l) => /self->hp\s*-=/.test(l.text));
  assert.ok(update, r.pseudocode);
  const updateAddrs = decompilerSourceAddresses(update);
  for (const addr of [0x10000049Cn, 0x1000004A0n, 0x1000004A4n, 0x1000004A8n, 0x1000004ACn]) {
    assert.ok(updateAddrs.includes(addr), `${addr.toString(16)} missing from ${fullDecompilerSourceText(update)}`);
  }
  assert.equal(formatDecompilerSource(update), '00049C–0004AC');

  const cond = r.lines.find((l) => /if\s*\(/.test(l.text));
  assert.ok(cond);
  assert.ok(decompilerSourceAddresses(cond).includes(0x1000004B0n), fullDecompilerSourceText(cond));
  assert.ok(decompilerSourceAddresses(cond).includes(0x1000004B4n), fullDecompilerSourceText(cond));
  assert.equal(formatDecompilerSource(cond), '0004B0–0004B4');

  const zeroStore = r.lines.find((l) => /self->hp\s*=\s*0;/.test(l.text));
  assert.ok(zeroStore);
  assert.equal(formatDecompilerSource(zeroStore), '0004B8–0004C0');
  assert.equal(formatDecompilerSource(callLine), '0004C8–0004D0');
  const returnLine = r.lines.find((l) => /return\s+self->hp;/.test(l.text));
  assert.ok(returnLine);
  assert.equal(formatDecompilerSource(returnLine), '0004D4 · 0004DC');

  assert.equal(formatDecompilerSource({ source: { addresses: [0x1000004C4n, 0x1000004D4n, 0x1000004D8n, 0x1000004DCn] } }),
    '0004C4 · 0004D4–0004DC');
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
