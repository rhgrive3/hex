from pathlib import Path

registry = Path('js/targets/abi/registry.js')
text = registry.read_text()
anchor = "function frozenArray(value) { return Object.freeze(Array.isArray(value) ? value.slice() : []); }\n"
addition = """function frozenArray(value) { return Object.freeze(Array.isArray(value) ? value.slice() : []); }\n\nexport function canonicalCallingConvention(value) {\n  let id = canonicalId(value).replace(/^__+/, '');\n  if (!id) return '';\n  if (id === 'ms-x64' || id === 'msvc-x64' || id === 'x64') return 'microsoft-x64';\n  if (id === 'microsoft-vectorcall' || id === 'msvc-vectorcall') return 'vectorcall';\n  return id;\n}\n\nfunction pluginClaimsConvention(plugin, requested) {\n  if (!requested) return true;\n  let claims = [];\n  try { claims = plugin.callingConventions?.() ?? []; } catch { claims = []; }\n  return claims.map(canonicalCallingConvention).includes(requested);\n}\n"""
if text.count(anchor) != 1:
    raise SystemExit('#954 registry helper anchor mismatch')
text = text.replace(anchor, addition, 1)
old = """export function findABIPlugin({ id = null, architecture = null, platform = null } = {}) {\n  if (id) return abiPlugin(id);\n  const arch = canonicalId(architecture);\n  const platformId = canonicalId(platform);\n  for (const plugin of ABI_PLUGINS.values()) {\n    if (!plugin.supported || plugin.id === 'unknown') continue;\n    if (arch && plugin.architectureId !== arch && !(arch === 'arm64e' && plugin.architectureId === 'arm64')) continue;\n    let matches = false;\n    try { matches = plugin.platformPredicate({ architecture:arch, platform:platformId }); } catch { matches = false; }\n    if (matches) return plugin;\n  }\n  return abiPlugin('unknown');\n}\n"""
new = """export function findABIPlugin({ id = null, architecture = null, platform = null, callingConvention = null } = {}) {\n  const requestedConvention = canonicalCallingConvention(callingConvention);\n  if (id) {\n    const plugin = abiPlugin(id);\n    if (!plugin?.supported || !pluginClaimsConvention(plugin, requestedConvention)) return abiPlugin('unknown');\n    return plugin;\n  }\n  const arch = canonicalId(architecture);\n  const platformId = canonicalId(platform);\n  for (const plugin of ABI_PLUGINS.values()) {\n    if (!plugin.supported || plugin.id === 'unknown') continue;\n    if (arch && plugin.architectureId !== arch && !(arch === 'arm64e' && plugin.architectureId === 'arm64')) continue;\n    if (!pluginClaimsConvention(plugin, requestedConvention)) continue;\n    let matches = false;\n    try { matches = plugin.platformPredicate({ architecture:arch, platform:platformId, callingConvention:requestedConvention || null }); } catch { matches = false; }\n    if (matches) return plugin;\n  }\n  return abiPlugin('unknown');\n}\n"""
if text.count(old) != 1:
    raise SystemExit('#954 registry resolver anchor mismatch')
registry.write_text(text.replace(old, new, 1))

index = Path('js/targets/abi/index.js')
text = index.read_text()
text = text.replace("import { ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin } from './registry.js';", "import { ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin, canonicalCallingConvention } from './registry.js';")
text = text.replace("  ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin,", "  ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin, canonicalCallingConvention,")
old = """  const explicit = target?.abiId || (typeof target?.abi === 'string' ? target.abi : null);\n  if (explicit) return abiPlugin(explicit);\n  const found = findABIPlugin({ architecture:target?.architecture || target?.arch, platform:target?.platform });\n"""
new = """  const explicit = target?.abiId || (typeof target?.abi === 'string' ? target.abi : null);\n  const prototype = target?.callPrototype ?? target?.functionPrototype ?? target?.prototype ?? null;\n  const requestedConvention = canonicalCallingConvention(\n    target?.callingConvention ?? prototype?.callingConvention ?? prototype?.convention ?? prototype?.cc ?? '',\n  );\n  const found = findABIPlugin({\n    id:explicit,\n    architecture:target?.architecture || target?.arch,\n    platform:target?.platform,\n    callingConvention:requestedConvention,\n  });\n"""
if text.count(old) != 1:
    raise SystemExit('#954 ABI index resolver anchor mismatch')
index.write_text(text.replace(old, new, 1))

