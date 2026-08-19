import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
} from '../../../../semantics/effects/index.js';
import {
  Arm64AddressingError,
  arm64RegisterOperand,
  arm64Temporary,
  buildArm64EffectiveAddress,
  createArm64RegisterRead,
  createArm64RegisterWrite,
} from './addressing.js';

const EXCLUSIVE_LOAD_RE = /^lda?xr([bh])?$/;
const EXCLUSIVE_STORE_RE = /^stl?xr([bh])?$/;
const CAS_RE = /^cas(al|a|l)?([bh])?$/;
const SWP_RE = /^swp(al|a|l)?([bh])?$/;
const RMW_RE = /^(ldadd|ldset|ldclr|ldeor)(al|a|l)?([bh])?$/;
const BARRIERS = new Set(['dmb','dsb','isb']);

export const ARM64_ATOMIC_INSTRUCTION_INVENTORY = Object.freeze({
  exclusiveLoads:Object.freeze(['ldxr','ldaxr']),
  exclusiveStores:Object.freeze(['stxr','stlxr']),
  compareSwap:Object.freeze(['cas','casa','casl','casal']),
  swap:Object.freeze(['swp','swpa','swpl','swpal']),
  readModifyWrite:Object.freeze(['ldadd','ldadda','ldaddl','ldaddal','ldset','ldclr','ldeor']),
  barriers:Object.freeze(['dmb','dsb','isb','clrex']),
});

function mnemonicOf(decoded) { return String(decoded?.mnemonic || '').trim().toLowerCase(); }
function contextOf(decoded, context = {}) {
  const instructionId = String(context.instructionId || decoded?.instructionId || '').trim();
  if (!instructionId) throw new TypeError('arm64-machine-effects-instruction-id-required');
  return {
    instructionId,
    architectureId:String(context.architectureId || decoded?.architectureId || 'arm64'),
    mode:String(context.mode || decoded?.mode || 'a64'),
    dataEndianness:String(context.dataEndianness || decoded?.dataEndianness || context.endian || decoded?.endian || 'little'),
    origin:context.origin || decoded?.origin || { instructionIds:[instructionId] },
    options:context.options || {},
  };
}

function bundle(decoded, context, body) {
  const ctx = contextOf(decoded, context);
  return createMachineEffectBundle({
    instructionId:ctx.instructionId,
    architectureId:ctx.architectureId,
    mode:ctx.mode,
    operations:body.operations || [],
    controlEffect:body.controlEffect || { kind:'fallthrough' },
    possibleFaults:body.possibleFaults || [],
    origin:ctx.origin,
    completeness:body.completeness || 'exact',
    ...(body.unknownEffects ? { unknownEffects:body.unknownEffects } : {}),
    ...(body.metadata ? { metadata:body.metadata } : {}),
  }, ctx.options);
}

function partial(decoded, context, reason, categories = ['memory','registers','faults','other']) {
  return bundle(decoded, context, {
    completeness:'partial',
    operations:[],
    unknownEffects:{ categories, reason },
    metadata:{ family:'arm64-atomic', mnemonic:mnemonicOf(decoded), unsupported:true },
  });
}

function operands(decoded) {
  return Array.isArray(decoded?.ops) ? decoded.ops : Array.isArray(decoded?.operands) ? decoded.operands : [];
}
function registers(decoded) { return operands(decoded).map((op) => arm64RegisterOperand(op)).filter(Boolean); }
function isGpOrZero(reg) { return !!reg && (reg.kind === 'gp' || reg.zero === true || reg.kind === 'zero'); }
function zeroDisplacement(addressing) {
  const raw = addressing?.metadata?.addressDisplacement;
  return raw == null || BigInt(raw) === 0n;
}
function isBaseOnly(addressing) {
  return addressing.mode === 'offset' && !addressing.index && zeroDisplacement(addressing) && addressing.writebackOperations.length === 0;
}
function registerMatchesSizeSuffix(reg, sizeSuffix) {
  if (!isGpOrZero(reg)) return false;
  if (sizeSuffix === 'b' || sizeSuffix === 'h') return reg.bits === 32;
  return reg.bits === 32 || reg.bits === 64;
}

