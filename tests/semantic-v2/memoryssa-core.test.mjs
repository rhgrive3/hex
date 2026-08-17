import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../../js/core/identity/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import {
  explainMemoryPath,
  memoryAccessMetadata,
  memoryUsesOfDefinition,
  reachingConcreteStore,
  reachingMemoryDefinition,
} from '../../js/semantics/memoryssa/queries.js';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

const functionId='function_memoryssa_fixture';
const origin=(id)=>({instructionIds:[`instruction_${id}`]});
const addressType={kind:'address',widthBits:64,addressSpace:'memory'};
const memory=(addressValueId,overrides={})=>({addressSpace:'memory',addressValueId,widthBits:32,endian:'little',volatility:false,atomic:false,ordering:'unknown',...overrides});
const node=(id,kind,extra={})=>({id,kind,blockId:'entry',inputs:[],outputs:[],origin:origin(id),...extra});
function callSummary(completeness='complete'){
 return {targetValueIds:[],targetEntityIds:[],arguments:[],returns:[],stateReads:[],stateWrites:[],memoryRead:{scope:completeness==='complete'?'none':'unknown'},memoryWrite:{scope:completeness==='complete'?'none':'unknown'},controlEffects:[],determinism:completeness==='complete'?'deterministic':'unknown',noreturn:completeness==='complete'?false:'unknown',mayThrow:completeness==='complete'?false:'unknown',summarySource:'fixture',completeness,unknownEffects:completeness==='complete'?null:{reason:'unresolved-call',categories:['memory']}};
}
function intrinsicSummary(){return {inputs:[],outputs:[],stateReads:[],stateWrites:[],memoryRead:{scope:'none'},memoryWrite:{scope:'all',addressSpaces:['memory']},controlEffects:[],determinism:'deterministic',symbolicDetail:'summary-only'};}
function makeFunction(nodes){
 const ids=new Set();for(const item of nodes){if(item.memory)ids.add(item.memory.addressValueId);for(const scope of [item.call?.memoryRead,item.call?.memoryWrite,item.intrinsic?.memoryRead,item.intrinsic?.memoryWrite])for(const access of scope?.accesses??[])ids.add(access.addressValueId);}
 return createSemanticIrFunction({functionId,entryBlockId:'entry',blocks:[{id:'entry',nodeIds:nodes.map((item)=>item.id),origin:origin('entry')}],values:[...ids].filter(Boolean).sort().map((id)=>({id,kind:'entry',machineType:addressType,origin:origin(id)})),nodes,completeness:nodes.some((item)=>item.completeness&&item.completeness!=='complete')?'partial':'complete',unknowns:nodes.some((item)=>item.completeness&&item.completeness!=='complete')?[{reason:'fixture-unknown',categories:['memory']}]:[],origin:origin('function')});
}
const cfg=createSemanticCfg({functionId,entryBlockId:'entry',blocks:[{id:'entry',successors:[]}]});
const regionA=createMemoryRegionRef({id:'region_A',kind:'rooted-offset',functionId,rootEntityId:'root_A',offset:0,widthBits:32});
const regionB=createMemoryRegionRef({id:'region_B',kind:'rooted-offset',functionId,rootEntityId:'root_B',offset:0,widthBits:32});
const regionMaybe=createMemoryRegionRef({id:'region_maybe',kind:'rooted-offset',functionId,rootEntityId:'root_maybe',offset:0,widthBits:32});
const regionUnknown=createMemoryRegionRef({id:'region_unknown_fixture',kind:'unknown',functionId,uncertaintyIdentity:{fixture:'unknown-pointer'}});
const regionByAddress=new Map([['addr_A',regionA],['addr_B',regionB],['addr_maybe',regionMaybe],['addr_unknown',regionUnknown]]);
function providers({unknownReadNoAlias=false,maybeRelation='may'}={}){
 return {resolveRegion(access){return regionByAddress.get(access.addressExpr.valueId)??regionUnknown;},queryAlias(left,right,context){const la=context.left.descriptor?.memory?.addressExpr?.valueId,ra=context.right.descriptor?.memory?.addressExpr?.valueId;if(context.purpose==='read-reaches-write'&&unknownReadNoAlias&&la==='addr_A'&&ra==='addr_unknown')return 'no';if(left.id===regionUnknown.id||right.id===regionUnknown.id||left.metadata?.precision==='conservative-default'||right.metadata?.precision==='conservative-default')return 'unknown';if((left.id===regionMaybe.id&&right.id===regionA.id)||(left.id===regionA.id&&right.id===regionMaybe.id))return maybeRelation;return left.id===right.id?'must':'no';}};
}
function build(nodes,providerOptions={},extra={}){const ir=makeFunction(nodes);return buildMemorySsa(ir,cfg,{...providers(providerOptions),...extra});}
const useA=(m,id)=>m.uses.find((use)=>use.sourceEntityId===id&&use.regionId===regionA.id);

