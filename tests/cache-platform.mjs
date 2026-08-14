import assert from 'node:assert/strict';
import { AnalysisCache } from '../js/cache/analysis-cache.js';

const memory = new Map();
const cache = new AnalysisCache({ indexedDB: null, memory, schemaVersion: 2 });
const input = { formatMetadata: { format: 'elf' }, functionSeeds: [1], binary: new Uint8Array([1,2,3]) };
await cache.put('abc', input);
input.formatMetadata.format = 'pe';
input.functionSeeds.push(2);
const value = await cache.get('abc');
assert.equal(value.formatMetadata.format, 'elf');
assert.deepEqual(value.functionSeeds, [1]);
assert.equal('binary' in value, false, 'binary bytes must never be cached');

// Reads are snapshots too; mutating a returned object cannot poison the cache.
value.functionSeeds.push(99);
assert.deepEqual((await cache.get('abc')).functionSeeds, [1]);

memory.set('1:old', { key: '1:old', schemaVersion: 1, binaryHash: 'old', data: {} });
assert.equal(await cache.invalidateStale(), 1);
console.log('cache-platform: PASS');
