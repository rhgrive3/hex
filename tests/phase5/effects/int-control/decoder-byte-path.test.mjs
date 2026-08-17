import assert from 'node:assert/strict';
import test from 'node:test';

import { liftX86MachineEffects } from '../../../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../../helpers/capstone-session.mjs';
import { flagReads, flagWrites, intrinsics, operations, registerWrites } from './helpers.mjs';

function one(session, bytes, address) {
  const decoded = session.decode(new Uint8Array(bytes), BigInt(address));
  assert.equal(decoded.length, 1);
  return decoded[0];
}
function effects(decoded, id) { return liftX86MachineEffects({ ...decoded, instructionId:id }); }

test('real Capstone bytes feed structured x86 integer/control MachineEffects', async () => {
  const session = await createCapstoneX86Session();
  try {
    const adc = one(session,[0x48,0x11,0xd8],0x1000n); // adc rax, rbx
    assert.equal(adc.instructionFamily,'adc');
    assert.equal(adc.length,3);
    assert.equal(adc.detail.operands.length,2);
    assert.equal(adc.detail.operands[0].register.id,'rax');
    const adcEffects = effects(adc,'p5-1:bytes:adc');
    assert.equal(flagReads(adcEffects,'CF').length,1);
    assert.equal(registerWrites(adcEffects,'rax').length,1);

    const inc = one(session,[0xff,0xc0],0x1100n); // inc eax
    assert.equal(inc.instructionFamily,'inc');
    assert.equal(inc.length,2);
    const incEffects = effects(inc,'p5-1:bytes:inc');
    assert.equal(flagWrites(incEffects,'CF').length,0);
    assert.equal(registerWrites(incEffects,'rax')[0].metadata.writePolicy,'zero-extend-32');

    const testInsn = one(session,[0x85,0xc0],0x2000n); // test eax, eax
    assert.equal(testInsn.instructionFamily,'test');
    const testEffects = effects(testInsn,'p5-1:bytes:test');
    assert.equal(registerWrites(testEffects).length,0);
    assert.equal(flagWrites(testEffects,'AF')[0].metadata.definedness,'undefined');

    const jne = one(session,[0x75,0x02],0x2002n); // jne 0x2006
    assert.equal(jne.instructionFamily,'jne');
    assert.equal(jne.length,2);
    const jneEffects = effects(jne,'p5-1:bytes:jne');
    assert.equal(jneEffects.controlEffect.kind,'conditional-branch');
    assert.equal(jneEffects.controlEffect.fallthrough.value,String(0x2004n));
    assert.equal(flagReads(jneEffects,'ZF').length,1);

    const setne = one(session,[0x0f,0x95,0xc0],0x3000n); // setne al
    assert.equal(setne.instructionFamily,'setne');
    assert.equal(setne.length,3);
    const setEffects = effects(setne,'p5-1:bytes:setne');
    assert.equal(registerWrites(setEffects,'rax').length,1);
    assert.equal(flagWrites(setEffects).length,0);

    const cmovne = one(session,[0x0f,0x45,0xc3],0x3100n); // cmovne eax, ebx
    assert.equal(cmovne.instructionFamily,'cmovne');
    const cmovEffects = effects(cmovne,'p5-1:bytes:cmovne');
    assert.ok(operations(cmovEffects,'value').some((operation) => operation.opcode === 'select' && operation.metadata.semantic === 'x86-conditional-register-write'));

    const shl = one(session,[0xd1,0xe0],0x4000n); // shl eax, 1
    assert.equal(shl.instructionFamily,'shl');
    assert.equal(shl.length,2);
    const shlEffects = effects(shl,'p5-1:bytes:shl');
    assert.equal(flagWrites(shlEffects,'OF')[0].metadata.definedness,'defined');
    assert.ok(intrinsics(shlEffects,'x86.integer.shl').length === 1);

    const imul = one(session,[0x0f,0xaf,0xc3],0x4100n); // imul eax, ebx
    assert.equal(imul.instructionFamily,'imul');
    assert.equal(imul.detail.operands.length,2);
    const imulEffects = effects(imul,'p5-1:bytes:imul');
    assert.equal(imulEffects.metadata.form,'two-operand');
    assert.equal(registerWrites(imulEffects,'rax').length,1);

    const call = one(session,[0xe8,0x05,0x00,0x00,0x00],0x5000n); // call 0x500a
    assert.equal(call.instructionFamily,'call');
    assert.equal(call.length,5);
    const callEffects = effects(call,'p5-1:bytes:call');
    assert.equal(callEffects.controlEffect.kind,'call');
    assert.equal(callEffects.controlEffect.fallthrough.value,String(0x5005n));
    assert.equal(callEffects.controlEffect.target.value,String(0x500an));

    const ret = one(session,[0xc3],0x6000n);
    assert.equal(ret.instructionFamily,'ret');
    assert.equal(ret.length,1);
    assert.equal(effects(ret,'p5-1:bytes:ret').controlEffect.kind,'return');
  } finally {
    session.close();
  }
});
