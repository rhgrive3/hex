import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SYSV_AMD64_ABI,
  classifySysVAMD64Arguments,
  classifySysVAMD64CallReturn,
} from '../../../js/targets/abi/sysv-amd64.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { semanticAbiAdapter, partitionDecodedFunction } from '../../../js/analysis/semantic-function.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { decoded, imm, reg } from '../effects/memory/helpers.mjs';

function classify(args, prototype = {}) {
  return classifySysVAMD64Arguments({ callPrototype:{ args, ...prototype } });
}

function one(type, extra = {}) { return { type, ...extra }; }

// #920 — X87/X87UP/COMPLEX_X87 arguments are memory-class arguments. They must
// never be invented as ordinary SSE scalar inputs merely because their spelling
// contains "double".
test('#920 SysV long double and complex long double never claim XMM argument registers', () => {
  const longDouble = classify([one('long double')]);
  assert.equal(longDouble.arguments[0].location, 'stack');
  assert.equal(longDouble.arguments[0].abiClass, 'x87-memory');
  assert.equal(longDouble.arguments[0].bits, 128);
  assert.equal(longDouble.arguments[0].bytes, 16);
  assert.equal(longDouble.arguments[0].alignment, 16);
  assert.deepEqual(longDouble.arguments[0].eightbyteClasses, ['X87','X87UP']);
  assert.equal(longDouble.srcs.some((source) => source.reg?.startsWith('xmm')), false);

  const explicitX87 = classify([{ abiClass:'X87', bits:128 }]);
  assert.equal(explicitX87.arguments[0].abiClass, 'x87-memory');
  assert.equal(explicitX87.srcs.length, 0);

  const complex = classify([one('complex long double')]);
  assert.equal(complex.arguments[0].location, 'stack');
  assert.equal(complex.arguments[0].abiClass, 'complex-x87-memory');
  assert.equal(complex.arguments[0].bits, 256);
  assert.equal(complex.arguments[0].bytes, 32);
  assert.equal(complex.srcs.some((source) => source.reg?.startsWith('xmm')), false);

  assert.equal(classify([one('double')]).arguments[0].reg, 'xmm0');
  assert.equal(classify([one('float')]).arguments[0].reg, 'xmm0');
  assert.equal(classify([one('long')]).arguments[0].reg, 'rdi');

  const mixed = classify([one('int'), one('double'), one('long double'), one('int')]);
  assert.deepEqual(mixed.arguments.map((argument) => argument.location), ['register','register','stack','register']);
  assert.equal(mixed.arguments[0].reg, 'rdi');
  assert.equal(mixed.arguments[1].reg, 'xmm0');
  assert.equal(mixed.arguments[2].abiClass, 'x87-memory');
  assert.equal(mixed.arguments[3].reg, 'rsi', 'memory-class X87 argument must not consume a GP register');

  const returned = classifySysVAMD64CallReturn({ callPrototype:{ returnType:'long double', returnsValue:true } });
  assert.equal(returned.reg, null);
  assert.equal(returned.unsupported, true);
  assert.equal(returned.partial, true);
});

// #921 — __int128 is two INTEGER eightbytes. SysV requires an all-or-stack
// register decision for the whole argument; one remaining GP register is not a
// valid half-assignment.
test('#921 SysV __int128 consumes two GP registers or rolls the whole argument to 16-byte stack storage', () => {
  for (const type of ['__int128', 'unsigned __int128']) {
    const first = classify([one(type)]);
    assert.equal(first.arguments[0].location, 'registers');
    assert.deepEqual(first.arguments[0].regs, ['rdi','rsi']);
    assert.deepEqual(first.arguments[0].pieces.map((piece) => piece.abiClass), ['INTEGER','INTEGER']);
    assert.equal(first.arguments[0].bits, 128);
  }

  const explicitBits = classify([{ bits:128 }]);
  assert.deepEqual(explicitBits.arguments[0].regs, ['rdi','rsi']);

  const fiveLeading = classify([
    ...Array.from({ length:5 }, () => one('int')),
    one('__int128'),
    one('int'),
  ]);
  assert.equal(fiveLeading.arguments[5].location, 'stack');
  assert.equal(fiveLeading.arguments[5].bytes, 16);
  assert.equal(fiveLeading.arguments[5].alignment, 16);
  assert.equal(fiveLeading.arguments[5].offset % 16, 0);
  assert.equal(fiveLeading.arguments[5].regs, undefined, 'failed two-register allocation must not consume the last GP register');
  assert.equal(fiveLeading.arguments[6].reg, 'r9', 'following scalar must still receive the unconsumed R9');

  const sixLeading = classify([
    ...Array.from({ length:6 }, () => one('int')),
    one('__int128'),
    one('int'),
  ]);
  assert.equal(sixLeading.arguments[6].location, 'stack');
  assert.equal(sixLeading.arguments[6].offset, 0);
  assert.equal(sixLeading.arguments[7].location, 'stack');
  assert.equal(sixLeading.arguments[7].offset, 16);

  const returned = classifySysVAMD64CallReturn({ callPrototype:{ returnType:'__int128', returnsValue:true } });
  assert.equal(returned.bits, 128);
  assert.deepEqual(returned.regs, ['rax','rdx']);
  assert.deepEqual(returned.pieces.map((piece) => piece.reg), ['rax','rdx']);
});

