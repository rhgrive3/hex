import assert from 'node:assert/strict';
import { parseObjcExtendedMetadata } from '../js/objc.js';

const mem = new Uint8Array(0x5000);
const dv = new DataView(mem.buffer);
const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
const str = (at, s) => { for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i); mem[at + s.length] = 0; };
const read = async (addr, len) => {
  const at = Number(addr);
  if (at < 0 || at >= mem.length) return null;
  return mem.subarray(at, Math.min(mem.length, at + len));
};

// __objc_protolist -> protocol_t CoinProviding.
p64(0x100, 0x1000);
p64(0x1008, 0);
p64(0x1000 + 8, 0x1800);       // name
p64(0x1000 + 16, 0);           // inherited protocol list
p64(0x1000 + 24, 0x1100);      // instance methods
p64(0x1000 + 32, 0);
p64(0x1000 + 40, 0);
p64(0x1000 + 48, 0);
p64(0x1000 + 56, 0);
str(0x1800, 'CoinProviding');

p32(0x1100, 24); p32(0x1104, 1);
p64(0x1108, 0x1820);           // selector
p64(0x1110, 0x1840);           // types
p64(0x1118, 0);                // protocol requirement has no concrete IMP
str(0x1820, 'coinCount');
str(0x1840, 'q16@0:8');

// __objc_catlist -> PlayerData(Debug), with one concrete instance method.
p64(0x200, 0x1200);
p64(0x1200 + 0, 0x1860);       // category name
p64(0x1200 + 8, 0x2000);       // target class
p64(0x1200 + 16, 0x1300);      // instance methods
p64(0x1200 + 24, 0);
p64(0x1200 + 32, 0);
p64(0x1200 + 40, 0);
p64(0x1200 + 48, 0);
str(0x1860, 'Debug');

p32(0x1300, 24); p32(0x1304, 1);
p64(0x1308, 0x1880);
p64(0x1310, 0x18a0);
p64(0x1318, 0x3000);
str(0x1880, 'debugName');
str(0x18a0, '@16@0:8');

const parsed = await parseObjcExtendedMetadata(read, {
  protocolList: { vmAddr: 0x100n, size: 8n },
  categoryList: { vmAddr: 0x200n, size: 8n },
}, {
  classes: [{ name: 'PlayerData', addr: 0x2000n }],
});

assert.equal(parsed.protocols.length, 1);
assert.equal(parsed.protocols[0].name, 'CoinProviding');
assert.equal(parsed.protocols[0].methods[0].sel, 'coinCount');
assert.equal(parsed.protocols[0].methods[0].imp, null);
assert.equal(parsed.categories.length, 1);
assert.equal(parsed.categories[0].name, 'Debug');
assert.equal(parsed.categories[0].className, 'PlayerData');
assert.equal(parsed.categories[0].methods[0].sel, 'debugName');
assert.equal(parsed.categories[0].methods[0].imp, 0x3000n);

console.log('objc-metadata: ok');
