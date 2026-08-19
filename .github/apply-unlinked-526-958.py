from pathlib import Path

# AAPCS64: unknown stack arguments may contain pointers; variadic tails preserve
# the remaining GP/SIMD frontier as possible (not proven) physical inputs.
aapcs = Path('js/targets/abi/aapcs64.js')
text = aapcs.read_text()
old = "return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:true, stackArgsMayContainPointers:false, evidence:'conservative-aapcs64' };"
new = "return { srcs, arguments:arguments_, stackArguments, possibleArguments:[], stackArgsUnknown:true, stackArgsMayContainPointers:true, evidence:'conservative-aapcs64' };"
if text.count(old) != 1:
    raise SystemExit(f'#526 unknown AAPCS64 stack anchor expected once, found {text.count(old)}')
text = text.replace(old, new, 1)
old = """  return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:proto?.variadic===true||proto?.varargs===true, stackArgsMayContainPointers, evidence:'prototype-aapcs64' };\n}\n"""
new = """  const variadic = proto?.variadic===true || proto?.varargs===true;\n  const possibleArguments = [];\n  if (variadic) {\n    for (let i=gp;i<8;i++) {\n      const reg=`x${i}`;\n      const entry={index:`vararg-gp:${i}`,location:'register',reg,abiClass:'possible-vararg-gp',bits:64,possible:true,mayContainPointers:true};\n      possibleArguments.push(entry);\n      srcs.push({t:'reg',reg,bits:64,purpose:'possible-variadic-argument',possible:true,mayContainPointers:true});\n    }\n    for (let i=fp;i<8;i++) {\n      const reg=`v${i}`;\n      const entry={index:`vararg-fp:${i}`,location:'register',reg,abiClass:'possible-vararg-fp-vector',bits:128,possible:true,mayContainPointers:true};\n      possibleArguments.push(entry);\n      srcs.push({t:'reg',reg,bits:128,purpose:'possible-variadic-argument',possible:true,mayContainPointers:true});\n    }\n    stackArgsMayContainPointers = true;\n  }\n  return { srcs, arguments:arguments_, possibleArguments, stackArguments, stackArgsUnknown:variadic, stackArgsMayContainPointers, evidence:variadic?'prototype-aapcs64-variadic-frontier':'prototype-aapcs64' };\n}\n"""
if text.count(old) != 1:
    raise SystemExit(f'#958 AAPCS64 return anchor expected once, found {text.count(old)}')
text = text.replace(old, new, 1)
text = text.replace("id:'aapcs64', semanticVersion:'1', architectureId:'arm64',", "id:'aapcs64', semanticVersion:'2', architectureId:'arm64',", 1)
aapcs.write_text(text)

# Preserve the ABI classifier's complete physical input set through the semantic
# adapter instead of throwing away srcs before the canonical IR/SSA boundary.
semantic = Path('js/analysis/semantic-function.js')
text = semantic.read_text()
old = """      const implicitInputs = Array.isArray(classified.implicitInputs)\n        ? classified.implicitInputs.map((input, index) => Object.freeze({\n          ...input,\n          index:`implicit:${index}`,\n          location:input.location ?? 'register',\n          abiClass:input.abiClass ?? 'abi-implicit-input',\n          implicit:true,\n          variadicVectorRegisterCount:classified.variadicVectorRegisterCount ?? null,\n          countKnown:Number.isSafeInteger(classified.variadicVectorRegisterCount),\n        }))\n        : [];\n      return {\n"""
new = """      const implicitInputs = Array.isArray(classified.implicitInputs)\n        ? classified.implicitInputs.map((input, index) => Object.freeze({\n          ...input,\n          index:`implicit:${index}`,\n          location:input.location ?? 'register',\n          abiClass:input.abiClass ?? 'abi-implicit-input',\n          implicit:true,\n          variadicVectorRegisterCount:classified.variadicVectorRegisterCount ?? null,\n          countKnown:Number.isSafeInteger(classified.variadicVectorRegisterCount),\n        }))\n        : [];\n      const possibleArguments = Array.isArray(classified.possibleArguments) ? classified.possibleArguments : [];\n      const physicalInputs = [];\n      const physicalSeen = new Set();\n      for (const source of [...(classified.srcs ?? []), ...implicitInputs]) {\n        const registers = Array.isArray(source?.regs) ? source.regs : source?.reg != null ? [source.reg] : [];\n        for (const rawRegister of registers) {\n          const reg = String(rawRegister || '');\n          if (!reg) continue;\n          const bits = Number(source?.bits ?? 0) || null;\n          const possible = source?.possible === true;\n          const key = `${reg}:${bits ?? ''}:${possible ? 'possible' : 'proven'}`;\n          if (physicalSeen.has(key)) continue;\n          physicalSeen.add(key);\n          physicalInputs.push(Object.freeze({\n            reg, bits, possible,\n            purpose:source?.purpose ?? source?.abiClass ?? (source?.implicit ? 'abi-implicit-input' : 'abi-argument'),\n            ...(source?.view == null ? {} : { view:source.view }),\n            mayContainPointers:source?.mayContainPointers === true,\n          }));\n        }\n      }\n      return {\n"""
if text.count(old) != 1:
    raise SystemExit(f'#526 semantic adapter input anchor expected once, found {text.count(old)}')
