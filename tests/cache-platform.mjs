import assert from 'node:assert/strict';
import { AnalysisCache } from '../js/cache/analysis-cache.js';

const memory = new Map();
const cache = new AnalysisCache({ indexedDB: null, memory, schemaVersion: 2 });
await cache.put('abc', { formatMetadata: { format: 'elf' }, functionSeeds: [1], binary: new Uint8Array([1,2,3]) });
const value = await cache.get('abc');
assert.equal(value.formatMetadata.format, 'elf');
assert.equal('binary' in value, false, 'binary bytes must never be cached');
memory.set('1:old', { key: '1:old', schemaVersion: 1, binaryHash: 'old', data: {} });
assert.equal(await cache.invalidateStale(), 1);
console.log('cache-platform: PASS');
