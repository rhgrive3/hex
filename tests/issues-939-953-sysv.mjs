// Minimal regressions for unlinked correctness issues #939 and #953.
import assert from 'node:assert/strict';
import { classifySysVAMD64Arguments, classifySysVAMD64CallReturn } from '../js/targets/abi/sysv-amd64.js';

const variadic = classifySysVAMD64Arguments({ callPrototype:{
  parameters:[{ type:'char *', pointer:true, bits:64 }], variadic:true,
}});
assert.equal(variadic.arguments.length, 1, 'fixed and unknown variadic arguments must remain distinct');
assert.equal(variadic.arguments[0].reg, 'rdi');
assert.ok(variadic.variadicRegisterCandidates.some((x) => x.reg === 'rsi' && x.possible === true));
assert.ok(variadic.variadicRegisterCandidates.some((x) => x.reg === 'xmm0' && x.possible === true));
assert.ok(variadic.srcs.some((x) => x.reg === 'rsi' && x.possible === true), 'possible GPR variadic frontier must reach conservative CALL use-set');
assert.ok(variadic.srcs.some((x) => x.reg === 'xmm0' && x.possible === true), 'possible SSE variadic frontier must reach conservative CALL use-set');
assert.ok(variadic.implicitInputs.some((x) => x.reg === 'rax' && x.view === 'al'), 'SysV variadic AL vector-count state must remain explicit');
assert.equal(variadic.partial, true);

const supported256 = classifySysVAMD64Arguments({ callPrototype:{ parameters:[
  { type:'vec256', vector:true, bits:256 },
]}}, { maxVectorRegisterBits:256 });
assert.equal(supported256.arguments[0].reg, 'ymm0');
assert.equal(supported256.arguments[0].bits, 256);
assert.ok(supported256.srcs.some((x) => x.reg === 'ymm0' && x.bits === 256));
assert.equal(supported256.arguments[0].unsupported, undefined);

const unsupported256 = classifySysVAMD64Arguments({ callPrototype:{ parameters:[
  { type:'vec256', vector:true, bits:256 },
]}});
assert.equal(unsupported256.arguments[0].reg, 'ymm0', 'ABI view must not masquerade as XMM');
assert.equal(unsupported256.arguments[0].bits, 256);
assert.equal(unsupported256.arguments[0].partial, true);
assert.equal(unsupported256.arguments[0].unsupported, true);
assert.ok(!unsupported256.srcs.some((x) => x.reg === 'xmm0' && x.bits === 128), 'wide vector must never truncate to XMM/128');

const return256 = classifySysVAMD64CallReturn({ callPrototype:{ returnType:'__m256', vector:true, returnBits:256 } }, { maxVectorRegisterBits:256 });
assert.equal(return256.reg, 'ymm0');
assert.equal(return256.bits, 256);
assert.equal(return256.partial, undefined);

const return512 = classifySysVAMD64CallReturn({ callPrototype:{ returnType:'__m512', vector:true, returnBits:512 } }, { maxVectorRegisterBits:512 });
assert.equal(return512.reg, 'zmm0');
assert.equal(return512.bits, 512);

const unknownProfileReturn = classifySysVAMD64CallReturn({ callPrototype:{ returnType:'__m256', vector:true, returnBits:256 } });
assert.equal(unknownProfileReturn.reg, null);
assert.equal(unknownProfileReturn.candidateReg, 'ymm0');
assert.equal(unknownProfileReturn.bits, 256);
assert.equal(unknownProfileReturn.partial, true);
assert.equal(unknownProfileReturn.unsupported, true);

console.log('issues 939/953 SysV variadic + wide-vector regressions: PASS');
