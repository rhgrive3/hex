from pathlib import Path

atomic = Path('js/targets/architecture/arm64/effects/atomic.js')
text = atomic.read_text()
old_import = """  createMachineOperation,\n  createMemoryAccess,\n} from '../../../../semantics/effects/index.js';\n"""
new_import = """  createMachineOperation,\n  createMemoryAccess,\n  createRegisterValue,\n} from '../../../../semantics/effects/index.js';\n"""
if text.count(old_import) != 1:
    raise SystemExit(f'#929 import anchor expected once, found {text.count(old_import)}')
text = text.replace(old_import, new_import, 1)

anchor = """function valueOp(opcode, input, fromBits, toBits, id, metadata = {}) {\n"""
helpers = r'''const EXCLUSIVE_MONITOR_STATE = Object.freeze({
  valid:Object.freeze({ registerId:'exclusive.monitor.valid', widthBits:1 }),
  address:Object.freeze({ registerId:'exclusive.monitor.address', widthBits:64 }),
  width:Object.freeze({ registerId:'exclusive.monitor.width', widthBits:16 }),
  context:Object.freeze({ registerId:'exclusive.monitor.context', widthBits:64 }),
});

function monitorStateRead(name, temporaryId) {
  const state = EXCLUSIVE_MONITOR_STATE[name];
  if (!state) throw new TypeError('arm64-exclusive-monitor-state-name-invalid');
  const value = arm64Temporary(temporaryId, state.widthBits);
  return {
    value,
    operation:createMachineOperation({
      kind:'register-read',
      register:createRegisterValue(state.registerId, state.widthBits),
      value,
      metadata:{ architecture:'arm64', hiddenState:'exclusive-monitor', monitorField:name },
    }),
  };
}

function monitorStateWrite(name, value, transition) {
  const state = EXCLUSIVE_MONITOR_STATE[name];
  if (!state) throw new TypeError('arm64-exclusive-monitor-state-name-invalid');
  return createMachineOperation({
    kind:'register-write',
    register:createRegisterValue(state.registerId, state.widthBits),
    value,
    metadata:{ architecture:'arm64', hiddenState:'exclusive-monitor', monitorField:name, transition },
  });
}

function readExclusiveMonitor(prefix) {
  const valid = monitorStateRead('valid', `${prefix}.valid`);
  const address = monitorStateRead('address', `${prefix}.address`);
  const width = monitorStateRead('width', `${prefix}.width`);
  const context = monitorStateRead('context', `${prefix}.context`);
  return {
    operations:[valid.operation, address.operation, width.operation, context.operation],
    values:{ valid:valid.value, address:address.value, width:width.value, context:context.value },
  };
}

function clearExclusiveMonitorState(transition) {
  return [
    monitorStateWrite('valid', createBitVectorValue(1, 0n), transition),
    monitorStateWrite('address', createBitVectorValue(64, 0n), transition),
    monitorStateWrite('width', createBitVectorValue(16, 0n), transition),
    monitorStateWrite('context', createBitVectorValue(64, 0n), transition),
  ];
}

'''
if text.count(anchor) != 1:
    raise SystemExit(f'#929 helper anchor expected once, found {text.count(anchor)}')
text = text.replace(anchor, helpers + anchor, 1)

