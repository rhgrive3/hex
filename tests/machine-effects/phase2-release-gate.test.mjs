import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { OP, buildIR } from '../../js/ir-core.js';
import { lowerMachineEffectsToLegacyV1 } from '../../js/semantics/compat/index.js';
import { ARM64_ARCHITECTURE, ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import {
  COVERAGE_STATUS,
  INTEGRATION_STATE,
  createCoverageRecord,
  summarizeCoverage,
} from '../../tools/validation/machine-effects/coverage-model.mjs';
import {
  canonicalJson,
  runDifferentialSuite,
} from '../../tools/validation/machine-effects/differential-harness.mjs';
import { assertNoSilentPreserve } from '../../tools/validation/machine-effects/zero-silent-preserve.mjs';

let nextAddress = 0x1000n;
function decoded(mnemonic, operands = '', extra = {}) {
  const address = extra.address ?? nextAddress;
  nextAddress = address + 4n;
  const instructionId = extra.instructionId ?? `phase2-release:${mnemonic}:${address.toString(16)}`;
  return {
    mnemonic,
    operands,
    ops: extra.ops ?? parseOperands(operands),
    address,
    mode: extra.mode ?? 'a64',
    instructionId,
    origin: extra.origin ?? { instructionIds:[instructionId] },
    ...extra,
  };
}

const gp = (num, bits = 64) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });
const fp = (num, bits = 32, prefix = bits === 32 ? 's' : 'd') => ({ k:'reg', cls:'fp', num, bits, text:`${prefix}${num}` });
const vec = (num, arr) => ({ k:'reg', cls:'vec', num, bits:128, arr, text:`v${num}.${arr}` });
const elem = (num, size, index) => ({ k:'elem', num, size, index, text:`v${num}.${size}[${index}]` });
const sys = (text) => ({ k:'other', text });
const imm = (value) => ({ k:'imm', value:BigInt(value), text:`#${value}` });

const coverageCorpus = [
  ['arm64:add', ARM64_ARCHITECTURE, decoded('add', 'x0, x1, x2')],
  ['arm64:adds', ARM64_ARCHITECTURE, decoded('adds', 'x3, x4, x5')],
  ['arm64:mov', ARM64_ARCHITECTURE, decoded('mov', 'x6, x7')],
  ['arm64:csel', ARM64_ARCHITECTURE, decoded('csel', 'x0, x1, x2, gt')],
  ['arm64:b', ARM64_ARCHITECTURE, decoded('b', '#0x5000', { branchTarget:0x5000n })],
  ['arm64:ret', ARM64_ARCHITECTURE, decoded('ret', '', { isReturn:true })],
  ['arm64:ldr', ARM64_ARCHITECTURE, decoded('ldr', 'x0, [x1, #16]', { memory:{ kind:'load', size:8, stack:false } })],
  ['arm64:str', ARM64_ARCHITECTURE, decoded('str', 'x0, [x1, #16]', { memory:{ kind:'store', size:8, stack:false } })],
  ['arm64:dmb', ARM64_ARCHITECTURE, decoded('dmb', 'ish', { ops:[sys('ish')] })],
  ['arm64:dmb-invalid', ARM64_ARCHITECTURE, decoded('dmb', 'future-option', { ops:[sys('future-option')] })],
  ['arm64:fadd', ARM64_ARCHITECTURE, decoded('fadd', 's0, s1, s2', { ops:[fp(0), fp(1), fp(2)] })],
  ['arm64:fmov', ARM64_ARCHITECTURE, decoded('fmov', 'd0, d1', { ops:[fp(0,64), fp(1,64)] })],
  ['arm64:fmov-decimal', ARM64_ARCHITECTURE, decoded('fmov', 'd0, #1.5', { ops:[fp(0,64), { k:'imm', value:null, float:1.5, text:'#1.5' }] })],
  ['arm64:simd-add', ARM64_ARCHITECTURE, decoded('add', 'v0.4s, v1.4s, v2.4s', { ops:[vec(0,'4s'), vec(1,'4s'), vec(2,'4s')] })],
  ['arm64:simd-ins', ARM64_ARCHITECTURE, decoded('ins', 'v0.s[2], w1', { ops:[elem(0,'s',2), gp(1,32)] })],
  ['arm64:simd-unknown', ARM64_ARCHITECTURE, decoded('mysteryvec', 'v0.16b, v1.16b', { ops:[vec(0,'16b'), vec(1,'16b')] })],
  ['arm64:nop', ARM64_ARCHITECTURE, decoded('nop')],
  ['arm64:mrs', ARM64_ARCHITECTURE, decoded('mrs', 'x0, tpidr_el0', { ops:[gp(0), sys('tpidr_el0')] })],
  ['arm64:svc', ARM64_ARCHITECTURE, decoded('svc', '#0x80', { ops:[imm(0x80)] })],
  ['arm64:sve', ARM64_ARCHITECTURE, decoded('fadd', 'z0.s, z1.s, z2.s', { ops:[] })],
  ['arm64e:paciasp', ARM64E_ARCHITECTURE, decoded('paciasp', '', { mode:'arm64e', operands:[] })],
  ['arm64e:autiasp', ARM64E_ARCHITECTURE, decoded('autiasp', '', { mode:'arm64e', operands:[] })],
  ['arm64e:xpaclri', ARM64E_ARCHITECTURE, decoded('xpaclri', '', { mode:'arm64e', operands:[] })],
  ['arm64:unsupported', ARM64_ARCHITECTURE, decoded('zzfuture')],
];

