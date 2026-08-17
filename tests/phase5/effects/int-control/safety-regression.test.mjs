import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { imm, lift, mem, operations, reg, registerWrites } from './helpers.mjs';

test('P5-0 MOV/add memory seed remains available without P5-1 memory expansion', () => {
  const mov = lift('mov', [reg('eax','write'), mem(32, { base:'rbx' })]);
  assert.notEqual(mov.completeness,'unknown');
  assert.equal(operations(mov,'memory-read').length,1);
  assert.equal(registerWrites(mov,'rax').length,1);

  const add = lift('add', [reg('rax','read-write'), mem(64, { base:'rbx' })]);
  assert.notEqual(add.completeness,'unknown');
  assert.equal(operations(add,'memory-read').length,1);

  const adc = lift('adc', [reg('rax','read-write'), mem(64, { base:'rbx' })]);
  assert.equal(adc.completeness,'partial');
  assert.match(adc.unknownEffects.reason,/deferred-to-p5-2/);
});

test('LEA uses structured address components without semantic memory access', () => {
  const bundle = lift('lea', [reg('rax','write'), mem(64, { base:'rbx', index:'rcx', scale:4, displacement:8n })]);
  assert.equal(bundle.completeness,'exact');
  assert.equal(operations(bundle,'memory-read').length,0);
  assert.equal(operations(bundle,'memory-write').length,0);
  assert.equal(registerWrites(bundle,'rax').length,1);
  assert.equal(bundle.metadata.semanticMemoryAccess,false);
});

test('partial writes and 32-bit zero-extension are preserved for new arithmetic operations', () => {
  const add16 = lift('add', [reg('ax','read-write'), imm(1n)]);
  assert.ok(operations(add16,'value').some((operation) => operation.opcode === 'insert' && operation.metadata.widthBits === 16));
  assert.equal(registerWrites(add16,'rax')[0].metadata.writePolicy,'preserve-unaffected');

  const add32 = lift('add', [reg('eax','read-write'), imm(1n)]);
  assert.equal(registerWrites(add32,'rax')[0].metadata.writePolicy,'zero-extend-32');
  assert.ok(operations(add32,'value').some((operation) => operation.opcode === 'zext' && operation.metadata.toBits === 64));

  const incHigh = lift('inc', [reg('ah','read-write')]);
  assert.ok(operations(incHigh,'value').some((operation) => operation.opcode === 'insert' && operation.metadata.lsb === 8));
  assert.equal(registerWrites(incHigh,'rax').length,1);
});

test('P5-1 production semantics do not parse formatted opStr or mnemonic text', () => {
  for (const file of ['integer.js','flags.js','control.js']) {
    const source = fs.readFileSync(new URL(`../../../../js/targets/architecture/x86_64/effects/${file}`, import.meta.url),'utf8');
    assert.equal(source.includes('.opStr'),false,`${file} must not parse opStr`);
    assert.equal(source.includes('.mnemonic'),false,`${file} must not parse mnemonic`);
  }
});
