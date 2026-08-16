import assert from 'node:assert/strict';
import { OP, VK } from '../../js/ir-core.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const bit1 = { kind: 'predicate', widthBits: 1 };
const bit16 = { kind: 'bitvector', widthBits: 16 };
const bit32 = { kind: 'bitvector', widthBits: 32 };
const bit64 = { kind: 'bitvector', widthBits: 64 };
const addr64 = { kind: 'address', widthBits: 64, addressSpace: 'memory' };

function origin(id, address = 0x1000n) {
  return {
    instructionIds: [`i:${id}`],
    operationIds: [`op:${id}`],
    virtualRanges: [{ start: address, end: address + 4n }],
    parentEntityIds: [`parent:${id}`],
  };
}
function variable(key, physicalId, kind = 'register') {
  return { key, kind: 'physical-state', scope: 'function', physicalIdentity: kind === 'register'
    ? { kind, registerId: physicalId }
    : { kind, flagId: physicalId } };
}
function entryValue(id, machineType = bit64, variableKey = null, at = 0x1000n) {
  return { id, kind: 'entry', machineType, sourceEntityId: 'fn', variableKey, origin: origin(`v:${id}`, at) };
}
function defValue(id, nodeId, machineType = bit64, variableKey = null, at = 0x1000n) {
  return { id, kind: 'definition', machineType, definitionNodeId: nodeId, sourceEntityId: nodeId, variableKey, origin: origin(`v:${id}`, at) };
}
function unknownValue(id, machineType = bit64, at = 0x1000n) {
  return { id, kind: 'unknown', machineType, sourceEntityId: 'unknown-source', variableKey: null, origin: origin(`v:${id}`, at) };
}
function block(id, nodeIds, at = 0x1000n) { return { id, nodeIds, origin: origin(`b:${id}`, at) }; }
function semanticFunction({ id = 'fn', blocks, values, nodes, completeness = 'complete', unknowns = [], at = 0x1000n }) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: id,
    entryBlockId: blocks[0].id,
    blocks,
    values,
    nodes,
    completeness,
    unknowns,
    origin: origin(`fn:${id}`, at),
  };
}
function exactIntrinsic(inputs, outputs) {
  return {
    inputs, outputs, stateReads: [], stateWrites: [],
    memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' },
    controlEffects: [], determinism: 'deterministic', symbolicDetail: 'summary-only',
  };
}
function memory(addressValueId, widthBits = 32) {
  return {
    addressSpace: 'memory', addressExpr: { valueId: addressValueId }, widthBits,
    endian: 'little', alignment: null, volatility: false, atomic: false, ordering: 'unknown', faults: [],
  };
}
function ssaDefinition({ id, valueId, kind, blockId = null, variableKey = null, sourceEntityId = null, incoming = [], at = 0x1000n, proof = null }) {
  return { definitionId: id, valueId, kind, blockId, variableKey, sourceEntityId, incoming, origin: origin(`ssa:${id}`, at), ...(proof ? { proof } : {}) };
}
function ssaUse({ id, valueId, blockId, sourceEntityId, at = 0x1000n, proof = null }) {
  return { useId: id, valueId, blockId, sourceEntityId, origin: origin(`use:${id}`, at), ...(proof ? { proof } : {}) };
}
function stateProof(kind, stateVar, sourceSemanticValueId, machineType = bit64) {
  return { kind, variableIdentity: stateVar, machineType, sourceSemanticValueId };
}
function cfg(functionId, entryBlockId, blocks) {
  return { contractVersion: '2.0.0', functionId, entryBlockId, blocks };
}
function projectionSnapshot(out) {
  return {
    values: out.values.map((value) => ({ kind:value.kind, reg:value.reg, stateKey:value.stateKey, version:value.version, bits:value.bits, constant:value.const })),
    instructions: out.instructions.map((inst) => ({
      op:inst.op, sub:inst.sub, semanticNodeId:inst.semanticNodeId, reg:inst.dst?.reg ?? null,
      args:inst.args.map((arg) => arg.value?.reg ?? arg.value?.const ?? arg.value?.semanticValueId ?? null),
      cond:inst.cond ?? null,
      address:inst.addr ? { base:inst.addr.baseReg, disp:inst.addr.disp, index:inst.addr.index?.reg ?? null, scale:inst.addr.scale, extend:inst.addr.extend, precise:inst.addr.precise } : null,
    })),
    blocks: out.blocks.map((b) => ({ id:b.semanticBlockId, succ:b.succ, pred:b.pred, loop:b.isLoopHeader, edges:b.successorEdges })),
    loops: out.loops.map((loop) => ({ header:loop.header, latches:[...loop.latches].sort(), nodes:[...loop.nodes].sort(), exits:[...loop.exits].sort() })),
    backEdges: out.backEdges,
  };
}

