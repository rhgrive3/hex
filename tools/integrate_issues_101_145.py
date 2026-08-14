from pathlib import Path
import re, subprocess

ROOT=Path(__file__).resolve().parents[1]
def show(ref,path): return subprocess.check_output(['git','show',f'{ref}:{path}'],text=True)
def checkout(ref,*paths): subprocess.run(['git','checkout',ref,'--',*paths],check=True)
def replace_once(text,old,new,label):
    if text.count(old)!=1: raise RuntimeError(f'{label}: expected one occurrence, got {text.count(old)}')
    return text.replace(old,new,1)

# #105-112 are isolated from the PE fixes for #97-100 on the parallel branch.
checkout('origin/fix/issues-97-109-20260815',
         'js/binary/source.js','js/bytesource/cached.js',
         'js/platform/worker-validation.js','js/platform/worker.js')

# #101-104: take only the relocation/TLS/LoadConfig implementation, leaving
# #97-100 to the neighboring worker/PR to avoid overlapping behavior changes.
loader_path=ROOT/'js/binary/pe-loader.js'
main_loader=loader_path.read_text()
peer_loader=show('origin/fix/issues-97-109-20260815','js/binary/pe-loader.js')
rel_start=peer_loader.index('function allowedBaseRelocationTypes')
rel_end=peer_loader.index('export function parseCoffSymbols',rel_start)
rel_chunk=peer_loader[rel_start:rel_end]
old_start=main_loader.index('export function parseBaseRelocations')
old_end=main_loader.index('export function parseCoffSymbols',old_start)
main_loader=main_loader[:old_start]+rel_chunk+main_loader[old_end:]
tail_start=peer_loader.index('function readPointer')
peer_tail=peer_loader[tail_start:].strip()
main_loader=main_loader.rstrip()+'\n\n'+peer_tail+'\n'
loader_path.write_text(main_loader)

pe_path=ROOT/'js/binary/pe.js'
pe=pe_path.read_text()
pe=replace_once(pe,
 "import { parseImports, parseExports, parseExceptionFunctions, parseBaseRelocations, parseCoffSymbols, directory, peMachineName } from './pe-loader.js';",
 "import { parseImports, parseExports, parseExceptionFunctions, parseBaseRelocations, parseCoffSymbols, parseTlsDirectory, parseLoadConfig, directory, peMachineName } from './pe-loader.js';",
 '#101-104 PE imports')
pe=replace_once(pe,
 'const IMAGE_DIRECTORY_ENTRY_BASERELOC = 5;\n',
 'const IMAGE_DIRECTORY_ENTRY_BASERELOC = 5;\nconst IMAGE_DIRECTORY_ENTRY_TLS = 9;\nconst IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG = 10;\n',
 '#103-104 directory constants')
pe=replace_once(pe,
 '  parseBaseRelocations(r, directory(directories, IMAGE_DIRECTORY_ENTRY_BASERELOC), image);',
 '  parseBaseRelocations(r, directory(directories, IMAGE_DIRECTORY_ENTRY_BASERELOC), image, machine);\n  parseTlsDirectory(r, directory(directories, IMAGE_DIRECTORY_ENTRY_TLS), image);\n  parseLoadConfig(r, directory(directories, IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG), image);',
 '#101-104 parser wiring')
pe_path.write_text(pe)

# #113-128 branch is already scoped exactly to blocks.js + its regression test.
checkout('origin/fix/issues-110-122-20260815','js/blocks.js','tests/issues-113-128.mjs')

