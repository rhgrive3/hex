import assert from 'node:assert/strict';
import { parseMetadata, parseMetadataAuto, Il2CppMetadataError } from '../js/il2cpp.js';

const PAIR={ stringLiteral:0,stringLiteralData:1,string:2,methods:5,typeDefinitions:19,images:20,assemblies:21 };
const SANITY=0xFAB11BAF;
function putPair(dv,index,offset,size){ dv.setInt32(8+index*8,offset,true); dv.setInt32(12+index*8,size,true); }
function putText(mem,offset,text){ const bytes=new TextEncoder().encode(text); mem.set(bytes,offset); mem[offset+bytes.length]=0; return bytes.length+1; }
function fixture({ version=27, typeSize=92, methodSize=40, typeMethodStart=40, typeMethodCount=68, typeToken=88, methodToken=24 }={}) {
  const mem=new Uint8Array(0x2000); const dv=new DataView(mem.buffer);
  dv.setUint32(0,SANITY,true); dv.setInt32(4,version,true);
  const stringOffset=0x200; let cursor=0;
  const typeName=cursor; cursor+=putText(mem,stringOffset+cursor,'Type');
  const namespace=cursor; cursor+=putText(mem,stringOffset+cursor,'NS');
  const methodName=cursor; cursor+=putText(mem,stringOffset+cursor,'Method');
  const imageName=cursor; cursor+=putText(mem,stringOffset+cursor,'Assembly-CSharp.dll');
  putPair(dv,PAIR.string,stringOffset,cursor);
  const methodOffset=0x400; putPair(dv,PAIR.methods,methodOffset,methodSize);
  dv.setInt32(methodOffset,methodName,true); dv.setInt32(methodOffset+4,0,true);
  if(methodToken+4<=methodSize) dv.setUint32(methodOffset+methodToken,0x06000001,true);
  const typeOffset=0x600; putPair(dv,PAIR.typeDefinitions,typeOffset,typeSize);
  dv.setInt32(typeOffset,typeName,true); dv.setInt32(typeOffset+4,namespace,true);
  dv.setInt32(typeOffset+typeMethodStart,0,true); dv.setUint16(typeOffset+typeMethodCount,1,true);
  if(typeToken+4<=typeSize) dv.setUint32(typeOffset+typeToken,0x02000001,true);
  const imageOffset=0x800; putPair(dv,PAIR.images,imageOffset,40);
  dv.setInt32(imageOffset,imageName,true); dv.setInt32(imageOffset+4,0,true); dv.setInt32(imageOffset+8,0,true); dv.setUint32(imageOffset+12,1,true); dv.setUint32(imageOffset+28,0,true);
  putPair(dv,PAIR.assemblies,0xa00,64);
  const literalIndex=0xc00, literalData=0xd00;
  putPair(dv,PAIR.stringLiteral,literalIndex,8); putPair(dv,PAIR.stringLiteralData,literalData,5);
  dv.setInt32(literalIndex,5,true); dv.setInt32(literalIndex+4,0,true); mem.set(new TextEncoder().encode('hello'),literalData);
  return {mem,dv,stringOffset,stringSize:cursor,methodOffset,typeOffset,imageOffset,literalIndex,literalData,methodName};
}

const good=fixture();
let parsed=parseMetadata(good.mem);
assert.equal(parsed.layout.id,'24.x-92-40');
assert.equal(parsed.layout.structurallyValid,true);
assert.equal(parsed.classes[0].full,'NS.Type');
assert.equal(parsed.methods[0].full,'NS.Type::Method');
assert.equal(parsed.images[0].name,'Assembly-CSharp.dll');
assert.equal(parsed.literals[0].text,'hello');

