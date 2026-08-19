from pathlib import Path

p = Path('js/targets/architecture/arm64/effects/atomic.js')
text = p.read_text()
old = """  createMachineOperation,
  createMemoryAccess,
} from '../../../../semantics/effects/index.js';
"""
new = """  createMachineOperation,
  createMemoryAccess,
  createRegisterValue,
} from '../../../../semantics/effects/index.js';
"""
assert text.count(old) == 1, f'atomic import anchor={text.count(old)}'
text = text.replace(old,new,1)
anchor = "function valueOp(opcode, input, fromBits, toBits, id, metadata = {}) {\n"
helpers = """const EXCLUSIVE_MONITOR_STATE = Object.freeze([
  ['arm64.exclusive.valid', 1],
  ['arm64.exclusive.address', 64],
  ['arm64.exclusive.size', 16],
  ['arm64.exclusive.token', 64],
]);

function exclusiveStateRead(operations, prefix) {
  const values = [];
  for (const [registerId, bits] of EXCLUSIVE_MONITOR_STATE) {
    const value = arm64Temporary(`${prefix}.${registerId}`, bits);
    operations.push(createMachineOperation({
      kind:'register-read', register:createRegisterValue(registerId, bits, { view:registerId }), value,
      metadata:{ architecture:'arm64', purpose:'exclusive-monitor-state' },
    }));
    values.push(value);
  }
  return values;
}
function exclusiveStateWrite(operations, values, metadata = {}) {
  EXCLUSIVE_MONITOR_STATE.forEach(([registerId, bits], index) => operations.push(createMachineOperation({
    kind:'register-write', register:createRegisterValue(registerId, bits, { view:registerId }), value:values[index],
    metadata:{ architecture:'arm64', purpose:'exclusive-monitor-state', ...metadata },
  })));
}
function exclusiveAddressValue(addressing) {
  return addressing.readOperations.find((operation) => operation.kind === 'register-read' && operation.register?.registerId === addressing.base.physicalId)?.value || null;
}

"""
assert text.count(anchor) == 1, f'helper anchor={text.count(anchor)}'
text = text.replace(anchor, helpers+anchor, 1)
old = """  const raw = arm64Temporary('exclusive.load.raw', widthBits);
  const monitor = arm64Temporary('exclusive.monitor.token', 1);
  const ops = [...addr.readOperations];
"""
new = """  const raw = arm64Temporary('exclusive.load.raw', widthBits);
  const monitor = arm64Temporary('exclusive.monitor.token', 64);
  const ops = [...addr.readOperations];
  const addressValue = exclusiveAddressValue(addr);
  if (!addressValue) return partial(decoded, context, 'exclusive load effective address state is unavailable');
"""
assert text.count(old) == 1, f'load monitor anchor={text.count(old)}'
text = text.replace(old,new,1)
old = """    effectSummary:intrinsicSummary({
      outputs:[monitor],
      registersRead:[addr.base.physicalId],
      determinism:'deterministic',
    }),
    metadata:{ addressExpr:addr.addressExpr, widthBits, hiddenState:'exclusive-monitor' },
  }));
"""
new = """    effectSummary:intrinsicSummary({
      inputs:[addressValue, createBitVectorValue(16, BigInt(widthBits))],
      outputs:[monitor],
      registersRead:[addr.base.physicalId],
      registersWritten:EXCLUSIVE_MONITOR_STATE.map(([id]) => id),
      determinism:'deterministic',
    }),
    metadata:{ addressExpr:addr.addressExpr, widthBits, state:'exclusive-monitor' },
  }));
  exclusiveStateWrite(ops, [
    createBitVectorValue(1, 1n), addressValue, createBitVectorValue(16, BigInt(widthBits)), monitor,
  ], { transition:'set' });
"""
assert text.count(old) == 1, f'load intrinsic anchor={text.count(old)}'
text = text.replace(old,new,1)
old = """  const statusValue = arm64Temporary('exclusive.store.status', 32);
  const ops = [...addr.readOperations, ...dataRead.operations];
  ops.push(createMachineOperation({
"""
new = """  const statusValue = arm64Temporary('exclusive.store.status', 32);
  const nextMonitorToken = arm64Temporary('exclusive.store.next-monitor-token', 64);
  const ops = [...addr.readOperations, ...dataRead.operations];
  const addressValue = exclusiveAddressValue(addr);
  if (!addressValue) return partial(decoded, context, 'exclusive store effective address state is unavailable');
  const monitorState = exclusiveStateRead(ops, 'exclusive.store.monitor');
  ops.push(createMachineOperation({
"""
assert text.count(old) == 1, f'store state anchor={text.count(old)}'
text = text.replace(old,new,1)
old = """    effectSummary:intrinsicSummary({
      inputs:[dataRead.value],
      outputs:[statusValue],
      registersRead:[addr.base.physicalId, dataRead.registerId],
      memoryWrite:{ scope:'accesses', accesses:[memAccess] },
      determinism:'nondeterministic',
    }),
"""
new = """    effectSummary:intrinsicSummary({
      inputs:[...monitorState, addressValue, createBitVectorValue(16, BigInt(widthBits)), dataRead.value],
      outputs:[statusValue, nextMonitorToken],
      registersRead:[addr.base.physicalId, dataRead.registerId, ...EXCLUSIVE_MONITOR_STATE.map(([id]) => id)],
      registersWritten:EXCLUSIVE_MONITOR_STATE.map(([id]) => id),
      memoryWrite:{ scope:'accesses', accesses:[memAccess] },
      determinism:'nondeterministic',
    }),
"""
assert text.count(old) == 1, f'store intrinsic anchor={text.count(old)}'
text = text.replace(old,new,1)
old = """  try { ops.push(...writeLoadedGp(status, statusValue, 32, 'exclusive.store.status')); }
  catch (error) { return partial(decoded, context, error.message); }
"""
new = """  exclusiveStateWrite(ops, [
    createBitVectorValue(1, 0n), createBitVectorValue(64, 0n), createBitVectorValue(16, 0n), nextMonitorToken,
  ], { transition:'clear-after-store-attempt' });
  try { ops.push(...writeLoadedGp(status, statusValue, 32, 'exclusive.store.status')); }
  catch (error) { return partial(decoded, context, error.message); }
"""
assert text.count(old) == 1, f'store clear anchor={text.count(old)}'
p.write_text(text.replace(old,new,1))

