import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSemanticCfg} from '../../js/semantics/cfg/index.js';
import {createSemanticSsaContract} from '../../js/semantics/ssa/contract.js';
import {MEMORY_SSA_ALIAS_RELATIONS,createMemoryRegionRef,createMemorySsaContract} from '../../js/semantics/memoryssa/contract.js';
const origin={instructionIds:['instruction_fixture']};
const cfg=createSemanticCfg({functionId:'function_fixture',entryBlockId:'entry',blocks:[{id:'entry',successors:[{to:'left',kind:'conditional-true'},{to:'right',kind:'conditional-false'}]},{id:'left',successors:[{to:'join',kind:'branch'}]},{id:'right',successors:[{to:'join',kind:'branch'}]},{id:'join',successors:[]}]});
{
 const ssa=createSemanticSsaContract({functionId:'function_fixture',definitions:[
  {definitionId:'def_entry',valueId:'value_entry',kind:'entry',blockId:'entry',variableKey:'state:v',sourceEntityId:'entity_entry',origin},
  {definitionId:'def_left',valueId:'value_left',kind:'definition',blockId:'left',variableKey:'state:v',sourceEntityId:'entity_left',origin},
  {definitionId:'def_right',valueId:'value_right',kind:'definition',blockId:'right',variableKey:'state:v',sourceEntityId:'entity_right',origin},
  {definitionId:'def_phi',valueId:'value_phi',kind:'phi',blockId:'join',variableKey:'state:v',sourceEntityId:'entity_phi',incoming:[{predecessorBlockId:'left',valueId:'value_left'},{predecessorBlockId:'right',valueId:'value_right'}],origin,proof:{kind:'dominance-frontier'}},
  {definitionId:'def_unknown',valueId:'value_unknown',kind:'unknown',blockId:'entry',variableKey:'state:u',sourceEntityId:'entity_unknown',origin},
  {definitionId:'def_undef',valueId:'value_undef',kind:'undef',blockId:'entry',variableKey:'state:d',sourceEntityId:'entity_undef',origin}],uses:[{useId:'use_phi',valueId:'value_phi',blockId:'join',sourceEntityId:'entity_return',origin}]},{cfg});
 assert.equal(ssa.useDefLinks[0].definitionId,'def_phi');assert.deepEqual(ssa.defUseLinks.find((link)=>link.definitionId==='def_phi').useIds,['use_phi']);assert.ok(Object.isFrozen(ssa));
}
assert.throws(()=>createSemanticSsaContract({functionId:'function_fixture',definitions:[{definitionId:'def_left',valueId:'value_left',kind:'definition',blockId:'left',sourceEntityId:'entity_left',origin},{definitionId:'def_bad_phi',valueId:'value_bad_phi',kind:'phi',blockId:'join',sourceEntityId:'entity_phi',incoming:[{predecessorBlockId:'entry',valueId:'value_left'}],origin}],uses:[]},{cfg}),/phi-predecessor-not-in-cfg|phi-predecessor-set-incomplete/);
const regions=[
 createMemoryRegionRef({id:'region_stack',kind:'stack-fixed',functionId:'function_fixture',binaryId:'bin_fixture',offset:-16,widthBits:8}),
 createMemoryRegionRef({id:'region_global',kind:'global-absolute',binaryId:'bin_fixture',address:0x2000n,widthBits:8}),
 createMemoryRegionRef({id:'region_field',kind:'rooted-offset',functionId:'function_fixture',binaryId:'bin_fixture',rootEntityId:'entity_object',offset:32,widthBits:4}),
 createMemoryRegionRef({id:'region_tls',kind:'tls',binaryId:'bin_fixture',addressSpace:'tls'}),
 createMemoryRegionRef({id:'region_io',kind:'io',binaryId:'bin_fixture',addressSpace:'device-io'}),
 createMemoryRegionRef({id:'region_unknown',kind:'unknown',functionId:'function_fixture',binaryId:'bin_fixture',uncertaintyIdentity:{sourceEntityId:'entity_unknown_ptr'}}),
];
{
 const memorySsa=createMemorySsaContract({functionId:'function_fixture',regions,definitions:[
  {id:'m_entry',kind:'entry',regionId:'region_field',blockId:'entry',sourceEntityId:'entity_entry',origin},
  {id:'m_left',kind:'memory-def',regionId:'region_field',blockId:'left',previousDefinitionIds:['m_entry'],sourceEntityId:'entity_store_left',origin},
  {id:'m_right',kind:'memory-def',regionId:'region_field',blockId:'right',previousDefinitionIds:['m_entry'],sourceEntityId:'entity_store_right',origin},
  {id:'m_phi',kind:'memory-phi',regionId:'region_field',blockId:'join',incoming:[{predecessorBlockId:'left',definitionId:'m_left'},{predecessorBlockId:'right',definitionId:'m_right'}],sourceEntityId:'entity_memory_phi',origin},
  {id:'m_may',kind:'may-alias-clobber',regionId:'region_field',blockId:'join',previousDefinitionIds:['m_phi'],aliasRelation:'may',sourceEntityId:'entity_store_unknown_base',origin},
  {id:'m_unknown',kind:'unknown-clobber',regionId:'region_unknown',blockId:'join',aliasRelation:'unknown',sourceEntityId:'entity_unknown_effect',origin},
  {id:'m_call',kind:'call-clobber',regionId:'region_global',blockId:'join',aliasRelation:'may',sourceEntityId:'entity_call',effectSummary:{memoryScope:'global'},origin},
  {id:'m_intrinsic',kind:'intrinsic-clobber',regionId:'region_io',blockId:'join',aliasRelation:'unknown',sourceEntityId:'entity_intrinsic',effectSummary:{memoryScope:'io'},origin}],uses:[{id:'mu_load',regionId:'region_field',reachingDefinitionId:'m_may',aliasRelation:'may',blockId:'join',sourceEntityId:'entity_load',origin}]},{cfg});
 assert.equal(memorySsa.reachingDefinitionLinks[0].definitionId,'m_may');assert.equal(memorySsa.reachingDefinitionLinks[0].aliasRelation,'may');assert.ok(memorySsa.definitions.some((definition)=>definition.kind==='unknown-clobber'));assert.ok(memorySsa.definitions.some((definition)=>definition.kind==='call-clobber'));assert.ok(memorySsa.definitions.some((definition)=>definition.kind==='intrinsic-clobber'));
}
assert.deepEqual(MEMORY_SSA_ALIAS_RELATIONS,['must','may','no','unknown']);
assert.throws(()=>createMemorySsaContract({functionId:'function_fixture',regions:[regions[2]],definitions:[{id:'m_bad_alias',kind:'memory-def',regionId:'region_field',blockId:'entry',aliasRelation:'impossible',sourceEntityId:'entity_bad',origin}],uses:[]}),/invalid-alias-relation/);
{
 const controller=new AbortController();controller.abort();assert.throws(()=>createSemanticSsaContract({functionId:'function_fixture',definitions:[],uses:[]},{signal:controller.signal}),/cancelled/);assert.throws(()=>createMemorySsaContract({functionId:'function_fixture',regions:[],definitions:[],uses:[]},{signal:controller.signal}),/cancelled/);
}
assert.throws(()=>createSemanticSsaContract({functionId:'function_fixture',definitions:[{definitionId:'d1',valueId:'v1',kind:'entry',sourceEntityId:'e1',origin},{definitionId:'d2',valueId:'v2',kind:'entry',sourceEntityId:'e2',origin}],uses:[]},{budget:{maxDefinitions:1}}),/budget-exceeded-maxDefinitions/);
assert.throws(()=>createMemorySsaContract({functionId:'function_fixture',regions:[regions[0],regions[1]],definitions:[],uses:[]},{budget:{maxRegions:1}}),/budget-exceeded-maxRegions/);