semantic = Path('js/analysis/semantic-function.js')
text = semantic.read_text()
old = "const abiPlugin = resolveABIPlugin({ architecture:architectureId, platform:input.platform, abiId:input.abiId });"
new = """const abiPlugin = resolveABIPlugin({\n    architecture:architectureId,\n    platform:input.platform,\n    abiId:input.abiId,\n    callPrototype:input.callPrototype ?? null,\n    callingConvention:input.callingConvention\n      ?? input.callPrototype?.callingConvention\n      ?? input.callPrototype?.convention\n      ?? input.callPrototype?.cc\n      ?? null,\n  });"""
if text.count(old) != 1:
    raise SystemExit('#954 semantic function resolver anchor mismatch')
semantic.write_text(text.replace(old, new, 1))

ms = Path('js/targets/abi/microsoft-x64.js')
text = ms.read_text()
insert = """function parameterList(prototype) {\n  const list = prototype && (prototype.args || prototype.parameters || prototype.params || prototype.arguments);\n  return Array.isArray(list) ? list : null;\n}\n"""
helpers = r'''function parameterList(prototype) {
  const list = prototype && (prototype.args || prototype.parameters || prototype.params || prototype.arguments);
  return Array.isArray(list) ? list : null;
}

function canonicalMicrosoftConvention(value) {
  let id = String(value ?? '').trim().toLowerCase().replace(/^__+/, '');
  if (id === 'ms-x64' || id === 'msvc-x64' || id === 'x64') id = 'microsoft-x64';
  return id;
}

function requestedConvention(prototype, options = {}) {
  return canonicalMicrosoftConvention(
    options.callingConvention ?? prototype?.callingConvention ?? prototype?.convention ?? prototype?.cc ?? '',
  );
}

function standardConventionRequested(prototype, options = {}) {
  const convention = requestedConvention(prototype, options);
  return !convention || convention === 'microsoft-x64' || convention === 'win64';
}

function unsupportedConventionArguments(convention) {
  return {
    srcs:[], arguments:[], stackArguments:[], stackArgsUnknown:true,
    stackArgsMayContainPointers:true,
    aggregateClassification:'unsupported-calling-convention',
    variadicClassification:'unsupported-calling-convention',
    partial:true,
    unsupported:true,
    unsupportedCallingConvention:convention,
    scope:MICROSOFT_X64_SCOPE,
    evidence:`unsupported-microsoft-x64-calling-convention:${convention}`,
  };
}

function microsoftX64ReturnDecision(prototype, options = {}) {
  if (!prototype) return { kind:'unknown', aggregate:false, reason:'prototype-missing' };
  if (!standardConventionRequested(prototype, options)) {
    return { kind:'unsupported', aggregate:false, convention:requestedConvention(prototype, options), reason:'unsupported-calling-convention' };
  }
  const type = String(options.returnType || prototype.returnType || prototype.ret || prototype.result || '').trim().toLowerCase();
  const abiClass = String(options.returnClass || prototype.returnClass || prototype.abiClass || prototype.resultClass || '').trim().toLowerCase();
  if (options.returnsValue === false || prototype.returnsValue === false || prototype.void === true || type === 'void' || abiClass === 'void') {
    return { kind:'void', aggregate:false };
  }
  if (prototype.indirectResult === true || abiClass === 'indirect') {
    return { kind:'indirect', aggregate:true, bits:Number(options.returnBits ?? prototype.returnBits ?? prototype.bits) || null, reason:'explicit-indirect-result' };
  }
  const aggregate = prototype.aggregate === true || prototype.isAggregate === true || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`);
  if (aggregate) {
    const rawBits = Number(options.returnBits ?? prototype.returnBits ?? prototype.bits);
    const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? rawBits : null;
    const nonTrivial = options.returnNonTrivialForCalls === true || prototype.returnNonTrivialForCalls === true || prototype.nonTrivialForCalls === true || prototype.nonTrivial === true;
    const trivial = options.returnTrivialForCalls === true || prototype.returnTrivialForCalls === true || prototype.trivialForCalls === true || prototype.pod === true;
    if (bits != null && (nonTrivial || ![8,16,32,64].includes(bits))) {
      return { kind:'indirect', aggregate:true, bits, reason:nonTrivial ? 'nontrivial-udt' : 'udt-size-requires-indirect-result' };
    }
    if (bits != null && trivial && [8,16,32,64].includes(bits)) {
      return { kind:'direct-integer', aggregate:true, bits, reason:'proven-direct-udt' };
    }
    return { kind:'partial', aggregate:true, bits, reason:'microsoft-x64-aggregate-return-classification-not-proven' };
  }
  const vector = /vector|simd|sse/.test(`${type} ${abiClass}`);
  const floating = vector || /(^|\s)(?:float|double)(?:\s|$)|\bfp\b/.test(`${type} ${abiClass}`);
  const rawBits = Number(prototype.returnBits || prototype.bits || options.returnBits || typeBits(type, vector ? 128 : 64));
  const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? Math.min(128, rawBits) : 64;
  if (floating) return { kind:'direct-vector', aggregate:false, bits };
  if (type || abiClass || options.returnsValue === true || prototype.returnsValue === true) return { kind:'direct-integer', aggregate:false, bits };
  return { kind:'unknown', aggregate:false, reason:'return-kind-unknown' };
}
'''
if text.count(insert) != 1:
    raise SystemExit('#954/#955 microsoft helper anchor mismatch')
