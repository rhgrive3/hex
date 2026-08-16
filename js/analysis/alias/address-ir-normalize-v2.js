import { deepFreeze } from '../../core/identity/index.js';

export const ADDRESS_IR_NORMALIZATION_VERSION = '1.0.0';

function parseInteger(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'value')) value = value.value;
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(value.trim())) return BigInt(value.trim());
  } catch {}
  return null;
}

function exactIntegerConstant(valuesById, nodesById, valueId) {
  const value = valuesById.get(String(valueId));
  if (!value || value.kind === 'unknown' || value.kind === 'undef') return null;
  const node = value.definitionNodeId == null ? null : nodesById.get(String(value.definitionNodeId));
  if (!node || node.kind !== 'const') return null;
  for (const candidate of [value.metadata?.constant, node.attributes?.constant, node.metadata?.constant]) {
    const integer = parseInteger(candidate);
    if (integer != null) return integer;
  }
  return null;
}

/**
 * Build an internal proof-only projection for semantic operations whose exact
 * result meaning is stronger than their generic intrinsic node kind.
 *
 * This does not inspect target mnemonics or architecture identifiers. The only
 * normalization currently accepted is the architecture-neutral semantic
 * operation add-with-carry when the selected value is the arithmetic result
 * output and the carry-in is a proven constant zero. Carry/overflow outputs,
 * non-zero carry, and unknown carry remain untouched and therefore unknown to
 * canonical address derivation.
 */
export function normalizeAddressProofIr(ir) {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return ir;
  const values = Array.isArray(ir.values) ? ir.values : [];
  const nodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const valuesById = new Map(values.map((value) => [String(value.id), value]));
  const nodesById = new Map(nodes.map((node) => [String(node.id), node]));
  const rewrittenValues = new Map();
  const syntheticNodes = [];

  for (const node of nodes) {
    if (node?.kind !== 'intrinsic' || String(node.operator ?? '').toLowerCase() !== 'add-with-carry') continue;
    if (!Array.isArray(node.inputs) || node.inputs.length !== 3) continue;
    if (!Array.isArray(node.outputs) || node.outputs.length < 1) continue;
    if (exactIntegerConstant(valuesById, nodesById, node.inputs[2]) !== 0n) continue;

    const resultValueId = String(node.outputs[0]);
    const resultValue = valuesById.get(resultValueId);
    if (!resultValue || String(resultValue.definitionNodeId ?? '') !== String(node.id)) continue;

    const syntheticId = `${String(node.id)}:canonical-address-result`;
    syntheticNodes.push(deepFreeze({
      ...node,
      id: syntheticId,
      kind: 'binary',
      inputs: node.inputs.slice(0, 2),
      outputs: [resultValueId],
      operator: 'add',
      intrinsic: null,
      attributes: {
        ...(node.attributes ?? {}),
        canonicalAddressProjection: {
          sourceOperator: 'add-with-carry',
          proof: 'carry-in-exact-zero',
        },
      },
    }));
    rewrittenValues.set(resultValueId, deepFreeze({ ...resultValue, definitionNodeId: syntheticId }));
  }

  if (!syntheticNodes.length) return ir;
  return deepFreeze({
    ...ir,
    values: values.map((value) => rewrittenValues.get(String(value.id)) ?? value),
    nodes: [...nodes, ...syntheticNodes],
  });
}