text = text.replace(old, new, 1)
old = """        explicitArguments,\n        implicitInputs,\n        variadicVectorRegisterCount:classified.variadicVectorRegisterCount ?? null,\n"""
new = """        explicitArguments,\n        implicitInputs,\n        possibleArguments,\n        physicalInputs:Object.freeze(physicalInputs),\n        variadicVectorRegisterCount:classified.variadicVectorRegisterCount ?? null,\n"""
if text.count(old) != 1:
    raise SystemExit(f'#526 semantic adapter return anchor expected once, found {text.count(old)}')
semantic.write_text(text.replace(old, new, 1))

# Canonical enrichment MUST happen before scalar SSA and MemorySSA. Materialize
# ABI physical reads as ordinary state-read nodes and make every proven/possible
# physical input a canonical CALL node input. Only proven inputs are promoted to
# call.arguments; possible vararg frontier values remain conservative SSA uses
# with explicit certainty metadata.
compat = Path('js/semantics/compat/index.js')
text = compat.read_text()
text = text.replace("  stableStringify,\n} from '../../core/identity/index.js';", "  stableStringify,\n  stableDigest,\n} from '../../core/identity/index.js';", 1)
text = text.replace("  createSemanticIrFunction,\n  lowerMachineEffectBundleToSemanticIr,", "  createSemanticIrFunction,\n  lowerMachineEffectBundleToSemanticIr,", 1)
text = text.replace("import { projectSemanticIrV2ToLegacyV1 } from './semantic-ir-v2-to-v1.js';", "import { projectSemanticIrV2ToLegacyV1 } from './semantic-ir-v2-to-v1.js';\nimport { createPhysicalStateVariable } from '../ir/normalize-effects.js';", 1)
text = text.replace("export const SEMANTIC_V2_COMPAT_PIPELINE_VERSION = '1.1.0';", "export const SEMANTIC_V2_COMPAT_PIPELINE_VERSION = '1.2.0';", 1)
text = text.replace("  'semantic-ir-v2',\n  'scalar-ssa',", "  'semantic-ir-v2',\n  'abi-call-enrichment',\n  'scalar-ssa',", 1)
anchor = """function architectureRegisterDescriptors(architecturePlugin) {\n  if (typeof architecturePlugin.registerFile !== 'function') return [];\n  let descriptors;\n  try { descriptors = architecturePlugin.registerFile(); }\n  catch { return []; }\n  return Array.isArray(descriptors) ? descriptors : [];\n}\n\n"""
helper = r'''function architectureRegisterDescriptors(architecturePlugin) {
  if (typeof architecturePlugin.registerFile !== 'function') return [];
  let descriptors;
  try { descriptors = architecturePlugin.registerFile(); }
  catch { return []; }
  return Array.isArray(descriptors) ? descriptors : [];
}

function enrichAbiCallInputsBeforeSsa({ nodes, values, blocks, abiAdapter, architecturePlugin }) {
  if (!abiAdapter || typeof abiAdapter.classifyCall !== 'function') return { callCount:0, physicalInputCount:0, possibleInputCount:0 };
  const registerWidths = new Map(architectureRegisterDescriptors(architecturePlugin)
    .filter((entry) => entry?.id != null)
    .map((entry) => [String(entry.id), Number(entry.bits ?? 0) || null]));
  let callCount = 0, physicalInputCount = 0, possibleInputCount = 0;

  for (const original of [...nodes.values()]) {
    if (original?.kind !== 'call' || !original.call) continue;
    let classified;
    try { classified = abiAdapter.classifyCall({ call:original.call }); }
    catch { classified = null; }
    const descriptors = Array.isArray(classified?.physicalInputs) ? classified.physicalInputs : [];
    if (!descriptors.length) continue;
    const block = blocks.get(original.blockId);
    if (!block) continue;

    callCount++;
    const readIds = [];
    const inputIds = [];
    const provenArgumentIds = [];
    const stateReads = [...(original.call.stateReads ?? [])];
    const seenVariables = new Set(stateReads.map((variable) => variable.key));
    const detail = [];

    for (let ordinal = 0; ordinal < descriptors.length; ordinal++) {
      const descriptor = descriptors[ordinal] ?? {};
      const reg = String(descriptor.reg ?? '');
      if (!reg) continue;
      const widthBits = Number(descriptor.bits ?? registerWidths.get(reg) ?? 0) || null;
      if (!Number.isSafeInteger(widthBits) || widthBits <= 0) continue;
      const possible = descriptor.possible === true;
      const variableBase = createPhysicalStateVariable({ kind:'register', registerId:reg, widthBits });
      const variable = {
        ...variableBase,
        metadata:{
          abiCallInput:true,
          certainty:possible ? 'possible' : 'proven',
          purpose:String(descriptor.purpose ?? 'abi-argument'),
          ...(descriptor.view == null ? {} : { view:String(descriptor.view) }),
        },
      };
      const token = stableDigest({ callNodeId:original.id, reg, widthBits, possible, ordinal });
      const readNodeId = `semantic_node_abi_call_read_${token}`;
      const valueId = `semantic_value_abi_call_read_${token}`;
      const origin = original.origin;
      if (!nodes.has(readNodeId)) {
        nodes.set(readNodeId, {
          id:readNodeId,
          kind:'state-read',
          blockId:original.blockId,
          inputs:[],
          outputs:[valueId],
          variable,
          attributes:{ abiCallInput:true, certainty:possible ? 'possible' : 'proven', purpose:String(descriptor.purpose ?? 'abi-argument') },
          sourceEffectIds:original.sourceEffectIds ?? [],
          origin,
        });
        values.set(valueId, {
          id:valueId,
          kind:'definition',
          machineType:{ kind:'bitvector', widthBits },
          definitionNodeId:readNodeId,
          sourceEntityId:original.id,
          variableKey:variable.key,
          origin,
          metadata:{ abiCallInput:true, certainty:possible ? 'possible' : 'proven', registerId:reg },
        });
      }
      readIds.push(readNodeId);
      inputIds.push(valueId);
      if (!possible) provenArgumentIds.push(valueId);
      if (!seenVariables.has(variable.key)) { stateReads.push(variable); seenVariables.add(variable.key); }
      detail.push({ reg, widthBits, certainty:possible ? 'possible' : 'proven', purpose:String(descriptor.purpose ?? 'abi-argument') });
      physicalInputCount++;
      if (possible) possibleInputCount++;
    }
    if (!inputIds.length) continue;

    const call = {
      ...original.call,
      arguments:[...new Set([...(original.call.arguments ?? []), ...provenArgumentIds])],
      stateReads,
    };
    nodes.set(original.id, {
      ...original,
      inputs:[...new Set([...(original.inputs ?? []), ...inputIds])],
      call,
      attributes:{
        ...(original.attributes ?? {}),
        abiCallInputs:{
          evidence:classified?.argumentEvidence ?? null,
          stackArguments:classified?.stackArguments ?? null,
          stackArgsUnknown:classified?.stackArgsUnknown ?? true,
          stackArgsMayContainPointers:classified?.stackArgsMayContainPointers ?? true,
          physicalInputs:detail,
        },
      },
    });
    const callIndex = block.nodeIds.indexOf(original.id);
    if (callIndex >= 0) block.nodeIds.splice(callIndex, 0, ...readIds.filter((id) => !block.nodeIds.includes(id)));
  }
  return { callCount, physicalInputCount, possibleInputCount };
}

'''
if text.count(anchor) != 1:
    raise SystemExit(f'#526 compat helper anchor expected once, found {text.count(anchor)}')
