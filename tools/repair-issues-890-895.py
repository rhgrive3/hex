from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one anchor, found {count}')
    p.write_text(text.replace(old, new, 1))


replace_once(
    'js/analysis/semantic-function.js',
    "    } else if (kind !== 'return' && fallthroughBlock) {\n      block.successors.push({ to:fallthroughBlock.key, kind:'fallthrough' });\n    }",
    "    } else if (!['return','unknown'].includes(kind) && fallthroughBlock) {\n      block.successors.push({ to:fallthroughBlock.key, kind:'fallthrough' });\n    }",
)
replace_once(
    'js/analysis/semantic-function.js',
    "  if (typeof architecturePlugin.liftExact !== 'function') throw new TypeError('semantic-function-architecture-lifter-required');\n  const abiPlugin = resolveABIPlugin({ architecture:architectureId, platform:input.platform, abiId:input.abiId });",
    "  if (typeof architecturePlugin.liftExact !== 'function') throw new TypeError('semantic-function-architecture-lifter-required');\n  const requestedMemoryEndianness = input.memoryEndianness ?? input.endian ?? null;\n  if (requestedMemoryEndianness != null) {\n    const endian = String(requestedMemoryEndianness).trim().toLowerCase();\n    const supported = architecturePlugin.supportedMemoryEndianness ?? [];\n    if (supported.length && !supported.includes(endian))\n      throw new TypeError(`semantic-function-unsupported-memory-endianness:${endian}`);\n  }\n  const abiPlugin = resolveABIPlugin({ architecture:architectureId, platform:input.platform, abiId:input.abiId });",
)
replace_once(
    'js/targets/architecture/registry.js',
    "    this.validateEncoding = definition.validateEncoding || null;\n    this.instructionAlignment = positiveInteger(definition.instructionAlignment ?? 1, 'instructionAlignment');",
    "    this.validateEncoding = definition.validateEncoding || null;\n    this.supportedMemoryEndianness = Object.freeze([...new Set(\n      (Array.isArray(definition.supportedMemoryEndianness) ? definition.supportedMemoryEndianness : [])\n        .map((value) => canonicalId(value)).filter(Boolean)\n    )]);\n    this.instructionAlignment = positiveInteger(definition.instructionAlignment ?? 1, 'instructionAlignment');",
)
replace_once(
    'js/targets/architecture/index.js',
    "  if (op.startsWith('b.') || op === 'cbz' || op === 'cbnz' || op === 'tbz' || op === 'tbnz') return 'conditional-branch';\n  return 'fallthrough';",
    "  if (op.startsWith('b.') || op === 'cbz' || op === 'cbnz' || op === 'tbz' || op === 'tbnz') return 'conditional-branch';\n  if (/^(?:eret|eretaa|eretab|brk|svc|hvc|smc)$/.test(op)) return 'unknown';\n  return 'fallthrough';",
)
replace_once(
    'js/targets/architecture/index.js',
    "  if (op === 'jmp') return 'branch';\n  if (/^j[^m]/.test(op)) return 'conditional-branch';\n  return 'fallthrough';",
    "  if (op === 'jmp') return 'branch';\n  if (/^(?:loop|loope|loopz|loopne|loopnz)$/.test(op)) return 'conditional-branch';\n  if (op === 'ud2' || op === 'int3') return 'unknown';\n  if (/^j[^m]/.test(op)) return 'conditional-branch';\n  return 'fallthrough';",
)
replace_once('js/targets/architecture/index.js', "  if (!fields?.supported) return 'fallthrough';", "  if (!fields?.supported) return 'unknown';")
replace_once(
    'js/targets/architecture/index.js',
    "  decodeProvider:'capstone/backend', liftExact:liftRiscv64MachineEffects, classifyControlFlow:riscv64ControlFlow,\n  directControlTarget:riscv64DirectControlTarget,",
    "  decodeProvider:'capstone/backend', liftExact:liftRiscv64MachineEffects, classifyControlFlow:riscv64ControlFlow,\n  directControlTarget:riscv64DirectControlTarget, supportedMemoryEndianness:Object.freeze(['little']),",
)
replace_once(
    'js/targets/architecture/riscv64/effects/system.js',
    "        fenceMode: Number(fields.fenceMode) === 0b1000 ? 'tso' : 'normal',",
    "        fenceMode: Number(fields.fenceMode) === 0b1000\n          && Number(fields.predecessor) === 0b0011\n          && Number(fields.successor) === 0b0011 ? 'tso' : 'normal',",
)
replace_once(
    'js/targets/architecture/x86_64/effects/control.js',
    "const CONDITION_COUNT_BRANCHES = Object.freeze(new Map([\n  ['jrcxz','rcx'],\n  ['jecxz','ecx'],\n  ['jcxz','cx'],\n]));",
    "const CONDITION_COUNT_BRANCHES = Object.freeze(new Map([\n  ['jrcxz','rcx'],\n  ['jecxz','ecx'],\n  ['jcxz','cx'],\n]));\nconst LOOP_BRANCHES = Object.freeze(new Set(['loop','loope','loopz','loopne','loopnz']));\n\nfunction loopCountRegister(instruction) {\n  const legacy = Array.from(instruction?.detail?.prefixes?.legacy ?? []);\n  return legacy.includes(0x67) ? 'ecx' : 'rcx';\n}",
)
replace_once(
    'js/targets/architecture/x86_64/effects/control.js',
    "  const conditional = family.startsWith('j') && family !== 'jmp';",
    "  const conditional = (family.startsWith('j') && family !== 'jmp') || LOOP_BRANCHES.has(family);",
)
replace_once(
    'js/targets/architecture/x86_64/effects/control.js',
    "    const countRegister = CONDITION_COUNT_BRANCHES.get(family);\n    let condition;",
    "    if (LOOP_BRANCHES.has(family)) {\n      const countRegister = loopCountRegister(ctx.instruction);\n      const countOperand = x86RegisterOperand(countRegister);\n      const oldCount = countOperand ? ctx.readRegister(countOperand) : null;\n      if (!oldCount) {\n        return ctx.partial(`x86-${family}-count-register-unmodelled`, ['control','registers'], { controlEffect:{ kind:'unknown', reason:`x86-${family}-count-register-unmodelled` } });\n      }\n      const bits = countOperand.widthBits;\n      const decremented = ctx.valueOp('sub', [oldCount,ctx.constant(bits,1n)], bits, { widthBits:bits, semantic:`${countRegister} - 1`, loopCounter:true });\n      if (!ctx.writeRegister(countOperand, decremented)) {\n        return ctx.partial(`x86-${family}-count-register-write-unmodelled`, ['control','registers'], { controlEffect:{ kind:'unknown', reason:`x86-${family}-count-register-write-unmodelled` } });\n      }\n      const nonZero = ctx.valueOp('icmp.ne', [decremented,ctx.constant(bits,0n)], 1, { predicate:'ne', signed:false, widthBits:bits, semantic:`${countRegister} != 0 after decrement` });\n      let condition = nonZero;\n      let conditionKind = 'loop-count';\n      if (family !== 'loop') {\n        const zf = ctx.readFlag('ZF');\n        const wantsZero = family === 'loope' || family === 'loopz';\n        const zfCondition = wantsZero ? zf : ctx.valueOp('xor', [zf,ctx.constant(1,1n)], 1, { semantic:'ZF == 0' });\n        condition = ctx.valueOp('and', [nonZero,zfCondition], 1, { semantic:wantsZero ? 'count != 0 && ZF == 1' : 'count != 0 && ZF == 0' });\n        conditionKind = wantsZero ? 'loop-count-and-zf' : 'loop-count-and-not-zf';\n      }\n      return ctx.finish({ family:'control', controlEffect:{ kind:'conditional-branch', target:addressRef(target), fallthrough:fallthrough(ctx.instruction), condition }, metadata:{ operation:family, conditionKind, countRegister, countDecremented:true, flagsPreserved:true, instructionLength:ctx.instruction.length } });\n    }\n\n    const countRegister = CONDITION_COUNT_BRANCHES.get(family);\n    let condition;",
)

