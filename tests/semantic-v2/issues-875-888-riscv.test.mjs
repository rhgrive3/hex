import assert from 'node:assert/strict';
import { abiPlugin } from '../../js/targets/abi/index.js';
import {
  riscvTypeBits,
  RISCV_VECTOR_ARGUMENT_REGISTERS,
  RISCV_VECTOR_VARIANT_CALLEE_SAVED,
  RISCV_VECTOR_VARIANT_CALLER_SAVED,
} from '../../js/targets/abi/riscv-lp64.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { parseELF, STO_RISCV_VARIANT_CC } from '../../js/binary/elf.js';

const lp64 = abiPlugin('lp64');
const lp64f = abiPlugin('lp64f');
const lp64d = abiPlugin('lp64d');

// #875 — LP64 type spelling -> width is canonical and compound types do not partially match.
for (const [type, expected] of [
  ['long',64], ['unsigned long',64], ['long long',64],
  ['__int128',128], ['unsigned __int128',128], ['int128_t',128],
  ['long double',128], ['double',64], ['float',32], ['_Float16',16], ['__bf16',16],
  ['_BitInt(127)',127], ['_BitInt(128)',128], ['_BitInt(129)',129], ['unsigned _BitInt(256)',256],
]) assert.equal(riscvTypeBits(type), expected, type);

{
  const out = lp64.classifyArguments({ callPrototype:{ args:[{ type:'__int128' }, { type:'unsigned __int128' }] } });
  assert.deepEqual(out.arguments[0].regs, ['x10','x11']);
  assert.deepEqual(out.arguments[1].regs, ['x12','x13']);
}
{
  const out = lp64d.classifyArguments({ callPrototype:{ args:[{ type:'long double' }] } });
  assert.deepEqual(out.arguments[0].regs, ['x10','x11'], 'long double exceeds ABI_FLEN and uses integer convention');
  assert.ok(!out.srcs.some((src) => src.reg === 'f10'));
  assert.equal(lp64d.classifyFunctionReturn({ functionPrototype:{ returnType:'long double', returnsValue:true } }).regs.join(','), 'x10,x11');
  assert.equal(lp64d.classifyFunctionReturn({ functionPrototype:{ returnType:'double', returnsValue:true } }).reg, 'f10');
}
{
  const widths = [127,128,129,256];
  const out = lp64.classifyArguments({ callPrototype:{ args:widths.map((bits) => ({ type:`_BitInt(${bits})` })) } });
  assert.equal(out.arguments[0].bits, 127);
  assert.equal(out.arguments[0].abiClass, 'integer-pair');
  assert.equal(out.arguments[1].bits, 128);
  assert.equal(out.arguments[1].abiClass, 'integer-pair');
  assert.equal(out.arguments[2].abiClass, 'scalar-by-reference');
  assert.equal(out.arguments[2].pointeeBits, 129);
  assert.equal(out.arguments[3].abiClass, 'scalar-by-reference');
  assert.equal(out.arguments[3].pointeeBits, 256);
}
{
  const explicit = lp64.classifyArguments({ callPrototype:{ args:[{ type:'long double', bits:64 }] } });
  assert.equal(explicit.arguments[0].bits, 64, 'explicit bit width remains authoritative');
}

// #882 — hard-float small aggregates never emit a concrete integer source without layout proof.
{
  const unknown = lp64d.classifyArguments({ callPrototype:{ args:[{ type:'struct S', aggregate:true, bits:64 }] } });
  assert.equal(unknown.partial, true);
  assert.equal(unknown.completeness, 'partial');
  assert.equal(unknown.arguments[0].location, 'unknown');
  assert.ok(!unknown.srcs.some((src) => src.reg === 'x10'), 'unproven aggregate must not create false a0 dependency');
}
{
  const oneDouble = lp64d.classifyArguments({ callPrototype:{ args:[{
    type:'struct S', aggregate:true, bits:64, fields:[{ type:'double', bits:64 }],
  }] } });
  assert.equal(oneDouble.partial, false);
  assert.equal(oneDouble.arguments[0].location, 'flattened-registers');
  assert.deepEqual(oneDouble.arguments[0].regs, ['f10']);
}
{
  const twoFloats = lp64d.classifyArguments({ callPrototype:{ args:[{
    type:'struct FF', aggregate:true, bits:64, fields:[{ type:'float', bits:32 },{ type:'float', bits:32 }],
  }] } });
  assert.deepEqual(twoFloats.arguments[0].regs, ['f10','f11']);
}
{
  const mixed = lp64d.classifyArguments({ callPrototype:{ args:[{
    type:'struct FI', aggregate:true, bits:64, fields:[{ type:'float', bits:32 },{ type:'int', bits:32 }],
  }] } });
  assert.deepEqual(mixed.arguments[0].regs, ['f10','x10']);
}
{
  const flenBoundary = lp64f.classifyArguments({ callPrototype:{ args:[{
    type:'struct D', aggregate:true, bits:64, fields:[{ type:'double', bits:64 }],
  }] } });
  assert.deepEqual(flenBoundary.arguments[0].regs, ['x10'], '64-bit double member is not eligible when ABI_FLEN=32');
}
{
  const adapter = semanticAbiAdapter(lp64d, { callPrototype:{ args:[{ type:'struct S', aggregate:true, bits:64 }] } });
  const call = adapter.classifyCall({ call:{ target:0x1234n } });
  assert.equal(call.abiPartial, true);
  assert.equal(call.argumentCompleteness, 'partial');
  assert.equal(call.arguments[0].location, 'unknown');
}

