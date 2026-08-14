import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DebugAdapter, asAddress, normalizeBreakpoint } from '../js/debug/adapter.js';
import { RuntimeMemoryMap, createSandboxMemoryMap, RUNTIME_HEAP_BASE } from '../js/runtime/memory.js';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';
import { validateRemotePacket, RemoteProtocolClient } from '../js/debug/remote-protocol.js';
import { LocalFunctionSandboxAdapter, RemoteDebugAdapter } from '../js/adapters/index.js';
import { compileExperiment, generateDifferentialInputs, classifyHypothesis, compareExpected, HypothesisVerifier } from '../js/dynamic/experiments.js';
import { createRuntimeEvidenceRecord, fuseStaticDynamic, traceToSemanticFacts, compareRuntimeDispatch } from '../js/runtime-evidence/index.js';
import { DebugSession, DebugSessionManager } from '../js/runtime/session.js';
import { RuntimeAnalysisPlatform } from '../js/runtime/index.js';

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

// Address and breakpoint validation must not silently coerce unsafe inputs or collide IDs.
{
  assert.equal(asAddress('0x1000'),0x1000n);
  assert.throws(()=>asAddress(null),/non-negative integer/);
  assert.throws(()=>asAddress(true),/non-negative integer/);
  assert.throws(()=>asAddress(Number.MAX_SAFE_INTEGER+1),/non-negative integer/);
  const c1=normalizeBreakpoint({kind:'conditional',address:0x1000n,condition:'x0 == 1'});
  const c2=normalizeBreakpoint({kind:'conditional',address:0x1000n,condition:'x0 == 2'});
  assert.notEqual(c1.id,c2.id);
  const w1=normalizeBreakpoint({kind:'memory',address:0x2000n,size:4,access:'write'});
  const w2=normalizeBreakpoint({kind:'memory',address:0x2000n,size:8,access:'readwrite'});
  assert.notEqual(w1.id,w2.id);
}

// add/sub
{
  const io = program([[0x1000,'add','x0, x0, x1'],[0x1004,'sub','x0, x0, #1'],[0x1008,'ret','']]);
  const r = await runLocal(io,0x1000,{arguments:[3n,5n]});
  assert.equal(r.returnValue,7n);
  assert.equal(r.stop.kind,'return');
}

// clamp + branch; branch instructions must not be misclassified as calls.
{
  const io = program([
    [0x1100,'cmp','x1, #0'],[0x1104,'b.ge','#0x1110'],[0x1108,'mov','x0, #0'],[0x110c,'ret',''],
    [0x1110,'mov','x0, x1'],[0x1114,'ret',''],
  ]);
  const neg = await runLocal(io,0x1100,{arguments:[0n,-9n]});
  const pos = await runLocal(io,0x1100,{arguments:[0n,9n]});
  assert.equal(neg.returnValue,0n); assert.equal(pos.returnValue,9n);
  assert.ok((neg.branches.length + pos.branches.length) >= 1);
  assert.equal(neg.calls.length + pos.calls.length,0);
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
  assert.equal(r.memoryAfter.find((x)=>x.offset===0n)?.value,15n);
}

// An unchanged-but-observed expected field is support, not a contradiction.
{
  const io = program([[0x1250,'ldr','x2, [x0]'],[0x1254,'add','x2, x2, x1'],[0x1258,'str','x2, [x0]'],[0x125c,'ret','']]);
  const adapter = new LocalFunctionSandboxAdapter(io);
  const experiment = compileExperiment({id:'zero-delta',functionAddress:0x1250n,fieldOffset:0n,fieldSize:8,initial:100n,argumentIndex:1,operation:'add'}, {inputs:[{id:'zero',kind:'scalar',value:0n}]});
  const verifier = new HypothesisVerifier(adapter);
  const result = await verifier.verify(experiment,{maxSteps:20});
  assert.equal(result.cases[0].observation.memoryDelta.length,0);
  assert.equal(result.cases[0].comparison.status,'supported');
  assert.equal(result.cases[0].comparison.source,'final-state');
  assert.equal(compareExpected(experiment.cases[0],{stop:{kind:'return'},memoryDelta:[]}).status,'inconclusive');
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
  assert.equal(r.calls.length,0);
}