Path('tests/phase6/generic-core/issues-890-895.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionDecodedFunction, analyzeDecodedSemanticFunction } from '../../../js/analysis/semantic-function.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { liftRiscv64SystemEffects } from '../../../js/targets/architecture/riscv64/effects/system.js';
import { liftX86ControlEffects } from '../../../js/targets/architecture/x86_64/effects/control.js';

const rv = architecturePluginV2('riscv64');
const x86 = architecturePluginV2('x86_64');
const arm = architecturePluginV2('arm64');

test('unsupported RISC-V control is an unknown terminator with no invented fallthrough (#890)', () => {
  const blocks = partitionDecodedFunction([
    { address:0x1000n, size:4, fields:{ supported:false }, mnemonic:'mret' },
    { address:0x1004n, size:4, fields:{ supported:true, op:'addi' }, mnemonic:'addi' },
  ], rv);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].successors, []);
});

test('explicit big-endian input is rejected by the little-endian RISC-V profile (#891)', () => {
  assert.deepEqual(rv.supportedMemoryEndianness, ['little']);
  assert.throws(() => analyzeDecodedSemanticFunction({
    architecture:'riscv64', platform:'linux', abiId:'lp64', endian:'big',
    binaryId:'binary-test', sliceId:'slice-test', decoderSemanticVersion:'test', instructions:[],
  }), /semantic-function-unsupported-memory-endianness:big/);
});