// State read/write roundtrip: physical public identity is distinct from SSA key and width view.
{
  const key = 'physical-state:digest-not-public';
  const physical = variable(key, 'generic-r0');
  const r32 = defValue('r32', 'read32', bit32, key, 0x1000n);
  const r64 = defValue('r64', 'read64', bit64, key, 0x1004n);
  const copied = defValue('copied', 'copy', bit32, null, 0x1008n);
  const nodes = [
    { id:'read32', kind:'state-read', blockId:'b0', inputs:[], outputs:['r32'], variable:physical, origin:origin('read32',0x1000n) },
    { id:'read64', kind:'state-read', blockId:'b0', inputs:[], outputs:['r64'], variable:physical, origin:origin('read64',0x1004n) },
    { id:'copy', kind:'copy', blockId:'b0', inputs:['r32'], outputs:['copied'], operator:'copy', origin:origin('copy',0x1008n) },
    { id:'write', kind:'state-write', blockId:'b0', inputs:['copied'], outputs:[], variable:physical, origin:origin('write',0x100cn) },
    { id:'ret', kind:'return', blockId:'b0', inputs:[], outputs:[], origin:origin('ret',0x1010n) },
  ];
  const ir = semanticFunction({ blocks:[block('b0', nodes.map((n) => n.id))], values:[r32,r64,copied], nodes });
  const ssa = {
    contractVersion:'2.0.0', functionId:'fn',
    definitions:[
      ssaDefinition({ id:'state-entry', valueId:'state-v0', kind:'entry', variableKey:key, sourceEntityId:'fn', proof:stateProof('entry-seed',physical,null,bit64) }),
      ssaDefinition({ id:'scalar-r32', valueId:'ssa-r32', kind:'definition', blockId:'b0', sourceEntityId:'r32', proof:{ kind:'semantic-value-definition', sourceSemanticValueId:'r32', machineType:bit32 } }),
      ssaDefinition({ id:'scalar-r64', valueId:'ssa-r64', kind:'definition', blockId:'b0', sourceEntityId:'r64', proof:{ kind:'semantic-value-definition', sourceSemanticValueId:'r64', machineType:bit64 } }),
      ssaDefinition({ id:'scalar-copy', valueId:'ssa-copy', kind:'definition', blockId:'b0', sourceEntityId:'copied', proof:{ kind:'semantic-value-definition', sourceSemanticValueId:'copied', machineType:bit32 } }),
      ssaDefinition({ id:'state-write', valueId:'state-v1', kind:'definition', blockId:'b0', variableKey:key, sourceEntityId:'write', at:0x100cn,
        proof:stateProof('renamed-definition',physical,'copied',bit32) }),
    ],
    uses:[
      ssaUse({ id:'read32-use', valueId:'state-v0', blockId:'b0', sourceEntityId:'read32', proof:stateProof('renamed-use',physical,'r32',bit32) }),
      ssaUse({ id:'read64-use', valueId:'state-v0', blockId:'b0', sourceEntityId:'read64', proof:stateProof('renamed-use',physical,'r64',bit64) }),
    ],
  };
  const out = projectSemanticIrV2ToLegacyV1(ir, { ssa });
  const read32 = out.instructions.find((inst) => inst.semanticNodeId === 'read32');
  const read64 = out.instructions.find((inst) => inst.semanticNodeId === 'read64');
  const write = out.instructions.find((inst) => inst.semanticNodeId === 'write');
  assert.equal(read32.op, OP.MOV);
  assert.equal(read64.op, OP.MOV);
  assert.equal(read32.dst.reg, 'generic-r0');
  assert.equal(read64.dst.reg, 'generic-r0');
  assert.equal(read32.dst.bits, 32);
  assert.equal(read64.dst.bits, 64);
  assert.equal(read32.args[0].value.reg, 'generic-r0');
  assert.equal(write.op, OP.MOV);
  assert.equal(write.dst.reg, 'generic-r0');
  assert.equal(write.dst.stateKey, key);
  assert.equal(write.args[0].value.semanticValueId, 'copied');
  assert.equal(write.origin.instructionIds[0], 'i:write');

  const conservative = projectSemanticIrV2ToLegacyV1(semanticFunction({
    blocks:[block('b0',['unknown-write'])], values:[entryValue('source',bit32)],
    nodes:[{ id:'unknown-write', kind:'state-write', blockId:'b0', inputs:['source'], outputs:[], variable:physical, origin:origin('unknown-write') }],
  }));
  assert.equal(conservative.instructions[0].op, OP.CLOBBER);
  assert.deepEqual(conservative.instructions[0].clobbers, ['generic-r0']);
}

