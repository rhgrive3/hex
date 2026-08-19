import assert from 'node:assert/strict';
import { aliasMemoryRegions } from '../js/analysis/alias/legacy-safety-floor.js';
import { classifyMicrosoftX64Arguments } from '../js/targets/abi/microsoft-x64.js';
import { dynamicRelocationResolutionMetadata, dynamicSymbolKind, resolveDynamicSectionIndex, symbolCountFromSymtabSize } from '../js/binary/elf-dynamic.js';

const stack = { kind:'stack-fixed', functionId:'f', offset:-8n, widthBits:64, metadata:{} };
const global = { kind:'global-absolute', binaryId:'b', address:0x1000n, widthBits:64, metadata:{} };
assert.notEqual(aliasMemoryRegions(stack, global), 'no');

const varargs = classifyMicrosoftX64Arguments({ callPrototype:{ args:[{ type:'const char *', pointer:true }], variadic:true } });
const regs = new Set(varargs.srcs.map((source) => source.reg));
for (const reg of ['rcx','rdx','r8','r9','xmm1','xmm2','xmm3']) assert.ok(regs.has(reg), `missing ${reg}`);
assert.deepEqual(varargs.variadicRegisterFrontier.map((entry) => entry.position), [1,2,3]);
const shifted = classifyMicrosoftX64Arguments({ callPrototype:{ args:[{ type:'int' }], variadic:true, indirectResult:true } });
assert.deepEqual(shifted.variadicRegisterFrontier.map((entry) => entry.position), [2,3]);

const bytes = new Uint8Array(96);
new DataView(bytes.buffer).setUint32(8, 7, true);
const reader = { length:bytes.length, u32:(offset) => new DataView(bytes.buffer).getUint32(offset, true) };
const image = { segments:[{ address:0x1000n, size:96n, fileOffset:0n, fileSize:96n, perms:{execute:true} }], sections:[], warnings:[], metadata:{machine:62} };
image.addressToOffset = (va) => Number(va - 0x1000n);
assert.deepEqual(resolveDynamicSectionIndex(reader, image, new Map(), 0, 0), { known:true, index:0, source:'st_shndx' });
assert.equal(resolveDynamicSectionIndex(reader, image, new Map(), 2, 0xffff).known, false);
const tags = new Map([[34n,[0x1000n]]]);
assert.deepEqual(resolveDynamicSectionIndex(reader, image, tags, 2, 0xffff), { known:true, index:7, source:'DT_SYMTAB_SHNDX' });
assert.equal(resolveDynamicSectionIndex(reader, image, tags, 24, 0xffff).known, false);

assert.equal(symbolCountFromSymtabSize(72n, 0x1000n, 24n, image), 3);
const malformedImage = { ...image, metadata:{machine:62}, warnings:[] };
assert.equal(symbolCountFromSymtabSize(71n, 0x1000n, 24n, malformedImage), 0);
assert.equal(malformedImage.metadata.programDynamicPartial, true);
assert.equal(symbolCountFromSymtabSize(120n, 0x1040n, 24n, { ...image, metadata:{machine:62}, warnings:[] }), 0);

assert.equal(dynamicSymbolKind(2), 'function');
assert.equal(dynamicSymbolKind(10), 'indirect-function');
assert.deepEqual(dynamicRelocationResolutionMetadata(image, { symIndex:3, type:7 }, { kind:'indirect-function', resolverAddress:0x401000n }), { requiresRuntimeResolution:true, resolverAddress:0x401000n, resolution:'ifunc-resolver-return' });
assert.deepEqual(dynamicRelocationResolutionMetadata(image, { symIndex:0, type:37, addend:0x402000n }, null), { requiresRuntimeResolution:true, resolverAddend:0x402000n, resolution:'irelative-resolver' });

console.log('issues #924 #930 #934 #940 #941 focused regressions passed');
