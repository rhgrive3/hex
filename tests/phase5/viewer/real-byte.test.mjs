import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import '../../../js/targets/architecture/x86_64/capstone-structured.js';
import { VariableInstructionIndex } from '../../../js/viewer/variable-instruction-index.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const modulePath=path.join(os.tmpdir(),`hex-p55-capstone-${process.pid}-${Date.now()}.cjs`);
const structured=globalThis.HexX86CapstoneStructured;

test('viewer index consumes exact structured Capstone x86 bytes and variable boundaries',async()=>{
  assert.ok(structured);
  fs.copyFileSync(path.join(root,'capstone.js'),modulePath);
  const require=createRequire(import.meta.url);
  const MCapstone=require(modulePath);
  let M=null,handlePointer=0,handle=0,outputPointer=0,buffer=0,instructionPointer=0,count=0;
  try{
    M=await MCapstone({locateFile:(name)=>path.join(root,name),print:()=>{},printErr:()=>{}});
    structured.verifyVersion(M);
    handlePointer=M._malloc(4);outputPointer=M._malloc(4);
    assert.equal(M.ccall('cs_open','number',['number','number','pointer'],[M.ARCH_X86,M.MODE_64|M.MODE_LITTLE_ENDIAN,handlePointer]),0);
    handle=M.getValue(handlePointer,'i32');
    assert.equal(M.ccall('cs_option','number',['number','number','number'],[handle,M.OPT_DETAIL,M.OPT_ON]),0);
    const bytes=Uint8Array.from([0x90,0x50,0x75,0x02,0xb8,0x78,0x56,0x34,0x12,0xe8,0x00,0x00,0x00,0x00,0x48,0x8b,0x44,0x8b,0xf0,0xc3]);
    const base=0x401000n;buffer=M._malloc(bytes.length);M.writeArrayToMemory(bytes,buffer);
    count=M.ccall('cs_disasm','number',['number','number','number','number','number','number'],[handle,buffer,bytes.length,base,0,outputPointer]);
    assert.equal(count,7);
    instructionPointer=M.getValue(outputPointer,'i32');
    const decoded=[];let expected=base;
    for(let i=0;i<count;i++){
      const item=structured.parseInstruction(M,handle,instructionPointer+i*structured.ABI.instructionSize,{address:expected,mode:'long-64'});
      decoded.push(item);expected+=BigInt(item.length);
    }
    assert.deepEqual(decoded.map((x)=>x.length),[1,1,2,5,5,5,1]);
    assert.deepEqual(decoded.map((x)=>x.mnemonic),['nop','push','jne','mov','call','mov','ret']);
    assert.equal(expected,base+BigInt(bytes.length));
    for(const item of decoded)assert.equal(item.rawBytes.length,item.length);
    const decode=async(address,{length})=>{const start=BigInt(address),end=start+BigInt(length);return{supported:true,found:true,instructions:decoded.filter((item)=>item.address>=start&&item.address+BigInt(item.length)<=end),bytesRead:length};};
    const index=new VariableInstructionIndex({disassembleAt:decode,pageBytes:64,maxPrefetchPages:0});
    index.configureRegion({id:'real',vmAddr:base,size:BigInt(bytes.length)});
    await index.navigate(base,{trusted:true});
    const rows=index.localRows();
    assert.deepEqual(rows.map((r)=>r.address),decoded.map((r)=>r.address));
    assert.deepEqual(rows.map((r)=>r.length),[1,1,2,5,5,5,1]);
    assert.deepEqual([...rows[5].bytes],[0x48,0x8b,0x44,0x8b,0xf0]);
  }finally{
    if(M&&instructionPointer&&count)try{M.ccall('cs_free','void',['number','number'],[instructionPointer,count]);}catch{}
    if(M&&handlePointer)try{M.ccall('cs_close','number',['pointer'],[handlePointer]);}catch{}
    if(M&&buffer)M._free(buffer);if(M&&outputPointer)M._free(outputPointer);if(M&&handlePointer)M._free(handlePointer);
    fs.rmSync(modulePath,{force:true});
  }
});