{
  const f=fixture(); const badIndex=f.stringSize-1; f.mem[f.stringOffset+badIndex]=0x41; f.dv.setInt32(f.methodOffset,badIndex,true);
  const x=parseMetadata(f.mem); assert.equal(x.methods.length,0); assert.ok(x.diagnostics.some((d)=>d.code==='IL2CPP_STRING_UNTERMINATED'));
}
{
  const size=70*1024; const mem=new Uint8Array(0x200+size+0x1000); const dv=new DataView(mem.buffer);
  dv.setUint32(0,SANITY,true); dv.setInt32(4,27,true); putPair(dv,PAIR.string,0x200,size);
  mem.fill(0x41,0x200,0x200+size); mem[0x200+size]=0;
  putPair(dv,PAIR.methods,0x200+size+0x100,40); dv.setInt32(0x200+size+0x100,0,true); dv.setInt32(0x200+size+0x104,0,true);
  const x=parseMetadata(mem); assert.equal(x.methods.length,0); assert.ok(x.diagnostics.some((d)=>d.code==='IL2CPP_STRING_UNTERMINATED'));
}
{
  const f=fixture(); putPair(f.dv,PAIR.methods,0x5000,40);
  const x=parseMetadata(f.mem); assert.ok(x.diagnostics.some((d)=>d.code==='IL2CPP_TABLE_RANGE'&&d.table==='methods')); assert.equal(x.literals[0].text,'hello');
}
{
  const f=fixture(); putPair(f.dv,PAIR.methods,f.stringOffset,40);
  const x=parseMetadata(f.mem); assert.ok(x.diagnostics.some((d)=>d.code==='IL2CPP_TABLE_OVERLAP')); assert.equal(x.tables.methods.valid,false); assert.equal(x.tables.string.valid,false);
}
{
  const f=fixture(); f.dv.setInt32(f.methodOffset+4,99,true);
  const x=parseMetadataAuto(f.mem); assert.equal(x.layout.structurallyValid,false); assert.equal(x.methods.length,0); assert.ok(x.diagnostics.some((d)=>d.code==='IL2CPP_LAYOUT_INVARIANT'));
}
{
  const f=fixture(); f.dv.setInt32(f.imageOffset+8,100,true); f.dv.setUint32(f.imageOffset+12,1,true);
  const x=parseMetadata(f.mem); assert.equal(x.images.length,0); assert.ok(x.diagnostics.some((d)=>d.code==='IL2CPP_IMAGE_INVARIANT'||d.code==='IL2CPP_LAYOUT_INVARIANT'));
}
{
  const f=fixture(); f.dv.setInt32(f.literalIndex+4,4,true); f.dv.setInt32(f.literalIndex,5,true);
  const x=parseMetadata(f.mem); assert.equal(x.literals.length,0); assert.ok(x.diagnostics.some((d)=>d.code==='IL2CPP_LITERAL_RANGE'));
}
{
  const mem=new Uint8Array(100); const dv=new DataView(mem.buffer); dv.setUint32(0,SANITY,true); dv.setInt32(4,27,true);
  assert.throws(()=>parseMetadata(mem),(error)=>error instanceof Il2CppMetadataError&&error.code==='IL2CPP_HEADER_TRUNCATED');
}
{
  const f=fixture({version:24,typeSize:100,methodSize:56,typeMethodStart:48,typeMethodCount:76,typeToken:96,methodToken:40});
  const x=parseMetadataAuto(f.mem); assert.equal(x.layout.id,'24.x-100-56'); assert.equal(x.layout.structurallyValid,true); assert.equal(x.methods[0].full,'NS.Type::Method');
}
{
  const f=fixture(); f.dv.setInt32(f.typeOffset+40,1,true);
  const x=parseMetadata(f.mem); assert.equal(x.methods.length,0); assert.equal(x.layout.structurallyValid,false); assert.ok(x.diagnostics.some((d)=>d.code==='IL2CPP_LAYOUT_INVARIANT'||d.code==='IL2CPP_METHOD_OWNER_RANGE'));
}
console.log('il2cpp-hardening: PASS');