// Constants, copies and generic insert-bits preserve the v1 value graph used by constant propagation.
{
  const low = defValue('low','const-low',bit64);
  const insert = defValue('insert-value','const-insert',bit16);
  const copied = defValue('copied','copy-low',bit64);
  const composed = defValue('composed','insert',bit64);
  const nodes = [
    { id:'const-low', kind:'const', blockId:'b0', inputs:[], outputs:['low'], attributes:{ value:'4660' }, origin:origin('const-low') },
    { id:'const-insert', kind:'const', blockId:'b0', inputs:[], outputs:['insert-value'], attributes:{ value:'43981' }, origin:origin('const-insert',0x1004n) },
    { id:'copy-low', kind:'copy', blockId:'b0', inputs:['low'], outputs:['copied'], operator:'copy', origin:origin('copy-low',0x1008n) },
    { id:'insert', kind:'insert', blockId:'b0', inputs:['copied','insert-value'], outputs:['composed'], operator:'insert-bits',
      attributes:{ machineEffects:{ operationMetadata:{ lsb:16, fieldWidth:16, widthBits:64 } } }, origin:origin('insert',0x100cn) },
  ];
  const out = projectSemanticIrV2ToLegacyV1(semanticFunction({ blocks:[block('b0',nodes.map((n)=>n.id))], values:[low,insert,copied,composed], nodes }));
  const c = out.instructions.find((inst) => inst.semanticNodeId === 'const-low');
  const copy = out.instructions.find((inst) => inst.semanticNodeId === 'copy-low');
  const bfi = out.instructions.find((inst) => inst.semanticNodeId === 'insert');
  assert.equal(c.op, OP.CONST);
  assert.equal(c.dst.const, 4660n);
  assert.equal(copy.op, OP.MOV);
  assert.equal(copy.args[0].value.const, 4660n);
  assert.equal(bfi.op, OP.BFI);
  assert.equal(bfi.extra.lsb, 16);
  assert.equal(bfi.extra.width, 16);
  assert.deepEqual(bfi.args.map((arg) => arg.value.semanticValueId), ['copied','insert-value']);
}