text = text.replace(insert, helpers, 1)

old = """export function classifyMicrosoftX64Arguments(instruction, options = {}) {\n  const prototype = callPrototypeOf(instruction, options);\n  const parameters = parameterList(prototype);\n  if (!parameters) return conservativeUnknownArguments();\n\n  const variadic = prototype?.variadic === true || prototype?.varargs === true;\n"""
new = """export function classifyMicrosoftX64Arguments(instruction, options = {}) {\n  const prototype = callPrototypeOf(instruction, options);\n  const convention = requestedConvention(prototype, options);\n  if (!standardConventionRequested(prototype, options)) return unsupportedConventionArguments(convention);\n  const parameters = parameterList(prototype);\n  if (!parameters) return conservativeUnknownArguments();\n  const returnDecision = microsoftX64ReturnDecision(prototype, options);\n  if (returnDecision.kind === 'partial') {\n    return {\n      ...conservativeUnknownArguments(),\n      partial:true,\n      returnClassification:returnDecision,\n      evidence:'partial-microsoft-x64-return-classification',\n    };\n  }\n\n  const variadic = prototype?.variadic === true || prototype?.varargs === true;\n"""
if text.count(old) != 1:
    raise SystemExit('#954/#955 classify arguments head mismatch')
text = text.replace(old, new, 1)
old = """  const indirectResult = prototype?.indirectResult === true || String(prototype?.returnClass || '').toLowerCase() === 'indirect';\n  const positionBias = indirectResult ? 1 : 0;\n"""
new = """  const indirectResult = returnDecision.kind === 'indirect';\n  const positionBias = indirectResult ? 1 : 0;\n"""
if text.count(old) != 1:
    raise SystemExit('#955 indirect result anchor mismatch')
text = text.replace(old, new, 1)
old = "arguments_.push({ index:-1, role:'indirect-result', location:'register', reg:INTEGER_ARGUMENT_REGISTERS[0], abiClass:'pointer', pointer:true, bits:64, hidden:true });"
new = "arguments_.push({ index:-1, role:'indirect-result', location:'register', reg:INTEGER_ARGUMENT_REGISTERS[0], abiClass:'pointer', pointer:true, bits:64, hidden:true, callerAllocatedResultStorage:true, returnedIn:'rax', returnBits:returnDecision.bits ?? null, returnReason:returnDecision.reason });"
if text.count(old) != 1:
    raise SystemExit('#955 hidden result entry anchor mismatch')
text = text.replace(old, new, 1)

start = text.index('function classifyReturn(prototype, options = {}) {')
end = text.index('\nexport function classifyMicrosoftX64CallReturn', start)
new_return = r'''function classifyReturn(prototype, options = {}) {
  const decision = microsoftX64ReturnDecision(prototype, options);
  if (decision.kind === 'void' || decision.kind === 'unknown') return null;
  if (decision.kind === 'unsupported') {
    return { reg:null, partial:true, unsupported:true, callingConvention:decision.convention, reason:'microsoft-x64-unsupported-calling-convention' };
  }
  if (decision.kind === 'partial') return { reg:null, partial:true, aggregate:true, bits:decision.bits, reason:decision.reason };
  if (decision.kind === 'indirect') {
    return {
      reg:'rax', bits:64, indirect:true, aggregate:true,
      hiddenResultPointer:{ input:'rcx', returned:'rax' },
      callerAllocatedResultStorage:true,
      resultBits:decision.bits,
      reason:decision.reason,
    };
  }
  if (decision.kind === 'direct-vector') return { reg:'xmm0', bits:decision.bits };
  return { reg:'rax', bits:decision.bits, ...(decision.aggregate ? { aggregate:true, abiClass:'integer-aggregate' } : {}) };
}
'''
text = text[:start] + new_return + text[end:]
text = text.replace("semanticVersion:'2',", "semanticVersion:'3',", 1)
ms.write_text(text)

test = Path('tests/phase5/abi/issues-954-955-win64-abi.test.mjs')
test.parent.mkdir(parents=True, exist_ok=True)
test.write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';
import {
  classifyMicrosoftX64Arguments,
  classifyMicrosoftX64CallReturn,
} from '../../../js/targets/abi/microsoft-x64.js';

const vector128 = { type:'__m128', vector:true, bits:128 };