test('x86 LOOP and UD2 control classification does not fabricate fallthrough (#892)', () => {
  const loopBlocks = partitionDecodedFunction([
    { address:0x2000n, size:2, instructionFamily:'loop', detail:{ operands:[{ type:'immediate', value:0x2004n }] } },
    { address:0x2002n, size:2, instructionFamily:'nop', detail:{ operands:[] } },
    { address:0x2004n, size:1, instructionFamily:'ret', detail:{ operands:[] } },
  ], x86);
  assert.deepEqual(new Set(loopBlocks[0].successors.map((edge) => edge.kind)), new Set(['conditional-true','conditional-false']));
  const trapBlocks = partitionDecodedFunction([
    { address:0x2100n, size:2, instructionFamily:'ud2', detail:{ operands:[] } },
    { address:0x2102n, size:1, instructionFamily:'nop', detail:{ operands:[] } },
  ], x86);
  assert.deepEqual(trapBlocks[0].successors, []);
});

test('x86 LOOP MachineEffects decrement count and retain the conditional transfer (#892)', () => {
  const bundle = liftX86ControlEffects({
    instructionId:'loop-test', address:0x2200n, length:2, size:2, mode:'long-64', rawBytes:[0xe2,0x02],
    instructionCode:1, instructionFamily:'loop', mnemonic:'loop', detailAvailable:true,
    detail:{ operands:[{ type:'immediate', value:0x2204n, encodedWidthBits:8, access:'read' }], prefixes:{ legacy:[] } },
  });
  assert.equal(bundle.controlEffect.kind, 'conditional-branch');
  assert.equal(bundle.metadata.countRegister, 'rcx');
  assert.equal(bundle.metadata.countDecremented, true);
  assert.ok(bundle.operations.some((op) => op.kind === 'register-write' && op.register?.id === 'rcx'));
});

test('ARM64 exception-return/trap instructions terminate normal CFG flow (#893)', () => {
  for (const mnemonic of ['eret','eretaa','eretab','brk','svc','hvc','smc']) {
    const blocks = partitionDecodedFunction([
      { address:0x3000n, size:4, mnemonic },
      { address:0x3004n, size:4, mnemonic:'add' },
    ], arm);
    assert.equal(blocks.length, 2, mnemonic);
    assert.deepEqual(blocks[0].successors, [], mnemonic);
  }
});

function fence(fields, id) {
  return liftRiscv64SystemEffects({
    instructionId:id, address:0x4000n, size:4, mode:'rv64imc',
    fields:{ supported:true, op:'fence', compressed:false, ...fields },
  });
}

test('FENCE.TSO requires the full canonical fm/pred/succ tuple (#895)', () => {
  const canonical = fence({ fenceMode:0b1000, predecessor:0b0011, successor:0b0011 }, 'fence-tso');
  const reservedSucc = fence({ fenceMode:0b1000, predecessor:0b0011, successor:0b0010 }, 'fence-reserved-succ');
  const reservedPred = fence({ fenceMode:0b1000, predecessor:0b0001, successor:0b0011 }, 'fence-reserved-pred');
  const otherFm = fence({ fenceMode:0b0111, predecessor:0b0011, successor:0b0011 }, 'fence-other-fm');
  const mode = (bundle) => bundle.operations.find((op) => op.kind === 'barrier').scope.fenceMode;
  assert.equal(mode(canonical), 'tso');
  assert.equal(mode(reservedSucc), 'normal');
  assert.equal(mode(reservedPred), 'normal');
  assert.equal(mode(otherFm), 'normal');
});
''')