// #888 — a minimal ET_REL RISC-V ELF preserves st_other and function-level variant CC metadata.
function writeU16(dv, off, value) { dv.setUint16(off, value, true); }
function writeU32(dv, off, value) { dv.setUint32(off, value >>> 0, true); }
function writeU64(dv, off, value) { dv.setBigUint64(off, BigInt(value), true); }
function variantElf(stOther) {
  const bytes = new Uint8Array(0x400);
  const dv = new DataView(bytes.buffer);
  bytes.set([0x7f,0x45,0x4c,0x46,2,1,1,0],0);
  writeU16(dv,16,1);          // ET_REL
  writeU16(dv,18,243);        // EM_RISCV
  writeU32(dv,20,1);
  writeU64(dv,24,0n);
  writeU64(dv,32,0n);
  writeU64(dv,40,0x100n);     // section headers
  writeU32(dv,48,0);
  writeU16(dv,52,64);
  writeU16(dv,54,56); writeU16(dv,56,0);
  writeU16(dv,58,64); writeU16(dv,60,5); writeU16(dv,62,4);

  const shstr = new TextEncoder().encode('\0.text\0.symtab\0.strtab\0.shstrtab\0');
  const strtab = new TextEncoder().encode('\0foo\0');
  bytes.set([0x13,0,0,0],0x300); // nop-ish text bytes; parser only needs executable extent.
  bytes.set(strtab,0x338);
  bytes.set(shstr,0x350);

  const sh = (index) => 0x100 + index * 64;
  // .text name=1, SHT_PROGBITS, ALLOC|EXEC, offset 0x300, size 4, align4
  writeU32(dv,sh(1)+0,1); writeU32(dv,sh(1)+4,1); writeU64(dv,sh(1)+8,6n);
  writeU64(dv,sh(1)+24,0x300n); writeU64(dv,sh(1)+32,4n); writeU64(dv,sh(1)+48,4n);
  // .symtab name=7, SHT_SYMTAB, two 24-byte entries, link .strtab
  writeU32(dv,sh(2)+0,7); writeU32(dv,sh(2)+4,2); writeU64(dv,sh(2)+24,0x308n); writeU64(dv,sh(2)+32,48n);
  writeU32(dv,sh(2)+40,3); writeU32(dv,sh(2)+44,1); writeU64(dv,sh(2)+48,8n); writeU64(dv,sh(2)+56,24n);
  // .strtab name=15
  writeU32(dv,sh(3)+0,15); writeU32(dv,sh(3)+4,3); writeU64(dv,sh(3)+24,0x338n); writeU64(dv,sh(3)+32,BigInt(strtab.length)); writeU64(dv,sh(3)+48,1n);
  // .shstrtab name=23
  writeU32(dv,sh(4)+0,23); writeU32(dv,sh(4)+4,3); writeU64(dv,sh(4)+24,0x350n); writeU64(dv,sh(4)+32,BigInt(shstr.length)); writeU64(dv,sh(4)+48,1n);

  // symbol #1: foo, GLOBAL|FUNC, configurable st_other, shndx=.text, value 0, size 4
  const sym = 0x308 + 24;
  writeU32(dv,sym+0,1); bytes[sym+4]=0x12; bytes[sym+5]=stOther; writeU16(dv,sym+6,1); writeU64(dv,sym+8,0n); writeU64(dv,sym+16,4n);
  return bytes;
}
{
  const image = parseELF(variantElf(STO_RISCV_VARIANT_CC));
  const foo = image.symbols.find((symbol) => symbol.name === 'foo');
  assert.equal(foo.stOther, 0x80);
  assert.equal(foo.visibility, 0);
  assert.equal(foo.riscvVariantCc, true);
  assert.equal(foo.callingConvention, 'riscv-vector-variant');
  const fn = image.functions.find((entry) => entry.name === 'foo');
  assert.equal(fn.callingConvention, 'riscv-vector-variant');
  assert.equal(fn.abiMetadata.riscvVariantCc, true);
  assert.equal(image.metadata.riscvVariantCcFunctions[0].name, 'foo');
}
{
  const image = parseELF(variantElf(0));
  const foo = image.symbols.find((symbol) => symbol.name === 'foo');
  assert.equal(foo.stOther, 0);
  assert.equal(foo.riscvVariantCc, false);
  assert.equal(foo.callingConvention, null);
}

