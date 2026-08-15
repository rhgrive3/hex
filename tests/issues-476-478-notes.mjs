import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class StorageMock {
  constructor() { this.map = new Map(); this.failWrites = false; }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) {
    if (this.failWrites) {
      const error = new Error('quota full');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.map.set(String(key), String(value));
  }
  removeItem(key) { this.map.delete(String(key)); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new StorageMock();

const { NoteStore, noteKeyFor, legacyV2NoteKeyFor } = await import('../js/names.js');
const { TypeStore } = await import('../js/types.js');

function fileLike(bytes, name = 'game.bin') {
  const blob = new Blob([bytes]);
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

// #476: two same-size files that are identical in the old start/middle/end
// windows but differ elsewhere must never share a current note identity.
{
  const size = 512 * 1024;
  const a = new Uint8Array(size);
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) a[i] = b[i] = (i * 31 + 7) & 0xff;
  b[100 * 1024 + 13] ^= 0x5a; // outside all three legacy 64 KiB sample windows
  const info = { slices: [{ offset: 0n, size: BigInt(size), info: { uuid: 'same-uuid', cpu: 'ARM64', cpuSub: '0' } }] };
  const fa = fileLike(a), fb = fileLike(b);
  const oldA = await legacyV2NoteKeyFor(fa, info, 0);
  const oldB = await legacyV2NoteKeyFor(fb, info, 0);
  assert.equal(oldA, oldB, 'fixture must collide under the legacy sampled v2 identity');
  const newA = await noteKeyFor(fa, info, 0);
  const newB = await noteKeyFor(fb, info, 0);
  assert.notEqual(newA, newB, 'full active-slice content must affect the v3 key');
  assert.match(newA, /sha256tree:v1:/, 'modern runtime should use cryptographic tree SHA-256');
}

// #478: migration -> explicit clear -> reload must stay empty, while preserving
// the old payload for backward compatibility.
{
  localStorage.clear();
  const legacyId = 'legacy-note-key';
  const currentId = 'current-note-key';
  const oldPayload = JSON.stringify({ v: 1, names: { '4096': 'coins' }, comments: { '4096': 'confirmed' } });
  localStorage.setItem('hex.notes.' + legacyId, oldPayload);
  const first = new NoteStore(currentId, [legacyId]);
  assert.equal(first.nameOf(4096n), 'coins');
  assert.equal(first.migratedFrom, legacyId);
  assert.equal(first.clear(), true);
  assert.equal(localStorage.getItem('hex.notes.' + legacyId), oldPayload, 'clear must not destroy backward-compatible legacy data');
  assert.equal(JSON.parse(localStorage.getItem('hex.notes.' + currentId)).cleared, true, 'current key must contain a migration-blocking tombstone');
  const reopened = new NoteStore(currentId, [legacyId]);
  assert.equal(reopened.count, 0);
  assert.equal(reopened.nameOf(4096n), null, 'deleted migrated notes must not resurrect');
}

// #477: quota failures are observable; the in-memory edit stays dirty so it can
// be exported/retried, and retry clears dirty only after a successful write.
{
  localStorage.clear();
  const notes = new NoteStore('quota-case');
  localStorage.failWrites = true;
  assert.equal(notes.setName(0x1234n, 'damage'), false);
  assert.equal(notes.nameOf(0x1234n), 'damage', 'failed persistence keeps the recoverable in-memory edit');
  assert.equal(notes.dirty, true);
  assert.equal(notes.lastSaveError?.code, 'QuotaExceededError');
  assert.match(notes.toJSON(), /damage/, 'dirty data remains exportable');
  localStorage.failWrites = false;
  assert.equal(notes.save(), true, 'retry must be explicit and observable');
  assert.equal(notes.dirty, false);
  assert.equal(notes.lastSaveError, null);
}

// MAX_BYTES must fail closed and preserve dirty/export state.
{
  localStorage.clear();
  const notes = new NoteStore('oversize-case');
  notes.structs = [{ name: 'huge', members: [], note: 'x'.repeat(2 * 1024 * 1024 + 4096) }];
  notes.dirty = true;
  assert.equal(notes.save(), false);
  assert.equal(notes.dirty, true);
  assert.equal(notes.lastSaveError?.code, 'TOO_LARGE');
  assert.ok(notes.lastSaveError?.bytes > notes.lastSaveError?.maxBytes);
}

// TypeStore keeps its existing success return types but throws on persistence
// failure so a caller cannot show a false success message.
{
  localStorage.clear();
  const notes = new NoteStore('type-quota');
  const types = new TypeStore(notes);
  localStorage.failWrites = true;
  assert.throws(() => types.add('Player', []), (error) =>
    error?.name === 'PersistenceError' && error?.code === 'QuotaExceededError');
  assert.equal(notes.dirty, true);
  assert.equal(types.lastPersisted, false);
  localStorage.failWrites = false;
  assert.equal(notes.save(), true);
}

console.log('issues #476-#478 note identity/persistence regressions PASS');