start = text.index('function exclusiveLoad(decoded, context, match) {')
end = text.index('\nfunction exclusiveStore(decoded, context, match) {', start)
new_load = r'''function exclusiveLoad(decoded, context, match) {
  const ctx = contextOf(decoded, context);
  const dest = registers(decoded)[0];
  const sizeSuffix = match[1] || '';
  if (!registerMatchesSizeSuffix(dest, sizeSuffix)) return partial(decoded, context, 'exclusive load destination width is invalid');
  const widthBits = widthFromSuffixOrReg(sizeSuffix, dest);
  if (!widthBits) return partial(decoded, context, 'exclusive load width is unsupported');

  let addr;
  try { addr = buildArm64EffectiveAddress(decoded, { prefix:'atomic.addr' }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code);
    throw error;
  }
  if (!isBaseOnly(addr)) return partial(decoded, context, 'exclusive loads require base-only addressing');

  const acquire = mnemonicOf(decoded).startsWith('ldaxr');
  const ordering = acquire ? 'acquire' : 'relaxed';
  const memAccess = access(ctx, addr.addressExpr, widthBits, ordering);
  const raw = arm64Temporary('exclusive.load.raw', widthBits);
  // Base-only exclusive addressing means the already materialized base value is
  // the exact reservation address. Reuse that temporary so Semantic IR sees one
  // typed def-use chain rather than a metadata-only address description.
  const reservationAddress = arm64Temporary('atomic.addr.base', 64);
  const monitorContext = arm64Temporary('exclusive.monitor.context.new', 64);
  const ops = [...addr.readOperations];
  ops.push(createMachineOperation({
    kind:'memory-read', access:memAccess, value:raw,
    metadata:{ architecture:'arm64', exclusive:true, ordering, tagChecked:tagChecked(addr) },
  }));
  ops.push(createMachineOperation({
    kind:'intrinsic',
    intrinsicId:'arm64.exclusive-monitor-set',
    effectSummary:intrinsicSummary({
      inputs:[reservationAddress],
      outputs:[monitorContext],
      registersRead:[addr.base.physicalId],
      determinism:'nondeterministic',
    }),
    metadata:{
      addressExpr:addr.addressExpr,
      widthBits,
      hiddenState:'exclusive-monitor',
      stateModel:'canonical-physical-state-v1',
      implementationContext:'opaque-nondeterministic-token',
    },
  }));
  ops.push(
    monitorStateWrite('valid', createBitVectorValue(1, 1n), 'exclusive-load-set'),
    monitorStateWrite('address', reservationAddress, 'exclusive-load-set'),
    monitorStateWrite('width', createBitVectorValue(16, BigInt(widthBits)), 'exclusive-load-set'),
    monitorStateWrite('context', monitorContext, 'exclusive-load-set'),
  );
  try { ops.push(...writeLoadedGp(dest, raw, widthBits, 'exclusive.load')); }
  catch (error) { return partial(decoded, context, error.message); }

  return bundle(decoded, context, {
    operations:ops,
    possibleFaults:faults('read', widthBits / 8, addr.addressExpr, addr),
    completeness:'exact-with-intrinsic',
    metadata:{ family:'arm64-atomic', kind:'exclusive-load', mnemonic:mnemonicOf(decoded), widthBits, ordering, addressing:addr.metadata, monitorState:'canonical-physical-state-v1' },
  });
}
'''
text = text[:start] + new_load + text[end:]

