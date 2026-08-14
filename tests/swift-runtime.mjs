import assert from 'node:assert/strict';
import {
  parseSwiftNominalDescriptor, parseSwiftFieldDescriptor, parseSwiftProtocolDescriptor,
  parseSwiftConformanceDescriptor, buildSwiftRuntimeIndex, resolveSwiftDispatch,
  demangleSwiftSymbol, swiftCallingConvention, formatSwiftCall,
} from '../js/swift.js';

const mem = new Uint8Array(0x3000);
const dv = new DataView(mem.buffer);
const put32 = (a, v) => dv.setUint32(a, Number(v) >>> 0, true);
const putI32 = (a, v) => dv.setInt32(a, Number(v), true);
const put16 = (a, v) => dv.setUint16(a, Number(v), true);
const putStr = (a, s) => { for (let i = 0; i < s.length; i++) mem[a + i] = s.charCodeAt(i); mem[a + s.length] = 0; };
const read = async (addr, len) => {
  const a = Number(addr);
  if (a < 0 || a >= mem.length) return null;
  return mem.subarray(a, Math.min(mem.length, a + len));
};

// Stable struct nominal descriptor at 0x1100.
put32(0x1100, 17); // ContextDescriptorKind::Struct
putI32(0x1104, 0);
putI32(0x1108, 0x1200 - 0x1108);
putI32(0x110c, 0);
putI32(0x1110, 0x1300 - 0x1110);
put32(0x1114, 1); // numFields
put32(0x1118, 3); // field offset vector offset
putStr(0x1200, 'PlayerState');

// Field descriptor + one field record.
putI32(0x1300, 0); putI32(0x1304, 0); put16(0x1308, 0); put16(0x130a, 12); put32(0x130c, 1);
put32(0x1310, 2); // var
putI32(0x1314, 0x1400 - 0x1314);
putI32(0x1318, 0x1410 - 0x1318);
putStr(0x1400, '$sSi');
putStr(0x1410, 'hp');

// Protocol descriptor.
put32(0x1500, 3);
putI32(0x1504, 0);
putI32(0x1508, 0x1520 - 0x1508);
put32(0x150c, 0); put32(0x1510, 1); putI32(0x1514, 0);
putStr(0x1520, 'Damageable');

// Conformance descriptor: protocol, type, witness pattern.
putI32(0x1600, 0x1500 - 0x1600);
putI32(0x1604, 0x1100 - 0x1604);
putI32(0x1608, 0x1700 - 0x1608);
put32(0x160c, 0);

const type = await parseSwiftNominalDescriptor(read, 0x1100n);
assert.equal(type.kind, 'struct');
assert.equal(type.name, 'PlayerState');
const fields = await parseSwiftFieldDescriptor(read, type.fieldDescriptor);
assert.equal(fields.length, 1);
assert.equal(fields[0].name, 'hp');
assert.equal(fields[0].var, true);
const proto = await parseSwiftProtocolDescriptor(read, 0x1500n);
assert.equal(proto.name, 'Damageable');
const conf = await parseSwiftConformanceDescriptor(read, 0x1600n);
assert.equal(conf.protocol, 0x1500n);
assert.equal(conf.typeRef, 0x1100n);
assert.equal(conf.witnessTable, 0x1700n);

// Vtable and witness dispatch resolution keep ABI slot evidence.
const index = buildSwiftRuntimeIndex({
  types: [{ ...type, vtable: [{ index: 0, impl: 0x2000n, name: 'takeDamage' }] }],
  protocols: [proto], conformances: [conf],
  vtables: [{ typeName: 'PlayerState', methods: [{ index: 0, impl: 0x2000n, name: 'takeDamage' }] }],
  witnessTables: [{ address: 0x1700n, typeName: 'PlayerState', protocolName: 'Damageable', entries: [{ index: 0, target: 0x2000n }] }],
});
const vr = resolveSwiftDispatch(index, { kind: 'vtable', typeName: 'PlayerState', slot: 0 });
assert.equal(vr.resolved.impl, 0x2000n);
const wr = resolveSwiftDispatch(index, { kind: 'witness', typeName: 'PlayerState', protocolName: 'Damageable', slot: 0 });
assert.equal(wr.resolved.target, 0x2000n);

const demangled = demangleSwiftSymbol('$s4Game6loaderyyYaKF');
assert.equal(demangled.parsed, true);
assert.deepEqual(demangled.components.slice(0, 2), ['Game', 'loader']);
const cc = swiftCallingConvention({ mangled: '$s4Game6loaderyyYaKF' });
assert.equal(cc.swiftasync, true);
assert.equal(cc.swiftthrows, true);
assert.equal(cc.representation, 'await-throwing');
assert.match(formatSwiftCall('$s4Game6loaderyyYaKF', ['ctx'], cc), /^try await /);

console.log('swift-runtime: ok');