// Canonical CFG, diamond phi, loop phi, edge kinds and loop/backedge structure survive projection.
{
  const physical = variable('state:loop-var', 'generic-loop-state');
  const cond = entryValue('cond',bit1);
  const init = entryValue('init',bit32);
  const next = entryValue('next',bit32);
  const loopPhi = entryValue('loop-phi',bit32);
  const exitValue = entryValue('exit-value',bit32);
  const blocks = [
    block('entry',['to-header'],0x2000n),
    block('header',['loop-test'],0x2010n),
    block('body',['back'],0x2020n),
    block('exit',['ret'],0x2030n),
  ];
  const nodes = [
    { id:'to-header', kind:'branch', blockId:'entry', inputs:[], outputs:[], targets:['header'], origin:origin('to-header',0x2000n) },
    { id:'loop-test', kind:'conditional-branch', blockId:'header', inputs:['cond'], outputs:[], targets:['body','exit'], origin:origin('loop-test',0x2010n) },
    { id:'back', kind:'branch', blockId:'body', inputs:[], outputs:[], targets:['header'], origin:origin('back',0x2020n) },
    { id:'ret', kind:'return', blockId:'exit', inputs:['exit-value'], outputs:[], origin:origin('ret-loop',0x2030n) },
  ];
  const ir = semanticFunction({ blocks, values:[cond,init,next,loopPhi,exitValue], nodes, at:0x2000n });
  const semanticCfg = cfg('fn','entry',[
    { id:'entry', successors:[{ to:'header', kind:'branch', metadata:{ proof:'direct' } }] },
    { id:'header', successors:[{ to:'body', kind:'conditional-true' },{ to:'exit', kind:'conditional-false' }] },
    { id:'body', successors:[{ to:'header', kind:'branch', metadata:{ role:'backedge' } }] },
    { id:'exit', successors:[] },
  ]);
  const ssa = {
    contractVersion:'2.0.0', functionId:'fn',
    definitions:[
      ssaDefinition({ id:'cond-def', valueId:'cond', kind:'entry', variableKey:null, sourceEntityId:'fn' }),
      ssaDefinition({ id:'init-def', valueId:'init', kind:'entry', variableKey:'state:loop-var', sourceEntityId:'fn', proof:stateProof('entry-seed',physical,null,bit32) }),
      ssaDefinition({ id:'next-def', valueId:'next', kind:'definition', blockId:'body', variableKey:'state:loop-var', sourceEntityId:'next-source', proof:stateProof('renamed-definition',physical,'next',bit32) }),
      ssaDefinition({ id:'loop-phi-def', valueId:'loop-phi', kind:'phi', blockId:'header', variableKey:'state:loop-var', sourceEntityId:'header', at:0x2010n,
        incoming:[{ predecessorBlockId:'entry', valueId:'init' },{ predecessorBlockId:'body', valueId:'next' }], proof:stateProof('dominance-frontier',physical,null,bit32) }),
      ssaDefinition({ id:'exit-def', valueId:'exit-value', kind:'definition', blockId:'exit', sourceEntityId:'exit-value' }),
    ], uses:[],
  };
  const out = projectSemanticIrV2ToLegacyV1(ir, { cfg:semanticCfg, ssa });
  const header = out.blocks.find((b) => b.semanticBlockId === 'header');
  const body = out.blocks.find((b) => b.semanticBlockId === 'body');
  const exit = out.blocks.find((b) => b.semanticBlockId === 'exit');
  const phi = out.instructions.find((inst) => inst.op === OP.PHI && inst.semanticSsaValueId === 'loop-phi');
  assert.ok(phi);
  assert.equal(phi.dst.kind, VK.PHI);
  assert.equal(phi.reg, 'generic-loop-state');
  assert.deepEqual(phi.incoming.map((x) => x.from).sort((a,b)=>a-b), [out.entry,body.index].sort((a,b)=>a-b));
  assert.equal(phi.origin.instructionIds[0], 'i:ssa:loop-phi-def');
  assert.equal(out.compat.canonicalCfg, true);
  assert.equal(header.isLoopHeader, true);
  assert.ok(out.backEdges.some((edge) => edge.from === body.index && edge.to === header.index));
  assert.ok(out.loops.some((loop) => loop.header === header.index && loop.nodes.has(body.index)));
  assert.deepEqual(header.successorEdges.map((edge) => edge.kind), ['conditional-true','conditional-false']);
  assert.deepEqual(header.succ, [body.index,exit.index]);
  assert.ok(out.compat.controlEdges.some((edge) => edge.kind === 'conditional-true' && edge.semanticFrom === 'header'));
}

