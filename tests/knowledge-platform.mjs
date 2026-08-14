import assert from 'node:assert/strict';
import { KnowledgeDB, fingerprintVendors } from '../js/knowledge/index.js';

const db = new KnowledgeDB({ indexedDB: null, memory: new Map() });
const fn = { address: 0x1000n, bytes: Uint8Array.from([1,2,3,4,5,6,7,8]), strings: ['coins'], imports: ['memcpy'], cfg: { blocks: 2, edges: 1, exits: 1 } };
await db.remember({ fingerprint: fn, name: 'PlayerData::addCoins', sourceBinaryHash: 'v1', versions: ['1.0'], confidence: 0.99, evidence: [{ kind: 'manual-confirmation' }] });
const found = await db.reidentify({ ...fn, address: 0x9000n });
assert.equal(found.matched, true);
assert.equal(found.knowledge.names[0], 'PlayerData::addCoins');

const vendors = fingerprintVendors({ libraries: ['/Frameworks/UnityFramework.framework/UnityFramework'], symbols: ['il2cpp_codegen_register'] });
assert.equal(vendors.some((x) => x.name === 'Unity'), true);
assert.equal(vendors.every((x) => x.confirmed === false), true, 'vendor fingerprinting must remain evidence-based, not asserted as fact');
console.log('knowledge-platform: PASS');