// unsupported instruction is distinct from a crash/condition result.
{
  const io = program([[0x1600,'svc','#0']]);
  const r = await runLocal(io,0x1600,{arguments:[]});
  assert.equal(r.stop.kind,'unsupported');
}

// Unified breakpoint model and explicit unsupported watchpoints in the local backend.
{
  const io=program([[0x1700,'add','x0, x0, #1'],[0x1704,'add','x0, x0, #1'],[0x1708,'ret','']]);
  const adapter=new LocalFunctionSandboxAdapter(io); await adapter.connect(); await adapter.setBreakpoint({kind:'address',address:0x1704n});
  await adapter.launch({address:0x1700n,arguments:[1n],objectAsArg0:false}); const stopped=await adapter.resume({maxSteps:20});
  assert.equal(stopped.stop.kind,'paused'); assert.equal((await adapter.readRegisters()).pc,0x1704n);
  await adapter.writeRegister('pc',0x1708n); assert.equal((await adapter.readRegisters()).pc,0x1708n);
  await assert.rejects(adapter.writeRegister('bad',1n),/invalid-register|unsupported register/i);
  await assert.rejects(adapter.watchMemory({address:0x600000001000n,size:4}),/unavailable|unsupported/i); await adapter.disconnect();
}

// Memory model: permissions, OOB, invalid addresses, bounded transfers, and disjoint synthetic heap/object regions.
{
  const map = new RuntimeMemoryMap([{start:0x1000n,size:0x100,kind:'global',permissions:'r'}]);
  assert.equal(map.assert(0x1000n,8,'read').kind,'global');
  assert.throws(()=>map.assert(0x1000n,8,'write'),/not writable/);
  assert.throws(()=>map.assert(0x2000n,8,'read'),/unmapped/);
  assert.throws(()=>map.assert(-1,8,'read'),/non-negative/);
  assert.throws(()=>map.assert(0x1000n,2*1024*1024,'read'),/exceeds|too-large|too large/i);
  const sandbox = createSandboxMemoryMap();
  assert.equal(sandbox.find(0x600000001000n,8)?.kind,'object');
  assert.equal(sandbox.find(RUNTIME_HEAP_BASE+0x100n,8)?.kind,'heap');
  assert.throws(()=>createSandboxMemoryMap({heapBase:0x600000001000n}),/overlap/);
}

// malloc must remain in the synthetic heap even after allocations larger than the old object overlap gap.
{
  const io=program([[0x1750,'mov','x0, #0x5000'],[0x1754,'bl','#0x9000'],[0x1758,'mov','x0, #8'],[0x175c,'bl','#0x9000'],[0x1760,'ret','']]);
  io.symbolFor=(addr)=>BigInt(addr)===0x9000n?'_malloc':null;
  const adapter=new LocalFunctionSandboxAdapter(io); await adapter.connect(); await adapter.launch({address:0x1750n,objectAsArg0:false});
  const result=await adapter.resume({maxSteps:20});
  assert.equal(adapter.memoryMap.find(result.returnValue,8)?.kind,'heap');
  await adapter.disconnect();
}

// Ring-buffer budget, sampling and aggregation remain bounded even with oversized/unique event types.
{
  const ring = new TraceRingBuffer({maxEvents:16,maxBytes:4096,sampleRate:1});
  for(let i=0;i<100;i++) ring.push({type:`branch:${i}`,address:BigInt(i)});
  const snap=ring.snapshot();
  assert.ok(snap.events.length<=16); assert.ok(snap.dropped>0); assert.ok(Object.keys(snap.aggregates).length<=16);
  const huge=new TraceRingBuffer({maxEvents:16,maxBytes:4096});
  assert.equal(huge.push({type:'huge',data:'x'.repeat(10000)}),false);
  assert.equal(huge.snapshot().events.length,0);
}

