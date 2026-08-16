import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { irFor, readModifyWrite, setSemanticMigrationMode, MK } from '../../js/ir.js';
import { buildSemanticV2CompatibilityPipeline, SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';

const BASE = 0x100000000n;
const lines = [
  'adr x19, #0x100001000',
  'ldr w8, [x19, #0x20]',
  'add w8, w8, #1',
  'str w8, [x19, #0x20]',
  'ret',
];
const rows = lines.map((line, row) => {
  const split = line.indexOf(' ');
  return { row, address:BASE + BigInt(row * 4), mn:split < 0 ? line : line.slice(0, split), ops:split < 0 ? '' : line.slice(split + 1) };
});
const rowOfAddress = (address) => {
  const delta = BigInt(address) - BASE;
  return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
};
const model = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });

function directPipeline() {
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin:ARM64_ARCHITECTURE,
    decoderSemanticVersion:'global-rmw-proof-diagnostic',
    binaryId:'global-rmw-proof-binary',
    sliceId:'global-rmw-proof-slice',
    addressWidthBits:64,
    canonicalStartIdentity:{ address:BASE },
    entryBlockKey:'entry',
    blocks:[{
      key:'entry', startAddress:BASE, successors:[],
      instructions:model.instructions.map((decoded) => ({ decoded, address:decoded.address, size:4, mode:'a64' })),
    }],
  });
}

function semanticValueTree(pipeline, valueId, depth = 0, active = new Set()) {
  if (valueId == null || depth > 8 || active.has(String(valueId))) return { valueId, cycleOrDepth:true };
  const id = String(valueId);
  const value = pipeline.semanticIr.values.find((candidate) => String(candidate.id) === id) ?? null;
  if (!value) return { valueId:id, missing:true };
  const node = value.definitionNodeId == null ? null : pipeline.semanticIr.nodes.find((candidate) => String(candidate.id) === String(value.definitionNodeId)) ?? null;
  const next = new Set(active).add(id);
  return {
    valueId:id,
    valueKind:value.kind,
    machineType:value.machineType,
    variableKey:value.variableKey ?? null,
    metadata:value.metadata ?? null,
    node:node == null ? null : {
      id:node.id,
      kind:node.kind,
      operator:node.operator ?? null,
      variable:node.variable ?? null,
      attributes:node.attributes ?? null,
      inputs:(node.inputs ?? []).map((input) => semanticValueTree(pipeline, input, depth + 1, next)),
    },
  };
}

try {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  const ir = irFor(model, { rowOfAddress, decoderSemanticVersion:'global-rmw-explicit-v2' });
  assert.ok(ir, 'explicit v2 route must build absolute global fixture');
  const rmw = readModifyWrite(ir).find((candidate) => candidate.location?.kind === MK.GLOBAL) ?? null;
  if (!rmw) {
    const pipeline = directPipeline();
    const x19Reads = pipeline.semanticIr.nodes.filter((node) => node.kind === 'state-read' && node.variable?.physicalIdentity?.registerId === 'x19');
    const x19Writes = pipeline.semanticIr.nodes.filter((node) => node.kind === 'state-write' && node.variable?.physicalIdentity?.registerId === 'x19');
    const relevantIds = new Set([...x19Reads, ...x19Writes].map((node) => node.id));
    const memoryNodes = pipeline.semanticIr.nodes.filter((node) => node.kind === 'load' || node.kind === 'store');
    console.log('V2_GLOBAL_RMW_DIAG ' + JSON.stringify({
      regions:pipeline.regions.map((region) => ({ id:region.id, kind:region.kind, address:region.address ?? null, offset:region.offset ?? null, rootEntityId:region.rootEntityId ?? null, metadata:region.metadata ?? null })),
      memoryAddressTrees:memoryNodes.map((node) => ({ nodeId:node.id, kind:node.kind, addressValueId:node.memory?.addressExpr?.valueId ?? node.memory?.addressValueId ?? null, tree:semanticValueTree(pipeline, node.memory?.addressExpr?.valueId ?? node.memory?.addressValueId ?? null) })),
      x19Reads:x19Reads.map((node) => ({ id:node.id, outputs:node.outputs, variableKey:node.variable?.key })),
      x19Writes:x19Writes.map((node) => ({ id:node.id, inputs:node.inputs, variableKey:node.variable?.key })),
      x19SsaUses:pipeline.ssa.uses.filter((use) => relevantIds.has(use.sourceEntityId)).map((use) => ({ sourceEntityId:use.sourceEntityId, valueId:use.valueId, proof:use.proof })),
      x19SsaDefs:pipeline.ssa.definitions.filter((definition) => definition.proof?.variableIdentity?.physicalIdentity?.registerId === 'x19').map((definition) => ({ valueId:definition.valueId, kind:definition.kind, sourceEntityId:definition.sourceEntityId, sourceSemanticValueId:definition.proof?.sourceSemanticValueId ?? null, variableKey:definition.variableKey })),
      constants:pipeline.semanticIr.nodes.filter((node) => node.kind === 'const').map((node) => ({ id:node.id, outputs:node.outputs, attributes:node.attributes })),
      locations:[...(ir.locations || new Map()).entries()].map(([key, loc]) => [key, { kind:loc.kind, address:loc.address == null ? null : String(loc.address), disp:loc.disp == null ? null : String(loc.disp), baseEntityId:loc.baseEntityId ?? null }]),
      memory:(ir.instructions || []).filter((inst) => inst.op === 'load' || inst.op === 'store').map((inst) => ({
        row:inst.row, op:inst.op, loc:inst.loc ? { key:inst.loc.key, kind:inst.loc.kind, address:inst.loc.address == null ? null : String(inst.loc.address), disp:inst.loc.disp == null ? null : String(inst.loc.disp), baseEntityId:inst.loc.baseEntityId ?? null } : null,
        addr:inst.addr ? { disp:inst.addr.disp == null ? null : String(inst.addr.disp), baseReg:inst.addr.baseReg ?? null, baseSemanticValueId:inst.addr.base?.semanticValueId ?? null, precise:inst.addr.precise ?? null } : null,
      })),
    }));
  }
  assert.ok(rmw, 'absolute ADR-based RMW must remain a proven GLOBAL location');
  assert.equal(rmw.location.address, 0x100001020n);
  assert.equal(rmw.load.row, 1);
  assert.equal(rmw.store.row, 3);
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('semantic-v2 absolute global RMW compatibility projection: PASS');