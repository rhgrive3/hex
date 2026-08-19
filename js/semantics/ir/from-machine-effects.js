import { stableDigest, stableStringify } from '../../core/identity/index.js';
import { mergeOriginSets } from '../../core/identity/origin.js';
import { createSemanticIrFunction } from './function.js';
import {
  createLoweringOrigin,
  createPhysicalStateVariable,
  machineValueMachineType,
  machineValueReferenceKey,
  normalizeMachineEffectBundleForSemanticIr,
  classifyMachineValueOpcode,
  semanticCompletenessFromMachineEffects,
} from './normalize-effects.js';

const COMPLETENESS_RANK = Object.freeze({ complete: 0, partial: 1, unknown: 2 });
const MAX_EXPRESSION_DEPTH = 64;
const MACHINE_VALUE_KINDS = new Set([
  'bitvector', 'float', 'vector', 'predicate', 'register', 'memory', 'code', 'tls', 'io', 'temporary', 'flag',
]);

function fail(code) { throw new TypeError(code); }
function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-ir-lowering-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function localId(prefix, payload) {
  return `${prefix}_${stableDigest(payload)}`;
}
function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

export function lowerMachineEffectBundleToSemanticIr(input, context = {}, options = {}) {
  assertNotAborted(options);
  const normalized = normalizeMachineEffectBundleForSemanticIr(input, options);
  const bundle = normalized.bundle;
  const functionId = nonEmpty(context.functionId, 'semantic-ir-lowering-function-id-required');
  const blockId = nonEmpty(context.blockId, 'semantic-ir-lowering-block-id-required');
  const entryBlockId = context.entryBlockId == null ? blockId : nonEmpty(context.entryBlockId, 'semantic-ir-lowering-entry-block-id-required');
  if (entryBlockId !== blockId) fail('semantic-ir-lowering-single-bundle-entry-must-match-block');

  const nodes = [];
  const values = [];
  const nodeIds = [];
  const blocks = new Map();
  const valueIds = new Set();
  const nodeIdSet = new Set();
  const temporaryDefinitions = new Map();
  const issues = new Map();
  let completeness = semanticCompletenessFromMachineEffects(bundle.completeness);

  const allSourceEffectIds = unique([
    ...normalized.effects.map((effect) => effect.sourceEffectId),
    normalized.control.sourceEffectId,
    normalized.unknown?.sourceEffectId,
    normalized.annotation?.sourceEffectId,
  ]).sort();

  function promote(next) {
    if (COMPLETENESS_RANK[next] > COMPLETENESS_RANK[completeness]) completeness = next;
  }

  function addIssue(reason, categories, detail = null, severity = 'partial') {
    const issue = {
      reason: String(reason),
      categories: unique(categories ?? ['other']).sort(),
      ...(detail == null ? {} : { detail }),
    };
    issues.set(stableStringify(issue), issue);
    promote(severity);
  }

  function effectOrigin(effect, ruleId, producedEntityIds) {
    return createLoweringOrigin(effect.origin ?? bundle.origin, {
      sourceEffectIds: [effect.sourceEffectId],
      ruleId,
      producedEntityIds,
    });
  }

  function currentBlockOrigin() {
    return createLoweringOrigin(bundle.origin, {
      sourceEffectIds: allSourceEffectIds,
      ruleId: 'bundle-block-projection',
      producedEntityIds: [blockId],
    });
  }

  blocks.set(blockId, { id: blockId, nodeIds, origin: currentBlockOrigin() });

  function addNode(node) {
    if (nodeIdSet.has(node.id)) fail('semantic-ir-lowering-duplicate-node-id');
    nodeIdSet.add(node.id);
    nodes.push(node);
    nodeIds.push(node.id);
    return node.id;
  }

  function addValue(value) {
    if (valueIds.has(value.id)) fail('semantic-ir-lowering-duplicate-value-id');
    valueIds.add(value.id);
    values.push(value);
    return value.id;
  }

  function nodeIdFor(effect, role, ordinal = 0) {
    return localId('semantic_node', {
      functionId,
      instructionId: bundle.instructionId,
      sourceEffectId: effect.sourceEffectId,
      role,
      ordinal,
    });
  }

  function valueIdFor(effect, role, ordinal = 0, identity = null) {
    return localId('semantic_value', {
      functionId,
      instructionId: bundle.instructionId,
      sourceEffectId: effect.sourceEffectId,
      role,
      ordinal,
      identity,
    });
  }

  function machineAttributes(effect, extra = {}) {
    const operation = effect.operation ?? null;
    return {
      machineEffects: {
        instructionId: bundle.instructionId,
        architectureId: bundle.architectureId,
        mode: bundle.mode,
        bundleCompleteness: bundle.completeness,
        sourceEffectId: effect.sourceEffectId,
        ...(operation == null ? {} : { operationKind: operation.kind }),
        ...(operation?.metadata == null ? {} : { operationMetadata: operation.metadata }),
        ...(bundle.metadata == null ? {} : { bundleMetadata: bundle.metadata }),
        ...(bundle.possibleFaults.length ? { possibleFaults: bundle.possibleFaults } : {}),
      },
      ...extra,
    };
  }

  function outputPlan(effect, value, role, ordinal) {
    const referenceKey = machineValueReferenceKey(value);
    const id = valueIdFor(effect, role, ordinal, referenceKey);
    if (referenceKey?.startsWith('temporary:')) {
      const previous = temporaryDefinitions.get(referenceKey);
      if (previous && previous.valueId !== id) fail('semantic-ir-lowering-duplicate-temporary-definition');
      temporaryDefinitions.set(referenceKey, { valueId: id, effect, value, role, ordinal });
    }
    return id;
  }

  function operationOutputs(effect) {
    const operation = effect.operation;
    if (operation.kind === 'value') return operation.outputs.map((value, index) => ({ value, role: 'value-output', ordinal: index }));
    if (operation.kind === 'register-read') return [{ value: operation.value, role: 'register-read-result', ordinal: 0 }];
    if (operation.kind === 'flag-read') return [{ value: operation.value, role: 'flag-read-result', ordinal: 0 }];
    if (operation.kind === 'memory-read') return [{ value: operation.value, role: 'memory-read-result', ordinal: 0 }];
    if (operation.kind === 'intrinsic') return operation.effectSummary.outputs.map((value, index) => ({ value, role: 'intrinsic-output', ordinal: index }));
    return [];
  }

  for (const effect of normalized.effects) {
    for (const output of operationOutputs(effect)) outputPlan(effect, output.value, output.role, output.ordinal);
  }

  function plannedOutputId(effect, value, role, ordinal) {
    const referenceKey = machineValueReferenceKey(value);
    if (referenceKey?.startsWith('temporary:')) {
      const planned = temporaryDefinitions.get(referenceKey);
      if (planned) return planned.valueId;
    }
    return valueIdFor(effect, role, ordinal, referenceKey);
  }

  function createDefinitionValue(effect, nodeId, machineValue, role, ordinal) {
    const id = plannedOutputId(effect, machineValue, role, ordinal);
    if (valueIds.has(id)) return id;
    const machineType = machineValueMachineType(machineValue, { addressWidthBits: context.addressWidthBits });
    if (!machineType) fail('semantic-ir-lowering-unrepresentable-output-machine-type');
    return addValue({
      id,
      kind: 'definition',
      machineType,
      definitionNodeId: nodeId,
      sourceEntityId: effect.sourceEffectId,
      origin: effectOrigin(effect, `${role}-value`, [id]),
      metadata: { machineValue },
    });
  }

  function createUnknownValue(effect, machineType, role, reason, raw, ordinal = 0) {
    if (!machineType) return null;
    const nodeId = nodeIdFor(effect, `${role}-unknown`, ordinal);
    const valueId = valueIdFor(effect, `${role}-unknown`, ordinal, raw);
    const origin = effectOrigin(effect, 'unknown-value-projection', [nodeId, valueId]);
    addValue({
      id: valueId,
      kind: 'definition',
      machineType,
      definitionNodeId: nodeId,
      sourceEntityId: effect.sourceEffectId,
      origin,
      metadata: { unresolvedMachineValue: raw },
    });
    addNode({
      id: nodeId,
      kind: 'unknown-value',
      blockId,
      outputs: [valueId],
      completeness: 'unknown',
      unknown: { reason, categories: ['value'], knownParts: { machineType, raw } },
      sourceEffectIds: [effect.sourceEffectId],
      attributes: machineAttributes(effect),
      origin,
    });
    addIssue(reason, ['value'], { raw });
    return valueId;
  }

  function createConstant(effect, machineValue, role, ordinal = 0, overrideType = null) {
    const machineType = overrideType ?? machineValueMachineType(machineValue, { addressWidthBits: context.addressWidthBits });
    if (!machineType) return null;
    const hasConcrete = machineValue.kind === 'bitvector'
      ? machineValue.value != null
      : machineValue.kind === 'float'
        ? machineValue.bitPattern != null || machineValue.semanticValue != null
        : false;
    if (!hasConcrete) return createUnknownValue(effect, machineType, role, 'machine-value-has-no-concrete-value', machineValue, ordinal);
    const nodeId = nodeIdFor(effect, `${role}-const`, ordinal);
    const valueId = valueIdFor(effect, `${role}-const`, ordinal, machineValue);
    const origin = effectOrigin(effect, 'constant-projection', [nodeId, valueId]);
    addValue({
      id: valueId,
      kind: 'definition',
      machineType,
      definitionNodeId: nodeId,
      sourceEntityId: effect.sourceEffectId,
      origin,
      metadata: { constant: machineValue },
    });
    addNode({
      id: nodeId,
      kind: 'const',
      blockId,
      outputs: [valueId],
      attributes: machineAttributes(effect, { constant: machineValue }),
      sourceEffectIds: [effect.sourceEffectId],
      origin,
    });
    return valueId;
  }

  function implicitStateRead(effect, machineValue, role, ordinal = 0) {
    const machineType = machineValueMachineType(machineValue, { addressWidthBits: context.addressWidthBits });
    if (!machineType) return null;
    const variable = createPhysicalStateVariable(machineValue);
    const nodeId = nodeIdFor(effect, `${role}-state-read`, ordinal);
    const valueId = valueIdFor(effect, `${role}-state-read`, ordinal, variable.key);
    const origin = effectOrigin(effect, 'implicit-state-read-projection', [nodeId, valueId]);
    addValue({
      id: valueId,
      kind: 'definition',
      machineType,
      definitionNodeId: nodeId,
      sourceEntityId: effect.sourceEffectId,
      variableKey: variable.key,
      origin,
      metadata: { machineValue },
    });
    addNode({
      id: nodeId,
      kind: 'state-read',
      blockId,
      outputs: [valueId],
      variable,
      attributes: machineAttributes(effect, { implicitFromMachineValue: true }),
      sourceEffectIds: [effect.sourceEffectId],
      origin,
    });
    return valueId;
  }

  function resolveMachineInput(effect, machineValue, role, ordinal = 0) {
    assertNotAborted(options);
    if (!machineValue || typeof machineValue !== 'object') return null;
    if (machineValue.kind === 'temporary') {
      const key = machineValueReferenceKey(machineValue);
      const planned = temporaryDefinitions.get(key);
      if (planned) return planned.valueId;
      const machineType = machineValueMachineType(machineValue, { addressWidthBits: context.addressWidthBits });
      return createUnknownValue(effect, machineType, role, 'temporary-value-has-no-defining-machine-effect', machineValue, ordinal);
    }
    if (machineValue.kind === 'register' || machineValue.kind === 'flag') return implicitStateRead(effect, machineValue, role, ordinal);
    if (machineValue.kind === 'bitvector' || machineValue.kind === 'float') return createConstant(effect, machineValue, role, ordinal);
    if (machineValue.kind === 'vector' || machineValue.kind === 'predicate') {
      const machineType = machineValueMachineType(machineValue, { addressWidthBits: context.addressWidthBits });
      return createUnknownValue(effect, machineType, role, 'aggregate-machine-value-has-no-reference-identity', machineValue, ordinal);
    }
    if (['memory', 'code', 'tls', 'io'].includes(machineValue.kind)) {
      const lowered = lowerExpression(effect, machineValue.addressExpr, machineValue.kind, `${role}-location`, 0);
      return lowered.valueId;
    }
    return null;
  }

  function rawBitvectorType(widthBits) {
    const width = positiveInteger(widthBits);
    return width == null ? null : { kind: 'bitvector', widthBits: width };
  }

  function rawConstant(effect, value, widthBits, role, ordinal = 0, asAddressSpace = null) {
    const width = positiveInteger(widthBits);
    if (width == null) return null;
    let integer;
    try { integer = BigInt(value); }
    catch { return null; }
    if (integer < 0n || integer >= (1n << BigInt(width))) return null;
    const machineValue = { kind: 'bitvector', widthBits: width, value: integer.toString() };
    const type = asAddressSpace == null ? null : { kind: 'address', widthBits: width, addressSpace: String(asAddressSpace) };
    return createConstant(effect, machineValue, role, ordinal, type);
  }

  function lowerExpression(effect, expression, addressSpace, role, depth) {
    assertNotAborted(options);
    if (depth > MAX_EXPRESSION_DEPTH) return { valueId: null, reason: 'machine-expression-depth-exceeded' };
    if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
      const width = positiveInteger(context.addressWidthBits);
      if (width != null && (typeof expression === 'number' || typeof expression === 'bigint' || typeof expression === 'string')) {
        const valueId = rawConstant(effect, expression, width, `${role}-constant`, depth, addressSpace);
        if (valueId) return { valueId };
      }
      return { valueId: null, reason: 'machine-expression-shape-not-representable' };
    }

    if (expression.kind === 'temporary') {
      const key = `temporary:${String(expression.temporaryId ?? '')}`;
      const planned = temporaryDefinitions.get(key);
      if (planned) return { valueId: planned.valueId };
      const type = rawBitvectorType(expression.widthBits);
      return { valueId: createUnknownValue(effect, type, role, 'address-temporary-has-no-defining-machine-effect', expression, depth) };
    }
    if (expression.kind === 'register' || expression.kind === 'flag') {
      const widthBits = positiveInteger(expression.widthBits) ?? (expression.kind === 'flag' ? 1 : null);
      if (widthBits == null) return { valueId: null, reason: 'physical-state-expression-width-missing' };
      return { valueId: implicitStateRead(effect, { ...expression, widthBits }, role, depth) };
    }
    if (expression.kind === 'bitvector') {
      const valueId = rawConstant(effect, expression.value, expression.widthBits, role, depth);
      return valueId ? { valueId } : { valueId: null, reason: 'bitvector-expression-not-concrete' };
    }

    const kind = String(expression.kind ?? '').toLowerCase();
    if (kind === 'add' || kind === 'sub') {
      const left = lowerExpression(effect, expression.left, addressSpace, `${role}-left`, depth + 1);
      const right = lowerExpression(effect, expression.right, addressSpace, `${role}-right`, depth + 1);
      const widthBits = positiveInteger(expression.widthBits) ?? positiveInteger(context.addressWidthBits);
      if (!left.valueId || !right.valueId || widthBits == null) {
        return { valueId: null, reason: left.reason ?? right.reason ?? 'address-arithmetic-width-missing' };
      }
      const nodeId = nodeIdFor(effect, `${role}-${kind}`, depth);
      const valueId = valueIdFor(effect, `${role}-${kind}`, depth, expression);
      const origin = effectOrigin(effect, 'address-expression-projection', [nodeId, valueId]);
      addValue({
        id: valueId,
        kind: 'definition',
        machineType: { kind: 'address', widthBits, addressSpace: String(addressSpace) },
        definitionNodeId: nodeId,
        sourceEntityId: effect.sourceEffectId,
        origin,
        metadata: { machineAddressExpression: expression },
      });
      addNode({
        id: nodeId,
        kind: 'address',
        blockId,
        inputs: [left.valueId, right.valueId],
        outputs: [valueId],
        operator: kind,
        attributes: machineAttributes(effect, { machineAddressExpression: expression }),
        sourceEffectIds: [effect.sourceEffectId],
        origin,
      });
      return { valueId };
    }

    if (kind === 'zero-extend' || kind === 'sign-extend') {
      const inner = lowerExpression(effect, expression.value, addressSpace, `${role}-value`, depth + 1);
      const fromBits = positiveInteger(expression.fromBits);
      const toBits = positiveInteger(expression.toBits);
      if (!inner.valueId || fromBits == null || toBits == null || toBits < fromBits) {
        return { valueId: null, reason: inner.reason ?? 'extension-expression-width-invalid' };
      }
      const semanticKind = kind === 'zero-extend' ? 'zext' : 'sext';
      const nodeId = nodeIdFor(effect, `${role}-${semanticKind}`, depth);
      const valueId = valueIdFor(effect, `${role}-${semanticKind}`, depth, expression);
      const origin = effectOrigin(effect, 'extension-expression-projection', [nodeId, valueId]);
      addValue({
        id: valueId,
        kind: 'definition',
        machineType: { kind: 'bitvector', widthBits: toBits },
        definitionNodeId: nodeId,
        sourceEntityId: effect.sourceEffectId,
        origin,
        metadata: { machineAddressExpression: expression },
      });
      addNode({
        id: nodeId,
        kind: semanticKind,
        blockId,
        inputs: [inner.valueId],
        outputs: [valueId],
        operator: kind,
        attributes: machineAttributes(effect, { fromBits, toBits }),
        sourceEffectIds: [effect.sourceEffectId],
        origin,
      });
      return { valueId };
    }

    if (kind === 'shift-left') {
      const inner = lowerExpression(effect, expression.value, addressSpace, `${role}-value`, depth + 1);
      const widthBits = positiveInteger(expression.widthBits) ?? positiveInteger(context.addressWidthBits);
      if (!inner.valueId || widthBits == null) return { valueId: null, reason: inner.reason ?? 'shift-expression-width-missing' };
      const amountId = rawConstant(effect, expression.amount, widthBits, `${role}-amount`, depth + 1);
      if (!amountId) return { valueId: null, reason: 'shift-expression-amount-invalid' };
      const nodeId = nodeIdFor(effect, `${role}-shift-left`, depth);
      const valueId = valueIdFor(effect, `${role}-shift-left`, depth, expression);
      const origin = effectOrigin(effect, 'shift-expression-projection', [nodeId, valueId]);
      addValue({
        id: valueId,
        kind: 'definition',
        machineType: { kind: 'bitvector', widthBits },
        definitionNodeId: nodeId,
        sourceEntityId: effect.sourceEffectId,
        origin,
        metadata: { machineAddressExpression: expression },
      });
      addNode({
        id: nodeId,
        kind: 'binary',
        blockId,
        inputs: [inner.valueId, amountId],
        outputs: [valueId],
        operator: 'shl',
        attributes: machineAttributes(effect, { machineAddressExpression: expression }),
        sourceEffectIds: [effect.sourceEffectId],
        origin,
      });
      return { valueId };
    }

    if (MACHINE_VALUE_KINDS.has(expression.kind)) {
      const valueId = resolveMachineInput(effect, expression, role, depth);
      return valueId ? { valueId } : { valueId: null, reason: 'machine-value-expression-not-representable' };
    }
    return { valueId: null, reason: `unsupported-machine-expression:${String(expression.kind ?? 'unknown')}` };
  }

  function semanticMemoryAccess(effect, access, role) {
    const lowered = lowerExpression(effect, access.addressExpr, access.space, `${role}-address`, 0);
    if (!lowered.valueId) return { access: null, reason: lowered.reason ?? 'memory-address-not-representable' };
    return {
      access: {
        addressSpace: access.space,
        addressValueId: lowered.valueId,
        widthBits: access.widthBits,
        endian: access.endian,
        alignment: access.alignment ?? null,
        volatility: access.volatility ?? 'unknown',
        atomic: access.atomic ?? 'unknown',
        ordering: access.ordering ?? 'unknown',
        faults: bundle.possibleFaults,
      },
    };
  }

  function stateVariableFromRegisterId(registerId) {
    const id = String(registerId);
    return {
      key: `physical-state:${stableDigest({ kind: 'register', registerId: id })}`,
      kind: 'physical-state',
      scope: 'function',
      physicalIdentity: { kind: 'register', registerId: id },
    };
  }

  function lowerIntrinsicMemoryScope(effect, scope, role) {
    if (scope.scope === 'none') return { scope: { scope: 'none' }, exact: true };
    if (scope.scope === 'unknown') {
      return { scope: { scope: 'unknown', detail: scope.detail ?? { reason: 'machine-intrinsic-memory-scope-unknown' } }, exact: false };
    }
    if (scope.scope === 'all') {
      return {
        scope: {
          scope: 'all',
          addressSpaces: scope.spaces,
          ...(scope.detail == null ? {} : { detail: scope.detail }),
        },
        exact: true,
      };
    }
    const accesses = [];
    for (let index = 0; index < scope.accesses.length; index++) {
      const lowered = semanticMemoryAccess(effect, scope.accesses[index], `${role}-${index}`);
      if (!lowered.access) {
        return {
          scope: { scope: 'unknown', detail: { reason: lowered.reason, machineScope: scope } },
          exact: false,
        };
      }
      accesses.push(lowered.access);
    }
    return { scope: { scope: 'accesses', accesses, ...(scope.detail == null ? {} : { detail: scope.detail }) }, exact: true };
  }

  function lowerValueOperation(effect) {
    const operation = effect.operation;
    const nodeId = nodeIdFor(effect, 'value-operation');
    const inputs = operation.inputs.map((value, index) => resolveMachineInput(effect, value, 'value-input', index)).filter(Boolean);
    const outputs = operation.outputs.map((value, index) => createDefinitionValue(effect, nodeId, value, 'value-output', index));
    const classification = classifyMachineValueOpcode(operation.opcode);
    const origin = effectOrigin(effect, `value-${classification.kind}`, [nodeId, ...outputs]);
    if (classification.kind === 'intrinsic') {
      addNode({
        id: nodeId,
        kind: 'intrinsic',
        blockId,
        inputs,
        outputs,
        operator: classification.operator,
        intrinsic: {
          inputs,
          outputs,
          stateReads: [],
          stateWrites: [],
          memoryRead: { scope: 'none' },
          memoryWrite: { scope: 'none' },
          controlEffects: [],
          determinism: 'deterministic',
          symbolicDetail: 'summary-only',
        },
        attributes: machineAttributes(effect, { machineValueOpcode: operation.opcode }),
        sourceEffectIds: [effect.sourceEffectId],
        origin,
      });
      return;
    }
    addNode({
      id: nodeId,
      kind: classification.kind,
      blockId,
      inputs,
      outputs,
      operator: classification.operator,
      attributes: machineAttributes(effect, { machineValueOpcode: operation.opcode }),
      sourceEffectIds: [effect.sourceEffectId],
      origin,
    });
  }

  function lowerStateRead(effect, stateValue, resultValue, role) {
    const nodeId = nodeIdFor(effect, role);
    const output = createDefinitionValue(effect, nodeId, resultValue, `${role}-result`, 0);
    const variable = createPhysicalStateVariable(stateValue);
    const origin = effectOrigin(effect, `${role}-projection`, [nodeId, output]);
    const index = values.findIndex((value) => value.id === output);
    if (index >= 0) values[index] = { ...values[index], variableKey: variable.key, origin };
    addNode({
      id: nodeId,
      kind: 'state-read',
      blockId,
      outputs: [output],
      variable,
      attributes: machineAttributes(effect),
      sourceEffectIds: [effect.sourceEffectId],
      origin,
    });
  }

  function lowerStateWrite(effect, stateValue, sourceValue, role) {
    const inputId = resolveMachineInput(effect, sourceValue, `${role}-input`, 0);
    if (!inputId) {
      emitUnknownEffects(effect, 'state-write-source-not-representable', ['registers'], { stateValue, sourceValue });
      return;
    }
    const nodeId = nodeIdFor(effect, role);
    const origin = effectOrigin(effect, `${role}-projection`, [nodeId]);
    addNode({
      id: nodeId,
      kind: 'state-write',
      blockId,
      inputs: [inputId],
      variable: createPhysicalStateVariable(stateValue),
      attributes: machineAttributes(effect),
      sourceEffectIds: [effect.sourceEffectId],
      origin,
    });
  }

  function lowerMemoryRead(effect) {
    const operation = effect.operation;
    const nodeId = nodeIdFor(effect, 'memory-read');
    const output = createDefinitionValue(effect, nodeId, operation.value, 'memory-read-result', 0);
    const memory = semanticMemoryAccess(effect, operation.access, 'memory-read');
    if (!memory.access) {
      const origin = effectOrigin(effect, 'unknown-memory-read-projection', [nodeId, output]);
      const index = values.findIndex((value) => value.id === output);
      if (index >= 0) values[index] = { ...values[index], origin };
      addNode({
        id: nodeId,
        kind: 'unknown-memory-effect',
        blockId,
        outputs: [output],
        completeness: 'partial',
        unknown: {
          reason: memory.reason,
          categories: ['memory', 'address'],
          knownParts: { access: operation.access, resultMachineValue: operation.value },
        },
        attributes: machineAttributes(effect, { machineMemoryAccess: operation.access }),
        sourceEffectIds: [effect.sourceEffectId],
        origin,
      });
      addIssue(memory.reason, ['memory', 'address'], { access: operation.access });
      return;
    }
    const origin = effectOrigin(effect, 'memory-read-projection', [nodeId, output]);
    const index = values.findIndex((value) => value.id === output);
    if (index >= 0) values[index] = { ...values[index], origin };
    addNode({
      id: nodeId,
      kind: 'load',
      blockId,
      inputs: [memory.access.addressExpr?.valueId ?? memory.access.addressValueId].filter(Boolean),
      outputs: [output],
      memory: memory.access,
      attributes: machineAttributes(effect),
      sourceEffectIds: [effect.sourceEffectId],
      origin,
    });
  }

  function lowerMemoryWrite(effect) {
    const operation = effect.operation;
    const inputId = resolveMachineInput(effect, operation.value, 'memory-write-value', 0);
    const memory = semanticMemoryAccess(effect, operation.access, 'memory-write');
    if (!inputId || !memory.access) {
      emitUnknownEffects(effect, memory.reason ?? 'memory-write-value-not-representable', ['memory'], {
        access: operation.access,
        value: operation.value,
      });
      return;
    }
    const nodeId = nodeIdFor(effect, 'memory-write');
    const origin = effectOrigin(effect, 'memory-write-projection', [nodeId]);
    addNode({
      id: nodeId,
      kind: 'store',
      blockId,
      inputs: [memory.access.addressExpr?.valueId ?? memory.access.addressValueId, inputId].filter(Boolean),
      memory: memory.access,
      attributes: machineAttributes(effect),
      sourceEffectIds: [effect.sourceEffectId],
      origin,
    });
  }

  function lowerIntrinsic(effect) {
    const operation = effect.operation;
    const summary = operation.effectSummary;
    const nodeId = nodeIdFor(effect, 'intrinsic');
    const inputs = summary.inputs.map((value, index) => resolveMachineInput(effect, value, 'intrinsic-input', index)).filter(Boolean);
    const outputs = summary.outputs.map((value, index) => createDefinitionValue(effect, nodeId, value, 'intrinsic-output', index));
    const memoryRead = lowerIntrinsicMemoryScope(effect, summary.memoryRead, 'intrinsic-memory-read');
    const memoryWrite = lowerIntrinsicMemoryScope(effect, summary.memoryWrite, 'intrinsic-memory-write');
    const controlUnknown = summary.controlEffects.some((control) => control.kind === 'unknown');
    const exact = memoryRead.exact && memoryWrite.exact && !controlUnknown && summary.determinism !== 'unknown';
    const origin = effectOrigin(effect, 'intrinsic-projection', [nodeId, ...outputs]);
    if (!exact) addIssue('intrinsic-summary-not-exactly-representable', ['intrinsic'], { intrinsicId: operation.intrinsicId });
    addNode({
      id: nodeId,
      kind: 'intrinsic',
      blockId,
      inputs,
      outputs,
      operator: operation.intrinsicId,
      intrinsic: {
        inputs,
        outputs,
        stateReads: summary.registersRead.map(stateVariableFromRegisterId),
        stateWrites: summary.registersWritten.map(stateVariableFromRegisterId),
        memoryRead: memoryRead.scope,
        memoryWrite: memoryWrite.scope,
        controlEffects: summary.controlEffects,
        determinism: summary.determinism,
        symbolicDetail: summary.symbolicDetail,
      },
      ...(exact ? {} : {
        completeness: 'partial',
        unknown: { reason: 'intrinsic-summary-not-exactly-representable', categories: ['intrinsic'] },
      }),
      attributes: machineAttributes(effect, { machineIntrinsicId: operation.intrinsicId }),
      sourceEffectIds: [effect.sourceEffectId],
      origin,
    });
  }

  function lowerBarrier(effect) {
    const nodeId = nodeIdFor(effect, 'barrier');
    addNode({
      id: nodeId,
      kind: 'barrier',
      blockId,
      attributes: machineAttributes(effect, { scope: effect.operation.scope }),
      sourceEffectIds: [effect.sourceEffectId],
      origin: effectOrigin(effect, 'barrier-projection', [nodeId]),
    });
  }

  function unknownNode(effect, kind, reason, categories, detail, ordinal) {
    const nodeId = nodeIdFor(effect, kind, ordinal);
    const isIncomplete = kind === 'incomplete';
    addNode({
      id: nodeId,
      kind,
      blockId,
      completeness: kind === 'incomplete' ? 'partial' : 'unknown',
      unknown: {
        reason,
        categories,
        ...(isIncomplete ? { missing: categories } : {}),
        ...(detail == null ? {} : { knownParts: detail }),
      },
      attributes: machineAttributes(effect, detail == null ? {} : { machineUnknownDetail: detail }),
      sourceEffectIds: [effect.sourceEffectId],
      origin: effectOrigin(effect, `${kind}-projection`, [nodeId]),
    });
  }

  function emitUnknownEffects(effect, reason, categories, detail = null, severity = 'partial') {
    const all = unique(categories.length ? categories : ['other']).sort();
    let ordinal = 0;
    const state = all.filter((category) => category === 'registers' || category === 'flags');
    const memory = all.filter((category) => category === 'memory');
    const control = all.filter((category) => category === 'control');
    const remainder = all.filter((category) => !state.includes(category) && !memory.includes(category) && !control.includes(category));
    if (state.length) unknownNode(effect, 'unknown-state-write', reason, state, detail, ordinal++);
    if (memory.length) unknownNode(effect, 'unknown-memory-effect', reason, memory, detail, ordinal++);
    if (control.length) unknownNode(effect, 'unknown-control-effect', reason, control, detail, ordinal++);
    if (remainder.length) unknownNode(effect, 'incomplete', reason, remainder, detail, ordinal++);
    addIssue(reason, all, detail, severity);
  }

  for (const effect of normalized.effects) {
    assertNotAborted(options);
    const operation = effect.operation;
    if (operation.kind === 'value') lowerValueOperation(effect);
    else if (operation.kind === 'register-read') lowerStateRead(effect, operation.register, operation.value, 'register-read');
    else if (operation.kind === 'register-write') lowerStateWrite(effect, operation.register, operation.value, 'register-write');
    else if (operation.kind === 'flag-read') lowerStateRead(effect, operation.flag, operation.value, 'flag-read');
    else if (operation.kind === 'flag-write') lowerStateWrite(effect, operation.flag, operation.value, 'flag-write');
    else if (operation.kind === 'memory-read') lowerMemoryRead(effect);
    else if (operation.kind === 'memory-write') lowerMemoryWrite(effect);
    else if (operation.kind === 'intrinsic') lowerIntrinsic(effect);
    else if (operation.kind === 'barrier') lowerBarrier(effect);
    else if (operation.kind === 'unknown') emitUnknownEffects(effect, operation.reason, operation.categories, operation.metadata ?? null);
    else emitUnknownEffects(effect, 'unsupported-machine-operation-kind', ['other'], { operationKind: operation.kind });
  }

  if (normalized.unknown) {
    emitUnknownEffects({
      sourceEffectId: normalized.unknown.sourceEffectId,
      origin: bundle.origin,
      operation: null,
    }, normalized.unknown.effect.reason, normalized.unknown.effect.categories, {
      detail: normalized.unknown.effect.detail ?? null,
      preservation: normalized.unknown.effect.preservation,
    }, bundle.completeness === 'unknown' ? 'unknown' : 'partial');
  }

  function configuredTargetBlocks(target, role) {
    const entries = Array.isArray(context.controlTargets) ? context.controlTargets : [];
    const key = stableStringify(target);
    const matches = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (stableStringify(entry.target) !== key) continue;
      if (entry.role != null && String(entry.role) !== String(role)) continue;
      matches.push(nonEmpty(entry.blockId, 'semantic-ir-lowering-control-target-block-required'));
    }
    return unique(matches);
  }

  function configuredTargetBlock(target, role) {
    const matches = configuredTargetBlocks(target, role);
    if (matches.length) return matches[0];
    return localId('semantic_block_target', {
      functionId,
      instructionId: bundle.instructionId,
      role,
      target,
    });
  }

  function ensureControlBlockId(id, ruleId = 'control-target-placeholder') {
    if (!blocks.has(id)) {
      blocks.set(id, {
        id,
        nodeIds: [],
        origin: createLoweringOrigin(bundle.origin, {
          sourceEffectIds: [normalized.control.sourceEffectId],
          ruleId,
          producedEntityIds: [id],
        }),
      });
    }
    return id;
  }

  function ensureControlTargetBlock(target, role) {
    return ensureControlBlockId(configuredTargetBlock(target, role));
  }

  function controlEffectRecord() {
    return {
      sourceEffectId: normalized.control.sourceEffectId,
      origin: bundle.origin,
      operation: null,
    };
  }

  function resolveControlCondition(effect, condition) {
    if (!condition || typeof condition !== 'object') return null;
    if (condition.kind === 'temporary') {
      const planned = temporaryDefinitions.get(`temporary:${String(condition.temporaryId ?? '')}`);
      if (planned) return planned.valueId;
      const type = rawBitvectorType(condition.widthBits);
      return createUnknownValue(effect, type, 'control-condition', 'control-condition-temporary-unresolved', condition, 0);
    }
    if (condition.kind === 'register' || condition.kind === 'flag') {
      const widthBits = positiveInteger(condition.widthBits) ?? (condition.kind === 'flag' ? 1 : null);
      if (widthBits == null) return null;
      return implicitStateRead(effect, { ...condition, widthBits }, 'control-condition', 0);
    }
    if (condition.kind === 'absolute-address') {
      const widthBits = positiveInteger(condition.widthBits) ?? positiveInteger(context.addressWidthBits);
      if (widthBits == null) return null;
      return rawConstant(effect, condition.value, widthBits, 'control-condition', 0, 'code');
    }
    if (condition.kind === 'bitvector') return rawConstant(effect, condition.value, condition.widthBits, 'control-condition', 0);
    return null;
  }

  function lowerControl() {
    const control = bundle.controlEffect;
    const effect = controlEffectRecord();
    if (control.kind === 'fallthrough') return;
    if (control.kind === 'branch') {
      const rawTargets = control.targets?.length ? control.targets : control.target == null ? [] : [control.target];
      if (!rawTargets.length) {
        emitUnknownEffects(effect, 'branch-target-missing', ['control'], { control });
        return;
      }
      const targets = rawTargets.map((target, index) => ensureControlTargetBlock(target, `branch-${index}`));
      const nodeId = nodeIdFor(effect, 'branch-control');
      addNode({
        id: nodeId,
        kind: 'branch',
        blockId,
        targets,
        attributes: machineAttributes(effect, { machineControlEffect: control }),
        sourceEffectIds: [effect.sourceEffectId],
        origin: effectOrigin(effect, 'branch-control-projection', [nodeId]),
      });
      return;
    }
    if (control.kind === 'conditional-branch') {
      const conditionId = resolveControlCondition(effect, control.condition);
      const rawTargets = control.targets?.length ? [...control.targets] : control.target == null ? [] : [control.target];
      if (control.fallthrough != null) rawTargets.push(control.fallthrough);
      else rawTargets.push({ kind: 'fallthrough-continuation', instructionId: bundle.instructionId });
      if (!conditionId || rawTargets.length < 2) {
        emitUnknownEffects(effect, 'conditional-branch-not-fully-representable', ['control'], { control });
        return;
      }
      const targets = unique(rawTargets.map((target, index) => ensureControlTargetBlock(target, index === rawTargets.length - 1 ? 'fallthrough' : `branch-${index}`)));
      const nodeId = nodeIdFor(effect, 'conditional-branch-control');
      addNode({
        id: nodeId,
        kind: 'conditional-branch',
        blockId,
        inputs: [conditionId],
        targets,
        attributes: machineAttributes(effect, { machineControlEffect: control }),
        sourceEffectIds: [effect.sourceEffectId],
        origin: effectOrigin(effect, 'conditional-branch-control-projection', [nodeId]),
      });
      return;
    }
    if (control.kind === 'call') {
      const targetValueIds = [];
      if (control.target && typeof control.target === 'object') {
        const targetId = resolveControlCondition(effect, control.target);
        if (targetId) targetValueIds.push(targetId);
      }
      const nodeId = nodeIdFor(effect, 'call-control');
      const categories = ['state', 'memory', 'control'];
      const origin = effectOrigin(effect, 'abi-neutral-call-projection', [nodeId]);
      addNode({
        id: nodeId,
        kind: 'call',
        blockId,
        inputs: targetValueIds,
        call: {
          targetValueIds,
          targetEntityIds: [],
          arguments: [],
          returns: [],
          stateReads: [],
          stateWrites: [],
          memoryRead: { scope: 'unknown', detail: { reason: 'callee-memory-read-effects-require-contextual-summary' } },
          memoryWrite: { scope: 'unknown', detail: { reason: 'callee-memory-write-effects-require-contextual-summary' } },
          controlEffects: [control],
          determinism: 'unknown',
          noreturn: 'unknown',
          mayThrow: 'unknown',
          summarySource: 'machine-effects-abi-neutral-call',
          completeness: 'unknown',
          unknownEffects: {
            reason: 'ABI and callee effects are outside MachineEffects-to-SemanticIR lowering',
            categories,
          },
        },
        completeness: 'partial',
        unknown: {
          reason: 'ABI and callee effects are outside MachineEffects-to-SemanticIR lowering',
          categories,
          knownParts: { machineControlEffect: control },
        },
        attributes: machineAttributes(effect, { machineControlEffect: control }),
        sourceEffectIds: [effect.sourceEffectId],
        origin,
      });
      addIssue('call-context-effects-not-enriched', categories, { control });
      return;
    }
    if (control.kind === 'return') {
      const nodeId = nodeIdFor(effect, 'return-control');
      addNode({
        id: nodeId,
        kind: 'return',
        blockId,
        attributes: machineAttributes(effect, { machineControlEffect: control }),
        sourceEffectIds: [effect.sourceEffectId],
        origin: effectOrigin(effect, 'return-control-projection', [nodeId]),
      });
      return;
    }
    if (control.kind === 'trap') {
      const nodeId = nodeIdFor(effect, 'trap-control');
      addNode({
        id: nodeId,
        kind: 'trap',
        blockId,
        attributes: machineAttributes(effect, { machineControlEffect: control }),
        sourceEffectIds: [effect.sourceEffectId],
        origin: effectOrigin(effect, 'trap-control-projection', [nodeId]),
      });
      return;
    }
    if (control.kind === 'indirect') {
      const targetValueIds = [];
      if (control.target && typeof control.target === 'object') {
        const targetId = resolveControlCondition(effect, control.target);
        if (targetId) targetValueIds.push(targetId);
      }
      const candidates = configuredTargetBlocks(control.target, 'indirect');
      const targetState = candidates.length ? 'candidate' : 'unknown';
      const targets = candidates.length
        ? candidates.map((id) => ensureControlBlockId(id, 'indirect-control-candidate-placeholder'))
        : [ensureControlTargetBlock({
          kind: 'unresolved-indirect-successor',
          instructionId: bundle.instructionId,
          target: control.target ?? null,
        }, 'indirect-unknown')];
      const nodeId = nodeIdFor(effect, 'indirect-control');
      const knownParts = {
        control,
        targetValueIds,
        targetState,
        candidateCount: candidates.length,
      };
      addNode({
        id: nodeId,
        kind: 'unknown-control-effect',
        blockId,
        inputs: targetValueIds,
        targets,
        completeness: 'partial',
        unknown: {
          reason: 'unresolved-indirect-control-flow',
          categories: ['control'],
          knownParts,
        },
        attributes: machineAttributes(effect, {
          machineControlEffect: control,
          indirectControl: {
            targetValueIds,
            targetState,
            candidateCount: candidates.length,
          },
        }),
        sourceEffectIds: [effect.sourceEffectId],
        origin: effectOrigin(effect, 'indirect-control-projection', [nodeId]),
      });
      addIssue('unresolved-indirect-control-flow', ['control'], knownParts);
      return;
    }
    emitUnknownEffects(effect, control.reason ?? 'unknown-machine-control-effect', ['control'], { control }, bundle.completeness === 'unknown' ? 'unknown' : 'partial');
  }

  lowerControl();

  if (bundle.statePreservation != null || (nodes.length === 0 && (bundle.possibleFaults.length || bundle.metadata != null))) {
    const effect = {
      sourceEffectId: normalized.annotation?.sourceEffectId ?? normalized.control.sourceEffectId,
      origin: bundle.origin,
      operation: null,
    };
    const nodeId = nodeIdFor(effect, 'bundle-annotation');
    addNode({
      id: nodeId,
      kind: 'intrinsic',
      blockId,
      operator: 'machine-effects.annotation',
      intrinsic: {
        inputs: [],
        outputs: [],
        stateReads: [],
        stateWrites: [],
        memoryRead: { scope: 'none' },
        memoryWrite: { scope: 'none' },
        controlEffects: [],
        determinism: 'deterministic',
        symbolicDetail: 'summary-only',
      },
      attributes: machineAttributes(effect, {
        ...(bundle.statePreservation == null ? {} : { statePreservation: bundle.statePreservation }),
        ...(bundle.possibleFaults.length ? { possibleFaults: bundle.possibleFaults } : {}),
      }),
      sourceEffectIds: [effect.sourceEffectId],
      origin: effectOrigin(effect, 'bundle-annotation-projection', [nodeId]),
    });
  }

  if (bundle.completeness === 'partial' && issues.size === 0) {
    addIssue('machine-effects-bundle-is-partial', bundle.unknownEffects?.categories ?? ['other'], bundle.unknownEffects ?? null);
  }
  if (bundle.completeness === 'unknown' && issues.size === 0) {
    addIssue('machine-effects-bundle-is-unknown', bundle.unknownEffects?.categories ?? ['other'], bundle.unknownEffects ?? null, 'unknown');
  }

  const functionOrigin = createLoweringOrigin(
    mergeOriginSets(bundle.origin, ...nodes.map((node) => node.origin), ...values.map((value) => value.origin)),
    {
      sourceEffectIds: allSourceEffectIds,
      ruleId: 'bundle-to-semantic-ir-function',
      producedEntityIds: [functionId],
    },
  );

  return createSemanticIrFunction({
    functionId,
    entryBlockId,
    blocks: [...blocks.values()],
    values,
    nodes,
    completeness,
    unknowns: [...issues.values()],
    origin: functionOrigin,
  }, options);
}

export const lowerMachineEffectsToSemanticIr = lowerMachineEffectBundleToSemanticIr;