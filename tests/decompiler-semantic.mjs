import assert from 'node:assert/strict';
import { decompile, decompilerSourceAddresses, fullDecompilerSourceText } from '../js/decompiler.js';
import { makeInstruction } from '../js/semantics.js';

function modelFrom(lines, { base = 0x100000000n, name = 'fn', symbolFor = null } = {}) {
  const instructions = lines.map((text, row) => {
    const [mnemonic, ...rest] = String(text).trim().split(/\s+/);
    return makeInstruction(row, base + BigInt(row * 4), mnemonic, rest.join(' '));
  });
  return { name, base, instructions, symbolFor };
}

function attachTexts(model, texts) {
  model.textAt = (addr) => texts.get(BigInt(addr).toString()) ?? null;
  return model;
}

function rowOfAddressFactory(base, count) {
  const by = new Map(Array.from({ length: count }, (_, i) => [(base + BigInt(i * 4)).toString(), i]));
  return (addr) => by.get(BigInt(addr).toString()) ?? null;
}

{
  const base = 0x100000400n;
  const PUTS = 0x100001000n;
  const model = modelFrom([
    'stp x29, x30, [sp, #-32]!',
    'mov x29, sp',
    'str x0, [sp, #24]',
    'str w1, [sp, #20]',
    'ldr x8, [sp, #24]',
    'ldr w9, [x8, #0x20]',
    'ldr w10, [sp, #20]',
    'ldr w11, [x8, #0x24]',
    'mul w10, w10, w11',
    'subs w9, w9, w10',
    'csel w9, w9, wzr, gt',
    'str w9, [x8, #0x20]',
    'adrp x0, 0x100000000',
    'add x0, x0, #0x5b4',
    `bl 0x${PUTS.toString(16)}`,
    'ldr x8, [sp, #24]',
    'ldr w0, [x8, #0x20]',
    'ldr w1, [sp, #20]',
    'cmp w0, #0',
    'b.gt 0x100000454',
    'str wzr, [x8, #0x20]',
    'ldr w0, [sp, #12]',
    'ldp x29, x30, [sp], #32',
    'ret',
  ], { base, name: 'apply_damage', symbolFor: (addr) => BigInt(addr) === PUTS ? '_puts' : null });
  attachTexts(model, new Map([['4294968756', 'damage dealt to enemy']])); // 0x1000005B4
  const rowOfAddress = rowOfAddressFactory(base, model.instructions.length);

  const r = decompile(model, {
    addr: base, name: 'apply_damage', rowOfAddress, returnType: 'int32', receiverType: 'Unit', beginner: false,
    symbolFor: (addr) => BigInt(addr) === PUTS ? '_puts' : null,
    fieldFor: (_base, off) => off === 0x20n ? { name: 'hp', type: 'int32' }
      : off === 0x24n ? { name: 'damageRate', type: 'uint32' } : null,
  });
  assert.equal(r.semantic, true, r.warnings?.join('\n'));
  assert.equal(r.legacyFallback, undefined);
  assert.doesNotMatch(r.pseudocode, /\b(?:var_|local_phi|phi_)\w*/i, r.pseudocode);
  assert.match(r.pseudocode, /self->hp\s*-=\s*(?:\(uint32_t\))?a2\s*\*\s*self->damageRate/);
  assert.match(r.pseudocode, /if\s*\(\s*\(int32_t\)self->hp\s*<=\s*\(int32_t\)0\s*\)/);
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
}

console.log('decompiler semantic regression: ok');
