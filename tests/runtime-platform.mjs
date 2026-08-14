import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DebugAdapter, normalizeBreakpoint } from '../js/debug/adapter.js';
import { RuntimeMemoryMap, createSandboxMemoryMap } from '../js/runtime/memory.js';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';
import { validateRemotePacket, RemoteProtocolClient } from '../js/debug/remote-protocol.js';
import { LocalFunctionSandboxAdapter, RemoteDebugAdapter } from '../js/adapters/index.js';
import { compileExperiment, generateDifferentialInputs, classifyHypothesis } from '../js/dynamic/experiments.js';
import { createRuntimeEvidenceRecord, fuseStaticDynamic, traceToSemanticFacts, compareRuntimeDispatch } from '../js/runtime-evidence/index.js';
import { DebugSession } from '../js/runtime/session.js';

function program(entries, fallback = null) {
  const table = new Map(entries.map(([a,mn,ops='']) => [BigInt(a).toString(), {mn,ops}]));
  return {
    fetch: async (addr) => table.get(BigInt(addr).toString()) || (fallback ? fallback(addr) : null),
    read: async () => null,
    symbolFor: () => null,
  };
}

async function runLocal(io, address, spec = {}, maxSteps = 100) {
  const adapter = new LocalFunctionSandboxAdapter(io, { trace:{maxEvents:128,maxBytes:65536} });
  await adapter.connect();
  await adapter.launch({ address, objectAsArg0:false, ...spec });
  const result = await adapter.resume({ maxSteps });
  await adapter.disconnect();
  return result;
}

// add/sub
{
  const io = program([[0x1000,'add','x0, x0, x1'],[0x1004,'sub','x0, x0, #1'],[0x1008,'ret','']]);
  const r = await runLocal(io,0x1000,{arguments:[3n,5n]});
  assert.equal(r.returnValue,7n);
  assert.equal(r.stop.kind,'return');
}

// clamp + branch
{
  const io = program([
    [0x1100,'cmp','x1, #0'],[0x1104,'b.ge','#0x1110'],[0x1108,'mov','x0, #0'],[0x110c,'ret',''],
    [0x1110,'mov','x0, x1'],[0x1114,'ret',''],
  ]);
  const neg = await runLocal(io,0x1100,{arguments:[0n,-9n]});
  const pos = await runLocal(io,0x1100,{arguments:[0n,9n]});
  assert.equal(neg.returnValue,0n); assert.equal(pos.returnValue,9n);
  assert.ok((neg.branches.length + pos.branches.length) >= 1);
}

// pointer load/store + alias + multiple fields
{
  const base = 0x600000001000n;
  const io = program([
    [0x1200,'ldr','x2, [x0]'],[0x1204,'add','x2, x2, x1'],[0x1208,'str','x2, [x0]'],
    [0x120c,'str','x1, [x0, #8]'],[0x1210,'ldr','x0, [x0]'],[0x1214,'ret',''],
  ]);
  const r = await runLocal(io,0x1200,{arguments:[base,5n],objectBase:base,objectMemory:[{offset:0,size:8,value:10n},{offset:8,size:8,value:1n}],watch:[{offset:0,size:8},{offset:8,size:8}]});
  assert.equal(r.returnValue,15n);
  assert.equal(r.memoryDelta.length,2);
  assert.ok(r.stores.some((s)=>BigInt(s.after)===15n));
}

// nested call
{
  const io = program([[0x1300,'bl','#0x1310'],[0x1304,'ret',''],[0x1310,'add','x0, x0, #2'],[0x1314,'ret','']]);
  const r = await runLocal(io,0x1300,{arguments:[40n]});
  assert.equal(r.returnValue,42n);
  assert.ok(r.calls.length >= 1);
}

// null/OOB crash is a fault, not a false branch result.
{
  const io = program([[0x1400,'ldr','x0, [x0]'],[0x1404,'ret','']]);
  const r = await runLocal(io,0x1400,{arguments:[0n]});
  assert.equal(r.stop.kind,'fault');
  assert.match(r.fault,/unmapped|oob/i);
}

// timeout / loop
{
  const io = program([[0x1500,'b','#0x1500']]);
  const r = await runLocal(io,0x1500,{arguments:[]},8);
  assert.equal(r.stop.kind,'timeout');
}

// unsupported instruction is distinct from a crash/condition result.
{
  const io = program([[0x1600,'svc','#0']]);
  const r = await runLocal(io,0x1600,{arguments:[]});
  assert.equal(r.stop.kind,'unsupported');
}