text = text.replace(anchor, helper, 1)
old = """  if (!bundles.length) fail('semantic-v2-integration-function-has-no-instructions');\n  const functionOrigin = mergeOriginSets(...bundles.map((bundle) => bundle.origin));\n"""
new = """  if (!bundles.length) fail('semantic-v2-integration-function-has-no-instructions');\n  const abiEnrichment = enrichAbiCallInputsBeforeSsa({\n    nodes, values, blocks,\n    abiAdapter:input.abiAdapter ?? options.abiAdapter ?? options.compatOptions?.abiAdapter,\n    architecturePlugin,\n  });\n  const functionOrigin = mergeOriginSets(...bundles.map((bundle) => bundle.origin));\n"""
if text.count(old) != 1:
    raise SystemExit(f'#526 pre-SSA enrichment anchor expected once, found {text.count(old)}')
text = text.replace(old, new, 1)
old = """      provenanceLossCount: 0,\n      instructions: instructionTelemetry,\n"""
new = """      provenanceLossCount: 0,\n      abiCallEnrichment:abiEnrichment,\n      instructions: instructionTelemetry,\n"""
if text.count(old) != 1:
    raise SystemExit(f'#526 instrumentation anchor expected once, found {text.count(old)}')
compat.write_text(text.replace(old, new, 1))

