import assert from 'node:assert/strict';
import { ArtifactStore, artifactPayloadChecksum } from '../../../js/core/artifacts/index.js';
import { artifactRecordChecksum } from '../../../js/core/artifacts/storage/integrity.js';
import { PersistentMemoryBackend, descriptor } from './support.mjs';

async function corruptCase(name, mutate, expectedStatus, expectedReason) {
  const entries = new Map();
  const backend = new PersistentMemoryBackend({ entries });
  const store = new ArtifactStore({ backend });
  const d = descriptor(`corrupt-${name}`);
  await store.publish(d, { a:1, z:2 });
  store.evictHot(d.artifactId);
  mutate(entries.get(d.artifactId));
  const result = await store.get(d);
  assert.equal(result.status, expectedStatus, name);
  assert.equal(result.reason, expectedReason, name);
  assert.notEqual(result.status, 'hit', name);
}

await corruptCase('checksum', (raw) => { new Uint8Array(raw.payload)[0] ^= 1; }, 'corrupt', 'artifact-payload-checksum-mismatch');
await corruptCase('truncated', (raw) => { raw.payload = raw.payload.slice(0, raw.payload.byteLength - 1); }, 'corrupt', 'artifact-payload-truncated');
await corruptCase('malformed-payload', (raw) => {
  raw.payload = new TextEncoder().encode('{').buffer;
  raw.record.payloadSize = 1;
  raw.record.payloadChecksum = artifactPayloadChecksum(new Uint8Array(raw.payload));
  raw.recordChecksum = artifactRecordChecksum(raw.record);
}, 'corrupt', 'artifact-payload-malformed');
await corruptCase('noncanonical', (raw) => {
  raw.payload = new TextEncoder().encode('{"z":2,"a":1}').buffer;
  raw.record.payloadSize = raw.payload.byteLength;
  raw.record.payloadChecksum = artifactPayloadChecksum(new Uint8Array(raw.payload));
  raw.recordChecksum = artifactRecordChecksum(raw.record);
}, 'corrupt', 'artifact-payload-noncanonical');
await corruptCase('record-schema', (raw) => { raw.record.recordSchemaVersion = 999; }, 'incompatible', 'artifact-record-schema-mismatch');
await corruptCase('contract', (raw) => { raw.record.artifactContractVersion = 'future-contract'; }, 'incompatible', 'artifact-contract-version-mismatch');
await corruptCase('producer', (raw) => { raw.record.producerVersion = '999'; }, 'incompatible', 'artifact-producer-version-mismatch');
await corruptCase('semantic', (raw) => { raw.record.versions.semanticSchema = '999'; }, 'incompatible', 'artifact-semantic-schema-mismatch');
await corruptCase('record-identity', (raw) => { raw.record.binaryId = 'bin_other'; }, 'incompatible', 'artifact-record-identity-mismatch');
await corruptCase('missing-payload', (raw) => { delete raw.payload; }, 'corrupt', 'artifact-payload-missing');
await corruptCase('malformed-record', (raw) => { raw.record = null; }, 'corrupt', 'artifact-record-malformed');

// New storage envelopes detect record-only corruption on by-ID reads.
{
  const entries = new Map();
  const store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const d = descriptor('envelope-checksum');
  await store.publish(d, { value:1 });
  store.evictHot(d.artifactId);
  entries.get(d.artifactId).record.creation = { corrupted:true };
  const result = await store.get(d.artifactId);
  assert.equal(result.status, 'corrupt');
  assert.equal(result.reason, 'artifact-record-checksum-mismatch');
}
{
  const entries = new Map();
  const store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const d = descriptor('envelope-schema');
  await store.publish(d, { value:1 });
  store.evictHot(d.artifactId);
  entries.get(d.artifactId).storageEnvelopeSchemaVersion = 999;
  const result = await store.get(d.artifactId);
  assert.equal(result.status, 'incompatible');
  assert.equal(result.reason, 'artifact-storage-envelope-schema-mismatch');
}

// P4-0 legacy rows remain readable without changing ArtifactId/record contracts.
{
  const entries = new Map();
  const store = new ArtifactStore({ backend:new PersistentMemoryBackend({ entries }) });
  const d = descriptor('legacy-envelope');
  await store.publish(d, { value:'legacy-compatible' });
  const row = entries.get(d.artifactId);
  delete row.storageEnvelopeSchemaVersion;
  delete row.recordChecksum;
  store.evictHot(d.artifactId);
  assert.deepEqual((await store.get(d)).payload, { value:'legacy-compatible' });
}

console.log('phase4 P4-1 store corruption: PASS');