start = text.index('function exclusiveStore(decoded, context, match) {')
end = text.index('\nfunction atomicRmw(decoded, context, { family, suffix = \'\', sizeSuffix = \'\' }) {', start)
new_store = r'''function exclusiveStore(decoded, context, match) {
  const ctx = contextOf(decoded, context);
  const regs = registers(decoded);
  const status = regs[0];
  const data = regs[1];
  const sizeSuffix = match[1] || '';
  if (!status || !isGpOrZero(status) || status.bits !== 32 || !registerMatchesSizeSuffix(data, sizeSuffix)) {
    return partial(decoded, context, 'exclusive store requires W status and correctly-sized GP data registers');
  }
  const widthBits = widthFromSuffixOrReg(sizeSuffix, data);
  if (!widthBits) return partial(decoded, context, 'exclusive store width is unsupported');

  let addr;
  try { addr = buildArm64EffectiveAddress(decoded, { prefix:'atomic.addr' }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code);
    throw error;
  }
  if (!isBaseOnly(addr)) return partial(decoded, context, 'exclusive stores require base-only addressing');

  const release = mnemonicOf(decoded).startsWith('stlxr');
  const ordering = release ? 'release' : 'relaxed';
  const memAccess = access(ctx, addr.addressExpr, widthBits, ordering);
  let dataRead;
  try { dataRead = readRegister(data, 'exclusive.store.data', widthBits); }
  catch (error) { return partial(decoded, context, error.message); }
  const reservationAddress = arm64Temporary('atomic.addr.base', 64);
  const monitor = readExclusiveMonitor('exclusive.store.monitor');
  const statusValue = arm64Temporary('exclusive.store.status', 32);
  const ops = [...addr.readOperations, ...dataRead.operations, ...monitor.operations];
  ops.push(createMachineOperation({
    kind:'intrinsic',
    intrinsicId:'arm64.exclusive-store-conditional',
    effectSummary:intrinsicSummary({
      inputs:[
        dataRead.value,
        reservationAddress,
        monitor.values.valid,
        monitor.values.address,
        monitor.values.width,
        monitor.values.context,
      ],
      outputs:[statusValue],
      registersRead:[addr.base.physicalId, dataRead.registerId, ...Object.values(EXCLUSIVE_MONITOR_STATE).map((state) => state.registerId)],
      memoryWrite:{ scope:'accesses', accesses:[memAccess] },
      determinism:'nondeterministic',
    }),
    metadata:{
      conditional:true,
      condition:'exclusive-monitor-pass',
      successValue:0,
      failureValue:1,
      widthBits,
      ordering,
      hiddenState:'exclusive-monitor',
      stateModel:'canonical-physical-state-v1',
      reservationInputs:{ valid:true, address:true, width:true, implementationContext:true, attemptedAddress:true },
      implementationConditions:'represented-by-opaque-monitor-context-and-nondeterministic-status',
      tagChecked:tagChecked(addr),
    },
  }));
  // A Store-Exclusive attempt clears the local exclusive monitor irrespective of
  // whether the conditional memory write succeeds. Make that transition an
  // ordinary physical-state definition so later LDXR/STXR/CLREX are linked by SSA.
  ops.push(...clearExclusiveMonitorState('exclusive-store-attempt-clear'));
  try { ops.push(...writeLoadedGp(status, statusValue, 32, 'exclusive.store.status')); }
  catch (error) { return partial(decoded, context, error.message); }

  return bundle(decoded, context, {
    operations:ops,
    possibleFaults:faults('write', widthBits / 8, addr.addressExpr, addr),
    completeness:'exact-with-intrinsic',
    metadata:{ family:'arm64-atomic', kind:'exclusive-store', mnemonic:mnemonicOf(decoded), widthBits, ordering, addressing:addr.metadata, monitorState:'canonical-physical-state-v1' },
  });
}
'''
text = text[:start] + new_store + text[end:]

start = text.index('function clearExclusive(decoded, context) {')
end = text.index('\nexport function isArm64AtomicInstruction', start)
new_clear = r'''function clearExclusive(decoded, context) {
  const monitor = readExclusiveMonitor('exclusive.clear.monitor');
  return bundle(decoded, context, {
    operations:[
      ...monitor.operations,
      createMachineOperation({
        kind:'intrinsic',
        intrinsicId:'arm64.exclusive-monitor-clear',
        effectSummary:intrinsicSummary({
          inputs:[monitor.values.valid, monitor.values.address, monitor.values.width, monitor.values.context],
          registersRead:Object.values(EXCLUSIVE_MONITOR_STATE).map((state) => state.registerId),
          determinism:'deterministic',
        }),
        metadata:{ architecture:'arm64', hiddenState:'exclusive-monitor', stateModel:'canonical-physical-state-v1' },
      }),
      ...clearExclusiveMonitorState('clrex-clear'),
    ],
    completeness:'exact-with-intrinsic',
    metadata:{ family:'arm64-atomic', kind:'exclusive-monitor-clear', mnemonic:'clrex', monitorState:'canonical-physical-state-v1' },
  });
}
'''
text = text[:start] + new_clear + text[end:]
atomic.write_text(text)

arch = Path('js/targets/architecture/index.js')
text = arch.read_text()
old = """  Object.freeze({ id:'nzcv', bits:4, kind:'flags' }),\n  ...Array.from({length:32}, (_x,i) => Object.freeze({ id:`v${i}`, bits:128, kind:'vector' })),\n"""
new = """  Object.freeze({ id:'nzcv', bits:4, kind:'flags' }),\n  Object.freeze({ id:'exclusive.monitor.valid', bits:1, kind:'hidden-state' }),\n  Object.freeze({ id:'exclusive.monitor.address', bits:64, kind:'hidden-state' }),\n  Object.freeze({ id:'exclusive.monitor.width', bits:16, kind:'hidden-state' }),\n  Object.freeze({ id:'exclusive.monitor.context', bits:64, kind:'hidden-state' }),\n  ...Array.from({length:32}, (_x,i) => Object.freeze({ id:`v${i}`, bits:128, kind:'vector' })),\n"""
if text.count(old) != 1:
    raise SystemExit(f'#929 ARM64 register-file anchor expected once, found {text.count(old)}')