function orderingFromSuffix(suffix = '') {
  return {
    read:suffix === 'a' || suffix === 'al' ? 'acquire' : 'relaxed',
    write:suffix === 'l' || suffix === 'al' ? 'release' : 'relaxed',
    summary:suffix === 'al' ? 'acq-rel' : suffix === 'a' ? 'acquire' : suffix === 'l' ? 'release' : 'relaxed',
  };
}
function widthFromSuffixOrReg(sizeSuffix, reg) {
  if (sizeSuffix === 'b') return 8;
  if (sizeSuffix === 'h') return 16;
  const bits = Number(reg?.bits || 0);
  return bits === 32 || bits === 64 ? bits : null;
}

function access(ctx, addressExpr, widthBits, ordering) {
  return createMemoryAccess({
    space:'memory',
    addressExpr,
    widthBits,
    alignment:Math.max(1, widthBits / 8),
    endian:ctx.dataEndianness,
    atomic:true,
    ordering,
  }, ctx.options);
}
function tagChecked(addressing) { return addressing?.base?.kind !== 'sp'; }
function faults(direction, alignment, addressExpr, addressing) {
  const causes = ['address-size','translation','access-flag','permission','external'];
  if (tagChecked(addressing)) causes.push('tag-check');
  const out = [
    {
      kind:'data-abort',
      condition:{ kind:'memory-access-fault', access:direction },
      detail:{ causes, tagChecked:tagChecked(addressing), addressExpr },
    },
    {
      kind:'alignment-fault',
      condition:{ kind:'misaligned', alignment },
      detail:{ access:direction, atomic:true, alignment },
    },
  ];
  if (addressing?.base?.kind === 'sp') {
    out.unshift({
      kind:'stack-pointer-alignment-fault',
      condition:{ kind:'sp-misaligned', alignment:16 },
      detail:{ baseRegister:'sp', architecturalCheck:'CheckSPAlignment' },
    });
  }
  return out;
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function intrinsicSummary({ inputs = [], outputs = [], registersRead = [], registersWritten = [], memoryRead = null, memoryWrite = null, determinism = 'input-dependent' }) {
  return createIntrinsicEffectSummary({
    inputs,
    outputs,
    registersRead:unique(registersRead),
    registersWritten:unique(registersWritten),
    memoryRead:memoryRead || { scope:'none' },
    memoryWrite:memoryWrite || { scope:'none' },
    controlEffects:[],
    determinism,
    symbolicDetail:'summary-only',
  });
}

function valueOp(opcode, input, fromBits, toBits, id, metadata = {}) {
  const output = arm64Temporary(id, toBits);
  return {
    output,
    operation:createMachineOperation({
      kind:'value', opcode, inputs:[input], outputs:[output],
      metadata:{ architecture:'arm64', fromBits, toBits, ...metadata },
    }),
  };
}
function readRegister(reg, id, widthBits = reg.bits) {
  if (reg.zero) return { operations:[], value:createBitVectorValue(widthBits, 0n), registerId:null };
  if (widthBits > reg.bits) throw new TypeError('arm64-atomic-source-width-exceeds-register-view');
  const read = createArm64RegisterRead(reg, id, reg.bits);
  const operations = [read.operation];
  let value = read.value;
  if (widthBits < reg.bits) {
    const trunc = valueOp('truncate', value, reg.bits, widthBits, `${id}.truncated`, { purpose:'atomic-source-width' });
    operations.push(trunc.operation);
    value = trunc.output;
  }
  return { operations, value, registerId:reg.physicalId };
}

function writeLoadedGp(reg, value, valueBits, idPrefix) {
  if (reg.zero) return [];
  if (reg.kind !== 'gp') throw new TypeError('arm64-atomic-result-must-be-gp-register');
  const operations = [];
  let result = value;
  const viewBits = Number(reg.bits);
  if (valueBits > viewBits) throw new TypeError('arm64-atomic-result-width-exceeds-register-view');
  if (valueBits < viewBits) {
    const widened = valueOp('zero-extend', result, valueBits, viewBits, `${idPrefix}.view`, { atomicResult:true });
    operations.push(widened.operation);
    result = widened.output;
  }
  if (viewBits === 32) {
    const physical = valueOp('zero-extend', result, 32, 64, `${idPrefix}.physical`, { writePolicy:'zero-upper-32', atomicResult:true });
    operations.push(physical.operation);
    result = physical.output;
  }
  operations.push(createArm64RegisterWrite(reg, result, {
    physicalWidth:64,
    metadata:{ purpose:'atomic-result', writePolicy:viewBits === 32 ? 'zero-upper-32' : 'full-width' },
  }));
  return operations;
}

function exclusiveLoad(decoded, context, match) {
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
  const monitor = arm64Temporary('exclusive.monitor.token', 1);
  const ops = [...addr.readOperations];
  ops.push(createMachineOperation({
    kind:'memory-read', access:memAccess, value:raw,
    metadata:{ architecture:'arm64', exclusive:true, ordering, tagChecked:tagChecked(addr) },
  }));
  ops.push(createMachineOperation({
    kind:'intrinsic',
    intrinsicId:'arm64.exclusive-monitor-set',
    effectSummary:intrinsicSummary({
      outputs:[monitor],
      registersRead:[addr.base.physicalId],
      determinism:'deterministic',
    }),
    metadata:{ addressExpr:addr.addressExpr, widthBits, hiddenState:'exclusive-monitor' },
  }));
  try { ops.push(...writeLoadedGp(dest, raw, widthBits, 'exclusive.load')); }
  catch (error) { return partial(decoded, context, error.message); }

  return bundle(decoded, context, {
    operations:ops,
    possibleFaults:faults('read', widthBits / 8, addr.addressExpr, addr),
    completeness:'exact-with-intrinsic',
    metadata:{ family:'arm64-atomic', kind:'exclusive-load', mnemonic:mnemonicOf(decoded), widthBits, ordering, addressing:addr.metadata },
  });
}

function exclusiveStore(decoded, context, match) {
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
  const statusValue = arm64Temporary('exclusive.store.status', 32);
  const ops = [...addr.readOperations, ...dataRead.operations];
  ops.push(createMachineOperation({
    kind:'intrinsic',
    intrinsicId:'arm64.exclusive-store-conditional',
    effectSummary:intrinsicSummary({
      inputs:[dataRead.value],
      outputs:[statusValue],
      registersRead:[addr.base.physicalId, dataRead.registerId],
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
      tagChecked:tagChecked(addr),
    },
  }));
  try { ops.push(...writeLoadedGp(status, statusValue, 32, 'exclusive.store.status')); }
  catch (error) { return partial(decoded, context, error.message); }

  return bundle(decoded, context, {
    operations:ops,
    possibleFaults:faults('write', widthBits / 8, addr.addressExpr, addr),
    completeness:'exact-with-intrinsic',
    metadata:{ family:'arm64-atomic', kind:'exclusive-store', mnemonic:mnemonicOf(decoded), widthBits, ordering, addressing:addr.metadata },
  });
}

function atomicRmw(decoded, context, { family, suffix = '', sizeSuffix = '' }) {
  const ctx = contextOf(decoded, context);
  const regs = registers(decoded);
  const source = regs[0];
  const result = regs[1];
  if (!registerMatchesSizeSuffix(source, sizeSuffix) || !registerMatchesSizeSuffix(result, sizeSuffix)) {
    return partial(decoded, context, `${family} requires correctly-sized GP registers`);
  }
  const widthBits = widthFromSuffixOrReg(sizeSuffix, source);
  if (!widthBits || (sizeSuffix === '' && result.bits !== source.bits)) return partial(decoded, context, `${family} register widths do not match`);

  let addr;
  try { addr = buildArm64EffectiveAddress(decoded, { prefix:'atomic.addr' }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code);
    throw error;
  }
  if (!isBaseOnly(addr)) return partial(decoded, context, `${family} requires base-only addressing`);

  const order = orderingFromSuffix(suffix);
  const readAccess = access(ctx, addr.addressExpr, widthBits, order.read);
  const writeAccess = access(ctx, addr.addressExpr, widthBits, order.write);
  let sourceRead;
  try { sourceRead = readRegister(source, `${family}.source`, widthBits); }
  catch (error) { return partial(decoded, context, error.message); }
  const oldValue = arm64Temporary(`${family}.old`, widthBits);
  const ops = [...addr.readOperations, ...sourceRead.operations];
  ops.push(createMachineOperation({
    kind:'intrinsic',
    intrinsicId:`arm64.atomic.${family}`,
    effectSummary:intrinsicSummary({
      inputs:[sourceRead.value],
      outputs:[oldValue],
      registersRead:[addr.base.physicalId, sourceRead.registerId],
      memoryRead:{ scope:'accesses', accesses:[readAccess] },
      memoryWrite:{ scope:'accesses', accesses:[writeAccess] },
    }),
    metadata:{ operation:family, widthBits, ordering:order.summary, readOrdering:order.read, writeOrdering:order.write, atomic:true, tagChecked:tagChecked(addr) },
  }));
  try { ops.push(...writeLoadedGp(result, oldValue, widthBits, `${family}.result`)); }
  catch (error) { return partial(decoded, context, error.message); }

  return bundle(decoded, context, {
    operations:ops,
    possibleFaults:[...faults('read', widthBits / 8, addr.addressExpr, addr), ...faults('write', widthBits / 8, addr.addressExpr, addr)],
    completeness:'exact-with-intrinsic',
    metadata:{ family:'arm64-atomic', kind:'read-modify-write', operation:family, mnemonic:mnemonicOf(decoded), widthBits, ordering:order.summary, addressing:addr.metadata },
  });
}

function compareSwap(decoded, context, match) {
  const ctx = contextOf(decoded, context);
  const suffix = match[1] || '';
  const sizeSuffix = match[2] || '';
  const regs = registers(decoded);
  const expected = regs[0];
  const replacement = regs[1];
  if (!registerMatchesSizeSuffix(expected, sizeSuffix) || !registerMatchesSizeSuffix(replacement, sizeSuffix)) {
    return partial(decoded, context, 'CAS requires correctly-sized expected and replacement GP registers');
  }
  const widthBits = widthFromSuffixOrReg(sizeSuffix, expected);
  if (!widthBits || (sizeSuffix === '' && expected.bits !== replacement.bits)) return partial(decoded, context, 'CAS register widths do not match');

  let addr;
  try { addr = buildArm64EffectiveAddress(decoded, { prefix:'atomic.addr' }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code);
    throw error;
  }
  if (!isBaseOnly(addr)) return partial(decoded, context, 'CAS requires base-only addressing');

  const order = orderingFromSuffix(suffix);
  const readAccess = access(ctx, addr.addressExpr, widthBits, order.read);
  const writeAccess = access(ctx, addr.addressExpr, widthBits, order.write);
  let expectedRead;
  let replacementRead;
  try {
    expectedRead = readRegister(expected, 'cas.expected', widthBits);
    replacementRead = readRegister(replacement, 'cas.replacement', widthBits);
  } catch (error) { return partial(decoded, context, error.message); }
  const oldValue = arm64Temporary('cas.old', widthBits);
  const ops = [...addr.readOperations, ...expectedRead.operations, ...replacementRead.operations];
  ops.push(createMachineOperation({
    kind:'intrinsic',
    intrinsicId:'arm64.atomic.compare-swap',
    effectSummary:intrinsicSummary({
      inputs:[expectedRead.value, replacementRead.value],
      outputs:[oldValue],
      registersRead:[addr.base.physicalId, expectedRead.registerId, replacementRead.registerId],
      memoryRead:{ scope:'accesses', accesses:[readAccess] },
      memoryWrite:{ scope:'accesses', accesses:[writeAccess] },
    }),
    metadata:{
      condition:'memory-equals-expected',
      conditionalWrite:true,
      widthBits,
      ordering:order.summary,
      readOrdering:order.read,
      writeOrdering:order.write,
      tagChecked:tagChecked(addr),
    },
  }));
  try { ops.push(...writeLoadedGp(expected, oldValue, widthBits, 'cas.result')); }
  catch (error) { return partial(decoded, context, error.message); }

  return bundle(decoded, context, {
    operations:ops,
    possibleFaults:[...faults('read', widthBits / 8, addr.addressExpr, addr), ...faults('write', widthBits / 8, addr.addressExpr, addr)],
    completeness:'exact-with-intrinsic',
    metadata:{ family:'arm64-atomic', kind:'compare-swap', mnemonic:mnemonicOf(decoded), widthBits, ordering:order.summary, addressing:addr.metadata },
  });
}

function barrierOption(decoded) {
  const op = operands(decoded)[0];
  const raw = String(op?.text || op?.value || decoded?.barrierOption || decoded?.operandsText || '').trim().toLowerCase();
  return raw.replace(/^#/, '') || 'sy';
}
const BARRIER_OPTIONS = Object.freeze({
  sy:{ domain:'full-system', access:'all' },
  st:{ domain:'full-system', access:'stores' },
  ld:{ domain:'full-system', access:'loads' },
  ish:{ domain:'inner-shareable', access:'all' },
  ishst:{ domain:'inner-shareable', access:'stores' },
  ishld:{ domain:'inner-shareable', access:'loads' },
  nsh:{ domain:'non-shareable', access:'all' },
  nshst:{ domain:'non-shareable', access:'stores' },
  nshld:{ domain:'non-shareable', access:'loads' },
  osh:{ domain:'outer-shareable', access:'all' },
  oshst:{ domain:'outer-shareable', access:'stores' },
  oshld:{ domain:'outer-shareable', access:'loads' },
});

function barrier(decoded, context, mnemonic) {
  const option = barrierOption(decoded);
  if (mnemonic === 'isb') {
    if (option !== 'sy') return partial(decoded, context, `unsupported ISB option: ${option}`, ['other']);
    return bundle(decoded, context, {
      operations:[createMachineOperation({ kind:'barrier', scope:{ kind:'isb', domain:'instruction-stream', access:'instruction-fetch', option:'sy' }, metadata:{ architecture:'arm64' } })],
      metadata:{ family:'arm64-atomic', kind:'barrier', mnemonic, option:'sy' },
    });
  }
  const scope = BARRIER_OPTIONS[option];
  if (!scope) return partial(decoded, context, `unsupported ${mnemonic.toUpperCase()} option: ${option}`, ['memory','other']);
  return bundle(decoded, context, {
    operations:[createMachineOperation({ kind:'barrier', scope:{ kind:mnemonic, option, ...scope }, metadata:{ architecture:'arm64', ordering:'barrier' } })],
    metadata:{ family:'arm64-atomic', kind:'barrier', mnemonic, option, ...scope },
  });
}

function clearExclusive(decoded, context) {
  const token = arm64Temporary('exclusive.monitor.cleared', 1);
  return bundle(decoded, context, {
    operations:[createMachineOperation({
      kind:'intrinsic',
      intrinsicId:'arm64.exclusive-monitor-clear',
      effectSummary:intrinsicSummary({ outputs:[token], determinism:'deterministic' }),
      metadata:{ architecture:'arm64', hiddenState:'exclusive-monitor' },
    })],
    completeness:'exact-with-intrinsic',
    metadata:{ family:'arm64-atomic', kind:'exclusive-monitor-clear', mnemonic:'clrex' },
  });
}

export function isArm64AtomicInstruction(decodedOrMnemonic) {
  const mnemonic = typeof decodedOrMnemonic === 'string' ? decodedOrMnemonic.toLowerCase() : mnemonicOf(decodedOrMnemonic);
  return EXCLUSIVE_LOAD_RE.test(mnemonic) || EXCLUSIVE_STORE_RE.test(mnemonic) || CAS_RE.test(mnemonic) || SWP_RE.test(mnemonic) || RMW_RE.test(mnemonic) || BARRIERS.has(mnemonic) || mnemonic === 'clrex';
}

export function liftArm64AtomicEffects(decoded, context = {}) {
  const mnemonic = mnemonicOf(decoded);
  let match;
  if ((match = EXCLUSIVE_LOAD_RE.exec(mnemonic))) return exclusiveLoad(decoded, context, match);
  if ((match = EXCLUSIVE_STORE_RE.exec(mnemonic))) return exclusiveStore(decoded, context, match);
  if ((match = CAS_RE.exec(mnemonic))) return compareSwap(decoded, context, match);
  if ((match = SWP_RE.exec(mnemonic))) return atomicRmw(decoded, context, { family:'swap', suffix:match[1] || '', sizeSuffix:match[2] || '' });
  if ((match = RMW_RE.exec(mnemonic))) {
    const operation = { ldadd:'add', ldset:'or', ldclr:'clear', ldeor:'xor' }[match[1]];
    return atomicRmw(decoded, context, { family:operation, suffix:match[2] || '', sizeSuffix:match[3] || '' });
  }
  if (BARRIERS.has(mnemonic)) return barrier(decoded, context, mnemonic);
  if (mnemonic === 'clrex') return clearExclusive(decoded, context);
  return null;
}

export const liftAtomicEffects = liftArm64AtomicEffects;