// Diamond phi keeps physical identity, predecessor identity, incoming value versions and OriginSet.
{
  const stateVar = variable('state:diamond', 'generic-diamond-state');
  const cond = entryValue('cond',bit1);
  const left = entryValue('left',bit32);
  const right = entryValue('right',bit32);
  const merged = entryValue('merged',bit32);
  const blocks = [block('entry',['cbr'],0x3000n),block('left-b',['lbr'],0x3010n),block('right-b',['rbr'],0x3020n),block('merge',['ret'],0x3030n)];
  const nodes = [
    { id:'cbr',kind:'conditional-branch',blockId:'entry',inputs:['cond'],outputs:[],targets:['left-b','right-b'],origin:origin('cbr',0x3000n) },
    { id:'lbr',kind:'branch',blockId:'left-b',inputs:[],outputs:[],targets:['merge'],origin:origin('lbr',0x3010n) },
    { id:'rbr',kind:'branch',blockId:'right-b',inputs:[],outputs:[],targets:['merge'],origin:origin('rbr',0x3020n) },
    { id:'ret',kind:'return',blockId:'merge',inputs:['merged'],outputs:[],origin:origin('ret-diamond',0x3030n) },
  ];
  const semanticCfg = cfg('fn','entry',[
    { id:'entry',successors:[{to:'left-b',kind:'conditional-true'},{to:'right-b',kind:'conditional-false'}] },
    { id:'left-b',successors:[{to:'merge',kind:'branch'}] },
    { id:'right-b',successors:[{to:'merge',kind:'branch'}] },
    { id:'merge',successors:[] },
  ]);
  const ssa = { contractVersion:'2.0.0', functionId:'fn', definitions:[
    ssaDefinition({id:'cond-d',valueId:'cond',kind:'entry',sourceEntityId:'fn'}),
    ssaDefinition({id:'left-d',valueId:'left',kind:'definition',blockId:'left-b',variableKey:'state:diamond',sourceEntityId:'left-source',proof:stateProof('renamed-definition',stateVar,'left',bit32)}),
    ssaDefinition({id:'right-d',valueId:'right',kind:'definition',blockId:'right-b',variableKey:'state:diamond',sourceEntityId:'right-source',proof:stateProof('renamed-definition',stateVar,'right',bit32)}),
    ssaDefinition({id:'merge-d',valueId:'merged',kind:'phi',blockId:'merge',variableKey:'state:diamond',sourceEntityId:'merge',at:0x3030n,
      incoming:[{predecessorBlockId:'left-b',valueId:'left'},{predecessorBlockId:'right-b',valueId:'right'}],proof:stateProof('dominance-frontier',stateVar,null,bit32)}),
  ], uses:[] };
  const out = projectSemanticIrV2ToLegacyV1(semanticFunction({blocks,values:[cond,left,right,merged],nodes,at:0x3000n}),{cfg:semanticCfg,ssa});
  const phi = out.instructions.find((inst)=>inst.op===OP.PHI);
  assert.equal(phi.reg,'generic-diamond-state');
  assert.deepEqual(phi.incoming.map((x)=>x.semanticPredecessorBlockId).sort(),['left-b','right-b']);
  assert.deepEqual(phi.incoming.map((x)=>x.value.semanticSsaValueId).sort(),['left','right']);
  assert.equal(phi.origin.instructionIds[0],'i:ssa:merge-d');
}

function comparisonCase({ signed, predicate, expectedCond, id }) {
  const a = entryValue(`${id}-a`,bit32);
  const b = entryValue(`${id}-b`,bit32);
  const pred = defValue(`${id}-pred`,`${id}-cmp`,bit1);
  const selected = defValue(`${id}-selv`,`${id}-sel`,bit32);
  const nodes = [
    { id:`${id}-cmp`,kind:'compare',blockId:'entry',inputs:[a.id,b.id],outputs:[pred.id],operator:'icmp',attributes:{predicate,signed},origin:origin(`${id}-cmp`,0x4000n) },
    { id:`${id}-sel`,kind:'select',blockId:'entry',inputs:[pred.id,a.id,b.id],outputs:[selected.id],operator:'select',origin:origin(`${id}-sel`,0x4004n) },
    { id:`${id}-cbr`,kind:'conditional-branch',blockId:'entry',inputs:[pred.id],outputs:[],targets:['yes','no'],origin:origin(`${id}-cbr`,0x4008n) },
  ];
  const blocks = [block('entry',nodes.map((n)=>n.id),0x4000n),block('yes',[],0x4010n),block('no',[],0x4020n)];
  const out = projectSemanticIrV2ToLegacyV1(semanticFunction({id,blocks,values:[a,b,pred,selected],nodes,at:0x4000n}));
  const cmp = out.instructions.find((inst)=>inst.semanticNodeId===`${id}-cmp`);
  const sel = out.instructions.find((inst)=>inst.semanticNodeId===`${id}-sel`);
  const branch = out.instructions.find((inst)=>inst.semanticNodeId===`${id}-cbr`);
  assert.equal(cmp.op,OP.CMP);
  assert.equal(cmp.extra.signed,signed);
  assert.equal(sel.op,OP.SEL);
  assert.equal(sel.args.length,3);
  assert.equal(sel.args[2].value,cmp.dst);
  assert.equal(sel.cond,expectedCond);
  assert.equal(branch.cond,expectedCond);
  assert.equal(branch.args[0].value,cmp.dst);
  return out;
}
comparisonCase({signed:true,predicate:'<',expectedCond:'lt',id:'signed-compare'});
comparisonCase({signed:false,predicate:'<',expectedCond:'lo',id:'unsigned-compare'});