# v1 compatibility must not collapse a multi-register ABI argument to its
# convenience `reg` field before considering the authoritative `regs` set.
v1 = Path('js/semantics/compat/semantic-ir-v2-to-v1.js')
text = v1.read_text()
old = """function abiRegisterDescriptors(argument) {\n  if (!argument || typeof argument !== 'object') return [];\n  if (argument.reg != null) return [{ reg: String(argument.reg), bits: Number(argument.bits ?? 0) || null }];\n  if (!Array.isArray(argument.regs)) return [];\n  return argument.regs.filter(Boolean).map((reg) => ({ reg: String(reg), bits: Number(argument.bits ?? 0) || null }));\n}\n"""
new = """function abiRegisterDescriptors(argument) {\n  if (!argument || typeof argument !== 'object') return [];\n  if (Array.isArray(argument.regs) && argument.regs.length) {\n    return argument.regs.filter(Boolean).map((reg) => ({ reg: String(reg), bits: Number(argument.bits ?? 0) || null }));\n  }\n  if (argument.reg != null) return [{ reg: String(argument.reg), bits: Number(argument.bits ?? 0) || null }];\n  return [];\n}\n"""
if text.count(old) != 1:
    raise SystemExit(f'#526 HFA descriptor anchor expected once, found {text.count(old)}')
v1.write_text(text.replace(old, new, 1))

