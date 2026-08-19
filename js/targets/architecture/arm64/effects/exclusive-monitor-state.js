import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';

export const ARM64_EXCLUSIVE_MONITOR_STATE = Object.freeze({
  valid:Object.freeze({ registerId:'arm64.exclusive-monitor.valid', widthBits:1 }),
  address:Object.freeze({ registerId:'arm64.exclusive-monitor.address', widthBits:64 }),
  width:Object.freeze({ registerId:'arm64.exclusive-monitor.width', widthBits:8 }),
});

const EXCLUSIVE_LOAD = /^lda?xr(?:b|h)?$/;
const EXCLUSIVE_STORE = /^stl?xr(?:b|h)?$/;

function mnemonicOf(instruction) {
  return String(instruction?.mnemonic || '').trim().toLowerCase();
}

function temp(id, widthBits) {
  return createTemporaryValue(id, createBitVectorValue(widthBits));
}

function register(definition) {
  return createRegisterValue(definition.registerId, definition.widthBits, { view:definition.registerId });
}

function stateRead(definition, id) {
  const value = temp(id, definition.widthBits);
  return {
    value,
    operation:createMachineOperation({
      kind:'register-read',
      register:register(definition),
      value,
      metadata:{ architecture:'arm64', hiddenState:'exclusive-monitor', stateField:definition.registerId },
    }),
  };
}

function stateWrite(definition, value, stateTransition) {
  return createMachineOperation({
    kind:'register-write',
    register:register(definition),
    value,
    metadata:{ architecture:'arm64', hiddenState:'exclusive-monitor', stateField:definition.registerId, stateTransition },
  });
}

function currentAddressValue() {
  // Current exclusive instructions are accepted only with base-only addressing,
  // and atomic.js materializes that base as this typed temporary.
  return temp('atomic.addr.base', 64);
}

function monitorReads(prefix) {
  const valid = stateRead(ARM64_EXCLUSIVE_MONITOR_STATE.valid, `${prefix}.valid`);
  const address = stateRead(ARM64_EXCLUSIVE_MONITOR_STATE.address, `${prefix}.address`);
  const width = stateRead(ARM64_EXCLUSIVE_MONITOR_STATE.width, `${prefix}.width`);
  return { valid, address, width, operations:[valid.operation, address.operation, width.operation] };
}

function rebuiltIntrinsic(operation, { inputs = operation.effectSummary.inputs, outputs = operation.effectSummary.outputs, metadata = operation.metadata } = {}) {
  const summary = operation.effectSummary;
  return createMachineOperation({
    kind:'intrinsic',
    ...(operation.id == null ? {} : { id:operation.id }),
    intrinsicId:operation.intrinsicId,
    effectSummary:createIntrinsicEffectSummary({
      inputs,
      outputs,
      registersRead:summary.registersRead,
      registersWritten:summary.registersWritten,
      memoryRead:summary.memoryRead,
      memoryWrite:summary.memoryWrite,
      controlEffects:summary.controlEffects,
      determinism:summary.determinism,
      symbolicDetail:summary.symbolicDetail,
    }),
    ...(metadata == null ? {} : { metadata }),
  });
}

function stateContract(metadata = {}) {
  return {
    ...metadata,
    hiddenState:'exclusive-monitor',
    monitorState:Object.freeze({
      valid:ARM64_EXCLUSIVE_MONITOR_STATE.valid,
      address:ARM64_EXCLUSIVE_MONITOR_STATE.address,
      width:ARM64_EXCLUSIVE_MONITOR_STATE.width,
      reservationGranule:Object.freeze({ kind:'implementation-defined', relation:'unknown-until-proven' }),
    }),
  };
}

function widthBitsOf(operation, bundle) {
  const raw = Number(operation?.metadata?.widthBits ?? bundle?.metadata?.widthBits ?? 0);
  return [8,16,32,64].includes(raw) ? raw : null;
}

function rebuildBundle(bundle, operations, metadataPatch = {}) {
  return createMachineEffectBundle({
    instructionId:bundle.instructionId,
    architectureId:bundle.architectureId,
    mode:bundle.mode,
    operations,
    controlEffect:bundle.controlEffect,
    possibleFaults:bundle.possibleFaults,
    origin:bundle.origin,
    completeness:bundle.completeness,
    ...(bundle.unknownEffects == null ? {} : { unknownEffects:bundle.unknownEffects }),
    ...(bundle.statePreservation == null ? {} : { statePreservation:bundle.statePreservation }),
    metadata:{ ...(bundle.metadata || {}), ...metadataPatch },
  });
}