test('issue #954: known __vectorcall never silently falls through to standard Win64', () => {
  const standard = resolveABIPlugin({ architecture:'x86_64', platform:'windows', callingConvention:'win64' });
  const vectorcall = resolveABIPlugin({ architecture:'x86_64', platform:'windows', callingConvention:'__vectorcall' });
  assert.equal(standard.id, 'microsoft-x64');
  assert.equal(standard.supported, true);
  assert.equal(vectorcall.id, 'unknown');
  assert.equal(vectorcall.supported, false);

  const standardArgs = classifyMicrosoftX64Arguments({ callPrototype:{ callingConvention:'win64', args:[vector128] } });
  assert.equal(standardArgs.arguments[0].reg, 'rcx');
  assert.equal(standardArgs.arguments[0].abiClass, 'vector-indirect');
  assert.equal(standardArgs.arguments[0].pointer, true);

  const rejected = classifyMicrosoftX64Arguments({ callPrototype:{ callingConvention:'__vectorcall', args:[vector128] } });
  assert.equal(rejected.partial, true);
  assert.equal(rejected.unsupported, true);
  assert.equal(rejected.unsupportedCallingConvention, 'vectorcall');
  assert.deepEqual(rejected.srcs, []);
  assert.equal(rejected.stackArgsMayContainPointers, true);
});

test('issue #955: proven 128-bit UDT return derives hidden RCX and shifts user args', () => {
  const prototype = {
    callingConvention:'win64', returnType:'struct Pair', aggregate:true,
    returnBits:128, returnTrivialForCalls:true,
    args:[{ type:'uint64_t', bits:64 }],
  };
  const args = classifyMicrosoftX64Arguments({ callPrototype:prototype });
  assert.equal(args.arguments[0].role, 'indirect-result');
  assert.equal(args.arguments[0].reg, 'rcx');
  assert.equal(args.arguments[0].callerAllocatedResultStorage, true);
  assert.equal(args.arguments[1].reg, 'rdx');
  const returned = classifyMicrosoftX64CallReturn({ callPrototype:prototype });
  assert.equal(returned.indirect, true);
  assert.deepEqual(returned.hiddenResultPointer, { input:'rcx', returned:'rax' });
  assert.equal(returned.resultBits, 128);
});

test('issue #955: hidden sret shifts the fourth user argument to stack', () => {
  const prototype = {
    returnType:'struct Pair', aggregate:true, returnBits:128, returnTrivialForCalls:true,
    args:Array.from({ length:4 }, () => ({ type:'uint64_t', bits:64 })),
  };
  const args = classifyMicrosoftX64Arguments({ callPrototype:prototype });
  const user = args.arguments.filter((entry) => !entry.hidden);
  assert.deepEqual(user.slice(0, 3).map((entry) => entry.reg), ['rdx','r8','r9']);
  assert.equal(user[3].location, 'stack');
  assert.equal(user[3].offset, 32);
});

test('issue #955 controls: direct 64-bit trivial UDT, nontrivial small UDT, scalar', () => {
  const direct = { returnType:'struct Small', aggregate:true, returnBits:64, returnTrivialForCalls:true, args:[{ type:'uint64_t' }] };
  assert.equal(classifyMicrosoftX64Arguments({ callPrototype:direct }).arguments[0].reg, 'rcx');
  assert.deepEqual(classifyMicrosoftX64CallReturn({ callPrototype:direct }), { reg:'rax', bits:64, aggregate:true, abiClass:'integer-aggregate' });

  const nontrivial = { returnType:'struct Small', aggregate:true, returnBits:64, nonTrivialForCalls:true, args:[{ type:'uint64_t' }] };
  assert.equal(classifyMicrosoftX64Arguments({ callPrototype:nontrivial }).arguments[0].role, 'indirect-result');
  assert.equal(classifyMicrosoftX64Arguments({ callPrototype:nontrivial }).arguments[1].reg, 'rdx');

  const scalar = { returnType:'uint64_t', returnBits:64, args:[{ type:'uint64_t' }] };
  assert.equal(classifyMicrosoftX64Arguments({ callPrototype:scalar }).arguments[0].reg, 'rcx');
  assert.deepEqual(classifyMicrosoftX64CallReturn({ callPrototype:scalar }), { reg:'rax', bits:64 });
});

test('issue #955: ambiguous aggregate return does not produce false-exact user placement', () => {
  const ambiguous = { returnType:'struct Maybe', aggregate:true, returnBits:64, args:[{ type:'uint64_t' }] };
  const args = classifyMicrosoftX64Arguments({ callPrototype:ambiguous });
  assert.equal(args.partial, true);
  assert.equal(args.evidence, 'partial-microsoft-x64-return-classification');
  assert.equal(args.stackArgsMayContainPointers, true);
  const returned = classifyMicrosoftX64CallReturn({ callPrototype:ambiguous });
  assert.equal(returned.partial, true);
  assert.equal(returned.reg, null);
});
''')