# Build a focused #101-112 regression suite. It exercises malformed PE blocks,
# machine-specific reloc filtering, TLS/GuardCF function seeds, BigInt/worker
# validation, ByteSource policy propagation, and provenance exactness.
(ROOT/'tests/issues-101-112.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ByteView } from '../js/binary/reader.js';
import { parseBaseRelocations, parseTlsDirectory, parseLoadConfig } from '../js/binary/pe-loader.js';
import { ByteSource, asByteSource } from '../js/binary/source.js';
import { InstrumentedByteSource } from '../js/bytesource/cached.js';
import { checkedChunkIndex, safeRegionLength, utf8Len, isExactFunctionSeed } from '../js/platform/worker-validation.js';

const BASE=0x140000000n;
function fixture(size=0x400){
  const bytes=new Uint8Array(size), view=new DataView(bytes.buffer);
  const image={imageBase:BASE,bits:64,functions:[],relocations:[],warnings:[],metadata:{},
    addressToOffset(address){const d=BigInt(address)-BASE; return d>=0n&&d<BigInt(bytes.length)?d:null;},
    sectionAt(address){const d=BigInt(address)-BASE; return d>=0x200n&&d<0x300n?{address:BASE+0x200n,size:0x100n,perms:{execute:true}}:null;}};
  return {bytes,view,r:new ByteView(bytes,{littleEndian:true}),image};
}
// #101 odd/truncated relocation blocks cannot desynchronize the parser.
{
  const {view,r,image}=fixture(); view.setUint32(0x40,0x200,true); view.setUint32(0x44,9,true);
  parseBaseRelocations(r,{rva:0x40,size:9},image,0x8664);
  assert.equal(image.relocations.length,0); assert.ok(image.warnings.some((w)=>/Malformed PE base-relocation block/.test(w)));
}
// #102 reserved relocation types stay unsupported evidence, never real relocations.
{
  const {view,r,image}=fixture(); view.setUint32(0x40,0x200,true); view.setUint32(0x44,10,true); view.setUint16(0x48,0xf000,true);
  parseBaseRelocations(r,{rva:0x40,size:10},image,0x8664);
  assert.equal(image.relocations.length,0); assert.ok(image.warnings.some((w)=>/unsupported PE base relocation type 15/.test(w)));
}
// #103 PE32+ TLS callback VA table contributes only executable function seeds.
{
  const {view,r,image}=fixture(); view.setBigUint64(0x40+24,BASE+0x100n,true); view.setBigUint64(0x100,BASE+0x220n,true); view.setBigUint64(0x108,0n,true);
  parseTlsDirectory(r,{rva:0x40,size:40},image);
  assert.deepEqual(image.metadata.tls.callbacks,[BASE+0x220n]); assert.ok(image.functions.some((f)=>f.address===BASE+0x220n&&f.source==='tls-callback'));
}
// #104 Load Config GuardCF table seeds executable entries with provenance.
{
  const {view,r,image}=fixture(); view.setUint32(0x40,0x98,true); view.setBigUint64(0x40+128,BASE+0x100n,true); view.setBigUint64(0x40+136,1n,true); view.setUint32(0x40+144,0,true); view.setUint32(0x100,0x220,true);
  parseLoadConfig(r,{rva:0x40,size:0x98},image);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions,[BASE+0x220n]); assert.ok(image.functions.some((f)=>f.address===BASE+0x220n&&f.source==='guard-cf'));
}
// #105/#111 reject lossy region sizes and invalid chunk indexes.
assert.throws(()=>safeRegionLength(9007199254740992n)); assert.throws(()=>checkedChunkIndex(-1)); assert.throws(()=>checkedChunkIndex(1.5)); assert.equal(checkedChunkIndex(3),3);
// #106/#107 request ownership and transactional open are retained in worker code.
const worker=fs.readFileSync(new URL('../js/platform/worker.js',import.meta.url),'utf8');
assert.match(worker,/active\.has\(msg\.id\)/); assert.match(worker,/candidateSource|nextSource|newSource/);
// #108 options on an existing ByteSource become a stricter wrapper.
{
 class S extends ByteSource{constructor(){super(16n,{maxReadLength:16})}async read(_o,n){return new Uint8Array(n)}}
 const base=new S(), wrapped=asByteSource(base,{maxReadLength:4}); assert.notEqual(wrapped,base); await wrapped.readExactly(0n,4); await assert.rejects(()=>wrapped.readExactly(0n,5));
}
// #109 InstrumentedByteSource forwards AbortSignal/options.
{
 let seen=null; const delegate={size:8n,maxReadLength:8,async read(_o,n,opts){seen=opts;return new Uint8Array(n)}};
 const src=new InstrumentedByteSource(delegate), ac=new AbortController(); await src.read(0n,1,{signal:ac.signal}); assert.equal(seen.signal,ac.signal);
}
// #110 scalar-valid UTF-8 only.
assert.equal(utf8Len(Uint8Array.from([0xe0,0x80,0x80]),0),0); assert.equal(utf8Len(Uint8Array.from([0xed,0xa0,0x80]),0),0); assert.equal(utf8Len(Uint8Array.from([0xf4,0x90,0x80,0x80]),0),0); assert.equal(utf8Len(Uint8Array.from([0xf0,0x9f,0x98,0x80]),0),4);
// #112 heuristic starts are not globally advertised as exact.
assert.equal(isExactFunctionSeed({source:'heuristic',confidence:1}),false); assert.equal(isExactFunctionSeed({source:'exception',confidence:.999}),true);
console.log('issues-101-112: ok');
''')

# Prepare a scoped copy of the peer decompiler regression: #146/#147 both live
# exclusively in switch.js and are intentionally left to the neighboring range.
peer_test=show('origin/fix/issues-136-147-20260815','tests/issues-136-147.mjs')
peer_test=peer_test.replace("import { structureKnownSwitches } from '../js/decompiler/switch.js';\n",'')
peer_test=re.sub(r'\n// #146:.*?(?=\nconsole\.log)', '', peer_test, flags=re.S)
peer_test=peer_test.replace("console.log('issues-136-147: ok');","console.log('issues-135-145: ok');")
(ROOT/'tests/issues-135-145.mjs').write_text(peer_test)
(ROOT/'tests/issues-101-145.mjs').write_text("await import('./issues-101-112.mjs');\nawait import('./issues-113-128.mjs');\nawait import('./issues-129-134.mjs');\nawait import('./issues-135-145.mjs');\nconsole.log('issues-101-145: all focused regressions passed');\n")

print('scoped integration staged')
