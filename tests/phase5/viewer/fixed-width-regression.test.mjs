import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeViewer } from '../../../js/viewer.js';
import { instructionCategory, instructionNote, supportsBeginnerInstructionNotes } from '../../../js/viewer/architecture-presentation.js';

function classList(){return{toggle(){},add(){},remove(){}};}
function viewport(){return{clientHeight:240,scrollTop:0,classList:classList(),addEventListener(){},removeEventListener(){}};}
function rows(){return{style:{height:''},appendChild(){}};}
function root(){return{classList:classList(),style:{setProperty(){}}};}
function installDom(){
  globalThis.__HEX_UI_ROOT__=root();
  globalThis.getComputedStyle=()=>({getPropertyValue:()=>''});
  globalThis.requestAnimationFrame=()=>1;
  globalThis.cancelAnimationFrame=()=>{};
}
function armBackend(){
  const bytes=new Uint8Array(4096);bytes.set([0x1f,0x20,0x03,0xd5],4);
  return{
    platformInfo:{capability:{architecture:'arm64',fixedInstructionSize:4,capabilities:{decode:'external'}}},
    legacyInfo:null,
    peek(_id,chunk,wantAsm){if(chunk!==0)return null;return wantAsm?{mn:['nop','nop'],ops:['','']}:{bytes};},
    request(){},
    disassembleAt(){throw new Error('ARM64 fixed viewer must not call variable decoder');},
  };
}

test('ARM64 fixed-width row/address/goTo/bytes behavior remains exact O(1)',()=>{
  installDom();
  const viewer=new CodeViewer({viewport:viewport(),rows:rows(),backend:armBackend()});
  viewer.setRegion({id:'arm',vmAddr:0x1000n,size:0x100n,disasm:true,capability:{architecture:'arm64',fixedInstructionSize:4,capabilities:{decode:'external'}}});
  assert.equal(viewer.totalRows,64);
  assert.equal(viewer.rowAddress(7),0x101cn);
  assert.equal(viewer.rowOfAddress(0x101cn),7);
  assert.equal(viewer.rowOfAddress(0x101dn),null);
  assert.equal(viewer.goToAddress(0x1020n),true);
  assert.equal(viewer.topRow(),5,'legacy third-placement keeps target row 8 three rows below viewport top');
  assert.equal(viewer.topAddress(),0x1014n);
  assert.equal(viewer.rowAddress(viewer.rowOfAddress(0x1020n)),0x1020n);
  const row=viewer.rowData(1);
  assert.equal(row.address,0x1004n);
  assert.equal(row.bytes,'1F 20 03 D5');
  assert.equal(row.mnemonic,'nop');
  assert.equal(viewer.isVariableAsm(),false);
  viewer.dispose();
});

test('ARM64 presentation stays enabled while x86 presentation never invokes ARM64 notes/categories',()=>{
  assert.equal(supportsBeginnerInstructionNotes('arm64'),true);
  assert.equal(supportsBeginnerInstructionNotes('x86_64'),false);
  assert.equal(instructionNote('x86_64',{mnemonic:'mov',operands:'rax, rbx',address:0x1000n,style:'ja',context:{}}),'');
  assert.equal(instructionCategory('x86_64','mov'),'');
  assert.equal(typeof instructionNote('arm64',{mnemonic:'nop',operands:'',address:0x1000n,style:'ja',context:{}}),'string');
});

test('viewer source isolates ARM64 presentation behind owned architecture boundary',()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const viewer=fs.readFileSync(path.join(root,'js/viewer.js'),'utf8');
  const presentation=fs.readFileSync(path.join(root,'js/viewer/architecture-presentation.js'),'utf8');
  assert.doesNotMatch(viewer,/from ['"]\.\/arm64\.js['"]/);
  assert.match(presentation,/from ['"]\.\.\/arm64\.js['"]/);
  assert.match(presentation,/arch !== 'arm64' && arch !== 'arm64e'/);
});