// Generic value == 0 / != 0 conditions serialize to existing v1 CBZ/CBNZ condition shape without mnemonic data.
for (const nonzero of [false,true]) {
  const id = nonzero ? 'zero-ne' : 'zero-eq';
  const value = entryValue(`${id}-value`,bit64);
  const zero = defValue(`${id}-zero`,`${id}-iszero`,bit1);
  const nodes = [
    { id:`${id}-iszero`,kind:'intrinsic',blockId:'entry',inputs:[value.id],outputs:[zero.id],operator:'is-zero',intrinsic:exactIntrinsic([value.id],[zero.id]),origin:origin(`${id}-iszero`) },
  ];
  let conditionId = zero.id;
  const values = [value,zero];
  if (nonzero) {
    const inverted = defValue(`${id}-not`,`${id}-not-node`,bit1);
    nodes.push({ id:`${id}-not-node`,kind:'intrinsic',blockId:'entry',inputs:[zero.id],outputs:[inverted.id],operator:'not-bool',intrinsic:exactIntrinsic([zero.id],[inverted.id]),origin:origin(`${id}-not`,0x1004n) });
    values.push(inverted);
    conditionId = inverted.id;
  }
  nodes.push({ id:`${id}-branch`,kind:'conditional-branch',blockId:'entry',inputs:[conditionId],outputs:[],targets:['yes','no'],origin:origin(`${id}-branch`,0x1008n) });
  const blocks = [block('entry',nodes.map((n)=>n.id)),block('yes',[]),block('no',[])];
  const out = projectSemanticIrV2ToLegacyV1(semanticFunction({id,blocks,values,nodes}));
  const branch = out.instructions.find((inst)=>inst.semanticNodeId===`${id}-branch`);
  assert.equal(branch.extra.kind,nonzero?'cbnz':'cbz');
  assert.equal(branch.args[0].value.semanticValueId,value.id);
  assert.equal(branch.cond,null);
}

function addressFixture({ id, indexKind = 'none', unknownIndex = false }) {
  const baseVar = variable(`${id}:base-key`,`${id}:base`);
  const indexVar = variable(`${id}:index-key`,`${id}:index`);
  const base = defValue(`${id}:base-v`,`${id}:base-read`,bit64,baseVar.key);
  const index = unknownIndex ? unknownValue(`${id}:unknown-index`,bit32) : defValue(`${id}:index-v`,`${id}:index-read`,bit32,indexVar.key);
  const disp = defValue(`${id}:disp`,`${id}:disp-node`,bit64);
  const values = [base,index,disp];
  const nodes = [
    { id:`${id}:base-read`,kind:'state-read',blockId:'b0',inputs:[],outputs:[base.id],variable:baseVar,origin:origin(`${id}:base-read`) },
    ...(!unknownIndex ? [{ id:`${id}:index-read`,kind:'state-read',blockId:'b0',inputs:[],outputs:[index.id],variable:indexVar,origin:origin(`${id}:index-read`,0x1004n) }] : []),
    { id:`${id}:disp-node`,kind:'const',blockId:'b0',inputs:[],outputs:[disp.id],attributes:{value:'32'},origin:origin(`${id}:disp`,0x1008n) },
  ];
  let addressRight = disp.id;
  if (indexKind !== 'none' || unknownIndex) {
    addressRight = index.id;
    if (indexKind === 'sxtw-shift') {
      const extended = defValue(`${id}:extended`,`${id}:sext`,bit64);
      const shift = defValue(`${id}:shift`,`${id}:shift-const`,bit64);
      const shifted = defValue(`${id}:shifted`,`${id}:shl`,bit64);
      values.push(extended,shift,shifted);
      nodes.push(
        { id:`${id}:sext`,kind:'sext',blockId:'b0',inputs:[index.id],outputs:[extended.id],operator:'sign-extend',attributes:{fromBits:32,toBits:64},origin:origin(`${id}:sext`,0x100cn) },
        { id:`${id}:shift-const`,kind:'const',blockId:'b0',inputs:[],outputs:[shift.id],attributes:{value:'2'},origin:origin(`${id}:shift-const`,0x1010n) },
        { id:`${id}:shl`,kind:'binary',blockId:'b0',inputs:[extended.id,shift.id],outputs:[shifted.id],operator:'shl',origin:origin(`${id}:shl`,0x1014n) },
      );
      addressRight = shifted.id;
    }
  }
  const addr = defValue(`${id}:addr`,`${id}:address`,addr64);
  const loaded = defValue(`${id}:loaded`,`${id}:load`,bit32);
  values.push(addr,loaded);
  nodes.push(
    { id:`${id}:address`,kind:'address',blockId:'b0',inputs:[base.id,addressRight],outputs:[addr.id],operator:'add',origin:origin(`${id}:address`,0x1018n) },
    { id:`${id}:load`,kind:'load',blockId:'b0',inputs:[addr.id],outputs:[loaded.id],memory:memory(addr.id,32),origin:origin(`${id}:load`,0x101cn) },
  );
  const ir = semanticFunction({id,blocks:[block('b0',nodes.map((n)=>n.id))],values,nodes});
  return projectSemanticIrV2ToLegacyV1(ir).instructions.find((inst)=>inst.semanticNodeId===`${id}:load`);
}

