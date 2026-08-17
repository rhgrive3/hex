import { createX86EffectContext, x86RegisterOperand } from './common.js';

const FENCES = new Set(['lfence','sfence','mfence']);
const PRIVILEGED = new Set(['cli','sti','hlt','invd','wbinvd','swapgs','lgdt','lidt','lldt','ltr','movcr','movdr']);

function exactPrefix(instruction, expected) {
  const actual = [...(instruction?.detail?.prefixes?.legacy || [])];
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function systemHiddenState(family, fields) {
  return Object.freeze({ instructionFamily:family, missingCanonicalState:Object.freeze(fields), preservation:'not-assumed' });
}

function environmentIntrinsic(ctx, id, inputs, outputWidths, config = {}) {
  return ctx.intrinsic(id, inputs, outputWidths, {
    registersRead:config.registersRead ?? [],
    registersWritten:config.registersWritten ?? [],
    memoryRead:{ scope:'none' },
    memoryWrite:{ scope:'none' },
    determinism:'nondeterministic',
    symbolicDetail:'summary-only',
    metadata:{ environmentDependent:true, exactArchitecturalSummary:false, ...(config.metadata || {}) },
  });
}

function liftCpuid(ctx) {
  const eax = x86RegisterOperand('eax');
  const ebx = x86RegisterOperand('ebx');
  const ecx = x86RegisterOperand('ecx');
  const edx = x86RegisterOperand('edx');
  const leaf = ctx.readRegister(eax);
  const subleaf = ctx.readRegister(ecx);
  if (!leaf || !subleaf) return ctx.partial('x86-cpuid-input-state-unmodelled', ['registers','other']);
  const outputs = environmentIntrinsic(ctx, 'x86.system.cpuid', [leaf,subleaf], [32,32,32,32], {
    registersRead:['rax','rcx'],
    registersWritten:['rax','rbx','rcx','rdx'],
    metadata:{ operation:'cpuid', inputs:['EAX.leaf','ECX.subleaf'], outputs:['EAX','EBX','ECX','EDX'], dependency:'CPU configuration / hypervisor / execution environment' },
  });
  for (const [operand,value] of [[eax,outputs[0]],[ebx,outputs[1]],[ecx,outputs[2]],[edx,outputs[3]]]) {
    if (!ctx.writeRegister(operand, value)) return ctx.partial('x86-cpuid-output-state-unmodelled', ['registers','other']);
  }
  return ctx.partial('x86-cpuid-environment-and-serialization-unmodelled', ['other'], {
    detail:systemHiddenState('cpuid', ['processor-feature-environment','serialization/ordering-contract']),
    metadata:{ family:'system', operation:'cpuid', deterministicOutput:false, outputShapeModeled:true, ordinaryCall:false },
  });
}

function liftTimestamp(ctx, family) {
  const eax = x86RegisterOperand('eax');
  const edx = x86RegisterOperand('edx');
  const ecx = x86RegisterOperand('ecx');
  const outputs = environmentIntrinsic(ctx, `x86.system.${family}`, [], family === 'rdtscp' ? [32,32,32] : [32,32], {
    registersWritten:family === 'rdtscp' ? ['rax','rdx','rcx'] : ['rax','rdx'],
    metadata:{ operation:family, value:'runtime timestamp counter', ordering:family === 'rdtscp' ? 'partially-ordering but frozen barrier contract insufficient' : 'not serializing' },
  });
  if (!ctx.writeRegister(eax, outputs[0]) || !ctx.writeRegister(edx, outputs[1])) return ctx.partial(`x86-${family}-output-state-unmodelled`, ['registers','other']);
  if (family === 'rdtscp' && !ctx.writeRegister(ecx, outputs[2])) return ctx.partial('x86-rdtscp-aux-state-unmodelled', ['registers','other']);
  return ctx.partial(`x86-${family}-runtime-state-unmodelled`, ['faults','other'], {
    detail:systemHiddenState(family, family === 'rdtscp'
      ? ['timestamp-counter','TSC_AUX','CR4.TSD/CPL privilege state','RDTSCP ordering semantics']
      : ['timestamp-counter','CR4.TSD/CPL privilege state']),
    possibleFaults:[{ kind:'general-protection', condition:{ kind:'x86-tsc-privilege-state-unmodelled', instruction:family }, detail:{ fault:'#GP(0)' } }],
    metadata:{ family:'system', operation:family, deterministicOutput:false, outputShapeModeled:true },
  });
}

function liftSyscall(ctx) {
  const nextRip = BigInt(ctx.instruction.address) + BigInt(ctx.instruction.length);
  const rflags = ctx.readRegister(x86RegisterOperand('rflags'));
  if (!rflags) return ctx.partial('x86-syscall-rflags-state-unmodelled', ['registers','control','other'], { controlEffect:{ kind:'unknown', reason:'x86-syscall-system-target-unmodelled' } });
  if (!ctx.writeRegister(x86RegisterOperand('rcx'), ctx.constant(64,nextRip)) || !ctx.writeRegister(x86RegisterOperand('r11'), rflags)) {
    return ctx.partial('x86-syscall-visible-register-state-unmodelled', ['registers','control','other'], { controlEffect:{ kind:'unknown', reason:'x86-syscall-system-target-unmodelled' } });
  }
  return ctx.partial('x86-syscall-msr-and-privilege-state-unmodelled', ['registers','flags','control','other'], {
    controlEffect:{ kind:'unknown', reason:'x86-syscall-target-derived-from-unmodelled-system-msrs' },
    detail:systemHiddenState('syscall', ['IA32_LSTAR','IA32_STAR','IA32_FMASK','CS/SS privilege state']),
    metadata:{ family:'system', operation:'syscall', ordinaryCall:false, knownVisibleWrites:['RCX=nextRIP','R11=RFLAGS'], stackCallSemantics:false },
  });
}

function liftSysret(ctx, family) {
  const rcx = ctx.readRegister(x86RegisterOperand('rcx'));
  const r11 = ctx.readRegister(x86RegisterOperand('r11'));
  if (!rcx || !r11) return ctx.partial('x86-sysret-visible-input-state-unmodelled', ['registers','flags','control','other'], { controlEffect:{ kind:'unknown', reason:'x86-sysret-system-state-unmodelled' } });
  return ctx.partial('x86-sysret-msr-segment-and-privilege-state-unmodelled', ['registers','flags','control','faults','other'], {
    controlEffect:{ kind:'unknown', reason:'x86-sysret-control-transfer-depends-on-unmodelled-system-state' },
    detail:systemHiddenState(family, ['IA32_STAR','CS/SS privilege state','canonical-address checks','full RFLAGS restore rules']),
    metadata:{ family:'system', operation:family, ordinaryReturn:false, stackReturnSemantics:false, visibleInputs:['RCX','R11'] },
  });
}

export function liftX86SystemEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  if (![...FENCES, ...PRIVILEGED, 'pause','cpuid','rdtsc','rdtscp','syscall','sysret','sysretq'].includes(family)) return null;
  const ctx = createX86EffectContext(instruction, context);

  if (FENCES.has(family)) {
    return ctx.partial('x86-fence-generic-barrier-contract-insufficient', ['memory','other'], {
      detail:{ instructionFamily:family, missingContract:'architecture-neutral barrier scope/order semantics strong enough to distinguish LFENCE/SFENCE/MFENCE', p5iRequirement:'define canonical barrier semantics before exact fence lowering' },
      metadata:{ family:'system', operation:family, barrierOperationEmitted:false, fenceKindsCollapsed:false },
    });
  }

  if (family === 'pause') {
    if (!exactPrefix(ctx.instruction, [0xf3])) return ctx.partial('x86-pause-prefix-evidence-unmodelled', ['other'], { metadata:{ family:'system', operation:'pause' } });
    return ctx.finish({
      family:'system',
      statePreservation:{ proven:true, reason:'x86-pause-has-no-architectural-register-memory-or-flag-state-mutation' },
      metadata:{ operation:'pause', microarchitecturalHintOnly:true },
    });
  }

  if (family === 'cpuid') return liftCpuid(ctx);
  if (family === 'rdtsc' || family === 'rdtscp') return liftTimestamp(ctx, family);
  if (family === 'syscall') return liftSyscall(ctx);
  if (family === 'sysret' || family === 'sysretq') return liftSysret(ctx, family);

  if (PRIVILEGED.has(family)) {
    const missing = family === 'cli' || family === 'sti'
      ? ['RFLAGS.IF','CPL/IOPL privilege state']
      : ['privilege/system execution state'];
    return ctx.partial(`x86-${family}-privileged-system-state-unmodelled`, ['registers','flags','control','faults','other'], {
      controlEffect:family === 'hlt' ? { kind:'unknown', reason:'x86-hlt-execution-resumption-environment-unmodelled' } : { kind:'fallthrough' },
      detail:systemHiddenState(family, missing),
      possibleFaults:[{ kind:'general-protection', condition:{ kind:'x86-privilege-check-unmodelled', instruction:family }, detail:{ fault:'#GP(0)' } }],
      metadata:{ family:'system', operation:family, treatedAsNop:false, privileged:true },
    });
  }
  return null;
}