arch.write_text(text.replace(old, new, 1))

index = Path('js/targets/architecture/arm64/effects/index.js')
text = index.read_text()
old = "export const ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION = '2';"
if text.count(old) != 1:
    raise SystemExit(f'#929 semantic-version anchor expected once, found {text.count(old)}')
index.write_text(text.replace(old, "export const ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION = '3';", 1))

test = Path('tests/machine-effects/issue-929-exclusive-monitor-state.test.mjs')
test.write_text(r'''import assert from 'node:assert/strict';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { liftArm64AtomicEffects } from '../../js/targets/architecture/arm64/effects/atomic.js';

let sequence = 0;
const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const w = (n) => ({ k:'reg', text:`w${n}`, cls:'gp', bits:32, num:n });
const mem = (base) => ({ k:'mem', text:'[...]', base, index:null, shift:null, mode:'offset', disp:null, addressDisp:null, writebackDisp:null });
function context() { const instructionId=`issue-929-${sequence++}`; return { instructionId, origin:{ instructionIds:[instructionId] } }; }
function lift(mnemonic, ops) { return liftArm64AtomicEffects({ mnemonic, ops }, context()); }

const stateIds = ['exclusive.monitor.valid','exclusive.monitor.address','exclusive.monitor.width','exclusive.monitor.context'];
const registerFile = new Map(ARM64_ARCHITECTURE.registerFile().map((entry) => [entry.id, entry]));
for (const id of stateIds) assert.equal(registerFile.get(id)?.kind, 'hidden-state', `${id} must be canonical architecture state`);

const load = lift('ldxr', [x(0), mem(x(1))]);
const loadWrites = load.operations.filter((op) => op.kind === 'register-write' && stateIds.includes(op.register.registerId));
assert.deepEqual(loadWrites.map((op) => op.register.registerId).sort(), stateIds.slice().sort());
const set = load.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.exclusive-monitor-set');
assert.ok(set);
assert.equal(set.effectSummary.inputs.length, 1, 'reservation address must be a typed monitor-set input');
assert.equal(set.effectSummary.outputs.length, 1, 'implementation-defined reservation context must be explicit');
assert.equal(set.effectSummary.determinism, 'nondeterministic');
assert.equal(load.metadata.monitorState, 'canonical-physical-state-v1');

const clear = lift('clrex', []);
const clearReads = clear.operations.filter((op) => op.kind === 'register-read').map((op) => op.register.registerId);
const clearWrites = clear.operations.filter((op) => op.kind === 'register-write').map((op) => op.register.registerId);
for (const id of stateIds) {
  assert.ok(clearReads.includes(id), `CLREX must consume prior ${id}`);
  assert.ok(clearWrites.includes(id), `CLREX must define cleared ${id}`);
}
const clearIntrinsic = clear.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.exclusive-monitor-clear');
assert.equal(clearIntrinsic.effectSummary.inputs.length, 4);

const store = lift('stxr', [w(0), x(2), mem(x(1))]);
const storeReads = store.operations.filter((op) => op.kind === 'register-read').map((op) => op.register.registerId);
const storeWrites = store.operations.filter((op) => op.kind === 'register-write').map((op) => op.register.registerId);
for (const id of stateIds) {
  assert.ok(storeReads.includes(id), `STXR must consume prior ${id}`);
  assert.ok(storeWrites.includes(id), `STXR attempt must clear ${id}`);
}
const conditional = store.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.exclusive-store-conditional');
assert.ok(conditional);
assert.equal(conditional.effectSummary.inputs.length, 6, 'STXR must consume data, attempted address, and four monitor-state values');
assert.equal(conditional.effectSummary.determinism, 'nondeterministic');
assert.equal(conditional.metadata.reservationInputs.address, true);
assert.equal(conditional.metadata.reservationInputs.implementationContext, true);
assert.equal(conditional.metadata.implementationConditions, 'represented-by-opaque-monitor-context-and-nondeterministic-status');

console.log('issue #929 canonical exclusive-monitor state regression: PASS');
''')