const coverageRecords = [];
for (const [key, architecture, instruction] of coverageCorpus) {
  const bundle = architecture.liftExact(instruction);
  const liftResult = bundle ?? { coverage:COVERAGE_STATUS.UNSUPPORTED, bundle:null, reason:'composed-lifter-returned-null' };
  assertNoSilentPreserve({ decodedInstruction:instruction, liftResult, recognized:true });
  coverageRecords.push(createCoverageRecord({
    key,
    mnemonic:instruction.mnemonic,
    family:bundle?.metadata?.family ?? (architecture.id === 'arm64e' ? 'arm64e' : 'unclaimed'),
    coverage:bundle?.completeness ?? COVERAGE_STATUS.UNSUPPORTED,
    reason:bundle?.unknownEffects?.reason ?? (bundle ? null : 'composed-lifter-returned-null'),
    integrationState:INTEGRATION_STATE.INTEGRATED,
    evidence:['phase2-release-corpus'],
  }));
}

const coverage = summarizeCoverage(coverageRecords, { integrationState:INTEGRATION_STATE.INTEGRATED });
assert.deepEqual(coverage.counts, {
  exact:11,
  'exact-with-intrinsic':7,
  partial:5,
  unknown:0,
  unsupported:1,
});
assert.equal(coverage.total, 24);

function singleInstructionCfg() {
  return {
    nodes:[{ startRow:0, endRow:0, succ:[], isEntry:true, isExit:true, isLoopHeader:false }],
    graph:{
      predecessors:[[]],
      dominators:[new Set([0])],
      reachable:new Set([0]),
      loops:[],
    },
  };
}

function legacyV1Oracle(instruction) {
  const insn = { ...instruction, row:0, address:instruction.address ?? 0x1000n };
  const ir = buildIR({
    name:'phase2-shadow-one-instruction',
    startAddress:insn.address,
    instructions:[insn],
    basicBlocks:[{ startRow:0, endRow:0, rows:[0] }],
    semantic:[],
  }, { cfg:singleInstructionCfg() });
  return (ir?.instructions || []).map((item) => item.extra).filter(Boolean);
}

function normalizeV1Observable(list) {
  const env = new Map();
  const writes = [];
  const memory = [];
  const control = [];
  const unknown = [];

  const isSynthetic = (reg) => String(reg || '').startsWith('$');
  const source = (src) => {
    if (!src) return null;
    if (src.t === 'imm') return ['const', src.value == null ? null : String(src.value), Number(src.bits || 64)];
    if (src.t === 'cond') return ['cond', String(src.cond || '')];
    if (src.t === 'reg') return env.get(src.reg) ?? ['reg', String(src.reg), Number(src.bits || 64)];
    return ['unknown-source'];
  };
  const address = (addr) => {
    if (!addr) return null;
    let expr = addr.base ? (env.get(addr.base) ?? ['reg', String(addr.base), 64]) : ['const', '0', 64];
    if (addr.index) {
      let index = env.get(addr.index) ?? ['reg', String(addr.index), 64];
      if (addr.extend) index = ['extend', String(addr.extend), index];
      if (Number(addr.scale || 0)) index = ['shl', index, Number(addr.scale)];
      expr = ['add', expr, index];
    }
    if (addr.disp != null && BigInt(addr.disp) !== 0n) expr = ['add', expr, ['const', String(addr.disp), 64]];
    return expr;
  };
  const define = (dst, expr, bits) => {
    if (!dst) return;
    env.set(dst, expr);
    if (!isSynthetic(dst) && dst !== 'nzcv') writes.push([String(dst), ['value', Number(bits || 64), expr]]);
  };

  for (const item of Array.isArray(list) ? list : []) {
    const srcs = (item.srcs || []).map(source).filter(Boolean);
    switch (item.op) {
      case OP.CONST:
        define(item.dstReg, ['const', item.value == null ? null : String(item.value)], item.dstBits);
        break;
      case OP.MOV:
        define(item.dstReg, srcs[0] ?? ['unknown'], item.dstBits);
        break;
      case OP.BIN:
        define(item.dstReg, ['bin', String(item.sub || ''), ...srcs], item.dstBits);
        break;
      case OP.UN:
        define(item.dstReg, ['un', String(item.sub || ''), ...srcs], item.dstBits);
        break;
      case OP.MAC:
        define(item.dstReg, ['mac', String(item.sub || ''), ...srcs], item.dstBits);
        break;
      case OP.BFX:
      case OP.BFI:
        define(item.dstReg, [item.op, item.lsb ?? null, item.width ?? null, ...srcs], item.dstBits);
        break;
      case OP.SEL:
        define(item.dstReg, ['sel', String(item.cond || ''), ...srcs], item.dstBits);
        break;
      case OP.ADDR:
        define(item.dstReg, ['address', item.value == null ? null : String(item.value)], item.dstBits);
        break;
      case OP.LOAD: {
        const expr = ['load', address(item.addr), Number(item.size || 0), !!item.signed];
        define(item.dstReg, expr, item.dstBits);
        break;
      }
      case OP.STORE:
        memory.push(['store', address(item.addr), Number(item.size || 0), srcs[0] ?? ['unknown']]);
        break;
      case OP.BR:
        control.push(['branch', item.target == null ? null : String(item.target), !!item.indirect, srcs[0] ?? null]);
        break;
      case OP.RET:
        control.push(['return']);
        break;
      case OP.CALL:
        control.push(['call', item.target == null ? null : String(item.target), !!item.indirect]);
        break;
      case OP.CBR:
        control.push(['conditional-branch', String(item.kind || ''), item.target == null ? null : String(item.target), srcs]);
        break;
      case OP.UNKNOWN:
        if (item.reason === 'possible-faults-not-representable-in-v1') break;
        unknown.push([item.op, String(item.mnemonic || item.reason || item.intrinsicId || '')]);
        break;
      case OP.CLOBBER:
        unknown.push([item.op, String(item.mnemonic || item.reason || item.intrinsicId || '')]);
        break;
      case OP.CMP:
        // The smoke corpus deliberately excludes flag-producing instructions;
        // full NZCV equivalence remains part of the required cutover corpus.
        env.set(item.dstReg || 'nzcv', ['cmp', String(item.sub || ''), ...srcs]);
        break;
      default:
        unknown.push(['unhandled-v1-op', String(item.op || '')]);
    }
  }
  return canonicalJson({ writes, memory, control, unknown });
}

