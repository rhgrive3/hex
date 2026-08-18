from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"guard failed for {path}: expected 1 match, got {count}")
    p.write_text(text.replace(old, new, 1))

replace_once(
    "js/targets/architecture/index.js",
    "  if (op === 'jal') return fields.rd === 'x0' ? 'branch' : 'call';\n  if (op === 'jalr') {\n    if (fields.rd !== 'x0') return 'call';",
    "  if (op === 'jal') return fields.rd === 'x0' ? 'branch' : ['x1', 'x5'].includes(fields.rd) ? 'call' : 'branch';\n  if (op === 'jalr') {\n    if (['x1', 'x5'].includes(fields.rd)) return 'call';\n    if (fields.rd !== 'x0') return 'branch';",
)

replace_once(
    "js/targets/architecture/riscv64/effects/control.js",
    "    const linked = ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, next));\n    return ctx.finish({\n      controlEffect: linked\n        ? { kind: 'call', target: addressRef(target), fallthrough: addressRef(next) }\n        : { kind: 'branch', target: addressRef(target) },",
    "    const linked = ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, next));\n    const isCallHint = linked && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rd);\n    return ctx.finish({\n      controlEffect: isCallHint\n        ? { kind: 'call', target: addressRef(target), fallthrough: addressRef(next) }\n        : { kind: 'branch', target: addressRef(target) },",
)
replace_once(
    "js/targets/architecture/riscv64/effects/control.js",
    "      metadata: { operation: op, direct: true, linkRegister: linked ? fields.rd : null, abiSemantics: false },",
    "      metadata: { operation: op, direct: true, linkRegister: linked ? fields.rd : null, jumpWithLinkage: linked && !isCallHint, abiSemantics: false },",
)
replace_once(
    "js/targets/architecture/riscv64/effects/control.js",
    "    const linked = ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, next));\n    const isReturnHint = !linked && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rs1);\n    const kind = linked ? 'call' : isReturnHint ? 'return' : 'indirect';",
    "    const linked = ctx.writeRegister(fields.rd, ctx.constant(RISCV64_XLEN, next));\n    const isCallHint = linked && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rd);\n    const isReturnHint = !linked && RETURN_ADDRESS_HINT_REGISTERS.includes(fields.rs1);\n    const kind = isCallHint ? 'call' : isReturnHint ? 'return' : 'indirect';",
)
replace_once(
    "js/targets/architecture/riscv64/effects/control.js",
    "        returnAddressStackHint: isReturnHint ? fields.rs1 : null,\n        abiSemantics: false,",
    "        returnAddressStackHint: isReturnHint ? fields.rs1 : null,\n        jumpWithLinkage: linked && !isCallHint,\n        abiSemantics: false,",
)

replace_once(
    "js/analysis/semantic-function.js",
    "function directTarget(plugin, instruction) {\n  try {\n    const target = plugin.directControlTarget?.(instruction);\n    return target == null ? null : BigInt(target);\n  } catch { return null; }\n}\n",
    "function directTarget(plugin, instruction) {\n  try {\n    const target = plugin.directControlTarget?.(instruction);\n    return target == null ? null : BigInt(target);\n  } catch { return null; }\n}\n\nfunction callNoreturnState(options = {}) {\n  const prototype = options?.callPrototype;\n  if (!prototype || typeof prototype !== 'object') return 'unknown';\n  if (prototype.noreturn === true || prototype.returns === false) return true;\n  if (prototype.noreturn === false || prototype.returns === true) return false;\n  return 'unknown';\n}\n\nfunction isAuthoritativeNoreturnCall(kind, options = {}) {\n  return kind === 'call' && callNoreturnState(options) === true;\n}\n",
)
replace_once(
    "js/analysis/semantic-function.js",
    "export function partitionDecodedFunction(instructions, architecturePlugin) {",
    "export function partitionDecodedFunction(instructions, architecturePlugin, options = {}) {",
)
replace_once(
    "js/analysis/semantic-function.js",
    "    if (['branch','conditional-branch','return','unknown'].includes(kind) && ordered[index + 1]) starts.add(addressOf(ordered[index + 1]).toString());",
    "    if ((['branch','conditional-branch','return','unknown'].includes(kind) || isAuthoritativeNoreturnCall(kind, options)) && ordered[index + 1]) starts.add(addressOf(ordered[index + 1]).toString());",
)
replace_once(
    "js/analysis/semantic-function.js",
    "    } else if (kind !== 'return' && fallthroughBlock) {\n      block.successors.push({ to:fallthroughBlock.key, kind:'fallthrough' });\n    }",
    "    } else if (kind !== 'return' && !isAuthoritativeNoreturnCall(kind, options) && fallthroughBlock) {\n      block.successors.push({ to:fallthroughBlock.key, kind:'fallthrough' });\n    }",
)
replace_once(
    "js/analysis/semantic-function.js",
    "        returnEvidence:returned == null ? null : `abi-${abiPlugin.id}-return`,\n      };",
    "        returnEvidence:returned == null ? null : `abi-${abiPlugin.id}-return`,\n        noreturn:callNoreturnState(options),\n      };",
)
replace_once(
    "js/analysis/semantic-function.js",
    "  const blocks = partitionDecodedFunction(input.instructions, architecturePlugin);",
    "  const blocks = partitionDecodedFunction(input.instructions, architecturePlugin, { callPrototype:input.callPrototype ?? null });",
)