// #919 — SysV variadic calls use the low byte of RAX as a distinct implicit ABI
// input. Keep its 8-bit AL access view in metadata while generic SSA continues to
// use the single canonical physical RAX cell.
test('#919 SysV variadic vector-register count is explicit, bounded, and not invented for unknown calls', () => {
  const nonVariadic = classify([one('double')]);
  assert.deepEqual(nonVariadic.implicitInputs, []);
  assert.equal(nonVariadic.variadicVectorRegisterCount, null);

  const zero = classify([], { variadic:true });
  assert.equal(zero.variadicVectorRegisterCount, 0);
  assert.deepEqual(zero.implicitInputs, [{ t:'reg', reg:'rax', view:'al', bits:8, purpose:'sse-register-argument-count' }]);

  const oneSse = classify([one('double')], { variadic:true });
  assert.equal(oneSse.variadicVectorRegisterCount, 1);
  const mixed = classify([one('int'), one('double'), one('float')], { variadic:true });
  assert.equal(mixed.variadicVectorRegisterCount, 2);

  const unknown = classifySysVAMD64Arguments({});
  assert.equal(unknown.variadicVectorRegisterCount, null);
  assert.deepEqual(unknown.implicitInputs, []);
});

test('#919 semantic ABI adapter retains typed AL input and its proven count', () => {
  const adapter = semanticAbiAdapter(SYSV_AMD64_ABI, {
    callPrototype:{ args:[one('int'), one('double')], variadic:true },
  });
  const classified = adapter.classifyCall({ call:{ target:0x5000n } });
  assert.equal(classified.variadicVectorRegisterCount, 1);
  assert.equal(classified.partial, true);
  assert.equal(classified.completeness, 'partial');
  assert.equal(classified.implicitInputs.length, 1);
  const al = classified.implicitInputs[0];
  assert.equal(al.reg, 'rax');
  assert.equal(al.view, 'al');
  assert.equal(al.bits, 8);
  assert.equal(al.implicit, true);
  assert.equal(al.purpose, 'sse-register-argument-count');
  assert.equal(al.variadicVectorRegisterCount, 1);
  assert.equal(al.countKnown, true);
  assert.ok(classified.arguments.includes(al), 'compatibility physical input set must include the implicit AL read');
});

