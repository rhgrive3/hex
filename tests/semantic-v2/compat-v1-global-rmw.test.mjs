import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { irFor, readModifyWrite, setSemanticMigrationMode, MK } from '../../js/ir.js';
import { deriveCanonicalAddressProof } from '../../js/analysis/alias/index-v2.js';
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

function proof(pipeline, valueId) {
  const result = deriveCanonicalAddressProof(pipeline.semanticIr, valueId, { ssa:pipeline.ssa, addressSpace:'memory' });
  return JSON.parse(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value));
}

try {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  const ir = irFor(model, { rowOfAddress, decoderSemanticVersion:'global-rmw-explicit-v2' });
  assert.ok(ir, 'explicit v2 route must build absolute global fixture');
  const rmw = readModifyWrite(ir).find((candidate) => candidate.location?.kind === MK.GLOBAL) ?? null;
  if (!rmw) {
    const pipeline = directPipeline();
    const x19Reads = pipeline.semanticIr.nodes.filter((node) => node.kind === 'state-read' && node.variable?.physicalIdentity?.registerId === 'x19');
    const memoryNodes = pipeline.semanticIr.nodes.filter((node) => node.kind === 'load' || node.kind === 'store');
    const addressProofs = memoryNodes.map((node) => {
      const addressValueId = node.memory?.addressExpr?.valueId ?? node.memory?.addressValueId ?? null;
      const value = pipeline.semanticIr.values.find((candidate) => candidate.id === addressValueId) ?? null;
      const addressNode = value?.definitionNodeId == null ? null : pipeline.semanticIr.nodes.find((candidate) => candidate.id === value.definitionNodeId) ?? null;
      return {
        nodeId:node.id,
        addressValueId,
        full:proof(pipeline, addressValueId),
        inputs:(addressNode?.inputs ?? []).map((input) => ({ valueId:input, proof:proof(pipeline, input) })),
      };
    });
    console.log('V2_GLOBAL_RMW_PROOFS ' + JSON.stringify({
      regions:pipeline.regions.map((region) => ({ kind:region.kind, metadata:region.metadata ?? null })),
      addressProofs,
      x19Reads:x19Reads.map((node) => ({ id:node.id, output:node.outputs?.[0], directProof:proof(pipeline, node.outputs?.[0]) })),
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