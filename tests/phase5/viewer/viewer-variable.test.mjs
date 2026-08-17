import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeViewer } from '../../../js/viewer.js';

function classList(){return{toggle(){},add(){},remove(){}};}
function fakeElement(tag='div'){
  return{tagName:tag,style:{display:'',top:'',height:''},className:'',classList:classList(),textContent:'',nodeValue:'',append(){},appendChild(){},closest(){return null;}};
}
function installDom(){
  globalThis.__HEX_UI_ROOT__={classList:classList(),style:{setProperty(){}}};
  globalThis.getComputedStyle=()=>({getPropertyValue:()=>''});
  globalThis.requestAnimationFrame=()=>1;
  globalThis.cancelAnimationFrame=()=>{};
  globalThis.document={createElement:fakeElement,createTextNode:(value)=>({nodeValue:value}),documentElement:globalThis.__HEX_UI_ROOT__};
}
function makeViewerBackend(base=0x1000n){
  const calls=[];
  const backend={
    platformInfo:{capability:{architecture:'x86_64',fixedInstructionSize:null,capabilities:{decode:'external-structured-v1'}}},
    legacyInfo:null,
    peek(){throw new Error('x86 asm must not use legacy peek/chunk path');},
    request(){throw new Error('x86 asm must not use legacy chunk request');},
    async disassembleAt(address,{length,signal}){
      calls.push({address:BigInt(address),length,signal});
      if(signal?.aborted)throw Object.assign(new Error('aborted'),{name:'AbortError'});
      const start=BigInt(address),end=start+BigInt(length),out=[];
      let cur=start;
      const widths=[1,2,3,5,7,15];let i=0;
      while(cur<end){let width=widths[i++%widths.length];if(cur+BigInt(width)>end)break;out.push({address:cur,length:width,rawBytes:Uint8Array.from({length:width},()=>0x90),mnemonic:'nop',opStr:''});cur+=BigInt(width);}
      return{supported:true,found:out.length>0,instructions:out,bytesRead:length};
    },
    async readAt(){return Uint8Array.of(0xcc);},
  };
  backend.calls=calls;return backend;
}
function viewport(){return{clientHeight:240,scrollTop:0,classList:classList(),addEventListener(){},removeEventListener(){}};}
function rows(){return{style:{height:''},appendChild(){}};}
async function settle(){await new Promise((resolve)=>setTimeout(resolve,0));await new Promise((resolve)=>setTimeout(resolve,0));}

test('x86 region never materializes region.size/4 rows and rowData uses actual decoded lengths',async()=>{
  installDom();const backend=makeViewerBackend();const viewer=new CodeViewer({viewport:viewport(),rows:rows(),backend});
  const region={id:'x86',vmAddr:0x1000n,size:1n<<40n,disasm:true,capability:{architecture:'x86_64',fixedInstructionSize:null,capabilities:{decode:'external-structured-v1'}}};
  viewer.setRegion(region);
  assert.equal(viewer.totalRows,0,'before bounded async decode exact global instruction count is unknown');
  assert.notEqual(viewer.totalRows,Number(region.size/4n));
  await settle();
  assert.ok(viewer.totalRows>0&&viewer.totalRows<=4096);
  assert.ok(backend.calls.length<=2,'initial decode plus at most one bounded neighbour prefetch');
  assert.ok(backend.calls.every((call)=>call.length<=2062));
  const first=viewer.rowData(0);
  assert.equal(first.address,0x1000n);
  assert.equal(first.length,1);
  assert.equal(first.bytes,'90');
  const second=viewer.rowData(1);
  assert.equal(second.address,0x1001n);
  assert.equal(second.length,2);
  assert.equal(second.bytes,'90 90');
  assert.equal(viewer.rowOfAddress(0x1002n),1,'inside known instruction resolves to containing proven row');
  assert.equal(viewer.rowAddress(2),0x1003n);
  viewer._render();
  const m=viewer.instrumentation();
  assert.ok(m.domRows<=viewer.visibleRows()+12);
  assert.ok(m.retainedPages<=8);
  assert.ok(m.retainedInstructions<=16384);
  viewer.dispose();
});

test('x86 asm -> hex -> asm preserves address anchor instead of row identity',async()=>{
  installDom();const backend=makeViewerBackend();const vp=viewport();const viewer=new CodeViewer({viewport:vp,rows:rows(),backend});
  viewer.setRegion({id:'x86',vmAddr:0x1000n,size:0x10000n,disasm:true,capability:{architecture:'x86_64',fixedInstructionSize:null,capabilities:{decode:'external-structured-v1'}}});
  await settle();
  const anchor=viewer.rowAddress(5);assert.ok(anchor!=null);
  viewer.goToAddress(anchor);await settle();
  viewer.setMode('hex');
  assert.equal(viewer.mode,'hex');
  const hexTop=viewer.topAddress();
  assert.ok(hexTop<=anchor&&anchor<hexTop+4n);
  viewer.setMode('asm');await settle();
  const asmTop=viewer.topAddress();
  assert.ok(asmTop!=null);
  assert.ok(viewer.variableIndex.knownEntry(anchor)||viewer.variableIndex.containingEntry(anchor));
  viewer.dispose();
});

test('selection exposes real address/length truth for variable rows',async()=>{
  installDom();const viewer=new CodeViewer({viewport:viewport(),rows:rows(),backend:makeViewerBackend()});
  viewer.setRegion({id:'x86',vmAddr:0x1000n,size:0x1000n,disasm:true,capability:{architecture:'x86_64',fixedInstructionSize:null,capabilities:{decode:'external-structured-v1'}}});
  await settle();viewer.beginRange(1);viewer.extendTo(3);const range=viewer.selectionRange();
  assert.equal(range.count,3);assert.equal(range.startAddress,viewer.rowAddress(1));assert.equal(range.endAddress,viewer.rowAddress(3));assert.ok(range.endLength>=1&&range.endLength<=15);assert.equal(range.endExclusive,range.endAddress+BigInt(range.endLength));
  viewer.dispose();
});
