import assert from 'node:assert/strict';
import { decompile } from '../js/decompiler.js';
import { buildIR } from '../js/ir.js';
import { loadWords } from './helpers/load-words.mjs';

const Words = await loadWords();
const PUTS = 0x100001000n;

function attachTexts(model, textByAddress) {
  for (const instruction of model.instructions || []) {
    const text = textByAddress.get(String(instruction.address));
    if (text != null) instruction.text = text;
  }
}

function rowOfAddress(address) {
  const target = BigInt(address);
  for (let row = 0; row < currentInstructions.length; row++) {
    if (BigInt(currentInstructions[row].address) === target) return row;
  }
  return null;
}

let currentInstructions = [];

{
  const base = 0x100000500n;
  currentInstructions = [
    { address: base,       size: 4, word: 0xf9401008, mn: 'ldr', ops: 'x8, [x0, #0x20]' },
    { address: base+4n,    size: 4, word: 0xb9402409, mn: 'ldr', ops: 'w9, [x0, #0x24]' },
    { address: base+8n,    size: 4, word: 0x1b097c2a, mn: 'mul', ops: 'w10, w1, w9' },
    { address: base+12n,   size: 4, word: 0x4b0a0108, mn: 'sub', ops: 'w8, w8, w10' },
    { address: base+16n,   size: 4, word: 0xb9002008, mn: 'str', ops: 'w8, [x0, #0x20]' },
    { address: base+20n,   size: 4, word: 0x7100011f, mn: 'cmp', ops: 'w8, #0' },
    { address: base+24n,   size: 4, word: 0x5400006c, mn: 'b.gt', ops: '#0x100000520' },
    { address: base+28n,   size: 4, word: 0xb900201f, mn: 'str', ops: 'wzr, [x0, #0x20]' },
    { address: base+32n,   size: 4, word: 0x90000000, mn: 'adrp', ops: 'x0, #0x100000000' },
    { address: base+36n,   size: 4, word: 0x9116d000, mn: 'add', ops: 'x0, x0, #0x5b4' },
    { address: base+40n,   size: 4, word: 0x940002d6, mn: 'bl', ops: '#0x100001000' },
    { address: base+44n,   size: 4, word: 0xb9402000, mn: 'ldr', ops: 'w0, [x0, #0x20]' },
    { address: base+48n,   size: 4, word: 0xd65f03c0, mn: 'ret', ops: '' },
  ];
  const model = buildIR(currentInstructions.map((instruction, row) => ({ ...instruction, row })), {
    Words,
    entry: base,
    name: 'apply_damage',
    rowOfAddress,
    symbolFor: (addr) => BigInt(addr) === PUTS ? '_puts' : null,
  });
  attachTexts(model, new Map([['4294968756', 'damage dealt to enemy']])); // 0x1000005B4

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
}

console.log('decompiler semantic tests: ok');