// Unified breakpoint model and explicit unsupported watchpoints in the local backend.
{
  assert.equal(normalizeBreakpoint({kind:'conditional',address:0x1000n,condition:'x0 == 1'}).kind,'conditional');
  assert.equal(normalizeBreakpoint({kind:'memory',address:0x2000n,size:4,access:'readwrite'}).access,'readwrite');
  const io=program([[0x1700,'add','x0, x0, #1'],[0x1704,'add','x0, x0, #1'],[0x1708,'ret','']]);
  const adapter=new LocalFunctionSandboxAdapter(io); await adapter.connect(); await adapter.setBreakpoint({kind:'address',address:0x1704n});
  await adapter.launch({address:0x1700n,arguments:[1n],objectAsArg0:false}); const stopped=await adapter.resume({maxSteps:20});
  assert.equal(stopped.stop.kind,'paused'); assert.equal((await adapter.readRegisters()).pc,0x1704n);
  await assert.rejects(adapter.watchMemory({address:0x600000001000n,size:4}),/unavailable|unsupported/i); await adapter.disconnect();
}

// Memory model: permissions, OOB, invalid addresses and bounded transfers.
{
  const map = new RuntimeMemoryMap([{start:0x1000n,size:0x100,kind:'global',permissions:'r'}]);
  assert.equal(map.assert(0x1000n,8,'read').kind,'global');
  assert.throws(()=>map.assert(0x1000n,8,'write'),/not writable/);
  assert.throws(()=>map.assert(0x2000n,8,'read'),/unmapped/);
  assert.throws(()=>map.assert(-1,8,'read'),/non-negative/);
  assert.throws(()=>map.assert(0x1000n,2*1024*1024,'read'),/exceeds|too-large|too large/i);
  const sandbox = createSandboxMemoryMap();
  assert.equal(sandbox.find(0x600000001000n,8)?.kind,'object');
  assert.equal(sandbox.find(0x600000000100n,8)?.kind,'heap');
  assert.equal(sandbox.find(0x600000012000n,8)?.kind,'heap');
}

// Ring-buffer budget, sampling and aggregation.
{
  const ring = new TraceRingBuffer({maxEvents:16,maxBytes:4096,sampleRate:1});
  for(let i=0;i<100;i++) ring.push({type:i%2?'branch':'instruction',address:BigInt(i)});
  const snap=ring.snapshot();
  assert.ok(snap.events.length<=16); assert.ok(snap.dropped>0); assert.ok(snap.aggregates.branch>0);
}

// Differential inputs and static -> experiment generation for all shipped real-binary fixtures.
{
  const inputs=generateDifferentialInputs({bits:32,boundary:100});
  assert.ok(inputs.some((x)=>x.kind==='scalar'&&x.value===0n));
  assert.ok(inputs.some((x)=>x.kind==='scalar'&&x.value===-1n));
  assert.ok(inputs.some((x)=>x.kind==='scalar'&&x.value===100n));
  assert.ok(inputs.some((x)=>x.kind==='pointer'&&x.value===0n));
  assert.ok(inputs.some((x)=>x.kind==='pointer'&&x.value!==0n));
  const pointerExp=compileExperiment({id:'ptr',functionAddress:0x1000n,argumentIndex:1,argumentKind:'pointer'});
  assert.ok(pointerExp.cases.some((x)=>x.id.endsWith('pointer:null')));
  assert.ok(pointerExp.cases.some((x)=>x.id.endsWith('pointer:nonnull')));
  for (const [name,file] of [['BattleCats','battlecats'],['YWP','YWP'],['TsumTsum','TsumTsum']]) {
    assert.ok(fs.statSync(new URL(`./${file}`, import.meta.url)).size > 0);
    const exp=compileExperiment({id:name,functionAddress:0x1000n,fieldOffset:0x20n,fieldSize:4,initial:100,argumentIndex:1,operation:'sub',clampMin:0},{binaryHash:`fixture:${name}`});
    assert.ok(exp.cases.length>=6); assert.equal(exp.binaryHash,`fixture:${name}`);
  }
}

// Hypothesis verdicts: confirmed, contradicted, inconclusive.
{
  const supported = Array.from({length:3},()=>({comparison:{status:'supported'}}));
  assert.equal(classifyHypothesis(supported).status,'confirmed');
  assert.equal(classifyHypothesis([...supported,{comparison:{status:'unsupported'}}]).status,'supported');
  assert.equal(classifyHypothesis([{comparison:{status:'contradicted'}}]).status,'contradicted');
  assert.equal(classifyHypothesis([{comparison:{status:'inconclusive'}}]).status,'inconclusive');
}

// Evidence independence: three observations from one trace group count once in fusion.
{
  const common={backend:'fake',binaryHash:'abc',sessionId:'s',experimentId:'e',caseId:'c',provenanceGroup:'runtime:s:e:c',verdict:'supported',confidence:.8};
  const ev=[createRuntimeEvidenceRecord({...common,id:'e1',kind:'register'}),createRuntimeEvidenceRecord({...common,id:'e2',kind:'memory'}),createRuntimeEvidenceRecord({...common,id:'e3',kind:'branch'})];
  const fused=fuseStaticDynamic({confidence:.5},ev);
  assert.equal(fused.runtimeGroups,1); assert.equal(fused.support,1);
  const contradiction=fuseStaticDynamic({confidence:.9},[createRuntimeEvidenceRecord({...common,id:'x',provenanceGroup:'other',verdict:'contradicted'})]);
  assert.equal(contradiction.status,'contradicted'); assert.ok(contradiction.confidence<.9);
}

