import assert from 'node:assert/strict';
import { createMemoryStorage, installOpaqueSandboxStorage } from '../js/userscript/sandbox-storage.js';

await testMemoryStorageSemantics();
await testThrowingWindowStorageGetsReplaced();
await testUsableStorageIsPreserved();

console.log('userscript sandbox storage: ok');

async function testMemoryStorageSemantics() {
  const storage = createMemoryStorage();
  assert.equal(storage.length, 0);
  assert.equal(storage.getItem('missing'), null);
  storage.setItem('a', 1);
  storage.setItem('b', true);
  assert.equal(storage.length, 2);
  assert.equal(storage.getItem('a'), '1');
  assert.equal(storage.getItem('b'), 'true');
  assert.equal(storage.key(0), 'a');
  assert.equal(storage.key(1), 'b');
  assert.equal(storage.key(2), null);
  storage.removeItem('a');
  assert.equal(storage.getItem('a'), null);
  assert.equal(storage.length, 1);
  storage.clear();
  assert.equal(storage.length, 0);
}

async function testThrowingWindowStorageGetsReplaced() {
  const fakeWindow = {};
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(fakeWindow, name, {
      configurable: true,
      get() { throw new DOMException('sandboxed', 'SecurityError'); },
    });
  }
  const installed = installOpaqueSandboxStorage(fakeWindow);
  installed.localStorage.setItem('hex', 'local');
  installed.sessionStorage.setItem('hex', 'session');
  assert.equal(fakeWindow.localStorage.getItem('hex'), 'local');
  assert.equal(fakeWindow.sessionStorage.getItem('hex'), 'session');
  assert.notEqual(fakeWindow.localStorage, fakeWindow.sessionStorage);
}

async function testUsableStorageIsPreserved() {
  const localStorage = createMemoryStorage();
  const sessionStorage = createMemoryStorage();
  const fakeWindow = { localStorage, sessionStorage };
  const installed = installOpaqueSandboxStorage(fakeWindow);
  assert.equal(installed.localStorage, localStorage);
  assert.equal(installed.sessionStorage, sessionStorage);
}