test('#919 mov al,N reaches CALL use through shared Semantic IR compatibility projection', () => {
  const instructions = [
    decoded({ family:'mov', address:0x401000n, length:2, operands:[reg('al', 8, 'write'), imm(1n, 8, 8)] }),
    decoded({ family:'call', address:0x401002n, length:5, operands:[imm(0x402000n, 64, 32)] }),
  ];
  const architecturePlugin = architecturePluginV2('x86_64');
  const abiAdapter = semanticAbiAdapter(SYSV_AMD64_ABI, {
    callPrototype:{ args:[one('double')], variadic:true },
  });
  const blocks = partitionDecodedFunction(instructions, architecturePlugin);
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin,
    decoderSemanticVersion:'issues-915-921',
    binaryId:'issues-915-921',
    sliceId:'x86_64',
    addressWidthBits:64,
    mode:'long-64',
    entryBlockKey:blocks[0].key,
    blocks,
    abiAdapter,
  }, { abiAdapter });
  const call = pipeline.legacyV1.instructions.find((instruction) => instruction.op === 'call');
  assert.ok(call, 'CALL must survive compatibility projection');
  const alDescriptor = call.callArguments.find((argument) => argument?.implicit && argument?.purpose === 'sse-register-argument-count');
  assert.ok(alDescriptor);
  assert.equal(alDescriptor.reg, 'rax');
  assert.equal(alDescriptor.view, 'al');
  assert.equal(alDescriptor.bits, 8);
  assert.equal(alDescriptor.variadicVectorRegisterCount, 1);

  const rax = (call.args || []).map((argument) => argument.value).find((value) => value?.reg === 'rax');
  assert.ok(rax, 'implicit AL read must resolve to canonical physical RAX SSA state');
  assert.ok(rax.uses.includes(call), 'CALL must be a real def-use consumer so setup cannot be dead-code eliminated');
  assert.ok(call.extra.abiProjectedArgumentValueIds.length > 0);
});

function decompilerValue(id, constant) {
  return { id, reg:null, bits:64, kind:'def', uses:[], def:null, const:BigInt(constant) };
}
function decompilerArg(value) { return { value }; }
function stackStore(id, row, value, key, disp) {
  return {
    id, op:'store', row, block:0, address:0x5000n + BigInt(row * 4), dst:null,
    loc:{ kind:'stack', key, disp:BigInt(disp), size:8 },
    addr:{ disp:BigInt(disp), size:8 },
    args:[decompilerArg(value)],
  };
}

// #915 — the display identity must come from the canonical signed stack key,
// not abs(local displacement). This also covers two different addressing forms
// that have already canonicalized to the same stack slot.
test('#915 decompiler preserves signed canonical stack-slot identity end to end', () => {
  const values = Array.from({ length:8 }, (_unused, index) => decompilerValue(index + 1, index + 1));
  const stores = [
    stackStore(100, 0, values[0], 'stack:-16', -16),
    stackStore(101, 1, values[1], 'stack:16', 16),
    stackStore(102, 2, values[2], 'stack:-8', -8),
    stackStore(103, 3, values[3], 'stack:8', 8),
    stackStore(104, 4, values[4], 'stack:0', 0),
    // Different local displacement, same canonical coordinate (e.g. FP-derived
    // vs SP-direct after frame movement) must render the same slot identity.
    stackStore(105, 5, values[5], 'stack:-16', 32),
    // Malformed/noncanonical keys still need collision-safe fallback names.
    stackStore(106, 6, values[6], 'stack:bad-16', -16),
    stackStore(107, 7, values[7], 'stack:bad+16', 16),
  ];
  stores.forEach((store, index) => values[index].uses.push(store));
  const ir = {
    values,
    instructions:stores,
    args:new Map(),
    blocks:[{ index:0, startRow:0, endRow:7, succ:[], insts:stores }],
  };
  const result = {
    semantic:true,
    ir,
    types:{ values:new Map(), locations:new Map() },
    lines:[
      { kind:'sig', indent:0, text:'void stack_identity(void)' },
      { kind:'ctrl', indent:0, text:'{' },
      ...stores.map((store) => ({ kind:'stmt', indent:1, text:'memory_unknown = 0;', row:store.row, addr:store.address })),
      { kind:'ctrl', indent:0, text:'}' },
    ],
    warnings:[], evidence:[], summary:'fallback', coverage:{ mode:'structured' },
  };
  const enhanced = enhanceSemanticDecompilation(result, { calls:[] }, { decompilerTimeBudgetMs:1000 });
  const names = enhanced.semanticFacts.stores.map((store) => store.location.name);
  assert.deepEqual(names.slice(0, 6), ['local_m10','local_p10','local_m8','local_p8','local_0','local_m10']);
  assert.notEqual(names[6], names[7], 'noncanonical keys with equal absolute displacement must not alias by display name');
  assert.match(enhanced.pseudocode, /local_m10 = 1;/);
  assert.match(enhanced.pseudocode, /local_p10 = 2;/);
  assert.match(enhanced.pseudocode, /local_m8 = 3;/);
  assert.match(enhanced.pseudocode, /local_p8 = 4;/);
  assert.match(enhanced.pseudocode, /local_0 = 5;/);
});