# Focused regression: AAPCS64 frontier + canonical pre-SSA physical inputs.
test = Path('tests/semantic-v2/issues-526-958-call-inputs.test.mjs')
test.write_text(r'''import assert from 'node:assert/strict';
import { createOriginSet } from '../../js/core/identity/origin.js';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { classifyAAPCS64Arguments } from '../../js/targets/abi/aapcs64.js';

const unknown = classifyAAPCS64Arguments({}, {});
assert.equal(unknown.stackArgsUnknown, true);
assert.equal(unknown.stackArgsMayContainPointers, true, 'unknown stack args must conservatively allow pointers');

const variadic = classifyAAPCS64Arguments({ callPrototype:{ args:[{ type:'const char *', pointer:true }], variadic:true } });
assert.equal(variadic.arguments[0].reg, 'x0');
assert.ok(variadic.possibleArguments.some((entry) => entry.reg === 'x1' && entry.possible === true));
assert.ok(variadic.possibleArguments.some((entry) => entry.reg === 'v0' && entry.possible === true));
assert.ok(!variadic.possibleArguments.some((entry) => entry.reg === 'x0'));
assert.equal(variadic.stackArgsUnknown, true);
assert.equal(variadic.stackArgsMayContainPointers, true);

const hfa = classifyAAPCS64Arguments({ callPrototype:{ args:[{ type:'double', hfa:true, members:2, bits:64 }] } });
assert.deepEqual(hfa.arguments[0].regs, ['v0','v1']);
assert.ok(hfa.srcs.some((source) => source.reg === 'v0'));
assert.ok(hfa.srcs.some((source) => source.reg === 'v1'));

const origin = createOriginSet({ instructionIds:['issue-526-call'] });
const architecturePlugin = {
  id:'test64', semanticVersion:'1', fixedInstructionSize:4,
  registerFile:() => [
    ...Array.from({length:8},(_,i)=>({id:`x${i}`,bits:64,kind:'general'})),
    ...Array.from({length:8},(_,i)=>({id:`v${i}`,bits:128,kind:'vector'})),
  ],
  liftExact(decoded, context) {
    return createMachineEffectBundle({
      instructionId:context.instructionId,
      architectureId:'test64', mode:context.mode,
      operations:[],
      controlEffect:{ kind:'call', target:{ kind:'absolute-address', value:'8192', widthBits:64 }, fallthrough:{ kind:'absolute-address', value:'4100', widthBits:64 } },
      possibleFaults:[], origin:context.origin, completeness:'exact',
    });
  },
};
const abiAdapter = {
  classifyCall() {
    return {
      physicalInputs:[
        {reg:'v0',bits:128,possible:false,purpose:'hfa-piece'},
        {reg:'v1',bits:128,possible:false,purpose:'hfa-piece'},
        {reg:'x1',bits:64,possible:true,purpose:'possible-variadic-argument',mayContainPointers:true},
      ],
      stackArguments:[], stackArgsUnknown:true, stackArgsMayContainPointers:true,
      argumentEvidence:'issue-526-fixture',
    };
  },
};
const pipeline = buildSemanticV2CompatibilityPipeline({
  architecturePlugin, decoderSemanticVersion:'1', binaryId:'issue-526-bin', sliceId:'issue-526-slice',
  addressWidthBits:64, mode:'test', abiAdapter,
  blocks:[{ key:'entry', startAddress:4096n, instructions:[{ address:4096n, size:4, decoded:{ mnemonic:'call' }, origin }], successors:[] }],
}, { abiAdapter });
const call = pipeline.semanticIr.nodes.find((node) => node.kind === 'call');
assert.ok(call);
const physicalReads = pipeline.semanticIr.nodes.filter((node) => node.kind === 'state-read' && node.attributes?.abiCallInput === true);
assert.deepEqual(physicalReads.map((node) => node.variable.physicalIdentity.registerId).sort(), ['v0','v1','x1']);
assert.ok(call.inputs.length >= 3, 'all ABI physical inputs must be in canonical CALL SSA use-set');
const v0 = physicalReads.find((node) => node.variable.physicalIdentity.registerId === 'v0').outputs[0];
const v1 = physicalReads.find((node) => node.variable.physicalIdentity.registerId === 'v1').outputs[0];
const x1 = physicalReads.find((node) => node.variable.physicalIdentity.registerId === 'x1').outputs[0];
assert.ok(call.inputs.includes(v0) && call.inputs.includes(v1) && call.inputs.includes(x1));
assert.ok(call.call.arguments.includes(v0) && call.call.arguments.includes(v1), 'proven HFA pieces must remain call arguments');
assert.ok(!call.call.arguments.includes(x1), 'possible vararg frontier must not be promoted to proven argument');
assert.equal(physicalReads.find((node) => node.variable.physicalIdentity.registerId === 'x1').attributes.certainty, 'possible');
assert.equal(pipeline.instrumentation.abiCallEnrichment.physicalInputCount, 3);
assert.equal(pipeline.instrumentation.abiCallEnrichment.possibleInputCount, 1);

console.log('issues #526/#958 ABI call input + variadic frontier regressions: PASS');
''')
