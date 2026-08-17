import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP, getLastSemanticV2Instrumentation } from '../../js/ir.js';

const BASE = 0x100000000n;
const lines = [
  'sub sp, sp, #32',
  'str x0, [sp, #16]',
  'str w2, [x0, #32]',
  'ldr x3, [sp, #16]',
  'add sp, sp, #32',
  'ret',
];
const rows = lines.map((line, i) => {
  const p = line.indexOf(' ');
  return { row: i, address: BASE + BigInt(i * 4), mn: p < 0 ? line : line.slice(0, p), ops: p < 0 ? '' : line.slice(p + 1) };
});
const rowOfAddress = (a) => {
  const d = a - BASE;
  return d < 0n || d >= BigInt(lines.length * 4) ? null : Number(d / 4n);
};
const model = buildSemanticModel(rows, { startRow: 0, endRow: lines.length - 1, rowOfAddress });
const ir = buildIR(model, { rowOfAddress });
const debug = getLastSemanticV2Instrumentation();
const semanticIr = debug?.semanticIr;
const load = ir.instructions.find((i) => i.op === OP.LOAD && i.row === 3);
const stateRead = ir.instructions.find((i) => i.row === 3 && i.extra?.stateRead && i.extra?.publicStateIdentity === 'x3');
const stateWrite = ir.instructions.find((i) => i.row === 3 && i.extra?.stateWrite && i.extra?.publicStateIdentity === 'x3');
const seeds = new Set([
  load?.dst?.semanticValueId,
  stateRead?.dst?.semanticValueId,
  stateRead?.args?.[0]?.value?.semanticValueId,
  stateWrite?.dst?.semanticValueId,
  stateWrite?.args?.[0]?.value?.semanticValueId,
].filter(Boolean));
const relatedNodes = semanticIr?.nodes?.filter((n) => [...(n.inputs || []), ...(n.outputs || [])].some((id) => seeds.has(id))) || [];
const ids = new Set([...seeds, ...relatedNodes.flatMap((n) => [...(n.inputs || []), ...(n.outputs || [])])]);
const compactNode = (n) => ({
  id: n.id,
  kind: n.kind,
  opcode: n.opcode ?? n.op ?? null,
  inputs: n.inputs,
  outputs: n.outputs,
  completeness: n.completeness,
  attributes: {
    stateRead: n.attributes?.stateRead ?? null,
    stateWrite: n.attributes?.stateWrite ?? null,
    publicStateIdentity: n.attributes?.publicStateIdentity ?? null,
    localPhysicalViewProjection: n.attributes?.localPhysicalViewProjection ?? null,
    machineValueOpcode: n.attributes?.machineValueOpcode ?? null,
    machineEffects: n.attributes?.machineEffects ? {
      operationKind: n.attributes.machineEffects.operationKind,
      operationMetadata: n.attributes.machineEffects.operationMetadata,
    } : null,
  },
});
const compactValue = (v) => ({ id: v.id, machineType: v.machineType, kind: v.kind, origin: v.origin, attributes: v.attributes });
const compactDef = (d) => ({ id: d.id, valueId: d.valueId, variableKey: d.variableKey, kind: d.kind, proof: d.proof });
const compactUse = (u) => ({ id: u.id, valueId: u.valueId, variableKey: u.variableKey, kind: u.kind, proof: u.proof });
const publicValue = (v) => v && ({
  id: v.id,
  reg: v.reg ?? null,
  kind: v.kind,
  bits: v.bits,
  semanticValueId: v.semanticValueId ?? null,
  semanticSsaValueId: v.semanticSsaValueId ?? null,
  compatDerived: v.compatDerived ?? null,
  compatPublicIdentity: v.compatPublicIdentity ?? null,
});
console.log(JSON.stringify({
  public: {
    load: load && { id: load.id, dst: publicValue(load.dst), reachingStore: load.reachingStore?.id ?? null },
    stateRead: stateRead && { id: stateRead.id, dst: publicValue(stateRead.dst), arg: publicValue(stateRead.args?.[0]?.value), extra: stateRead.extra },
    stateWrite: stateWrite && { id: stateWrite.id, dst: publicValue(stateWrite.dst), arg: publicValue(stateWrite.args?.[0]?.value), extra: stateWrite.extra },
  },
  semanticNodes: relatedNodes.map(compactNode),
  semanticValues: semanticIr?.values?.filter((v) => ids.has(v.id)).map(compactValue) || [],
  ssaDefinitions: debug?.ssa?.definitions?.filter((d) => ids.has(d.proof?.sourceSemanticValueId) || ids.has(d.valueId)).map(compactDef) || [],
  ssaUses: debug?.ssa?.uses?.filter((u) => ids.has(u.proof?.sourceSemanticValueId) || ids.has(u.valueId)).map(compactUse) || [],
}, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
