import assert from 'node:assert/strict';
import {SEMANTIC_IR_CONTRACT_VERSION,SEMANTIC_IR_SCHEMA_VERSION,SEMANTIC_OPERATION_KINDS,SEMANTIC_MACHINE_TYPE_KINDS,canonicalSerializeSemanticIr,createSemanticCallSummary,createSemanticIntrinsicSummary,createSemanticIrFunction,createSemanticMachineType,createSemanticMemoryAccess,createSemanticNode,createSemanticValue,createSemanticVariableRef} from '../../js/semantics/ir/index.js';
const origin={instructionIds:['instruction_fixture']},bit32={kind:'bitvector',widthBits:32},address64={kind:'address',widthBits:64,addressSpace:'memory'},entryBlockId='block_entry',addrId='value_addr',loadId='value_load';

for (const kind of ['const','copy','unary','binary','compare','select','zext','sext','trunc','extract','insert','concat','state-read','state-write','address','load','store','call','return','branch','conditional-branch','trap','barrier','intrinsic','unknown-value','unknown-state-write','unknown-memory-effect','unknown-control-effect','incomplete']) assert.ok(SEMANTIC_OPERATION_KINDS.includes(kind), `missing semantic operation kind ${kind}`);
for (const kind of ['bitvector','float','vector','predicate','address']) assert.ok(SEMANTIC_MACHINE_TYPE_KINDS.includes(kind), `missing semantic machine type ${kind}`);