const shadowCases = [
  { key:'shadow:add', family:'integer', decodedInstruction:decoded('add', 'x0, x1, x2') },
  { key:'shadow:sub', family:'integer', decodedInstruction:decoded('sub', 'x3, x4, x5') },
  { key:'shadow:mov', family:'integer', decodedInstruction:decoded('mov', 'x6, x7') },
  { key:'shadow:ldr', family:'memory', decodedInstruction:decoded('ldr', 'x0, [x1, #16]', { memory:{ kind:'load', size:8, stack:false } }) },
  { key:'shadow:str', family:'memory', decodedInstruction:decoded('str', 'x0, [x1, #16]', { memory:{ kind:'store', size:8, stack:false } }) },
  { key:'shadow:b', family:'control', decodedInstruction:decoded('b', '#0x9000', { branchTarget:0x9000n }) },
  { key:'shadow:ret', family:'control', decodedInstruction:decoded('ret', '', { isReturn:true }) },
  { key:'shadow:nop', family:'system', decodedInstruction:decoded('nop') },
];

const differential = await runDifferentialSuite(shadowCases, {
  semanticVersions:{ machineEffects:'1.0.0', arm64:'2', legacyV1:'1' },
  machineLifter:(instruction) => ARM64_ARCHITECTURE.liftExact(instruction),
  compatibilityLowering:(bundle) => lowerMachineEffectsToLegacyV1(bundle),
  legacyV1Oracle,
  normalizeV1:normalizeV1Observable,
  integrationState:INTEGRATION_STATE.INTEGRATED,
});

assert.equal(differential.notIntegrated, 0);
assert.equal(differential.unsupported, 0);
assert.equal(differential.mismatches, 0, JSON.stringify(differential.results.filter((result) => result.status === 'mismatch'), null, 2));

let conservativeCompatibilityBarriers = 0;
for (const { decodedInstruction } of shadowCases) {
  const bundle = ARM64_ARCHITECTURE.liftExact(decodedInstruction);
  conservativeCompatibilityBarriers += lowerMachineEffectsToLegacyV1(bundle)
    .filter((item) => item.op === OP.UNKNOWN && item.reason === 'possible-faults-not-representable-in-v1').length;
}
assert.ok(conservativeCompatibilityBarriers > 0, 'fault information must remain conservative when v1 cannot represent it');

const releaseGate = Object.freeze({
  schemaVersion:'phase2-machine-effects-release-gate/v1',
  machineEffectsSchemaVersion:'1.0.0',
  architectureSemanticVersion:'2',
  coverageScope:'phase2-release-corpus',
  coverage,
  shadowDifferentialScope:'representative-observable-v1-smoke',
  differential:Object.freeze({
    total:differential.total,
    matches:differential.matches,
    mismatches:differential.mismatches,
    unsupported:differential.unsupported,
    conservativeCompatibilityBarriers,
  }),
  cutover:Object.freeze({
    eligible:false,
    reason:'required-full-corpus-shadow-proof-not-established-and-machine-effects-coverage-remains-partial',
    activeSemanticPath:'legacy-v1',
  }),
});

console.log(`PHASE2_RELEASE_GATE ${JSON.stringify(releaseGate)}`);
console.log('Phase 2 release coverage/shadow differential: PASS');