// Trace -> semantic facts, including ObjC/Swift runtime evidence.
{
  const facts=traceToSemanticFacts({events:[
    {type:'memory-read',address:1n,size:8,region:'object',value:2n},
    {type:'memory-write',address:1n,size:8,region:'object',before:2n,after:3n},
    {type:'call',address:4n,target:8n},{type:'branch',address:12n,next:20n,taken:true},{type:'return',address:24n,value:3n},
    {type:'objc-dispatch',address:30n,className:'Foo',selector:'bar:',imp:40n},
    {type:'swift-dispatch',address:50n,dynamicType:'Game.Player',metadata:60n,witnessTarget:70n},
  ]},{sessionId:'s'});
  assert.deepEqual(new Set(facts.map((f)=>f.kind)),new Set(['reads-field','writes-field','calls-target','branch-taken','returns-value','objc-dispatch','swift-dispatch']));
  assert.equal(new Set(facts.map((f)=>f.provenance.observationGroup)).size,1);
  assert.ok(facts.every((f)=>f.provenance.group==='runtime'));
  assert.equal(compareRuntimeDispatch([40n],{imp:40n}).status,'supported');
  assert.equal(compareRuntimeDispatch([41n],{imp:40n}).status,'contradicted');
}

class FakeAdapter extends DebugAdapter {
  constructor(){super({id:'fake',kind:'fake',capabilities:{connect:true,disconnect:true,threads:true,modules:true}});this.disconnected=false;}
  async getThreads(){return[{id:1}]}
  async getModules(){return[{id:'m'}]}
  async disconnect(){this.disconnected=true;return super.disconnect()}
}

// Session stale-event rejection, cancellation, replay and disconnect.
{
  const adapter=new FakeAdapter(); const session=new DebugSession(adapter,{binaryHash:'bin'}); await session.connect();
  assert.equal(session.acceptEvent({epoch:session.epoch,type:'branch'}),true);
  assert.equal(session.acceptEvent({epoch:session.epoch+1,type:'branch'}),false);
  const ctl=session.controller(); session.newEpoch(); assert.equal(ctl.signal.aborted,true);
  session.addExperiment({id:'e'}); session.addObservation({experimentId:'e',value:1});
  assert.equal(session.replayShape('e').experiments.length,1);
  await session.disconnect(); assert.equal(adapter.disconnected,true);
}

// Remote capability negotiation is the intersection of client support and server advertisement.
{
  let receiver = () => {};
  const sent = [];
  const transport = {
    send: async (packet) => {
      sent.push(packet);
      if (packet.type === 'request' && packet.method === 'connect') queueMicrotask(() => receiver({
        version:1,type:'response',id:packet.id,epoch:packet.epoch,
        result:{capabilities:{readMemory:true,attach:false,objcRuntime:true}}
      }));
    },
    onMessage: (fn) => { receiver = fn; return () => {}; },
    close: () => {},
  };
  const adapter = new RemoteDebugAdapter(transport,{capabilities:{readMemory:true,attach:true,objcRuntime:true}});
  await adapter.connect();
  assert.equal(adapter.capabilities.readMemory,true);
  assert.equal(adapter.capabilities.attach,false);
  assert.equal(adapter.capabilities.objcRuntime,true);
  assert.throws(()=>adapter.readMemory(0x1000n,300*1024),/exceeds|too-large|too large/i);
  adapter.protocol.close();
}

// Remote protocol validation, malformed/huge packets, request cancellation and stale response rejection.
{
  assert.throws(()=>validateRemotePacket({version:1,type:'request',id:1,method:'exec',params:{}}),/prohibited/);
  assert.throws(()=>validateRemotePacket({version:1,type:'request',id:1,method:'readMemory',params:{blob:'x'.repeat(1024*1024+1)}}),/exceeds|too large/i);
  const sent=[]; let receiver=()=>{};
  const transport={send:async(p)=>sent.push(p),onMessage:(fn)=>{receiver=fn;return()=>{}},close:()=>{}};
  const client=new RemoteProtocolClient(transport,{timeoutMs:100}); client.setEpoch(7);
  const p=client.request('readRegisters',{}); await new Promise((r)=>setTimeout(r,0));
  const req=sent.find((x)=>x.type==='request');
  receiver({version:1,type:'response',id:req.id,epoch:6,result:{x0:'1'}});
  assert.equal(client.pending.size,1);
  receiver({version:1,type:'response',id:req.id,epoch:7,result:{x0:'2'}});
  assert.deepEqual(await p,{x0:'2'});
  const c=client.request('readRegisters',{}); const cancelled=assert.rejects(c,/cancelled/); await new Promise((r)=>setTimeout(r,0)); const req2=sent.filter((x)=>x.type==='request').at(-1); await client.cancel(req2.id); await cancelled;
  client.close();
}

console.log('runtime platform tests: ok');