function baseFunction(overrides={}){return{schemaVersion:2,contractVersion:'2.0.0',functionId:'function_fixture',entryBlockId,blocks:[{id:entryBlockId,nodeIds:['node_load','node_return'],origin}],values:[{id:addrId,kind:'entry',machineType:address64,sourceEntityId:'function_fixture',origin},{id:loadId,kind:'definition',machineType:bit32,definitionNodeId:'node_load',sourceEntityId:'node_load',origin}],nodes:[{id:'node_load',kind:'load',blockId:entryBlockId,inputs:[addrId],outputs:[loadId],memory:{addressSpace:'memory',addressExpr:{valueId:addrId},widthBits:32,endian:'little',alignment:4,volatility:false,atomic:false,faults:[{kind:'translation-fault',detail:{recoverable:true}}]},sourceEffectIds:['effect-load'],origin},{id:'node_return',kind:'return',blockId:entryBlockId,inputs:[loadId],outputs:[],origin}],completeness:'complete',unknowns:[],origin,...overrides};}
{
 const ir=createSemanticIrFunction(baseFunction());assert.equal(ir.schemaVersion,SEMANTIC_IR_SCHEMA_VERSION);assert.equal(ir.contractVersion,SEMANTIC_IR_CONTRACT_VERSION);assert.ok(Object.isFrozen(ir));assert.ok(Object.isFrozen(ir.nodes[0]));assert.ok(Object.isFrozen(ir.nodes[0].origin));assert.throws(()=>ir.nodes.push({}),TypeError);const load=ir.nodes.find((node)=>node.id==='node_load');assert.equal(load.memory.widthBits,32);assert.equal(load.memory.alignment,4);assert.equal(load.memory.faults[0].kind,'translation-fault');
}
{
 const a=baseFunction(),b={origin,unknowns:[],completeness:'complete',nodes:[a.nodes[1],a.nodes[0]],values:[a.values[1],a.values[0]],blocks:a.blocks,entryBlockId,functionId:'function_fixture',contractVersion:'2.0.0',schemaVersion:2};assert.equal(canonicalSerializeSemanticIr(a),canonicalSerializeSemanticIr(b));
}
{
 const variable=createSemanticVariableRef({key:'state:arg0',kind:'physical-state',scope:'function',physicalIdentity:{bank:'opaque-bank',slot:0}});assert.equal(variable.key,'state:arg0');assert.equal(variable.physicalIdentity.bank,'opaque-bank');
}
{
 const access=createSemanticMemoryAccess({addressSpace:'io',addressValueId:addrId,widthBits:16,endian:'big',alignment:2,volatility:true,atomic:'unknown',ordering:'unknown',faults:[{kind:'device-fault'}]});assert.equal(access.addressExpr.valueId,addrId);assert.equal(access.volatility,true);assert.equal(access.atomic,'unknown');const unspecified=createSemanticMemoryAccess({addressSpace:'memory',addressValueId:addrId,widthBits:8,endian:'little'});assert.equal(unspecified.volatility,'unknown');assert.equal(unspecified.atomic,'unknown');assert.equal(unspecified.ordering,'unknown');
}
{
 const summary=createSemanticIntrinsicSummary({inputs:[loadId],outputs:[loadId],stateReads:[{key:'state:opaque',kind:'logical-state',scope:'function'}],stateWrites:[{key:'state:opaque',kind:'logical-state',scope:'function'}],memoryRead:{scope:'all',addressSpaces:['memory']},memoryWrite:{scope:'unknown',detail:{reason:'summary lacks address precision'}},controlEffects:[{kind:'fallthrough'}],determinism:'input-dependent',symbolicDetail:'summary-only'});const node=createSemanticNode({id:'node_intrinsic',kind:'intrinsic',blockId:entryBlockId,inputs:[loadId],outputs:[],intrinsic:summary,completeness:'partial',unknown:{reason:'intrinsic memory scope unresolved',categories:['memory']},origin});assert.equal(node.intrinsic.memoryWrite.scope,'unknown');assert.equal(node.intrinsic.stateWrites.length,1);
}
{
 const call=createSemanticCallSummary({targetValueIds:[addrId],targetEntityIds:[],arguments:[loadId],returns:[],stateReads:[],stateWrites:[],memoryRead:{scope:'unknown',detail:{reason:'callee unresolved'}},memoryWrite:{scope:'unknown',detail:{reason:'callee unresolved'}},controlEffects:[{kind:'call'}],determinism:'unknown',noreturn:'unknown',mayThrow:'unknown',summarySource:'conservative-unknown-call',completeness:'unknown',unknownEffects:{reason:'callee summary unavailable',categories:['state','memory','control']}});const node=createSemanticNode({id:'node_call',kind:'call',blockId:entryBlockId,inputs:[addrId,loadId],outputs:[],call,completeness:'partial',unknown:{reason:'callee summary unavailable',categories:['state','memory','control']},origin});assert.equal(node.call.memoryWrite.scope,'unknown');assert.equal(node.call.completeness,'unknown');
}
for(const[kind,category]of[['unknown-value','value'],['unknown-state-write','state'],['unknown-memory-effect','memory'],['unknown-control-effect','control']]){const node=createSemanticNode({id:`node_${kind}`,kind,blockId:entryBlockId,unknown:{reason:`${category} semantics unresolved`,categories:[category]},completeness:'unknown',origin});assert.equal(node.kind,kind);assert.equal(node.completeness,'unknown');}
assert.doesNotThrow(()=>createSemanticNode({id:'node_incomplete',kind:'incomplete',blockId:entryBlockId,unknown:{reason:'partial semantics',categories:['state'],missing:['secondary-result']},completeness:'partial',origin}));
assert.throws(()=>createSemanticMachineType({kind:'bitvector',widthBits:0}),/invalid-width/);
assert.throws(()=>createSemanticMemoryAccess({addressSpace:'memory',addressValueId:addrId,widthBits:-1,endian:'little'}),/invalid-memory-width/);
assert.throws(()=>createSemanticNode({id:'missing_origin',kind:'copy',blockId:entryBlockId,inputs:[],outputs:[]}),/node-origin-required/);
assert.throws(()=>createSemanticValue({id:'missing_value_origin',kind:'entry',machineType:bit32}),/value-origin-required/);
assert.throws(()=>createSemanticNode({id:'empty_origin',kind:'copy',blockId:entryBlockId,inputs:[],outputs:[],origin:{}}),/empty-origin/);
assert.throws(()=>createSemanticIrFunction({...baseFunction(),schemaVersion:1}),/schema-version-mismatch/);
{
 const malformed=baseFunction();malformed.blocks=[malformed.blocks[0],{id:entryBlockId,nodeIds:[],origin}];assert.throws(()=>createSemanticIrFunction(malformed),/duplicate-block-id/);
}
{
 const malformed=baseFunction();malformed.nodes=malformed.nodes.map((node)=>node.id==='node_return'?{...node,inputs:['value_missing']}:node);assert.throws(()=>createSemanticIrFunction(malformed),/dangling-value-id/);
}
{
 const malformed=baseFunction();malformed.nodes=malformed.nodes.map((node)=>node.id==='node_return'?{...node,kind:'branch',inputs:[],targets:['block_missing']}:node);assert.throws(()=>createSemanticIrFunction(malformed),/invalid-control-target/);
}
{
 const cycle={};cycle.self=cycle;assert.throws(()=>createSemanticNode({id:'node_cycle',kind:'copy',blockId:entryBlockId,attributes:cycle,origin}),/invalid-node-attributes|identity-cyclic-value/);
}
{
 const controller=new AbortController();controller.abort();assert.throws(()=>createSemanticIrFunction(baseFunction(),{signal:controller.signal}),/cancelled/);
}
assert.throws(()=>createSemanticIrFunction(baseFunction(),{budget:{maxNodes:1}}),/budget-exceeded-maxNodes/);
console.log('semantic-v2 IR contract: PASS');