Path("tests/phase6/generic-core/issues-889-897.test.mjs").write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { liftRiscv64ControlEffects } from '../../../js/targets/architecture/riscv64/effects/control.js';
import { partitionDecodedFunction, semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';

function rv(op, fields = {}, address = 0x1000n) {
  return {
    instructionId:`${op}-${address.toString(16)}`,
    address,
    size:4,
    length:4,
    mode:'rv64imc',
    origin:{ instructionIds:[`${op}-${address.toString(16)}`] },
    fields:{ supported:true, compressed:false, op, ...fields },
  };
}

test('issue #889: non-RAS link registers do not become ABI calls', () => {
  const plugin = architecturePluginV2('riscv64');
  assert.equal(plugin.classifyControlFlow(rv('jal', { rd:'x6', imm:8n })), 'branch');
  assert.equal(plugin.classifyControlFlow(rv('jal', { rd:'x1', imm:8n })), 'call');
  assert.equal(plugin.classifyControlFlow(rv('jal', { rd:'x5', imm:8n })), 'call');

  const direct = liftRiscv64ControlEffects(rv('jal', { rd:'x6', imm:8n }));
  assert.equal(direct.controlEffect.kind, 'branch');
  assert.equal(direct.metadata.jumpWithLinkage, true);
  assert.ok(direct.operations.some((op) => op.kind === 'register-write'));

  const indirect = liftRiscv64ControlEffects(rv('jalr', { rd:'x6', rs1:'x10', imm:0n }));
  assert.equal(indirect.controlEffect.kind, 'indirect');
  assert.equal(indirect.metadata.jumpWithLinkage, true);
  assert.ok(indirect.controlEffect.target);

  const realCall = liftRiscv64ControlEffects(rv('jalr', { rd:'x1', rs1:'x10', imm:0n }));
  assert.equal(realCall.controlEffect.kind, 'call');
});

test('issue #897: authoritative noreturn call has no normal CFG successor', () => {
  const plugin = {
    classifyControlFlow: (instruction) => instruction.kind,
    directControlTarget: () => null,
  };
  const instructions = [
    { address:0x1000n, size:4, length:4, kind:'call' },
    { address:0x1004n, size:4, length:4, kind:'fallthrough' },
    { address:0x1008n, size:4, length:4, kind:'return' },
  ];
  const blocks = partitionDecodedFunction(instructions, plugin, { callPrototype:{ noreturn:true } });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].instructions.length, 1);
  assert.deepEqual(blocks[0].successors, []);

  const ordinary = partitionDecodedFunction(instructions, plugin, { callPrototype:{ noreturn:false } });
  assert.equal(ordinary[0].instructions.length, 3);
});

test('issue #897: ABI call summary preserves typed noreturn evidence without conflating void', () => {
  const abi = {
    id:'test', semanticVersion:'1',
    stackRules:()=>({}), unwindRules:()=>({}),
    classifyArguments:()=>({ arguments:[], stackArguments:[], stackArgsUnknown:false, stackArgsMayContainPointers:false }),
    classifyCallReturn:()=>null,
    callerSaved:()=>[],
  };
  assert.equal(semanticAbiAdapter(abi, { callPrototype:{ noreturn:true, returnType:'void' } }).classifyCall({ call:{} }).noreturn, true);
  assert.equal(semanticAbiAdapter(abi, { callPrototype:{ noreturn:false, returnType:'void' } }).classifyCall({ call:{} }).noreturn, false);
  assert.equal(semanticAbiAdapter(abi, { callPrototype:{ returnType:'void', returnsValue:false } }).classifyCall({ call:{} }).noreturn, 'unknown');
});
''')