// Base + constant displacement.
{
  const load = addressFixture({id:'addr-disp'});
  assert.equal(load.addr.baseReg,'addr-disp:base');
  assert.equal(load.addr.disp,32n);
  assert.equal(load.addr.index,null);
  assert.equal(load.addr.precise,true);
  assert.ok(load.addr.origin.instructionIds.length > 0);
}
// Base + exact index.
{
  const load = addressFixture({id:'addr-index',indexKind:'index'});
  assert.equal(load.addr.baseReg,'addr-index:base');
  assert.equal(load.addr.index.reg,'addr-index:index');
  assert.equal(load.addr.scale,0);
  assert.equal(load.addr.extend,null);
  assert.equal(load.addr.precise,true);
}
// Exact sign-extend 32 -> 64 plus shift-left 2 serializes as legacy sxtw + scale 2.
{
  const load = addressFixture({id:'addr-extended',indexKind:'sxtw-shift'});
  assert.equal(load.addr.baseReg,'addr-extended:base');
  assert.equal(load.addr.index.reg,'addr-extended:index');
  assert.equal(load.addr.extend,'sxtw');
  assert.equal(load.addr.scale,2);
  assert.equal(load.addr.indexSignedness,'signed');
  assert.equal(load.addr.indexWidthBits,32);
  assert.equal(load.addr.addressWidthBits,64);
  assert.equal(load.addr.precise,true);
}
// Unsupported/unknown index does not manufacture a precise indexed address.
{
  const load = addressFixture({id:'addr-unknown',unknownIndex:true,indexKind:'index'});
  assert.equal(load.addr.precise,false);
  assert.equal(load.addr.index,null);
  assert.equal(load.addr.disp,null);
  assert.equal(load.addr.extend,null);
  assert.equal(load.addr.unknownReason,'semantic-address-expression-not-proven');
}

// Projection is deterministic for the same Semantic IR + canonical CFG inputs.
{
  const a = entryValue('det-a',bit32);
  const c = defValue('det-c','det-const',bit32);
  const sum = defValue('det-sum','det-add',bit32);
  const nodes = [
    {id:'det-const',kind:'const',blockId:'b0',inputs:[],outputs:['det-c'],attributes:{value:'7'},origin:origin('det-const')},
    {id:'det-add',kind:'binary',blockId:'b0',inputs:['det-a','det-c'],outputs:['det-sum'],operator:'add',origin:origin('det-add',0x1004n)},
  ];
  const ir = semanticFunction({id:'deterministic',blocks:[block('b0',nodes.map((n)=>n.id))],values:[a,c,sum],nodes});
  const aOut = projectSemanticIrV2ToLegacyV1(ir);
  const bOut = projectSemanticIrV2ToLegacyV1(ir);
  assert.deepEqual(projectionSnapshot(aOut),projectionSnapshot(bOut));
}

console.log('semantic-v2 v1 projection fidelity repair: PASS');