{
 const m=build([node('store_A','store',{memory:memory('addr_A')}),node('load_A','load',{memory:memory('addr_A')})]);
 const use=useA(m,'load_A'),def=reachingMemoryDefinition(m,use);assert.equal(def.kind,'memory-def');assert.equal(def.sourceEntityId,'store_A');assert.equal(use.aliasRelation,'must');assert.equal(reachingConcreteStore(m,use)?.id,def.id);assert.deepEqual(memoryUsesOfDefinition(m,def).map((item)=>item.id),[use.id]);assert.ok(explainMemoryPath(m,use).nodes.some((item)=>item.kind==='entry'));assert.doesNotThrow(()=>validateMemorySsa(m,{cfg}));
}
{
 const m=build([node('store_A','store',{memory:memory('addr_A')}),node('store_B','store',{memory:memory('addr_B')}),node('load_A','load',{memory:memory('addr_A')})]);assert.equal(reachingMemoryDefinition(m,useA(m,'load_A')).sourceEntityId,'store_A');
}
{
 const m=build([node('store_A','store',{memory:memory('addr_A')}),node('store_maybe','store',{memory:memory('addr_maybe')}),node('load_A','load',{memory:memory('addr_A')})]);const use=useA(m,'load_A'),def=reachingMemoryDefinition(m,use);assert.equal(def.kind,'may-alias-clobber');assert.equal(def.sourceEntityId,'store_maybe');assert.equal(reachingConcreteStore(m,use),null);
}
{
 const m=build([node('store_A','store',{memory:memory('addr_A')}),node('store_maybe','store',{memory:memory('addr_maybe')}),node('load_A','load',{memory:memory('addr_A')})],{maybeRelation:'unknown'});assert.equal(reachingMemoryDefinition(m,useA(m,'load_A')).kind,'unknown-clobber');
}
{
 const m=build([node('store_A','store',{memory:memory('addr_A')}),node('store_unknown','store',{memory:memory('addr_unknown')}),node('load_A','load',{memory:memory('addr_A')})]);const use=useA(m,'load_A'),def=reachingMemoryDefinition(m,use);assert.equal(def.kind,'unknown-clobber');assert.equal(def.sourceEntityId,'store_unknown');assert.equal(reachingConcreteStore(m,use),null);
}
{
 const m=build([node('store_A','store',{memory:memory('addr_A')}),node('store_unknown','store',{memory:memory('addr_unknown')}),node('load_A','load',{memory:memory('addr_A')})],{unknownReadNoAlias:true});const use=useA(m,'load_A'),def=reachingMemoryDefinition(m,use);assert.equal(def.kind,'memory-def');assert.equal(def.sourceEntityId,'store_A');assert.equal(reachingConcreteStore(m,use)?.sourceEntityId,'store_A');
}
{
 const call=node('call_unknown','call',{call:callSummary('unknown'),completeness:'unknown',unknown:{reason:'unresolved-call',categories:['memory']}});const m=build([node('store_A','store',{memory:memory('addr_A')}),call,node('load_A','load',{memory:memory('addr_A')})]);const use=useA(m,'load_A'),def=reachingMemoryDefinition(m,use);assert.equal(def.kind,'call-clobber');assert.equal(def.sourceEntityId,'call_unknown');assert.equal(reachingConcreteStore(m,use),null);
}
{
 const intrinsic=node('intrinsic_all','intrinsic',{intrinsic:intrinsicSummary()});const m=build([node('store_A','store',{memory:memory('addr_A')}),intrinsic,node('load_A','load',{memory:memory('addr_A')})]);assert.equal(reachingMemoryDefinition(m,useA(m,'load_A')).kind,'intrinsic-clobber');
}
{
 const ordered=memory('addr_A',{volatility:true,atomic:true,ordering:'seq-cst',alignment:4});const m=build([node('store_ordered','store',{memory:ordered}),node('load_ordered','load',{memory:ordered})]);const def=m.definitions.find((item)=>item.sourceEntityId==='store_ordered'&&item.regionId===regionA.id),use=useA(m,'load_ordered');const expected={alignment:4,atomic:true,ordering:'seq-cst',volatility:true};assert.deepEqual(def.effectSummary.sequencing,expected);assert.deepEqual(memoryAccessMetadata(m,use.id).sequencing,expected);
}
{
 const nodes=[node('store_A','store',{memory:memory('addr_A')}),node('store_B','store',{memory:memory('addr_B')}),node('load_A','load',{memory:memory('addr_A')})];const first=build(nodes),second=build(nodes);assert.equal(stableStringify(first),stableStringify(second));assert.ok(first.regions.some((region)=>region.id===regionA.id));assert.ok(first.regions.some((region)=>region.id===regionB.id));for(const def of first.definitions)assert.ok(def.origin.transforms.some((transform)=>transform.passId==='semantic-memoryssa'));for(const use of first.uses)assert.ok(use.origin.transforms.some((transform)=>transform.passId==='semantic-memoryssa'));
}
{
 const controller=new AbortController();controller.abort();const ir=makeFunction([node('load_A','load',{memory:memory('addr_A')})]);assert.throws(()=>buildMemorySsa(ir,cfg,{...providers(),signal:controller.signal}),/cancelled/);
}
{
 const ir=makeFunction([node('store_A','store',{memory:memory('addr_A')}),node('load_A','load',{memory:memory('addr_A')})]);assert.throws(()=>buildMemorySsa(ir,cfg,{...providers(),budget:{maxAliasQueries:1}}),/budget-exceeded-maxAliasQueries/);
}
{
 const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');for(const relative of ['js/semantics/memoryssa/build.js','js/semantics/memoryssa/queries.js','js/semantics/memoryssa/validate.js']){const source=fs.readFileSync(path.join(root,relative),'utf8');assert.doesNotMatch(source,/\b(?:arm64|aapcs64|nzcv|rax|rflags|x0|w8)\b/i,`${relative} must remain architecture-neutral`);assert.doesNotMatch(source,/\b(?:stack-fixed|global-absolute|rooted-offset)\b/i,`${relative} must not special-case production region kinds`);}
 const validator=fs.readFileSync(path.join(root,'js/semantics/memoryssa/validate.js'),'utf8');assert.doesNotMatch(validator,/accessMetadata\.some\s*\(/,'MemorySSA metadata coverage validation must not regress to per-entity linear scans');assert.match(validator,/metadataEntityIdsByKind/,'MemorySSA metadata validation must keep one-pass coverage indexes');
}
console.log('semantic-v2 generic MemorySSA core: PASS');