p = Path('js/targets/architecture/arm64/effects/system.js')
text = p.read_text()
anchor = "function clrex(instruction, context, ops) {\n"
helpers = """const EXCLUSIVE_MONITOR_STATE = Object.freeze([
  ['arm64.exclusive.valid', 1],
  ['arm64.exclusive.address', 64],
  ['arm64.exclusive.size', 16],
  ['arm64.exclusive.token', 64],
]);
function readExclusiveMonitor(operations) {
  return EXCLUSIVE_MONITOR_STATE.map(([registerId,bits]) => {
    const value = temp(`clrex:${registerId}`, createBitVectorValue(bits));
    operations.push(createMachineOperation({
      kind:'register-read', register:createRegisterValue(registerId,bits,{view:registerId}), value,
      metadata:{ architecture:'arm64', purpose:'exclusive-monitor-state' },
    }));
    return value;
  });
}
function clearExclusiveMonitor(operations, token) {
  const values = [createBitVectorValue(1,0n), createBitVectorValue(64,0n), createBitVectorValue(16,0n), token];
  EXCLUSIVE_MONITOR_STATE.forEach(([registerId,bits], index) => operations.push(createMachineOperation({
    kind:'register-write', register:createRegisterValue(registerId,bits,{view:registerId}), value:values[index],
    metadata:{ architecture:'arm64', purpose:'exclusive-monitor-state', transition:'clear' },
  })));
}

"""
assert text.count(anchor) == 1, f'system helper anchor={text.count(anchor)}'
text = text.replace(anchor, helpers+anchor, 1)
old = """function clrex(instruction, context, ops) {
  const imm = immediate(ops[0]);
  const operation = completeIntrinsic({
    id:'arm64.system.clrex',
    inputs:imm ? [imm] : [], outputs:[], registersRead:[], registersWritten:[],
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[],
    determinism:'deterministic', symbolicDetail:'summary-only',
    metadata:{ architecturalStateWritten:'local-exclusive-monitor', immediatePresent:!!imm },
  });
  return bundle(instruction, context, { operations:[operation], completeness:'exact-with-intrinsic' });
}
"""
new = """function clrex(instruction, context, ops) {
  const imm = immediate(ops[0]);
  const operations = [];
  const monitorState = readExclusiveMonitor(operations);
  const nextToken = temp('clrex:next-monitor-token', createBitVectorValue(64));
  const operation = completeIntrinsic({
    id:'arm64.system.clrex',
    inputs:[...monitorState, ...(imm ? [imm] : [])], outputs:[nextToken],
    registersRead:EXCLUSIVE_MONITOR_STATE.map(([id]) => id),
    registersWritten:EXCLUSIVE_MONITOR_STATE.map(([id]) => id),
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[],
    determinism:'deterministic', symbolicDetail:'summary-only',
    metadata:{ architecturalStateWritten:'local-exclusive-monitor', immediatePresent:!!imm },
  });
  operations.push(operation);
  clearExclusiveMonitor(operations, nextToken);
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic' });
}
"""
assert text.count(old) == 1, f'clrex body anchor={text.count(old)}'
p.write_text(text.replace(old,new,1))