assert.throws(()=>createMemoryRegionRef({id:'bad_unknown',kind:'unknown',functionId:'function_fixture'}),/unknown-region-identity-required/);
assert.throws(()=>createMemorySsaContract({functionId:'function_fixture',regions:[regions[2]],definitions:[{id:'m_bad',kind:'may-alias-clobber',regionId:'region_field',blockId:'entry',aliasRelation:'no',sourceEntityId:'entity_bad',origin}],uses:[]}),/may-clobber-invalid-alias-relation/);
assert.throws(()=>createMemorySsaContract({functionId:'function_fixture',regions:[regions[2]],definitions:[{id:'m_entry',kind:'entry',regionId:'region_field',blockId:'entry',sourceEntityId:'entity_entry',origin}],uses:[{id:'mu_bad',regionId:'region_field',reachingDefinitionId:'missing',blockId:'entry',sourceEntityId:'entity_load',origin}]}),/dangling-reaching-definition/);
{
 const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');for(const relative of ['js/semantics/ssa/contract.js','js/semantics/memoryssa/contract.js']){const source=fs.readFileSync(path.join(root,relative),'utf8');assert.doesNotMatch(source,/\b(?:arm64|aapcs64|nzcv|rax|rflags|x0|w8)\b/i,`${relative} must stay architecture-neutral`);}
}
console.log('semantic-v2 SSA/MemorySSA contracts: PASS');