function decorateExclusiveLoad(bundle) {
  const setIndex = bundle.operations.findIndex((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64.exclusive-monitor-set');
  if (setIndex < 0) return bundle;
  const set = bundle.operations[setIndex];
  const widthBits = widthBitsOf(set, bundle);
  if (widthBits == null) return bundle;
  const address = currentAddressValue();
  const operations = bundle.operations.slice();
  operations[setIndex] = rebuiltIntrinsic(set, {
    inputs:[...set.effectSummary.inputs, address],
    metadata:stateContract({ ...(set.metadata || {}), reservationAddressInput:'atomic.addr.base', reservationWidthBits:widthBits }),
  });
  operations.splice(setIndex + 1, 0,
    stateWrite(ARM64_EXCLUSIVE_MONITOR_STATE.valid, createBitVectorValue(1, 1), 'set'),
    stateWrite(ARM64_EXCLUSIVE_MONITOR_STATE.address, address, 'set'),
    stateWrite(ARM64_EXCLUSIVE_MONITOR_STATE.width, createBitVectorValue(8, widthBits), 'set'),
  );
  return rebuildBundle(bundle, operations, {
    exclusiveMonitorState:'typed-canonical',
    exclusiveMonitorTransition:'set',
    reservationGranule:'implementation-defined',
  });
}

function decorateExclusiveStore(bundle) {
  const storeIndex = bundle.operations.findIndex((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64.exclusive-store-conditional');
  if (storeIndex < 0) return bundle;
  const store = bundle.operations[storeIndex];
  const reads = monitorReads('exclusive.monitor.before-store');
  const currentAddress = currentAddressValue();
  const operations = bundle.operations.slice();
  operations.splice(storeIndex, 0, ...reads.operations);
  const adjustedIndex = storeIndex + reads.operations.length;
  operations[adjustedIndex] = rebuiltIntrinsic(store, {
    inputs:[...store.effectSummary.inputs, reads.valid.value, reads.address.value, reads.width.value, currentAddress],
    metadata:stateContract({
      ...(store.metadata || {}),
      monitorInputOrder:['valid','reservation-address','reservation-width','current-address'],
      reservationAddressRelation:'must-be-compatible-with-current-exclusive-reservation-granule',
      successRemainsNondeterministicWhenGranule-or-global-monitor-state-is-unknown:true,
    }),
  });
  // A store-exclusive attempt consumes the local reservation regardless of the
  // returned status. Preserve stale address/width evidence, but version `valid`
  // to false so later stores reach this transition rather than the old LDXR.
  operations.splice(adjustedIndex + 1, 0,
    stateWrite(ARM64_EXCLUSIVE_MONITOR_STATE.valid, createBitVectorValue(1, 0), 'store-exclusive-consumed'),
  );
  return rebuildBundle(bundle, operations, {
    exclusiveMonitorState:'typed-canonical',
    exclusiveMonitorTransition:'consume-after-store-exclusive',
    reservationGranule:'implementation-defined',
  });
}

function decorateClearExclusive(bundle) {
  const clearIndex = bundle.operations.findIndex((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64.exclusive-monitor-clear');
  if (clearIndex < 0) return bundle;
  const clear = bundle.operations[clearIndex];
  const reads = monitorReads('exclusive.monitor.before-clear');
  const operations = bundle.operations.slice();
  operations.splice(clearIndex, 0, ...reads.operations);
  const adjustedIndex = clearIndex + reads.operations.length;
  operations[adjustedIndex] = rebuiltIntrinsic(clear, {
    inputs:[...clear.effectSummary.inputs, reads.valid.value, reads.address.value, reads.width.value],
    metadata:stateContract({ ...(clear.metadata || {}), monitorInputOrder:['valid','reservation-address','reservation-width'] }),
  });
  operations.splice(adjustedIndex + 1, 0,
    stateWrite(ARM64_EXCLUSIVE_MONITOR_STATE.valid, createBitVectorValue(1, 0), 'clear'),
  );
  return rebuildBundle(bundle, operations, {
    exclusiveMonitorState:'typed-canonical',
    exclusiveMonitorTransition:'clear',
    reservationGranule:'implementation-defined',
  });
}

export function decorateArm64ExclusiveMonitorEffects(instruction, bundle) {
  if (!bundle) return bundle;
  const mnemonic = mnemonicOf(instruction);
  if (EXCLUSIVE_LOAD.test(mnemonic)) return decorateExclusiveLoad(bundle);
  if (EXCLUSIVE_STORE.test(mnemonic)) return decorateExclusiveStore(bundle);
  if (mnemonic === 'clrex') return decorateClearExclusive(bundle);
  return bundle;
}