// Differential inputs and static -> experiment generation for all shipped real-binary fixtures.
{
  const inputs=generateDifferentialInputs({bits:32,boundary:100,pointer:false});
  assert.ok(inputs.some((x)=>x.kind==='scalar'&&x.value===0n));
  assert.ok(inputs.some((x)=>x.kind==='scalar'&&x.value===-1n));
  assert.ok(inputs.some((x)=>x.kind==='scalar'&&x.value===100n));
  assert.equal(inputs.some((x)=>x.kind==='pointer'),false);
  const unsigned=generateDifferentialInputs({bits:32,signed:false,limit:64,pointer:false});
  assert.ok(unsigned.some((x)=>x.value===0xffffffffn));
  const pointerInputs=generateDifferentialInputs({bits:64,pointer:true});
  assert.ok(pointerInputs.some((x)=>x.kind==='pointer'&&x.value===0n));
  assert.ok(pointerInputs.some((x)=>x.kind==='pointer'&&x.value!==0n));
  const pointerExp=compileExperiment({id:'ptr',functionAddress:0x1000n,argumentIndex:1,argumentKind:'pointer'});
  assert.ok(pointerExp.cases.some((x)=>x.id.endsWith('pointer:null')));
  assert.ok(pointerExp.cases.some((x)=>x.id.endsWith('pointer:nonnull')));
  assert.throws(()=>compileExperiment({functionAddress:0x1000n,fieldOffset:-1,fieldSize:4}),/fieldOffset|non-negative/);
  assert.throws(()=>compileExperiment({functionAddress:0x1000n,fieldOffset:0,fieldSize:16}),/fieldSize/);
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

// Evidence independence and binary scoping.
{
  const common={backend:'fake',binaryHash:'abc',sessionId:'s',experimentId:'e',caseId:'c',provenanceGroup:'runtime:s:e:c',verdict:'supported',confidence:.8};
  const ev=[createRuntimeEvidenceRecord({...common,id:'e1',kind:'register'}),createRuntimeEvidenceRecord({...common,id:'e2',kind:'memory'}),createRuntimeEvidenceRecord({...common,id:'e3',kind:'branch'})];
  const fused=fuseStaticDynamic({confidence:.5,binaryHash:'abc'},ev);
  assert.equal(fused.runtimeGroups,1); assert.equal(fused.support,1);
  const mismatch=fuseStaticDynamic({confidence:.5,binaryHash:'new'},ev);
  assert.equal(mismatch.support,0); assert.equal(mismatch.ignoredEvidence,3); assert.equal(mismatch.confidence,.5);
  const contradiction=fuseStaticDynamic({confidence:.9,binaryHash:'abc'},[createRuntimeEvidenceRecord({...common,id:'x',provenanceGroup:'other',verdict:'contradicted'})]);
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
  assert.equal(compareRuntimeDispatch([],{imp:40n}).status,'inconclusive');
}

class FakeAdapter extends DebugAdapter {
  constructor(){super({id:'fake',kind:'fake',capabilities:{connect:true,disconnect:true,threads:true,modules:true}});this.disconnected=false;}
  async getThreads(){return[{id:1}]}
  async getModules(){return[{id:'m'}]}
  async disconnect(){this.disconnected=true;return super.disconnect()}
}

// Session stale-event rejection, cancellation, JSON-safe replay, disconnect, and adapter ownership.
{
  const adapter=new FakeAdapter(); const session=new DebugSession(adapter,{binaryHash:'bin'}); await session.connect();
  assert.equal(session.acceptEvent({epoch:session.epoch,type:'branch',address:1n}),true);
  assert.equal(session.acceptEvent({epoch:session.epoch+1,type:'branch'}),false);
  const ctl=session.controller(); session.newEpoch(); assert.equal(ctl.signal.aborted,true);
  session.addExperiment({id:'e',functionAddress:0x1000n}); session.addObservation({experimentId:'e',value:1n});
  const replay=session.replayShape('e'); assert.equal(replay.experiments.length,1); assert.doesNotThrow(()=>JSON.stringify(replay));
  assert.doesNotThrow(()=>JSON.stringify(session.serialize()));
  await session.disconnect(); assert.equal(adapter.disconnected,true);
  const manager=new DebugSessionManager(); const shared=new FakeAdapter(); manager.create(shared);
  assert.throws(()=>manager.create(shared),/cannot be shared|adapter-in-use/i);
}

// Runtime platform refuses stale-binary experiments and cannot have trace options redirect the target address.
{
  const io=program([[0x1800,'mov','x0, #1'],[0x1804,'ret',''],[0x1810,'mov','x0, #2'],[0x1814,'ret','']]);
  const platform=new RuntimeAnalysisPlatform({localIO:io,symbolic:false});
  const session=await platform.startSession({binaryHash:'new'});
  const stale=compileExperiment({id:'stale',functionAddress:0x1800n,fieldOffset:0n,fieldSize:8,operation:'set'},{binaryHash:'old',inputs:[{id:'one',kind:'scalar',value:1n}]});
  await assert.rejects(platform.runExperiment(stale),/binary hash|binary-version-mismatch/i);
  const traced=await platform.traceFunction(0x1800n,{address:0x1810n,maxSteps:10,objectAsArg0:false});
  assert.equal(traced.functionAddress,0x1800n); assert.equal(traced.observation.returnValue,1n);
  await platform.sessions.close(session.id);
}

// Remote capability negotiation is the intersection of client support and server advertisement, and bytes are normalized.
{
  let receiver = () => {};
  const sent = [];
  const transport = {
    send: async (packet) => {
      sent.push(packet);
      if (packet.type !== 'request') return;
      if (packet.method === 'connect') queueMicrotask(() => receiver({version:1,type:'response',id:packet.id,epoch:packet.epoch,result:{capabilities:{readMemory:true,attach:false,objcRuntime:true}}}));
      if (packet.method === 'readMemory') queueMicrotask(() => receiver({version:1,type:'response',id:packet.id,epoch:packet.epoch,result:{bytes:packet.params.address==='4097'?[1]:[1,2]}}));
    },
    onMessage: (fn) => { receiver = fn; return () => {}; },
    close: () => {},
  };
  const adapter = new RemoteDebugAdapter(transport,{capabilities:{readMemory:true,attach:true,objcRuntime:true}});
  await adapter.connect();
  assert.equal(adapter.capabilities.readMemory,true);
  assert.equal(adapter.capabilities.attach,false);
  assert.equal(adapter.capabilities.objcRuntime,true);
  await assert.rejects(adapter.readMemory(0x1000n,300*1024),/exceeds|too-large|too large/i);
  assert.deepEqual([...await adapter.readMemory(0x1000n,2)],[1,2]);
  await assert.rejects(adapter.readMemory(0x1001n,2),{code:'short-read'});
  assert.throws(()=>adapter.call('totallyUnknown',{}),/not exposed|unsupported-method/i);
  adapter.protocol.close();
}

// Remote protocol validation, byte-size bounds, BigInt wire encoding, epoch cancellation and stale response rejection.
{
  assert.throws(()=>validateRemotePacket({version:1,type:'request',id:1,epoch:0,method:'exec',params:{}}),/prohibited/);
  assert.throws(()=>validateRemotePacket({version:1,type:'request',id:1,epoch:0,method:'readMemory',params:{blob:'x'.repeat(1024*1024+1)}}),/exceeds|too large/i);
  assert.throws(()=>validateRemotePacket({version:1,type:'request',id:1,epoch:0,method:'readMemory',params:{blob:'é'.repeat(600000)}}),/exceeds|too large/i);
  assert.throws(()=>validateRemotePacket({version:1,type:'event',event:{}}),/epoch/);
  const sent=[]; let receiver=()=>{};
  const transport={send:async(p)=>sent.push(p),onMessage:(fn)=>{receiver=fn;return()=>{}},close:()=>{}};
  const client=new RemoteProtocolClient(transport,{timeoutMs:100}); client.setEpoch(7);
  const p=client.request('readRegisters',{address:0x1234n}); await new Promise((r)=>setTimeout(r,0));
  const req=sent.find((x)=>x.type==='request'); assert.equal(req.params.address,'4660');
  receiver({version:1,type:'response',id:req.id,epoch:6,result:{x0:'1'}});
  assert.equal(client.pending.size,1);
  receiver({version:1,type:'response',id:req.id,epoch:7,result:{x0:'2'}});
  assert.deepEqual(await p,{x0:'2'});
  const stale=client.request('readRegisters',{}); const staleRejected=assert.rejects(stale,/stale-request|epoch/i); await new Promise((r)=>setTimeout(r,0)); client.setEpoch(8); await staleRejected; assert.equal(client.pending.size,0);
  const c=client.request('readRegisters',{}); const cancelled=assert.rejects(c,/cancelled/); await new Promise((r)=>setTimeout(r,0)); const req2=sent.filter((x)=>x.type==='request').at(-1); await client.cancel(req2.id); await cancelled;
  client.close();
}

console.log('runtime platform tests: ok');