const marked = { address:0x5000n, riscvVariantCc:true, callingConvention:'riscv-vector-variant' };
const symbolForAddress = (address) => BigInt(address) === marked.address ? marked : null;
{
  const first = lp64d.classifyArguments({ callTarget:marked.address, callPrototype:{ args:[{ type:'vint32m1_t', vector:true, bits:128 }] } }, { symbolForAddress });
  assert.deepEqual(first.arguments[0].regs, ['v8']);
  assert.ok(first.srcs.some((src) => src.reg === 'v8'));
  assert.equal(first.callingConvention, 'riscv-vector-variant');
}
{
  const mask = lp64d.classifyArguments({ callTarget:marked.address, callPrototype:{ args:[{ type:'vbool8_t', vector:true, mask:true, bits:8 }] } }, { symbolForAddress });
  assert.deepEqual(mask.arguments[0].regs, ['v0']);
}
{
  const lmul2 = lp64d.classifyArguments({ callTarget:marked.address, callPrototype:{ args:[{ type:'vint32m2_t', vector:true, lmul:2, bits:256 }] } }, { symbolForAddress });
  assert.deepEqual(lmul2.arguments[0].regs, ['v8','v9']);
  const tuple = lp64d.classifyArguments({ callTarget:marked.address, callPrototype:{ args:[{ type:'vector tuple', vector:true, lmul:2, tupleCount:2, bits:512 }] } }, { symbolForAddress });
  assert.deepEqual(tuple.arguments[0].regs, ['v8','v9','v10','v11']);
}
{
  const ret = lp64d.classifyFunctionReturn({ functionPrototype:{ returnType:'vint32m2_t', returnBits:256, vectorReturn:true, returnVector:{ vector:true, lmul:2 }, callingConvention:'riscv-vector-variant', returnsValue:true } });
  assert.deepEqual(ret.regs, ['v8','v9']);
}
{
  for (const reg of ['v1','v7','v24','v31']) assert.ok(RISCV_VECTOR_VARIANT_CALLEE_SAVED.includes(reg));
  for (const reg of ['v0','v8','v23']) assert.ok(RISCV_VECTOR_VARIANT_CALLER_SAVED.includes(reg));
  assert.equal(RISCV_VECTOR_ARGUMENT_REGISTERS[0], 'v8');
  assert.equal(RISCV_VECTOR_ARGUMENT_REGISTERS.at(-1), 'v23');
}
{
  const prototype = { args:[{ type:'vint32m1_t', vector:true, bits:128 }] };
  const adapter = semanticAbiAdapter(lp64d, { callPrototype:prototype, symbolForAddress });
  const call = adapter.classifyCall({ call:{ target:marked.address } });
  assert.equal(call.callingConvention, 'riscv-vector-variant');
  assert.deepEqual(call.arguments[0].regs, ['v8']);
  assert.ok(call.clobbers.includes('v8'));
  assert.ok(!call.clobbers.includes('v1'), 'variant callee-saved v1 must not be clobbered');
}
{
  const ambiguous = lp64d.classifyArguments({ callPrototype:{ args:[{ type:'vint32m1_t', vector:true, bits:128 }] } });
  assert.equal(ambiguous.partial, true);
  assert.equal(ambiguous.arguments[0].location, 'unknown');
  assert.ok(!ambiguous.srcs.some((src) => src.reg === 'x10'), 'unmarked vector type must not silently become a0');
}
{
  const fixedUnknown = lp64d.classifyArguments({ callTarget:marked.address, callPrototype:{ args:[{ type:'fixed vector', vector:true, fixedLengthVector:true, bits:128 }] } }, { symbolForAddress });
  assert.equal(fixedUnknown.arguments[0].location, 'unknown');
  assert.equal(fixedUnknown.partial, true);
}

console.log('issues #875 #882 #888 regressions: ok');
